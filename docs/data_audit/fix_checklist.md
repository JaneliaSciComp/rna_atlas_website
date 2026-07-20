# Missing-attribute fix checklist

Follow-up to [`README.md`](README.md) / [`summary_by_field.csv`](summary_by_field.csv). Every
item below was traced back to the actual builder script + source file (not guessed) — see
"Evidence" under each. Grouped by what kind of fix it needs, since that's what determines who
does the work and how long it takes.

---

## 0. Upstream inference gap (not fixable in this repo) — reactivity for I/J/K/L/M

- [ ] **`ribo2-iq-curated-v2` letters I/J/K/L/M (13,993 records): no real DMS/2A3 reactivity
  at all**, and `r2a3`/`shape_agr`/`pred_pearson_*`/`pred_spearman_*` are all null as a
  consequence. This is the single biggest missing-data item in the whole atlas by record
  count — bigger than everything in sections A-D combined.
  - **Root cause (confirmed at the raw model-output level):** spot-checked via
    `21258723-ribonanza2k` (tRNA-Pro, human mitochondrial, 69nt). Its `profiles.npz`
    prediction file exists on disk and has a real, varying `profile_1D` array (69×10,
    values 0.0009-0.9995) — inference genuinely ran — but `exp_reactivity_DMS` and
    `exp_reactivity_2A3` are **all zero**, and the model's own `pearson_dms`/`pearson_2a3`/
    `spearman_dms`/`spearman_2a3` are **NaN**. Checked all 13,993 I/J/K/L/M records the same
    way: 100% show either a missing npz or an all-zero reactivity channel — none have a
    real signal.
  - **This is the documented 2026-07-02 incident**, not a new bug: the production submit
    scripts for these letters were generated without `--atlas_save_extra_outputs true`
    (dropped from `_template_submit_array.sh`), so reactivity/profile output was never
    computed for 33.4% of the atlas, while N/O/P/Q (which had the flag) got it.
  - **Correction to a code comment:** `build_iq_curated.py`'s `load_react()` docstring
    claims *"the old I-M flag-drop is fixed on the de-padded run"* — the data contradicts
    this. The de-padded npz for the spot-checked record still has all-zero reactivity, so
    whatever fix was intended doesn't appear to have actually landed in what's deployed.
    Worth correcting the comment or re-checking whether the de-padded rerun that was
    supposed to fix this actually happened.
  - **Fix:** requires re-running RNAnix inference for I/J/K/L/M with reactivity output
    enabled — an expensive re-inference job, not an atlas_explorer code change. Track as the
    known "permanent coverage gap on I-M" cost noted in project memory, not a quick patch.

---

## A. Data already exists — just needs to be joined/wired in (real bugs, cheap fixes)

- [ ] **`ribo2` letters G + H: zero RNAcentral/Rfam annotation** (`rnacentral_id`,
  `rnacentral_name`, `member_dbs`, `rna_type`, `rfam_id`, `rfam_name`) — **971 records**
  (G: 439, H: 532), vs. letter F at ~99% coverage.
  - **Root cause (confirmed):** `enrich_fgh_metadata.py` computes
    `fasta_index = int(id.split("-")[0]) - 1` the same way for F, G, and H. But the source
    parquets (`ribo2_metadata_enhanced/Ribonanza2{F,G,H}.parquet`, 8M rows each, confirmed
    present on disk) use a **global fasta_index offset per letter**: F = `0..7,999,999`,
    G = `8,000,000..15,999,999`, H = `16,000,000..23,999,999`. The script never adds this
    offset for G/H, so its parquet filter matches zero rows.
  - **Verified:** manually re-queried `Ribonanza2G.parquet`/`Ribonanza2H.parquet` with the
    offset added (`local_index + 8_000_000` / `+ 16_000_000`) and got real RNAcentral hits
    (e.g. `URS00007E3A87` / *bra-miR9568-5p*, `URS0000548AE4` / *Mus musculus oocyte...*) for
    G/H folds that currently show null.
  - **Fix:** add a per-letter offset (`{"F": 0, "G": 8_000_000, "H": 16_000_000}`) to the
    `fasta_index` computation in `enrich_fgh_metadata.py`, then rerun it.

