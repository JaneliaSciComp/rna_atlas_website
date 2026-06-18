// Selectable atlases. base "" = repo root (Ribonanza-2 curated); others under datasets/<id>/.
// react/motifs flags say whether that dataset ships per-fold reactivity + motif spans.
window.DATASETS = [
  { id: "ribo2", label: "Ribonanza-2 curated (7,757)", base: "", ext: "cif", react: true, motifs: true },
  { id: "pseudolabels", label: "Ribo-1 pseudolabel (19,759)", base: "data/datasets/pseudolabels", ext: "pdb", react: true, motifs: true },
  { id: "openknot", label: "OpenKnot (3,698)", base: "data/datasets/openknot", ext: "pdb", react: true, motifs: true },
  { id: "rfam_pdb130", label: "RFAM-PDB 130 (1,614)", base: "data/datasets/rfam_pdb130", ext: "pdb", react: true, motifs: true },
  { id: "rfam_pdb240", label: "RFAM-PDB 240 (2)", base: "data/datasets/rfam_pdb240", ext: "pdb", react: true, motifs: true },
];
