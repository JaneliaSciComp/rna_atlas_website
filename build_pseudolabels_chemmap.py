#!/usr/bin/env python
"""Patch the pseudolabels per-fold react JSON with real 2A3 + DMS chemmap.

Source (per configs_data.py rna_ribonanza_pseudolabels):
  reactivity: ribonanza_pseudolabels_combined_quickstart.parquet
              (sequence_id, experiment_type {2A3_MaP,DMS_MaP}, signal_to_noise, reactivity_0001..N)
  metadata:   pseudolabels_combined_metadata.csv (sub_start, design_length per sequence_id)

sequence_id == the pseudolabels manifest seq_id (the hash). Reactivity is aligned to the full
padded sequence; slice [sub_start-1 : sub_start-1+design_length] to the design region (== seq in
the react JSON). DMS masked to A/C positions (convention). Batched read keeps memory bounded.
Run in the `rna` env.
"""
import csv
import json
import os
import pyarrow.parquet as pq

ROOT = os.path.dirname(os.path.abspath(__file__))
R = "/nrs/das/rnastruct/joshic/RNAnix_data/ribonanza"
PARQ = f"{R}/ribonanza_pseudolabels_combined_quickstart.parquet"
META = f"{R}/pseudolabels_combined_metadata.csv"
DD = f"{ROOT}/dist/datasets/pseudolabels"
csv.field_size_limit(10 ** 7)


def main():
    folds = json.load(open(f"{DD}/data/folds.json"))
    keyof = {f["id"]: f["key"] for f in folds}
    idset = set(keyof)
    print(f"pseudolabel folds: {len(idset)}")

    meta = {}
    with open(META) as f:
        for r in csv.DictReader(f):
            s = r["sequence_id"]
            if s in idset:
                try:
                    meta[s] = (int(float(r["sub_start"])), int(float(r["design_length"])))
                except (ValueError, KeyError):
                    pass
    print(f"metadata matched: {len(meta)}")

    pf = pq.ParquetFile(PARQ)
    rcols = [c for c in pf.schema_arrow.names if c.startswith("reactivity_") and "error" not in c]
    cols = ["sequence_id", "experiment_type", "signal_to_noise"] + rcols
    best = {}   # (id, exp) -> (sn, [reactivity])
    seen = 0
    for batch in pf.iter_batches(batch_size=20000, columns=cols):
        d = batch.to_pydict()
        sids, exps, sns = d["sequence_id"], d["experiment_type"], d["signal_to_noise"]
        rc = [d[c] for c in rcols]
        for i, s in enumerate(sids):
            if s not in idset:
                continue
            e = exps[i]; sn = sns[i] or 0.0
            kk = (s, e)
            if kk in best and best[kk][0] >= sn:
                continue
            best[kk] = (sn, [rc[j][i] for j in range(len(rcols))])
        seen += len(sids)
    print(f"scanned {seen} rows; reactivity profiles: {len(best)}")

    def clean(seg, seq, mask_ac):
        if seg is None:
            return None
        out = []
        for i, x in enumerate(seg):
            if x is None or (isinstance(x, float) and x != x):
                out.append(None)
            elif mask_ac and i < len(seq) and seq[i] not in "AC":
                out.append(None)
            else:
                out.append(round(float(x), 4))
        return out

    n = nchem = 0
    for sid, k in keyof.items():
        p = f"{DD}/react/{k}.json"
        rec = json.load(open(p)) if os.path.exists(p) else {"seq": "", "dms": None, "a23": None, "sn": [None, None]}
        seq = rec.get("seq", "")
        if sid in meta:
            ss, dl = meta[sid]
            a = best.get((sid, "2A3_MaP")); m = best.get((sid, "DMS_MaP"))
            a23 = a[1][ss - 1: ss - 1 + dl] if a else None
            dms = m[1][ss - 1: ss - 1 + dl] if m else None
            rec["a23"] = clean(a23, seq, False)
            rec["dms"] = clean(dms, seq, True)
            rec["sn"] = [round(float(m[0]), 2) if m else None, round(float(a[0]), 2) if a else None]
            if rec["a23"] or rec["dms"]:
                nchem += 1
        json.dump(rec, open(p, "w"), separators=(",", ":"))
        n += 1
    print(f"patched {n} pseudolabel react json; {nchem} with chemmap")


if __name__ == "__main__":
    main()
