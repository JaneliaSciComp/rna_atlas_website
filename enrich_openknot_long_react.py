#!/usr/bin/env python
"""Patch OK7b/OK8 (`openknot_long`/`openknot_long_seq`) per-fold react JSON with REAL 1D cmuts
DMS+2A3 reactivity, replacing the OpenKnotBench-sourced 2A3 (sparse/often-null: bench per-position
coverage for these ~240nt designs tops out around ~100nt median) and always-null DMS.

Source: `202606-1d-ok7ab/metadata/ok7ab8_metadata_combined.parquet` (30,000 designs; validated,
QC'd 1D cmuts DMS+2A3 for ALL of OK7a/OK7b/OK8 -- see memory `ok7a-1d-cmuts`). Per row this carries
`reactivity_h5` (full path to the per-library cmuts H5), `reactivity_row`, `sub_start`/`sub_end`
(design-region bounds within that H5 row's 177/300/307-nt frame), and `SNR_DMS`/`SNR_2A3`.

Join key: normalized `design_sequence` (same `norm()` convention as `build_openknot_long.py`'s
own OpenKnotBench join) against each react JSON's `seq` field -- confirmed 100% match rate for
both datasets (9,193/9,193) before writing this script.

Run in the `rna` env (needs pyarrow + h5py). Then re-run derive_ss.py if bp_fraction/pairing
should reflect the new reactivity (it currently doesn't depend on chemmap, so not required).
"""
import argparse
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
PARQ = "/groups/das/rnastruct/bioinformatics/202606-1d-ok7ab/metadata/ok7ab8_metadata_combined.parquet"
DATASETS = ["openknot_long", "openknot_long_seq"]


def norm(s):
    return (s or "").strip().upper().replace("T", "U")


def fl(x, default=0.0):
    try:
        v = float(x)
        return v if v == v else default  # NaN -> default
    except (TypeError, ValueError):
        return default


def load_best_rows():
    """norm(design_sequence) -> best-SNR (reactivity_h5, reactivity_row, sub_start, sub_end,
    SNR_DMS, SNR_2A3). Best = highest SNR_DMS+SNR_2A3 among duplicate design_sequences.
    Every numeric column in this parquet is stored as string -- cast explicitly."""
    import pyarrow.parquet as pq
    t = pq.read_table(PARQ, columns=["design_sequence", "sub_start", "sub_end",
                                      "reactivity_h5", "reactivity_row", "SNR_DMS", "SNR_2A3"])
    d = t.to_pydict()
    best = {}
    for i in range(len(d["design_sequence"])):
        key = norm(d["design_sequence"][i])
        if not key:
            continue
        snr_d, snr_a = fl(d["SNR_DMS"][i]), fl(d["SNR_2A3"][i])
        sn = snr_d + snr_a
        prev = best.get(key)
        if prev is not None and prev[0] >= sn:
            continue
        best[key] = (sn, d["reactivity_h5"][i], int(fl(d["reactivity_row"][i])),
                     int(fl(d["sub_start"][i])), int(fl(d["sub_end"][i])), snr_d, snr_a)
    return best


def main():
    import h5py
    import numpy as np

    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets-root", default=f"{ROOT}/dist/datasets",
                     help="root holding <name>/data/folds.json + <name>/react/<key>.json")
    ap.add_argument("--out-root", default=None,
                     help="if set, write patched react/<key>.json here instead of in place "
                          "(mirrors --datasets-root layout); use when the source tree is read-only")
    ap.add_argument("--names", nargs="+", default=DATASETS)
    args = ap.parse_args()

    best = load_best_rows()
    print(f"ok7ab8_metadata_combined: {len(best)} unique design_sequence keys", flush=True)

    h5_cache = {}

    def h5_group(path):
        if path not in h5_cache:
            h5_cache[path] = h5py.File(path, "r")
        return h5_cache[path]

    for name in args.names:
        dd = f"{args.datasets_root}/{name}/data"
        rd = f"{args.datasets_root}/{name}/react"
        out_rd = f"{args.out_root}/{name}/react" if args.out_root else rd
        os.makedirs(out_rd, exist_ok=True)

        folds = json.load(open(f"{dd}/folds.json"))
        n = n_matched = n_dms = n_a23 = 0
        for f in folds:
            n += 1
            key = f["key"]
            rj_path = f"{rd}/{key}.json"
            if not os.path.exists(rj_path):
                continue
            rj = json.load(open(rj_path))
            seq = rj.get("seq", "")
            hit = best.get(norm(seq))
            if hit is None:
                json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
                continue
            sn, h5_path, row, sub_start, sub_end, snr_d, snr_a = hit
            n_matched += 1
            g = h5_group(h5_path)
            dms_full = np.asarray(g["DMS/reactivity"][row], np.float32)
            a23_full = np.asarray(g["2A3/reactivity"][row], np.float32)
            dms_seg = dms_full[sub_start - 1: sub_end]
            a23_seg = a23_full[sub_start - 1: sub_end]
            if len(dms_seg) != len(seq) or len(a23_seg) != len(seq):
                # length mismatch (shouldn't happen given the 100% pre-check) -- leave untouched
                json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))
                continue
            dms_clean = [round(float(dms_seg[i]), 4) if (dms_seg[i] == dms_seg[i] and seq[i] in "AC") else None
                         for i in range(len(seq))]
            a23_clean = [round(float(v), 4) if v == v else None for v in a23_seg]
            rj["dms"] = dms_clean
            rj["a23"] = a23_clean
            rj["sn"] = [round(float(snr_d), 2), round(float(snr_a), 2)]
            if any(v is not None for v in dms_clean):
                n_dms += 1
            if any(v is not None for v in a23_clean):
                n_a23 += 1
            json.dump(rj, open(f"{out_rd}/{key}.json", "w"), separators=(",", ":"))

        print(f"{name}: {n} folds, {n_matched} matched to real 1D cmuts "
              f"({n_a23} with 2A3 signal, {n_dms} with DMS signal) -> {out_rd}", flush=True)

    for h5 in h5_cache.values():
        h5.close()


if __name__ == "__main__":
    main()
