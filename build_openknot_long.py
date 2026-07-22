#!/usr/bin/env python
"""Build the OpenKnot long-design source (OK7b/OK8, >=200 nt) from EXISTING RNAnix predictions.

No new inference: the unfiltered OpenKnot 3D predictions already live in
`/nrs/das/rnastruct/joshic/RNAnix_predictions/ribonanza_openknot_atlas_v1__*chemmap_on*__shard*`
(250 shards, length-batched; the >=200 nt designs sit in the high-index shards). The long
designs are `0pad0` so the predicted structure's sequence == the OpenKnotBench design_sequence
(no trim). We match prediction <-> OpenKnotBench v4.5.1 by design_sequence to attach the 2A3
SHAPE reactivity (sliced to the design region) + metadata.

Output (explorer dataset layout):
  dist/datasets/<name>/structs/<key>.pdb       (gzip bytes; served with content-encoding gzip)
  dist/datasets/<name>/react/<key>.json        ({seq, dms:null, a23[], sn})
  dist/datasets/<name>/data/folds.json         (one record/design)
  dist/datasets/<name>/data/motifs.json        ({} -- no tertiary-motif scan for this source)
Then run:  enrich_openknot_long_react.py --names <name>   (replaces the placeholder a23/dms
             above with real 1D cmuts DMS+2A3 -- OpenKnotBench's own coverage tops out around
             ~100nt median for these ~240nt designs, so most of it is otherwise null/sparse)
           derive_ss.py --name <name>   (pairing.json + ss/termini fields)
           enrich_pseudolabels_shape.py --dataset-root dist/datasets/<name>   (r2a3/shape_agr/
             shape_ok from the real a23 vs pairing.json -- otherwise these stay null and the
             SHAPE column reads "no" for every record despite real reactivity being present)
           compute_embedding.py --name <name>   (ex,ey for the map)

Run in the `rna` env.
"""
import argparse
import csv
import glob
import gzip
import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
OKB = "/groups/das/home/joshic/RNAnix/release_data/openknotbench/OpenKnotBench_data.v4.5.1.txt"
PRED = "/nrs/das/rnastruct/joshic/RNAnix_predictions"
# Two existing full prediction runs (same M5 ckpt), selected by --chemmap:
#   on  = SHAPE-guided (enable_chemmap_input: true)
#   off = sequence-only (enable_chemmap_input: false)  <- what Rhiju's "OpenKnotAIDesign" wants
PRED_GLOB = {
    "on":  "ribonanza_openknot_atlas_v1__M5_chemmap_no_trunk_step6499__chemmap_on__rna_ribonanza_openknot__shard{sh:04d}of0250",
    "off": "ribonanza_openknot_atlas_v1__M5_chemmap_no_trunk_step6499__rna_ribonanza_openknot__shard{sh:04d}of0250",
}
csv.field_size_limit(10 ** 7)


def norm(s):
    return (s or "").strip().upper().replace("T", "U")


def key_of(sid):
    k = re.sub(r"[^A-Za-z0-9_-]+", "_", sid).strip("_")[:70]
    return f"{k}_{hashlib.md5(sid.encode()).hexdigest()[:6]}"


