#!/usr/bin/env python
"""Assemble the explorer feature table from the mined curated set.

Merges the per-fold TSVs produced by the rna_motif / SHAPE / novelty pipeline
(lsf/20260612_rna_motif_chaitanya/) into two static JSON files the web UI loads:

  data/folds.json   one record per fold (scalar features for client-side filtering/ranking)
  data/motifs.json  {seq_id: [[motif_type, "A:6-8"], ...]}  (motif spans for the deep view)
  data/paths.json   {seq_id: absolute .cif path}            (served lazily by serve.py)

Everything here is manifest/TSV-driven -- no filesystem scans over the atlas trees.
Run in the `base` (or any) python env -- only needs csv/json.
"""
import argparse
import csv
import json
import os
import re
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
try:
    _CFG = json.load(open(os.path.join(ROOT, "config.json")))
    EXP_DEFAULT = _CFG["mined_dir"]
    PARQ_TMPL = _CFG.get("metadata_parquet", "")
except Exception:
    EXP_DEFAULT = ""
    PARQ_TMPL = ""

TERT = {"A_MINOR", "TL_RECEPTOR", "UA_HANDLE", "T_LOOP", "GA_MINOR", "PLATFORM",
        "TANDEM_GA_SHEARED", "TANDEM_GA_WATSON_CRICK", "TETRALOOP_TL_RECEPTOR"}
RARE_TERT = {"TL_RECEPTOR", "GA_MINOR", "T_LOOP", "TETRALOOP_TL_RECEPTOR", "UA_HANDLE"}


def rows(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f, delimiter="\t"))


def fl(x):
    try:
        v = float(x)
        return v if v == v else None  # drop NaN
    except (TypeError, ValueError):
        return None


def human_name(sublibrary, source_id):
    """Readable name from sublibrary + source_id (mirrors the deck naming)."""
    sub = (sublibrary or "").strip()
    sid = (source_id or "").strip()
    if sub.startswith("gRNAde"):
        m = re.search(r"id=(\S+)", sid)
        return f"gRNAde design — target PDB {m.group(1)}" if m else "gRNAde design"
    if sub.startswith("UW"):
        return f"UW design {sid}" if sid else "UW design"
    if sub.startswith("rnamake"):
        pdbs = sorted(set(re.findall(r"\.([0-9][A-Za-z0-9]{3})\.", sid)))
        return "RNAMake assembly" + (f" (from {', '.join(pdbs)})" if pdbs else "")
    if "RNAcentral" in sub:
        return f"natural RNA · {sub}"
    if "utrs_windows" in sub:
        return f"natural UTR · {sub.split('.')[0].replace('_', ' ')}"
    return sub.replace("_", " ") if sub else ""


def load_source_ids(sel):
    """Batch-read source_id for A-E folds from the per-library metadata parquet."""
    if not PARQ_TMPL:
        return {}
    try:
        import pyarrow.parquet as pq
    except Exception:
        return {}
    bylib = defaultdict(list)
    for sid in sel:
        lib = sid.split("-")[1].replace("ribonanza2", "").upper()
        if lib in "ABCDE":
            bylib[lib].append(sid)
    out = {}
    for lib, sids in bylib.items():
        fis = [int(s.split("-")[0]) - 1 for s in sids]
        try:
            t = pq.read_table(PARQ_TMPL.format(L=lib), columns=["fasta_index", "source_id"],
                              filters=[("fasta_index", "in", fis)]).to_pydict()
            m = dict(zip(t["fasta_index"], t["source_id"]))
            for s in sids:
                v = m.get(int(s.split("-")[0]) - 1)
                if v:
                    out[s] = v
        except Exception as e:
            print(f"  source_id read failed for {lib}: {e}")
    return out


