#!/usr/bin/env python
"""Phase-1 enrichment for the ribo2-iq-curated dataset.

Run AFTER build_iq_curated.py -> derive_ss.py -> compute_embedding.py. Reads the existing
outputs (does NOT rebuild structs/folds) and adds:

  react/<key>.json:
    pred_dms, pred_a23  -- RNAnix-predicted 1D reactivity (profile_1D cols 0/1 from the
                           per-fold .profiles.npz; cols 2-9 are constant-0.5 padding).

  data/folds.json:
    r2a3, shape_agr, shape_ok  -- SHAPE-pairing agreement, same definition as ribo2
                                  (build_feature_table.py): r2a3 = pearson(is_paired, 2A3),
                                  shape_agr = -r2a3, shape_ok = 1 if r2a3 < -0.2. is_paired
                                  comes from the derive_ss dot-bracket (pairing.json).
    pred_pearson_2a3/dms, pred_spearman_2a3/dms  -- predicted-vs-pseudolabel fidelity, joined
                                  from 11_chemmap/chemmap_correlations.tsv (a DIFFERENT metric
                                  than shape_agr; N-Q only).

Reactivity is a chemmap PSEUDOLABEL the model was conditioned on, so pairing-agreement here is
partly circular -- surfaced in the UI as "SHAPE agr (pseudolabel)". Only N-Q folds carry
reactivity (25,844); I-M stay null. Run in the `rna` env.
"""
import argparse
import csv
import json
import os
import re
from multiprocessing import Pool

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = "/groups/das/home/zouinkhim/atlas_recovery_setup/curation_iq_pLDDT70"
SNR_ROOT = "/groups/das/home/zouinkhim/atlas_recovery_setup"
NOPQ = set("NOPQ")
csv.field_size_limit(10 ** 7)


def letter_of(sid):
    m = re.search(r"ribonanza2([a-z])$", sid)
    return m.group(1).upper() if m else ""


def npz_path(sid, letter):
    lo = letter.lower()
    return (f"{SNR_ROOT}/{lo}_snr1_out/{lo}_snr1__rna_ribonanza2__shard0000of0001/"
            f"predictions/rna_ribonanza2/step_0_rna_ribonanza2_{sid}/seed_0/predictions/"
            f"step_0_rna_ribonanza2_{sid}_seed_0_sample_0.profiles.npz")


def pearson(x, y):
    """Pearson r over paired finite samples; None if <3 points or zero variance."""
    import numpy as np
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 3:
        return None
    x, y = x[m], y[m]
    if x.std() == 0 or y.std() == 0:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def clean_list(a):
    out = []
    for v in a.tolist():
        out.append(round(float(v), 4) if v == v else None)
    return out


def _determine_col_map(sample_ids):
    """Which profile_1D column is DMS vs 2A3? Fixed model convention -- decide once by
    correlating each column against the exp_reactivity_* pseudolabels over a sample."""
    import numpy as np
    c0_dms = c0_a23 = 0.0
    n = 0
    for sid in sample_ids:
        p = npz_path(sid, letter_of(sid))
        if not os.path.exists(p):
            continue
        try:
            d = np.load(p)
            prof = d["profile_1D"].astype("float32")
            edms = d["exp_reactivity_DMS"].astype("float32")
            ea23 = d["exp_reactivity_2A3"].astype("float32")
        except Exception:
            continue
        rd = pearson(prof[:, 0], edms)
        ra = pearson(prof[:, 0], ea23)
        if rd is not None and ra is not None:
            c0_dms += rd
            c0_a23 += ra
            n += 1
        if n >= 200:
            break
    # col0 is DMS if it correlates more with exp DMS than exp 2A3
    col0_is_dms = c0_dms >= c0_a23
    print(f"  profile_1D column map (from {n} folds): "
          f"col0~DMS r={c0_dms / max(n,1):.3f} col0~2A3 r={c0_a23 / max(n,1):.3f} "
          f"-> col0={'DMS' if col0_is_dms else '2A3'}")
    return col0_is_dms


_CTX = {}


def _init(ctx):
    _CTX.update(ctx)


