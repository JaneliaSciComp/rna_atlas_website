// Selectable atlases. base "" = repo root (Ribonanza-2 curated); others under datasets/<id>/.
// react/motifs flags say whether that dataset ships per-fold reactivity + motif spans.
// cond = how each fold's structure was CONDITIONED at prediction time (drives the
//   "Conditioning" filter): 'msa' (MSA), 'tbm' (template-based modeling), 'chemmap'
//   (SHAPE/chemical-mapping-guided). [] = sequence-only (unconditioned). "exp" = an
//   experimental PDB structure, not a prediction. A per-fold `conditioning`/`cond` field
//   in folds.json overrides this dataset default.
// parent = this dataset is a COMPANION of another source (not its own source-menu row).
//   It shares the parent's source checkbox; its `letters` are shown in the per-letter filter
//   and its data loads lazily the first time one of those letters is enabled. Per-fold
//   struct/react/pairing still dispatch via `_dsid`, so the companion keeps its own base/ext.
window.DATASETS = [
  { id: "ribo2", label: "Ribonanza-2 curated · A–Q (34,931)", base: "", ext: "cif", react: true, motifs: true, cond: [] },
  { id: "pseudolabels", label: "Ribo-1 pseudolabel (19,759)", base: "data/datasets/pseudolabels", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot", label: "OpenKnot (3,698)", base: "data/datasets/openknot", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_long", label: "OpenKnot OK7b/OK8 240-mer · SHAPE-guided (4,600)", base: "data/datasets/openknot_long", ext: "pdb", react: true, motifs: true, cond: ["chemmap"] },
  { id: "openknot_long_seq", label: "OpenKnot OK7b/OK8 240-mer · sequence-only (4,593)", base: "data/datasets/openknot_long_seq", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_cryoem_seq", label: "OK8 cryo-EM candidates · sequence-only (28)", base: "data/datasets/openknot_cryoem_seq", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_cryoem_msa", label: "OK8 cryo-EM candidates · MSA-conditioned (28)", base: "data/datasets/openknot_cryoem_msa", ext: "pdb", react: true, motifs: true, cond: ["msa"] },
  // Ribonanza-2 I-Q curated (M5 rnaonly, chemmap head) — COMPANION of ribo2 (letters I–Q).
  // Reactivity is chemmap PSEUDOLABELS (exp_reactivity_*, the inference-time conditioning),
  // NOT measured SHAPE/DMS. 1,330 folds (I-M) are sequence-only (no npz); N-O-P-Q (25,844)
  // carry dms+a23. motifs:true so pairing.json (SS view) loads; motifs.json is empty.
  // Loads lazily when an I–Q letter is enabled under the "Ribonanza-2 curated" source.
  { id: "ribo2-iq-curated", label: "Ribonanza-2 curated I–Q (chemmap pseudolabel, 27,174)", base: "data/datasets/ribo2-iq-curated", ext: "pdb", react: true, motifs: true, cond: ["chemmap"],
    parent: "ribo2", letters: ["I", "J", "K", "L", "M", "N", "O", "P", "Q"] },
  { id: "rfam_pdb130", label: "RFAM-PDB 130 (1,614)", base: "data/datasets/rfam_pdb130", ext: "pdb", react: true, motifs: true, cond: ["exp"] },
  { id: "rfam_pdb240", label: "RFAM-PDB 240 (2)", base: "data/datasets/rfam_pdb240", ext: "pdb", react: true, motifs: true, cond: ["exp"] },
];
