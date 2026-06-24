# CLAUDE.md — RNA Atlas Explorer

Orientation for Claude/dev sessions in this repo. The explorer is a **static, client-side**
web app over the Ribonanza-2 (+ add-on) RNA prediction atlases: filter/rank folds, an embedding
**map**, per-fold 3D + tracks + secondary structure, an in-page **Claude assistant**, and a
(scaffolded) **/inference** page. Hosted on S3 + CloudFront, passcode-gated.

- **Repo / remote:** `github.com/mzouink/rib2_atlas_explorer` (this dir: `/groups/das/home/zouinkhim/atlas_explorer`).
- **Live:** `https://rna-atlas.org` (and the CloudFront domain). Secrets/IDs (passcode, distribution/OAC, deployer IAM, domain/cert, shared Claude key location) are in **`DEPLOYED.local.md`** (gitignored) — never commit those.

## Architecture

- **Static site** in `web/` — no backend. Filtering/ranking is 100% client-side over precomputed JSON.
- **Hosting:** one S3 bucket `s3://rnanix/atlas_explorer` behind CloudFront (`E2CV6KWMNI7AQP`).
- **Passcode gate + folder-index** is a CloudFront **viewer-request function** `atlas-explorer-gate`:
  gates `/data/ /structs/ /react/` (403 without `?t=<passcode>`), 301-redirects extensionless paths
  to add a trailing slash, and rewrites `/dir/` → `/dir/index.html`. Editing it needs an **admin**
  token (the `atlas-deployer` IAM cannot touch CloudFront/Route53).
- **Two-tier deploy:** `dev/` prefix for staging (reuses prod data via `DATA_BASE=".."`), root for prod.

## Deploy (`deploy.sh`, uses the non-expiring `atlas-deployer` profile)

```
./deploy.sh dev        # web shell -> dev/  + invalidate /dev/*   (test at .../dev/)
./deploy.sh promote    # server-side copy the tested dev/ shell -> root  (ship exact bytes)
./deploy.sh            # web shell + data jsons -> root (prod)
./deploy.sh full       # prod + re-sync structs/ + react/ + datasets/ from dist/
```

- Workflow: **edit → `./deploy.sh dev` → verify at `/dev/` → `./deploy.sh promote`.**
- **ALWAYS `node --check web/<file>.js` before deploying.** A duplicate `const` once broke all of
  `agent.js` silently; brace-counting misses it (and gives false positives on `{`/`}` inside strings).
  `node` is at `/usr/bin/node`.
- `config.js` is generated per-target by deploy (never upload `web/config.js`): sets `DATA_BASE`,
  `GATED=true`, and injects `window.CLAUDE_KEY` from the gitignored **`.claude_key`** if present.
- `promote` must carry image assets + `lib/*` too (it does — keep the lists in sync if adding files).
- Data lives at root only; `dev/` shell reads it via `DATA_BASE=".."` (so deep sub-pages like
  `/inference` must keep relative-path assumptions in mind).
- After updating a data JSON at root, **invalidate that path** (`deploy.sh dev` only invalidates `/dev/*`).

## web/ layout

- `index.html` · `app.js` (main: filters, table, map, deep view, `AtlasAPI`) · `agent.js` (Claude
  assistant) · `style.css` · `viz_style.js` (palettes) · `datasets.js` (dataset registry) ·
  `config.js` (gen at deploy) · `lib/` (`3Dmol-min.js`, `three.min.js`, `OrbitControls.js`) ·
  favicon/logos (`icon.png` header, `logo_exp.png` gate, `claude.png` agent button) · `inference/`.

## Data model

- `data/folds.json` (ribo2) and `dist/datasets/<name>/data/folds.json` (add-ons): one record/fold —
  `id, key, name, letter, length, plddt, gpde, best_tm1, near, near_title, is_novel_v341, overlap_ae,
  shape_ok, shape_agr, r2a3, mean_prot_2a3, contact_ratio, bp_fraction, pseudoknot, ss_class,
  n_tert, n_rare, motifs[], fold_size, global_fold_id, seq_cluster_size, global_seq_cluster_id,
  rnacentral_id, rnacentral_name, rna_type, member_dbs[], rfam_id, rfam_name, ex, ey, …`.
- `…/data/motifs.json` = `{id: [[motif_type, residues], …]}` (deep-view spans / 3D sticks).
- `…/data/pairing.json` = `{id: dot-bracket}` (pairing track + arc/2D secondary structure).
- `…/react/<key>.json` = `{seq, dms[], a23[], sn:[dms_sn, a23_sn]}` (lazy per-fold reactivity).
  Keyed by sanitized `key` (ids can contain quotes, e.g. OpenKnot). ribo2 uses `react/<id>.json`.
