#!/usr/bin/env python
"""Patch the `openknot` dataset's own `openknot` (pseudoknot) score -- currently hardcoded
`None` for all 3,698 records because it was built with the generic `build_dataset.py`, which
has no OpenKnotBench join at all (unlike `build_openknot_long.py`, which already gets this
score for free for OK7b/OK8). Confirmed by Marwan's own audit: a sample `openknot` record's
`design_sequence` (from its react JSON) matches a row in OpenKnotBench v4.5.1 with a real
`target_openknot_score`.

Join: atlas record `id` == OpenKnotBench's own `id` column, exact string match -- 3,698/3,698
(100%), no ambiguity. (Earlier drafted this as a normalized-`design_sequence` + best-SN-per-
sequence join, matching `build_openknot_long.py`'s `load_okb()` pattern -- but OpenKnotBench
has real sequence collisions: e.g. `W02_35A_5pad6_libraryready` and `W02_13200432_..._
libraryready` share an identical design_sequence but have different, legitimately different
`target_openknot_score` values [80.91 vs 90.53] -- since the atlas's own `id` already equals
OKB's `id` for every record, joining directly on `id` sidesteps that ambiguity entirely rather
than relying on a best-SN tiebreak to usually pick the right row.)

Run in the `rna` env (no extra deps beyond stdlib csv).
"""
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
OKB = "/groups/das/home/joshic/RNAnix/release_data/openknotbench/OpenKnotBench_data.v4.5.1.txt"
csv.field_size_limit(10 ** 7)


def fl(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def load_okscores_by_id():
    """OKB `id` -> `target_openknot_score`."""
    out = {}
    with open(OKB) as f:
        for r in csv.DictReader(f):
            sid = (r.get("id") or "").strip()
            score = fl(r.get("target_openknot_score"))
            if sid and score is not None:
                out[sid] = score
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset-root", default=f"{ROOT}/dist/datasets/openknot")
    ap.add_argument("--out-root", default=None,
                     help="if set, write patched data/folds.json here instead of in place "
                          "(use when --dataset-root is read-only)")
    args = ap.parse_args()

    dd = f"{args.dataset_root}/data"
    out_dd = f"{args.out_root}/data" if args.out_root else dd
    os.makedirs(out_dd, exist_ok=True)

    scores = load_okscores_by_id()
    print(f"OpenKnotBench v4.5.1: {len(scores)} unique id -> target_openknot_score", flush=True)

    folds = json.load(open(f"{dd}/folds.json"))
    n = n_matched = 0
    for f in folds:
        n += 1
        score = scores.get(f["id"])
        if score is not None:
            f["openknot"] = round(score, 4)
            n_matched += 1

    json.dump(folds, open(f"{out_dd}/folds.json", "w"), separators=(",", ":"))
    print(f"openknot: {n} folds, {n_matched} matched to a real OpenKnot score -> {out_dd}", flush=True)


if __name__ == "__main__":
    main()
