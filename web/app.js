// RNA Atlas Explorer — client-side filtering/ranking + lazy deep view.
// Sources are chosen as checkboxes (header "Source" menu) and MERGED: FOLDS is the
// union of every checked dataset, each fold tagged with f._dsid so the deep view can
// dispatch struct/ext/reactivity/motifs per row.
let FOLDS = [], MOTIF_SET = [], LETTERS = [];
let MOTIFS_BY_DS = {}, PAIRING_BY_DS = {};  // {dsid: {foldId: ...}} — only motif-bearing datasets populate these
let sortOverride = null;  // {key, dir} from header click
const DATASETS = window.DATASETS || [{ id: "ribo2", label: "curated", base: "", ext: "cif", react: true, motifs: true }];
const DSBYID = {}; DATASETS.forEach((d) => { DSBYID[d.id] = d; });
const LOADED = {};        // dsid -> {folds, motifs, pairing} cache (loaded once)
function dsFor(f) { return DSBYID[f._dsid] || DATASETS[0]; }
function prefix(ds) { return ds && ds.base ? ds.base + "/" : ""; }
function activeSources() { return [...document.querySelectorAll(".src:checked")].map((c) => c.value); }

// Data source: "" = same origin (local serve.py). Otherwise a CloudFront URL
// fronting the S3 data, gated by a shared token (prompted once, kept in localStorage).
const DATA_BASE = (window.DATA_BASE || "").replace(/\/$/, "");
const GATED = !!window.GATED;
function token() { return GATED ? (localStorage.getItem("atlas_token") || "") : ""; }
function durl(path) {
  const base = DATA_BASE ? `${DATA_BASE}/${path}` : path;
  if (!GATED) return base;
  const t = token();
  return t ? `${base}${base.includes("?") ? "&" : "?"}t=${encodeURIComponent(t)}` : base;
}
async function getJSON(path) {
  const r = await fetch(durl(path));
  if (!r.ok) { const e = new Error("http " + r.status); e.status = r.status; throw e; }
  return r.json();
}

const $ = (id) => document.getElementById(id);
const num = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x)) ? "" : (+x).toFixed(d);
// escape for HTML text + attribute values (ids/names can contain " < & — e.g. OpenKnot ids)
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// --- persist filter settings across reloads ---
const FKEY = "atlas_filters";
const FIELD_IDS = ["search", "len_min", "len_max", "plddt_min", "clash_max", "tm_max", "tm_has", "novel_only",
  "ov_max", "shape_ok", "agr_min", "cr_min", "bp_min", "fold_min", "sclust_min", "req_tert", "req_rare", "pk", "rank_key", "topn", "per_letter", "alt_palette", "color_by"];
const altPalette = () => !!($("alt_palette") && $("alt_palette").checked);
function snapshot() {
  const s = {};
  FIELD_IDS.forEach((id) => { const el = $(id); if (el) s[id] = el.type === "checkbox" ? el.checked : el.value; });
  s.mf = [...document.querySelectorAll(".mf:checked")].map((c) => c.value);
  s.lf = [...document.querySelectorAll(".lf:checked")].map((c) => c.value);
  s.src = activeSources();
  s.sort = sortOverride;
  s.collapsed = [...document.querySelectorAll("#config fieldset")].map((fs, i) => fs.classList.contains("collapsed") ? i : -1).filter((i) => i >= 0);
  s.allcollapsed = $("config").classList.contains("allcollapsed");
  return s;
}
function applyState(s) {
  if (!s) return;
  FIELD_IDS.forEach((id) => { const el = $(id); if (el && id in s) { if (el.type === "checkbox") el.checked = !!s[id]; else el.value = s[id]; } });
  if (s.mf) document.querySelectorAll(".mf").forEach((c) => { c.checked = s.mf.includes(c.value); });
  if (s.lf) document.querySelectorAll(".lf").forEach((c) => { c.checked = s.lf.includes(c.value); });
  sortOverride = s.sort || null;
  if (s.collapsed) { const fs = document.querySelectorAll("#config fieldset"); s.collapsed.forEach((i) => fs[i] && fs[i].classList.add("collapsed")); }
  if (s.allcollapsed) $("config").classList.add("allcollapsed");
}
function saveState() { try { localStorage.setItem(FKEY, JSON.stringify(snapshot())); } catch (e) {} }
function loadState() { try { return JSON.parse(localStorage.getItem(FKEY) || "null"); } catch (e) { return null; } }

function showGate(msg) {
  const g = $("gate");
  g.classList.remove("hidden");
  $("gate-msg").textContent = msg || "";
  const inp = $("gate-input");
  inp.value = "";
  inp.focus();
  const submit = () => {
    const v = inp.value.trim();
    if (!v) return;
    localStorage.setItem("atlas_token", v);
    g.classList.add("hidden");
    boot();
  };
  $("gate-go").onclick = submit;
  inp.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

async function boot() {
  if (GATED && !token()) return showGate();
  buildSourcePanel();
  wireSourceUI();
  wireStatic();
  // initial source selection: persisted set, else just the first dataset (ribo2)
  const st = loadState();
  const saved = st && st.src;
  document.querySelectorAll(".src").forEach((c) => {
    c.checked = (saved && saved.length) ? saved.includes(c.value) : (c.value === DATASETS[0].id);
  });
  toggleLetterVisibility(); updateSourceBtn();
  await loadSources();
}

function buildSourcePanel() {
  // The motif-bearing dataset (ribo2) gets the nested per-letter checkboxes (#letter_filter).
  $("source-panel").innerHTML = DATASETS.map((d) => {
    const row = `<label class="srcrow"><input type="checkbox" class="src" value="${d.id}">${d.label}</label>`;
    return d.motifs ? row + `<div id="letter_filter" class="letters srcsub"></div>` : row;
  }).join("");
}

function wireSourceUI() {
  $("source-btn").addEventListener("click", (e) => { e.stopPropagation(); $("source-panel").classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!$("sourcewrap").contains(e.target)) $("source-panel").classList.add("hidden"); });
  document.querySelectorAll(".src").forEach((c) =>
    c.addEventListener("change", () => { toggleLetterVisibility(); updateSourceBtn(); saveState(); loadSources(); }));
}

