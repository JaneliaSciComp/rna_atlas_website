# RNA Atlas Explorer

Interactive, configurable web explorer over the Ribonanza-2 A–H prediction-atlas mining
results. Replaces the static PowerPoint decks (`per_letter_top10_novel.pptx`, etc.) — you tune
the selection arguments live (length, novelty, SHAPE support, motifs, pseudoknot, source,
per-letter top-N) and the candidate list + per-fold deep view update instantly. Built for picking
**high-value cryo-EM targets**.

## Status

- **v1 (this):** curated set of **7,757** folds (already fully mined: motifs + SHAPE + sparse
  novelty). Filtering/ranking is 100% client-side; structures + reactivity load lazily per fold.
- **v2 (planned):** scale to the **414,633** high-confidence strict index via the precompute
  pipeline (motifs + SHAPE cheap; USalign novelty ~1–2 days on LSF). See plan.

## Run it

```bash
eval "$(mamba shell hook --shell bash)"; mamba activate rna   # needs h5py + pyarrow + gemmi + numpy
cd /groups/das/home/zouinkhim/atlas_explorer
python serve.py --port 8765          # then open http://<host>:8765/
```

A tiny static server is required (browsers can't fetch the local structure/reactivity files over
`file://`). It only serves bytes — all filtering happens in the browser.

## Layout

```
config.json              # machine-specific absolute base paths — GITIGNORED, copy from config.example.json
build_feature_table.py   # assembles data/*.json from the mined TSVs (run once / on update)
serve.py                 # static server + lazy /struct/<id> and /react/<id> endpoints
web/                     # index.html, app.js, style.css, viz_style.js (palette port), lib/3Dmol-min.js
data/                    # folds.json (table), motifs.json (deep-view spans) — no absolute paths
```

### config.json (not committed)

All absolute paths (`/groups/...`) live in `config.json` so nothing internal is committed or served
to the browser. Copy `config.example.json` → `config.json` and fill in `mined_dir`, the two
`struct_bases` (A-E / F-H curated CIF dirs), `metadata_parquet`, `react_override`, and the per-letter
`hdf5` map. `serve.py` builds each structure path as `struct_bases[AE|FGH]/<seq_id>.cif` at request
time; `data/` only ever holds scalar features + motif spans.

## Data provenance (curated 7,757)

Built from `lsf/20260612_rna_motif_chaitanya/`:
- `selection.tsv` — id, design_sequence, **cif path**, pLDDT, gpde, sublibrary, letter
- `fold_metadata.tsv` — length, source, pseudoknot, r_2a3_ispaired, openknot, overlap_ae_tm1, …
- `summary/motifs_labeled.tsv` — per-motif type + residue spans
- `summary/motifs_shape_gated_AH.tsv` — per-motif 2A3 protection (all A–H) → `shape_ok`/`mean_prot_2a3`
- `summary/{per_letter_candidates,top10_novelty_v341,top10b_novelty_v341,pk_candidates}.tsv` —
  continuous `best_tm1` vs v341 (only ~105 folds scored; the rest get `best_tm1 = null` until v2)
- name TSVs — human-readable names

Reactivity is read on demand: A–E from the cmuts HDF5 (`r_norm`, sliced by `sub_start`), F–H from
the design-aligned `react_override_fgh40.parquet` (only the len>40 coverage subset exists). F–H
sequences are derived from the CIF (they are empty in `selection.tsv`).

## Configurable arguments

Length, pLDDT, clashscore, novelty (`best_tm1` ≤, only-scored toggle, overlap-vs-AE),
SHAPE support (require `shape_ok`, `r(2A3)` ≤), motifs (require tertiary / rare / specific types),
pseudoknot, source/letter, ranking key + top-N (overall or **per letter**).

## Verification

`build_feature_table.py` output reproduces the per-letter deck exactly: with **has-best_tm1 +
length>40 + rank best_tm1 ascending + top-10 per letter**, the explorer yields the same 80 seq_ids
as `summary/per_letter_candidates.tsv` (checked 80/80).

Note: the deck's "SHAPE-supported" label was generous — several per-letter picks have **negative**
2A3 protection (motif residues *more* reactive). The explorer exposes the real `mean_prot_2a3` and
a strict protection-based `shape_ok`, so a genuine SHAPE gate is now possible (it is *not* applied
by default, to match the deck's pool).

## Rebuild the table

```bash
python build_feature_table.py            # -> data/folds.json, motifs.json, paths.json
```
