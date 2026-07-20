# Review of Marwan's data-audit (docs/data_audit) — independent verification

**Source under review:** `/groups/das/home/zouinkhim/atlas_explorer/docs/data_audit/`
(`README.md`, `fix_checklist.md`, `summary_by_field.csv`, `suspicious_records.csv`,
`by_sequence_<dataset>.csv` × 10) — a missing-attribute sweep of all 10 active datasets in
`web/datasets.js`, ~85k fold records total.

**Purpose of this doc:** Gao independently re-derived every root cause in `fix_checklist.md`
against the actual current builder scripts in this repo (not just trusted the writeup), to
answer Marwan's ask: "which are bugs and which are explainable." Written up here so a second
reviewer (Codex) can sanity-check the conclusions before they go back to Marwan/Rhiju.

**How to verify:** every claim below cites the exact file/line in this repo as it stands right
now. Re-open those files and confirm the cited line still says what's quoted.

---

## 1. Confirmed real bugs (fix_checklist.md section A/B) — verified against current code

| # | Claim | Verified against | Verdict |
|---|---|---|---|
| 1 | `ribo2` letters G+H (971 records): zero RNAcentral/Rfam because `enrich_fgh_metadata.py` computes the same *local* `fasta_index` for F/G/H, never adding the source parquet's global per-letter offset (F=0, G=+8,000,000, H=+16,000,000). | `enrich_fgh_metadata.py:37-49` — `by[f["letter"]][int(f["id"].split("-")[0]) - 1] = f` runs identically for F/G/H; the subsequent `pq.read_table(..., filters=[("fasta_index","in",list(idx2f))])` never adds an offset. | **Confirmed.** No offset logic exists anywhere in the file. |
| 2 | `openknot` dataset's own `openknot` (pseudoknot) score is null for all 3,698 records because `build_dataset.py` hardcodes it, and `merge_analysis.py`'s follow-up pass never fills it in. | `build_dataset.py:93` — `"openknot": None,` unconditional in the record dict. `merge_analysis.py:27` `DATASETS = ["pseudolabels","openknot","rfam_pdb130","rfam_pdb240"]`; its per-fold loop (`merge_analysis.py:137-161`) never references an `openknot` key. | **Confirmed.** |
| 3 | `openknot_long`/`openknot_long_seq`/`ribo2-iq-curated-v2` (51,824 records total): `near_title` null for 100%, even though `near` is populated 100%, because the existing RCSB-title-lookup helper was never called for these builders. | `build_openknot_long.py:196-204` sets `"near_title": ""` with no title lookup. `build_iq_curated.py:158-166` (`process()`) sets `"near_title": ""` the same way. Compare: `build_feature_table.py:117-141` (`load_pdb_titles`) and `merge_analysis.py:101-120` (`pdb_titles`) both exist and are called for `ribo2`/`pseudolabels`/`openknot`/`rfam_pdb130`. | **Confirmed.** Helper exists twice in the repo; neither of the two I-Q/OpenKnot-long builders calls either version. |
| 4 | `openknot_cryoem_seq`/`_msa` (56 records): `contact_ratio` null despite `bp_fraction`/`ss_class`/`plddt` being populated, because `build_cryoem.py` hardcodes it and never calls the compactness calc even though it already has the PDB on disk. | `build_cryoem.py:107` — `"contact_ratio": None,` (same line also hardcodes `"bp_fraction": None` and `"ss_class": ""`, but those two get overwritten by a later `derive_ss.py --name <name>` pass per the module docstring at line 18 — `contact_ratio` has no such downstream fill-in anywhere). No `contact_ratio()`/equivalent function exists in this file at all; three *other* builders (`build_dataset.py:26-45`, `build_feature_table.py:48-66`, `build_openknot_long.py:76-95`) each already implement the identical ~15-line C1'-C1' calc. | **Confirmed.** Cheapest fix in the list — function to copy-paste already exists 3× in-repo. |
| 5 | `ribo2` base (A-H): `key` missing for all 7,757 records, present in every other dataset's schema. | `build_feature_table.py:360-392` (the `rec` dict) has no `key` field. `key_of()` (sanitize id + 6-char md5 suffix) is defined in `build_dataset.py:21-23` / `build_iq_curated.py:46-48` / `build_openknot_long.py:47-49` but never imported into `build_feature_table.py`. | **Confirmed.** Purely derived from `id`; no new source data needed. |
| 6 | `ribo2` base: `struct_rep` missing dataset-wide — flagged as a **judgment call**, not a blind fix. | `build_feature_table.py`'s `rec` dict has no `struct_rep` key, and no code in the file reads any "representative" column from `selection.tsv`/`fold_metadata.tsv`. **Not independently verified:** could not check the raw TSV headers on `/groups/das/home/zouinkhim/atlas_recovery_setup`-adjacent mined-set paths (no `config.json` here to resolve `mined_dir`). | **Plausible, not fully verified** — code-side claim checks out; source-TSV-header claim is unconfirmed from this repo alone. |