function toggleLetterVisibility() {
  const on = [...document.querySelectorAll(".src")].some((c) => c.checked && DSBYID[c.value] && DSBYID[c.value].motifs);
  const lf = $("letter_filter"); if (lf) lf.style.display = on ? "" : "none";
}
function updateSourceBtn() {
  const n = activeSources().length;
  $("source-btn").innerHTML = `Source${n ? ` (${n})` : ""} &#9662;`;
}

async function ensureLoaded(dsid) {
  if (LOADED[dsid]) return;
  const ds = DSBYID[dsid];
  const folds = await getJSON(prefix(ds) + "data/folds.json");
  folds.forEach((f) => { f._dsid = dsid; });
  let motifs = {}, pairing = {};
  if (ds.motifs) {
    try { motifs = await getJSON(prefix(ds) + "data/motifs.json"); } catch (e) {}
    try { pairing = await getJSON(prefix(ds) + "data/pairing.json"); } catch (e) {}
  }
  LOADED[dsid] = { folds, motifs, pairing };
}

async function loadSources() {
  const active = activeSources();
  try {
    for (const id of active) await ensureLoaded(id);
  } catch (e) {
    if (GATED && e.status === 403) { localStorage.removeItem("atlas_token"); return showGate("Incorrect passcode — try again."); }
    if (GATED) return showGate("Could not load data (" + (e.status || "network") + ").");
    throw e;
  }
  FOLDS = []; MOTIFS_BY_DS = {}; PAIRING_BY_DS = {}; FBYK = {};
  for (const id of active) {
    const L = LOADED[id]; if (!L) continue;
    FOLDS = FOLDS.concat(L.folds);
    MOTIFS_BY_DS[id] = L.motifs; PAIRING_BY_DS[id] = L.pairing;
  }
  const ms = new Set(), ls = new Set();
  let maxLen = 0;
  for (const f of FOLDS) {
    (f.motifs || []).forEach((m) => ms.add(m));
    if (DSBYID[f._dsid] && DSBYID[f._dsid].motifs && f.letter) ls.add(f.letter);  // letters only from motif-bearing source
    if (f.length > maxLen) maxLen = f.length;
  }
  MOTIF_SET = [...ms].sort();
  LETTERS = [...ls].sort();
  $("len_max").value = maxLen || 9999;
  const maxCR = Math.max(1, ...FOLDS.map((f) => f.contact_ratio || 0));
  $("cr_min").max = Math.ceil(maxCR * 20) / 20;
  buildMotifFilter();
  buildLetterFilter();
  wireDynamic();
  applyState(loadState());
  toggleLetterVisibility();
  syncLabels();
  render();
}

function buildMotifFilter() {
  $("motif_filter").innerHTML = MOTIF_SET.map((m) =>
    `<label><input type="checkbox" class="mf" value="${m}">` +
    `<span class="motif-chip" style="background:${motifColor(m)}">${m.replace(/_/g, " ").toLowerCase()}</span></label>`
  ).join("");
}
function buildLetterFilter() {
  $("letter_filter").innerHTML = LETTERS.map((l) =>
    `<label><input type="checkbox" class="lf" value="${l}" checked>${l}</label>`).join("");
}

function wireDynamic() {
  document.querySelectorAll(".mf,.lf").forEach((c) =>
    c.addEventListener("change", () => { saveState(); render(); }));
}

function wireStatic() {
  document.querySelectorAll("#config input:not(.mf):not(.lf), #config select").forEach((el) =>
    el.addEventListener("input", () => { syncLabels(); saveState(); render(); }));
  $("reset").addEventListener("click", () => {
    document.querySelectorAll(".mf").forEach((c) => c.checked = false);
    document.querySelectorAll(".lf").forEach((c) => c.checked = true);
    ["plddt_min", "tm_max", "ov_max"].forEach((id) => $(id).value = $(id).max);
    $("agr_min").value = -1;
    $("plddt_min").value = 0; $("clash_max").value = 9999; $("len_min").value = 0;
    $("len_max").value = Math.max(...FOLDS.map((f) => f.length || 0));
    ["shape_ok", "req_tert", "req_rare", "tm_has", "novel_only", "per_letter"].forEach((id) => $(id).checked = false);
    $("cr_min").value = 0; $("bp_min").value = 0;
    if ($("fold_min")) $("fold_min").value = 0; if ($("sclust_min")) $("sclust_min").value = 0;
    $("pk").value = "any"; $("rank_key").value = "best_tm1:asc"; $("topn").value = 200;
    if ($("color_by")) $("color_by").value = "a23";
    if ($("search")) $("search").value = "";
    sortOverride = null; localStorage.removeItem(FKEY); syncLabels(); render();
  });
  if ($("search")) $("search").addEventListener("input", () => { saveState(); render(); });
  if ($("alt_palette")) $("alt_palette").addEventListener("change", () => { if (currentDeep) { drawTracks(currentDeep.f, currentDeep.react); load3D(currentDeep.f, currentDeep.react); } });
  if ($("color_by")) $("color_by").addEventListener("change", () => { if (currentDeep) load3D(currentDeep.f, currentDeep.react); });
  // collapsible sections (click a legend) + collapse-all (click the panel heading)
  document.querySelectorAll("#config fieldset legend").forEach((lg) =>
    lg.addEventListener("click", () => { lg.parentElement.classList.toggle("collapsed"); saveState(); }));
  const h2 = document.querySelector("#config h2");
  if (h2) h2.addEventListener("click", () => { $("config").classList.toggle("allcollapsed"); saveState(); });
  $("deep-close").addEventListener("click", closeDeep);
  if ($("deep-export")) $("deep-export").addEventListener("click", exportFold);
  $("deep").addEventListener("click", (e) => { if (e.target.id === "deep") closeDeep(); });
  document.querySelectorAll('#layoutctl button[data-mode]').forEach((b) =>
    b.addEventListener("click", () => setDeepMode(b.dataset.mode)));
  document.querySelectorAll('#viewctl button[data-view]').forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view)));
  if ($("help-btn")) $("help-btn").addEventListener("click", () => $("help").classList.remove("hidden"));
  if ($("help-close")) $("help-close").addEventListener("click", () => $("help").classList.add("hidden"));
  $("help").addEventListener("click", (e) => { if (e.target.id === "help") $("help").classList.add("hidden"); });
  updateLayout();
  syncLabels();
}
function syncLabels() {
  $("plddt_min_v").textContent = $("plddt_min").value;
  $("tm_max_v").textContent = (+$("tm_max").value).toFixed(2);
  $("ov_max_v").textContent = (+$("ov_max").value).toFixed(2);
  $("agr_min_v").textContent = (+$("agr_min").value).toFixed(2);
  $("cr_min_v").textContent = (+$("cr_min").value).toFixed(2);
  $("bp_min_v").textContent = (+$("bp_min").value).toFixed(2);
}

