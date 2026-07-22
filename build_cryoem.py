#!/usr/bin/env python
"""Build the OK8 cryo-EM candidates source from local RNAnix predictions.

The 28 cryo-EM candidate 240-mers (from "Cryo-EM Candidates - Sheet1.csv") are
round-8 Eterna designs NOT present in OpenKnotBench v4.5.1, so they were predicted
fresh on the LSF cluster (predict_rna.py, M5 checkpoint):
  - sequence-only  (--use_msa False)     -> pred dir cryo_tmp/pred
  - MSA-conditioned (--use_msa True)      -> pred dir cryo_tmp/pred_msa

Each candidate has 5 diffusion samples; we pick the highest-pLDDT sample.
predict_rna.py output is NOT relaxed (no ".relaxed." files) -> use the raw sample.

Output (explorer dataset layout):
  dist/datasets/<name>/structs/<key>.pdb     (gzip bytes; served content-encoding gzip)
  dist/datasets/<name>/react/<key>.json      ({seq, dms:null, a23:null, sn:[null,null]})
  dist/datasets/<name>/data/folds.json       (one record/candidate + CSV metadata)
  dist/datasets/<name>/data/motifs.json      ({} -- rna_motif scan added later)
Then run:  enrich_openknot_long_react.py --names <name>   (real 1D cmuts DMS+2A3 -- the cryo-EM
             candidates ARE in ok7ab8_metadata_combined.parquet, contrary to the "no experimental
             SHAPE" note above; the dms:null placeholder written here gets replaced)
           derive_ss.py --name <name>   (pairing.json + bp_fraction/pseudoknot/ss_class -- these
             stay null in folds.json until this runs, even though pairing.json may already exist)
           enrich_pseudolabels_shape.py --dataset-root dist/datasets/<name>   (r2a3/shape_agr/shape_ok)
           compute_embedding.py --name <name>   (ex,ey for the map -- absent until this runs)

Run in the `rna` env.
"""
import argparse
import glob
import gzip
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


def contact_ratio(path):
    """C1'-C1' globularity proxy: pairs within 8 A, sequence separation >=6, / length.
    Same calc as build_dataset.py / build_feature_table.py / build_openknot_long.py."""
    import gemmi
    import numpy as np
    st = gemmi.read_structure(path)
    pts = []
    for r in st[0][0]:
        for atom in r:
            if atom.name in ("C1'", "C1*"):
                pts.append([atom.pos.x, atom.pos.y, atom.pos.z]); break
    n = len(pts)
    if n < 2:
        return None
    P = np.asarray(pts)
    D = np.sqrt(((P[:, None, :] - P[None, :, :]) ** 2).sum(-1))
    idx = np.arange(n)
    sep = np.abs(idx[:, None] - idx[None, :])
    mask = np.triu((D <= 8.0) & (sep >= 6), 1)
    return round(int(mask.sum()) / n, 4)


def best_sample(pred_dir, name):
    """Return (sample_idx, conf_dict, pdb_path) for the highest-pLDDT sample."""
    preds = f"{pred_dir}/{name}/seed_101/predictions"
    best = None
    for cj in glob.glob(f"{preds}/*summary_confidence_sample_*.json"):
        d = json.load(open(cj))
        k = int(cj.split("_sample_")[1].split(".")[0])
        pl = d.get("plddt") or 0
        if best is None or pl > best[0]:
            best = (pl, k, d)
    if best is None:
        return None
    _, k, d = best
    pdb = f"{preds}/{name}_seed_101_sample_{k}.pdb"
    return (k, d, pdb) if os.path.exists(pdb) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="dataset dir name, e.g. openknot_cryoem_seq")
    ap.add_argument("--pred-dir", required=True, help="predictions dir (cryo_tmp/pred or pred_msa)")
    ap.add_argument("--source", required=True, help="display source label")
    ap.add_argument("--meta", default=f"{ROOT}/cryo_tmp/candidates_meta.json")
    args = ap.parse_args()

    meta = json.load(open(args.meta))
    out = f"{ROOT}/dist/datasets/{args.name}"
    os.makedirs(f"{out}/structs", exist_ok=True)
    os.makedirs(f"{out}/react", exist_ok=True)
    os.makedirs(f"{out}/data", exist_ok=True)

    folds = []
    missing = []
    for name, mrec in meta.items():
        picked = best_sample(args.pred_dir, name)
        if not picked:
            missing.append(name)
            continue
        k, conf, pdb_path = picked
        key = name  # ok8cryo-NN is already filename-safe
        try:
            cr = contact_ratio(pdb_path)
        except Exception:
            cr = None
        # struct: gzip the raw pdb
        with open(pdb_path, "rb") as fh:
            raw = fh.read()
        with open(f"{out}/structs/{key}.pdb", "wb") as fh:
            fh.write(gzip.compress(raw))
        # reactivity: predicted-only candidates -> sequence, no experimental SHAPE
        seq = mrec["seq"]
        json.dump({"seq": seq, "dms": None, "a23": None, "sn": [None, None]},
                  open(f"{out}/react/{key}.json", "w"))

        def fl(x):
            try:
                return float(x)
            except (TypeError, ValueError):
                return None

        folds.append({
            "id": name,
            "key": key,
            "name": mrec.get("title") or name,
            "letter": "",
            "source": args.source,
            "sublibrary": mrec.get("section", ""),
            "length": len(seq),
            "plddt": round(conf.get("plddt", 0), 2),
            "ptm": conf.get("ptm"),
            "gpde": conf.get("gpde"),
            "iptm": conf.get("iptm"),
            "best_sample": k,
            "clashscore": None,
            "n_tert": 0, "n_rare": 0, "motifs": [],
            "pseudoknot": 0, "ss_class": "",
            "r2a3": None, "shape_agr": None, "mean_prot_2a3": None, "shape_ok": 0,
            "openknot": fl(mrec.get("openknot")),
            "overlap_ae": None,
            "is_novel_v341": None, "best_tm1": None, "near": None, "near_title": None,
            "score": None, "contact_ratio": cr, "bp_fraction": None,
            "in_shortlist": 0, "seq_cluster_size": None, "struct_rep": 1,
            "termini_bp": 0, "termini_trim": 0, "overhang5": 0, "overhang3": 0,
            "uucg_tetraloop": 0,
            # cryo-EM candidate metadata (from the CSV)
            "designer": mrec.get("designer", ""),
            "eterna_id": mrec.get("eterna_id", ""),
            "description": mrec.get("description", ""),
            "target_dbn": mrec.get("dotbracket", ""),
            "trrosetta_url": mrec.get("trrosetta", ""),
            "notes": mrec.get("notes", ""),
        })

    json.dump(folds, open(f"{out}/data/folds.json", "w"))
    if not os.path.exists(f"{out}/data/motifs.json"):
        json.dump({}, open(f"{out}/data/motifs.json", "w"))
    print(f"[{args.name}] wrote {len(folds)} folds -> {out}")
    if missing:
        print(f"  MISSING predictions for {len(missing)}: {missing}")


if __name__ == "__main__":
    main()
