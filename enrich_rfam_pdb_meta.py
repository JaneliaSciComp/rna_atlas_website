#!/usr/bin/env python
"""Add RFAM-family labels (already embedded in the id, never surfaced) to rfam_pdb130/240
folds.json. Purely additive display metadata.

- rfam_id / rfam_name: parsed directly from each record's `id`, which embeds the Rfam accession
  and family name (all 1,614 rfam_pdb130 ids match ^RF#####, both rfam_pdb240 too). Setting these
  lights up the deep view's existing "Rfam family" row + rfam.org link (already wired for ribo2),
  zero frontend work.
    colon form (130): "RF00356:Small_nucleolar_RNA_R32_R81_Z41:AY707463.1_3-93"
    underscore form (240): "RF01807_GIR1_branching_ribozyme_URS000080DE6F_5793_1-188"

NOTE on reads: the PDB-RFAM metadata parquet's `reads`/`design_reads` are the fld-pipeline
*predicted* per-design coverage (a design-time estimate before sequencing, per the metadata
README), NOT an empirical sequencing depth — so they are deliberately NOT surfaced here as
"sequencing depth" (that would be misleading). The real per-record reliability signal for these
datasets is the empirical SNR already in each react/<key>.json `sn`.

Run in the `rna` env (stdlib only).
"""
import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))

DATASETS = ["rfam_pdb130", "rfam_pdb240"]

ACCESSION = re.compile(r"^(URS[0-9A-Za-z]+|[A-Za-z]{1,3}\d+\.\d+|\d+|\d+-\d+)$")


def parse_rfam(sid):
    """(rfam_id, rfam_name) from the embedded Rfam accession + family name in the id."""
    m = re.match(r"(RF\d+)", sid or "")
    if not m:
        return None, None
    rfid = m.group(1)
    if ":" in sid:                                  # colon form (130)
        parts = sid.split(":")
        name = parts[1] if len(parts) > 1 else ""
    else:                                           # underscore form (240)
        toks = sid[m.end():].lstrip("_").split("_")
        keep = []
        for tk in toks:
            if ACCESSION.match(tk):
                break
            keep.append(tk)
        name = "_".join(keep)
    return rfid, name.replace("_", " ").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets-root", default=f"{ROOT}/dist/datasets")
    ap.add_argument("--out-root", default=None)
    ap.add_argument("--names", nargs="+", default=DATASETS)
    args = ap.parse_args()

    for name in args.names:
        dd = f"{args.datasets_root}/{name}/data"
        out_dd = f"{args.out_root}/{name}/data" if args.out_root else dd
        os.makedirs(out_dd, exist_ok=True)
        folds = json.load(open(f"{dd}/folds.json"))
        n = n_rfam = 0
        for f in folds:
            n += 1
            rfid, rfname = parse_rfam(f["id"])
            if rfid:
                f["rfam_id"] = rfid
                if rfname:
                    f["rfam_name"] = rfname
                n_rfam += 1
        json.dump(folds, open(f"{out_dd}/folds.json", "w"), separators=(",", ":"))
        print(f"{name}: {n} folds, {n_rfam} rfam_id/name set -> {out_dd}", flush=True)


if __name__ == "__main__":
    main()
