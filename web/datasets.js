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
  { id: "ribo2", label: "Ribonanza-2 curated · A–Q (50,388)", base: "", ext: "cif", react: true, motifs: true, cond: [] },
  { id: "pseudolabels", label: "Ribo-1 pseudolabel (19,759)", base: "data/datasets/pseudolabels", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot", label: "OpenKnot (3,698)", base: "data/datasets/openknot", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_long", label: "OpenKnot OK7b/OK8 240-mer · SHAPE-guided (4,600)", base: "data/datasets/openknot_long", ext: "pdb", react: true, motifs: true, cond: ["chemmap"] },
  { id: "openknot_long_seq", label: "OpenKnot OK7b/OK8 240-mer · sequence-only (4,593)", base: "data/datasets/openknot_long_seq", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_cryoem_seq", label: "OK8 cryo-EM candidates · sequence-only (28)", base: "data/datasets/openknot_cryoem_seq", ext: "pdb", react: true, motifs: true, cond: [] },
  { id: "openknot_cryoem_msa", label: "OK8 cryo-EM candidates · MSA-conditioned (28)", base: "data/datasets/openknot_cryoem_msa", ext: "pdb", react: true, motifs: true, cond: ["msa"] },
  // Ribonanza-2 I-Q curated v2 — the DE-PADDED UNION (M5 rnaonly, chemmap head). Supersedes the
  // original padded ribo2-iq-curated (27,174) AND the tRNA showcase: short natural RNAs were refolded
  // on their true (unpadded) design_sequence, rescuing tRNAs/rRNA/RefSeq/MANE that the padded run lost.
  // 42,631 curated (novel ∩ interesting-SS), OpenMM-relaxed, full 11-stage curation. COMPANION of ribo2
  // (letters I–Q). react:true — predicted chemmap (exp_reactivity_*), NOT experimental → cond:[]
  // (sequence-only inference; NOT chemmap-conditioned). motifs:true so pairing.json (SS view) loads;
  // motifs.json is empty (motif stage not run). Loads lazily when an I–Q letter is enabled.
  { id: "ribo2-iq-curated-v2", label: "Ribonanza-2 curated I–Q · de-padded union (42,631)", base: "data/datasets/ribo2-iq-curated-v2", ext: "pdb", react: true, motifs: true, cond: [],
    parent: "ribo2", letters: ["I", "J", "K", "L", "M", "N", "O", "P", "Q"] },
  { id: "rfam_pdb130", label: "RFAM-PDB 130 (1,614)", base: "data/datasets/rfam_pdb130", ext: "pdb", react: true, motifs: true, cond: ["exp"] },
  { id: "rfam_pdb240", label: "RFAM-PDB 240 (2)", base: "data/datasets/rfam_pdb240", ext: "pdb", react: true, motifs: true, cond: ["exp"] },
];
