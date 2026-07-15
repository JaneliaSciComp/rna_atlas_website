#!/usr/bin/env python
"""Build the small "Ribonanza-2 I–Q human tRNAs (raw, below curation cut)" dataset.

Context: the human tRNA sublibrary (tRNA_human) has 104 sequences in the I–Q pool (all library
K). NONE passed the pLDDT>70 / gPDE<0.5 curation, so they are absent from `ribo2-iq-curated`.
Of the 104, only 20 were ever folded (the K inference input was pre-filtered to SN>=1); the raw
(unrelaxed) predictions live in the SN>=1 run tree. This builder packages those 20 raw predictions
into the explorer layout as a STANDALONE source so the tRNAs can be inspected despite failing the cut.

Sources:
  metadata (names + design region): per-sublibrary shard
    /groups/das/rnastruct/bioinformatics/2026ribo2-metadata/out/per_sublibrary/Ribonanza2K_tRNA_human.parquet
    (fasta_index, source_id, sub_start, sub_end, design_length, design_sequence)  -- 104 rows
  raw structure + confidence (per fold, gzipped):
    {SNR_ROOT}/k_snr1_out/k_snr1__rna_ribonanza2__shard0000of0001/predictions/rna_ribonanza2/
      step_0_rna_ribonanza2_<sid>/seed_0/predictions/
        step_0_rna_ribonanza2_<sid>_seed_0_sample_0.pdb.gz                     (130-nt model, B=pLDDT)
        step_0_rna_ribonanza2_<sid>_seed_0_summary_confidence_sample_0.json.gz (plddt/ptm/gpde)

seq_id = f"{fasta_index + 1 + 16_000_000}-ribonanza2k"  (K = block 2 of the IJK combined FASTA).

Emits dist/datasets/<name>/{data/folds.json, data/motifs.json({}), structs/<key>.pdb(gz), react/<key>.json}.
These are 130-nt 5'-PADDED models: the true tRNA is the 3' `design_length` nt (positions
sub_start..sub_end of the 177-nt construct). Sequence-only (no reactivity). Run in the `rna` env, then:
  derive_ss.py --name <name>   ;   compute_embedding.py --name <name>
"""
import argparse
import gzip
import json
import os

from build_iq_curated import key_of, contact_ratio_from_text  # reuse (no side effects on import)

ROOT = os.path.dirname(os.path.abspath(__file__))
SNR_ROOT = "/groups/das/home/zouinkhim/atlas_recovery_setup"
SHARD = "/groups/das/rnastruct/bioinformatics/2026ribo2-metadata/out/per_sublibrary/Ribonanza2K_tRNA_human.parquet"
K_OFFSET = 16_000_000
_NUC = {"A": "A", "U": "U", "G": "G", "C": "C",
        "RA": "A", "RU": "U", "RG": "G", "RC": "C",
        "ADE": "A", "URA": "U", "URI": "U", "GUA": "G", "CYT": "C"}


def raw_dir(sid):
    return (f"{SNR_ROOT}/k_snr1_out/k_snr1__rna_ribonanza2__shard0000of0001/predictions/"
            f"rna_ribonanza2/step_0_rna_ribonanza2_{sid}/seed_0/predictions")


def pdb_path(sid):
    return f"{raw_dir(sid)}/step_0_rna_ribonanza2_{sid}_seed_0_sample_0.pdb.gz"


def conf_path(sid):
    return f"{raw_dir(sid)}/step_0_rna_ribonanza2_{sid}_seed_0_summary_confidence_sample_0.json.gz"


def seq_from_pdb(text):
    """Ordered nucleotide sequence from ATOM records (one letter per residue, chain-order)."""
    seq, seen = [], None
    for line in text.splitlines():
        if not line.startswith("ATOM"):
            continue
        resid = line[21:27]           # chain + resSeq + iCode
        if resid == seen:
            continue
        seen = resid
        rn = line[17:20].strip().upper()
        seq.append(_NUC.get(rn, rn[-1] if rn else "N"))
    return "".join(seq)