- **Datasets** (`web/datasets.js`): `ribo2` (base "", cif, react+motifs) + `pseudolabels`,
  `openknot`, `rfam_pdb130`, `rfam_pdb240` (base `data/datasets/<id>`, pdb). Source menu MERGES
  checked datasets; per-row `_dsid` dispatches struct/ext/react/motifs in the deep view.

## Data builders (run in the `rna` conda env; absolute source paths in gitignored `config.json`)

- `build_dataset.py` — manifest atlas → `dist/datasets/<name>/{data/folds.json, structs/<key>.pdb(gz)}` (confidence + compactness + novelty flag).
- `build_react.py` — per-fold `react/<key>.json`: sequence (manifest `design_sequence`) for all; **OpenKnot 2A3** from OpenKnotBench (`design_sequence` join, sliced by sub_start).
- `build_pseudolabels_chemmap.py` — Ribo-1 pseudolabel **2A3 + DMS** from `ribonanza_pseudolabels_combined_quickstart.parquet` + `pseudolabels_combined_metadata.csv` (join by `sequence_id` = hash).
- `derive_ss.py` — clean 2D from 3D: **canonical WC/wobble pairs only** → `bp_fraction`, `pseudoknot`, `ss_class` (unpaired/hairpin/two-helix/multiloop/pseudoknot), dbn. Fixes the old "two-helix" mislabel + pseudoknot over-call. Run per dataset.
- `enrich_fgh_metadata.py` — ribo2 F-H RNAcentral/Rfam from the team's `ribo2_metadata_enhanced/Ribonanza2{F,G,H}.parquet` (URS, description→name, rna_type, member_dbs, RFAM acc, family name). Supersedes the old `enrich_rnacentral.py`/`enrich_rfam.py`.
- `enrich_clusters.py` — A-H cluster IDs + member-count sizes (`global_seq_cluster_id`, `global_fold_id`, `fold_size`, `seq_cluster_size`) from the AE_FGH handoff `annotation_manifest.parquet`.
- `compute_embedding.py` — per-fold 2D t-SNE (`ex`, `ey`) over standardized features + motif one-hot (sklearn; per dataset).
- `build_feature_table.py` (ribo2) / `build_static.py` (static export) / `serve.py` (local dev server).
- After regenerating a folds.json: upload to S3 + invalidate (`aws s3 cp …; create-invalidation`).

## Features

- **Filters** (`#config`): length, confidence, novelty (best_tm1 + novel flag + overlap), SHAPE, structure (compactness/paired), **clusters** (fold/seq-cluster size), **motifs with any/all match toggle**, topology, ranking, top-N, per-letter, display.
- **Show-more** pagination (`Show more (+N)` / `Show all`, "X of Y").
- **Map** view (Table/Map toggle): canvas scatter of the t-SNE embedding, color-by, zoom (clamped) / pan / double-click reset, hover, click→deep view, t-SNE axes.
- **Deep view**: 3D (3Dmol) with a **Color by** selector (2A3/DMS/pLDDT/pairing/nucleotide/spectrum) + motif sticks; sequence/DMS/2A3/pairing tracks; **secondary structure** (forna-style 2D default, arc-diagram toggle); RNAcentral/Rfam/cluster metadata; **Export** zip (cif+pdb+png+txt).
- **Claude assistant** (`agent.js`, ✦ logo button): drives `window.AtlasAPI` (filters/search/map/select) + analysis (get_results/field_stats) + charts (2D expand+PNG, interactive 3D three.js downloadable as HTML). Model selector, welcome+examples, live status, markdown tables, localStorage conversation cache. Key from `.claude_key` (gated config) or per-user localStorage.
- **/inference** (`web/inference/`): paste a sequence → staged **no-MSA draft → MSA-refined** result. **Front-end scaffold only**; set `window.INFER_API` and implement `POST /predict` + `GET /status` (see the adapter comment in `inference.js`).

## Gotchas

- `config.json`, `.claude_key`, `DEPLOYED.local.md`, `dist/` are **gitignored** — never commit.
- **≤30 nt F-H folds have all-NaN chemmap** in the source parquet (~52% of F-H, all the short
  miRNA/fragment designs) — empty reactivity there is faithful, not a bug.
- The shared Claude key ships in the (gated) client `config.js` and calls `api.anthropic.com`
  directly — set a spend limit; per-user-key mode is also supported.
- `node --check` every JS edit before deploy (see Deploy).
- No heavy recursive `find`/`du` over `/groups` or `/nrs` atlas trees — work manifest-driven.

## Open / TODO

- `/inference` backend: wire `INFER_API` to the AWS CASP inference pipeline (trigger + output S3 convention).
- Short-sequence (≤30 nt) chemmap: optional "no signal" note; confirm with the data team if a source exists.
- forna 2D falls back to the arc diagram for >900 nt RNAs (perf).