def process(rec):
    """Per fold: load pred_* from npz, write into react json, return (id, enrichment)."""
    import numpy as np
    sid, key = rec["id"], rec["key"]
    letter = letter_of(sid)
    rj_path = f"{_CTX['od']}/react/{key}.json"
    enr = {"r2a3": None, "shape_agr": None, "shape_ok": 0}

    if letter not in NOPQ:
        return sid, enr

    try:
        rj = json.load(open(rj_path))
    except Exception:
        return sid, enr

    a23 = rj.get("a23")

    # predicted 1D reactivity from profile_1D cols 0/1
    p = npz_path(sid, letter)
    if os.path.exists(p):
        try:
            d = np.load(p)
            prof = d["profile_1D"].astype("float32")
            col_dms = 0 if _CTX["col0_is_dms"] else 1
            col_a23 = 1 - col_dms
            rj["pred_dms"] = clean_list(prof[:, col_dms])
            rj["pred_a23"] = clean_list(prof[:, col_a23])
        except Exception:
            rj.setdefault("pred_dms", None)
            rj.setdefault("pred_a23", None)
        json.dump(rj, open(rj_path, "w"), separators=(",", ":"))

    # SHAPE-pairing agreement: r2a3 = pearson(is_paired, 2A3); shape_agr = -r2a3
    dbn = _CTX["pairing"].get(sid) or ""
    if a23 and dbn and len(dbn) == len(a23):
        is_paired = [0 if c in ".-" else 1 for c in dbn]
        r = pearson(is_paired, [v if v is not None else float("nan") for v in a23])
        if r is not None:
            enr["r2a3"] = round(r, 4)
            enr["shape_agr"] = round(-r, 4)
            enr["shape_ok"] = 1 if r < -0.2 else 0
    return sid, enr


def load_chemmap(path):
    """seq_id -> {pred_pearson_2a3/dms, pred_spearman_2a3/dms} from chemmap_correlations.tsv."""
    out = {}
    if not os.path.exists(path):
        print(f"  WARNING: chemmap TSV not found: {path}")
        return out

    def fl(v):
        try:
            x = float(v)
            return round(x, 4) if x == x else None
        except (TypeError, ValueError):
            return None
    with open(path) as f:
        for r in csv.DictReader(f, delimiter="\t"):
            sid = r.get("rep_id") or r.get("seq_id")
            if not sid:
                continue
            out[sid] = {
                "pred_pearson_dms": fl(r.get("pearson_dms")),
                "pred_pearson_2a3": fl(r.get("pearson_2a3")),
                "pred_spearman_dms": fl(r.get("spearman_dms")),
                "pred_spearman_2a3": fl(r.get("spearman_2a3")),
            }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="ribo2-iq-curated")
    ap.add_argument("--workers", type=int, default=32)
    args = ap.parse_args()
    od = os.path.join(ROOT, "dist", "datasets", args.name)
    fp = f"{od}/data/folds.json"
    pp = f"{od}/data/pairing.json"

    folds = json.load(open(fp))
    pairing = json.load(open(pp))
    print(f"{args.name}: {len(folds)} folds, {len(pairing)} pairing entries", flush=True)

    col0_is_dms = _determine_col_map([f["id"] for f in folds if letter_of(f["id"]) in NOPQ][:2000])

    chem = load_chemmap(f"{SRC}/11_chemmap/chemmap_correlations.tsv")
    print(f"  chemmap fidelity rows: {len(chem)}", flush=True)

    ctx = {"od": od, "pairing": pairing, "col0_is_dms": col0_is_dms}
    enrich = {}
    with Pool(args.workers, initializer=_init, initargs=(ctx,)) as pool:
        for i, (sid, enr) in enumerate(pool.imap_unordered(process, folds, chunksize=64)):
            enrich[sid] = enr
            if (i + 1) % 4000 == 0:
                print(f"  {i + 1}/{len(folds)} ...", flush=True)

    n_agr = n_pred_fit = 0
    for f in folds:
        e = enrich.get(f["id"], {})
        f["r2a3"] = e.get("r2a3")
        f["shape_agr"] = e.get("shape_agr")
        f["shape_ok"] = e.get("shape_ok", 0)
        if f["shape_agr"] is not None:
            n_agr += 1
        c = chem.get(f["id"])
        if c:
            f.update(c)
            n_pred_fit += 1
    json.dump(folds, open(fp, "w"), separators=(",", ":"))
    print(f"\n{args.name}: shape_agr populated {n_agr}/{len(folds)}  "
          f"chemmap-fidelity {n_pred_fit}/{len(folds)}  -> {fp}")


if __name__ == "__main__":
    main()
