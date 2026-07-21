#!/usr/bin/env python
"""Compute `r2a3`/`shape_agr`/`shape_ok` in a dataset's folds.json from whatever real a23
already exists in each react/<key>.json against `pairing.json`'s dot-bracket -- these three
fields are hardcoded null/0 by the generic `build_dataset.py` builder and never computed
afterward, even on datasets where real a23 + a real dot-bracket are both already sitting there.
Confirmed applicable to `pseudolabels` (19,759/19,759 a23+pairing matched) and `openknot`
(3,698/3,698 pairing matched; a23 populated for all, real for the ~31% joined to real 1D cmuts
by `enrich_openknot_long_react.py`, OpenKnotBench-sourced for the rest -- either way, real
enough to compute a genuine, non-circular SHAPE-pairing agreement from).
Same formula as `enrich_iq.py` / `enrich_iq_real_reactivity.py`: r2a3 = pearson(is_paired, a23);
shape_agr = -r2a3; shape_ok = 1 if r2a3 < -0.2.

NOT computed here (documented, not silently dropped): `mean_prot_2a3` needs per-tertiary-motif
background-subtracted protection (build_feature_table.py's fuller calc, needs TERT-type motif
spans) -- a separate, bigger follow-up, not the same "any real signal → derive the summary field"
gap as the other three.

Run in the `rna` env (no extra deps beyond stdlib).
"""
import argparse
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset-root", default=f"{ROOT}/dist/datasets/pseudolabels",
                     help="dir holding data/folds.json + data/pairing.json")
    ap.add_argument("--react-root", default=None,
                     help="dir holding react/<key>.json, if different from --dataset-root "
                          "(e.g. a already-patched a23 tree from another enrich script)")
    ap.add_argument("--out-root", default=None,
                     help="if set, write patched data/folds.json here instead of in place "
                          "(mirrors --dataset-root layout); use when the source tree is read-only")
    args = ap.parse_args()

    dd = f"{args.dataset_root}/data"
    rd = f"{args.react_root}/react" if args.react_root else f"{args.dataset_root}/react"
    out_dd = f"{args.out_root}/data" if args.out_root else dd
    os.makedirs(out_dd, exist_ok=True)

    folds = json.load(open(f"{dd}/folds.json"))
    pairing = json.load(open(f"{dd}/pairing.json"))

    n = n_recomputed = n_no_a23 = n_no_dbn = 0
    for f in folds:
        n += 1
        sid, key = f["id"], f["key"]
        rj_path = f"{rd}/{key}.json"
        if not os.path.exists(rj_path):
            continue
        rj = json.load(open(rj_path))
        a23 = rj.get("a23")
        if not a23 or all(v is None for v in a23):
            n_no_a23 += 1
            continue
        dbn = pairing.get(sid) or pairing.get(key)
        if not dbn or len(dbn) != len(a23):
            n_no_dbn += 1
            continue
        is_paired = [0.0 if c in ".-" else 1.0 for c in dbn]
        xs, ys = [], []
        for p, v in zip(is_paired, a23):
            if v is not None:
                xs.append(p); ys.append(v)
        r = pearson(xs, ys)
        if r is not None:
            f["r2a3"] = round(r, 4)
            f["shape_agr"] = round(-r, 4)
            f["shape_ok"] = 1 if r < -0.2 else 0
            n_recomputed += 1
        # else: has real a23 + a length-matched dbn, but the correlation is undefined --
        # e.g. dbn is 100% unpaired (zero variance in is_paired) or too few positions.

    json.dump(folds, open(f"{out_dd}/folds.json", "w"), separators=(",", ":"))
    print(f"pseudolabels: {n} folds, {n_recomputed} r2a3/shape_agr/shape_ok recomputed, "
          f"{n_no_a23} no real a23, {n_no_dbn} no matching/length-aligned dbn, "
          f"{n - n_recomputed - n_no_a23 - n_no_dbn} correlation undefined (e.g. all-unpaired dbn) "
          f"-> {out_dd}", flush=True)


if __name__ == "__main__":
    main()
