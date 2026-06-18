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
import string
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
try:
    _CFG = json.load(open(os.path.join(ROOT, "config.json")))
    EXP_DEFAULT = _CFG["mined_dir"]
    PARQ_TMPL = _CFG.get("metadata_parquet", "")
    STRUCT_BASES = _CFG.get("struct_bases", {})
    ANNOT = _CFG.get("annotation_manifest", "")
    REACT_OVERRIDE = _CFG.get("react_override", "")
    CROSSED_TSV = _CFG.get("crossed_tsv", "")
except Exception:
    EXP_DEFAULT = ""
    PARQ_TMPL = ""
    STRUCT_BASES = {}
    ANNOT = ""
    REACT_OVERRIDE = ""
    CROSSED_TSV = ""

PAIR_CHARS = set("()[]{}<>") | set(string.ascii_letters)


def struct_path(sid):
    lib = sid.split("-")[1].replace("ribonanza2", "").upper()
    base = STRUCT_BASES.get("AE" if lib in "ABCDE" else "FGH", "")
    return os.path.join(base, sid + ".cif") if base else ""


def contact_ratio(path):
    """C1'-C1' globularity proxy: pairs within 8 A, sequence separation >=6, / length."""
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


def load_contact_ratios(sel):
    try:
        import gemmi  # noqa: F401
    except Exception as e:
        print(f"  contact_ratio skipped (no gemmi): {e}")
        return {}
    out = {}
    for sid in sel:
        p = struct_path(sid)
        if p and os.path.exists(p):
            try:
                v = contact_ratio(p)
                if v is not None:
                    out[sid] = v
            except Exception:
                pass
    return out


def load_manifest(sel):
    """From the annotation manifest: base-paired fraction + the fold-rep dbn (via global_fold_id),
    and fold-level novelty (best_tm1_v341 / best_v341) for every fold."""
    if not ANNOT or not os.path.exists(ANNOT):
        print("  manifest annotations skipped (no annotation_manifest)")
        return {}, {}, {}, {}
    import pyarrow.parquet as pq
    t = pq.read_table(ANNOT, columns=["seq_id", "global_fold_id", "is_fold_rep", "dbn",
                                       "best_tm1_v341", "best_v341"]).to_pydict()
    rep_dbn, mem_gf = {}, {}
    tm, near = {}, {}
    for i, sid in enumerate(t["seq_id"]):
        gf, isrep, dbn = t["global_fold_id"][i], t["is_fold_rep"][i], t["dbn"][i]
        if str(isrep) in ("1", "True", "true") and dbn:
            rep_dbn[gf] = dbn
        mem_gf[sid] = gf
        v = fl(t["best_tm1_v341"][i]); nr = t["best_v341"][i] or ""
        # TM1 == 0 with no nearest chain = USalign couldn't align (too short), not "novel" — leave unscored
        if v is not None and v > 0 and nr:
            tm[sid], near[sid] = v, nr
    bp, dbns = {}, {}
    for sid in sel:
        dbn = rep_dbn.get(mem_gf.get(sid))
        if dbn:
            bp[sid] = round(sum(c in PAIR_CHARS for c in dbn) / len(dbn), 4)
            dbns[sid] = dbn
    return bp, tm, near, dbns


def load_pdb_titles(near_ids):
    """Fetch RCSB entry titles for the distinct nearest-PDB ids (cached on disk)."""
    cache_path = os.path.join(ROOT, ".rcsb_titles.json")
    cache = {}
    if os.path.exists(cache_path):
        try:
            cache = json.load(open(cache_path))
        except Exception:
            cache = {}
    import urllib.request
    pdbs = sorted({n.split("_")[0].upper() for n in near_ids if n})
    miss = [p for p in pdbs if p not in cache]
    for i, p in enumerate(miss):
        try:
            with urllib.request.urlopen(f"https://data.rcsb.org/rest/v1/core/entry/{p}", timeout=15) as r:
                d = json.load(r)
            cache[p] = ((d.get("struct") or {}).get("title") or "")
        except Exception:
            cache[p] = ""
        if i % 50 == 0:
            json.dump(cache, open(cache_path, "w"))
    json.dump(cache, open(cache_path, "w"))
    if miss:
        print(f"  RCSB titles: fetched {len(miss)} new, {len(cache)} cached")
    return cache