function filters() {
  const lf = [...document.querySelectorAll(".lf:checked")].map((c) => c.value);
  const mf = [...document.querySelectorAll(".mf:checked")].map((c) => c.value);
  return {
    q: ($("search") ? $("search").value : "").trim().toLowerCase(),
    lmin: +$("len_min").value, lmax: +$("len_max").value,
    plddt: +$("plddt_min").value, clash: +$("clash_max").value,
    tmax: +$("tm_max").value, tmhas: $("tm_has").checked, novelOnly: $("novel_only").checked,
    ovmax: +$("ov_max").value,
    shape: $("shape_ok").checked, agr: +$("agr_min").value,
    crmin: +$("cr_min").value, bpmin: +$("bp_min").value,
    foldMin: +($("fold_min") ? $("fold_min").value : 0), sclustMin: +($("sclust_min") ? $("sclust_min").value : 0),
    tert: $("req_tert").checked, rare: $("req_rare").checked, motifs: mf,
    pk: $("pk").value, letters: new Set(lf),
    rank: $("rank_key").value, topn: +$("topn").value, perLetter: $("per_letter").checked,
  };
}

function pass(f, c) {
  if (c.q && !(f.id.toLowerCase().includes(c.q) || (f.name || "").toLowerCase().includes(c.q)
      || (f.sublibrary || "").toLowerCase().includes(c.q) || (f.rna_type || "").toLowerCase().includes(c.q)
      || (f.rfam_name || "").toLowerCase().includes(c.q)
      || String(f.global_fold_id || "") === c.q || String(f.global_seq_cluster_id || "") === c.q)) return false;
  if (f.length != null && (f.length < c.lmin || f.length > c.lmax)) return false;
  if ((f.plddt || 0) < c.plddt) return false;
  if (f.clashscore != null && f.clashscore > c.clash) return false;
  if (c.tmhas && f.best_tm1 == null) return false;
  if (c.novelOnly && f.is_novel_v341 !== 1) return false;
  if (f.best_tm1 != null && f.best_tm1 > c.tmax) return false;
  if (f.overlap_ae != null && f.overlap_ae > c.ovmax) return false;
  if (c.shape && !f.shape_ok) return false;
  if (c.agr > -1 && (f.shape_agr == null || f.shape_agr < c.agr)) return false;
  if (c.crmin > 0 && (f.contact_ratio == null || f.contact_ratio < c.crmin)) return false;
  if (c.bpmin > 0 && (f.bp_fraction == null || f.bp_fraction < c.bpmin)) return false;
  if (c.foldMin > 0 && (f.fold_size == null || f.fold_size < c.foldMin)) return false;
  if (c.sclustMin > 0 && (f.seq_cluster_size == null || f.seq_cluster_size < c.sclustMin)) return false;
  if (c.tert && f.n_tert < 1) return false;
  if (c.rare && f.n_rare < 1) return false;
  if (c.motifs.length && !c.motifs.some((m) => (f.motifs || []).includes(m))) return false;
  if (c.pk !== "any" && String(f.pseudoknot) !== c.pk) return false;
  if (DSBYID[f._dsid] && DSBYID[f._dsid].motifs && f.letter && !c.letters.has(f.letter)) return false;
  return true;
}

function ranker(c) {
  const [key, dir] = (sortOverride ? `${sortOverride.key}:${sortOverride.dir}` : c.rank).split(":");
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    let x = a[key], y = b[key];
    const xn = (x == null), yn = (y == null);
    if (xn && yn) return 0;
    if (xn) return 1;       // nulls always last
    if (yn) return -1;
    if (typeof x === "string") return sign * x.localeCompare(y);
    return sign * (x - y);
  };
}

function render() {
  const c = filters();
  let rows = FOLDS.filter((f) => pass(f, c));
  rows.sort(ranker(c));
  if (c.perLetter) {
    const seen = {};
    rows = rows.filter((f) => { seen[f.letter] = (seen[f.letter] || 0) + 1; return seen[f.letter] <= c.topn; });
  } else {
    rows = rows.slice(0, c.topn);
  }
  lastRows = rows;
  $("count").textContent = `${rows.length} shown`;
  if (viewMode === "map") renderMap(rows); else drawTable(rows);
}
let viewMode = "table", lastRows = [];

const COLS = [
  ["id", "seq_id"], ["name", "name"], ["letter", "L"], ["length", "len"], ["plddt", "pLDDT"],
  ["best_tm1", "best_tm1"], ["near", "nearest"], ["overlap_ae", "ovlp_AE"],
  ["shape_ok", "SHAPE"], ["shape_agr", "SHAPE agr"], ["contact_ratio", "compact"], ["bp_fraction", "paired"],
  ["fold_size", "cluster"], ["n_tert", "tert"], ["n_rare", "rare"], ["pseudoknot", "PK"], ["motifs", "motifs"],
];

