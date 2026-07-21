# Fixes for the remaining items in Marwan's data-audit checklist (2026-07)

## Context

`plan/DATA_AUDIT_REVIEW.md` (Section 1) independently re-confirmed 6 real bugs from Marwan's own
`docs/data_audit/fix_checklist.md`. Three were already fixed (PR #4: `struct_rep`, `key`, cryo-EM
`contact_ratio`). This pass fixes the **other three**, all still live on the real deployed data as
of this check:

| Bug (Marwan's own finding) | Before | After |
|---|---|---|
| `ribo2` G/H: zero RNAcentral/Rfam | G 0/439, H 0/532 | G 433/439, H 525/532 |
| `openknot` dataset's own `openknot` (pseudoknot) score | 0/3,698 | 3,698/3,698 |
| `near_title` (3 datasets, 51,824 records) | 0/51,824 | 51,621/51,824 |

Every claim below was measured against the real deployed data first (not assumed from the
checklist text), and every fix was independently re-verified with fresh code, same bar as the
reactivity-fixes pass (`plan/REACTIVITY_FIXES.md`).

---

## Fix 1 — `ribo2` G/H RNAcentral/Rfam (971 records affected)

**Root cause, confirmed exactly as Marwan described:** `enrich_fgh_metadata.py` computes each
fold's join key as the *local* index derived from its `id` (`int(id.split("-")[0]) - 1`), but
the enhanced-metadata parquet's `fasta_index` column is **globally** offset per letter —
confirmed directly via parquet row-group statistics: F is 0–7,999,999, G is
8,000,000–15,999,999, H is 16,000,000–23,999,999 (each file is a full 8M-row block of one
combined numbering scheme). F's join happened to work (offset 0); G/H's filter matched zero
rows.

**Fix:** added `OFFSET = {"F": 0, "G": 8_000_000, "H": 16_000_000}`, added to the local index
before building the join-key dict.

**Result:** F unaffected (1,811/1,812, unchanged — regression-checked). G: 0→433/439 (98.6%).
H: 0→525/532 (98.7%). Isolation-checked over all 7,757 `ribo2` records: 0 changes to non-F/G/H
records, 0 disallowed field changes on F/G/H records. Fresh independent re-derivation (separate
script, single-row parquet queries, not reusing the fix's own dict-building code) matched 10/10
sampled records exactly — including one of Marwan's own manually-checked examples
(`URS00007E3A87`).

**Where it lives:** `data/folds.json` is git-tracked in this repo (confirmed byte-identical to
the live deployed copy before this fix) — patched in place, ready to commit directly, same as
the PR #4 pattern.

---

## Fix 2 — `openknot` dataset's own OpenKnot (pseudoknot) score (3,698 records)

**Root cause:** `build_dataset.py` hardcodes `"openknot": None` for every dataset it builds
(also correct for `pseudolabels`/`rfam_pdb130`/`rfam_pdb240`, which aren't OpenKnot designs —
but wrong for `openknot`, which is). Marwan's own manual check found a sample record's
`design_sequence` matching a row in `OpenKnotBench_data.v4.5.1.txt` with a real
`target_openknot_score`.

**Fix, and a correction made mid-implementation:** first drafted as a normalized-`design_sequence`
+ best-signal-to-noise join (matching `build_openknot_long.py`'s own `load_okb()` pattern) — but
investigating one fresh-verification mismatch found a **real sequence collision** in
OpenKnotBench: `W02_35A_5pad6_libraryready` and `W02_13200432_..._libraryready` share an
identical `design_sequence` but have legitimately different `target_openknot_score` values
(80.91 vs 90.53) — the best-SN tiebreak happened to pick the right row for this one case, but
that's luck, not a guarantee. Checked whether a safer join exists: **the atlas's own `id` is
already identical to OpenKnotBench's own `id` column for all 3,698 records** — switched to an
exact `id == id` join, which sidesteps the sequence-collision ambiguity entirely.

**Result:** 3,698/3,698 (100%) matched, zero ambiguity. Isolation-checked: only the `openknot`
field changed. Fresh independent re-derivation (direct `id`-column lookup, separate script)
matched all sampled records exactly, including the collision case and Marwan's own manually
-checked example (`W02_13198268_5pad6_libraryready` → 86.5988).

**Where it lives:** `tmp_analysis/openknot_score_patched/` (hand-off — `openknot`'s `folds.json`
lives under gitignored `dist/`, not directly git-tracked like the base `ribo2` dataset).

---

## Fix 3 — `near_title` (`openknot_long`, `openknot_long_seq`, `ribo2-iq-curated-v2`; 51,824 records)

**Root cause:** both builders (`build_openknot_long.py`, `build_iq_curated.py`) initialize
`near_title` blank and never call the RCSB title-lookup helper (`pdb_titles()`, RCSB GraphQL,
cached at `.rcsb_titles.json`) that `merge_analysis.py` already uses for the other 4 datasets.

**Investigated (per `plan/DATA_AUDIT_REVIEW.md`'s open question) — where does `near` itself come
from, since it's 100% populated despite the same builders initializing it blank too:**
- `ribo2-iq-curated-v2`: resolved — `build_iq_curated.py`'s own `load_novelty()` reads
  `{SRC}/08_intersect/curated.tsv` (`best_v341_hit`/`tm1_max` columns) at build time, independent
  of `merge_analysis.py`. Confirmed by reading the code directly.
- `openknot_long`/`openknot_long_seq`: **still genuinely unresolved** — grepped every `.py` file
  in this repo for a `near`-assignment (only `merge_analysis.py` and `build_iq_curated.py` have
  one) and checked whether the shared `{LSF}/novelty/chunk_*.tsv` `merge_analysis.py` reads
  covers these ids (it doesn't — sampled ids are absent). So this dataset's `near` was filled by
  something entirely outside this checkout. **This does not block the fix below**: `near_title`
  is an RCSB lookup keyed purely by the PDB-id string already sitting in `near`, so it's correct
  regardless of that string's provenance — spot-checked that the `near` values are real,
  currently-valid RCSB entries (6WLJ, 8UYE, 1S9S, 8UYK, ...).

**Fix:** new `enrich_near_title.py`, reusing the exact `pdb_titles()` mechanism and the same
shared `.rcsb_titles.json` cache `merge_analysis.py` already populates (so previously-cached
lookups from the other 4 datasets are free; only new PDB ids get a fresh RCSB GraphQL call).

**Result:** `openknot_long` 4,600/4,600, `openknot_long_seq` 4,593/4,593,
`ribo2-iq-curated-v2` 42,428/42,631 (99.5%). The 203 unfilled `ribo2-iq-curated-v2` records all
share just 3 distinct `near` values (`8ukb_C.pdb:C`, `9azc_V.pdb:V`, `8uik_C.pdb:C`) — confirmed
via a direct fresh RCSB query that none of these 3 PDB ids currently resolve at RCSB (empty
result), so leaving them blank is correct, not a bug. Isolation-checked over all 3 datasets: only
`near_title` changed. Independently re-verified: 7 sampled `near_title` values, across all 3
datasets, cross-checked against a **fresh, uncached** direct RCSB GraphQL query — 7/7 exact
matches.

**Where it lives:** `tmp_analysis/near_title_patched/` (hand-off, same reason as Fix 2).
`.rcsb_titles.json` (repo root) was updated in place — it's git-tracked (shared cache used by
`merge_analysis.py` too), so this update **is** committed directly, unlike the two dataset
hand-offs above.

---

## Not investigated further (out of scope for this pass)

- **Section 2's `openknot_long` blank `name` field** (checklist Section C) — likely a genuine
  source-data limitation (`eterna_title` blank at the OpenKnotBench source itself), not something
  fixable from this repo; not independently re-derived.
- **Marwan's own audit-tooling categorization gap** (`plan/DATA_AUDIT_REVIEW.md` Section 3 —
  `near_title` and the other 4 `SUSPICIOUS_DATASET_GAP`-category findings don't show up in his
  `summary_by_field.csv`/`suspicious_records.csv`) — this is feedback on his own audit script,
  not this repo; should go back to him directly rather than being "fixed" here.

## Files changed

| File | Change |
|---|---|
| `enrich_fgh_metadata.py` | Fix 1 — added per-letter global-index offset |
| `enrich_openknot_score.py` | new — Fix 2 |
| `enrich_near_title.py` | new — Fix 3 |
| `data/folds.json` | Fix 1, patched in place (git-tracked base `ribo2` dataset) |
| `.rcsb_titles.json` | Fix 3, cache updated in place (git-tracked, shared with `merge_analysis.py`) |

## Verification methodology (same bar as `plan/REACTIVITY_FIXES.md`)

1. Measure the real deployed data first — never trusted the checklist's claim of "0%" without
   re-checking it live (all three were still live bugs as of this check).
2. Isolation diff: full-record scan confirming only the intended field(s) changed.
3. Fresh independent re-derivation with separate code (not reusing the fix script), including at
   least one direct network/parquet round-trip bypassing any cache, for every fix.
4. For Fix 2, a fresh-verification mismatch surfaced a real data quirk (OpenKnotBench sequence
   collisions) that changed the join strategy mid-implementation — not swept under the rug.

## Not yet done

- Not committed, not pushed, no PR opened — pending review, same as the reactivity-fixes pass.
- `tmp_analysis/openknot_score_patched/` and `tmp_analysis/near_title_patched/` still need to be
  applied to the live `dist/` and redeployed by whoever holds `atlas-deployer` credentials.
