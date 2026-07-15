# Handoff: recompute I–Q pLDDT over the true (unpadded) design region

*Prompt for the curation agent. Self-contained — you do not need prior context. Author: atlas agent
(RNA Atlas Explorer session). You decide the approach (§5) and execute; I gathered the facts,
evidence, and concerns below.*

---

## 1. Task

For Ribonanza‑2 **I–Q** designs whose **true design length < 130 nt**, recompute a fair **pLDDT**
(and gPDE / ptm) for the **true design region only**, and re‑apply the curation cut
`pLDDT > 70 & gPDE < 0.5`. Then (optionally) feed newly‑passing folds back to the atlas (§6).

**Why:** these designs were folded as **130‑nt 5′‑padded constructs**. The library was built "pad to
130 and add flanks", and the inference input builder (`build_iq_letter.py`) then slices a **fixed
`[26:156]` (130‑nt) window for every row** — it never consults per‑sequence design boundaries, so the
5′ pad is frozen into every fold. The `pLDDT>70` curation ran on those padded models, so short
well‑characterized RNAs (e.g. human tRNAs) were almost all excluded. Is that exclusion a **padding
artifact** (fixable) or **real**?

---

## 2. Empirical finding + concerns — READ BEFORE CHOOSING AN APPROACH

Per‑residue pLDDT is already in the existing PDB **B‑factor** column (0–100). Because padding is 5′ and
`sub_end` is fixed at 156, the true design is the **last `design_length` residues** of the 130‑mer
(`design_length = 157 − sub_start = 130 − len(five_padding)`). So a design‑region mean is recomputable
**with no inference**. I did that for the **20 human tRNAs that were folded**:

| metric | value |
|---|---|
| full‑130 mean pLDDT > 70 | **1 / 20** |
| design‑region mean pLDDT > 70 | **4 / 20** |
| mean pLDDT, full‑130 → design‑region | **56.1 → 56.0** (unchanged) |
| per‑fold change (design − full) | **mixed: −12.7 … +11.5** |

```
21259029  57.2 → 68.7 (+11.5)   21258902  55.7 → 55.9 (+0.2)
21259016  61.0 → 71.2 (+10.3)   21258818  45.8 → 45.6 (−0.2)
21259061  67.5 → 75.2 (+7.7)    21259033  61.9 → 59.9 (−2.0)
21258796  51.7 → 58.0 (+6.3)    21258811  49.7 → 47.0 (−2.8)
21258782  59.7 → 64.8 (+5.2)    21258820  57.5 → 54.5 (−3.0)
21258901  63.5 → 67.3 (+3.8)    21259048  54.3 → 48.9 (−5.5)
21259020  73.7 → 77.4 (+3.7)    21258714  51.5 → 44.8 (−6.7)
21258878  67.8 → 71.4 (+3.6)    21259034  53.5 → 46.7 (−6.7)
21259057  63.3 → 65.4 (+2.1)    21259019  47.1 → 38.9 (−8.2)
                                21258896  39.3 → 30.1 (−9.2)
                                21258886  40.7 → 27.9 (−12.7)
```

**⇒ Padding is NOT purely a mean‑averaging artifact.** For many tRNAs the design region folds with
genuinely low confidence *while the 5′ padding is present*. A free recompute alone rescues only the
clear cases (4/20).

**Concerns:**

- **A — Context contamination (the key one).** The design‑region pLDDT *inside a padded model* is
  affected by the ~50–75‑nt 5′ padding (which can base‑pair with the design and distort its fold). A
  context‑free number requires folding the design **alone** — only re‑inference answers "is the padding
  disrupting the fold, or is the model genuinely uncertain about these RNAs?"
- **B — Coverage.** For `tRNA_human` only **20 of 104** were ever folded: the inference input was
  pre‑filtered to **SN ≥ 1** (both DMS + 2A3 probes; `build_iq_letter.py --sn_threshold 1.0`), dropping
  84. A re‑fold that builds shards from the metadata can simply **drop the SN gate** and cover all 104.
- **C — Conditioning is a non‑issue (corrected).** The I–Q run used **`--enable_chemmap_input false`**,
  so reactivity was **never a folding input** for any letter — the `M5` checkpoint has a chemmap
  prediction *head* that emits reactivity as an auxiliary **output**. So re‑folding is **sequence‑only
  for all letters**; there is nothing to "slice". (The reason I–M are PDB‑only is that their submit
  scripts omitted `--atlas_save_extra_outputs true`, the flag that dumps the predicted `.profiles.npz` —
  a flag‑drop, not a conditioning difference. Add that flag on the re‑run if you want reactivity for the
  true region.)
- **D — Scale / cost.** Padded cases number ~**684,234** across all I–Q (`design_length < 130`); only
  **104** are in the curated atlas today. Recommend batching the **natural‑RNA sublibraries first**
  (`tRNA_human`, `rRNA_human`, `RefSeq_human`, `RefSeqSelect_human`/`_nonhuman`, `MANE`, `*_hand_selected`)
  — that's where short true designs + the bias live, and where re‑curation can admit genuinely new folds.
