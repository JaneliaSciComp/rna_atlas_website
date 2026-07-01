#!/usr/bin/env python
"""Export a fully static bundle for S3/CloudFront hosting.

Produces dist/ with everything the browser needs as plain files (no serve.py):

  dist/data/folds.json, motifs.json     (copied from data/)
  dist/structs/<seq_id>.cif             (gzip bytes; upload with Content-Encoding: gzip)
  dist/react/<seq_id>.json              ({seq, dms[], a23[], sn[]})

Reactivity is read here (server-side) so the static site never touches HDF5.
Reads are batched per library to stay IO-light. Run in the `rna` env.

  python build_static.py                 # all 7,757
  python build_static.py --limit 30      # quick validation
Then:
  aws s3 sync dist/data    s3://rnanix/atlas_explorer/data
  aws s3 sync dist/react   s3://rnanix/atlas_explorer/react
  aws s3 sync dist/structs s3://rnanix/atlas_explorer/structs \
      --content-encoding gzip --content-type text/plain
"""
import argparse
import gzip
import json
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(ROOT, "config.json")))
MINED = CFG["mined_dir"]
STRUCT_BASES = CFG["struct_bases"]
PARQUET = CFG["metadata_parquet"]
HDF5 = CFG["hdf5"]
REACT_OVERRIDE = CFG.get("react_override") or os.path.join(MINED, "summary/react_override_fgh40.parquet")

# Chemmap source = the uniform-spread reprocessing (cmuts126 --uniform-spread) for ALL of A-H.
#   A-E: per-library Ribonanza2<LIB>_{2A3,DMS}.h5, each (8e6, 177); row = numeric(seq_id)-1,
#        same 177 frame as the old r_norm, sliced to the design region by sub_start (metadata parquet).
#   F-H: one concatenated Ribonanza2FGH_{2A3,DMS}.h5, (24e6, 177); row = LIBOFF[lib] + numeric-1.
#        The design floats within the 177 frame (per-construct barcode offset), so we recover the
#        offset by aligning the design-aligned default-spread parquet (REACT_OVERRIDE) against the
#        default FGH h5 (exact float16 match), then read the SAME row+offset from the uniform h5.
UNIFORM_DIR = CFG["uniform_spread_dir"]
FGH_DEFAULT_DIR = CFG["fgh_default_h5_dir"]
FGH_LIBOFF = {"F": 0, "G": 8_000_000, "H": 16_000_000}


def struct_path(sid):
    lib = sid.split("-")[1].replace("ribonanza2", "").upper()
    base = STRUCT_BASES["AE"] if lib in "ABCDE" else STRUCT_BASES["FGH"]
    return os.path.join(base, sid + ".cif")


def nan_list(a):
    return [None if (v != v) else round(float(v), 4) for v in a]


