#!/usr/bin/env python
"""Add OpenKnot DESIGN-PROVENANCE metadata (already on disk, never surfaced) to the OpenKnot
family's folds.json: designer, design method, round/puzzle, design title, organism, and per-design
read depth. Purely additive display metadata — no reactivity/structure fields touched.

Two sources, one per dataset family (join keys empirically validated, see tmp_analysis/probe_join*):
  - `openknot` (3,698)  -> OpenKnotBench_data.v4.5.1.txt, joined by `id` == OKB `id` (exact, 100%,
    unique). Columns: eterna_author, method, round, puzzle, eterna_title, reads.
  - `openknot_long` / `openknot_long_seq` / `openknot_cryoem_seq` / `openknot_cryoem_msa`
    -> ok7ab8_metadata_combined.parquet, joined by normalized design_sequence (best SNR_DMS+SNR_2A3
    per sequence, the SAME row the reactivity came from in enrich_openknot_long_react.py, so the
    metadata is consistent with the displayed reactivity). ~99.6% of sequences are unique; the rest
    fall back to the best-SNR row. Columns: author, method, openknot_round, eterna_title, organism,
    accession, reads_DMS, reads_2A3.

Fields written (only these; all display-only):
  designer, design_method, design_round, design_title, organism, reads_dms, reads_2a3, reads

Run in the `rna` env (pyarrow + stdlib csv).
"""
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
OKB = "/groups/das/home/joshic/RNAnix/release_data/openknotbench/OpenKnotBench_data.v4.5.1.txt"
PARQ = "/groups/das/rnastruct/bioinformatics/202606-1d-ok7ab/metadata/ok7ab8_metadata_combined.parquet"
csv.field_size_limit(10 ** 7)

OKB_DATASETS = ["openknot"]
OK7AB8_DATASETS = ["openknot_long", "openknot_long_seq", "openknot_cryoem_seq", "openknot_cryoem_msa"]


def norm(s):
    return (s or "").strip().upper().replace("T", "U")


def fl(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def s(x):
    return (str(x).strip() if x is not None else "")


def load_okb_by_id():
    """OKB id -> provenance dict."""
    out = {}
    with open(OKB) as f:
        for r in csv.DictReader(f):
            sid = (r.get("id") or "").strip()
            if not sid:
                continue
            rnd, puz = s(r.get("round")), s(r.get("puzzle"))
            out[sid] = {
                "designer": s(r.get("eterna_author")),
                "design_method": s(r.get("method")),
                "design_round": (f"{puz} · round {rnd}" if puz and rnd else puz or rnd),
                "design_title": s(r.get("eterna_title")),
                "organism": "",
                "reads_dms": None, "reads_2a3": None,
                "reads": fl(r.get("reads")),
            }
    return out


def load_ok7ab8_by_seq():
    """norm(design_sequence) -> best-(SNR_DMS+SNR_2A3) provenance dict (consistent with the
    reactivity join in enrich_openknot_long_react.py)."""
    import pyarrow.parquet as pq
    t = pq.read_table(PARQ, columns=["design_sequence", "author", "method", "openknot_round",
                                      "eterna_title", "organism", "accession",
                                      "SNR_DMS", "SNR_2A3", "reads_DMS", "reads_2A3"])
    d = t.to_pydict()
    best = {}
    for i in range(len(d["design_sequence"])):
        key = norm(d["design_sequence"][i])
        if not key:
            continue
        sn = (fl(d["SNR_DMS"][i]) or 0.0) + (fl(d["SNR_2A3"][i]) or 0.0)
        prev = best.get(key)
        if prev is not None and prev[0] >= sn:
            continue
        rnd = s(d["openknot_round"][i])
        best[key] = (sn, {
            "designer": s(d["author"][i]),
            "design_method": s(d["method"][i]),
            "design_round": (f"OK{rnd}" if rnd and not rnd.upper().startswith("OK") else rnd.upper()),
            "design_title": s(d["eterna_title"][i]),
            "organism": s(d["organism"][i]),
            "reads_dms": fl(d["reads_DMS"][i]), "reads_2a3": fl(d["reads_2A3"][i]),
            "reads": None,
        })
    return {k: v[1] for k, v in best.items()}


FIELDS = ("designer", "design_method", "design_round", "design_title", "organism",
          "reads_dms", "reads_2a3", "reads")


def apply(folds, react_dir, lookup, by):
    n = n_matched = 0
    for f in folds:
        n += 1
        if by == "id":
            meta = lookup.get(f["id"])
        else:  # by == "seq"
            rp = f"{react_dir}/{f.get('key') or f['id']}.json"
            seq = json.load(open(rp)).get("seq", "") if os.path.exists(rp) else ""
            meta = lookup.get(norm(seq))
        if not meta:
            continue
        for k in FIELDS:
            v = meta.get(k)
            if v not in (None, ""):
                f[k] = v
        n_matched += 1
    return n, n_matched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets-root", default=f"{ROOT}/dist/datasets")
    ap.add_argument("--out-root", default=None,
                     help="if set, write patched data/folds.json here instead of in place")
    ap.add_argument("--names", nargs="+", default=OKB_DATASETS + OK7AB8_DATASETS)
    args = ap.parse_args()

    okb = ok7 = None
    for name in args.names:
        dd = f"{args.datasets_root}/{name}/data"
        rd = f"{args.datasets_root}/{name}/react"
        out_dd = f"{args.out_root}/{name}/data" if args.out_root else dd
        os.makedirs(out_dd, exist_ok=True)
        folds = json.load(open(f"{dd}/folds.json"))
        if name in OKB_DATASETS:
            if okb is None:
                okb = load_okb_by_id()
            n, m = apply(folds, rd, okb, "id")
        else:
            if ok7 is None:
                ok7 = load_ok7ab8_by_seq()
            n, m = apply(folds, rd, ok7, "seq")
        json.dump(folds, open(f"{out_dd}/folds.json", "w"), separators=(",", ":"))
        print(f"{name}: {n} folds, {m} got design-provenance metadata -> {out_dd}", flush=True)


if __name__ == "__main__":
    main()
