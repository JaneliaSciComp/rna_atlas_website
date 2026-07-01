// Selectable atlases. base "" = repo root (Ribonanza-2 curated); others under datasets/<id>/.
// react/motifs flags say whether that dataset ships per-fold reactivity + motif spans.
// cond = how each fold's structure was CONDITIONED at prediction time (drives the
//   "Conditioning" filter): 'msa' (MSA), 'tbm' (template-based modeling), 'chemmap'
//   (SHAPE/chemical-mapping-guided). [] = sequence-only (unconditioned). "exp" = an
//   experimental PDB structure, not a prediction. A per-fold `conditioning`/`cond` field
//   in folds.json overrides this dataset default.
window.DATASETS = [
  { id: "ribo2", label: "Ribonanza-2 curated (7,757)", base: "", ext: "cif", react: true, motifs: true, cond: [] },
  { id: "pseudolabels", label: "Ribo-1 pseudolabel (19,759)", base: "data/datasets/pseudolabels", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot", label: "OpenKnot (3,698)", base: "data/datasets/openknot", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_long", label: "OpenKnot OK7b/OK8 240-mer · SHAPE-guided (4,600)", base: "data/datasets/openknot_long", ext: "pdb", react: true, motifs: true, cond: ["chemmap"] },
  { id: "openknot_long_seq", label: "OpenKnot OK7b/OK8 240-mer · sequence-only (4,593)", base: "data/datasets/openknot_long_seq", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_cryoem_seq", label: "OK8 cryo-EM candidates · sequence-only (28)", base: "data/datasets/openknot_cryoem_seq", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_cryoem_msa", label: "OK8 cryo-EM candidates · MSA-conditioned (28)", base: "data/datasets/openknot_cryoem_msa", ext: "pdb", react: true, motifs: true, cond: ["msa"] },
  { id: "rfam_pdb130", label: "RFAM-PDB 130 (1,614)", base: "data/datasets/rfam_pdb130", ext: "pdb", react: true, motifs: true, cond: ["exp"] },
  { id: "rfam_pdb240", label: "RFAM-PDB 240 (2)", base: "data/datasets/rfam_pdb240", ext: "pdb", react: true, motifs: true, cond: ["exp"] },
];
