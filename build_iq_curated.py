#!/usr/bin/env python
"""Build the "Ribonanza-2 I-Q Curated" dataset (27,174 folds) into the explorer layout.

Hand-off spec: atlas_delivery/DELIVERY_FOR_ATLAS_AGENT.md
(under /groups/das/home/zouinkhim/atlas_recovery_setup/curation_iq_pLDDT70).

Sources (all under ROOT):
  08_intersect/curated.list                       27,174 seq_ids (final curated fold-reps)
  02_fasta/iq_survivors.fasta                      design_sequence per id (130 nt design region)
  01_survivors/survivors_pLDDT>70_gPDE<0.5.csv     mean_plddt / mean_ptm / mean_gpde / letter
  03_mmseqs_seqreps/clu_cluster.tsv                mmseqs2 clusters -> seq_cluster_size
  08_intersect/curated.tsv                         tm1_max (best_tm1) + best_v341_hit (near)
  10_bfactor_restore/pdb/<id>.final.pdb            relaxed PDB, pLDDT in B-factor (plain text)
  <letter>_snr1_out/.../<id>...profiles.npz        reactivity (N/O/P/Q only, 25,844)

Reactivity is Ribonanza-2 chemmap *pseudolabels* used to condition inference (exp_reactivity_*),
NOT measured SHAPE/DMS -> sn is [null, null] and no SN filtering. I/J/K/L/M (1,330) have no npz
(sequence-only react). Structures are relaxed already; B-factor = pLDDT x 100.

Emits (explorer dataset layout):
  dist/datasets/<name>/structs/<key>.pdb   (gzip bytes; deploy serves content-encoding gzip)
  dist/datasets/<name>/react/<key>.json    ({seq, dms, a23, sn})
  dist/datasets/<name>/data/folds.json     (one record/fold)
  dist/datasets/<name>/data/motifs.json    ({} -- no tertiary-motif scan for this source)
Then run:  derive_ss.py --name <name>        (pairing.json + ss/termini fields)
           compute_embedding.py --name <name>  (ex,ey for the map)

Run in the `rna` env.
"""
import argparse
import csv
import gzip
import hashlib
import json
import os
import re
from multiprocessing import Pool

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = "/groups/das/home/zouinkhim/atlas_recovery_setup/curation_iq_pLDDT70"
SNR_ROOT = "/groups/das/home/zouinkhim/atlas_recovery_setup"
NOPQ = set("NOPQ")
csv.field_size_limit(10 ** 7)


def key_of(sid):
    k = re.sub(r"[^A-Za-z0-9_-]+", "_", sid).strip("_")[:70]
    return f"{k}_{hashlib.md5(sid.encode()).hexdigest()[:6]}"


