#!/usr/bin/env python
"""Enrich ribo2-iq-curated folds with sequence NAMES + biological SOURCES from the team's
unified Ribonanza-2 A-Q metadata (Max Gao; documented in the "ribo2_metadata" Notion page).

Source (per-library, from config.json["metadata_parquet"]):
  /groups/das/rnastruct/bioinformatics/2026ribo2-metadata/out/per_lib/Ribonanza2{L}.parquet
  columns used: fasta_index, sublibrary, source_id, design_sequence, sub_start, sub_end, design_length

Sets per fold (when present):
  name                -- source_id (descriptive FASTA-header prefix, the human-readable name)
  sublibrary          -- source CATEGORY verbatim (e.g. tRNA_human, rRNA_human, RefSeq_human, MANE,
                         bacteria_breaker, virus_*). This is the biological origin.
  rna_type            -- clean controlled vocab derived from sublibrary (tRNA/rRNA/mRNA/viral RNA/...),
                         drives the search box + the "Biological source" dropdown filter.
  design_start/end    -- 1-based coords of the TRUE design region within the 177-nt full construct.
  true_design_length  -- corrected (<=130) design length. The folded model stays 130 nt (5'-padded);
                         a ~70-nt tRNA sits at the 3' end of that padded 130-mer.

JOIN: fold id is "<N>-ribonanza2<letter>", where <N> is a 1-based COMBINED-GROUP index over the
{IJK, LMQ, NOP} FASTA groupings (each library = one 8M block). The per-library parquet row is
therefore fasta_index = (int(id.split("-")[0]) - 1) % 8_000_000, and <letter> selects the parquet.
(Differs from enrich_fgh_metadata.py's plain -1 -- do not copy that arithmetic.)

A build-time validation samples matched folds and checks the metadata design_sequence against the
atlas 130-nt react seq (endswith / equality); it REFUSES to write folds.json if the overall match
rate is below --min-match, which would mean the index mapping is wrong. Run in the `rna` env.
"""
import argparse
import json
import os
import random
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
IQ = set("IJKLMNOPQ")
BLOCK = 8_000_000
COLS = ["fasta_index", "sublibrary", "source_id", "design_sequence",
        "sub_start", "sub_end", "design_length"]


def letter_of(sid):
    m = re.search(r"ribonanza2([a-z])$", sid)
    return m.group(1).upper() if m else ""


def rna_type_of(sub):
    """Molecule type -- set ONLY where the sublibrary is a genuine RNA type ('' otherwise).
    The curated I-Q set is mostly 130-nt genomic/transcript window scans, which are NOT a
    specific RNA type, so those stay ''. Kept for the deep-view 'RNA type' row + search."""
    s = (sub or "").strip().lower()
    if s.startswith("trna"):
        return "tRNA"
    if s.startswith("rrna"):
        return "rRNA"
    if s.startswith(("mane", "refseq")):  # MANE + RefSeq*/RefSeqSelect* = mRNA transcript windows
        return "mRNA"
    return ""


def source_group_of(sub):
    """Biological SOURCE / organism domain -- the primary filter axis for I-Q ('' if unknown).
    Check 'nonhuman' before 'human' (RefSeqSelect_nonhuman contains the substring 'human')."""
    s = (sub or "").strip().lower()
    if not s:
        return ""
    if "nonhuman" in s or "non_human" in s:
        return "non-human vertebrate"
    if s == "mane" or "human" in s:
        return "human"
    if s.startswith("bacteria"):
        return "bacteria"
    if s.startswith("archaea"):
        return "archaea"
    if "virus" in s or s.startswith("viral"):
        return "virus"
    if s.startswith("fugu") or s.startswith("eukaryote"):
        return "eukaryote"
    return ""


def norm(s):
    return (s or "").upper().replace("T", "U")