- [ ] **`openknot` dataset: its own `openknot` (pseudoknot) score is null for all 3,698
  records**, while sibling datasets `openknot_long`/`openknot_long_seq` have it on 100%.
  - **Root cause (confirmed):** `openknot` was built with the generic `build_dataset.py`,
    which hardcodes `"openknot": None` (line 93) for every dataset it builds. The follow-up
    enrichment pass, `merge_analysis.py`, backfills `best_tm1`/`near`/motifs/`bp_fraction` for
    this dataset but never touches the `openknot` field either.
  - **Verified:** pulled the sequence for a sample `openknot` record
    (`W02_13198268_5pad6_libraryready`) from its `react/<key>.json` and found an exact
    `design_sequence` match in `OpenKnotBench_data.v4.5.1.txt` — the same source file
    `build_openknot_long.py` already joins by — with `target_openknot_score = 86.5988`.
  - **Fix:** add an OpenKnotBench design-sequence join (same pattern as
    `build_openknot_long.py`'s `load_okb()`) to `merge_analysis.py`'s `openknot` handling, or
    a small standalone patch script.

- [ ] **`openknot_long`, `openknot_long_seq`, `ribo2-iq-curated-v2`: `near_title` is null for
  100% of records** (**51,824 total**: 4,600 + 4,593 + 42,631), even though `near` (the PDB
  chain id) is populated for 100% of the same records.
  - **Root cause:** `load_pdb_titles()`/`pdb_titles()` (RCSB REST/GraphQL lookup, with an
    on-disk cache at `.rcsb_titles.json`) already exists and is used by
    `build_feature_table.py`/`merge_analysis.py` for `ribo2`/`pseudolabels`/`openknot`/
    `rfam_pdb130` — it was just never called for these 3 datasets' builders
    (`build_openknot_long.py`, `build_iq_curated.py`).
  - **Fix:** after building, run the existing title-lookup helper against each dataset's
    `near` values and write `near_title` back into `folds.json`. No new data source needed.

---

## B. Needs fresh computation from data we already have on disk

- [ ] **`openknot_cryoem_seq` / `openknot_cryoem_msa`: `contact_ratio` null for all 56
  records** (28 + 28), while `bp_fraction`/`ss_class`/`plddt` — computed from the same
  structures — are populated.
  - **Root cause (confirmed):** `build_cryoem.py` hardcodes `"contact_ratio": None` (line
    107) and never calls a compactness calc, even though it gzips the raw predicted PDB into
    `structs/<key>.pdb` right there in the same function. The identical `contact_ratio()`
    C1'-C1' calc (gemmi + numpy, ~15 lines) is already implemented 3 times elsewhere
    (`build_dataset.py`, `build_feature_table.py`, `build_openknot_long.py`).
  - **Fix:** call the existing `contact_ratio()` function on the PDB path already being
    written, same as the other three builders do. Cheapest fix in this whole list — 56
    records, structure already on disk, function already written.

- [ ] **`ribo2` base (A-H): `key` missing for all 7,757 records**, present in every other
  dataset's schema.
  - **Root cause:** `build_feature_table.py` (the actual builder for `data/folds.json`) never
    computes a `key` field at all — `build_dataset.py`'s `key_of()` (sanitize id + 6-char md5
    suffix) was written for the *other* datasets and never ported back to this one.
  - **Fix:** add the same `key_of()` call to `build_feature_table.py`'s record dict and
    rerun. Purely derived from `id` — no new source data needed.

- [ ] **`ribo2` base (A-H): `struct_rep` missing for all 7,757 records** — needs a decision,
  not just a rerun.
  - **Investigated:** unlike `pseudolabels`/`openknot`/etc. (whose source manifests carry a
    `struct_is_representative` column, because those pipelines predict multiple candidate
    structures per cluster and flag one), the ribo2 A-H mined-set files
    (`selection.tsv`, `fold_metadata.tsv`) have **no representative-flag column at all** —
    checked both headers directly.
  - **Open question:** does "representative structure" even apply to ribo2 A-H, where each
    fold is already a single 1:1 prediction (not one-of-several candidates per cluster)? If
    yes, it'd need new logic (e.g. picking one structure per `global_fold_id`); if the concept
    doesn't apply here, this should be documented as N/A rather than "missing." **Flag for
    the data team rather than fixing blind.**

---

## C. Not a bug — confirmed working as intended

