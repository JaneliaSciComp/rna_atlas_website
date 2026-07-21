#!/usr/bin/env python
"""Patch `ribo2-iq-curated-v2` (I-Q letters, 42,631 records) per-fold react JSON with REAL
measured DMS+2A3 reactivity, replacing what's there now:
  - I/J/K/L/M: pure placeholder (null or exactly 0.0 at every position -- confirmed, not partial).
  - N/O/P/Q: the chemmap *pseudolabel* that conditioned the 3D structure model at inference time
    (real-looking, non-degenerate, but never a wet-lab measurement -- `sn`/SNR is null for
    every one of the 42,631 records today, confirming none of it is measured data).

Source: the uniform-spread cmuts126 reprocessing at `config.json`'s `uniform_spread_dir`
(`/groups/das/rnastruct/bioinformatics/atoq-upload/uniform-spread/`), already used elsewhere in
this repo for A-H (see `serve.py`/`build_static.py`). Three combined per-letter-group H5 pairs
cover all 9 I-Q letters:
  IJK -> Ribonanza2IJK_{DMS,2A3}.h5   (24M rows: I=block0, J=block1, K=block2)
  NOP -> Ribonanza2NOP_{DMS,2A3}.h5   (24M rows: N=block0, O=block1, P=block2)
  LMQ -> Ribonanza2LMQ_{DMS,2A3}.h5   (24M rows: L=block0, M=block1, Q=block2)

Row lookup: empirically validated this session against real sequences (18/18 letters/samples) --
`global_row = int(id.split("-")[0]) - 1` directly, NO additional per-letter block offset (it's
already baked into the id's numeric prefix). Confirmed the H5 row order matches the FASTA row
order too (NaN boundary at positions 0-25 / 126-176 -- the 5'/3' primer regions -- lines up
exactly for a validated row).

Design-region bounds: use each record's OWN `design_start`/`design_end` from `folds.json` (the
de-padded union already carries these), NOT the generic default sub_start=27/sub_end=156 -- many
records were re-cropped to a real length shorter than the original 130nt slot.

Also recomputes `r2a3`/`shape_agr`/`shape_ok` in folds.json from the NEW real `a23` against
`pairing.json`'s dot-bracket -- same formula as `enrich_iq.py`, but non-circular now (that script
computed it against the pseudolabel the model was conditioned on).

Also recomputes `pred_pearson_*`/`pred_spearman_*` in folds.json against the NEW real `dms`/`a23`
(the react JSON's own `pred_dms`/`pred_a23` -- the model's raw predicted profile -- already sit
right there, no raw model-output re-read needed). For every patched record this replaces the old
value (which described pred-vs-*pseudolabel* fidelity and is now stale/misleading against the
replaced real data) with either the new pred-vs-real correlation, or `None` if `pred_dms`/`pred_a23`
is absent or the correlation is undefined (zero-variance segment) -- never left silently stale.

Run in the `rna` env (needs h5py). Then re-run compute_embedding.py if ex/ey should reflect the
new reactivity (motif one-hot + scalar features feed that, not raw reactivity, so not required).
"""
import argparse
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
UNIFORM_DIR = "/groups/das/rnastruct/bioinformatics/atoq-upload/uniform-spread/"
GROUP_OF = {"I": "IJK", "J": "IJK", "K": "IJK", "N": "NOP", "O": "NOP", "P": "NOP",
            "L": "LMQ", "M": "LMQ", "Q": "LMQ"}


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / (sxx * syy) ** 0.5


