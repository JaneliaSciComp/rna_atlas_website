// Shared visual style — JS port of lsf/20260611_rna_motif_atlas/viz_style.py.
// Single source of truth for motif / nucleotide / reactivity colors.

const MOTIF_COLORS = {
  A_MINOR: "#d1495b",
  TL_RECEPTOR: "#e8862e",
  TETRALOOP_TL_RECEPTOR: "#e8862e",
  UA_HANDLE: "#8c2f39",
  T_LOOP: "#c879c8",
  INTERCALATED_T_LOOP: "#9b5fb0",
  GA_MINOR: "#e8a598",
  PLATFORM: "#edae49",
  TANDEM_GA_SHEARED: "#c9a96b",
  TANDEM_GA_WATSON_CRICK: "#c9a96b",
  U_TURN: "#2e6f95",
  Z_TURN: "#5b7c99",
  GNRA_TETRALOOP: "#16a0a0",
  LOOP_E_SUBMOTIF: "#6a4c93",
  BULGED_G: "#3a7d44",
};
const MOTIF_DEFAULT = "#9aa7b3";

const NUC_COLORS = { A: "#4e9f3d", C: "#3d6cb9", G: "#e8a33d", U: "#c0504d", T: "#c0504d" };
// alternate base palette (user-selectable): A gold, C forest green, G red, U blue
const NUC_COLORS_ALT = { A: "#E8A317", C: "#2E7D32", G: "#D32F2F", U: "#1F6FB2", T: "#1F6FB2" };
function nucColor(ch, alt) { return (alt ? NUC_COLORS_ALT : NUC_COLORS)[ch] || "#ccc"; }

const TERT = new Set(["A_MINOR", "TL_RECEPTOR", "UA_HANDLE", "T_LOOP", "GA_MINOR",
  "PLATFORM", "TANDEM_GA_SHEARED", "TANDEM_GA_WATSON_CRICK", "TETRALOOP_TL_RECEPTOR"]);
const RARE_TERT = new Set(["TL_RECEPTOR", "GA_MINOR", "T_LOOP", "TETRALOOP_TL_RECEPTOR", "UA_HANDLE"]);

function motifColor(name) { return MOTIF_COLORS[name] || MOTIF_DEFAULT; }

// SHAPE/2A3 reactivity ramp (white protected -> deep red reactive), value clipped [0,1].
const SHAPE_STOPS = [[1, 1, 1], [255 / 255, 212 / 255, 194 / 255],
  [240 / 255, 138 / 255, 93 / 255], [184 / 255, 29 / 255, 36 / 255]];
function lerp(a, b, t) { return a + (b - a) * t; }
function shapeRGB(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return [223, 227, 232]; // masked
  v = Math.max(0, Math.min(1, v));
  const seg = v * (SHAPE_STOPS.length - 1);
  const i = Math.min(SHAPE_STOPS.length - 2, Math.floor(seg));
  const t = seg - i, a = SHAPE_STOPS[i], b = SHAPE_STOPS[i + 1];
  const r = Math.round(lerp(a[0], b[0], t) * 255);
  const g = Math.round(lerp(a[1], b[1], t) * 255);
  const bb = Math.round(lerp(a[2], b[2], t) * 255);
  return [r, g, bb];
}
function shapeColor(v) {
  const [r, g, bb] = shapeRGB(v);
  if (v === null || v === undefined || Number.isNaN(v)) return "#dfe3e8"; // masked
  return `rgb(${r},${g},${bb})`;
}
function shapeColorHex(v) {
  return "0x" + shapeRGB(v).map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("");
}