- [ ] **`best_tm1`/`near`/`near_title` gaps in `rfam_pdb130` (13 records), `ribo2` (6),
  `pseudolabels` (9)** — my earlier audit called the `rfam_pdb130` ones "suspicious" because
  they didn't fit the short-length pattern the other two datasets show. That was wrong.
  - **Root cause (confirmed):** all 13 `rfam_pdb130` records show `best_tm1_v341 = 0.0000`
    and an empty `nearest_known` in the LSF novelty chunks, which `merge_analysis.py`
    explicitly treats as *"-1 error / no USalign hit (LALI<20) → unscored, not novel"* (its
    own comment) and deliberately leaves `best_tm1` null rather than reporting a misleading
    `0.0`. `build_feature_table.py` has the identical guard for `ribo2`/`pseudolabels`. USalign
    simply couldn't find a long-enough alignable match for these specific small/unusual folds
    (snoRNAs, microRNA precursors, a CRISPR repeat, an HIV splice-donor stem — all short,
    idiosyncratic motifs with no close v341 PDB neighbor).
  - **Correction to prior audit:** reclassify all 28 of these (13+6+9) from
    `SUSPICIOUS_PARTIAL` to explainable — no fix needed, this is the intended behavior.

- [ ] **`ribo2` letter F: `r2a3`/`shape_agr` null for 132 records with length >30nt** — refines
  (doesn't overturn) the documented "≤30nt has all-NaN chemmap" gotcha.
  - **Root cause (confirmed):** all 132 ids were found directly in `fold_metadata.tsv` with
    `r_2a3_ispaired` already blank in the **source** TSV — this is not a join/wiring issue,
    the correlation itself was never computed upstream for these specific reads.
  - **Refinement:** 130 of the 132 (98.5%) are 31-36nt — i.e. just above the documented 30nt
    boundary. The real "chemmap unusable" cutoff for letter F looks closer to **≤36nt**, not
    ≤30nt as currently written in `CLAUDE.md`. Only **2 true outliers remain** (41nt, 45nt) —
    see section D.
  - **Suggested action:** update the documented threshold; no pipeline fix needed for the 130.

- [ ] **`openknot_long`/`openknot_long_seq`: `name` missing for ~50% of records** (2,291 /
  2,309 split).
  - **Root cause:** `name` is set directly from OpenKnotBench's `eterna_title` column
    (`build_openknot_long.py` line 196), which is simply blank for about half of the source
    rows (ids like `TauraTaura`, `SCARNA2_4_...`, `ok8-00009` have no title in OpenKnotBench
    v4.5.1; ids like `U7 AK_PK240-3 OK7b` do).
  - **Optional improvement (not a bug fix):** could derive a fallback name from `sublibrary`/
    `source` the way `build_feature_table.py`'s `human_name()` does for the base ribo2 set,
    rather than leaving it blank. Low priority — UI already falls back to `id`.

- [ ] **`ribo2` letters A-E: `openknot` score always null** — confirmed genuinely not
  applicable (OpenKnotBench only scores natural F-H-type sequences; `fold_metadata.tsv` shows
  `openknot_score` populated for 100% of F/G/H rows and 0% of A-E rows, at the *source*, before
  any repo code runs). No fix possible or needed.

---

## D. Unresolved — needs more digging

- [ ] **2 `ribo2` letter-F records (41nt, 45nt) missing `r2a3`/`shape_agr`** despite being
  well above the refined ~36nt boundary from section C. Source `fold_metadata.tsv` also shows
  these blank, so it's an upstream-pipeline question, not an atlas-explorer bug — but worth
  asking the mined-set team why these two specific reads lack a chemmap correlation when nabors
  of similar length have one. Low volume (2 records), low priority.

---

## E. By design — confirmed no source data exists, no action possible

Reference only, not for follow-up: per-letter field applicability (`overlap_ae`,
`overlap_global_fold_id`, clustering fields restricted to the A-H/AE_FGH manifest,
I-Q-only fields `ptm`/`design_start`/`design_end`/`true_design_length`/`source_group`/
`pred_pearson_*`/`pred_spearman_*` restricted to letters N-Q), `overhang3`/`overhang5`
gated by `termini_trim`, `score` gated by `in_shortlist`, `mean_prot_2a3` gated by
`n_tert`/signal-to-noise, `clashscore` only for curated representatives, and the cryo-EM
micro-batch's optional manual-curation fields (`description`/`designer`/`eterna_id`/`notes`/
etc.). Full per-field rationale is in `summary_by_field.csv`.

---

## Priority if picking one thing to fix first

**Biggest record count by far is section 0 (I/J/K/L/M reactivity, 13,993 records)**, but it
needs an expensive re-inference run, not a code fix — track it separately as infrastructure
work, not a quick patch.

**Of the fixes actually doable in this repo, A (RNAcentral/Rfam G/H offset bug)** is highest
priority — 971 records × 6 fields, a one-line offset fix in `enrich_fgh_metadata.py`, and
it's an unambiguous, proven bug rather than a judgment call.
