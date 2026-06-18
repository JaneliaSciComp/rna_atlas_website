#!/usr/bin/env python
"""Enrich ribo2 F-H folds with RNAcentral + Rfam metadata from the bioinformatics team's
enhanced parquet (supersedes enrich_rnacentral.py + enrich_rfam.py).

Source: /groups/das/rnastruct/bioinformatics/202606-distill/ribo2_metadata_enhanced/Ribonanza2{F,G,H}.parquet
  rnacentral_urs / rnacentral_taxid / rnacentral_description / rnacentral_member_dbs
  rnacentral_rna_type / rnacentral_family_acc (e.g. "RFAM:RF00050|RIBOCENTRE:...")
  rfam_family_id (short, e.g. "FMN") / rfam_family_name (full)

Sets per fold (when present): rnacentral_id (URS_taxid), rnacentral_name (description, also
upgrades display name), rna_type, member_dbs, rfam_id (RF accession), rfam_name.
Join by fasta_index. Run in the `rna` env; updates data/folds.json.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
ENH = "/groups/das/rnastruct/bioinformatics/202606-distill/ribo2_metadata_enhanced/Ribonanza2{L}.parquet"
COLS = ["fasta_index", "rnacentral_urs", "rnacentral_taxid", "rnacentral_description",
        "rnacentral_member_dbs", "rnacentral_rna_type", "rnacentral_family_acc",
        "rfam_family_id", "rfam_family_name"]


def main():
    import pyarrow.parquet as pq
    folds = json.load(open(f"{ROOT}/data/folds.json"))

    def default_name(sub):
        if "RNAcentral" in sub:
            return f"natural RNA · {sub}"
        if "utrs_windows" in sub:
            return f"natural UTR · {sub.split('.')[0].replace('_', ' ')}"
        return sub.replace("_", " ")

    by = {"F": {}, "G": {}, "H": {}}
    for f in folds:
        if f["letter"] in by:
            # reset prior ad-hoc enrichment so the enhanced parquet is the single source
            for k in ("rnacentral_id", "rnacentral_name", "rna_type", "member_dbs", "rfam_id", "rfam_name"):
                f.pop(k, None)
            f["name"] = default_name(f.get("sublibrary", "") or "")
            by[f["letter"]][int(f["id"].split("-")[0]) - 1] = f
    n_urs = n_rfam = 0
    for lib, idx2f in by.items():
        if not idx2f:
            continue
        t = pq.read_table(ENH.format(L=lib), columns=COLS,
                          filters=[("fasta_index", "in", list(idx2f))]).to_pydict()
        for i, fi in enumerate(t["fasta_index"]):
            f = idx2f.get(fi)
            if not f:
                continue
            urs = (t["rnacentral_urs"][i] or "").strip()
            if not urs:
                continue
            taxid = t["rnacentral_taxid"][i]
            f["rnacentral_id"] = f"{urs}_{taxid}" if taxid else urs
            n_urs += 1
            desc = (t["rnacentral_description"][i] or "").strip()
            if desc:
                f["rnacentral_name"] = desc
                f["name"] = desc
            rtype = (t["rnacentral_rna_type"][i] or "").strip()
            if rtype:
                f["rna_type"] = rtype
            dbs = (t["rnacentral_member_dbs"][i] or "").strip()
            if dbs:
                f["member_dbs"] = [d for d in dbs.split("|") if d]
            rfn = (t["rfam_family_name"][i] or "").strip()
            acc = (t["rnacentral_family_acc"][i] or "")
            m = re.search(r"RFAM:(RF\d+)", acc)
            if rfn or m:
                if m:
                    f["rfam_id"] = m.group(1)
                f["rfam_name"] = rfn or (t["rfam_family_id"][i] or "").strip()
                n_rfam += 1
    json.dump(folds, open(f"{ROOT}/data/folds.json", "w"), separators=(",", ":"))
    tot = sum(len(v) for v in by.values())
    print(f"F-H folds: {tot}  rnacentral: {n_urs} ({100*n_urs//tot}%)  rfam: {n_rfam} ({100*n_rfam//tot}%)")


if __name__ == "__main__":
    main()
