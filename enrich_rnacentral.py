#!/usr/bin/env python
"""Add RNAcentral metadata to the ribo2 F-H natural folds.

The per-library metadata parquet's `source_id` for F-H RNAcentral folds is
"URS<hex>_<taxid> <entry description>" (e.g. "URS000232B20C_343512 Agrococcus casei
FMN sequence"). We split it into:
    rnacentral_id   = URS<hex>_<taxid>           (links to rnacentral.org/rna/<id>)
    rnacentral_name = the entry description       (also upgrades the display `name`)

Run in the `rna` env. Updates data/folds.json in place.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
PARQ = json.load(open(os.path.join(ROOT, "config.json")))["metadata_parquet"]
URS_RE = re.compile(r"^(URS[0-9A-Za-z]+_\d+)\s*(.*)$")


def main():
    import pyarrow.parquet as pq
    folds = json.load(open(f"{ROOT}/data/folds.json"))
    by = {"F": {}, "G": {}, "H": {}}
    for f in folds:
        if f["letter"] in by:
            by[f["letter"]][int(f["id"].split("-")[0]) - 1] = f
    n_id = n_name = 0
    for lib, idx2f in by.items():
        if not idx2f:
            continue
        t = pq.read_table(PARQ.format(L=lib), columns=["fasta_index", "source_id"],
                          filters=[("fasta_index", "in", list(idx2f))]).to_pydict()
        for fi, src in zip(t["fasta_index"], t["source_id"]):
            f = idx2f.get(fi)
            if not f or not src:
                continue
            m = URS_RE.match(src.strip())
            if not m:
                continue
            f["rnacentral_id"] = m.group(1)
            n_id += 1
            desc = m.group(2).strip()
            if desc:
                f["rnacentral_name"] = desc
                f["name"] = desc          # upgrade the generic "natural RNA · ..." display name
                n_name += 1
    json.dump(folds, open(f"{ROOT}/data/folds.json", "w"), separators=(",", ":"))
    print(f"rnacentral_id: {n_id}  rnacentral_name: {n_name}  (of {sum(len(v) for v in by.values())} F-H folds)")


if __name__ == "__main__":
    main()