def fl(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def letter_of(sid):
    # id like 22943699-ribonanza2p -> "P"
    m = re.search(r"ribonanza2([a-z])$", sid)
    return m.group(1).upper() if m else ""


def npz_path(sid, letter):
    lo = letter.lower()
    return (f"{SNR_ROOT}/{lo}_snr1_out/{lo}_snr1__rna_ribonanza2__shard0000of0001/"
            f"predictions/rna_ribonanza2/step_0_rna_ribonanza2_{sid}/seed_0/predictions/"
            f"step_0_rna_ribonanza2_{sid}_seed_0_sample_0.profiles.npz")


def contact_ratio_from_text(text):
    """C1'-C1' compactness (fraction of |i-j|>=6 pairs within 8 A), from PDB text."""
    import numpy as np
    pts, seen = [], None
    for line in text.splitlines():
        if line.startswith(("ATOM", "HETATM")) and line[12:16].strip() in ("C1'", "C1*"):
            resid = line[22:27]
            if resid != seen:                       # one C1' per residue
                seen = resid
                pts.append((float(line[30:38]), float(line[38:46]), float(line[46:54])))
    n = len(pts)
    if n < 2:
        return None
    P = np.asarray(pts, float)
    D = np.sqrt(((P[:, None, :] - P[None, :, :]) ** 2).sum(-1))
    idx = np.arange(n)
    sep = np.abs(idx[:, None] - idx[None, :])
    return round(int(np.triu((D <= 8.0) & (sep >= 6), 1).sum()) / n, 4)


def load_react(sid, letter, seqlen):
    """(dms[], a23[]) design-aligned floats (NaN->None), or (None, None) if no npz."""
    if letter not in NOPQ:
        return None, None
    p = npz_path(sid, letter)
    if not os.path.exists(p):
        return None, None
    import numpy as np
    try:
        d = np.load(p)
        dms = d["exp_reactivity_DMS"].astype("float32")
        a23 = d["exp_reactivity_2A3"].astype("float32")
    except Exception:
        return None, None

    def clean(a):
        out = []
        for v in a.tolist():
            out.append(round(float(v), 4) if v == v else None)   # NaN -> null
        return out
    return clean(dms), clean(a23)


# per-worker context (set by initializer to avoid re-pickling the big dicts each task)
_CTX = {}


def _init(ctx):
    _CTX.update(ctx)


def process(sid):
    od = _CTX["od"]
    meta = _CTX["meta"].get(sid, {})
    seq = _CTX["seqs"].get(sid, "")
    key = key_of(sid)
    letter = letter_of(sid)

    pdb_src = f"{SRC}/10_bfactor_restore/pdb/{sid}.final.pdb"
    cr = None
    n_struct = 0
    if os.path.exists(pdb_src):
        with open(pdb_src) as fh:
            text = fh.read()
        try:
            cr = contact_ratio_from_text(text)
        except Exception:
            cr = None
        with open(f"{od}/structs/{key}.pdb", "wb") as out:            # gzip bytes
            out.write(gzip.compress(text.encode(), 6))
        n_struct = 1

    length = len(seq) if seq else 130
    dms, a23 = load_react(sid, letter, length)
    json.dump({"seq": seq, "dms": dms, "a23": a23, "sn": [None, None]},
              open(f"{od}/react/{key}.json", "w"), separators=(",", ":"))

    rec = {
        "id": sid, "key": key, "name": "", "letter": letter, "source": _CTX["label"],
        "sublibrary": "", "length": length,
        "plddt": meta.get("plddt"), "ptm": meta.get("ptm"), "gpde": meta.get("gpde"),
        "clashscore": None, "n_tert": 0, "n_rare": 0, "motifs": [], "pseudoknot": 0,
        "ss_class": "", "r2a3": None, "shape_agr": None, "mean_prot_2a3": None, "shape_ok": 0,
        "openknot": None, "overlap_ae": None,
        "is_novel_v341": 1,                                   # all curated folds are novel vs v341
        "best_tm1": meta.get("best_tm1"), "near": meta.get("near", ""), "near_title": "",
        "score": None, "contact_ratio": cr, "bp_fraction": None, "in_shortlist": 0,
        "seq_cluster_size": meta.get("seq_cluster_size"),
        "struct_rep": 1,
        # conditioning is dataset-level (cond:["chemmap"] in datasets.js); the app expects
        # an ARRAY, so do NOT emit a per-fold string here. Pseudolabel nuance is in the label.
    }
    return rec, n_struct, (1 if dms is not None else 0)


def load_seqs(path):
    seqs, cur = {}, None
    with open(path) as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith(">"):
                cur = line[1:].split()[0]
            elif cur is not None:
                seqs[cur] = seqs.get(cur, "") + line.strip().upper().replace("T", "U")
    return seqs


def load_conf(path):
    conf = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            conf[r["sequence_id"]] = {
                "plddt": fl(r.get("mean_plddt")), "ptm": fl(r.get("mean_ptm")),
                "gpde": fl(r.get("mean_gpde")),
            }
    return conf


def load_novelty(path):
    """curated.tsv -> {seq_id: (best_tm1, near)}."""
    nov = {}
    with open(path) as f:
        for r in csv.DictReader(f, delimiter="\t"):
            nov[r["rep_id"]] = (fl(r.get("tm1_max")), (r.get("best_v341_hit") or "").strip())
    return nov


def load_cluster_sizes(path, ids):
    """clu_cluster.tsv (rep \\t member) -> {member_id: cluster member count}, for curated ids."""
    from collections import defaultdict
    member2rep, rep2count = {}, defaultdict(int)
    with open(path) as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            rep, member = parts[0], parts[1]
            member2rep[member] = rep
            rep2count[rep] += 1
    out = {}
    for sid in ids:
        rep = member2rep.get(sid)
        if rep is not None:
            out[sid] = rep2count[rep]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="ribo2-iq-curated")
    ap.add_argument("--label", default="Ribonanza-2 curated I–Q · chemmap pseudolabel")
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--limit", type=int, default=0, help="build only first N ids (smoke test)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "datasets"))
    args = ap.parse_args()

    od = os.path.join(args.out, args.name)
    os.makedirs(f"{od}/data", exist_ok=True)
    os.makedirs(f"{od}/structs", exist_ok=True)
    os.makedirs(f"{od}/react", exist_ok=True)

    ids = [ln.strip() for ln in open(f"{SRC}/08_intersect/curated.list") if ln.strip()]
    if args.limit:
        ids = ids[:args.limit]
    print(f"curated ids: {len(ids)}", flush=True)

    seqs = load_seqs(f"{SRC}/02_fasta/iq_survivors.fasta")
    conf = load_conf(f"{SRC}/01_survivors/survivors_pLDDT>70_gPDE<0.5.csv")
    nov = load_novelty(f"{SRC}/08_intersect/curated.tsv")
    csz = load_cluster_sizes(f"{SRC}/03_mmseqs_seqreps/clu_cluster.tsv", set(ids))
    print(f"loaded: seqs={len(seqs)} conf={len(conf)} novelty={len(nov)} clusters={len(csz)}", flush=True)

    meta = {}
    for sid in ids:
        c = conf.get(sid, {})
        bt, near = nov.get(sid, (None, ""))
        meta[sid] = {
            "plddt": round(c["plddt"], 2) if c.get("plddt") is not None else None,
            "ptm": round(c["ptm"], 4) if c.get("ptm") is not None else None,
            "gpde": round(c["gpde"], 4) if c.get("gpde") is not None else None,
            "best_tm1": round(bt, 4) if bt is not None else None,
            "near": near, "seq_cluster_size": csz.get(sid),
        }

    ctx = {"od": od, "label": args.label, "meta": meta, "seqs": seqs}
    folds, n_struct, n_react = [], 0, 0
    with Pool(args.workers, initializer=_init, initargs=(ctx,)) as pool:
        for i, (rec, ns, nr) in enumerate(pool.imap_unordered(process, ids, chunksize=64)):
            folds.append(rec)
            n_struct += ns
            n_react += nr
            if (i + 1) % 2000 == 0:
                print(f"  {i + 1}/{len(ids)} ...", flush=True)

    folds.sort(key=lambda x: -(x["plddt"] or 0))
    json.dump(folds, open(f"{od}/data/folds.json", "w"), separators=(",", ":"))
    if not os.path.exists(f"{od}/data/motifs.json"):
        json.dump({}, open(f"{od}/data/motifs.json", "w"))

    n_seq = sum(1 for f in folds if seqs.get(f["id"]))
    n_novel = sum(f["is_novel_v341"] for f in folds)
    n_csz = sum(1 for f in folds if f["seq_cluster_size"] is not None)
    print(f"\n{args.name}: {len(folds)} folds -> {od}")
    print(f"  structs(gz)={n_struct}  react_json={len(folds)} (with DMS/2A3={n_react}, seq={n_seq})")
    print(f"  novel={n_novel}  contact_ratio={sum(1 for f in folds if f['contact_ratio'] is not None)}"
          f"  seq_cluster_size={n_csz}")


if __name__ == "__main__":
    main()
