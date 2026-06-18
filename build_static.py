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

    # reactivity, batched per library
    bylib = defaultdict(list)
    for sid in ids:
        bylib[sid.split("-")[1].replace("ribonanza2", "")].append(sid)

    # F-H override parquet — filter to our F-H ids (the full chemmap is ~6.9M rows / 2 GB)
    ovr = {}
    fgh_ids = [s for s in ids if s.split("-")[1].replace("ribonanza2", "").upper() not in "ABCDE"]
    if fgh_ids and os.path.exists(REACT_OVERRIDE):
        t = pq.read_table(REACT_OVERRIDE, filters=[("sequence_id", "in", fgh_ids)]).to_pydict()
        for i, s in enumerate(t["sequence_id"]):
            ovr[s] = (t["reactivity_DMS"][i], t["reactivity_2A3"][i])

    n_react = 0
    for lib, sids in bylib.items():
        substart = {}
        if lib in HDF5:
            fis = [int(s.split("-")[0]) - 1 for s in sids]
            tbl = pq.read_table(PARQUET.format(L=lib.upper()), columns=["fasta_index", "sub_start"],
                                filters=[("fasta_index", "in", fis)]).to_pydict()
            substart = dict(zip(tbl["fasta_index"], tbl["sub_start"]))
        h5 = h5py.File(HDF5[lib], "r") if lib in HDF5 else None
        for sid in sids:
            seq = seqmap.get(sid) or cifseq.get(sid, "")
            rec = {"seq": seq, "dms": None, "a23": None, "sn": [None, None]}
            if sid in ovr:
                dlen = len(seq) or len(ovr[sid][1])
                rec["dms"] = nan_list(np.asarray(ovr[sid][0], np.float32)[:dlen])
                rec["a23"] = nan_list(np.asarray(ovr[sid][1], np.float32)[:dlen])
            elif h5 is not None and seq:
                fi = int(sid.split("-")[0]) - 1
                ss = substart.get(fi)
                if ss is not None:
                    seg = h5["r_norm"][fi][ss - 1: ss - 1 + len(seq)]
                    sn = h5["signal_to_noise"][fi]
                    rec["dms"] = nan_list([seg[i, 0] if seq[i] in "AC" else float("nan") for i in range(len(seq))])
                    rec["a23"] = nan_list(seg[:, 1])
                    rec["sn"] = [round(float(sn[0]), 2), round(float(sn[1]), 2)]
            json.dump(rec, open(f"{args.out}/react/{sid}.json", "w"), separators=(",", ":"))
            n_react += 1
        if h5 is not None:
            h5.close()

    print(f"dist/: {n_struct} structs (gz), {n_react} react json, table copied -> {args.out}")


if __name__ == "__main__":
    main()
