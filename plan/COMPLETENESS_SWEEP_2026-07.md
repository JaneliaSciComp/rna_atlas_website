# Field-completeness sweep of the deployed data (2026-07)

A follow-up sweep of the *deployed* tree (`/groups/das/home/zouinkhim/atlas_explorer`, = live)
looking for the "field is computed in some datasets but left null in others where the source data
supports it" class of bug — the same shape as the pseudolabels/openknot SHAPE-field fixes. Two
scripts (kept in `tmp_analysis/`, gitignored): `audit_reactivity_completeness.py` (per-dataset
reactivity/SHAPE coverage) and `field_completeness_matrix.py` (every folds.json field × every
dataset).

Most cross-dataset gaps are legitimate N/A (e.g. `letter` only applies to ribo2/I-Q; `name` is
blank for the hash-id `pseudolabels`; `motifs`/`clashscore` intentionally not run for some add-ons
per their builders). The genuine omissions found:

## 1. SHAPE-agreement fields null on 4 datasets that have real reactivity — FIXED (data hand-off)

`openknot_long` (4,600), `openknot_long_seq` (4,593), `openknot_cryoem_seq` (28),
`openknot_cryoem_msa` (28) all ship real DMS+2A3 + a `pairing.json` dot-bracket, but their
`r2a3`/`shape_agr`/`shape_ok` were never computed — so the SHAPE column reads "no" for every one
of these 9,249 records despite the data being present. This is exactly the gap that was already
fixed for `pseudolabels` and `openknot`; these four just never had the recompute run.

Fixed by running the existing, unchanged `enrich_pseudolabels_shape.py` against each. Patched
`folds.json` (only `r2a3`/`shape_agr`/`shape_ok` change — isolation-verified, id-sets equal) are
in `tmp_analysis/shape_fields_patched/<name>/data/folds.json`, ready to drop into `dist/` and
redeploy:

| dataset | shape_ok=1 after | mean r2a3 |
|---|---|---|
| openknot_long | 1,812 / 4,600 | −0.12 |
| openknot_long_seq | 1,786 / 4,593 | −0.12 |
| openknot_cryoem_seq | 26 / 28 | −0.40 |
| openknot_cryoem_msa | 24 / 28 | −0.40 |

To keep it from regressing, the `enrich_pseudolabels_shape.py` step is now written into
`build_openknot_long.py` and `build_cryoem.py`'s "Then run:" docstring chains (this PR).

## 2. cryo-EM datasets are under-enriched — FLAGGED for Marwan (his build pipeline)

`openknot_cryoem_seq`/`openknot_cryoem_msa` (28 each) are missing several derived fields even
though the inputs exist. Their `pairing.json` has real dot-brackets (with pseudoknots), yet in
`folds.json`:
- `bp_fraction` = null, `pseudoknot` = 0, `ss_class` = "" for all 56 → `derive_ss.py` output was
  never merged into folds.json.
- `ex`/`ey` absent from the schema entirely → `compute_embedding.py` never run → these records
  won't appear on the Map view.
- `is_novel_v341` = null, `best_tm1`/`near`/`near_title` = null → the novelty (USalign) step never
  ran; these are novel designs, so `is_novel_v341` should presumably be 1.

Recommended: run `derive_ss.py --name openknot_cryoem_seq` (and `_msa`), then
`enrich_pseudolabels_shape.py`, then `compute_embedding.py --name` for both — i.e. the full
"Then run:" chain now documented in `build_cryoem.py`. The novelty fields need the USalign step if
those cryo-EM candidates are meant to carry a novelty score. Not patched here since these are
build-pipeline steps best run in the build env with the real config paths (only 56 records, tiny).

## 3. Stale label count on the Source menu — FIXED (this PR)

The base ribo2 Source row read `Ribonanza-2 curated · A–Q (34,931)`. That count is stale:
`34,931 = 7,757 (A–H) + 27,174 (old padded I–Q)`. The I–Q companion (`ribo2-iq-curated-v2`) was
replaced by the de-padded union (42,631), so the correct combined count is
`7,757 + 42,631 = 50,388`. Fixed the label in `web/datasets.js`. (This is a companion-merged row:
one checkbox covers the A–H base + the I–Q companion; only the displayed number was wrong, dispatch
was fine.) All other Source-menu counts were verified against real record counts and are correct.

## Files changed (this PR)

| File | Change |
|---|---|
| `web/datasets.js` | ribo2 Source label count 34,931 → 50,388 |
| `build_openknot_long.py` | docstring — add the `enrich_pseudolabels_shape.py` step |
| `build_cryoem.py` | docstring — full post-build chain (react + derive_ss + shape + embedding) |
| `plan/COMPLETENESS_SWEEP_2026-07.md` | this doc |

## Not in this PR (data hand-off / Marwan's pipeline)

- Apply `tmp_analysis/shape_fields_patched/*` to `dist/` and redeploy (item 1).
- Re-run the cryo-EM build chain to fill `bp_fraction`/`pseudoknot`/`ss_class`/`ex`/`ey`/novelty
  (item 2).