def fl(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def pdb_seq(fp):
    """5'->3' sequence (one chain) from C1' atom lines of a (gzipped) PDB."""
    m = {"A": "A", "U": "U", "G": "G", "C": "C", "RA": "A", "RU": "U", "RG": "G", "RC": "C",
         "ADE": "A", "URA": "U", "GUA": "G", "CYT": "C"}
    seen, order = {}, []
    op = gzip.open(fp, "rt") if fp.endswith(".gz") else open(fp)
    with op as f:
        for line in f:
            if line.startswith(("ATOM", "HETATM")) and line[12:16].strip() == "C1'":
                r = line[22:27]
                if r not in seen:
                    seen[r] = line[17:20].strip()
                    order.append(r)
    return "".join(m.get(seen[r], "N") for r in order)


def contact_ratio(fp):
    import gemmi
    import numpy as np
    try:
        st = gemmi.read_structure(fp)            # gemmi reads .gz by extension
    except Exception:
        return None
    pts = []
    for r in st[0][0]:
        for a in r:
            if a.name in ("C1'", "C1*"):
                pts.append([a.pos.x, a.pos.y, a.pos.z]); break
    n = len(pts)
    if n < 2:
        return None
    P = np.asarray(pts)
    D = np.sqrt(((P[:, None, :] - P[None, :, :]) ** 2).sum(-1))
    idx = np.arange(n)
    sep = np.abs(idx[:, None] - idx[None, :])
    return round(int(np.triu((D <= 8.0) & (sep >= 6), 1).sum()) / n, 4)


def load_okb(minlen):
    """norm(design_sequence) -> best-SN row: design_sequence, length, sub_start/end, 2A3 (design-aligned),
    SN, openknot score, eterna title, id."""
    best = {}
    with open(OKB) as f:
        rd = csv.DictReader(f)
        rcols = [c for c in rd.fieldnames if c.startswith("reactivity_0")]
        for r in rd:
            try:
                dl = int(float(r.get("design_length") or 0))
            except ValueError:
                dl = 0
            if dl < minlen:
                continue
            ds = r.get("design_sequence", "")
            key = norm(ds)
            if not key:
                continue
            sn = fl(r.get("signal_to_noise")) or 0.0
            if key in best and best[key]["sn"] >= sn:
                continue
            ss = int(fl(r.get("sub_start")) or 1)
            a23 = [fl(r.get(c)) for c in rcols][ss - 1: ss - 1 + dl]
            best[key] = {"design_sequence": ds, "length": dl, "sn": sn,
                         "a23": [round(v, 4) if v is not None else None for v in a23],
                         "okscore": fl(r.get("target_openknot_score")),
                         "title": (r.get("eterna_title") or "").strip(),
                         "id": (r.get("id") or "").split("\t")[0].strip()}
    return best


def main():
    import shutil
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="openknot_long")
    ap.add_argument("--label", default="OpenKnot OK7b/OK8 ≥200nt")
    ap.add_argument("--chemmap", choices=["on", "off"], default="on",
                    help="on = SHAPE-guided predictions; off = sequence-only")
    ap.add_argument("--minlen", type=int, default=200)
    ap.add_argument("--shard-lo", type=int, default=175)
    ap.add_argument("--shard-hi", type=int, default=249)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "datasets"))
    args = ap.parse_args()
    od = os.path.join(args.out, args.name)
    os.makedirs(f"{od}/data", exist_ok=True)
    os.makedirs(f"{od}/structs", exist_ok=True)
    os.makedirs(f"{od}/react", exist_ok=True)

    okb = load_okb(args.minlen)
    print(f"OpenKnotBench v4.5.1: {len(okb)} unique designs >={args.minlen} nt", flush=True)

    # scan prediction shards -> best (highest plddt) prediction per matched design_sequence
    glob_pat = PRED_GLOB[args.chemmap]
    chosen = {}   # norm(seq) -> {pdb, plddt, ptm, gpde}
    n_dirs = 0
    for sh in range(args.shard_lo, args.shard_hi + 1):
        sd = glob.glob(os.path.join(PRED, glob_pat.format(sh=sh)))
        if not sd:
            continue
        base = os.path.join(sd[0], "predictions", "rna_ribonanza_openknot")
        for d in glob.glob(os.path.join(base, "step_0_*")):
            pdbs = glob.glob(os.path.join(d, "seed_0", "predictions", "*.relaxed.pdb.gz"))
            if not pdbs:
                continue
            n_dirs += 1
            try:
                key = norm(pdb_seq(pdbs[0]))
            except Exception:
                continue
            rec = okb.get(key)
            if not rec or len(key) < args.minlen:
                continue
            conf = glob.glob(os.path.join(d, "seed_0", "predictions", "*summary_confidence*sample_0.json.gz"))
            plddt = ptm = gpde = None
            if conf:
                try:
                    c = json.load(gzip.open(conf[0], "rt"))
                    plddt, ptm, gpde = c.get("plddt"), c.get("ptm"), c.get("gpde")
                except Exception:
                    pass
            if key not in chosen or (plddt or 0) > (chosen[key]["plddt"] or 0):
                chosen[key] = {"pdb": pdbs[0], "plddt": plddt, "ptm": ptm, "gpde": gpde}
        if args.limit and len(chosen) >= args.limit:
            break
    print(f"scanned {n_dirs} predicted structures; matched {len(chosen)} designs with both structure + OpenKnotBench", flush=True)

    folds = []
    for key, pr in chosen.items():
        rec = okb[key]
        cid = rec["id"] or f"oklong-{len(folds):05d}"
        k = key_of(cid + "|" + key[:20])
        shutil.copyfile(pr["pdb"], f"{od}/structs/{k}.pdb")     # keep gzip bytes
        cr = contact_ratio(pr["pdb"])
        json.dump({"seq": rec["design_sequence"], "dms": None, "a23": rec["a23"],
                   "sn": [None, round(rec["sn"], 2) if rec["sn"] else None]},
                  open(f"{od}/react/{k}.json", "w"), separators=(",", ":"))
        folds.append({
            "id": cid, "key": k, "name": rec["title"], "letter": "", "source": args.label,
            "sublibrary": "", "length": rec["length"],
            "plddt": round(pr["plddt"], 2) if pr["plddt"] is not None else None,
            "ptm": round(pr["ptm"], 4) if pr["ptm"] is not None else None,
            "gpde": round(pr["gpde"], 4) if pr["gpde"] is not None else None,
            "clashscore": None, "n_tert": 0, "n_rare": 0, "motifs": [], "pseudoknot": 0,
            "ss_class": "", "r2a3": None, "shape_agr": None, "mean_prot_2a3": None, "shape_ok": 0,
            "openknot": rec["okscore"], "overlap_ae": None,
            "is_novel_v341": 0, "best_tm1": None, "near": "", "near_title": "", "score": None,
            "contact_ratio": cr, "bp_fraction": None, "in_shortlist": 0,
            "seq_cluster_size": None, "struct_rep": 1,
        })
    folds.sort(key=lambda x: -(x["plddt"] or 0))
    json.dump(folds, open(f"{od}/data/folds.json", "w"), separators=(",", ":"))
    if not os.path.exists(f"{od}/data/motifs.json"):
        json.dump({}, open(f"{od}/data/motifs.json", "w"))
    nchem = sum(1 for k in chosen if okb[k]["a23"] and any(v is not None for v in okb[k]["a23"]))
    print(f"{args.name}: {len(folds)} folds, {nchem} with 2A3 signal -> {od}  (label={args.label!r})", flush=True)


if __name__ == "__main__":
    main()
