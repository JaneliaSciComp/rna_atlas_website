#!/usr/bin/env python
"""Patch `near_title` for `openknot_long`/`openknot_long_seq`/`ribo2-iq-curated-v2` -- currently
null for all 51,824 records even though `near` (the closest-known-PDB-chain hit) is already
100% populated. Root cause: their builders (`build_openknot_long.py`, `build_iq_curated.py`)
both initialize `near_title` blank and never call the RCSB title-lookup helper that
`merge_analysis.py` already uses for the other 4 datasets (`pdb_titles()`/`.rcsb_titles.json`).

Note on `near`'s own provenance (does NOT block this fix): for `ribo2-iq-curated-v2`, `near`
comes from `build_iq_curated.py`'s own `load_novelty()` (the I-Q curation pipeline's
`curated.tsv`), confirmed by reading that script directly. For `openknot_long`/
`openknot_long_seq`, `near` is NOT produced by anything in this repo -- confirmed by grepping
every `.py` file for a `near`-assignment and by checking the shared `{LSF}/novelty/chunk_*.tsv`
`merge_analysis.py` reads (the openknot_long sample ids checked are absent from those chunks) --
so its origin is genuinely untracked from this checkout. This doesn't matter for the fix below:
`near_title` is an RCSB lookup keyed purely by the PDB-id *string* already sitting in `near`, so
it's correct regardless of how that string was produced, as long as `near` itself is a real,
valid PDB id (spot-checked: 6WLJ, 8UYE, 1S9S, 8UYK, ... all real RCSB entries).

Reuses the exact same `pdb_titles()` mechanism (RCSB GraphQL, batched by 50, cached at the
repo-root `.rcsb_titles.json` -- same cache file `merge_analysis.py` already populates for
pseudolabels/openknot/rfam_pdb, so hits there are free).

Run in any env with network egress (stdlib only, no extra deps).
"""
import argparse
import json
import os
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, ".rcsb_titles.json")


def pdb_titles(near_ids):
    titles = {}
    if os.path.exists(CACHE):
        titles = json.load(open(CACHE))
    want = {n.split("_")[0].upper() for n in near_ids if n}
    missing = sorted(want - set(titles))
    for i in range(0, len(missing), 50):
        batch = missing[i:i + 50]
        q = '{entries(entry_ids:[%s]){rcsb_id struct{title}}}' % ",".join(f'"{b}"' for b in batch)
        try:
            url = "https://data.rcsb.org/graphql?query=" + urllib.parse.quote(q)
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.load(r)
            for e in data.get("data", {}).get("entries", []) or []:
                titles[e["rcsb_id"].upper()] = (e.get("struct") or {}).get("title", "")
        except Exception as ex:
            print(f"  title fetch failed for batch {i // 50}: {ex}")
            break
    json.dump(titles, open(CACHE, "w"))
    return titles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets-root", default=f"{ROOT}/dist/datasets")
    ap.add_argument("--out-root", default=None,
                     help="if set, write patched data/folds.json here instead of in place "
                          "(use when --datasets-root is read-only)")
    ap.add_argument("--names", nargs="+",
                     default=["openknot_long", "openknot_long_seq", "ribo2-iq-curated-v2"])
    args = ap.parse_args()

    per_ds = {}
    all_near = []
    for name in args.names:
        dd = f"{args.datasets_root}/{name}/data"
        folds = json.load(open(f"{dd}/folds.json"))
        per_ds[name] = folds
        all_near.extend(f.get("near", "") for f in folds)

    titles = pdb_titles(all_near)
    print(f".rcsb_titles.json now has {len(titles)} cached PDB titles", flush=True)

    for name, folds in per_ds.items():
        dd = f"{args.datasets_root}/{name}/data"
        out_dd = f"{args.out_root}/{name}/data" if args.out_root else dd
        os.makedirs(out_dd, exist_ok=True)
        n = n_matched = 0
        for f in folds:
            n += 1
            near = f.get("near", "")
            if not near:
                continue
            t = titles.get(near.split("_")[0].upper())
            if t:
                f["near_title"] = t
                n_matched += 1
        json.dump(folds, open(f"{out_dd}/folds.json", "w"), separators=(",", ":"))
        print(f"{name}: {n} folds, {n_matched} near_title filled -> {out_dd}", flush=True)


if __name__ == "__main__":
    main()