def parse_residues(s):
    """'A:6-8' or 'A:6-8,A:12' -> [[6,8],[12,12]] (numeric design-position ranges)."""
    out = []
    for chunk in s.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        rng = chunk.split(":")[-1]  # drop chain prefix
        if "-" in rng:
            a, b = rng.split("-")[:2]
        else:
            a = b = rng
        try:
            out.append([int(a), int(b)])
        except ValueError:
            continue
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", default=EXP_DEFAULT, help="mined-set dir (chaitanya)")
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    args = ap.parse_args()
    E = args.exp
    os.makedirs(args.out, exist_ok=True)

    sel = {r["seq_id"]: r for r in rows(f"{E}/selection.tsv")}
    meta = {r["seq_id"]: r for r in rows(f"{E}/fold_metadata.tsv")}
    short = {r["seq_id"]: r for r in rows(f"{E}/summary/shortlist.tsv")}

    # per-fold SHAPE support from the unified A-H gate: mean 2A3 protection over the
    # fold's tertiary motifs with SN>1 (matches build_shortlist.py). Covers all letters.
    prot = {}
    for g in rows(f"{E}/summary/motifs_shape_gated_AH.tsv"):
        if g["motif_type"] not in TERT:
            continue
        p, sn = fl(g.get("prot_2a3")), fl(g.get("sn_2a3"))
        if p is None or sn is None or sn <= 1:
            continue
        prot.setdefault(g["seq_id"], []).append(p)
    mean_prot = {sid: sum(v) / len(v) for sid, v in prot.items()}

    # motifs aggregated per fold + spans for the deep view
    spans = {}
    agg = {}
    for m in rows(f"{E}/summary/motifs_labeled.tsv"):
        sid = m["seq_id"]
        spans.setdefault(sid, []).append([m["motif_type"], m["residues"]])
        a = agg.setdefault(sid, {"motifs": set(), "tert": set(), "rare": set()})
        a["motifs"].add(m["motif_type"])
        if m["motif_type"] in TERT:
            a["tert"].add(m["motif_type"])
        if m["motif_type"] in RARE_TERT:
            a["rare"].add(m["motif_type"])

    # continuous novelty (best_tm1 vs v341) + nearest known fold, from candidate TSVs
    novelty = {}
    for fn, tm_col, near_col in [
        ("summary/per_letter_candidates.tsv", "best_tm1", "near"),
        ("summary/top10_novelty_v341.tsv", "best_tm1_v341", "nearest_known"),
        ("summary/top10b_novelty_v341.tsv", "best_tm1_v341", "nearest_known"),
        ("summary/pk_candidates.tsv", "best_tm1", "near"),
    ]:
        for r in rows(f"{E}/{fn}"):
            tm = fl(r.get(tm_col))
            if tm is None:
                continue
            novelty.setdefault(r["seq_id"], {"best_tm1": tm, "near": r.get(near_col, "")})

    # human-readable names
    names = {}
    for fn in ["summary/per_letter_names.tsv", "summary/candidate_names.tsv", "summary/pk_names.tsv"]:
        for r in rows(f"{E}/{fn}"):
            names.setdefault(r["seq_id"], r.get("human_name", ""))
    # derive names for the rest from sublibrary + source_id
    src_ids = load_source_ids(sel)

    folds = []
    for sid, s in sel.items():
        md = meta.get(sid, {})
        a = agg.get(sid, {"motifs": set(), "tert": set(), "rare": set()})
        sh = short.get(sid, {})
        nv = novelty.get(sid, {})
        r2a3 = fl(md.get("r_2a3_ispaired"))
        mp = mean_prot.get(sid)
        # SHAPE-supported: per-residue protection>0 (any letter) OR fold pairing agreement r2a3<-0.2
        shape_ok = 1 if ((mp is not None and mp > 0) or (r2a3 is not None and r2a3 < -0.2)) else 0
        length = md.get("length") or len(s.get("design_sequence", ""))
        rec = {
            "id": sid,
            "name": names.get(sid) or human_name(s.get("sublibrary", ""), src_ids.get(sid, "")),
            "letter": s.get("letter", md.get("letter", "")),
            "source": md.get("source", ""),
            "sublibrary": s.get("sublibrary", ""),
            "length": int(length) if str(length).isdigit() else None,
            "plddt": fl(s.get("mean_plddt")) or fl(md.get("plddt")),
            "gpde": fl(s.get("mean_gpde")) or fl(md.get("gpde")),
            "clashscore": fl(md.get("final_clashscore") or md.get("clashscore")),
            "n_tert": len(a["tert"]),
            "n_rare": len(a["rare"]),
            "motifs": sorted(a["motifs"]),
            "pseudoknot": 1 if md.get("pseudoknot") == "1" else 0,
            "ss_class": md.get("ss_class", ""),
            "r2a3": r2a3,
            "mean_prot_2a3": mp if mp is not None else fl(sh.get("mean_prot_2a3")),
            "shape_ok": shape_ok,
            "openknot": fl(md.get("openknot_score")),
            "overlap_ae": fl(md.get("overlap_ae_tm1")),
            "is_novel_v341": 1 if md.get("is_novel_v341") == "1" else 0,
            "best_tm1": nv.get("best_tm1"),
            "near": nv.get("near", ""),
            "score": fl(sh.get("score")),
            "in_shortlist": 1 if sid in short else 0,
        }
        folds.append(rec)

    folds.sort(key=lambda r: (-(r["plddt"] or 0)))
    with open(f"{args.out}/folds.json", "w") as f:
        json.dump(folds, f, separators=(",", ":"))
    with open(f"{args.out}/motifs.json", "w") as f:
        json.dump(spans, f, separators=(",", ":"))

    n_tm = sum(1 for r in folds if r["best_tm1"] is not None)
    n_sh = sum(1 for r in folds if r["shape_ok"])
    print(f"folds.json: {len(folds)} folds  ({n_sh} SHAPE-supported, {n_tm} with continuous best_tm1)")
    print(f"motifs.json: {len(spans)} folds with motif spans  (structure paths resolved at serve time via config.json)")


if __name__ == "__main__":
    main()