function drawTable(rows) {
  $("thead").innerHTML = COLS.map(([k, lbl]) => {
    let cls = "";
    if (sortOverride && sortOverride.key === k) cls = sortOverride.dir === "asc" ? "asc" : "sorted";
    return `<th data-k="${k}" class="${cls}">${lbl}</th>`;
  }).join("");
  $("thead").querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (sortOverride && sortOverride.key === k) sortOverride.dir = sortOverride.dir === "asc" ? "desc" : "asc";
    else sortOverride = { key: k, dir: "asc" };
    render();
  }));
  const body = rows.map((f) => {
    const chips = (f.motifs || []).slice(0, 6).map((m) =>
      `<span class="motif-chip" style="background:${motifColor(m)}">${m.replace(/_/g, " ").toLowerCase()}</span>`).join("");
    const pl = f.plddt || 0;
    const plbar = `<span class="bar" style="width:${pl * 0.45}px;background:${pl > 80 ? "#3a7d44" : pl > 60 ? "#edae49" : "#c0504d"}"></span> ${num(pl, 0)}`;
    const hasShape = f.r2a3 != null || f.mean_prot_2a3 != null;
    const shape = f.shape_ok ? `<span class="pill" style="background:#3a7d44">yes</span>`
      : (hasShape ? `<span class="muted" title="has SHAPE data but motif residues not protected">no</span>`
                  : `<span class="muted" title="no usable SHAPE data for this fold">n/d</span>`);
    return `<tr data-id="${esc(f.id)}">
      <td>${esc(f.id)}</td><td>${esc(f.name || "")}</td><td>${f.letter}</td>
      <td class="num">${f.length ?? ""}</td><td class="num">${plbar}</td>
      <td class="num">${num(f.best_tm1, 3)}</td><td title="${(f.near_title || "").replace(/"/g, "&quot;")}">${f.near || ""}</td>
      <td class="num">${num(f.overlap_ae, 2)}</td><td>${shape}</td>
      <td class="num">${num(f.shape_agr, 2)}</td><td class="num">${num(f.contact_ratio, 2)}</td><td class="num">${num(f.bp_fraction, 2)}</td>
      <td class="num" title="${f.global_fold_id ? "structural fold #" + f.global_fold_id : ""}">${f.fold_size ?? ""}</td>
      <td class="num">${f.n_tert}</td><td class="num">${f.n_rare}</td>
      <td>${f.pseudoknot ? "&#10003;" : ""}</td><td>${chips}</td></tr>`;
  }).join("");
  $("tbody").innerHTML = body;
  $("tbody").querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => openDeep(tr.dataset.id)));
}

// ---------------- deep view ----------------
let FBYK = {};
function foldById(id) { if (!FBYK[id]) FOLDS.forEach((f) => FBYK[f.id] = f); return FBYK[id]; }

function currentMode() { return localStorage.getItem("atlas_deepmode") || "modal"; }
function updateLayout() {
  const open = !$("deep").classList.contains("hidden");
  const m = currentMode();
  document.body.classList.remove("deepopen-right", "deepopen-bottom");
  if (open && m === "right") document.body.classList.add("deepopen-right");
  if (open && m === "bottom") document.body.classList.add("deepopen-bottom");
  document.querySelectorAll('#layoutctl button[data-mode]').forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
}
function setDeepMode(m) {
  const d = $("deep");
  d.classList.remove("mode-modal", "mode-right", "mode-bottom");
  d.classList.add("mode-" + m);
  localStorage.setItem("atlas_deepmode", m);
  updateLayout();
  if (viewer) { try { viewer.resize(); viewer.render(); } catch (e) {} }
}
function closeDeep() {
  $("deep").classList.add("hidden");
  updateLayout();
  if (viewer) { try { viewer.resize(); } catch (e) {} }
}

async function openDeep(id) {
  const f = foldById(id);
  const ds = dsFor(f);
  $("deep").classList.remove("hidden");
  setDeepMode(currentMode());
  $("deep-title").textContent = `${id}${f.name ? "  —  " + f.name : ""}`;
  drawProps(f);
  let react = null;
  if (ds.react) {
    try { react = await (await fetch(durl(prefix(ds) + "react/" + (f.key || id) + ".json"))).json(); } catch (e) { react = null; }
  }
  currentDeep = { f, react };
  drawTracks(f, react);
  load3D(f, react);
}
let currentDeep = null;

