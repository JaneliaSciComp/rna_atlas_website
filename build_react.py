#!/usr/bin/env python
"""Per-fold reactivity/sequence JSON for the add-on datasets, matching ribo2's react format:
    dist/datasets/<ds>/react/<key>.json = {seq, dms, a23, sn:[dms_sn, a23_sn]}

- Sequence (all datasets): the manifest `design_sequence`.
- OpenKnot chemmap (2A3 only): joined by design_sequence to OpenKnotBench, sliced to the
  design region via sub_start/design_length (same idea as the ribo2 A-E HDF5 slice).
- Pseudolabels / RFAM: sequence only (no chemmap source wired yet; RFAM is experimental, none).

Keyed by the folds.json `key` (sanitized) so ids with quotes/specials map to safe filenames.
Run in the `rna` env.
"""
import csv
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
MAN = "/groups/das/home/joshic/RNAnix/release_data/distillation_atlases"
OKB = "/groups/das/home/joshic/RNAnix/release_data/openknotbench/OpenKnotBench_data.v4.5.1.txt"
DATASETS = {"openknot": "openknot_manifest.tsv", "pseudolabels": "pseudolabels_manifest.tsv",
            "rfam_pdb130": "rfam_pdb130_manifest.tsv", "rfam_pdb240": "rfam_pdb240_manifest.tsv"}
csv.field_size_limit(10 ** 7)


def norm(s):
    return (s or "").strip().upper().replace("T", "U")


def fl(v):
    try:
        x = float(v); return x if x == x else None
    except (TypeError, ValueError):
        return None


def load_okb():
    """design_sequence -> 2A3 reactivity sliced to the design region (best signal/noise row)."""
    best = {}
    with open(OKB) as f:
        rd = csv.DictReader(f)
        rcols = [c for c in rd.fieldnames if c.startswith("reactivity_0")]
        for r in rd:
            ds = norm(r.get("design_sequence", ""))
            if not ds:
                continue
            sn = fl(r.get("signal_to_noise")) or 0.0
            if ds in best and best[ds][0] >= sn:
                continue
            ss = int(fl(r.get("sub_start")) or 1)
            dl = int(fl(r.get("design_length")) or len(ds))
            react = [fl(r.get(c)) for c in rcols]
            best[ds] = (sn, react[ss - 1: ss - 1 + dl])
    return {k: v[1] for k, v in best.items()}


def main():
    okb = load_okb() if os.path.exists(OKB) else {}
    print(f"OpenKnotBench design_sequences with reactivity: {len(okb)}")
    for name, mf in DATASETS.items():
        od = f"{ROOT}/dist/datasets/{name}/react"
        os.makedirs(od, exist_ok=True)
        folds = json.load(open(f"{ROOT}/dist/datasets/{name}/data/folds.json"))
        keyof = {f["id"]: f.get("key") for f in folds}
        n = nseq = nchem = 0
        with open(f"{MAN}/{mf}") as f:
            for r in csv.DictReader(f, delimiter="\t"):
                sid = r["seq_id"]
                k = keyof.get(sid)
                if not k:
                    continue
                seq = r.get("design_sequence", "") or ""
                rec = {"seq": seq, "dms": None, "a23": None, "sn": [None, None]}
                if seq:
                    nseq += 1
                if name == "openknot" and seq:
                    a23 = okb.get(norm(seq))
                    if a23 and len(a23) >= len(seq):
                        rec["a23"] = [round(v, 4) if v is not None else None for v in a23[:len(seq)]]
                        nchem += 1
                json.dump(rec, open(f"{od}/{k}.json", "w"), separators=(",", ":"))
                n += 1
        print(f"{name:13} react json={n}  seq={nseq}  chemmap(2A3)={nchem}")


if __name__ == "__main__":
    main()