def main():
    import pyarrow.parquet as pq
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="ribo2-iq-trna")
    ap.add_argument("--label", default="Ribonanza-2 I–Q human tRNAs · raw, below curation cut")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "datasets"))
    args = ap.parse_args()

    od = os.path.join(args.out, args.name)
    os.makedirs(f"{od}/data", exist_ok=True)
    os.makedirs(f"{od}/structs", exist_ok=True)
    os.makedirs(f"{od}/react", exist_ok=True)

    t = pq.read_table(SHARD, columns=["fasta_index", "source_id", "sub_start", "sub_end",
                                      "design_length", "design_sequence"]).to_pydict()
    n = len(t["fasta_index"])
    print(f"tRNA_human shard rows: {n}", flush=True)

    folds, n_struct, n_missing = [], 0, 0
    for i in range(n):
        fi = int(t["fasta_index"][i])
        sid = f"{fi + 1 + K_OFFSET}-ribonanza2k"
        pp = pdb_path(sid)
        if not os.path.exists(pp):
            n_missing += 1
            continue
        with gzip.open(pp, "rt") as fh:
            text = fh.read()
        seq = seq_from_pdb(text)
        try:
            cr = contact_ratio_from_text(text)
        except Exception:
            cr = None
        key = key_of(sid)
        with open(f"{od}/structs/{key}.pdb", "wb") as out:      # gzip bytes (deploy serves as gzip)
            out.write(gzip.compress(text.encode(), 6))
        n_struct += 1

        plddt = ptm = gpde = None
        cp = conf_path(sid)
        if os.path.exists(cp):
            try:
                with gzip.open(cp, "rt") as fh:
                    c = json.load(fh)
                plddt = round(float(c["plddt"]), 2)
                ptm = round(float(c["ptm"]), 4)
                gpde = round(float(c["gpde"]), 4)
            except Exception:
                pass

        json.dump({"seq": seq, "dms": None, "a23": None, "sn": [None, None]},
                  open(f"{od}/react/{key}.json", "w"), separators=(",", ":"))

        rec = {
            "id": sid, "key": key, "name": (t["source_id"][i] or "").strip(), "letter": "K",
            "source": args.label, "sublibrary": "tRNA_human",
            "rna_type": "tRNA", "source_group": "human",
            "design_start": int(t["sub_start"][i]), "design_end": int(t["sub_end"][i]),
            "true_design_length": int(t["design_length"][i]),
            "length": len(seq) or 130,
            "plddt": plddt, "ptm": ptm, "gpde": gpde,
            "clashscore": None, "n_tert": 0, "n_rare": 0, "motifs": [], "pseudoknot": 0,
            "ss_class": "", "r2a3": None, "shape_agr": None, "mean_prot_2a3": None, "shape_ok": 0,
            "openknot": None, "overlap_ae": None,
            "is_novel_v341": None,                    # not novelty-scored (below curation cut)
            "best_tm1": None, "near": "", "near_title": "",
            "score": None, "contact_ratio": cr, "bp_fraction": None, "in_shortlist": 0,
            "seq_cluster_size": None, "struct_rep": 1,
        }
        folds.append(rec)

    folds.sort(key=lambda x: -(x["plddt"] or 0))
    json.dump(folds, open(f"{od}/data/folds.json", "w"), separators=(",", ":"))
    if not os.path.exists(f"{od}/data/motifs.json"):
        json.dump({}, open(f"{od}/data/motifs.json", "w"))

    print(f"\n{args.name}: {len(folds)} folds -> {od}")
    print(f"  structs(gz)={n_struct}  no-prediction(skipped)={n_missing}")
    if folds:
        pl = [f["plddt"] for f in folds if f["plddt"] is not None]
        print(f"  pLDDT range {min(pl):.1f}–{max(pl):.1f} (n={len(pl)}); true_design_length "
              f"{min(f['true_design_length'] for f in folds)}–{max(f['true_design_length'] for f in folds)} nt")


if __name__ == "__main__":
    main()