## 2. Confirmed not-a-bug (fix_checklist.md section C)

| Claim | Verified against | Verdict |
|---|---|---|
| `best_tm1`/`near` "gaps" in `rfam_pdb130` (13), `ribo2` (6), `pseudolabels` (9) are deliberate — USalign found no alignable hit (LALI<20), left unscored by design, not a bug. | `merge_analysis.py:83` — `if tm <= 0 or not near: continue   # -1 error / no USalign hit (LALI<20) -> unscored, not "novel"`. `build_feature_table.py:104-107` has the equivalent guard (`if v is not None and v > 0 and nr:`). | **Confirmed**, comment text matches almost verbatim. |

*(Section C's other two items — letter-F's 31-36nt SHAPE-gate refinement, and `openknot_long`
`name` being blank because `eterna_title` is blank at the OpenKnotBench source — were not
independently re-derived here; would need the actual `fold_metadata.tsv` /
`OpenKnotBench_data.v4.5.1.txt` rows, which live outside this repo checkout. Flagging as
**not re-verified**, not as wrong.)*

## 3. New finding: the audit's own categorization is internally inconsistent

`near_title` (item 3 above, **51,824 records — the single largest record count of any finding
in the whole audit**) is correctly identified as a real, root-caused bug in `fix_checklist.md`.
But:

- In `summary_by_field.csv`, `near_title` for `openknot_long` / `openknot_long_seq` /
  `ribo2-iq-curated-v2` is tagged **`NOT_APPLICABLE`** ("field never populated... not surfaced
  per-row"), not `SUSPICIOUS_DATASET_GAP` — even though the README's own category definition
  for `SUSPICIOUS_DATASET_GAP` ("100% missing dataset-wide... but a directly comparable
  dataset/field shows it should be populated") describes this exact case.
- `suspicious_records.csv` contains **zero** rows mentioning `near_title` — verified by
  scanning the file directly. In fact `suspicious_records.csv` contains only 973 rows total,
  **all from the `ribo2` dataset** (the 971 G/H-offset records + 2 letter-F outliers). By
  design, that file only catches *partial* per-record gaps within a dataset, not fields that
  are 100% absent dataset-wide — so all 5 of the `SUSPICIOUS_DATASET_GAP`-category findings
  (`ribo2/key`, `ribo2/struct_rep`, `openknot/openknot`, `openknot_cryoem_seq/contact_ratio`,
  `openknot_cryoem_msa/contact_ratio`) are invisible there too, and `near_title` doesn't even
  make it into `summary_by_field.csv`'s version of that category.

**Consequence:** the README explicitly says "Start here if you just want the bug list" about
`suspicious_records.csv`. Following that instruction would surface only the `ribo2` G/H-offset
bug and miss every other confirmed finding in the audit, including the highest-record-count one.
Recommend: re-run/patch the categorization script so `summary_by_field.csv` tags `near_title`
as `SUSPICIOUS_DATASET_GAP` for those 3 datasets, consistent with what `fix_checklist.md` already
found by hand.

## 4. Ask for Codex

Please re-check section 1 and 2's file/line citations against the repo as it stands, and in
particular:
- Confirm/refute the `struct_rep` source-TSV claim (item 6) if you have access to the mined-set
  path (`config.json`'s `mined_dir`, not present in this checkout).
- Sanity-check section 3's claim about `suspicious_records.csv` only containing `ribo2` rows —
  re-run the same `csv.DictReader` scan independently rather than trusting this doc.
- Flag anything in `fix_checklist.md` sections C/D/E that looks inconsistent with the current
  code but wasn't covered above (this review didn't re-derive every item, only the ones with
  the highest record-count impact).

## 5. Codex's independent re-verification — corrections to this review

Codex re-checked every citation above against the repo (with access to the mined-set/config
paths this checkout lacks) and against the *actually deployed* v2 data. Full raw output:
`codex-review.md` (repo root). Summary of what changed:

### Downgraded — real gap, but not an active site bug
- **Item 5 (`ribo2.key`):** confirmed missing, but `web/app.js:529` and `:810` already do
  `(f.key || f.id)` — the frontend falls back gracefully, so this is a schema-consistency gap,
  not something visibly broken on the live site. Still worth fixing for consistency, just lower
  urgency than the others.

### Upgraded — turns out to be a cheap, unambiguous fix, not a judgment call
- **Item 6 (`ribo2.struct_rep`):** **REFUTED** as "needs a data-team decision." Codex found
  `annotation_manifest.parquet` already has an `is_fold_rep` column, it matches all 7,757
  `ribo2` ids, and it's `1` for every single one — and `build_feature_table.py:95-103`
  (`load_manifest()`) **already reads that column** into memory, just never writes it out as
  `struct_rep`. This resolves the open question the checklist raised (does "representative
  structure" even apply to ribo2 A-H?) — yes, trivially, the data's already sitting there.
  One-line fix, not a judgment call.

### Refined — conclusion direction was right, mechanism was described wrong
- **Section 2, letter-F "31-36nt SHAPE-gate":** there is no actual 36nt threshold. The real
  upstream rule (`27_chemmap_agreement.py:106-119`, outside this repo) requires >5 finite 2A3
  values *and* a non-constant pairing indicator for Pearson correlation to be defined; short
  length just correlates with hitting that guard. The 2 "unresolved" letter-F outliers in
  checklist Section D are **not actually unexplained** — same mechanism (41nt record: all valid
  positions unpaired; 45nt record: all valid positions paired → correlation undefined either way).
- **Checklist Section E's applicability list has factual errors in the deployed data:** `ptm`
  is not I-Q-only (present in every add-on dataset); `design_start`/`design_end`/
  `true_design_length`/`source_group` are present across *all* I-Q letters, not just N-Q;
  `seq_cluster_size` is not restricted to the A-H manifest. Only `pred_pearson_*`/
  `pred_spearman_*` are genuinely N-Q-restricted.

### Deepened — the root cause isn't fully understood yet
- **Item 3 (`near_title`):** the 51,824-record gap and cited lines are real, but
  `build_openknot_long.py:204` initializes *both* `near` and `near_title` blank — yet deployed
  `near` is 100% populated for these records. Some untracked step fills `near` outside what's
  in this repo. The "just call the existing title-lookup helper" fix may be incomplete until
  that producing step is found — it needs to reuse whatever already resolves `near`, not just
  bolt on a title lookup blind.
- **Section 3 wording overreach:** "zero rows mentioning `near_title`" was imprecise — one row
  (`7504094-ribonanza2g`) has it in `missing_fields` (just not in `suspicious_fields`, which is
  the substantive claim and still holds).

### New, most important finding — not in the original review at all
- **I-M letters (13,993 records) in the deployed `ribo2-iq-curated-v2` have no reactivity at
  all**, despite `build_iq_curated.py:103-104` and `enrich_iq.py:126` explicitly commenting
  "the old I-M flag-drop is fixed on the de-padded run." Checked directly: DMS/2A3 missing or
  all-zero, all agreement/fidelity fields null, for every one of the 13,993 records. This
  matches Marwan's own Slack explanation ("I made a mistake by not saving the predicted chemmap
  ... only NOPQ have it") — but means the code comments claiming this was already fixed are
  stale/wrong relative to what's actually deployed, independent of whatever Marwan's own
  in-progress "deep check" finds.