function drawProps(f) {
  const verdict = f.best_tm1 == null ? "n/a (not scored vs v341)"
    : f.best_tm1 < 0.40 ? "novel" : f.best_tm1 < 0.45 ? "borderline" : "matches known fold";
  const rowsHtml = [
    ["Source", `${f.source} (lib ${f.letter})`],
    ["Sublibrary", f.sublibrary],
    f.rnacentral_id ? ["RNAcentral", `<a href="https://rnacentral.org/rna/${esc(f.rnacentral_id)}" target="_blank" rel="noopener">${esc(f.rnacentral_id)}</a>${f.rnacentral_name ? ` &mdash; ${esc(f.rnacentral_name)}` : ""}`] : null,
    f.rna_type ? ["RNA type", esc(f.rna_type)] : null,
    (f.member_dbs && f.member_dbs.length) ? ["Member databases", f.member_dbs.map(esc).join(", ")] : null,
    f.rfam_id ? ["Rfam family", `<a href="https://rfam.org/family/${esc(f.rfam_id)}" target="_blank" rel="noopener">${esc(f.rfam_id)}</a>${f.rfam_name ? ` &mdash; ${esc(f.rfam_name)}` : ""}`] : null,
    ["Length", `${f.length} nt`],
    ["pLDDT / gpde", `${num(f.plddt)} / ${num(f.gpde, 3)}`],
    ["Clashscore", num(f.clashscore, 2)],
    ["Novelty (best_tm1 vs v341)", f.best_tm1 == null ? "&mdash;" : `${num(f.best_tm1, 3)} &mdash; ${verdict}`],
    ["Nearest known fold", `${f.near || "&mdash;"}${f.near_title ? ` &mdash; ${f.near_title}` : ""}`],
    ["Distinct vs A&ndash;E (overlap)", num(f.overlap_ae, 3)],
    ["SHAPE-supported", `${f.shape_ok ? "yes" : "no"} (SHAPE–pairing agreement = ${num(f.shape_agr, 3)}, + = good; mean prot = ${num(f.mean_prot_2a3, 3)})`],
    ["OpenKnot score", num(f.openknot, 3)],
    ["Pseudoknot", f.pseudoknot ? "yes" : "no"],
    ["Secondary-structure class", f.ss_class],
    ["Compactness (C1′ contact ratio)", num(f.contact_ratio, 3)],
    ["Base-paired fraction", num(f.bp_fraction, 3)],
    ["Tertiary motifs", `${f.n_tert} (rare ${f.n_rare})`],
    f.global_fold_id ? ["Structural fold (A–H)", `#${f.global_fold_id} &mdash; ${f.fold_size} member${f.fold_size === 1 ? "" : "s"}${f.overlap_global_fold_id ? ` &middot; nearest A–E fold #${f.overlap_global_fold_id}` : ""}`] : null,
    f.global_seq_cluster_id ? ["Sequence cluster (A–H)", `#${f.global_seq_cluster_id} &mdash; ${f.seq_cluster_size} member${f.seq_cluster_size === 1 ? "" : "s"}`] : null,
  ].filter(Boolean);
  const chips = (f.motifs || []).map((m) =>
    `<span class="motif-chip" style="background:${motifColor(m)}">${m.replace(/_/g, " ").toLowerCase()}</span>`).join(" ");
  $("props").innerHTML = "<table>" + rowsHtml.filter(Boolean).map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("")
    + `<tr><td class="muted">Motifs</td><td>${chips}</td></tr></table>`;
}

function spansFor(f) {
  const M = MOTIFS_BY_DS[f._dsid] || {};
  return (M[f.id] || []).map(([type, res]) => {
    const ranges = [];
    res.split(",").forEach((c) => {
      const rng = c.trim().split(":").pop();
      const [a, b] = rng.includes("-") ? rng.split("-") : [rng, rng];
      const ai = parseInt(a), bi = parseInt(b);
      if (!Number.isNaN(ai)) ranges.push([ai, Number.isNaN(bi) ? ai : bi]);
    });
    return { type, ranges };
  });
}

function drawTracks(f, react) {
  const seq = (react && react.seq) || "";
  const ra = react && (react.a23 || react.dms);
  const n = seq.length || (ra ? ra.length : 0) || f.length || 0;
  if (!n) { $("tracks").innerHTML = '<p class="muted">No reactivity / sequence available for this fold.</p>'; return; }
  const cw = Math.max(6, Math.min(16, Math.floor(900 / n)));
  const W = n * cw, pad = 4;
  const motifs = spansFor(f);
  // lane assignment
  const lanes = [];
  motifs.forEach((m) => {
    const lo = Math.min(...m.ranges.map((r) => r[0])), hi = Math.max(...m.ranges.map((r) => r[1]));
    let li = lanes.findIndex((end) => end < lo);
    if (li < 0) { li = lanes.length; lanes.push(0); }
    lanes[li] = hi; m.lane = li;
  });
  const laneH = 9, mh = lanes.length * (laneH + 2);
  const yMot = pad, ySeq = yMot + mh + 4, yDms = ySeq + 16, yA23 = yDms + 16, yPair = yA23 + 16, H = yPair + 18;
  let svg = `<svg width="${W + 40}" height="${H}" font-size="9">`;
  // motif bars
  motifs.forEach((m) => {
    m.ranges.forEach(([a, b]) => {
      svg += `<rect x="${(a - 1) * cw}" y="${yMot + m.lane * (laneH + 2)}" width="${(b - a + 1) * cw}" height="${laneH}" rx="2" fill="${motifColor(m.type)}"><title>${m.type} ${a}-${b}</title></rect>`;
    });
  });
  // sequence
  for (let i = 0; i < n; i++) {
    const ch = seq[i] || "N";
    svg += `<rect x="${i * cw}" y="${ySeq}" width="${cw - 0.5}" height="13" fill="${nucColor(ch, altPalette())}"/>`;
    if (cw >= 10) svg += `<text x="${i * cw + cw / 2}" y="${ySeq + 10}" text-anchor="middle" fill="#fff">${ch}</text>`;
  }
  // reactivity rows
  const rrow = (arr, y, label) => {
    let s = `<text x="${W + 3}" y="${y + 11}" fill="#5b6670">${label}</text>`;
    for (let i = 0; i < n; i++) {
      const v = arr ? arr[i] : null;
      s += `<rect x="${i * cw}" y="${y}" width="${cw - 0.5}" height="13" fill="${shapeColor(v)}"><title>${label} ${i + 1}: ${v == null ? "n/a" : (+v).toFixed(2)}</title></rect>`;
    }
    return s;
  };
  svg += rrow(react && react.dms, yDms, "DMS");
  svg += rrow(react && react.a23, yA23, "2A3");
  // predicted pairing track: unpaired = light red, paired = white (eyeball SHAPE agreement)
  const dbn = (PAIRING_BY_DS[f._dsid] || {})[f.id] || "";
  let pr = `<text x="${W + 3}" y="${yPair + 11}" fill="#5b6670">pair</text>`;
  for (let i = 0; i < n; i++) {
    const ch = dbn[i];
    const paired = ch && ch !== "." && ch !== "-";
    const fill = ch ? (paired ? "#ffffff" : "#f3a0a0") : "#eef2f5";
    pr += `<rect x="${i * cw}" y="${yPair}" width="${cw - 0.5}" height="13" fill="${fill}" stroke="#dfe3e8" stroke-width="0.5"><title>pos ${i + 1}: ${ch ? (paired ? "paired" : "unpaired") : "n/a"}</title></rect>`;
  }
  svg += pr + "</svg>";
  $("tracks").innerHTML = `<div style="font-size:11px;color:#5b6670;margin-bottom:3px">motif lanes &middot; sequence &middot; DMS &middot; 2A3 reactivity (white=protected &rarr; red=reactive) &middot; pairing (white=paired, light red=unpaired)</div>` + svg;
}

let viewer = null, viewerModel = null;
async function load3D(f, react) {
  const el = $("viewer3d");
  el.innerHTML = "";
  if (typeof $3Dmol === "undefined") { el.innerHTML = '<p style="color:#fff;padding:8px">3Dmol.js not loaded.</p>'; return; }
  const id = f.id;
  const ds = dsFor(f);
  let data;
  viewerModel = null; if (currentDeep) { currentDeep.structText = null; currentDeep.structFmt = null; }
  try { data = await (await fetch(durl(prefix(ds) + "structs/" + (f.key || f.id) + "." + (ds.ext || "cif")))).text(); }
  catch (e) { el.innerHTML = '<p style="color:#fff;padding:8px">structure unavailable</p>'; return; }
  viewer = $3Dmol.createViewer(el, { backgroundColor: "0x0d1117" });
  const fmt = data.startsWith("data_") || data.includes("_atom_site") ? "cif" : "pdb";
  if (currentDeep) { currentDeep.structText = data; currentDeep.structFmt = fmt; }
  viewerModel = viewer.addModel(data, fmt);
  const a23 = react && react.a23, dms = react && react.dms;
  const dbn = (PAIRING_BY_DS[f._dsid] || {})[f.id] || "";
  const mode = ($("color_by") && $("color_by").value) || "a23";
  let style;
  if (mode === "plddt") {                       // per-residue pLDDT from the B-factor (AlphaFold palette)
    style = { cartoon: { colorfunc: (a) => plddtCF(a.b), ringMode: 3 } };
  } else if (mode === "pairing") {              // predicted secondary structure: paired vs unpaired
    style = { cartoon: { colorfunc: (a) => { const c = dbn[a.resi - 1]; const p = c && c !== "." && c !== "-"; return p ? "0xffffff" : (c ? "0xf3a0a0" : "0x9aa7b0"); }, ringMode: 3 } };
  } else if (mode === "nuc") {                   // nucleotide identity (same palette as the sequence track)
    const alt = altPalette();
    style = { cartoon: { colorfunc: (a) => hexCF(nucColor((a.resn || "").trim(), alt)), ringMode: 3 } };
  } else if (mode === "spectrum") {
    style = { cartoon: { color: "spectrum", ringMode: 3 } };
  } else {                                       // a23 / dms reactivity (blue protected -> red reactive); spectrum if absent
    const arr = mode === "dms" ? dms : a23;
    style = arr ? { cartoon: { colorfunc: (a) => reactCF(arr[a.resi - 1]), ringMode: 3 } }
                : { cartoon: { color: "spectrum", ringMode: 3 } };
  }
  viewer.setStyle({}, style);
  spansFor(f).forEach((m) => {
    const resi = [];
    m.ranges.forEach(([a, b]) => { for (let r = a; r <= b; r++) resi.push(r); });
    viewer.addStyle({ resi }, { stick: { color: motifColor(m.type), radius: 0.28 } });
  });
  viewer.zoomTo(); viewer.render();
}
function shapeMix(a, b, t) {
  return "0x" + [0, 1, 2].map((i) => Math.round((a[i] + (b[i] - a[i]) * t) * 255).toString(16).padStart(2, "0")).join("");
}
function hexCF(h) { return "0x" + h.replace("#", ""); }
function reactCF(v) {                              // 2A3/DMS: blue protected -> white -> red reactive
  if (v == null || Number.isNaN(v)) return "0xf7f7f7";
  const t = Math.max(-0.3, Math.min(1, v)), f = (t + 0.3) / 1.3;
  return f < 0.5 ? $3Dmol.CC.color(shapeMix(PROT_STOPS[0], PROT_STOPS[1], f * 2))
                 : $3Dmol.CC.color(shapeMix(PROT_STOPS[1], PROT_STOPS[2], (f - 0.5) * 2));
}
function plddtCF(b) {                              // AlphaFold confidence palette
  if (b == null || Number.isNaN(b)) return "0xcccccc";
  return b >= 90 ? "0x0053d6" : b >= 70 ? "0x65cbf3" : b >= 50 ? "0xffdb13" : "0xff7d45";
}

// ---------------- export bundle (cif + pdb + png + txt -> zip) ----------------
const _enc = (s) => new TextEncoder().encode(s);
function safeName(s) { return String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 90); }
let _CRCT = null;
function crc32(u8) {
  if (!_CRCT) { _CRCT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; _CRCT[n] = c >>> 0; } }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) crc = _CRCT[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {   // store method (no compression); files: [{name, data:Uint8Array}]
  const parts = [], central = []; let off = 0;
  for (const f of files) {
    const nb = _enc(f.name), d = f.data, crc = crc32(d);
    const lh = new Uint8Array(30 + nb.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true);
    lv.setUint16(26, nb.length, true); lh.set(nb, 30);
    parts.push(lh, d);
    const ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true);
    cv.setUint16(28, nb.length, true); cv.setUint32(42, off, true); ch.set(nb, 46);
    central.push(ch); off += lh.length + d.length;
  }
  const cs = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cs, true); ev.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
