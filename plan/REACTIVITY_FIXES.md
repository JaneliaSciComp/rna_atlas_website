# Reactivity data-integrity fixes (2026-07)

## Context

Following up on `plan/DATA_AUDIT_REVIEW.md` (the struct_rep/key/contact_ratio audit, already in
PR #4), this pass went dataset-by-dataset through every reactivity-bearing source registered in
`web/datasets.js` and *measured* (not assumed) whether each one's `dms`/`a23` actually reflects
real chemical-probing data. Every number below was independently re-derived by a fresh agent with
no memory of the implementation, recomputing from the raw HDF5/FASTA sources with its own code —
not by re-running or trusting the fix scripts themselves. Every claim was also self-verified with
isolation diffs (confirming *only* the intended fields changed) before that independent pass.

**Also independently re-reviewed by Codex** (`codex-reactivity-review.md`) after the pass below was
first written. Its findings — a stale "no data anywhere" claim for `openknot_cryoem_*`, a UI/
derived-field staleness bug in Fix 2, and a couple of doc-only number nits — are folded in below as
Fix 7 and corrections throughout; see "Codex's independent re-verification" at the end.

**Coverage is now complete**: all 9 datasets in the Source selector have a real, fixable reactivity
gap that is now fixed — including `openknot_cryoem_*`, initially (and incorrectly) written off as
"no gap to fix" until Codex's review caught it (see Fix 7).

## Where the data lives (important: nothing is deployed yet)

This checkout has no `config.json`/`dist/`/`cryo_tmp/` (gitignored, machine-specific). The
*already-deployed* per-fold data lives read-only at
`/groups/das/home/zouinkhim/atlas_explorer/dist/datasets/<name>/` — we can read it but not write
it. So every fix below is "run against the real deployed data, write the corrected result to
`tmp_analysis/<fix>/`" — those patched trees are the hand-off artifact; whoever holds the
`atlas-deployer` AWS credentials still needs to drop them into `dist/` and run `./deploy.sh`.
`tmp_analysis/` itself is not meant to be committed (matches the pattern used for the
struct_rep/key/contact_ratio fix).

---

## Fix 1 — OK7b/OK8 reactivity (`openknot_long`, `openknot_long_seq`)

**Root cause:** `build_openknot_long.py` sources 2A3 only (DMS always null) from a join to
`OpenKnotBench_data.v4.5.1.txt`, whose per-position coverage for these ~240nt designs tops out
around ~100nt median. Real, validated, per-nucleotide 1D cmuts DMS+2A3 data for OK7a/OK7b/OK8
already exists (`202606-1d-ok7ab/`, QC'd vs Rhiju's UBR pipeline, r=0.87–0.98) but was never wired
into the website.

**Fix:** new `enrich_openknot_long_react.py` — joins by normalized `design_sequence` against
`ok7ab8_metadata_combined.parquet` (which carries `reactivity_h5`/`reactivity_row`/`sub_start`/
`sub_end`/`SNR_DMS`/`SNR_2A3` per row), slices the real H5, masks DMS to A/C.

**Result:** 9,193/9,193 records (4,600 + 4,593) matched at 100%. DMS went 0%→50.66% position
coverage (expected — DMS only measures A/C); 2A3 went 99.92%→99.58% coverage (this is a *source
swap* to a validated measurement, not a coverage fix — the old OpenKnotBench-sourced value was
already 99.92% covered, not sparse as initially assumed; caught and corrected mid-investigation,
numbers re-confirmed independently by Codex's review and by a fresh recount of the patched output).

**Also:** updated `build_openknot_long.py`'s docstring "Then run:" chain to include this script.

---

## Fix 2 — A-Q / I-Q reactivity (`ribo2-iq-curated-v2`)

**Root cause:** all 42,631 records shipped either pure placeholder (I/J/K/L/M: confirmed 100% of
"signal" is literally constant `0.0`, matching Marwan's own admission of a lost predicted-chemmap
save) or a chemmap *pseudolabel* (N/O/P/Q: real-looking but confirmed non-measured — `sn`/SNR was
`null` for all 42,631 records, proving none of it was ever a wet-lab value). Real measured DMS+2A3
for all 9 letters exists at `atoq-upload/uniform-spread/` but nothing in the codebase read it.

**Fix:** new `enrich_iq_real_reactivity.py`. Row lookup was empirically validated against real
sequences (not assumed offsets): `global_row = int(id.split("-")[0]) - 1`, **no per-letter block
offset** — confirmed 18/18 sample records across all 9 letters via FASTA substring match, and the
H5's NaN boundary (5'/3' primer regions) lines up with a validated row exactly. Uses each record's
own `design_start`/`design_end` (not the generic default) since many were re-cropped by the
de-padded union pipeline. Also recomputes `r2a3`/`shape_agr`/`shape_ok` from the new real `a23`
(non-circular now, vs. `enrich_iq.py`'s pseudolabel-based version).

**Result:** all 42,631 records patched, `sn` populated for 100% (was 0%). Position coverage:
I/J/K/L/M went from a fake 100% to a real 11–60% (genuine gaps — these letters have shallow
sequencing depth, median 74–228 reads, confirmed via direct SNR/reads↔coverage correlation,
r=0.78–0.88); N/O/P/Q went from 77–79% (pseudolabel) to 72–76% (real), similar order of magnitude.
`r2a3`/`shape_agr` recomputed for 32,543/42,631 (the rest have an unpaired-dbn / correlation-
undefined edge case, not missing data).

**Also (found by Codex's review, now fixed):** the react JSON's own `pred_dms`/`pred_a23` (the
model's raw predicted profile, present in ~97% of records) were still being scored, via stale
`pred_pearson_*`/`pred_spearman_*` in `folds.json`, against the *replaced* pseudolabel — and
`web/app.js`'s deep-view metadata panel and reactivity chart hardcoded the label "pseudolabel" for
what the patch had just made real data. The original deferral note ("needs the raw model-prediction
arrays") was wrong — `pred_dms`/`pred_a23` were already sitting in the react JSON, no re-read
needed. Fixed: `enrich_iq_real_reactivity.py` now recomputes `pred_pearson_dms`/`pred_pearson_2a3`/
`pred_spearman_dms`/`pred_spearman_2a3` against the new real `dms`/`a23` for every patched record
(set to `null`, not left stale, when `pred_dms`/`pred_a23` is absent or the correlation is
undefined); `web/app.js` lines 645/769/776 changed "pseudolabel" → "real"/"measured (real)".
30,863/42,631 `pred_pearson_dms` and 31,155/42,631 `pred_pearson_2a3` got a real recomputed value
(rest correctly `null` — no `pred_dms`/`pred_a23` on that record, or the correlation was
undefined); a fresh from-scratch pearson/spearman implementation (not reusing the fix's own
functions) re-checked all 85,262 dms+2a3 slots across all 42,631 records — 0 mismatches, 0
disallowed `folds.json` field diffs.

---

## Fix 3 — `pseudolabels` SHAPE-support fields (not a reactivity gap — reactivity was already fine)

**Root cause:** reported by the user after spotting "N/D" SHAPE on the live site. Reactivity
itself was already real and complete (19,627–19,759/19,759, confirmed) — the bug is one layer up:
`build_dataset.py` hardcodes `r2a3`/`shape_agr`/`shape_ok`/`mean_prot_2a3` to null/0 for every
record, and nothing downstream ever computes them, even with real `a23` and a real `pairing.json`
dot-bracket sitting right there for all 19,759 records.

**Fix:** new `enrich_pseudolabels_shape.py` — `r2a3 = pearson(is_paired, a23)`; `shape_agr = -r2a3`;
`shape_ok = 1 if r2a3 < -0.2`.

**Result:** 18,837/19,759 (95.3%) now `shape_ok=1`, up from 0/19,759. Mean `r2a3 = -0.40` (paired
positions measurably less reactive — the correct SHAPE-agreement signature, confirmed
position-by-position, not just in aggregate). Of the other 922 (previously under-described as just
"the remaining 132" — corrected after Codex's review): 132 have a 100%-unpaired dot-bracket
(zero-variance `is_paired` → correlation mathematically undefined, correctly left alone) and 790
have a well-defined `r2a3` that simply doesn't clear the `< -0.2` `shape_ok` threshold — genuinely
weaker SHAPE-pairing agreement, not a bug. `mean_prot_2a3` is a deliberate scope choice, not a
data-availability limitation (the motif spans and patched 2A3 arrays it needs already exist for
both this dataset and `openknot`) — left for a separate, bigger job: the fuller tertiary-motif
background-subtracted calc.

---

## Fix 4 — F/G/H DMS masking (`ribo2` base, letters F/G/H)

**Root cause:** found while re-checking the base `ribo2` dataset (A-H) end to end. A-E masks DMS
to A/C positions correctly; the F/G/H branch in both `build_static.py` and `serve.py` never did —
confirmed directly: real DMS values were sitting at G/U sequence positions, which is chemically
meaningless (DMS only methylates A/C).

**Fix:** added the same `seq[i] in "AC"` mask to F/G/H's DMS assignment in both files, matching
the existing A-E pattern. Also added a `len(seq) == L` guard (flagged by the independent
verification pass as a latent fragility — no live bug today, but the F/G/H branch's slice length
and the masking loop's length were never asserted equal).

**Result:** retroactively patched the 2,783 already-deployed F/G/H react JSONs (no H5 re-read
needed — the underlying values are correct, just null out the wrongly-populated G/U positions):
1,188/2,783 records affected, 18,070 values nulled. 0 A/C-position values changed, 0 other fields
changed.

---

## Fix 5 — `openknot` OK7a reactivity + SHAPE fields

**Root cause:** same missing-DMS gap as Fix 1, for the separate `openknot` dataset (3,698 records,
OpenKnotBench-general, not OK7b/OK8-specific). Also had the same hardcoded-null SHAPE fields as
Fix 3.

**Fix:** reused `enrich_openknot_long_react.py` (`--names openknot`) — the same
`ok7ab8_metadata_combined.parquet` also covers 12,000 OK7a designs. Then reused
`enrich_pseudolabels_shape.py` (generalized with a new `--react-root` flag to read a23 from the
just-patched tree while pulling `pairing.json` from the original).

**Result:** only **1,147/3,698 (31%)** matched the OK7a cmuts source — `openknot` is not
exclusively OK7a, so this is a partial, honest fix, not full coverage. Those 1,147 got real
DMS+2A3; the other 2,551 keep their existing OpenKnotBench-sourced `a23` unchanged (confirmed
untouched). `r2a3`/`shape_agr`/`shape_ok` recomputed for all 3,698 (0 skipped) using whichever a23
source each record has.

---

## Fix 6 — RFAM-PDB 130/240 reactivity (from zero)

**Root cause:** `rfam_pdb130` (1,614) / `rfam_pdb240` (2) are experimental PDB/RFAM structures
(`cond:["exp"]`) that shipped **zero** reactivity of any kind. Real DMS+2A3 1D chemical-mapping
data for both libraries exists (Ultima sequencing, 99.8–99.9% SNR≥1) but was never wired in —
these datasets don't share the id-embedded-row-index trick the others do, since the atlas's ids
(`RF00356:Small_nucleolar_RNA_...`) don't match the source library's numbering scheme directly.

**Fix:** new `enrich_rfam_pdb_react.py` — joins by finding each record's `seq` as a substring of
the original library FASTA (whose row order matches the H5 row order, confirmed via the
library's own translation table), disambiguating the ~5% of sequences that hit multiple FASTA
rows by comparing normalized names (the FASTA headers closely mirror the atlas's id format).

**Result:** **1,614/1,614 and 2/2 — 100%**, up from 0%. Real SNR now present for all. Every
join (unique-hit and name-disambiguated alike) and every dms/a23/sn value was independently
re-derived from scratch and matched exactly.

---

## Fix 7 — `openknot_cryoem_seq`/`openknot_cryoem_msa` reactivity (found by Codex's review)

**Root cause:** these 56 records (28 round-8 Eterna cryo-EM candidates × 2 dataset variants) were
first documented below as "confirmed fine, no gap to fix" — `build_cryoem.py`'s docstring says
they're fresh AI designs never wet-lab probed, and they're absent from OpenKnotBench (the source
Fix 1/5 looked at for OK7b/OK8/OK7a). But they were never checked against the *fuller* 1D cmuts
metadata parquet those same fixes actually read from. Codex's review flagged this as likely wrong;
independently re-verified from scratch: 28/28 unique cryo sequences match a `design_sequence` row
in `ok7ab8_metadata_combined.parquet` exactly.

**Fix:** reused `enrich_openknot_long_react.py` completely unchanged — `--names
openknot_cryoem_seq openknot_cryoem_msa`. No new code needed; the script was already generic over
dataset name.

**Result:** 28/28 and 28/28 (100%) matched and patched with real DMS+2A3 + SNR.
`build_cryoem.py`'s own docstring ("no experimental SHAPE") is now stale on this point — left as-is
since the *build* step didn't change, same as `build_openknot_long.py` after Fix 1 (the enrichment
script supersedes it). Isolation-checked: 0/28 `seq` changes in either dataset, only `dms`/`a23`/`sn`
touched, no unexpected new keys.

---

## Confirmed fine, no action needed

- **`ribo2` base, letters A-E**: real uniform-spread data, ~51–54% DMS coverage (expected A/C
  masking), ~100% 2A3, SNR populated, no degenerate records.

## Explicitly deferred (documented in the relevant script, not silently dropped)

- `mean_prot_2a3` (pseudolabels, openknot) — a deliberate **scope choice**, not a data-availability
  limitation (corrected after Codex's review flagged the original wording as implying the data
  wasn't there — it is: motif spans + the patched 2A3 arrays both already exist). Needs the fuller
  tertiary-motif background-subtracted protection calc, a separate bigger job.
- `pred_dms`/`pred_a23` themselves (ribo2-iq-curated-v2) — the model's raw predicted profile is
  left untouched (still describes what the model predicted, independent of which reactivity source
  it's compared against). `pred_pearson_*`/`pred_spearman_*` are **not** deferred any more — see
  Fix 2's "Also" paragraph.

## Files changed

| File | Change |
|---|---|
| `enrich_openknot_long_react.py` | new — Fix 1, reused unchanged for Fix 5 and Fix 7 |
| `enrich_iq_real_reactivity.py` | new — Fix 2; extended (Codex review) to recompute `pred_pearson_*`/`pred_spearman_*` |
| `enrich_pseudolabels_shape.py` | new — Fix 3, generalized + reused for Fix 5 |
| `enrich_rfam_pdb_react.py` | new — Fix 6 |
| `build_static.py`, `serve.py` | Fix 4 (F/G/H DMS mask + length guard) |
| `build_openknot_long.py` | docstring only, points at `enrich_openknot_long_react.py` |
| `web/app.js` | Codex review — lines 645/769/776: "pseudolabel" → "real"/"measured (real)" wording for the I-Q prediction-fidelity panel + chart, now stale after Fix 2 |

## Verification methodology (applied to every fix above)

1. Self-check: isolation diff (only the intended fields changed, full record scan, not sampled)
   and coverage/degeneracy measurement (real numbers, not "has any non-null value" — that check
   itself gave a false "100%" for the I-M placeholder data and had to be redone properly).
2. Independent agent re-verification: a fresh agent with no memory of the implementation,
   recomputing from the raw sources with its own code (not reusing or trusting the fix script),
   full-scan where feasible. Zero refutations across the original six fixes.
3. Independent Codex review (`codex-reactivity-review.md`), a second, differently-tooled pass over
   the same claims — see below.

## Codex's independent re-verification

Ran a second-pass review after this doc's first draft, re-deriving joins/values from the raw
parquet/H5/FASTA sources itself rather than trusting the fix scripts or our own verify scripts.

- **Confirmed** Fixes 1, 3, 4, 5, 6 and the base-A-E "confirmed fine" claim — with two doc-only
  number corrections folded into Fix 1 and Fix 3 above (old/new 2A3 coverage; the 132-vs-790
  breakdown).
- **Found two real issues**, both independently re-confirmed with fresh code (not just trusting
  Codex's report) and fixed before this branch goes to PR:
  - `openknot_cryoem_*` was **not** "no data anywhere" — 28/28 sequences match the same
    `ok7ab8_metadata_combined.parquet` Fix 1/5 already use. Now Fix 7.
  - Fix 2's `pred_pearson_*`/`pred_spearman_*` and two `app.js` UI labels were stale against the
    newly-real `dms`/`a23`, and the deferral rationale ("needs raw model outputs") was wrong since
    `pred_dms`/`pred_a23` were already on hand. Now fixed — see Fix 2's "Also" paragraph.
- Also correctly flagged `mean_prot_2a3`'s deferral as a scope choice, not a data-availability
  limitation — reworded above, not otherwise acted on (still a separate bigger job).

## Not yet done

- Not committed, not pushed, no PR opened — holding per explicit request pending review.
- Patched data hand-off (`tmp_analysis/*_patched/`) still needs to be applied to the live `dist/`
  and redeployed by whoever holds `atlas-deployer` credentials.