def regate_fgh(sel, spans, react_parquet):
    """Recompute F-H mean tertiary 2A3 protection from the full design-aligned chemmap parquet."""
    fgh = [s for s in sel if s.split("-")[1].replace("ribonanza2", "").upper() not in "ABCDE"]
    if not fgh or not react_parquet or not os.path.exists(react_parquet):
        return {}
    import pyarrow.parquet as pq
    import numpy as np
    t = pq.read_table(react_parquet, columns=["sequence_id", "reactivity_2A3"],
                      filters=[("sequence_id", "in", fgh)]).to_pydict()
    react = {s: t["reactivity_2A3"][i] for i, s in enumerate(t["sequence_id"])}
    out = {}
    for sid in fgh:
        arr = react.get(sid)
        if arr is None:
            continue
        a = np.asarray(arr, float)
        valid = a[~np.isnan(a)]
        if valid.size == 0:
            continue
        bg = float(np.median(valid))
        provals = []
        for mtype, resstr in spans.get(sid, []):
            if mtype not in TERT:
                continue
            ds = [d for rng in parse_residues(resstr) for d in range(rng[0], rng[1] + 1)]
            vals = [a[d - 1] for d in ds if 0 <= d - 1 < len(a) and not np.isnan(a[d - 1])]
            if vals:
                provals.append(bg - float(np.mean(vals)))
        if provals:
            out[sid] = round(sum(provals) / len(provals), 4)
    return out

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


def load_crossed(path):
    """crossed-pairs tertiary-complexity (Max/Rhiju), precomputed in 202606-roi-1000selection via
    lib.eval_defs.pct_crossed. seq_id -> {crossed_frac, n_crossed_pairs, mohca_regime_frac}. Joined,
    NOT recomputed here (single source of truth lives in the mohca-contact-cnn repo)."""
    out = {}
    if not path or not os.path.exists(path):
        print("  crossed_pairs skipped (no crossed_tsv in config.json)")
        return out
    for r in rows(path):
        out[r["seq_id"]] = {"crossed_frac": fl(r.get("crossed_frac")),
                            "n_crossed_pairs": fl(r.get("n_crossed_pairs")),
                            "mohca_regime_frac": fl(r.get("mohca_regime_frac"))}
    print(f"  crossed_pairs: {len(out)} folds from {os.path.basename(path)}")
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
    # structuredness metrics + manifest novelty (best_tm1 for all folds)
    contact = load_contact_ratios(sel)
    crossed = load_crossed(CROSSED_TSV)
    bpfrac, tm_manifest, near_manifest, dbns = load_manifest(sel)
    for sid in sel:
        if sid not in novelty and sid in tm_manifest:
            novelty[sid] = {"best_tm1": tm_manifest[sid], "near": near_manifest.get(sid, "")}
    # RCSB titles for the closest known fold (sanity-check display)
    titles = load_pdb_titles([d.get("near", "") for d in novelty.values()])
    # re-gate F-H SHAPE from the full design-aligned chemmap parquet
    fgh_prot = regate_fgh(sel, spans, REACT_OVERRIDE)

    folds = []
    for sid, s in sel.items():
        md = meta.get(sid, {})
        a = agg.get(sid, {"motifs": set(), "tert": set(), "rare": set()})
        sh = short.get(sid, {})
        nv = novelty.get(sid, {})
        r2a3 = fl(md.get("r_2a3_ispaired"))
        mp = fgh_prot[sid] if sid in fgh_prot else mean_prot.get(sid)
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
            "contact_ratio": contact.get(sid),
            "bp_fraction": bpfrac.get(sid),
            "crossed_frac": crossed.get(sid, {}).get("crossed_frac"),
            "n_crossed_pairs": crossed.get(sid, {}).get("n_crossed_pairs"),
            "mohca_regime_frac": crossed.get(sid, {}).get("mohca_regime_frac"),
            "r2a3": r2a3,
            "shape_agr": (round(-r2a3, 4) if r2a3 is not None else None),
            "mean_prot_2a3": mp if mp is not None else fl(sh.get("mean_prot_2a3")),
            "shape_ok": shape_ok,
            "openknot": fl(md.get("openknot_score")),
            "overlap_ae": fl(md.get("overlap_ae_tm1")),
            "is_novel_v341": 1 if md.get("is_novel_v341") == "1" else 0,
            "best_tm1": nv.get("best_tm1"),
            "near": nv.get("near", ""),
            "near_title": titles.get((nv.get("near", "") or "").split("_")[0].upper(), ""),
            "score": fl(sh.get("score")),
            "in_shortlist": 1 if sid in short else 0,
        }
        folds.append(rec)

    folds.sort(key=lambda r: (-(r["plddt"] or 0)))
    with open(f"{args.out}/folds.json", "w") as f:
        json.dump(folds, f, separators=(",", ":"))
    with open(f"{args.out}/motifs.json", "w") as f:
        json.dump(spans, f, separators=(",", ":"))
    with open(f"{args.out}/pairing.json", "w") as f:
        json.dump(dbns, f, separators=(",", ":"))

    n_tm = sum(1 for r in folds if r["best_tm1"] is not None)
    n_sh = sum(1 for r in folds if r["shape_ok"])
    n_cr = sum(1 for r in folds if r["contact_ratio"] is not None)
    n_bp = sum(1 for r in folds if r["bp_fraction"] is not None)
    print(f"folds.json: {len(folds)} folds  ({n_sh} SHAPE-supported, {n_tm} best_tm1, {n_cr} contact_ratio, {n_bp} bp_fraction)")
    print(f"motifs.json: {len(spans)} folds with motif spans  (structure paths resolved at serve time via config.json)")


if __name__ == "__main__":
    main()
