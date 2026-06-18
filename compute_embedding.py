#!/usr/bin/env python
"""2D embedding per fold for the scatter "map" view. t-SNE over standardized per-fold
features (confidence, novelty, structure metrics, cluster size) + tertiary-motif one-hot.
Writes ex, ey (normalized to 0..1) into each dataset's folds.json.

  python compute_embedding.py --name ribo2
Run in the `rna` env (sklearn).
"""
import argparse
import json
import math
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
NUM_FEATS = ["length", "plddt", "gpde", "contact_ratio", "bp_fraction", "n_tert", "n_rare",
             "pseudoknot", "best_tm1", "shape_agr", "fold_size", "seq_cluster_size"]
LOG_FEATS = {"fold_size", "seq_cluster_size", "length"}


def path_for(name):
    return f"{ROOT}/data/folds.json" if name == "ribo2" else f"{ROOT}/dist/datasets/{name}/data/folds.json"


def main():
    import numpy as np
    from sklearn.preprocessing import StandardScaler
    from sklearn.manifold import TSNE
    from sklearn.decomposition import PCA
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    args = ap.parse_args()
    fp = path_for(args.name)
    folds = json.load(open(fp))
    n = len(folds)

    # motif one-hot
    motifs = sorted({m for f in folds for m in (f.get("motifs") or [])})
    # numeric features present with variance
    feats = []
    for k in NUM_FEATS:
        vals = [f.get(k) for f in folds]
        present = [v for v in vals if isinstance(v, (int, float))]
        if len(present) >= max(10, 0.2 * n) and len(set(present)) > 1:
            feats.append(k)
    cols = []
    for f in folds:
        row = []
        for k in feats:
            v = f.get(k)
            v = float(v) if isinstance(v, (int, float)) else float("nan")
            if k in LOG_FEATS and v == v:
                v = math.log1p(max(v, 0))
            row.append(v)
        for m in motifs:
            row.append(1.0 if m in (f.get("motifs") or []) else 0.0)
        cols.append(row)
    X = np.array(cols, float)
    # impute NaN with column mean
    for j in range(X.shape[1]):
        col = X[:, j]; m = np.nanmean(col) if np.any(~np.isnan(col)) else 0.0
        col[np.isnan(col)] = m
    Xs = StandardScaler().fit_transform(X)
    print(f"{args.name}: {n} folds, {len(feats)} numeric + {len(motifs)} motif features")

    if n <= 5:
        emb = PCA(n_components=2).fit_transform(Xs) if n > 2 else np.zeros((n, 2))
    else:
        Xp = PCA(n_components=min(20, Xs.shape[1]), random_state=0).fit_transform(Xs)
        emb = TSNE(n_components=2, perplexity=min(30, max(5, n // 100)),
                   init="pca", random_state=0).fit_transform(Xp)
    # normalize each axis to 0..1
    mn, mx = emb.min(0), emb.max(0)
    rng = np.where((mx - mn) > 0, mx - mn, 1.0)
    emb = (emb - mn) / rng
    for f, (x, y) in zip(folds, emb):
        f["ex"] = round(float(x), 4); f["ey"] = round(float(y), 4)
    json.dump(folds, open(fp, "w"), separators=(",", ":"))
    print(f"{args.name}: wrote ex,ey for {n} folds -> {fp}")


if __name__ == "__main__":
    main()