function dataURIBytes(uri) {
  const bin = atob(uri.split(",")[1]), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function atomsToPDB(atoms) {
  const L = [];
  atoms.forEach((a, i) => {
    const nm = (a.atom || ""), an = nm.length < 4 ? " " + nm : nm;
    L.push("ATOM  " + String(a.serial || i + 1).padStart(5) + " " + an.padEnd(4) + " " +
      (a.resn || "").padStart(3) + " " + (a.chain || "A").slice(0, 1) + String(a.resi || 1).padStart(4) + "    " +
      a.x.toFixed(3).padStart(8) + a.y.toFixed(3).padStart(8) + a.z.toFixed(3).padStart(8) +
      "  1.00" + (a.b != null ? a.b : 0).toFixed(2).padStart(6) + "          " + (a.elem || "").padStart(2));
  });
  L.push("END");
  return L.join("\n") + "\n";
}
function atomsToCIF(atoms, id) {
  let s = "data_" + id + "\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\n_atom_site.type_symbol\n_atom_site.label_atom_id\n" +
    "_atom_site.label_comp_id\n_atom_site.label_asym_id\n_atom_site.label_seq_id\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n" +
    "_atom_site.Cartn_z\n_atom_site.occupancy\n_atom_site.B_iso_or_equiv\n";
  atoms.forEach((a, i) => {
    s += ["ATOM", i + 1, a.elem || "X", a.atom || "X", a.resn || "X", a.chain || "A", a.resi || 1,
      a.x.toFixed(3), a.y.toFixed(3), a.z.toFixed(3), "1.00", (a.b != null ? a.b : 0).toFixed(2)].join(" ") + "\n";
  });
  return s + "#\n";
}
function foldTxt(f, react) {
  const L = [];
  L.push("name: " + (f.name || ""));
  L.push("seq_id: " + f.id);
  L.push("source: " + (f.source || "") + (f.letter ? " (library " + f.letter + ")" : ""));
  if (f.sublibrary) L.push("sublibrary: " + f.sublibrary);
  L.push("length: " + (f.length != null ? f.length : "") + " nt");
  L.push("pLDDT: " + num(f.plddt, 1) + "   gpde: " + num(f.gpde, 3));
  L.push("novelty best_tm1 (vs v341): " + (f.best_tm1 == null ? "n/a (unscored)" : num(f.best_tm1, 3)) +
    (f.near ? "   nearest: " + f.near + (f.near_title ? " (" + f.near_title + ")" : "") : ""));
  L.push("is_novel_v341: " + (f.is_novel_v341 === 1 ? "yes" : "no"));
  L.push("SHAPE-supported: " + (f.shape_ok ? "yes" : "no") + (f.shape_agr != null ? "   SHAPE-agr: " + num(f.shape_agr, 3) : ""));
  L.push("compactness (C1' contact ratio): " + num(f.contact_ratio, 3));
  L.push("base-paired fraction: " + num(f.bp_fraction, 3));
  L.push("pseudoknot: " + (f.pseudoknot ? "yes" : "no"));
  L.push("tertiary motifs: " + (f.motifs || []).join(", ") + (f.n_tert != null ? "  (n_tert=" + f.n_tert + ", n_rare=" + f.n_rare + ")" : ""));
  const dbn = (PAIRING_BY_DS[f._dsid] || {})[f.id];
  if (react && react.seq) L.push("sequence:\n" + react.seq);
  if (dbn) L.push("secondary structure (dbn):\n" + dbn);
  return L.join("\n") + "\n";
}
async function exportFold() {
  if (!currentDeep) return;
  const f = currentDeep.f, react = currentDeep.react, base = safeName(f.id) || "fold";
  const files = [{ name: base + ".txt", data: _enc(foldTxt(f, react)) }];
  const atoms = viewerModel ? viewerModel.selectedAtoms({}) : [];
  if (currentDeep.structText && atoms.length) {
    const native = currentDeep.structFmt;     // keep the original file for its own format; generate the other
    files.push({ name: base + ".pdb", data: _enc(native === "pdb" ? currentDeep.structText : atomsToPDB(atoms)) });
    files.push({ name: base + ".cif", data: _enc(native === "cif" ? currentDeep.structText : atomsToCIF(atoms, base)) });
  }
  if (viewer) { try { files.push({ name: base + ".png", data: dataURIBytes(viewer.pngURI()) }); } catch (e) {} }
  const fname = (safeName(f.name) ? safeName(f.name) + "__" : "") + base + ".zip";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zipStore(files)); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- scatter "map" view (t-SNE embedding ex/ey) ----------------
let mapT = { k: 1, x: 0, y: 0 }, mapPts = [], mapInit = false, mapDrag = null;
function setView(mode) {
  viewMode = mode === "map" ? "map" : "table";
  $("tbl").classList.toggle("hidden", viewMode === "map");
  $("mapwrap").classList.toggle("hidden", viewMode !== "map");
  document.querySelectorAll('#viewctl button[data-view]').forEach((b) => b.classList.toggle("active", b.dataset.view === viewMode));
  if (viewMode === "map") setupMap();
  render();
}
function grad4(t) {
  const s = [[33, 102, 172], [14, 154, 166], [237, 174, 73], [211, 74, 69]];
  t = Math.max(0, Math.min(1, t)); const u = t * 3, i = Math.min(2, Math.floor(u)), w = u - i, a = s[i], b = s[i + 1];
  return `rgb(${a.map((x, j) => Math.round(x + (b[j] - x) * w)).join(",")})`;
}
function mapColorFn(field, rows) {
  if (field === "rna_type" || field === "letter") {
    const vals = [...new Set(rows.map((f) => f[field]).filter((v) => v != null && v !== ""))].sort();
    const pal = ["#2e6f95", "#e8a317", "#2e7d32", "#d32f2f", "#7b5ea7", "#1f6fb2", "#c1440e", "#0d9aa6", "#aa3388", "#888", "#55aa77", "#aa7744"];
    const m = {}; vals.forEach((v, i) => { m[v] = pal[i % pal.length]; });
    return { fn: (f) => m[f[field]] || "#ccc", legend: vals.slice(0, 12).map((v) => [v, m[v]]) };
  }
  const log = field === "fold_size" || field === "seq_cluster_size";
  let nums = rows.map((f) => f[field]).filter((v) => typeof v === "number");
  if (log) nums = nums.map((v) => Math.log1p(v));
  const lo = nums.length ? Math.min(...nums) : 0, hi = nums.length ? Math.max(...nums) : 1, rng = hi > lo ? hi - lo : 1;
  return { fn: (f) => { let v = f[field]; if (typeof v !== "number") return "#ccc"; if (log) v = Math.log1p(v); return grad4((v - lo) / rng); }, range: [lo, hi, log] };
}
function mapProject(ex, ey, W, H) {
  const pad = 26, bx = pad + ex * (W - 2 * pad), by = pad + (1 - ey) * (H - 2 * pad);
  return [bx * mapT.k + mapT.x, by * mapT.k + mapT.y];
}
function renderMap(rows) {
  const wrap = $("mapwrap"), cv = $("map");
  const W = wrap.clientWidth, H = Math.max(100, wrap.clientHeight - 36), dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  // axes: gridded embedding box (moves with zoom/pan) + fixed t-SNE axis labels
  const c00 = mapProject(0, 0, W, H), c11 = mapProject(1, 1, W, H);
  const bL = Math.min(c00[0], c11[0]), bR = Math.max(c00[0], c11[0]), bT = Math.min(c00[1], c11[1]), bB = Math.max(c00[1], c11[1]);
  ctx.strokeStyle = "#eef2f5"; ctx.lineWidth = 1;
  for (let g = 0; g <= 1.0001; g += 0.25) {
    const gx = mapProject(g, 0, W, H)[0], gy = mapProject(0, g, W, H)[1];
    ctx.beginPath(); ctx.moveTo(gx, bT); ctx.lineTo(gx, bB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bL, gy); ctx.lineTo(bR, gy); ctx.stroke();
  }
  ctx.strokeStyle = "#dde3e8"; ctx.strokeRect(bL, bT, bR - bL, bB - bT);
  ctx.fillStyle = "#8a96a0"; ctx.font = "11px sans-serif";
  ctx.fillText("t-SNE 1", W / 2 - 18, H - 6);
  ctx.save(); ctx.translate(11, H / 2 + 20); ctx.rotate(-Math.PI / 2); ctx.fillText("t-SNE 2", 0, 0); ctx.restore();
  const pts = rows.filter((f) => f.ex != null);
  const col = mapColorFn($("map_color").value, pts);
  mapPts = [];
  ctx.globalAlpha = 0.8;
  for (const f of pts) {
    const [x, y] = mapProject(f.ex, f.ey, W, H);
    mapPts.push({ x, y, f });
    if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.2832); ctx.fillStyle = col.fn(f); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const lg = $("maplegend");
  if (col.legend) lg.innerHTML = col.legend.map(([v, c]) => `<span class="lg"><i style="background:${c}"></i>${esc(v)}</span>`).join("");
  else { const [lo, hi, log] = col.range, fmt = (v) => log ? Math.round(Math.expm1(v)) : (+v).toFixed(2);
    lg.innerHTML = `<span class="lg">${fmt(lo)}</span><span class="lgbar" style="background:linear-gradient(90deg,${grad4(0)},${grad4(.5)},${grad4(1)})"></span><span class="lg">${fmt(hi)}</span>`; }
}
function mapPick(mx, my, r) { let best = null, bd = r * r; for (const p of mapPts) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bd) { bd = d; best = p; } } return best; }
function setupMap() {
  if (mapInit) return; mapInit = true;
  const cv = $("map");
  cv.addEventListener("wheel", (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    mapT.x = mx - (mx - mapT.x) * f; mapT.y = my - (my - mapT.y) * f; mapT.k *= f; renderMap(lastRows); }, { passive: false });
  cv.addEventListener("mousedown", (e) => { mapDrag = { x: e.clientX, y: e.clientY, ox: mapT.x, oy: mapT.y, moved: false }; });
  window.addEventListener("mousemove", (e) => {
    const cv2 = $("map"), r = cv2.getBoundingClientRect();
    if (mapDrag) { mapDrag.moved = mapDrag.moved || Math.abs(e.clientX - mapDrag.x) + Math.abs(e.clientY - mapDrag.y) > 3;
      mapT.x = mapDrag.ox + (e.clientX - mapDrag.x); mapT.y = mapDrag.oy + (e.clientY - mapDrag.y); renderMap(lastRows); return; }
    if (viewMode !== "map") return;
    const tip = $("maptip");
    if (e.target !== cv2) { tip.classList.add("hidden"); return; }
    const p = mapPick(e.clientX - r.left, e.clientY - r.top, 7);
    if (p) { tip.classList.remove("hidden"); tip.style.left = (e.clientX - r.left + 14) + "px"; tip.style.top = (e.clientY - r.top + 14) + "px";
      tip.innerHTML = `<b>${esc(p.f.id)}</b>${p.f.name ? "<br>" + esc(p.f.name) : ""}`; } else tip.classList.add("hidden");
  });
  window.addEventListener("mouseup", (e) => { if (mapDrag && !mapDrag.moved && e.target === $("map")) { const r = $("map").getBoundingClientRect(); const p = mapPick(e.clientX - r.left, e.clientY - r.top, 9); if (p) openDeep(p.f.id); } mapDrag = null; });
  $("map_color").addEventListener("change", () => renderMap(lastRows));
}

