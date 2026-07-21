#!/usr/bin/env python
"""Add global sequence-cluster + structural-fold IDs and their member-count sizes to the
ribo2 folds (the curated fold representatives), from the A-H distillation handoff manifest.

Manifest (1.73M A-H rows): global_seq_cluster_id, global_fold_id, is_curated_rep, ...
Our 7,757 ribo2 folds == is_curated_rep rows. We add per fold:
  global_fold_id, fold_size            (# A-H entries that adopt this structural fold)
  global_seq_cluster_id, seq_cluster_size  (# A-H entries in the rep's sequence cluster)
  overlap_global_fold_id               (nearest A-E fold for an FGH fold)

Run in the `rna` env; updates data/folds.json.
"""
import json
import os
from collections import Counter

ROOT = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.environ.get(
    "AH_MANIFEST",
    "/groups/das/home/joshic/RNAnix/projects/20260609_ribonanza2_distillation_FGH/"
    "handoff/annotation_manifest.parquet")


def toi(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return None


def main():
    import pyarrow.parquet as pq
    t = pq.read_table(MANIFEST, columns=[
        "seq_id", "global_seq_cluster_id", "global_fold_id",
        "overlap_global_fold_id", "is_curated_rep"]).to_pydict()
    fold_size = Counter(v for x in t["global_fold_id"] if (v := toi(x)) is not None)
    seq_size = Counter(v for x in t["global_seq_cluster_id"] if (v := toi(x)) is not None)
    rep = {}
    for i, cur in enumerate(t["is_curated_rep"]):
        if toi(cur) == 1:
            rep[t["seq_id"][i]] = (toi(t["global_seq_cluster_id"][i]), toi(t["global_fold_id"][i]),
                                   toi(t["overlap_global_fold_id"][i]))
    print(f"manifest: {len(t['seq_id'])} rows, {len(fold_size)} folds, {len(seq_size)} seq clusters, {len(rep)} curated reps")

    folds = json.load(open(f"{ROOT}/data/folds.json"))
    n = 0
    for f in folds:
        r = rep.get(f["id"])
        if not r:
            continue
        scid, fid, ovl = r
        if scid is not None:
            f["global_seq_cluster_id"] = int(scid)
            f["seq_cluster_size"] = int(seq_size.get(scid, 0))
        if fid is not None:
            f["global_fold_id"] = int(fid)
            f["fold_size"] = int(fold_size.get(fid, 0))
        if ovl is not None:
            f["overlap_global_fold_id"] = int(ovl)
        n += 1
    json.dump(folds, open(f"{ROOT}/data/folds.json", "w"), separators=(",", ":"))
    sizes = sorted((f.get("fold_size", 0) for f in folds), reverse=True)
    print(f"enriched {n} folds; fold_size top5={sizes[:5]} median={sizes[len(sizes)//2]}")


if __name__ == "__main__":
    main()
