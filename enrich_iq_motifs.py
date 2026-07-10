#!/usr/bin/env python
"""Phase-2: merge Rosetta rna_motif (PyRosetta get_rna_motifs) output into ribo2-iq-curated.

Input: the motif TSV produced by run_rna_motif.py over the I-Q structures — columns
  seq_id, letter, mean_plddt, n_res, motif_type, residues  (residues space-separated,
  e.g. "A:67-68 A:76-77"; error rows start with "#").

Writes (mirrors build_feature_table.py:303-372 semantics — same TERT/RARE_TERT sets):
  data/motifs.json  = {seq_id: [[motif_type, residues], ...]}   (per-instance spans; keyed by
                       fold id, which is what the deep view's spansFor(f) looks up)
  data/folds.json  += n_tert, n_rare (counts of DISTINCT tertiary / rare-tertiary types),
                       motifs[] (sorted distinct types)

Run in the `rna` env.
"""
import argparse
import csv
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
# identical to build_feature_table.py:176-178 and web/viz_style.js
TERT = {"A_MINOR", "TL_RECEPTOR", "UA_HANDLE", "T_LOOP", "GA_MINOR", "PLATFORM",
        "TANDEM_GA_SHEARED", "TANDEM_GA_WATSON_CRICK", "TETRALOOP_TL_RECEPTOR"}
RARE_TERT = {"TL_RECEPTOR", "GA_MINOR", "T_LOOP", "TETRALOOP_TL_RECEPTOR", "UA_HANDLE"}
csv.field_size_limit(10 ** 7)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="ribo2-iq-curated")
    ap.add_argument("--motifs", required=True, help="rna_motif output TSV")
    args = ap.parse_args()
    od = os.path.join(ROOT, "dist", "datasets", args.name)
    fp = f"{od}/data/folds.json"

    spans, agg = {}, {}
    with open(args.motifs) as f:
        for m in csv.DictReader(f, delimiter="\t"):
            sid = m.get("seq_id")
            mt = m.get("motif_type")
            if not sid or sid.startswith("#") or not mt:
                continue
            spans.setdefault(sid, []).append([mt, m.get("residues", "")])
            a = agg.setdefault(sid, {"motifs": set(), "tert": set(), "rare": set()})
            a["motifs"].add(mt)
            if mt in TERT:
                a["tert"].add(mt)
            if mt in RARE_TERT:
                a["rare"].add(mt)

    folds = json.load(open(fp))
    n_with = n_tert_folds = n_rare_folds = 0
    for rec in folds:
        a = agg.get(rec["id"], {"motifs": set(), "tert": set(), "rare": set()})
        rec["n_tert"] = len(a["tert"])
        rec["n_rare"] = len(a["rare"])
        rec["motifs"] = sorted(a["motifs"])
        if rec["motifs"]:
            n_with += 1
        if rec["n_tert"]:
            n_tert_folds += 1
        if rec["n_rare"]:
            n_rare_folds += 1
    json.dump(folds, open(fp, "w"), separators=(",", ":"))
    json.dump(spans, open(f"{od}/data/motifs.json", "w"), separators=(",", ":"))

    from collections import Counter
    tc = Counter(mt for insts in spans.values() for mt, _ in insts)
    print(f"{args.name}: motifs.json = {len(spans)} folds with instances")
    print(f"  folds with any motif: {n_with}/{len(folds)}  | with tertiary: {n_tert_folds}  | with rare: {n_rare_folds}")
    print(f"  top motif types: {dict(tc.most_common(10))}")


if __name__ == "__main__":
    main()
