# Fold attribute reference

Every record in `data/folds.json` (A–H) and `dist/datasets/<name>/data/folds.json`
(add-on datasets, e.g. `ribo2-iq-curated-v2` for I–Q) describes one predicted RNA
fold. This is the field-by-field reference for what each attribute means.

Not every record has every field — I–Q and A–H diverge slightly, and some fields
are dataset-specific (noted inline). Some fields are pass-throughs from external
pipelines whose exact formulas aren't documented in this repo; those are flagged.

## Identity / provenance

| Field | Meaning |
|---|---|
| `id` | Unique fold ID (e.g. `12345-ribonanza2a`). |
| `key` | Filesystem-safe hashed version of `id`, used to name `structs/<key>.pdb`, `react/<key>.json`, etc. |
| `name` | Human-readable display name. |
| `letter` | Library letter A–Q. A–E = synthetic designs (gRNAde, UW, RNAMake); F–H = natural RNAs from RNAcentral; I–Q = newer curated batch (natural + designed windows). |
| `source` | Free-text dataset/source label. |
| `source_group` *(I–Q only)* | Coarse biological-origin bucket: human / non-human vertebrate / bacteria / archaea / virus / eukaryote. |
| `sublibrary` | Raw origin category string (e.g. `tRNA_human`, `gRNAde_Designs`, `virus_first_two_thirds`). |
| `rna_type` | Controlled-vocabulary molecule type (tRNA, rRNA, mRNA, …). |
| `length` | Design-region length in nt (for I–Q this is the folded/padded model length — see `true_design_length`). |
| `design_start` / `design_end` *(I–Q only)* | 1-based coordinates of the true design region within the padded construct. |
| `true_design_length` *(I–Q only)* | Actual (unpadded) design length before 5′ padding for folding. |

## Confidence / model quality

| Field | Meaning |
|---|---|
| `plddt` | pLDDT model confidence, 0–100 (higher = more confident). |
| `ptm` *(I–Q only)* | Predicted TM-score, a global confidence metric. |
| `gpde` | Folding-pipeline error/confidence metric (lower = better). Acronym not spelled out in-repo. |
| `clashscore` | Steric clashes per 1000 atoms (Phenix); lower = cleaner geometry. |

## Novelty / similarity to known structures

| Field | Meaning |
|---|---|
| `best_tm1` | USalign TM1 score to the closest known PDB-RNA chain (v341 set). Lower = more novel. |
| `near` | ID/label of the closest known PDB chain. |
| `near_title` | RCSB entry title for `near`. |
| `is_novel_v341` | Boolean: novel vs. the v341 PDB training set. |
| `overlap_ae` | TM1 to the closest A–E fold (structural redundancy vs. synthetic set); lower = more distinct. |
| `overlap_global_fold_id` | ID of the nearest A–E structural fold cluster. |
| `struct_rep` | Boolean: this record is the chosen structural representative. |
| `score` | Numeric ranking value from an external shortlist pipeline (`build_shortlist.py`, not in this repo — formula undocumented). |
| `in_shortlist` | Boolean shortlist flag from the same external pipeline. |

## Secondary structure

| Field | Meaning |
|---|---|
| `bp_fraction` | Fraction of positions paired in the predicted secondary structure (canonical WC/wobble only). |
| `pseudoknot` | 1 if the secondary structure contains crossed base pairs. |
| `ss_class` | Topology bucket: unpaired / hairpin / two-helix / multiloop (3+ helices) / pseudoknot. |
| `termini_bp` | 1 if the 5′/3′ ends base-pair to each other. |
| `termini_trim` | 1 if the first-paired and last-paired bases pair to each other (superset of `termini_bp`). |
| `overhang5` / `overhang3` | Length (nt) of the trimmable single-stranded 5′/3′ overhang when `termini_trim` is true. |
| `uucg_tetraloop` | 1 if the fold contains a UUCG tetraloop. |

## Tertiary structure / complexity

| Field | Meaning |
|---|---|
| `contact_ratio` | C1′–C1′ contact ratio (nucleotide pairs within 8 Å, sequence separation ≥6) divided by length — a compactness/globularity proxy. |
| `crossed_frac` | Fraction of residues in a "crossed" 3D-contact pair (tertiary-structure pinning, a continuous 3D generalization of `pseudoknot`). |
| `n_crossed_pairs` | Raw count of crossed contact pairs underlying `crossed_frac`. |
| `mohca_regime_frac` | Fraction of predicted 3D contacts in MOHCA-seq's most informative range (25–50 nt separation). |

## Motifs

| Field | Meaning |
|---|---|
| `motifs` | Sorted list of distinct tertiary motif types detected (A-minor, TL-receptor, T-loop, U-turn, platform, …). |
| `n_tert` | Count of distinct tertiary-motif types (restricted TERT set). |
| `n_rare` | Count of distinct rare tertiary-motif types (restricted rare set). |

## SHAPE / chemical mapping (2A3 / DMS)

| Field | Meaning |
|---|---|
| `r2a3` | Pearson correlation of predicted pairing vs. 2A3 reactivity. |
| `shape_agr` | SHAPE–pairing agreement (sign-flipped `r2a3`); positive = chemical mapping supports the predicted fold. |
| `mean_prot_2a3` | Mean 2A3 protection signal (inverse reactivity) averaged over tertiary-motif residues. |
| `shape_ok` | Boolean "SHAPE-supported" flag (protected motif residues OR reactivity agrees with predicted pairing); UI also shows "n/d" when no usable signal exists. |
| `openknot` | OpenKnot pseudoknot/structure score (external scoring, not documented in this repo). |
| `pred_pearson_2a3` / `pred_pearson_dms` / `pred_spearman_2a3` / `pred_spearman_dms` *(I–Q, mainly N–Q)* | Correlation between predicted reactivity and the chemmap pseudolabel it was conditioned on ("prediction fidelity"). |

## Clustering

| Field | Meaning |
|---|---|
| `global_fold_id` | ID of the structural-fold cluster this representative belongs to. |
| `fold_size` | Number of entries that adopt this structural fold (cluster member count). |
| `global_seq_cluster_id` | ID of the sequence-cluster this representative belongs to. |
| `seq_cluster_size` | Number of entries in the representative's sequence cluster. |

## Embedding (map view)

| Field | Meaning |
|---|---|
| `ex`, `ey` | 2D t-SNE coordinates (normalized 0–1), computed over standardized numeric features + one-hot motif encoding. |

## RNAcentral / Rfam annotation (mainly F–H)

| Field | Meaning |
|---|---|
| `rnacentral_id` | RNAcentral `URS_taxid` identifier. |
| `rnacentral_name` | RNAcentral description string for that URS. |
| `member_dbs` | List of RNAcentral source databases containing this sequence. |
| `rfam_id` | Rfam family accession (e.g. `RF00050`). |
| `rfam_name` | Rfam family full name. |

## Undocumented / external

A few fields are pass-throughs from pipelines outside this repo, so their exact
definitions aren't available here:

- `gpde`, `ptm` — spelled out nowhere in-repo beyond "confidence/error metric, paired with pLDDT."
- `score`, `in_shortlist` — from an external `summary/shortlist.tsv` / `build_shortlist.py`.
- `openknot` — OpenKnot score computed by the external OpenKnotBench pipeline.