def main():
    import numpy as np
    import pyarrow.parquet as pq
    import h5py
    import gemmi
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    os.makedirs(f"{args.out}/structs", exist_ok=True)
    os.makedirs(f"{args.out}/react", exist_ok=True)
    os.makedirs(f"{args.out}/data", exist_ok=True)
    os.makedirs(f"{args.out}/lib", exist_ok=True)

    # stage the web shell into dist/ so the whole site syncs from one dir.
    import shutil
    for f in ("index.html", "app.js", "agent.js", "style.css", "viz_style.js", "datasets.js"):
        shutil.copy(os.path.join(ROOT, "web", f), f"{args.out}/{f}")
    shutil.copy(os.path.join(ROOT, "web", "lib", "3Dmol-min.js"), f"{args.out}/lib/3Dmol-min.js")
    # deploy config: same-origin data, passcode-gated (overrides the local dev config.js)
    with open(f"{args.out}/config.js", "w") as o:
        o.write('window.DATA_BASE = "";\nwindow.GATED = true;\n')

    # ids + design sequence (A-E); F-H sequence derived from the CIF
    seqmap = {}
    with open(os.path.join(MINED, "selection.tsv")) as fh:
        next(fh)
        for line in fh:
            p = line.rstrip("\n").split("\t")
            if len(p) >= 2:
                seqmap[p[0]] = p[1]
    ids = list(seqmap)
    if args.limit:
        ids = ids[:args.limit]

    # copy the table files
    for f in ("folds.json", "motifs.json"):
        src = os.path.join(ROOT, "data", f)
        if os.path.exists(src):
            open(f"{args.out}/data/{f}", "w").write(open(src).read())

    # structs (gzip) + derive F-H sequence
    cifseq = {}
    n_struct = 0
    for sid in ids:
        p = struct_path(sid)
        if not os.path.exists(p):
            continue
        txt = open(p).read()
        with gzip.open(f"{args.out}/structs/{sid}.cif", "wt") as o:
            o.write(txt)
        n_struct += 1
        if not seqmap.get(sid):
            try:
                ch = gemmi.read_structure(p)[0][0]
                cifseq[sid] = "".join((r.name if r.name in "AUGC" else "N") for r in ch)
            except Exception:
                cifseq[sid] = ""

    # reactivity, batched per library — uniform-spread chemmap for all of A-H
    bylib = defaultdict(list)
    for sid in ids:
        bylib[sid.split("-")[1].replace("ribonanza2", "").upper()].append(sid)

    # F-H default-spread parquet (design-aligned) — the offset/length/NaN reference for the
    # uniform-spread extraction. Filtered to our F-H ids (the full chemmap is ~6.9M rows / 2 GB).
    ovr = {}
    fgh_ids = [s for s in ids if s.split("-")[1].replace("ribonanza2", "").upper() in ("F", "G", "H")]
    if fgh_ids and os.path.exists(REACT_OVERRIDE):
        t = pq.read_table(REACT_OVERRIDE, filters=[("sequence_id", "in", fgh_ids)]).to_pydict()
        for i, s in enumerate(t["sequence_id"]):
            ovr[s] = (t["reactivity_DMS"][i], t["reactivity_2A3"][i])

    def fgh_offset(pa, hrow):
        """Design offset of the design-aligned default array `pa` within the 177-frame default
        h5 row `hrow`. Brute-force; accept only an essentially exact (float16) match."""
        L = len(pa)
        best = None
        for sh in range(0, 177 - L + 1):
            seg = hrow[sh:sh + L]
            m = ~(np.isnan(seg) | np.isnan(pa))
            if m.sum() < 5:
                continue
            md = float(np.max(np.abs(seg[m] - pa[m])))
            if best is None or md < best[0]:
                best = (md, sh)
        return best  # (maxabsdiff, offset) or None

    n_react = n_fgh_ok = n_fgh_nosig = 0
    for lib, sids in bylib.items():
        if lib in ("A", "B", "C", "D", "E"):
            fis = [int(s.split("-")[0]) - 1 for s in sids]
            tbl = pq.read_table(PARQUET.format(L=lib), columns=["fasta_index", "sub_start"],
                                filters=[("fasta_index", "in", fis)]).to_pydict()
            substart = dict(zip(tbl["fasta_index"], tbl["sub_start"]))
            h2 = h5py.File(f"{UNIFORM_DIR}Ribonanza2{lib}_2A3.h5", "r")
            hd = h5py.File(f"{UNIFORM_DIR}Ribonanza2{lib}_DMS.h5", "r")
            r2, rd, sn2, snd = h2["reactivity"], hd["reactivity"], h2["SNR"], hd["SNR"]
            for sid in sids:
                seq = seqmap.get(sid) or cifseq.get(sid, "")
                rec = {"seq": seq, "dms": None, "a23": None, "sn": [None, None]}
                fi = int(sid.split("-")[0]) - 1
                ss = substart.get(fi)
                if ss is not None and seq:
                    a23 = np.asarray(r2[fi][ss - 1: ss - 1 + len(seq)], np.float32)
                    dms = np.asarray(rd[fi][ss - 1: ss - 1 + len(seq)], np.float32)
                    rec["a23"] = nan_list(a23)
                    rec["dms"] = nan_list([dms[i] if seq[i] in "AC" else float("nan") for i in range(len(seq))])
                    rec["sn"] = [round(float(snd[fi]), 2), round(float(sn2[fi]), 2)]
                json.dump(rec, open(f"{args.out}/react/{sid}.json", "w"), separators=(",", ":"))
                n_react += 1
            h2.close()
            hd.close()
        elif lib in ("F", "G", "H"):
            u2 = h5py.File(f"{UNIFORM_DIR}Ribonanza2FGH_2A3.h5", "r")
            ud = h5py.File(f"{UNIFORM_DIR}Ribonanza2FGH_DMS.h5", "r")
            d2 = h5py.File(f"{FGH_DEFAULT_DIR}combined_2A3_samples_normalized.h5", "r")
            u2r, udr, u2sn, udsn, d2r = u2["reactivity"], ud["reactivity"], u2["SNR"], ud["SNR"], d2["reactivity"]
            for sid in sids:
                seq = seqmap.get(sid) or cifseq.get(sid, "")
                rec = {"seq": seq, "dms": None, "a23": None, "sn": [None, None]}
                if sid in ovr:
                    pa2 = np.asarray(ovr[sid][1], np.float32)              # default-spread 2A3, design-aligned
                    L = len(pa2)
                    row = FGH_LIBOFF[lib] + int(sid.split("-")[0]) - 1
                    if np.isfinite(pa2).sum() >= 5:
                        bo = fgh_offset(pa2, np.asarray(d2r[row], np.float32))
                        if bo is not None and bo[0] < 0.02:              # offset locked to the default h5
                            sh = bo[1]
                            rec["a23"] = nan_list(np.asarray(u2r[row][sh:sh + L], np.float32))
                            rec["dms"] = nan_list(np.asarray(udr[row][sh:sh + L], np.float32))
                            rec["sn"] = [round(float(udsn[row]), 2), round(float(u2sn[row]), 2)]
                            n_fgh_ok += 1
                    if rec["a23"] is None:
                        n_fgh_nosig += 1                                  # no recoverable signal -> null (faithful)
                json.dump(rec, open(f"{args.out}/react/{sid}.json", "w"), separators=(",", ":"))
                n_react += 1
            u2.close()
            ud.close()
            d2.close()
        else:
            for sid in sids:
                seq = seqmap.get(sid) or cifseq.get(sid, "")
                json.dump({"seq": seq, "dms": None, "a23": None, "sn": [None, None]},
                          open(f"{args.out}/react/{sid}.json", "w"), separators=(",", ":"))
                n_react += 1

    print(f"dist/: {n_struct} structs (gz), {n_react} react json "
          f"(F-H uniform: {n_fgh_ok} with signal, {n_fgh_nosig} null), table copied -> {args.out}")


if __name__ == "__main__":
    main()