- **E — Comparability.** Keep the padded prediction; report **old (padded) vs new (unpadded)** pLDDT
  side‑by‑side so the de‑padding effect is measurable, not silently overwritten.

---

## 3. Metadata reference — where the true design region comes from

- **Per‑library parquets (recommended source):**
  `/groups/das/rnastruct/bioinformatics/2026ribo2-metadata/out/per_lib/Ribonanza2{L}.parquet`
  (L ∈ I..Q, 8,000,000 rows each). Cols: `fasta_index, library, sublibrary, source_id, sequence(177nt),
  sub_start, sub_end, design_length, design_sequence` (**the true design**), `five_padding, barcode, …`.
  Corrected by `phase6_fix_iq.py` (684,234 rows de‑padded) — trust these, not a raw "130" assumption.
  Per‑sublibrary shards + counts: `…/out/per_sublibrary/` (+ `_INDEX.csv`; `Ribonanza2K_tRNA_human` = 104).
- **177‑nt construct layout:** `GGGAACG(7) + ACUCGAGUAGAGUCGAAAA(19) + five_padding + design_sequence +
  three_padding(∅) + barcode + AAAAGAAACAACAACAACAAC(21)`. The folded 130‑mer = positions **27..156**
  (0‑based `[26:156]`) of the 177‑mer; `sub_start = 27 + len(five_padding)`, `sub_end = 156` (fixed).
  **Padded iff `design_length < 130`** (⇔ `five_padding` non‑empty). Verified identity:
  `folded_130nt[sub_start-27:] == design_sequence`, i.e. the design is the **3′ suffix** of the 130‑mer.
- **Join — atlas/curation `seq_id` ↔ metadata row (validated to 1.000).** `seq_id =
  "<N>-ribonanza2<letter>"`, `<N>` a 1‑based **combined‑group** index over the `{IJK, LMQ, NOP}`
  groupings (each library = one 8M block; I/L/N block 0, J/M/O block 1, K/Q/P block 2). Recover the row:
  ```
  letter      = seq_id.split("-")[1].removeprefix("ribonanza2").upper()
  fasta_index = (int(seq_id.split("-")[0]) - 1) % 8_000_000     # → row in Ribonanza2{L}.parquet
  ```
  This exact join is already implemented + validated in `/groups/das/home/zouinkhim/atlas_explorer/enrich_iq_metadata.py`
  (reads the parquet path from `config.json`, checks `design_sequence` against each fold's atlas 130‑nt
  seq with `aseq==dseq or aseq.endswith(dseq) or dseq.endswith(aseq)`, and refuses to write below
  `--min-match 0.90`) — reuse that mapping + sanity check for the re‑run.
  **Caveat:** the alternative file `…/out/rnanix/Ribonanza2{L}.parquet` has the same `design_sequence`
  but its `sequence_id` is **per‑library zero‑padded** (`f"{fasta_index+1:07d}-ribonanza2{letter}"`,
  e.g. `0000146-ribonanza2k`), which does **not** string‑match the combined‑group curation seq_ids for
  block‑1/2 letters (J/K/M/O/P/Q). If you use that file, join on the reconstructed per‑library index,
  not the raw seq_id. The `per_lib` `fasta_index` numeric join above avoids this.
- **Enumerate targets:** filter `Ribonanza2{L}.parquet` (or the per‑sublibrary shards) to
  `design_length < 130`; map each back to `seq_id = f"{fasta_index + 1 + offset}-ribonanza2{letter.lower()}"`,
  `offset ∈ {I/L/N:0, J/M/O:8_000_000, K/Q/P:16_000_000}`.

---

## 4. Existing pipeline (exact commands — reuse for the re‑run)

- **Input builder + SN gate:** `/groups/das/home/zouinkhim/atlas_recovery_setup/build_iq_letter.py`
  (+ `build_iq_letter_lsf.sh`, LSF array [1‑9]). It applies `keep = (sn_dms>=1) & (sn_2a3>=1)` and writes
  the **fixed** slice `design_seq = seq_full[26:156].replace("T","U")` (130 nt, pad included) to
  per‑shard parquets `…/atlas_recovery_setup/{L}_snr1_shards/shard_*.parquet` (schema
  `sequence_id, sequence, file_idx, row_idx, reactivity_DMS[130], reactivity_2A3[130]`). **This fixed
  `[26:156]` slice is the root cause and the one thing to change** (make `sequence = design_sequence`).
