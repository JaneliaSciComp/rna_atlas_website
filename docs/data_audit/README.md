# Missing-attribute audit

A full sweep of all 10 active datasets on the site (per `web/datasets.js`) checking, for
every one of the ~85k fold records, which of the fields documented in
[`../fold-attributes.md`](../fold-attributes.md) are missing, and whether that's expected
or looks like a pipeline gap.

Datasets covered: `ribo2` (A-H base), `pseudolabels`, `openknot`, `openknot_long`,
`openknot_long_seq`, `openknot_cryoem_seq`, `openknot_cryoem_msa`, `ribo2-iq-curated-v2`
(I-Q), `rfam_pdb130`, `rfam_pdb240`.

Regenerate with the one-off script described below (not checked in — ask if you want it
restored) against `data/folds.json` + `dist/datasets/<id>/data/folds.json`.

## Files

- **`summary_by_field.csv`** — one row per (dataset, field): counts, `pct_missing`, and a
  `category`. Start here.
- **`by_sequence_<dataset>.csv`** — one row per fold: `missing_fields` (every field that's
  null/absent for that record, among fields the dataset actually populates for *some*
  record), `suspicious_fields` (the subset with no known explanation), and
  `suspicious_notes` (why).
- **`suspicious_records.csv`** — the `n_suspicious > 0` rows from all `by_sequence_*` files
  combined, sorted worst-first. **Start here if you just want the bug list.**

## Category meanings (`summary_by_field.csv`)

| Category | Meaning |
|---|---|
| `ALWAYS_PRESENT` | 0% missing — no issue. |
| `NOT_APPLICABLE` | Field is never populated anywhere in this dataset (0 of N records) — the dataset's pipeline doesn't compute it at all, e.g. `rfam_id` for `pseudolabels`. Not surfaced per-row since it's constant across every record. |
| `EXPLAINABLE_PARTIAL` | Some records missing it, but every missing case matches a known, verifiable cause (e.g. `overhang3` only exists when `termini_trim=1`). |
| `SUSPICIOUS_PARTIAL` | Some records missing it with **no** known cause for at least one record — see `note` for the explainable/suspicious split. |
| `SUSPICIOUS_DATASET_GAP` | 100% missing dataset-wide (so it would look like `NOT_APPLICABLE`), but a directly comparable dataset/field shows it *should* be populated. Hand-curated exceptions, see below. |

## Headline findings — root-caused

See **[`fix_checklist.md`](fix_checklist.md)** for the full investigation: every item below
was traced to the actual builder script + source file/parquet, not guessed, and grouped by
what kind of fix it needs (data exists but isn't joined vs. needs fresh computation vs. not
a bug at all).

1. **`ribo2` letters G+H (971 records): zero RNAcentral/Rfam annotation.** Confirmed root
   cause: `enrich_fgh_metadata.py` computes the same local `fasta_index` for F/G/H, but the
   source parquets use a global offset per letter (G starts at 8,000,000, H at 16,000,000) —
   the script never adds it, so the join silently matches zero rows for G/H. **Data exists,
   one-line fix.**
2. **`openknot` dataset: its own `openknot` score is null for all 3,698 records.** Confirmed
   root cause: it was built with the generic `build_dataset.py`, which hardcodes
   `openknot: None`; the follow-up enrichment pass never fills it in either. Verified the
   score is sitting right there in `OpenKnotBench_data.v4.5.1.txt` (same file
   `openknot_long`'s builder already joins by design-sequence). **Data exists, needs a join.**
3. **`openknot_long`/`openknot_long_seq`/`ribo2-iq-curated-v2` (51,824 records): `near_title`
   null for 100%**, even though `near` (the matched PDB id) is populated for all of them. The
   RCSB-title-lookup helper already exists and is used for other datasets — it was just never
   called for these three builders. **Data exists, needs a join.**
4. **`openknot_cryoem_seq`/`_msa` (56 records): `contact_ratio` null**, despite
   `bp_fraction`/`ss_class`/`plddt` (from the same structures) being populated. The builder
   hardcodes `None` and never calls the compactness calc, even though it already gzips the
   same PDB it could compute it from. **Needs computation, cheapest fix in the list.**
5. **`ribo2` base (A-H): `key` missing for all 7,757 records** — the base builder
   (`build_feature_table.py`) never computes it, unlike every other dataset's builder.
   **Needs computation** (trivial: same 3-line hash function used elsewhere).
   **`struct_rep`** is also missing dataset-wide, but the base mined-set files have no
   representative-flag column at all — unclear if the concept even applies to ribo2's
   1:1 prediction architecture. Flagged for the data team, not blindly fixed.
6. **Corrected from the first pass:** the `rfam_pdb130` (13), `ribo2` (6), and
   `pseudolabels` (9) `best_tm1`/`near` gaps are **not a bug** — confirmed via the LSF
   novelty chunks that USalign found no alignable match (LALI<20) for these specific short
   or unusual folds, and the code deliberately leaves them unscored by design. Also, `ribo2`
   letter F's SHAPE-agreement gap (132 records) is mostly **not a bug** either — the source
   TSV itself is blank for 130 of them, refining the documented "≤30nt" chemmap-gap
   threshold to more like ≤36nt for letter F; only **2 true outliers** remain unexplained.

Everything else that's missing (per-letter field applicability, `score` gated by
`in_shortlist`, `overhang3/5` gated by `termini_trim`, clustering fields only for the A-H
manifest, I-Q-only fields, etc.) checked out as explainable by design — see
`EXPLAINABLE_PARTIAL` rows in `summary_by_field.csv` for the full list with rationale.
