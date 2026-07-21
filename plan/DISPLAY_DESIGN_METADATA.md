# Surface existing-but-hidden metadata in the deep view (2026-07)

Every website dataset is a subset of an entry in the master "Individual Datasets" inventory
(Notion). Cross-referencing that inventory against what each `folds.json` actually carries turned
up rich per-record metadata that already exists on disk but was never surfaced. This adds three
kinds, all **display-only** (no reactivity/structure/scoring fields touched).

## What was added

### 1. OpenKnot design provenance — `openknot`, `openknot_long`, `openknot_long_seq`, `openknot_cryoem_seq`, `openknot_cryoem_msa`
`enrich_openknot_meta.py`. The source metadata has 40+ columns; we only used `openknot_score`.
Now also: **designer**, **design method** (Eterna / gRNAde / codesign-RFdiff / …), **round/puzzle**
(W02·round 1, OK7b, OK8, …), **design title**, **organism** (for natural-genome designs), and
**empirical read depth** (DMS / 2A3).

Two sources, join keys empirically validated (see `tmp_analysis/probe_join*`):
- `openknot` (3,698) → `OpenKnotBench_data.v4.5.1.txt`, joined by `id`==OKB `id` (exact, 100%).
- the four OK7b/OK8/cryo-EM sets → `ok7ab8_metadata_combined.parquet`, joined by normalized
  `design_sequence` (best SNR row — the *same* row the reactivity was pulled from, so the metadata
  is consistent with the displayed reactivity). ~99.6% unique; cryo-EM 28/28.

All 5 datasets: 100% of records matched.

### 2. RFAM family labels — `rfam_pdb130` (1,614), `rfam_pdb240` (2)
`enrich_rfam_pdb_meta.py`. Every id embeds the Rfam accession + family name (e.g.
`RF00356:Small_nucleolar_RNA_R32_R81_Z41:…`) but `rfam_id`/`rfam_name` were null. Parsed them out
(handles both the colon form of 130 and the underscore form of 240). Setting `rfam_id` lights up
the deep view's **existing** "Rfam family" row + rfam.org link (already wired for ribo2) — zero
frontend work for that part. 100% of records now labelled.

Deliberately NOT added: the PDB-RFAM metadata parquet's `reads` column is the fld-pipeline
*predicted* coverage (a design-time estimate, per its README), not empirical sequencing depth, so
surfacing it as "read depth" would mislead. These datasets already carry real empirical SNR in
their `react/<key>.json` `sn`.

### 3. Deep-view display (`web/app.js`, `drawProps`)
New rows, each shown only when populated: **Design** (round · by designer · via method),
**Design name**, **Organism (design source)**, **Read depth (DMS / 2A3)**. The Rfam-family row was
already present and now fires for the RFAM-PDB datasets.

## Files

| File | Change |
|---|---|
| `enrich_openknot_meta.py` | new — OpenKnot design provenance + read depth |
| `enrich_rfam_pdb_meta.py` | new — RFAM family labels |
| `web/app.js` | `drawProps`: 4 new conditional metadata rows |

Patched `folds.json` (isolation-verified — only the new additive fields change, id-sets equal, 0
disallowed changes across all 7 datasets) are the data hand-off in `tmp_analysis/meta_patched/`.

## Not yet done
- Data hand-off (`tmp_analysis/meta_patched/*`) still needs to be applied to `dist/` + redeployed.
- `app.js` change ships with the next web-shell deploy.