- **Fold runner:** `/groups/das/home/zouinkhim/ribonanza_inf_aws/RNAnix/runner/inference_rna.py`, launched
  per shard by `…/RNAnix/lsf/20260629_iq_snr1/{submit_all.sh, <L>/submit_array.sh}` (LSF `-q gpu_l4`,
  mamba env `RNAnix_v1`). **Exact command:**
  ```bash
  python runner/inference_rna.py \
    --run_name "<L>_snr1" --project "RNAnix_<L>_snr1" \
    --base_dir "$OUT_ROOT" --output_root "$OUT_ROOT" \
    --ribonanza_source rna_ribonanza2 \
    --ckpt "calibrated_20260508_chemmap_no_trunk:M5_rnaonly_no_tpl_ribo2_only_no_trunk" \
    --enable_chemmap_input false --predictions_per_rna 1 \
    --chunk_id 0 --num_chunks 1 --resume_skip_existing true --gzip_output true \
    --use_wandb false --eval_metrics false --max_steps 1 \
    --ribonanza_strip_padding false \
    --data.rna_ribonanza2.base_info.ribonanza2_presharded_parquet_fpath "$PARQUET" \
    --data.num_dl_workers 0 --atlas_openmm_inband false \
    --atlas_save_extra_outputs true
  ```
  Model = fleet `calibrated_20260508_chemmap_no_trunk`, slot **`M5_rnaonly_no_tpl_ribo2_only_no_trunk`**
  (rnaonly, templates off, chemmap head, no trunk truncation; ckpt on S3 `rnanix/checkpoints/…`).
  `--predictions_per_rna 1` → `seed_0/sample_0`. The presharded path (`dataset_rna.py` ribonanza2 branch)
  reads the parquet's `sequence` column verbatim — **no length assumption, no re‑padding** — so folding
  an arbitrary unpadded sequence just works.
- **Outputs:** `$OUT_ROOT/<L>_snr1__rna_ribonanza2__shard0000of0001/predictions/rna_ribonanza2/
  step_0_rna_ribonanza2_<seq_id>/seed_0/predictions/*_sample_0.pdb.gz` +
  `*_summary_confidence_sample_0.json.gz` (`plddt, ptm, iptm, gpde, ranking_score, disorder, has_clash,
  num_recycles`); run‑level `_manifest_0_of_1.tsv` (`sequence_id, mean_plddt, mean_ptm, mean_gpde, …`).
- **Curation cut:** `/groups/das/home/zouinkhim/atlas_recovery_setup/curation_iq_pLDDT70/logs/stage_1_2_fasta.py`
  applies `df[(df.mean_plddt > 70.0) & (df.mean_gpde < 0.5)]` over each letter's `_manifest_0_of_1.tsv`
  → `01_survivors/survivors_pLDDT>70_gPDE<0.5.csv` + `02_fasta/iq_survivors.fasta` (currently the padded
  130‑mers). Delivery docs: `…/curation_iq_pLDDT70/atlas_delivery/{DELIVERY_FOR_ATLAS_AGENT.md,
  TRAINING_INTEGRATION.md}` (both treat 130 as uniform; neither anticipates de‑padded re‑folding).

---

## 5. Two approaches — pick one or both

### A. Free recompute (no GPU)
For each padded fold, open the existing `…/seed_0/predictions/*_sample_0.pdb.gz`, average the per‑residue
B‑factor over the **last `design_length` residues** (3′ = true design), and re‑apply `pLDDT>70 & gPDE<0.5`.
- Instant, free, on‑disk. Cannot remove padding‑context effects; rescued only 4/20 tRNAs here. Best as a
  first filter and to quantify the "mean drag" per sublibrary.

### B. Re‑inference on the true region (rigorous — what actually removes the padding)
Build new pre‑sharded parquets whose **`sequence` = `design_sequence`** (the only change vs. today's
pipeline — a variant of `build_iq_letter.py` that reads `sub_start/sub_end/design_sequence` from
`Ribonanza2{L}.parquet` per row instead of the fixed `[26:156]` slice; drop the SN gate to cover all
targets, and trim the `reactivity_*` arrays to the design window for schema consistency). Then run the
**exact §4 command** unchanged, recompute pLDDT/gPDE from the new `summary_confidence`, and re‑curate.
- Sequence‑only for all letters (Concern C); covers the 84 unfolded tRNAs (Concern B); removes
  padding‑context effects (Concern A). Scope per Concern D. Report old vs new pLDDT (Concern E).
- *(Alternative to a new builder: use the non‑presharded HDF5 path with `--ribonanza_strip_padding true`
  and repoint `metadata_csv_fpath` to the I–Q metadata — but the presharded rebuild above is cleaner and
  reuses the fast fold path unchanged.)*

---

## 6. Downstream — atlas integration (after re‑fold)

New structures + pLDDT feed the RNA Atlas Explorer via builders in `/groups/das/home/zouinkhim/atlas_explorer/`:
`build_iq_curated.py` (curated set) or `build_iq_trna.py` (raw‑run variant, same layout) → `derive_ss.py`
→ `compute_embedding.py` → `enrich_iq_metadata.py` (names/sources/`source_group`) → upload `folds.json` +
`structs/` to `s3://rnanix/atlas_explorer/data/datasets/…` + invalidate. Short RNAs that newly pass the
cut then appear in the atlas.

---

*Numbers here (20 folded tRNAs; 4/20 vs 1/20; 56.1→56.0; 684,234 padded I–Q rows; 104 tRNA_human;
thresholds pLDDT>70 & gPDE<0.5) were measured/derived during the atlas session that produced this file.*