def rank(xs):
    """1-based ranks with ties resolved by average rank (standard Spearman convention)."""
    n = len(xs)
    order = sorted(range(n), key=lambda i: xs[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        i = j + 1
    return ranks


def spearman(xs, ys):
    if len(xs) < 3:
        return None
    return pearson(rank(xs), rank(ys))


def pred_corr(pred, real):
    """Pearson+Spearman between a predicted array and the (possibly None-masked) real array,
    over positions where both are present. Returns (None, None) if too few paired points or
    the correlation is undefined (zero-variance segment)."""
    if not pred or not real or len(pred) != len(real):
        return None, None
    xs, ys = [], []
    for p, v in zip(pred, real):
        if p is not None and v is not None:
            xs.append(float(p)); ys.append(float(v))
    return pearson(xs, ys), spearman(xs, ys)


def main():
    import h5py
    import numpy as np

    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset-root", default=f"{ROOT}/dist/datasets/ribo2-iq-curated-v2",
                     help="dir holding data/folds.json, data/pairing.json, react/<key>.json")
    ap.add_argument("--uniform-dir", default=UNIFORM_DIR)
    ap.add_argument("--out-root", default=None,
                     help="if set, write patched react/<key>.json and data/folds.json here "
                          "instead of in place (mirrors --dataset-root layout); use when the "
                          "source tree is read-only")
    args = ap.parse_args()

    dd = f"{args.dataset_root}/data"
    rd = f"{args.dataset_root}/react"
    out_dd = f"{args.out_root}/data" if args.out_root else dd
    out_rd = f"{args.out_root}/react" if args.out_root else rd
    os.makedirs(out_dd, exist_ok=True)
    os.makedirs(out_rd, exist_ok=True)

    folds = json.load(open(f"{dd}/folds.json"))
    pairing = json.load(open(f"{dd}/pairing.json"))

    h5_cache = {}

    def h5s(group):
        if group not in h5_cache:
            h5_cache[group] = (
                h5py.File(f"{args.uniform_dir}Ribonanza2{group}_DMS.h5", "r"),
                h5py.File(f"{args.uniform_dir}Ribonanza2{group}_2A3.h5", "r"),
            )
        return h5_cache[group]

    n = n_patched = n_oob = n_len_mismatch = 0
    n_r2a3 = n_pred_dms = n_pred_a23 = 0
    for f in folds:
        n += 1
        letter = f["letter"]
        group = GROUP_OF.get(letter)
        sid, key = f["id"], f["key"]
        rj_path = f"{rd}/{key}.json"
        if group is None or not os.path.exists(rj_path):
            continue
        rj = json.load(open(rj_path))
        seq = rj.get("seq", "")
        try:
            global_row = int(sid.split("-")[0]) - 1
        except ValueError:
            continue
        ds, de = f.get("design_start"), f.get("design_end")
        if ds is None or de is None:
            json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
            continue
        ds, de = int(ds), int(de)

        h5_dms, h5_a23 = h5s(group)
        if global_row < 0 or global_row >= h5_dms["reactivity"].shape[0]:
            n_oob += 1
            json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
            continue

        dms_full = np.asarray(h5_dms["reactivity"][global_row], np.float32)
        a23_full = np.asarray(h5_a23["reactivity"][global_row], np.float32)
        dms_seg = dms_full[ds - 1: de]
        a23_seg = a23_full[ds - 1: de]
        if len(dms_seg) != len(seq) or len(a23_seg) != len(seq):
            n_len_mismatch += 1
            json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
            continue

        dms_clean = [round(float(dms_seg[i]), 4) if (dms_seg[i] == dms_seg[i] and seq[i] in "AC") else None
                     for i in range(len(seq))]
        a23_clean = [round(float(v), 4) if v == v else None for v in a23_seg]
        snr_dms = float(h5_dms["SNR"][global_row])
        snr_a23 = float(h5_a23["SNR"][global_row])
        rj["dms"] = dms_clean
        rj["a23"] = a23_clean
        rj["sn"] = [round(snr_dms, 2) if snr_dms == snr_dms else None,
                    round(snr_a23, 2) if snr_a23 == snr_a23 else None]
        json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
        n_patched += 1

        # pred-vs-real fidelity (replaces the old pred-vs-pseudolabel numbers, which are now
        # stale since dms/a23 above were just replaced) -- None if pred_dms/pred_a23 is absent
        # or the correlation is undefined, never left as the old mismatched value.
        pr_dms, sr_dms = pred_corr(rj.get("pred_dms"), dms_clean)
        pr_a23, sr_a23 = pred_corr(rj.get("pred_a23"), a23_clean)
        f["pred_pearson_dms"] = round(pr_dms, 4) if pr_dms is not None else None
        f["pred_spearman_dms"] = round(sr_dms, 4) if sr_dms is not None else None
        f["pred_pearson_2a3"] = round(pr_a23, 4) if pr_a23 is not None else None
        f["pred_spearman_2a3"] = round(sr_a23, 4) if sr_a23 is not None else None
        if pr_dms is not None:
            n_pred_dms += 1
        if pr_a23 is not None:
            n_pred_a23 += 1

        # non-circular r2a3/shape_agr from the NEW real a23 vs the pairing dot-bracket
        dbn = pairing.get(sid) or pairing.get(key)
        if dbn and len(dbn) == len(a23_clean):
            is_paired = [0.0 if c in ".-" else 1.0 for c in dbn]
            xs, ys = [], []
            for p, v in zip(is_paired, a23_clean):
                if v is not None:
                    xs.append(p); ys.append(v)
            r = pearson(xs, ys)
            if r is not None:
                f["r2a3"] = round(r, 4)
                f["shape_agr"] = round(-r, 4)
                f["shape_ok"] = 1 if r < -0.2 else 0
                n_r2a3 += 1

    for h5_dms, h5_a23 in h5_cache.values():
        h5_dms.close(); h5_a23.close()

    json.dump(folds, open(f"{out_dd}/folds.json", "w"), separators=(",", ":"))
    print(f"ribo2-iq-curated-v2: {n} folds, {n_patched} patched with real reactivity, "
          f"{n_oob} out-of-range, {n_len_mismatch} length-mismatch (left untouched), "
          f"{n_r2a3} r2a3/shape_agr recomputed, "
          f"{n_pred_dms} pred_pearson_dms / {n_pred_a23} pred_pearson_2a3 recomputed (of "
          f"{n_patched} patched -- rest set to null: no pred_dms/pred_a23 or undefined corr) "
          f"-> {out_rd} / {out_dd}", flush=True)


if __name__ == "__main__":
    main()
