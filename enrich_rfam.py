#!/usr/bin/env python
"""Add Rfam family (id + name) to ribo2 F-H folds that have an rnacentral_id.

Source: RNAcentral's bulk computed Rfam annotations
  https://ftp.ebi.ac.uk/pub/databases/RNAcentral/current_release/rfam/rfam_annotations.tsv.gz
  (URS-Id  Rfam-Model-Id  Score  E-value  s_start  s_stop  m_start  m_stop  Description)
Joined by URS base; best-scoring hit per URS kept. Many atlas RNAs are novel and have no
Rfam hit (expected) -- only matched folds get rfam_id/rfam_name. Run after enrich_rnacentral.py.

Needs the gz at $RFAM_GZ (default /tmp/rfam_ann.tsv.gz); downloads if absent (needs outbound,
e.g. from a Janelia login node). Run in the `rna` env.
"""
import gzip
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
URL = "https://ftp.ebi.ac.uk/pub/databases/RNAcentral/current_release/rfam/rfam_annotations.tsv.gz"
GZ = os.environ.get("RFAM_GZ", "/tmp/rfam_ann.tsv.gz")


def main():
    folds = json.load(open(f"{ROOT}/data/folds.json"))
    bases = {f["rnacentral_id"].split("_")[0]: None for f in folds if f.get("rnacentral_id")}
    print(f"URS bases to look up: {len(bases)}")
    if not os.path.exists(GZ):
        print(f"downloading {URL} -> {GZ}")
        subprocess.run(["curl", "-s", "--max-time", "600", "-o", GZ, URL], check=True)
    best = {}   # base -> (score, RF, desc)
    with gzip.open(GZ, "rt") as fh:
        for ln in fh:
            p = ln.rstrip("\n").split("\t")
            if len(p) < 9 or p[0] not in bases:
                continue
            try:
                sc = float(p[2])
            except ValueError:
                sc = 0.0
            if p[0] not in best or sc > best[p[0]][0]:
                best[p[0]] = (sc, p[1], p[8])
    n = 0
    for f in folds:
        rid = f.get("rnacentral_id")
        if rid and rid.split("_")[0] in best:
            _, rf, desc = best[rid.split("_")[0]]
            f["rfam_id"] = rf; f["rfam_name"] = desc; n += 1
    json.dump(folds, open(f"{ROOT}/data/folds.json", "w"), separators=(",", ":"))
    print(f"enriched {n} folds with Rfam family ({len(best)} URS with a hit)")


if __name__ == "__main__":
    main()