def load_seq(od, key):
    try:
        return json.load(open(f"{od}/react/{key}.json")).get("seq") or ""
    except Exception:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="ribo2-iq-curated")
    ap.add_argument("--sample", type=int, default=200, help="per-letter validation sample size")
    ap.add_argument("--min-match", type=float, default=0.90, help="write gate on validation rate")
    ap.add_argument("--force", action="store_true", help="write even if validation is below --min-match")
    args = ap.parse_args()
    random.seed(0)

    import pyarrow.parquet as pq
    cfg = json.load(open(f"{ROOT}/config.json"))
    tmpl = cfg["metadata_parquet"]

    od = os.path.join(ROOT, "dist", "datasets", args.name)
    fp = f"{od}/data/folds.json"
    folds = json.load(open(fp))
    print(f"{args.name}: {len(folds)} folds", flush=True)

    # group folds by letter, keyed by the per-library fasta_index (modulo the 8M block)
    by = {L: {} for L in IQ}
    collisions = 0
    for f in folds:
        L = (f.get("letter") or letter_of(f["id"])).upper()
        if L not in IQ:
            continue
        nid = f["id"].split("-")[0]
        if not nid.isdigit():
            continue
        fi = (int(nid) - 1) % BLOCK
        if fi in by[L]:
            collisions += 1
        by[L][fi] = f
    if collisions:
        print(f"  WARNING: {collisions} intra-letter fasta_index collisions (last-wins)")

    # idempotent re-run: clear fields this script owns before re-deriving them
    for L in IQ:
        for f in by[L].values():
            for k in ("rna_type", "source_group", "design_start", "design_end", "true_design_length"):
                f.pop(k, None)

    n_name = n_sub = n_type = n_grp = n_true = no_meta = 0
    src_hist = {}
    val = {L: [0, 0] for L in IQ}  # [matched, sampled]

    for L in sorted(IQ):
        idx2f = by[L]
        if not idx2f:
            continue
        path = tmpl.format(L=L)
        if not os.path.exists(path):
            print(f"  WARNING: parquet missing for {L}: {path}")
            continue
        t = pq.read_table(path, columns=COLS,
                          filters=[("fasta_index", "in", list(idx2f))]).to_pydict()
        sample_set = set(random.sample(list(idx2f), min(args.sample, len(idx2f))))
        hits = 0
        for i, fi in enumerate(t["fasta_index"]):
            f = idx2f.get(fi)
            if f is None:
                continue
            hits += 1
            sub = (t["sublibrary"][i] or "").strip()
            name = (t["source_id"][i] or "").strip()
            if name:
                f["name"] = name
                n_name += 1
            if sub:
                f["sublibrary"] = sub
                n_sub += 1
            rt = rna_type_of(sub)
            if rt:
                f["rna_type"] = rt
                n_type += 1
            sg = source_group_of(sub)
            if sg:
                f["source_group"] = sg
                n_grp += 1
            src_hist[sg or "(unknown)"] = src_hist.get(sg or "(unknown)", 0) + 1
            ss, se, dl = t["sub_start"][i], t["sub_end"][i], t["design_length"][i]
            if ss is not None:
                f["design_start"] = int(ss)
            if se is not None:
                f["design_end"] = int(se)
            if dl is not None:
                f["true_design_length"] = int(dl)
                if int(dl) < 130:
                    n_true += 1
            if fi in sample_set:
                val[L][1] += 1
                aseq, dseq = norm(load_seq(od, f["key"])), norm(t["design_sequence"][i])
                if aseq and dseq and (aseq == dseq or aseq.endswith(dseq) or dseq.endswith(aseq)):
                    val[L][0] += 1
        no_meta += len(idx2f) - hits
        print(f"  {L}: folds={len(idx2f):5d} matched={hits:5d} "
              f"val={val[L][0]}/{val[L][1]}", flush=True)

    tot_m = sum(v[0] for v in val.values())
    tot_s = sum(v[1] for v in val.values())
    rate = tot_m / tot_s if tot_s else 0.0
    print(f"\njoin validation: {tot_m}/{tot_s} = {rate:.3f}  (gate --min-match {args.min_match})")
    print("source_group histogram:", dict(sorted(src_hist.items(), key=lambda kv: -kv[1])))
    print(f"name set: {n_name}  sublibrary set: {n_sub}  rna_type(genuine) set: {n_type}  "
          f"source_group set: {n_grp}  true_design_length<130: {n_true}  no-metadata-row: {no_meta}")

    if rate < args.min_match and not args.force:
        print(f"\nABORT: validation match rate {rate:.3f} < {args.min_match}; NOT writing "
              f"{fp}. The modulo index mapping is likely wrong. Re-run with --force to override.")
        raise SystemExit(2)

    json.dump(folds, open(fp, "w"), separators=(",", ":"))
    print(f"\nwrote {fp}")


if __name__ == "__main__":
    main()