// ---------------- AtlasAPI: programmatic surface the assistant drives ----------------
const FILTER_MAP = { length_min: "len_min", length_max: "len_max", plddt_min: "plddt_min", clash_max: "clash_max",
  novelty_max: "tm_max", overlap_max: "ov_max", shape_agr_min: "agr_min", compactness_min: "cr_min",
  paired_min: "bp_min", fold_size_min: "fold_min", seq_cluster_min: "sclust_min", top_n: "topn", rank: "rank_key" };
const BOOL_MAP = { novel_only: "novel_only", shape_only: "shape_ok", require_tertiary: "req_tert", require_rare: "req_rare", only_with_tm: "tm_has", per_letter: "per_letter" };
function applyFilters(obj) {
  obj = obj || {};
  const set = (id, v) => { const el = $(id); if (!el) return; if (el.type === "checkbox") el.checked = !!v; else el.value = v; };
  for (const k in obj) {
    if (k in FILTER_MAP) set(FILTER_MAP[k], obj[k]);
    else if (k in BOOL_MAP) set(BOOL_MAP[k], obj[k]);
    else if (k === "pseudoknot") set("pk", obj[k] === true ? "1" : obj[k] === false ? "0" : String(obj[k]));
    else if (k === "search") set("search", obj[k]);
    else if (k === "motifs") { const want = new Set((obj[k] || []).map(String)); document.querySelectorAll(".mf").forEach((c) => { c.checked = want.has(c.value); }); }
    else if (k === "letters") { const want = new Set((obj[k] || []).map(String)); document.querySelectorAll(".lf").forEach((c) => { c.checked = want.has(c.value); }); }
  }
  sortOverride = null; syncLabels(); saveState(); render();
  return lastRows.length;
}
function fieldStats(field, over) {
  const data = (over === "all" ? FOLDS : lastRows).map((f) => f[field]).filter((v) => v != null && v !== "");
  if (!data.length) return { field, n: 0 };
  if (typeof data[0] === "number") {
    const s = [...data].sort((a, b) => a - b), lo = s[0], hi = s[s.length - 1], mean = s.reduce((a, b) => a + b, 0) / s.length;
    const nb = 20, w = (hi - lo) / nb || 1, hist = Array.from({ length: nb }, (_, i) => ({ x0: +(lo + i * w).toFixed(3), count: 0 }));
    s.forEach((v) => { hist[Math.min(nb - 1, Math.floor((v - lo) / w))].count++; });
    return { field, n: s.length, min: lo, max: hi, mean: +mean.toFixed(4), median: s[s.length >> 1], histogram: hist };
  }
  const counts = {}; data.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
  return { field, n: data.length, counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40)) };
}
window.AtlasAPI = {
  setView,
  setColorBy: (f) => { if ($("map_color")) { $("map_color").value = f; if (viewMode === "map") renderMap(lastRows); } },
  applyFilters,
  resetFilters: () => { $("reset").click(); return lastRows.length; },
  selectFold: (id) => { const f = foldById(id); if (!f) return false; openDeep(id); return true; },
  getResults: (limit, fields) => {
    const def = ["id", "name", "letter", "length", "plddt", "best_tm1", "near", "rna_type", "rfam_id", "rfam_name",
      "fold_size", "global_fold_id", "seq_cluster_size", "contact_ratio", "bp_fraction", "pseudoknot", "n_tert", "n_rare",
      "shape_ok", "shape_agr", "is_novel_v341", "motifs", "ex", "ey"];
    const ks = fields && fields.length ? fields : def;
    return lastRows.slice(0, limit || 50).map((f) => { const o = {}; ks.forEach((k) => { if (f[k] !== undefined) o[k] = f[k]; }); return o; });
  },
  fieldStats,
  getState: () => ({ shown: lastRows.length, total: FOLDS.length, view: viewMode, sources: activeSources(),
    columns: COLS.map((c) => c[0]), motif_types: MOTIF_SET, letters: LETTERS }),
};

boot();
