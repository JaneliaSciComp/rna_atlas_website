#!/usr/bin/env python
"""Patch `rfam_pdb130`/`rfam_pdb240` per-fold react JSON with REAL 1D chemical-mapping data
(DMS + 2A3) -- these are experimental RFAM/PDB structures (cond:["exp"]) that currently ship
ZERO reactivity of any kind (confirmed: 0/1614 and 0/2 have any dms/a23 value).

Source: the PDB-RFAM-130 / PDB-RFAM-240 1D cmuts datasets (Ultima sequencing, excellent QC:
99.8-99.9% SNR>=1 both conditions). H5 row order matches the "numbered" FASTA used for the
Ultima aligner, which in turn matches the ORIGINAL FASTA's row order 1:1 (confirmed via the
translation table) -- so we never need the numbered FASTA or translation table directly, just
the original FASTA (whose headers already closely match the atlas's `id` format, e.g.
"RF00356:Small nucleolar RNA R32/R81/Z41:AY707463.1/3-93 (rfam-130)" vs atlas id
"RF00356:Small_nucleolar_RNA_R32_R81_Z41:AY707463.1_3-93").

Join: normalized `seq` (react json) as a substring of the original FASTA's sequences ->
(row, start_offset). 94% of rfam_pdb130 records hit exactly one FASTA row; the rest either hit
0 (no fix possible) or >1 (ambiguous by sequence alone -- broken by normalized-name similarity
against the FASTA header, since names correspond 1:1 with sequences in this library).

Run in the `rna` env (needs h5py).
"""
import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))

CONFIGS = {
    "rfam_pdb130": {
        "orig_fasta": "/groups/das/rnastruct/2601-mocha/RFAM-run/metadata/library-PDB-RFAM-130/PDB-RFAM-130_RNA_sequences.fasta",
        "dms_h5": "/nrs/das/rnastruct/bioinfomatics/202603rfam-1d/PDB-RFAM-130/mpicmuts/RFAM130_DMS_samples_normalized.h5",
        "a23_h5": "/nrs/das/rnastruct/bioinfomatics/202603rfam-1d/PDB-RFAM-130/mpicmuts/RFAM130_2A3_samples_normalized.h5",
    },
    "rfam_pdb240": {
        "orig_fasta": "/groups/das/rnastruct/2601-mocha/RFAM-run/metadata/library-PDB-RFAM-240/PDB-RFAM-240_RNA_sequences.fasta",
        "dms_h5": "/nrs/das/rnastruct/bioinfomatics/202603rfam-1d/PDB-RFAM-240/mpicmuts/RFAM240_DMS_samples_normalized.h5",
        "a23_h5": "/nrs/das/rnastruct/bioinfomatics/202603rfam-1d/PDB-RFAM-240/mpicmuts/RFAM240_2A3_samples_normalized.h5",
    },
}


def norm_seq(s):
    return (s or "").strip().upper().replace("T", "U")


def norm_name(s):
    """Collapse both id styles (atlas underscores vs FASTA spaces/slashes + '(rfam-N)' suffix)
    to a common comparable form."""
    s = re.sub(r"\s*\(rfam-\d+\)\s*$", "", s or "")
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").upper()


def load_fasta(path):
    names, seqs = [], []
    cur_name, cur_seq = None, []
    with open(path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith(">"):
                if cur_name is not None:
                    names.append(cur_name); seqs.append(norm_seq("".join(cur_seq)))
                cur_name = line[1:]
                cur_seq = []
            else:
                cur_seq.append(line.strip())
        if cur_name is not None:
            names.append(cur_name); seqs.append(norm_seq("".join(cur_seq)))
    return names, seqs


def main():
    import h5py
    import numpy as np

    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets-root", default=f"{ROOT}/dist/datasets")
    ap.add_argument("--out-root", default=None)
    ap.add_argument("--names", nargs="+", default=list(CONFIGS))
    args = ap.parse_args()

    for name in args.names:
        cfg = CONFIGS[name]
        dd = f"{args.datasets_root}/{name}/data"
        rd = f"{args.datasets_root}/{name}/react"
        out_rd = f"{args.out_root}/{name}/react" if args.out_root else rd
        os.makedirs(out_rd, exist_ok=True)

        fnames, fseqs = load_fasta(cfg["orig_fasta"])
        fnames_norm = [norm_name(n) for n in fnames]
        dms_h5 = h5py.File(cfg["dms_h5"], "r")
        a23_h5 = h5py.File(cfg["a23_h5"], "r")

        folds = json.load(open(f"{dd}/folds.json"))
        n = n_matched = n_ambig_resolved = n_ambig_unresolved = n_nohit = 0
        for f in folds:
            n += 1
            sid, key = f["id"], f["key"]
            rj_path = f"{rd}/{key}.json"
            if not os.path.exists(rj_path):
                continue
            rj = json.load(open(rj_path))
            seq = rj.get("seq", "")
            nseq = norm_seq(seq)
            if not nseq:
                json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
                continue
            hits = [i for i, fs in enumerate(fseqs) if nseq in fs]
            row = None
            if len(hits) == 1:
                row = hits[0]
                n_matched += 1
            elif len(hits) > 1:
                nid = norm_name(sid)
                name_hits = [i for i in hits if fnames_norm[i] == nid]
                if len(name_hits) == 1:
                    row = name_hits[0]
                    n_ambig_resolved += 1
                else:
                    n_ambig_unresolved += 1
            else:
                n_nohit += 1

            if row is None:
                json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
                continue

            start = fseqs[row].find(nseq)
            L = len(nseq)
            dms_seg = np.asarray(dms_h5["reactivity"][row][start:start + L], np.float32)
            a23_seg = np.asarray(a23_h5["reactivity"][row][start:start + L], np.float32)
            dms_clean = [round(float(dms_seg[i]), 4) if (dms_seg[i] == dms_seg[i] and seq[i] in "AC") else None
                         for i in range(len(seq))]
            a23_clean = [round(float(v), 4) if v == v else None for v in a23_seg]
            snr_dms = float(dms_h5["SNR"][row])
            snr_a23 = float(a23_h5["SNR"][row])
            rj["dms"] = dms_clean
            rj["a23"] = a23_clean
            rj["sn"] = [round(snr_dms, 2) if snr_dms == snr_dms else None,
                        round(snr_a23, 2) if snr_a23 == snr_a23 else None]
            json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))

        dms_h5.close(); a23_h5.close()
        n_total_matched = n_matched + n_ambig_resolved
        print(f"{name}: {n} folds, {n_total_matched} patched with real reactivity "
              f"({n_matched} unique seq-hit, {n_ambig_resolved} disambiguated by name), "
              f"{n_ambig_unresolved} still ambiguous (left untouched), "
              f"{n_nohit} no sequence hit at all (left untouched)", flush=True)


if __name__ == "__main__":
    main()
