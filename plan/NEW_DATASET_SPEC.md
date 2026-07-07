# Adding a new source dataset to the atlas — data delivery spec

Hand this to the agent/person producing the new dataset. The cleanest hand-off is **raw
predictions + a manifest**; the atlas side then runs the builders
(`build_dataset.py → derive_ss.py → compute_embedding.py → build_react.py`), registers the
dataset in `web/datasets.js`, and deploys.

> Output layout produced by the pipeline (for reference):
> `dist/datasets/<id>/data/folds.json` · `…/data/pairing.json` · `…/data/motifs.json` ·
> `…/structs/<key>.pdb|cif(.gz)` · `…/react/<key>.json`

---

## 0. Dataset identity (state these)
- **`id`** — short kebab-case slug (e.g. `mynewset`) — folder + registry key.
- **`label`** — human name incl. count, e.g. `"My New Set (12,345)"`.
- **`cond`** — how structures were conditioned at prediction time (drives a UI tag):
  `none` (single-sequence), `msa`, `chemmap`, or `exp` (experimental / real PDB, not predicted).
  May be a list if mixed.
- **Total fold count.**

---

## 1. Manifest — REQUIRED
A **TSV with a header, one row per fold** (a Parquet is also fine — just give the column names).
Columns the builder reads directly:

| Column | Req? | Meaning |
|---|---|---|
| `seq_id` | **required** | unique id per fold → becomes `id` (`key` = sanitized for filenames) |
| `pdb_off_relaxed` | **required** | **absolute path** to that fold's structure file (one per fold) |
| `design_sequence` | strongly wanted | the RNA sequence (A/C/G/U) — powers the sequence track + reactivity join |
| `length` | wanted | sequence length (nt) |
| `mean_plddt_on` / `mean_plddt_off` | wanted | pLDDT confidence 0–100 (provide whichever exists) |
| `mean_ptm_on` / `mean_ptm_off` | optional | pTM |
| `mean_gpde_on` / `mean_gpde_off` | optional | gpde |
| `seq_cluster_size` | optional | sequence-cluster member count |
| `struct_is_representative` | optional | `1` / `0` |

(`on` / `off` = with / without conditioning.)

---

## 2. Structure files — REQUIRED
- **One file per fold**, at the `pdb_off_relaxed` paths in the manifest.
- Format: **relaxed single-model PDB** (gzipped is fine) **or** mmCIF.
- Absolute paths on `/groups` or `/nrs`. Keyed consistently with `seq_id`.

---

## 3. Reactivity — OPTIONAL (only if experimental chemmap exists)
Either:
- the atlas format directly, per fold: `{seq, dms:[...], a23:[...], sn:[dms_sn, a23_sn]}`, **or**
- a Parquet keyed by `design_sequence` with columns `reactivity` (array), `signal_to_noise`,
  `sub_start`, `design_length` (OpenKnotBench-style) so it can be sliced to the design region.

---

## 4. Novelty — OPTIONAL
- A TSV whose **first column is the `seq_id`** of folds that are novel vs the v341 references
  (flags `is_novel_v341`).
- Better still: per-fold `best_tm1` + nearest-reference `near` (+ `near_title`) — these get wired in.

---

## 5. Motifs / metadata — OPTIONAL
- Motifs (from `rna_motif` / `get_rna_motifs`): per fold `[[motif_type, [residues]], …]`
  — otherwise they can be computed from the structures.
- Any RNAcentral / Rfam ids + names, `rna_type`, `member_dbs`.

---

## Derived on the atlas side (do NOT provide)
- Secondary structure — `bp_fraction`, `pseudoknot`, `ss_class`, termini / UUCG flags,
  dot-bracket (`pairing.json`) — from the 3D (`derive_ss.py`).
- The **2D map** coordinates (`ex`, `ey`) — computed (`compute_embedding.py`).
- **C1′ compactness** (`contact_ratio`) — from the 3D.

---

## Minimum viable delivery
If only the essentials are available: **a manifest TSV with `seq_id`, `pdb_off_relaxed`,
`design_sequence`, `length`, `plddt` + the per-fold structure files.** Everything else is optional
enrichment that can be computed or skipped.

---

## Logistics
- Provide **absolute paths** (manifest-driven) — no recursive scanning of `/groups` or `/nrs` needed.
- The atlas is a static, client-side app; an add-on up to ~tens-of-thousands of folds is fine.
  Much larger (≫10⁵) needs the separate scaling design in `plan/SCALING_TO_23M.md`.

---

## Registry entry (added on the atlas side after building)
One line in `web/datasets.js`:
```js
{ id: "<id>", label: "<label>", base: "data/datasets/<id>", ext: "pdb"|"cif",
  react: true|false, motifs: true|false, cond: ["none"|"msa"|"chemmap"|"exp"] }
```
