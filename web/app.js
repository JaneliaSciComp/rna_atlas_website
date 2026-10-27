// RNA Atlas Explorer — client-side filtering/ranking + lazy deep view.
// Sources are chosen as checkboxes (header "Source" menu) and MERGED: FOLDS is the
// union of every checked dataset, each fold tagged with f._dsid so the deep view can
// dispatch struct/ext/reactivity/motifs per row.
let FOLDS = [], MOTIF_SET = [], LETTERS = [];
let MOTIFS_BY_DS = {}, PAIRING_BY_DS = {}, TSPANS_BY_DS = {};  // {dsid: {foldId: ...}} — only motif-bearing datasets populate these
let sortOverride = null;  // {key, dir} from header click
const DATASETS = window.DATASETS || [{ id: "ribo2", label: "curated", base: "", ext: "cif", react: true, motifs: true }];
const DSBYID = {}; DATASETS.forEach((d) => { DSBYID[d.id] = d; });
const LOADED = {};        // dsid -> {folds, motifs, pairing} cache (loaded once)
function dsFor(f) { return DSBYID[f._dsid] || DATASETS[0]; }
// Per-fold struct/react filenames: every dataset except the base ribo2 (A-H) names files by
// `key` (a hashed id); ribo2 itself never got a key-based build and still uses raw `id` — so
// `f.key` can't be used as a blanket "prefer key" fallback now that ribo2 records also carry
// a `key` field (added for clustering, not file naming).
function fileStem(f, ds) { return (ds.id !== "ribo2" && f.key) ? f.key : f.id; }
// ---------------- multi-structure datasets (T-0367) ----------------
// A registry entry with `multi: {samples, methods:[{id,label,frame,note}]}` says every record carries several
// structures: structs/<key>__<method>__s<k>.<ext> (k = 0..samples-1), a lazy data/samples/<key>.json with the
// per-sample fields (dot-bracket, confidence, reactivity agreement) and a react/<key>.json over the whole
// construct (seq311 + design_start/design_end) that a "design240" frame slices to the design window. The
// record's `methods` summary ({<m>: {best:{react,ranking,plddt}, plddt, ranking_score, shape_agr}}) and its
// `default` ({method, sample}) let the pickers render before the lazy file arrives. First user: openknot_r9.
const MULTI_BESTBY = [["react", "reactivity agreement"], ["ranking", "ranking score"], ["plddt", "mean pLDDT"]];
const MULTI_KEY = "atlas_multi";
function multiOf(ds) { const m = ds && ds.multi; return (m && Array.isArray(m.methods) && m.methods.length) ? m : null; }
// Method, best-by and compare stick across folds (a reader browsing Protenix wants Protenix on the next design
// too); the explicit sample does not: openDeep() resets it to "best".
let multiSel = (() => {
  const d = { method: null, sample: "best", bestBy: "react", compare: false, cmpMode: "side" };
  try { Object.assign(d, JSON.parse(localStorage.getItem(MULTI_KEY) || "{}")); } catch (e) {}
  d.sample = "best";
  if (!MULTI_BESTBY.some((b) => b[0] === d.bestBy)) d.bestBy = "react";
  if (d.cmpMode !== "overlay") d.cmpMode = "side";
  d.compare = !!d.compare;
  if (typeof d.method !== "string") d.method = null;
  return d;
})();
function saveMultiSel() { try { localStorage.setItem(MULTI_KEY, JSON.stringify({ method: multiSel.method, bestBy: multiSel.bestBy, compare: multiSel.compare, cmpMode: multiSel.cmpMode })); } catch (e) {} }
function bestByLabel(by) { const b = MULTI_BESTBY.find((x) => x[0] === by); return b ? b[1] : String(by || ""); }
// Which sample a method shows under a Best-by rule, read from the build's precomputed best indices:
// react -> ranking -> sample 0, each fallback with the note users see.
function resolveBest(mblock, bestBy, mdef) {
  const best = (mblock && mblock.best) || {};
  const has = (v) => Number.isInteger(v) && v >= 0;
  const who = (mdef && (mdef.label || mdef.id)) || "this method";
  if (bestBy === "react") {
    if (has(best.react)) return { k: best.react, by: "react", note: "" };
    if (has(best.ranking)) return { k: best.ranking, by: "ranking", note: "no reactivity for this design: best by ranking score" };
    return { k: 0, by: null, note: "no reactivity for this design and no confidence for " + who + ": showing sample 1" };
  }
  if (has(best[bestBy])) return { k: best[bestBy], by: bestBy, note: "" };
  return { k: 0, by: null, note: "no confidence for " + who + ": showing sample 1" };
}
// The structure a fold shows: {multi, mdef, method, k, by, note, frame, nS}, or null for a one-structure dataset.
// `method` / `sample` override the current selection (the compare cells ask for each method's best).
function multiCurrent(f, method, sample) {
  const ds = dsFor(f), multi = multiOf(ds);
  if (!multi) return null;
  const ids = multi.methods.map((m) => m.id);
  const dflt = (f.default && ids.includes(f.default.method)) ? f.default.method : ids[0];
  const want = method || multiSel.method;
  const mid = ids.includes(want) ? want : dflt;
  const mdef = multi.methods.find((m) => m.id === mid);
  const mblock = (f.methods || {})[mid] || {};
  const nS = Math.max(1, (multi.samples | 0) || 5);
  const sel = sample === undefined ? multiSel.sample : sample;
  let r;
  if (sel === "best" || sel == null) r = resolveBest(mblock, multiSel.bestBy, mdef);
  else r = { k: Math.max(0, Math.min(nS - 1, sel | 0)), by: null, note: "" };
  return { multi, mdef, method: mid, k: r.k, by: r.by, note: r.note, frame: mdef.frame === "construct311" ? "construct311" : "design240", nS };
}
// cif vs pdb from the text itself (the fetch carries no usable type)
function structFmt(text) { return (text.startsWith("data_") || text.includes("_atom_site")) ? "cif" : "pdb"; }
function multiStructPath(f, ds, method, k) { return prefix(ds) + "structs/" + fileStem(f, ds) + "__" + method + "__s" + k + "." + (ds.ext || "pdb"); }
function structPath(f, ds) {
  const cur = multiCurrent(f);
  return cur ? multiStructPath(f, ds, cur.method, cur.k) : prefix(ds) + "structs/" + fileStem(f, ds) + "." + (ds.ext || "cif");
}
// A multi dataset's react file covers the whole construct; a design240 structure gets the design window
// [design_start, design_end), a construct311 one the full arrays. Legacy {seq, a23, dms, sn[]} files pass through.
function reactForFrame(raw, frame) {
  if (!raw || (!raw.seq311 && raw.design_start == null)) return raw || null;
  const full = raw.seq311 || "";
  const n = full.length || (raw.a23 || raw.dms || []).length;
  let s = 0, e = n;
  if (frame !== "construct311" && raw.design_start != null && raw.design_end != null) { s = Math.max(0, raw.design_start | 0); e = Math.min(n, raw.design_end | 0); }
  const cut = (a) => (Array.isArray(a) ? a.slice(s, e) : null);
  const sn = Array.isArray(raw.sn) ? raw.sn : (raw.sn ? [raw.sn.dms == null ? null : raw.sn.dms, raw.sn.a23 == null ? null : raw.sn.a23] : null);
  // `frame` records which window this is; everything else is the legacy shape the drawing code reads
  return { seq: full.slice(s, e), a23: cut(raw.a23), dms: cut(raw.dms), a23_err: cut(raw.a23_err), dms_err: cut(raw.dms_err), sn, frame: frame === "construct311" ? "construct311" : "design240" };
}
// the per-sample record (from the lazy samples file) of the OPEN fold; null until that file is in
function sampleOf(f, method, k) {
  const S = currentDeep && currentDeep.f === f && currentDeep.samples;
  const m = S && S[method];
  return (m && Array.isArray(m.samples) && m.samples[k]) || null;
}
// dot-bracket of a shown sample: the samples file's, else derived once from its 3D (ss.js deriveSS)
function sampleDbn(f, method, k, structText) {
  const s = sampleOf(f, method, k);
  if (s && s.dbn) return s.dbn;
  if (structText && typeof deriveSS === "function") {
    const cache = (currentDeep && currentDeep.f === f) ? (currentDeep._dbnDerived = currentDeep._dbnDerived || {}) : {};
    const key = method + "/" + k;
    if (!(key in cache)) { try { cache[key] = deriveSS(structText).dbn || ""; } catch (e) { cache[key] = ""; } }
    return cache[key];
  }
  return "";
}
// what the pairing track, the "pairing" colouring, the 2D and the export use: the shown sample's dot-bracket
// for a multi dataset, the dataset-wide pairing.json otherwise
function dbnFor(f) {
  const cur = multiCurrent(f);
  if (!cur) return (PAIRING_BY_DS[f._dsid] || {})[f.id] || "";
  const sel = currentDeep && currentDeep.f === f && currentDeep.structSel;
  const st = (sel && sel.method === cur.method && sel.k === cur.k) ? currentDeep.structText : null;
  return sampleDbn(f, cur.method, cur.k, st);
}
// share-link state for the pickers (fullSnapshot / enterState)
function multiShareState() { return { method: multiSel.method, sample: multiSel.sample, bestBy: multiSel.bestBy, compare: multiSel.compare, cmpMode: multiSel.cmpMode }; }
function applyMultiState(m) {
  if (!m || typeof m !== "object") return;
  if (typeof m.method === "string" || m.method === null) multiSel.method = m.method;
  if (m.sample === "best" || (Number.isInteger(m.sample) && m.sample >= 0)) multiSel.sample = m.sample;
  if (MULTI_BESTBY.some((b) => b[0] === m.bestBy)) multiSel.bestBy = m.bestBy;
  if (typeof m.compare === "boolean") multiSel.compare = m.compare;
  if (m.cmpMode === "side" || m.cmpMode === "overlay") multiSel.cmpMode = m.cmpMode;
}
// Companion datasets share a parent source's checkbox + per-letter filter and load lazily.
function companionsOf(srcId) { return DATASETS.filter((d) => d.parent === srcId); }
function companionLetterSet() { return new Set(DATASETS.filter((d) => d.parent).flatMap((d) => d.letters || [])); }
function checkedLetters() { return new Set([...document.querySelectorAll(".lf:checked")].map((c) => c.value)); }
// Companions (of active sources) not yet loaded whose declared letters are currently enabled.
function neededCompanions() {
  const on = checkedLetters();
  return activeSources().flatMap(companionsOf)
    .filter((c) => !LOADED[c.id] && (c.letters || []).some((l) => on.has(l)))
    .map((c) => c.id);
}
const COND_LABELS = { msa: "MSA", tbm: "TBM (template-based)", chemmap: "chemmap input (SHAPE-guided)", exp: "experimental (PDB)" };
function condLabel(cond) { const t = cond || []; return t.length ? t.map((x) => COND_LABELS[x] || x).join(", ") : "sequence-only (unconditioned)"; }
function prefix(ds) { return ds && ds.base ? ds.base + "/" : ""; }
function activeSources() { return [...document.querySelectorAll(".src:checked")].map((c) => c.value); }

// Data source: "" = same origin (local serve.py). Otherwise a CloudFront URL fronting the S3
// data; access is enforced at the edge (Cognito), not by this client.
const DATA_BASE = (window.DATA_BASE || "").replace(/\/$/, "");
function durl(path) { return DATA_BASE ? `${DATA_BASE}/${path}` : path; }
async function getJSON(path) {
  // no-cache: always revalidate with the origin (conditional request) so a data update after a
  // deploy is picked up without a manual hard-refresh (data files carry no cache-control header).
  const r = await fetch(durl(path), { cache: "no-cache" });
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
  "ov_max", "shape_ok", "agr_min", "cr_min", "bp_min", "cf_min", "fold_min", "sclust_min", "req_tert", "req_rare", "motif_mode", "pk", "termini", "overhang_max", "uucg", "rank_key", "topn", "per_letter", "alt_palette", "color_by", "ss_view"];
const altPalette = () => !!($("alt_palette") && $("alt_palette").checked);
// Sublibraries menu: all present sublibraries are ON by default; we persist only the ones the
// user has explicitly turned OFF, so newly-appearing sublibraries (from a new source) start ON.
let SUBLIB_OFF = new Set();
function snapshot() {
  const s = {};
  FIELD_IDS.forEach((id) => { const el = $(id); if (el) s[id] = el.type === "checkbox" ? el.checked : el.value; });
  s.mf = [...document.querySelectorAll(".mf:checked")].map((c) => c.value);
  s.lf = [...document.querySelectorAll(".lf:checked")].map((c) => c.value);
  s.cf = [...document.querySelectorAll(".cf:checked")].map((c) => c.value);
  s.sfx = [...SUBLIB_OFF];
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
  if (s.cf) document.querySelectorAll(".cf").forEach((c) => { c.checked = s.cf.includes(c.value); });
  if (s.sfx) { SUBLIB_OFF = new Set(s.sfx); document.querySelectorAll(".sf").forEach((c) => { c.checked = !SUBLIB_OFF.has(c.value); }); updateSublibBtn(); }
  sortOverride = s.sort || null;
  if (s.collapsed) { const fs = document.querySelectorAll("#config fieldset"); s.collapsed.forEach((i) => fs[i] && fs[i].classList.add("collapsed")); }
  if (s.allcollapsed) $("config").classList.add("allcollapsed");
}
function saveState() { try { localStorage.setItem(FKEY, JSON.stringify(snapshot())); } catch (e) {} updateShareUI(); }
function loadState() { try { return JSON.parse(localStorage.getItem(FKEY) || "null"); } catch (e) { return null; } }

// --- shareable view-state links (Neuroglancer-style): the full view state is JSON-encoded into
// the URL hash fragment. The fragment is never sent in an HTTP request, so this needs zero backend
// support on this static site, and there's no server-side URL-length limit to worry about.
const HKEY = "state";
let PENDING_STATE = null;   // a decoded #state=/localStorage snapshot waiting to be applied by the first loadSources()
function fullSnapshot() {
  // snapshot() covers filters/sources/sort/collapsed; add the bits it doesn't track.
  const s = snapshot();
  s.view = viewMode;
  if ($("map_color")) s.map_color = $("map_color").value;
  s.mapT = mapT;
  if (currentDeep && currentDeep.f) { s.deep = currentDeep.f._uid; if (multiOf(dsFor(currentDeep.f))) s.multi = multiShareState(); }   // T-0367: method/sample/best-by/compare travel with the link
  return s;
}
function decodeHashState() {
  const h = location.hash.slice(1);
  if (!h.startsWith(HKEY + "=")) return null;
  try { return JSON.parse(decodeURIComponent(h.slice(HKEY.length + 1))); } catch (e) { return null; }
}
function updateShareUI() {
  try { history.replaceState(null, "", "#" + HKEY + "=" + encodeURIComponent(JSON.stringify(fullSnapshot()))); } catch (e) {}
}
let _shareTimer = null;
// debounced variant for high-frequency changes (map drag/zoom) so we're not rewriting the address
// bar on every mousemove — the eventual state is identical either way, just less thrashy.
function scheduleShareUpdate() { clearTimeout(_shareTimer); _shareTimer = setTimeout(updateShareUI, 300); }

function copyShareLink() {
  clearTimeout(_shareTimer);
  updateShareUI();   // flush any pending debounced change so the copied link is exactly current
  const url = location.href;
  const flash = () => {
    const b = $("share-btn"); if (!b) return;
    const prev = b.innerHTML;
    b.innerHTML = "&#10003; Copied!"; b.classList.add("copied");
    setTimeout(() => { b.innerHTML = prev; b.classList.remove("copied"); }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(flash).catch(() => legacyCopy(url, flash));
  } else {
    legacyCopy(url, flash);
  }
}
function legacyCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
  if (done) done();
}

async function boot() {
  buildSourcePanel();
  wireSourceUI();
  wireStatic();
  // Pasting a link that only differs in the hash (same path) into an ALREADY-OPEN tab does not
  // reload the page — the browser just fires hashchange. Without this listener that link would
  // silently do nothing there, even though opening it in a fresh tab works fine.
  window.addEventListener("hashchange", onHashChange);
  // initial state: a shared #state= link (if present) wins over the locally-persisted one —
  // opening someone else's link should show THEIR view, not silently fall back to your last session.
  await enterState(decodeHashState() || loadState());
}
let _applyingHash = false;
async function onHashChange() {
  if (_applyingHash) return;                // our own updateShareUI() uses replaceState, which never
  const s = decodeHashState();               // fires hashchange, so this only runs for genuine external
  if (!s) return;                            // navigations (pasted link, edited address bar, etc.)
  _applyingHash = true;
  try { await enterState(s); } finally { _applyingHash = false; }
}
// Drives the app to a given snapshot: source/letter selection (re-fetching any newly-needed
// dataset), all filters, and the parts snapshot()/applyState() don't cover (view mode, map
// color-by + pan/zoom, the open deep-view fold). Shared by boot() and onHashChange() so a pasted
// link is applied identically whether it's the first load or a live navigation.
async function enterState(initial) {
  PENDING_STATE = initial;
  const saved = initial && initial.src;
  document.querySelectorAll(".src").forEach((c) => {
    c.checked = (saved && saved.length) ? saved.includes(c.value) : (c.value === DATASETS[0].id);
  });
  toggleLetterVisibility(); updateSourceBtn();
  await loadSources();
  if (initial && initial.map_color && $("map_color")) $("map_color").value = initial.map_color;
  if (initial && initial.mapT) mapT = initial.mapT;
  setView((initial && initial.view) || "table");
  if (initial && initial.multi) applyMultiState(initial.multi);          // T-0367: before openDeep, which reads it
  if (initial && initial.deep) await openDeep(initial.deep, { keepSample: !!(initial.multi && (initial.multi.sample === "best" || Number.isInteger(initial.multi.sample))) });
  else if (currentDeep) closeDeep();
  updateShareUI();   // normalize the address bar to whatever we actually ended up showing
}

function buildSourcePanel() {
  // Companion datasets (d.parent) don't get their own row — they ride the parent source.
  // The first motif-bearing source gets the nested per-letter checkboxes (#letter_filter).
  let letterAttached = false;
  $("source-panel").innerHTML = DATASETS.filter((d) => !d.parent).map((d) => {
    const row = `<label class="srcrow"><input type="checkbox" class="src" value="${d.id}">${d.label}</label>`;
    if (d.motifs && !letterAttached) { letterAttached = true; return row + `<div id="letter_filter" class="letters srcsub"></div>`; }
    return row;
  }).join("");
}

function wireSourceUI() {
  $("source-btn").addEventListener("click", (e) => { e.stopPropagation(); $("source-panel").classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!$("sourcewrap").contains(e.target)) $("source-panel").classList.add("hidden"); });
  document.querySelectorAll(".src").forEach((c) =>
    c.addEventListener("change", () => { toggleLetterVisibility(); updateSourceBtn(); saveState(); loadSources(); }));
  // Sublibraries menu (sibling of Source): toggle + close on outside click + all/none shortcuts.
  $("sublib-btn").addEventListener("click", (e) => { e.stopPropagation(); $("sublib-panel").classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!$("sublibwrap").contains(e.target)) $("sublib-panel").classList.add("hidden"); });
  $("sublib-all").addEventListener("click", () => {
    SUBLIB_OFF.clear();
    document.querySelectorAll(".sf").forEach((c) => c.checked = true);
    updateSublibBtn(); saveState(); render();
  });
  $("sublib-none").addEventListener("click", () => {
    document.querySelectorAll(".sf").forEach((c) => { c.checked = false; SUBLIB_OFF.add(c.value); });
    updateSublibBtn(); saveState(); render();
  });
  // Delegated so it survives buildSublibFilter() rebuilds (the checkboxes are re-created each time).
  $("sublib_filter").addEventListener("change", (e) => {
    const c = e.target; if (!c.classList || !c.classList.contains("sf")) return;
    if (c.checked) SUBLIB_OFF.delete(c.value); else SUBLIB_OFF.add(c.value);
    updateSublibBtn(); saveState(); render();
  });
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
  const dcond = ds.cond || [];
  folds.forEach((f) => { f._dsid = dsid; f._cond = f.conditioning || f.cond || dcond; f._uid = dsid + "|" + f.id; });
  let motifs = {}, pairing = {}, tspans = {};
  if (ds.motifs) {
    try { motifs = await getJSON(prefix(ds) + "data/motifs.json"); } catch (e) {}
    try { pairing = await getJSON(prefix(ds) + "data/pairing.json"); } catch (e) {}
    try { tspans = await getJSON(prefix(ds) + "data/tertiary_spans.json"); } catch (e) {}
  }
  LOADED[dsid] = { folds, motifs, pairing, tspans };
}

function showLoadError(msg) { const e = $("load-error"); e.textContent = msg; e.classList.remove("hidden"); }
function clearLoadError() { $("load-error").classList.add("hidden"); }

async function loadSources() {
  const active = activeSources();
  const comps = active.flatMap(companionsOf);                 // companions of active sources
  // A companion loads once any of its declared letters is enabled (persisted lf, or current DOM).
  const st = PENDING_STATE || loadState() || {};
  const onLetters = new Set([...(Array.isArray(st.lf) ? st.lf : []), ...checkedLetters()]);
  const compLoad = comps.filter((c) => (c.letters || []).some((l) => onLetters.has(l))).map((c) => c.id);
  const toLoad = [...active, ...compLoad];
  try {
    for (const id of toLoad) await ensureLoaded(id);
  } catch (e) {
    showLoadError("Could not load data (" + (e.status || "network") + "). Try reloading the page.");
    throw e;
  }
  clearLoadError();
  FOLDS = []; MOTIFS_BY_DS = {}; PAIRING_BY_DS = {}; TSPANS_BY_DS = {}; FBYK = {};
  for (const id of toLoad) {
    const L = LOADED[id]; if (!L) continue;
    FOLDS = FOLDS.concat(L.folds);
    MOTIFS_BY_DS[id] = L.motifs; PAIRING_BY_DS[id] = L.pairing; TSPANS_BY_DS[id] = L.tspans || {};
  }
  const ms = new Set(), ls = new Set();
  for (const f of FOLDS) {
    (f.motifs || []).forEach((m) => ms.add(m));
    if (DSBYID[f._dsid] && DSBYID[f._dsid].motifs && f.letter) ls.add(f.letter);  // letters only from motif-bearing source
  }
  // Show companion letters (e.g. I–Q) as checkboxes even before their data is loaded.
  comps.forEach((c) => (c.letters || []).forEach((l) => ls.add(l)));
  MOTIF_SET = [...ms].sort();
  LETTERS = [...ls].sort();
  $("len_max").value = 2000;   // default length-max cap (raise the field to see longer folds)
  const maxCR = Math.max(1, ...FOLDS.map((f) => f.contact_ratio || 0));
  $("cr_min").max = Math.ceil(maxCR * 20) / 20;
  buildMotifFilter();
  buildLetterFilter();
  wireDynamic();
  applyState(PENDING_STATE || loadState());
  buildSublibFilter();   // after applyState so it scopes to the restored letter + SUBLIB_OFF state
  toggleLetterVisibility();
  syncLabels();
  render();
  // Only the very first load (boot, possibly from a shared link) replays a pending snapshot;
  // later reloads (user toggling a source checkbox) should reflect live state, not repeat it.
  PENDING_STATE = null;
}

function buildMotifFilter() {
  $("motif_filter").innerHTML = MOTIF_SET.map((m) =>
    `<label><input type="checkbox" class="mf" value="${m}">` +
    `<span class="motif-chip" style="background:${motifColor(m)}">${m.replace(/_/g, " ").toLowerCase()}</span></label>`
  ).join("");
}
function buildLetterFilter() {
  // Companion letters (I–Q) start UNCHECKED so the default view stays A–H (fast); enabling one
  // lazily loads that companion's data. A–H (loaded) start checked.
  const comp = companionLetterSet();
  const hasComp = LETTERS.some((l) => comp.has(l));
  $("letter_filter").innerHTML = LETTERS.map((l) =>
    `<label${comp.has(l) ? ' class="lf-opt" title="curated I–Q · chemmap pseudolabel · loads on first use"' : ""}>` +
    `<input type="checkbox" class="lf" value="${l}"${comp.has(l) ? "" : " checked"}>${l}</label>`).join("") +
    (hasComp ? `<div class="lf-note">I–Q = curated novel folds (chemmap pseudolabel) · load on demand</div>` : "");
}

// Sublibraries menu — repopulated from the distinct `sublibrary` values in the currently-loaded
// sources (tracks the source selection). All present sublibraries default ON; only user-turned-OFF
// ones (SUBLIB_OFF) start unchecked, so a newly-appearing sublibrary starts ON. The whole menu
// button hides when the active sources have no sublibraries.
function buildSublibFilter() {
  const el = $("sublib_filter"); if (!el) return;
  // Prefer the sublibraries of the CURRENTLY-CHECKED letters (enabling one I–Q letter loads the whole
  // I–Q dataset, so scoping keeps the list to the selected letters). Fall back to ALL loaded
  // sublibraries if that scope is momentarily empty, so the menu never vanishes when data has them.
  const all = [...new Set(FOLDS.map((f) => f.sublibrary).filter(Boolean))];
  const letters = new Set([...document.querySelectorAll(".lf:checked")].map((c) => c.value));
  const inScope = (f) => !(DSBYID[f._dsid] && DSBYID[f._dsid].motifs && f.letter && !letters.has(f.letter));
  let subs = [...new Set(FOLDS.filter(inScope).map((f) => f.sublibrary).filter(Boolean))];
  if (!subs.length) subs = all;
  subs.sort();
  el.innerHTML = subs.map((s) =>
    `<label><input type="checkbox" class="sf" value="${esc(s)}"${SUBLIB_OFF.has(s) ? "" : " checked"}>${esc(s)}</label>`).join("");
  const wrap = $("sublibwrap"); if (wrap) wrap.style.display = all.length ? "" : "none";
  updateSublibBtn();
}
function updateSublibBtn() {
  const btn = $("sublib-btn"); if (!btn) return;
  const boxes = [...document.querySelectorAll(".sf")];
  const on = boxes.filter((c) => c.checked).length;
  btn.innerHTML = `Sublibraries${boxes.length && on < boxes.length ? ` (${on}/${boxes.length})` : ""} &#9662;`;
}

function wireDynamic() {
  document.querySelectorAll(".mf").forEach((c) =>
    c.addEventListener("change", () => { saveState(); render(); }));
  document.querySelectorAll(".lf").forEach((c) => c.addEventListener("change", onLetterChange));
}
// A letter toggle: if it enables a not-yet-loaded companion (I–Q), lazily load it, else just render.
async function onLetterChange() {
  saveState();
  if (neededCompanions().length) {
    const note = document.querySelector(".lf-note");
    if (note) { note.textContent = "loading I–Q folds…"; note.classList.add("loading"); }
    await loadSources();   // rebuilds the letter filter (and note) when done
  } else { buildSublibFilter(); render(); }
}

function wireStatic() {
  document.querySelectorAll("#config input:not(.mf):not(.lf), #config select").forEach((el) =>
    el.addEventListener("input", () => { syncLabels(); saveState(); render(); }));
  $("reset").addEventListener("click", () => {
    // Reset argument filters only — leave the source/letter selection and the Sublibrary
    // checkboxes intact (those are "what data is shown", not a filter argument).
    document.querySelectorAll(".mf").forEach((c) => c.checked = false);
    document.querySelectorAll(".cf").forEach((c) => c.checked = false);
    ["plddt_min", "tm_max", "ov_max"].forEach((id) => $(id).value = $(id).max);
    $("agr_min").value = -1;
    $("plddt_min").value = 0; $("clash_max").value = 9999; $("len_min").value = 0;
    $("len_max").value = 2000;
    ["shape_ok", "req_tert", "req_rare", "tm_has", "novel_only", "per_letter"].forEach((id) => $(id).checked = false);
    $("cr_min").value = 0; $("bp_min").value = 0; $("cf_min").value = 0;
    if ($("fold_min")) $("fold_min").value = 0; if ($("sclust_min")) $("sclust_min").value = 0;
    $("pk").value = "any";
    $("rank_key").value = "best_tm1:asc"; $("topn").value = 200;
    if ($("color_by")) $("color_by").value = "a23";
    if ($("motif_mode")) $("motif_mode").value = "any";
    if ($("ss_view")) $("ss_view").value = "proj";
    if ($("search")) $("search").value = "";
    sortOverride = null; saveState(); syncLabels(); render();
  });
  if ($("search")) $("search").addEventListener("input", () => { saveState(); render(); });
  if ($("alt_palette")) $("alt_palette").addEventListener("change", () => { if (currentDeep) { drawTracks(currentDeep.f, currentDeep.react); load3D(currentDeep.f, currentDeep.react); } });
  if ($("color_by")) $("color_by").addEventListener("change", () => { if ($("deep_color_by")) $("deep_color_by").value = $("color_by").value; if (currentDeep) load3D(currentDeep.f, currentDeep.react); });
  if ($("deep_color_by")) $("deep_color_by").addEventListener("change", () => { if ($("color_by")) $("color_by").value = $("deep_color_by").value; saveState(); if (currentDeep) load3D(currentDeep.f, currentDeep.react); });
  if ($("ss_view")) $("ss_view").addEventListener("change", () => { if ($("deep_ss_view")) $("deep_ss_view").value = $("ss_view").value; if (currentDeep) drawTracks(currentDeep.f, currentDeep.react); });
  if ($("deep_ss_view")) $("deep_ss_view").addEventListener("change", () => { if ($("ss_view")) $("ss_view").value = $("deep_ss_view").value; saveState(); if (currentDeep) drawTracks(currentDeep.f, currentDeep.react); });
  initProjDrag();   // drag the 2D projection to rotate (drives the 3D + gallery)
  // collapsible sections (click a legend) + collapse-all (click the panel heading)
  document.querySelectorAll("#config fieldset legend").forEach((lg) =>
    lg.addEventListener("click", () => { lg.parentElement.classList.toggle("collapsed"); saveState(); }));
  const h2 = document.querySelector("#config h2");
  if (h2) h2.addEventListener("click", () => { $("config").classList.toggle("allcollapsed"); saveState(); });
  $("deep-close").addEventListener("click", closeDeep);
  wireMultiBar();                                             // T-0367 pickers (delegated; the bar is re-rendered per fold)
  if ($("deep-export")) $("deep-export").addEventListener("click", exportFold);
  if ($("deep-vtoggle")) { markDeepEngine(); $("deep-vtoggle").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setDeepEngine(b.dataset.v))); }
  $("deep").addEventListener("click", (e) => { if (e.target.id === "deep") closeDeep(); });
  document.querySelectorAll('#layoutctl button[data-mode]').forEach((b) =>
    b.addEventListener("click", () => setDeepMode(b.dataset.mode)));
  if ($("deep-pano")) $("deep-pano").addEventListener("click", () => {
    setDeepMode(currentMode() === "panoramic" ? "modal" : "panoramic");
    // re-render for the new layout: 3D switches between single viewer and the per-channel
    // gallery; tracks/2D reflow (fluid SVGs); the reactivity <canvas> must be re-sized.
    if (currentDeep) { load3D(currentDeep.f, currentDeep.react); drawTracks(currentDeep.f, currentDeep.react); drawReactChart(currentDeep.f, currentDeep.react); }
  });
  document.querySelectorAll('#viewctl button[data-view]').forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view)));
  if ($("share-btn")) $("share-btn").addEventListener("click", copyShareLink);
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
  $("cf_min_v").textContent = (+$("cf_min").value).toFixed(2);
}

function filters() {
  const lf = [...document.querySelectorAll(".lf:checked")].map((c) => c.value);
  const mf = [...document.querySelectorAll(".mf:checked")].map((c) => c.value);
  const cf = [...document.querySelectorAll(".cf:checked")].map((c) => c.value);
  return {
    q: ($("search") ? $("search").value : "").trim().toLowerCase(),
    lmin: +$("len_min").value, lmax: +$("len_max").value,
    plddt: +$("plddt_min").value, clash: +$("clash_max").value,
    tmax: +$("tm_max").value, tmhas: $("tm_has").checked, novelOnly: $("novel_only").checked,
    ovmax: +$("ov_max").value,
    shape: $("shape_ok").checked, agr: +$("agr_min").value,
    crmin: +$("cr_min").value, bpmin: +$("bp_min").value, cfmin: +$("cf_min").value,
    foldMin: +($("fold_min") ? $("fold_min").value : 0), sclustMin: +($("sclust_min") ? $("sclust_min").value : 0),
    tert: $("req_tert").checked, rare: $("req_rare").checked, motifs: mf,
    motifMode: ($("motif_mode") ? $("motif_mode").value : "any"),
    pk: $("pk").value, sublibOff: SUBLIB_OFF,
    letters: new Set(lf), cond: new Set(cf),
    termini: ($("termini") ? $("termini").value : "any"),
    ohmax: ($("overhang_max") && $("overhang_max").value !== "") ? +$("overhang_max").value : Infinity,
    uucg: $("uucg") ? $("uucg").checked : false,
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
  if (c.cfmin > 0 && (f.crossed_frac == null || f.crossed_frac < c.cfmin)) return false;
  if (c.bpmin > 0 && (f.bp_fraction == null || f.bp_fraction < c.bpmin)) return false;
  if (c.foldMin > 0 && (f.fold_size == null || f.fold_size < c.foldMin)) return false;
  if (c.sclustMin > 0 && (f.seq_cluster_size == null || f.seq_cluster_size < c.sclustMin)) return false;
  if (c.tert && f.n_tert < 1) return false;
  if (c.rare && f.n_rare < 1) return false;
  if (c.motifs.length) { const has = (m) => (f.motifs || []).includes(m); if (c.motifMode === "all" ? !c.motifs.every(has) : !c.motifs.some(has)) return false; }
  if (c.pk !== "any" && String(f.pseudoknot) !== c.pk) return false;
  if (f.sublibrary && c.sublibOff.has(f.sublibrary)) return false;
  if (c.termini === "bp" && f.termini_bp !== 1) return false;
  if (c.termini === "trim" && (f.termini_trim !== 1 || Math.max(f.overhang5 || 0, f.overhang3 || 0) > c.ohmax)) return false;
  if (c.uucg && f.uucg_tetraloop !== 1) return false;
  if (c.cond.size) {
    const tags = f._cond || [];
    const ok = (c.cond.has("none") && tags.length === 0) || tags.some((t) => c.cond.has(t));
    if (!ok) return false;
  }
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

let pageLimit = 0, keepPage = false;
function render() {
  const c = filters();
  if (!keepPage) pageLimit = c.topn;   // filter/sort changes reset paging; showMore() keeps it
  keepPage = false;
  let rows = FOLDS.filter((f) => pass(f, c));
  rows.sort(ranker(c));
  let disp;
  if (c.perLetter) {
    const seen = {};
    disp = rows.filter((f) => { seen[f.letter] = (seen[f.letter] || 0) + 1; return seen[f.letter] <= pageLimit; });
  } else {
    disp = rows.slice(0, pageLimit);
  }
  lastRows = disp;
  const total = rows.length;
  $("count").textContent = disp.length < total ? `${disp.length} of ${total} shown` : `${total} shown`;
  if (viewMode === "map") renderMap(disp); else drawTable(disp);
  drawShowMore(disp.length, total);
}
function drawShowMore(shown, total) {
  const el = $("showmore"); if (!el) return;
  if (viewMode === "map" || shown >= total) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = `<button id="more-btn">Show more (+${+$("topn").value || 200})</button>`
    + `<button id="all-btn">Show all (${total})</button><span class="sm-note">showing ${shown} of ${total}</span>`;
  $("more-btn").onclick = () => showMore(false);
  $("all-btn").onclick = () => { if (total > 4000 && !confirm(`Render all ${total} rows? This can be slow.`)) return; showMore(true); };
}
function showMore(all) { pageLimit = all ? Infinity : pageLimit + (+$("topn").value || 200); keepPage = true; render(); }
let viewMode = "table", lastRows = [];

const COLS = [
  ["id", "seq_id"], ["name", "name"], ["source_group", "source"], ["letter", "L"], ["length", "len"], ["plddt", "pLDDT"],
  ["best_tm1", "best_tm1"], ["near", "nearest"], ["overlap_ae", "ovlp_AE"],
  ["shape_ok", "SHAPE"], ["shape_agr", "SHAPE agr"], ["contact_ratio", "compact"], ["bp_fraction", "paired"],
  ["crossed_frac", "crossed"], ["fold_size", "cluster"], ["n_tert", "tert"], ["n_rare", "rare"], ["pseudoknot", "PK"], ["motifs", "motifs"],
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
    return `<tr data-id="${esc(f.id)}" data-uid="${esc(f._uid)}">
      <td>${esc(f.id)}</td><td>${esc(f.name || "")}</td><td>${esc(f.source_group || "")}</td><td>${f.letter ?? ""}</td>
      <td class="num">${f.length ?? ""}</td><td class="num">${plbar}</td>
      <td class="num">${num(f.best_tm1, 3)}</td><td title="${(f.near_title || "").replace(/"/g, "&quot;")}">${f.near || ""}</td>
      <td class="num">${num(f.overlap_ae, 2)}</td><td>${shape}</td>
      <td class="num">${num(f.shape_agr, 2)}</td><td class="num">${num(f.contact_ratio, 2)}</td><td class="num">${num(f.bp_fraction, 2)}</td>
      <td class="num">${num(f.crossed_frac, 2)}</td>
      <td class="num" title="${f.global_fold_id ? "structural fold #" + f.global_fold_id : ""}">${f.fold_size ?? ""}</td>
      <td class="num">${f.n_tert ?? ""}</td><td class="num">${f.n_rare ?? ""}</td>
      <td>${f.pseudoknot ? "&#10003;" : ""}</td><td>${chips}</td></tr>`;
  }).join("");
  $("tbody").innerHTML = body;
  $("tbody").querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => openDeep(tr.dataset.uid)));
}

// ---------------- deep view ----------------
let FBYK = {};
// key by composite _uid (dsid|id) so same-id folds across datasets stay distinct;
// also index plain id (first-wins) as a fallback for external callers (API, links).
function foldById(key) { if (!FBYK[key]) FOLDS.forEach((f) => { FBYK[f._uid] = f; if (!(f.id in FBYK)) FBYK[f.id] = f; }); return FBYK[key]; }

function currentMode() { return localStorage.getItem("atlas_deepmode") || "modal"; }
function updateLayout() {
  const open = !$("deep").classList.contains("hidden");
  const m = currentMode();
  document.body.classList.remove("deepopen-right", "deepopen-bottom");
  if (open && m === "right") document.body.classList.add("deepopen-right");
  if (open && m === "bottom") document.body.classList.add("deepopen-bottom");
  document.querySelectorAll('#layoutctl button[data-mode]').forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  const pb = $("deep-pano"); if (pb) pb.classList.toggle("active", m === "panoramic");
}
function setDeepMode(m) {
  const d = $("deep");
  d.classList.remove("mode-modal", "mode-right", "mode-bottom", "mode-panoramic");
  d.classList.add("mode-" + m);
  localStorage.setItem("atlas_deepmode", m);
  updateLayout();
  if (viewer) { try { viewer.resize(); viewer.render(); } catch (e) {} }
}
function closeDeep() {
  $("deep").classList.add("hidden");
  updateLayout();
  if (_projRaf) { cancelAnimationFrame(_projRaf); _projRaf = 0; }   // don't let a queued proj redraw fire after close
  disposePano();
  loseGL($("viewer3d"));                                            // release WebGL contexts on close
  viewer = null;
  currentDeep = null;
  _openSeq++; _load3DSeq++;                                         // T-0367: an in-flight openDeep/load3D must not repopulate a closed view
  saveState();
}

let _openSeq = 0;
async function openDeep(key, opts) {
  const f = foldById(key);
  if (!f) return;
  const id = f.id;
  const ds = dsFor(f);
  const multi = multiOf(ds);
  // T-0367: a specific sample is a per-design choice (back to Best); method, best-by and compare stick.
  // A shared link that names a sample keeps it (enterState passes keepSample).
  if (multi && !(opts && opts.keepSample)) multiSel.sample = "best";
  const my = ++_openSeq;
  $("deep").classList.remove("hidden");
  setDeepMode(currentMode());
  $("deep-title").textContent = `${id}${f.name ? "  —  " + f.name : ""}`;
  renderMultiBar(multi ? f : null);
  drawProps(f);
  const get = (path) => fetch(durl(path), { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [reactRaw, samples] = await Promise.all([
    ds.react ? get(prefix(ds) + "react/" + fileStem(f, ds) + ".json") : null,
    multi ? get(prefix(ds) + "data/samples/" + fileStem(f, ds) + ".json") : null,   // per-sample block, one lazy file per record
  ]);
  if (my !== _openSeq) return;                                  // another fold opened while these were in flight
  currentDeep = { f, reactRaw, react: null, samples: (samples && samples.methods) ? samples.methods : null, targetDbn: (samples && samples.target_dbn) || null };
  currentDeep.react = multi ? reactForFrame(reactRaw, multiCurrent(f).frame) : reactRaw;
  const react = currentDeep.react;
  if (multi) { renderMultiBar(f); drawProps(f); }               // again, now with the per-sample details
  saveState();
  drawTracks(f, react);
  drawReactChart(f, react);
  load3D(f, react);
}
let currentDeep = null;
let reactChartResizeBound = false;

function drawProps(f) {
  const verdict = f.best_tm1 == null ? "n/a (not scored vs v341)"
    : f.best_tm1 < 0.40 ? "novel" : f.best_tm1 < 0.45 ? "borderline" : "matches known fold";
  const rowsHtml = [
    ...multiPropRows(f),                                       // T-0367: shown structure, per-sample metrics, replicates, target
    ["Source", `${esc(f.source || "")}${f.letter ? ` (lib ${esc(f.letter)})` : ""}`],
    f.source_group ? ["Biological source", esc(f.source_group)] : null,
    ["Sublibrary", f.sublibrary],
    f.rnacentral_id ? ["RNAcentral", `<a href="https://rnacentral.org/rna/${esc(f.rnacentral_id)}" target="_blank" rel="noopener">${esc(f.rnacentral_id)}</a>${f.rnacentral_name ? ` &mdash; ${esc(f.rnacentral_name)}` : ""}`] : null,
    f.rna_type ? ["RNA type", esc(f.rna_type)] : null,
    (f.member_dbs && f.member_dbs.length) ? ["Member databases", f.member_dbs.map(esc).join(", ")] : null,
    f.rfam_id ? ["Rfam family", `<a href="https://rfam.org/family/${esc(f.rfam_id)}" target="_blank" rel="noopener">${esc(f.rfam_id)}</a>${f.rfam_name ? ` &mdash; ${esc(f.rfam_name)}` : ""}`] : null,
    ["Length", `${f.length} nt`],
    (f.true_design_length != null && f.true_design_length !== f.length)
      ? ["True design region", `${f.true_design_length} nt (positions ${f.design_start}–${f.design_end} of the 177-nt construct; the folded model is 5′-padded to ${f.length} nt)`] : null,
    ["pLDDT / gpde", `${num(f.plddt)} / ${num(f.gpde, 3)}`],
    ["Conditioning", condLabel(f._cond)],
    ["Clashscore", num(f.clashscore, 2)],
    ["Novelty (best_tm1 vs v341)", f.best_tm1 == null ? "&mdash;" : `${num(f.best_tm1, 3)} &mdash; ${verdict}`],
    ["Closest known structure (PDB)", `${f.near || "&mdash;"}${f.near_title ? ` &mdash; ${f.near_title}` : ""}${f.best_tm1 != null ? ` &middot; TM₁ ${num(f.best_tm1, 3)}` : ""}`],
    ["Distinct vs A&ndash;E (overlap)", num(f.overlap_ae, 3)],
    ["SHAPE agr (vs 2A3)", `${f.shape_ok ? "yes" : "no"} (SHAPE–pairing agreement = ${num(f.shape_agr, 3)}, + = good; mean prot = ${num(f.mean_prot_2a3, 3)})`],
    (f.pred_pearson_2a3 != null || f.pred_pearson_dms != null) ? ["Prediction fidelity (pred vs real)", `2A3 r=${num(f.pred_pearson_2a3, 2)} / DMS r=${num(f.pred_pearson_dms, 2)} · Spearman 2A3 ${num(f.pred_spearman_2a3, 2)} / DMS ${num(f.pred_spearman_dms, 2)}`] : null,
    ["OpenKnot score", num(f.openknot, 3)],
    (f.designer || f.design_method || f.design_round) ? ["Design",
      [f.design_round && esc(f.design_round),
       f.designer && ("by " + esc(f.designer)),
       f.design_method && ("via " + esc(f.design_method))].filter(Boolean).join(" &middot; ")] : null,
    f.design_title ? ["Design name", esc(f.design_title.length > 80 ? f.design_title.slice(0, 80) + "…" : f.design_title)] : null,
    f.organism ? ["Organism (design source)", esc(f.organism)] : null,
    (f.reads_dms != null || f.reads_2a3 != null) ? ["Read depth (DMS / 2A3)",
      `${f.reads_dms != null ? Math.round(f.reads_dms).toLocaleString() : "&mdash;"} / ${f.reads_2a3 != null ? Math.round(f.reads_2a3).toLocaleString() : "&mdash;"}`]
      : (f.reads != null ? ["Read depth", Math.round(f.reads).toLocaleString()] : null),
    ["Pseudoknot", f.pseudoknot ? "yes" : "no"],
    ["Secondary-structure class", f.ss_class],
    ["5′/3′ termini", f.termini_bp ? "ends base-paired (1↔N)"
      : f.termini_trim ? `ends paired &mdash; trimmable overhangs (5′ ${f.overhang5} nt, 3′ ${f.overhang3} nt)`
      : "ends not directly paired"],
    f.uucg_tetraloop ? ["UUCG tetraloop", "present"] : null,
    ["Compactness (C1′ contact ratio)", num(f.contact_ratio, 3)],
    ["Base-paired fraction", num(f.bp_fraction, 3)],
    ["Tertiary complexity (crossed-pairs)", `${num(f.crossed_frac, 3)}${f.n_crossed_pairs != null ? ` &middot; ${f.n_crossed_pairs} crossed pairs` : ""}`],
    ["MOHCA-regime fraction (25–50 nt)", num(f.mohca_regime_frac, 3)],
    ["Tertiary motifs", `${f.n_tert} (rare ${f.n_rare})`],
    f.global_fold_id ? ["Structural fold (A–H)", `#${f.global_fold_id} &mdash; ${f.fold_size} member${f.fold_size === 1 ? "" : "s"}${f.overlap_global_fold_id ? ` &middot; nearest A–E fold #${f.overlap_global_fold_id}` : ""}`] : null,
    f.global_seq_cluster_id ? ["Sequence cluster (A–H)", `#${f.global_seq_cluster_id} &mdash; ${f.seq_cluster_size} member${f.seq_cluster_size === 1 ? "" : "s"}`] : null,
  ].filter(Boolean);
  const chips = (f.motifs || []).map((m) =>
    `<span class="motif-chip" style="background:${motifColor(m)}">${m.replace(/_/g, " ").toLowerCase()}</span>`).join(" ");
  $("props").innerHTML =
    `<div class="meta-size"><button type="button" onclick="setMetaScale(-1)" title="smaller text">A−</button><button type="button" onclick="setMetaScale(1)" title="larger text">A+</button></div>`
    + "<table>" + rowsHtml.filter(Boolean).map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("")
    + `<tr><td class="muted">Motifs</td><td>${chips}</td></tr></table>`;
  $("props").style.fontSize = metaScale() + "px";
}

function crossedResiSet(f) {
  // crossed (tertiary) residue indices from data/tertiary_spans.json: {seq_id: [[start,end],...]} (1-based incl)
  const set = new Set();
  ((TSPANS_BY_DS[f._dsid] || {})[f.id] || []).forEach(([a, b]) => { for (let r = a; r <= b; r++) set.add(r); });
  return set;
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

// ssPairs / arcDiagram / ssLayout / forna2D (+ deriveSS) now live in the shared web/ss.js
// module (loaded before app.js), so app.js and the /inference page share one implementation.
function drawTracks(f, react) {
  const seq = (react && react.seq) || "";
  const ra = react && (react.a23 || react.dms || react.pred_a23 || react.pred_dms);
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
  const yMot = pad, ySeq = yMot + mh + 4;
  const reactRows = [
    { arr: react && react.dms, label: "DMS" },
    ...(react && react.pred_dms ? [{ arr: react.pred_dms, label: "DMS pred" }] : []),
    { arr: react && react.a23, label: "2A3" },
    ...(react && react.pred_a23 ? [{ arr: react.pred_a23, label: "2A3 pred" }] : []),
  ];
  const hasPred = !!(react && (react.pred_dms || react.pred_a23));
  const yPair = ySeq + 16 + reactRows.length * 16, H = yPair + 18;
  let svg = `<svg width="${W + 40}" height="${H}" viewBox="0 0 ${W + 40} ${H}" preserveAspectRatio="xMinYMin meet" font-size="9">`;
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
    let s = `<text x="${W + 3}" y="${y + 11}" fill="currentColor">${label}</text>`;
    for (let i = 0; i < n; i++) {
      const v = arr ? arr[i] : null;
      s += `<rect x="${i * cw}" y="${y}" width="${cw - 0.5}" height="13" fill="${shapeColor(v)}"><title>${label} ${i + 1}: ${v == null ? "n/a" : (+v).toFixed(2)}</title></rect>`;
    }
    return s;
  };
  let yReact = ySeq + 16;
  reactRows.forEach((row) => { svg += rrow(row.arr, yReact, row.label); yReact += 16; });
  // predicted pairing track: unpaired = light red, paired = white (eyeball SHAPE agreement)
  const dbn = dbnFor(f);                                       // T-0367: the shown sample's for a multi dataset
  let pr = `<text x="${W + 3}" y="${yPair + 11}" fill="currentColor">pair</text>`;
  for (let i = 0; i < n; i++) {
    const ch = dbn[i];
    const paired = ch && ch !== "." && ch !== "-";
    const fill = ch ? (paired ? "#ffffff" : "#f3a0a0") : "#eef2f5";
    pr += `<rect x="${i * cw}" y="${yPair}" width="${cw - 0.5}" height="13" fill="${fill}" stroke="#dfe3e8" stroke-width="0.5"><title>pos ${i + 1}: ${ch ? (paired ? "paired" : "unpaired") : "n/a"}</title></rect>`;
  }
  svg += pr + "</svg>";
  const ssMode = ($("ss_view") ? $("ss_view").value : "proj");
  let ss = "", ssLbl = "";
  if (ssMode === "arc") {
    ss = dbn ? arcDiagram(dbn, n, cw, W) : ""; ssLbl = "arcs link base pairs";
  } else if (ssMode === "proj") {
    const st = currentDeep && currentDeep.structText;
    if (st) {
      if (!currentDeep._proj) currentDeep._proj = projParse(st);
      if (currentDeep._proj) { ss = proj2D(currentDeep._proj, dbn, seq, 340, altPalette(), activeQuat()); ssLbl = "flattened 3D fold — follows the 3D viewer as you rotate it"; }
    }
    if (!ss) { ss = dbn ? forna2D(f.id, dbn, seq, react, 340, altPalette()) : ""; ssLbl = "abstract layout (loading 3D…)"; }
  } else {
    ss = dbn ? forna2D(f.id, dbn, seq, react, 340, altPalette()) : ""; ssLbl = "abstract spring layout — nodes colored by base";
  }
  const hasSS = !!(dbn || (currentDeep && currentDeep.structText));
  const pills = [["proj", "3D projection"], ["forna", "2D layout"], ["arc", "arc"]]
    .map(([m, lbl]) => `<button type="button" class="ss-pill${m === ssMode ? " active" : ""}" onclick="setSSView('${m}')">${lbl}</button>`).join("");
  const ssBlock = hasSS
    ? `<div class="ss-cap">secondary structure <span class="ss-switch">${pills}</span>${ssLbl ? ` <span class="ss-note">${ssLbl}; backbone grey · <span style="color:#7b61ff">base pair</span> · <span style="color:#e83e8c">pseudoknot (dashed)</span></span>` : ""}</div><div class="ss2d${ssMode === "arc" ? " ss2d-arc" : ""}${ssMode === "proj" ? " ss2d-proj" : ""}">${ss || '<span class="muted">no 2D available</span>'}</div>`
    : "";
  const predNote = hasPred ? " &middot; *pred = RNAnix-predicted" : "";
  $("tracks").innerHTML = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">motif lanes &middot; sequence &middot; DMS &middot; 2A3 reactivity (white=protected &rarr; red=reactive) &middot; pairing (white=paired, light red=unpaired)${predNote}</div>` + svg + ssBlock;
}

function drawReactChart(f, react) {
  const el = $("reactchart");
  if (!el) return;
  if (!react || (!react.pred_dms && !react.pred_a23)) { el.innerHTML = ""; return; }
  if (!reactChartResizeBound) {
    window.addEventListener("resize", () => {
      if (currentDeep) drawReactChart(currentDeep.f, currentDeep.react);
    });
    reactChartResizeBound = true;
  }

  el.innerHTML = `
    <div class="reactchart-title">Predicted vs real reactivity</div>
    <div class="reactchart-caption">DMS &mdash; Pearson ${num(f.pred_pearson_dms, 3)} &middot; Spearman ${num(f.pred_spearman_dms, 3)}</div>
    <canvas id="rc_dms"></canvas>
    <div class="reactchart-caption">2A3 &mdash; Pearson ${num(f.pred_pearson_2a3, 3)} &middot; Spearman ${num(f.pred_spearman_2a3, 3)}</div>
    <canvas id="rc_2a3"></canvas>
    <div class="reactchart-legend">
      <span><span class="reactchart-swatch" style="background:#1f77b4"></span>predicted (model)</span>
      <span><span class="reactchart-swatch" style="background:#f59e0b"></span>measured (real)</span>
    </div>`;

  const drawChart = (canvas, pred, exp) => {
    if (!canvas) return;
    const n = (pred && pred.length) || (exp && exp.length) || 0;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!n || !w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 22, padR = 6, padT = 4, padB = 14;
    const plotW = Math.max(1, w - padL - padR), plotH = Math.max(1, h - padT - padB);
    const ymin = -0.5, ymax = 1.5;
    const clip = (v) => Math.max(ymin, Math.min(ymax, v));
    const x = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
    const y = (v) => padT + ((ymax - clip(v)) / (ymax - ymin)) * plotH;

    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(padL, y(0));
    ctx.lineTo(padL + plotW, y(0));
    [0, 1].forEach((v) => {
      const yy = y(v);
      ctx.moveTo(padL - 3, yy);
      ctx.lineTo(padL, yy);
    });
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    ctx.fillStyle = "#6b7280";
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    [0, 1].forEach((v) => ctx.fillText(String(v), padL - 5, y(v)));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("1", padL, padT + plotH + 2);
    if (n > 1) ctx.fillText(String(n), padL + plotW, padT + plotH + 2);

    const line = (arr, color, width) => {
      if (!arr) return;
      ctx.beginPath();
      let drawing = false;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (v === null || v === undefined || Number.isNaN(+v)) { drawing = false; continue; }
        const xx = x(i), yy = y(+v);
        if (!drawing) { ctx.moveTo(xx, yy); drawing = true; }
        else ctx.lineTo(xx, yy);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    line(exp, "#f59e0b", 1.2);
    line(pred, "#1f77b4", 1.4);
  };

  drawChart($("rc_dms"), react.pred_dms, react.dms);
  drawChart($("rc_2a3"), react.pred_a23, react.a23);
}

let viewer = null, viewerModel = null, mstar = null, molstarLoading = null;
let deepEngine = (() => { try { return localStorage.getItem("deep_viewer") || "3dmol"; } catch (e) { return "3dmol"; } })();
function loadMolstarLib() {                          // vendored bundle, shared with web/lib/*
  if (window.molstar) return Promise.resolve();
  if (molstarLoading) return molstarLoading;
  molstarLoading = new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "lib/molstar.css"; document.head.appendChild(css);
    const s = document.createElement("script"); s.src = "lib/molstar.js"; s.onload = () => res(); s.onerror = () => rej(new Error("molstar")); document.head.appendChild(s);
  });
  return molstarLoading;
}
function markDeepEngine() {
  const t = $("deep-vtoggle"); if (t) t.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === deepEngine));
  if ($("color_by")) $("color_by").disabled = (deepEngine === "molstar");   // color-by is 3Dmol-only
  if ($("deep_color_by")) $("deep_color_by").disabled = (deepEngine === "molstar");
}
function setDeepEngine(v) {
  if (v === deepEngine) return;
  deepEngine = v; try { localStorage.setItem("deep_viewer", v); } catch (e) {}
  markDeepEngine();
  if (currentDeep) load3D(currentDeep.f, currentDeep.react);
}
async function renderMolstar(el, data, fmt) {
  try { if (mstar && mstar.dispose) mstar.dispose(); } catch (e) {}
  mstar = null; viewer = null; viewerModel = null; el.innerHTML = "";
  try { await loadMolstarLib(); } catch (e) { el.innerHTML = '<p style="color:#fff;padding:8px">Mol* failed to load.</p>'; return; }
  try {
    mstar = await molstar.Viewer.create(el, { layoutIsExpanded: false, layoutShowControls: true, layoutShowSequence: true, layoutShowLog: false, viewportShowExpand: true });
    await mstar.loadStructureFromData(data, fmt === "cif" ? "mmcif" : "pdb");
  } catch (e) { el.innerHTML = '<p style="color:#fff;padding:8px">Mol* render failed.</p>'; }
}
let _v3dRO = null;
function ensureViewerResizeObserver(el) {            // re-fit the active viewer when #viewer3d is drag-resized
  if (_v3dRO || typeof ResizeObserver === "undefined" || !el) return;
  _v3dRO = new ResizeObserver(() => {
    try { if (viewer && viewer.resize) viewer.resize(); } catch (e) {}
    try { if (mstar && mstar.handleResize) mstar.handleResize(); } catch (e) {}
  });
  _v3dRO.observe(el);
}
// explicitly release the WebGL context(s) in a container before dropping its canvases —
// 3Dmol's clear() keeps the renderer/context alive, so without this, cycling the single
// viewer / gallery leaks contexts until the browser's limit blanks the viewers.
function loseGL(container) {
  if (!container) return;
  container.querySelectorAll("canvas").forEach((cv) => {
    try { const gl = cv.getContext("webgl") || cv.getContext("webgl2"); const ext = gl && gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } catch (e) {}
  });
}
let _load3DSeq = 0;                                                 // T-0367: the pickers reload the SAME fold rapidly; only the newest load may render
async function load3D(f, react) {
  const my = ++_load3DSeq;
  const el = $("viewer3d");
  disposePano();
  loseGL(el);                     // free any live WebGL contexts before we drop the canvases
  el.innerHTML = "";
  el.classList.remove("pano-gallery");
  viewer = null;
  ensureViewerResizeObserver(el);
  try { if (mstar && mstar.dispose) mstar.dispose(); } catch (e) {}
  mstar = null;
  const ds = dsFor(f);
  let data;
  viewerModel = null; if (currentDeep) { currentDeep.structText = null; currentDeep.structFmt = null; }
  const cur = multiCurrent(f);                                   // T-0367: which of the record's structures
  if (cur && multiSel.compare) { currentDeep.structSel = null; await renderCompare(f, cur, my); return; }
  try { data = await (await fetch(durl(structPath(f, ds)))).text(); }
  catch (e) { if (currentDeep && currentDeep.f === f && my === _load3DSeq) el.innerHTML = '<p style="color:#fff;padding:8px">structure unavailable</p>'; return; }
  // a newer fold may have opened, or a newer load of this fold started, while this fetch was in flight — don't clobber it
  if (!currentDeep || currentDeep.f !== f || my !== _load3DSeq) return;
  const fmt = structFmt(data);
  currentDeep.structText = data; currentDeep.structFmt = fmt; currentDeep._proj = null;
  currentDeep.structSel = cur ? { method: cur.method, k: cur.k } : null;
  // T-0367: the shown sample's dot-bracket (possibly derived from this very structure) must reach the tracks in
  // every 2D mode, not only in "3D projection" (which redraws below once the camera exists)
  if (cur) drawTracks(f, react);
  if ($("deep_color_by") && $("color_by")) $("deep_color_by").value = $("color_by").value;
  if ($("deep_ss_view") && $("ss_view")) $("deep_ss_view").value = $("ss_view").value;
  // panoramic always uses the 3Dmol channel gallery (before the Mol* branch, so Mol* + panoramic
  // still gives the small-multiples rather than a single Mol* viewer)
  if (currentMode() === "panoramic" && typeof $3Dmol !== "undefined") { renderChannelGallery(f, react, data, fmt); return; }
  if (deepEngine === "molstar") { renderMolstar(el, data, fmt); return; }
  if (typeof $3Dmol === "undefined") { el.innerHTML = '<p style="color:#fff;padding:8px">3Dmol.js not loaded.</p>'; return; }
  viewer = $3Dmol.createViewer(el, { backgroundColor: "0x0d1117" });
  viewerModel = viewer.addModel(data, fmt);
  const mode = ($("color_by") && $("color_by").value) || "a23";
  paintViewer(viewer, f, react, mode);
  // now that the 3D camera exists, re-draw the "3D projection" 2D so it matches this orientation,
  // and keep it in sync as the user rotates the 3D
  if ($("ss_view") && $("ss_view").value === "proj" && currentDeep) drawTracks(f, react);
  try { viewer.setViewChangeCallback(refreshProjIfActive); } catch (e) {}
}
// panoramic gallery column count (fewer = bigger structures), persisted
function panoCols() { const n = parseInt(localStorage.getItem("atlas_pano_cols") || "2", 10); return Math.max(1, Math.min(4, n || 2)); }
function setPanoCols(n) {
  n = Math.max(1, Math.min(4, n));
  try { localStorage.setItem("atlas_pano_cols", String(n)); } catch (e) {}
  const el = $("viewer3d");
  if (el && el.classList.contains("pano-gallery")) {
    el.style.gridTemplateColumns = "repeat(" + n + ",1fr)";
    requestAnimationFrame(() => panoViewers.forEach((v) => { try { v.resize(); v.render(); } catch (e) {} }));
  }
}
// metadata (props) text size, persisted
function metaScale() { const n = parseInt(localStorage.getItem("atlas_meta_scale") || "12", 10); return Math.max(10, Math.min(18, n || 12)); }
function setMetaScale(delta) {
  const n = Math.max(10, Math.min(18, metaScale() + delta));
  try { localStorage.setItem("atlas_meta_scale", String(n)); } catch (e) {}
  if ($("props")) $("props").style.fontSize = n + "px";
}
// per-channel value legend for the panoramic gallery (matches the exact palettes used in 3D)
function channelLegend(key, alt) {
  const bar = (grad, lo, hi) => `<span class="leg-lab">${lo}</span><span class="leg-bar" style="background:${grad}"></span><span class="leg-lab">${hi}</span>`;
  const sw = (items) => items.map(([c, l]) => `<span class="leg-sw" style="background:${c}"></span>${l}`).join(" ");
  let inner = "";
  if (key === "a23" || key === "dms") inner = bar("linear-gradient(90deg,#fff,#ffd4c2,#f08a5d,#b81d24)", "prot", "react");
  else if (key === "plddt") inner = bar("linear-gradient(90deg,#ff7d45,#ffdb13 45%,#65cbf3 72%,#0053d6)", "0", "100");
  else if (key === "pairing") inner = sw([["#ffffff", "paired"], ["#f3a0a0", "unpaired"]]);
  else if (key === "nuc") inner = sw([[nucColor("A", alt), "A"], [nucColor("C", alt), "C"], [nucColor("G", alt), "G"], [nucColor("U", alt), "U"]]);
  else if (key === "spectrum") inner = bar("linear-gradient(90deg,#2166ac,#4dac26,#fee08b,#d73027)", "5′", "3′");
  return inner ? `<div class="chan-leg">${inner}</div>` : "";
}
// the 3D viewer the 2D projection tracks (single viewer, or the linked gallery's first viewer)
function projActiveViewer() { return (currentMode() === "panoramic" && panoViewers[0]) ? panoViewers[0] : (viewer || panoViewers[0] || null); }
// let the user drag the 2D "3D projection" to rotate — it drives the 3D viewer, which re-projects
// the 2D (and, in panoramic, spins the linked gallery) via the existing view-change plumbing.
let _projDrag = null;
function initProjDrag() {
  document.addEventListener("pointerdown", (e) => {
    const box = e.target.closest && e.target.closest("#tracks .ss2d");
    if (!box || !($("ss_view") && $("ss_view").value === "proj") || !projActiveViewer()) return;
    _projDrag = { x: e.clientX, y: e.clientY };
    document.body.style.cursor = "grabbing";
    e.preventDefault();
  });
  document.addEventListener("pointermove", (e) => {
    if (!_projDrag) return;
    const v = projActiveViewer(); if (!v) { _projDrag = null; return; }
    const dx = e.clientX - _projDrag.x, dy = e.clientY - _projDrag.y;
    _projDrag.x = e.clientX; _projDrag.y = e.clientY;
    try {
      v.rotate(dx * 0.5, "y", 0); v.rotate(dy * 0.5, "x", 0); v.render();
      if (panoViewers.length > 1) { const view = v.getView(); panoViewers.forEach((o) => { if (o !== v) { try { o.setView(view); o.render(); } catch (e2) {} } }); }
    } catch (e2) {}
    refreshProjIfActive();
  });
  const end = () => { if (_projDrag) { _projDrag = null; document.body.style.cursor = ""; } };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}
// quaternion of the active 3D viewer's current camera (for aligning the 2D projection to it)
function activeQuat() {
  try {
    const v = (currentMode() === "panoramic" && panoViewers && panoViewers[0]) ? panoViewers[0] : (viewer || (panoViewers && panoViewers[0]));
    if (v && typeof v.getView === "function") { const a = v.getView(); if (a && a.length >= 8) return [a[4], a[5], a[6], a[7]]; }
  } catch (e) {}
  return null;
}
// switch the 2D secondary-structure rendering (called from the inline pills next to the diagram)
function setSSView(m) {
  if ($("ss_view")) $("ss_view").value = m;
  if ($("deep_ss_view")) $("deep_ss_view").value = m;
  saveState();
  if (currentDeep) drawTracks(currentDeep.f, currentDeep.react);
}
// live-follow: when the 3D camera moves and the 2D is in "3D projection" mode, re-project just
// the .ss2d SVG (parse is cached on currentDeep._proj, so this only rotates + redraws). rAF-throttled.
let _projRaf = 0;
function refreshProjIfActive() {
  if (!($("ss_view") && $("ss_view").value === "proj")) return;
  if (!currentDeep || !currentDeep.structText || _projRaf) return;
  const fold = currentDeep.f;   // pin the fold this frame is for
  _projRaf = requestAnimationFrame(() => {
    _projRaf = 0;
    // re-validate after the frame delay: fold may have closed/changed, or the view switched to forna/arc
    if (!currentDeep || currentDeep.f !== fold || !currentDeep.structText) return;
    if (!($("ss_view") && $("ss_view").value === "proj")) return;
    const box = document.querySelector("#tracks .ss2d");
    if (!box) return;
    if (!currentDeep._proj) currentDeep._proj = projParse(currentDeep.structText);
    if (!currentDeep._proj) return;
    const dbn = dbnFor(fold);
    const svg = proj2D(currentDeep._proj, dbn, (currentDeep.react && currentDeep.react.seq) || "", 340, altPalette(), activeQuat());
    if (svg) box.innerHTML = svg;
  });
}
// nucColor() returns a CSS hex ("#rrggbb"); 3Dmol colorfuncs want 0x-prefixed hex.
function hexCF(c) { return (c || "#cccccc").replace("#", "0x"); }
// 3Dmol style object for a given coloring channel (shared by the single viewer + the gallery).
function styleForMode(mode, f, react, dbnOver) {           // dbnOver: a compare cell's own dot-bracket (T-0367)
  const a23 = react && react.a23, dms = react && react.dms;
  const dbn = dbnOver != null ? dbnOver : dbnFor(f);
  if (mode === "plddt") return { cartoon: { colorfunc: (a) => plddtCF(a.b), ringMode: 3 } };
  if (mode === "pairing") return { cartoon: { colorfunc: (a) => { const c = dbn[a.resi - 1]; const p = c && c !== "." && c !== "-"; return p ? "0xffffff" : (c ? "0xf3a0a0" : "0x9aa7b0"); }, ringMode: 3 } };
  if (mode === "nuc") { const alt = altPalette(); return { cartoon: { colorfunc: (a) => hexCF(nucColor((a.resn || "").trim(), alt)), ringMode: 3 } }; }
  if (mode === "crossed") { const cs = crossedResiSet(f); return { cartoon: { colorfunc: (a) => cs.has(a.resi) ? "0xb5121b" : "0x9aa7b0", ringMode: 3 } }; }
  if (mode === "spectrum") return { cartoon: { color: "spectrum", ringMode: 3 } };
  const arr = mode === "dms" ? dms : a23;                     // a23 / dms reactivity; spectrum if absent
  return arr ? { cartoon: { colorfunc: (a) => shapeColorHex(arr[a.resi - 1]), ringMode: 3 } } : { cartoon: { color: "spectrum", ringMode: 3 } };
}
function paintViewer(v, f, react, mode, dbnOver) {
  v.setStyle({}, styleForMode(mode, f, react, dbnOver));
  spansFor(f).forEach((m) => {
    const resi = [];
    m.ranges.forEach(([a, b]) => { for (let r = a; r <= b; r++) resi.push(r); });
    v.addStyle({ resi }, { stick: { color: motifColor(m.type), radius: 0.28 } });
  });
  v.zoomTo(); v.render();
}
const PANO_CHANNELS = [
  { k: "a23", label: "2A3 reactivity", need: (r) => r && r.a23 },
  { k: "dms", label: "DMS reactivity", need: (r) => r && r.dms },
  { k: "plddt", label: "pLDDT confidence" },
  { k: "pairing", label: "base pairing" },
  { k: "nuc", label: "nucleotide" },
  { k: "spectrum", label: "5′→3′ spectrum" },
];
let panoViewers = [];
function disposePano() { panoViewers.forEach((v) => { try { v.setViewChangeCallback(null); } catch (e) {} try { v.clear(); } catch (e) {} }); panoViewers = []; }
function renderChannelGallery(f, react, data, fmt) {
  const el = $("viewer3d");
  disposePano();
  el.innerHTML = "";
  el.classList.add("pano-gallery");
  el.style.gridTemplateColumns = "repeat(" + panoCols() + ",1fr)";
  const alt = altPalette();
  PANO_CHANNELS.filter((c) => !c.need || c.need(react)).forEach((c) => {
    const cell = document.createElement("div"); cell.className = "chan-cell";
    const lab = document.createElement("div"); lab.className = "chan-lab"; lab.textContent = c.label;
    const vd = document.createElement("div"); vd.className = "chan-viewer";
    cell.appendChild(vd); cell.appendChild(lab);
    cell.insertAdjacentHTML("beforeend", channelLegend(c.k, alt));   // value scale, bottom-right
    el.appendChild(cell);
    try {
      const v = $3Dmol.createViewer(vd, { backgroundColor: "0x0d1117" });
      v.addModel(data, fmt);
      paintViewer(v, f, react, c.k);
      panoViewers.push(v);
    } catch (e) {}
  });
  // +/- to resize the panels (fewer columns = bigger structures)
  const zoom = document.createElement("div"); zoom.className = "pano-zoom";
  zoom.innerHTML = '<button type="button" title="smaller">−</button><button type="button" title="larger">+</button>';
  el.appendChild(zoom);
  const zb = zoom.querySelectorAll("button");
  zb[0].onclick = () => setPanoCols(panoCols() + 1);
  zb[1].onclick = () => setPanoCols(panoCols() - 1);
  linkPanoCameras();
  // align the "3D projection" 2D to the gallery's shared camera now that it exists
  if ($("ss_view") && $("ss_view").value === "proj" && currentDeep) drawTracks(f, react);
}
// ---- T-0367 pickers: the #multi-bar row under the deep-view header (hidden for one-structure datasets) ----
function renderMultiBar(f) {
  const bar = $("multi-bar"); if (!bar) return;
  const cur = f ? multiCurrent(f) : null;
  if (!cur) { bar.classList.add("hidden"); $("deep").classList.remove("cmp-on"); return; }
  bar.classList.remove("hidden");
  $("deep").classList.toggle("cmp-on", multiSel.compare);        // compare: the 3D region spans the whole card width
  const fmt = (v, d) => (v == null ? "n/a" : (+v).toFixed(d));
  const trio = (s) => s ? ["pLDDT " + fmt(s.plddt, 1), "ranking " + fmt(s.ranking_score, 3), "agreement " + fmt(s.shape_agr, 2)].join(" · ") : "";
  const sum = f.methods || {};
  $("mb-methods").innerHTML = cur.multi.methods.map((m) =>
    `<button type="button" data-m="${esc(m.id)}" class="${!multiSel.compare && m.id === cur.method ? "active" : ""}" title="${esc(m.label)}${sum[m.id] ? " · best-by-reactivity sample: " + esc(trio(sum[m.id])) : ""}">${esc(m.label)}</button>`).join("")
    + `<button type="button" data-m="compare" class="${multiSel.compare ? "active" : ""}" title="every method for this design, each at its Best-by sample (the selected method keeps its sample)">Compare</button>`;
  const best = multiCurrent(f, cur.method, "best");
  let sh = `<button type="button" data-k="best" class="${multiSel.sample === "best" ? "active" : ""}" title="${esc(best.note || ("best by " + bestByLabel(best.by)))}">Best (${best.k + 1})</button>`;
  for (let k = 0; k < cur.nS; k++) sh += `<button type="button" data-k="${k}" class="${multiSel.sample !== "best" && cur.k === k ? "active" : ""}" title="${esc(trio(sampleOf(f, cur.method, k)) || ("sample " + (k + 1)))}">${k + 1}</button>`;
  $("mb-samples").innerHTML = sh;
  $("mb-bestby").innerHTML = MULTI_BESTBY.map(([v, l]) => `<option value="${v}"${v === multiSel.bestBy ? " selected" : ""}>${l}</option>`).join("");
  const cm = $("mb-cmpmode"); cm.classList.toggle("hidden", !multiSel.compare);
  cm.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.cmp === multiSel.cmpMode));
  // notes: a Best fallback (no reactivity / no confidence), a frame note (RNet's 311-nt construct), replicates
  const notes = [];
  if (multiSel.sample === "best" && cur.note) notes.push(cur.note);
  if (multiSel.compare) cur.multi.methods.forEach((m) => { if (m.id === cur.method) return; const c = multiCurrent(f, m.id, "best"); if (c.note) notes.push(c.note.indexOf(m.label) >= 0 ? c.note : m.label + ": " + c.note); });
  cur.multi.methods.forEach((m) => { if (m.note && (multiSel.compare || m.id === cur.method)) notes.push(m.note); });
  if (f.replicate_of) notes.push(`replicate of ${f.replicate_of}: the same design sequence, so design-frame predictions are shared`);
  else if (f.n_replicates > 1) notes.push(`${f.n_replicates} constructs share this design sequence`);
  $("mb-note").innerHTML = notes.map((n) => `<span class="mb-n">${esc(n)}</span>`).join("");
}
function wireMultiBar() {
  const bar = $("multi-bar"); if (!bar) return;
  bar.addEventListener("click", (e) => {                       // delegated: the buttons are re-created on every render
    const b = e.target.closest ? e.target.closest("button") : null; if (!b || !bar.contains(b)) return;
    if (b.dataset.m) { if (b.dataset.m === "compare") setMulti({ compare: !multiSel.compare }); else setMulti({ method: b.dataset.m, compare: false }); }
    else if (b.dataset.k !== undefined) setMulti({ sample: b.dataset.k === "best" ? "best" : +b.dataset.k });
    else if (b.dataset.cmp) setMulti({ cmpMode: b.dataset.cmp });
  });
  if ($("mb-bestby")) $("mb-bestby").addEventListener("change", () => setMulti({ bestBy: $("mb-bestby").value }));
}
// a picker change: re-slice the reactivity when the frame changes, reload the 3D when the structure changes,
// redraw the bar / props / tracks, keep the share link current
function setMulti(patch) {
  const f = currentDeep && currentDeep.f;
  const before = f ? multiCurrent(f) : null;
  Object.assign(multiSel, patch);
  saveMultiSel();
  if (!f || !before) return;
  const cur = multiCurrent(f);
  currentDeep.react = reactForFrame(currentDeep.reactRaw, cur.frame);
  renderMultiBar(f);
  drawProps(f);
  // the 3D is rebuilt when the shown structure changes, when compare is toggled, and in compare when its layout or
  // the Best-by rule changes (the other methods' cells follow that rule even if the selected method's sample does not)
  const structChanged = before.method !== cur.method || before.k !== cur.k || ("compare" in patch)
    || (multiSel.compare && (("cmpMode" in patch) || ("bestBy" in patch)));
  if (structChanged) load3D(f, currentDeep.react);
  drawTracks(f, currentDeep.react);                              // always: the pairing track / 2D follow the selection in every 2D mode
  drawReactChart(f, currentDeep.react);
  saveState();
}
// extra metadata rows for a multi record (drawProps)
function multiPropRows(f) {
  const cur = multiCurrent(f); if (!cur) return [];
  const raw = currentDeep && currentDeep.f === f ? currentDeep.reactRaw : null;
  const s = sampleOf(f, cur.method, cur.k);
  const how = multiSel.sample === "best" ? ` (best by ${bestByLabel(cur.by || multiSel.bestBy)}${cur.note ? "; " + esc(cur.note) : ""})` : " (chosen)";
  const rows = [["Structure shown", `${esc(cur.mdef.label)} · sample ${cur.k + 1} of ${cur.nS}${how}${multiSel.compare ? " · comparing all methods" : ""}`]];
  if (cur.frame === "construct311") rows.push(["Frame", `the full ${f.construct_length || (raw && raw.seq311 && raw.seq311.length) || ""}-nt construct as folded${raw && raw.design_start != null && raw.design_end != null ? `; the design is positions ${raw.design_start + 1}–${raw.design_end}` : ""}`]);
  if (s) rows.push(["This sample", [s.plddt != null && "pLDDT " + num(s.plddt), s.ptm != null && "pTM " + num(s.ptm, 3), s.gpde != null && "gpde " + num(s.gpde, 3),
    s.ranking_score != null && "ranking " + num(s.ranking_score, 3), s.has_clash != null && (s.has_clash ? "has clash" : "no clash"),
    s.shape_agr != null && "2A3 agreement " + num(s.shape_agr, 3), s.rdms != null && "DMS r " + num(s.rdms, 3),
    s.ss_class && esc(s.ss_class), s.bp_fraction != null && "paired " + num(s.bp_fraction, 2)].filter(Boolean).join(" · ") || "n/a"]);
  else if (currentDeep && currentDeep.f === f && currentDeep.samples === null) rows.push(["This sample", "per-sample details unavailable (no samples file for this record)"]);
  const na = (x, d) => (x == null ? "n/a" : num(x, d));
  const per = cur.multi.methods.map((m) => { const b = (f.methods || {})[m.id]; return b ? `${esc(m.label)}: pLDDT ${na(b.plddt)} · ranking ${na(b.ranking_score, 3)} · agreement ${na(b.shape_agr, 3)}` : null; }).filter(Boolean);
  if (per.length) rows.push(["Methods (best-by-reactivity sample)", per.join("<br>")]);
  if (f.replicate_of) rows.push(["Replicate", `same design sequence as ${esc(f.replicate_of)}${f.n_replicates ? ` (${f.n_replicates} constructs)` : ""}`]);
  else if (f.n_replicates > 1) rows.push(["Replicate", `${f.n_replicates} constructs share this design sequence`]);
  const tdbn = currentDeep && currentDeep.f === f ? currentDeep.targetDbn : null;
  if (tdbn) rows.push(["Design target", `${f.n_crossed_bp_target != null ? f.n_crossed_bp_target + " crossed base pairs · " : ""}<span class="mono" title="${esc(tdbn)}">${esc(tdbn.length > 72 ? tdbn.slice(0, 72) + "…" : tdbn)}</span>`]);
  else if (f.n_crossed_bp_target != null) rows.push(["Design target", `${f.n_crossed_bp_target} crossed base pairs`]);
  if (f.ok_overall != null || f.ok_crossed != null || f.snr != null) rows.push(["Measured OpenKnot", [f.ok_overall != null && "overall " + num(f.ok_overall), f.ok_crossed != null && "crossed " + num(f.ok_crossed), f.snr != null && "SNR " + num(f.snr, 2)].filter(Boolean).join(" · ")]);
  return rows;
}
// metrics suffix for a compare cell: the sample's own values, else the record's best-by-reactivity summary
function metricsLabel(f, c) {
  const s = sampleOf(f, c.method, c.k) || (c.by === "react" ? (f.methods || {})[c.method] : null);
  if (!s) return "";
  const parts = [];
  if (s.plddt != null) parts.push("pLDDT " + (+s.plddt).toFixed(1));
  if (s.ranking_score != null) parts.push("rank " + (+s.ranking_score).toFixed(2));
  if (s.shape_agr != null) parts.push("agr " + (+s.shape_agr).toFixed(2));
  return parts.length ? " · " + parts.join(" · ") : "";
}
// link cameras: dragging/rotating any panel rotates all the others in lock-step (panoramic gallery + compare)
function linkPanoCameras() {
  let syncing = false;
  panoViewers.forEach((v) => {
    try {
      v.setViewChangeCallback((view) => {
        if (syncing) return;
        syncing = true;
        panoViewers.forEach((o) => { if (o !== v) { try { o.setView(view); o.render(); } catch (e) {} } });
        syncing = false;
        refreshProjIfActive();
      });
    } catch (e) {}
  });
}
// ---- T-0367 compare: every method of a multi record for one design. Side by side = linked-camera viewers
// (the gallery's mechanics); overlay = one viewer, the others superposed on the selected method by a C1'
// Kabsch fit over the design window. The selected method keeps its sample, the others show their Best-by one.
const OVERLAY_COLORS = ["#f2a93b", "#4aa3df", "#e4572e", "#8ac926", "#c77dff"];
async function renderCompare(f, cur, my) {                          // my: load3D's sequence token for this load
  const el = $("viewer3d"), ds = dsFor(f);
  const cells = cur.multi.methods.map((m) => (m.id === cur.method ? cur : multiCurrent(f, m.id, "best")));
  const texts = await Promise.all(cells.map((c) => fetch(durl(multiStructPath(f, ds, c.method, c.k))).then((r) => (r.ok ? r.text() : null)).catch(() => null)));
  if (!currentDeep || currentDeep.f !== f || my !== _load3DSeq || !multiSel.compare) return;
  const prim = cells.findIndex((c) => c.method === cur.method);
  if (texts[prim]) { currentDeep.structText = texts[prim]; currentDeep.structFmt = structFmt(texts[prim]); currentDeep.structSel = { method: cur.method, k: cur.k }; currentDeep._proj = null; }
  if (typeof $3Dmol === "undefined") { el.innerHTML = '<p style="color:#fff;padding:8px">3Dmol.js not loaded.</p>'; return; }
  disposePano(); loseGL(el); el.innerHTML = ""; viewer = null; viewerModel = null;
  const mode = ($("color_by") && $("color_by").value) || "a23";
  const label = (c, i) => `${c.mdef.label} · s${c.k + 1}${c.by ? " · best by " + bestByLabel(c.by) : ""}${metricsLabel(f, c)}${texts[i] ? "" : " · unavailable"}`;
  if (multiSel.cmpMode === "overlay") { renderOverlay(el, f, cur, cells, texts, prim, label); }
  else {
    el.classList.add("pano-gallery");
    el.style.gridTemplateColumns = "repeat(" + (el.clientWidth >= 540 ? Math.min(cells.length, 3) : 1) + ",1fr)";
    cells.forEach((c, i) => {
      const cell = document.createElement("div"); cell.className = "chan-cell";
      const lab = document.createElement("div"); lab.className = "chan-lab"; lab.textContent = label(c, i);
      const vd = document.createElement("div"); vd.className = "chan-viewer";
      cell.appendChild(vd); cell.appendChild(lab);
      cell.insertAdjacentHTML("beforeend", channelLegend(mode, altPalette()));
      el.appendChild(cell);
      if (!texts[i]) { vd.innerHTML = '<p style="color:#fff;padding:8px">structure unavailable</p>'; return; }
      try {
        const v = $3Dmol.createViewer(vd, { backgroundColor: "0x0d1117" });
        const m = v.addModel(texts[i], structFmt(texts[i]));
        paintViewer(v, f, reactForFrame(currentDeep.reactRaw, c.frame), mode, sampleDbn(f, c.method, c.k, texts[i]));
        panoViewers.push(v);
        if (i === prim) viewerModel = m;
      } catch (e) {}
    });
    linkPanoCameras();
  }
  drawTracks(f, currentDeep.react);                              // the primary's dot-bracket / 2D, in every 2D mode
}
function renderOverlay(el, f, cur, cells, texts, prim, label) {
  el.classList.remove("pano-gallery"); el.style.gridTemplateColumns = "";
  const ref = texts[prim];
  if (!ref) { el.innerHTML = '<p style="color:#fff;padding:8px">structure unavailable</p>'; return; }
  viewer = $3Dmol.createViewer(el, { backgroundColor: "0x0d1117" });
  const refC1 = c1Coords(ref), refWin = designWindow(cur);
  const leg = [];
  cells.forEach((c, i) => {
    const txt = texts[i]; const col = OVERLAY_COLORS[i % OVERLAY_COLORS.length];
    if (!txt) { leg.push({ c, col, text: "unavailable" }); return; }
    let t = txt, rmsd = null, n = 0, aligned = i === prim, why = "";
    if (i !== prim) {
      const cWin = designWindow(c);
      if (!canPairFrames(c.frame, cWin, cur.frame, refWin)) why = "not aligned (no design window)";
      else {
        const fit = superposeC1(c1Coords(txt), cWin, refC1, refWin);
        const moved = fit ? transformPDB(txt, fit.R, fit.t) : null;
        if (moved != null) { t = moved; rmsd = fit.rmsd; n = fit.n; aligned = true; }
        else why = fit ? "not aligned (format)" : "not aligned (too few C1′ atoms)";
      }
    }
    const m = viewer.addModel(t, structFmt(t));
    viewer.setStyle({ model: m }, { cartoon: { color: hexCF(col), ringMode: 3 } });
    if (i === prim) viewerModel = m;
    leg.push({ c, col, text: i === prim ? "reference" : (aligned ? `RMSD ${rmsd.toFixed(2)} Å over ${n} C1′` : why) });
  });
  viewer.zoomTo(); viewer.render();
  try { viewer.setViewChangeCallback(refreshProjIfActive); } catch (e) {}
  el.insertAdjacentHTML("beforeend", `<div class="ovl-leg">` + leg.map((x) => `<span><span class="leg-sw" style="background:${x.col}"></span>${esc(label(x.c, cells.indexOf(x.c)))} · ${esc(x.text)}</span>`).join("") + `</div>`);
}
// residue index window (0-based, end exclusive) of the DESIGN in a method's frame; null = the whole chain
function designWindow(c) {
  const raw = currentDeep && currentDeep.reactRaw;
  if (c.frame === "construct311" && raw && raw.design_start != null && raw.design_end != null) return [raw.design_start | 0, raw.design_end | 0];
  return null;
}
// two frames pair residue by residue when they are the same frame, or when every whole-construct side knows its
// design window; otherwise an index pairing would silently offset the chains and print a meaningless RMSD
function canPairFrames(aFrame, aWin, bFrame, bWin) {
  if (aFrame === bFrame) return true;
  return (aFrame !== "construct311" || !!aWin) && (bFrame !== "construct311" || !!bWin);
}
// one C1' coordinate per residue (null where missing), first chain / first model (ss.js parser)
function c1Coords(text) { return (typeof ssParseResidues === "function" ? ssParseResidues(text) : []).map((r) => (r.atoms && r.atoms["C1'"]) || null); }
// pair residues by position inside each design window, then Kabsch-fit the mobile set onto the reference
function superposeC1(mob, mobWin, ref, refWin) {
  const sl = (a, w) => (w ? a.slice(w[0], w[1]) : a);
  const a = sl(mob, mobWin), b = sl(ref, refWin), n = Math.min(a.length, b.length);
  const P = [], Q = [];
  for (let i = 0; i < n; i++) if (a[i] && b[i]) { P.push(a[i]); Q.push(b[i]); }
  return kabsch(P, Q);
}
// Kabsch: the rotation R and translation t that move P onto Q (least squares); {R, t, rmsd, n} or null.
// SVD of the 3x3 covariance via the eigen-decomposition of HᵀH (ss.js jacobiEig3); a reflection is undone
// by flipping the smallest singular direction.
function kabsch(P, Q) {
  const n = P.length; if (n < 3 || Q.length !== n) return null;
  const cp = [0, 0, 0], cq = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) { cp[d] += P[i][d] / n; cq[d] += Q[i][d] / n; }
  const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) H[a][b] += (P[i][a] - cp[a]) * (Q[i][b] - cq[b]);
  const HtH = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let k = 0; k < 3; k++) HtH[a][b] += H[k][a] * H[k][b];
  const V = jacobiEig3(HtH);                                     // right singular vectors, largest first
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const U = V.map((v) => { const hv = [0, 1, 2].map((a) => H[a][0] * v[0] + H[a][1] * v[1] + H[a][2] * v[2]); const s = Math.hypot(hv[0], hv[1], hv[2]); return s > 1e-9 ? hv.map((x) => x / s) : null; });
  if (!U[0] || !U[1]) return null;                              // collinear points: no unique rotation
  if (!U[2]) U[2] = cross(U[0], U[1]);                          // planar set: complete the frame
  const det3 = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const build = (sign) => { const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { let s = 0; for (let i = 0; i < 3; i++) s += V[i][a] * (i === 2 ? sign : 1) * U[i][b]; R[a][b] = s; } return R; };
  let R = build(1); if (det3(R) < 0) R = build(-1);
  const t = [0, 1, 2].map((a) => cq[a] - (R[a][0] * cp[0] + R[a][1] * cp[1] + R[a][2] * cp[2]));
  let ss = 0;
  for (let i = 0; i < n; i++) { const p = P[i], q = Q[i]; const x = R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0], y = R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1], z = R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2]; ss += (x - q[0]) ** 2 + (y - q[1]) ** 2 + (z - q[2]) ** 2; }
  return { R, t, rmsd: Math.sqrt(ss / n), n };
}
// apply R·p + t to every ATOM/HETATM coordinate of a PDB text (fixed columns); null for other formats (no transform)
function transformPDB(text, R, t) {
  if (structFmt(text) === "cif") return null;
  return text.split("\n").map((l) => {
    if (!(l.startsWith("ATOM") || l.startsWith("HETATM")) || l.length < 54) return l;
    const x = parseFloat(l.slice(30, 38)), y = parseFloat(l.slice(38, 46)), z = parseFloat(l.slice(46, 54));
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return l;
    const nx = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0], ny = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1], nz = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2];
    return l.slice(0, 30) + nx.toFixed(3).padStart(8) + ny.toFixed(3).padStart(8) + nz.toFixed(3).padStart(8) + l.slice(54);
  }).join("\n");
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
  const cur = multiCurrent(f);                                  // T-0367: which method / sample this export is
  if (cur) {
    L.push("method: " + cur.mdef.label + " (" + cur.method + ")");
    L.push("sample: " + (cur.k + 1) + " of " + cur.nS + (multiSel.sample === "best" ? "   (best by " + bestByLabel(cur.by || multiSel.bestBy) + (cur.note ? "; " + cur.note : "") + ")" : ""));
    const s = sampleOf(f, cur.method, cur.k);
    if (s) L.push("sample metrics: pLDDT " + num(s.plddt, 1) + "   ranking " + num(s.ranking_score, 3) + "   2A3 agreement " + num(s.shape_agr, 3));
    if (cur.mdef.note) L.push("note: " + cur.mdef.note);
  }
  const dbn = dbnFor(f);
  if (react && react.seq) L.push("sequence:\n" + react.seq);
  if (dbn) L.push("secondary structure (dbn):\n" + dbn);
  return L.join("\n") + "\n";
}
async function exportFold() {
  if (!currentDeep) return;
  const f = currentDeep.f, react = currentDeep.react, base0 = safeName(f.id) || "fold";
  const sel = currentDeep.structSel;                           // T-0367: name the structure by method + sample
  const base = sel ? base0 + "__" + safeName(sel.method) + "__sample" + (sel.k + 1) : base0;
  const files = [{ name: base + ".txt", data: _enc(foldTxt(f, react)) }];
  if (currentDeep.structText) {
    const native = currentDeep.structFmt;     // always ship the fetched file in its own format
    files.push({ name: base + "." + native, data: _enc(currentDeep.structText) });
    const atoms = viewerModel ? viewerModel.selectedAtoms({}) : [];   // 3Dmol only -> convert to the other format
    if (atoms.length) files.push({ name: base + "." + (native === "pdb" ? "cif" : "pdb"),
      data: _enc(native === "pdb" ? atomsToCIF(atoms, base) : atomsToPDB(atoms)) });
  }
  let png = null;                              // snapshot from whichever engine is active
  try { if (viewer) png = dataURIBytes(viewer.pngURI()); } catch (e) {}
  if (!png) { try { const c = $("viewer3d").querySelector("canvas"); if (c) { const u = c.toDataURL("image/png"); if (u && u.length > 3000) png = dataURIBytes(u); } } catch (e) {} }
  if (png) files.push({ name: base + ".png", data: png });
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
  saveState();
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
    const nk = Math.max(0.75, Math.min(40, mapT.k * f)), af = nk / mapT.k;   // clamp zoom-out (fit ~panel) and zoom-in
    mapT.x = mx - (mx - mapT.x) * af; mapT.y = my - (my - mapT.y) * af; mapT.k = nk; renderMap(lastRows); scheduleShareUpdate(); }, { passive: false });
  cv.addEventListener("dblclick", () => { mapT = { k: 1, x: 0, y: 0 }; renderMap(lastRows); scheduleShareUpdate(); });   // double-click resets to fit
  cv.addEventListener("mousedown", (e) => { mapDrag = { x: e.clientX, y: e.clientY, ox: mapT.x, oy: mapT.y, moved: false }; });
  window.addEventListener("mousemove", (e) => {
    const cv2 = $("map"), r = cv2.getBoundingClientRect();
    if (mapDrag) { mapDrag.moved = mapDrag.moved || Math.abs(e.clientX - mapDrag.x) + Math.abs(e.clientY - mapDrag.y) > 3;
      mapT.x = mapDrag.ox + (e.clientX - mapDrag.x); mapT.y = mapDrag.oy + (e.clientY - mapDrag.y); renderMap(lastRows); scheduleShareUpdate(); return; }
    if (viewMode !== "map") return;
    const tip = $("maptip");
    if (e.target !== cv2) { tip.classList.add("hidden"); return; }
    const p = mapPick(e.clientX - r.left, e.clientY - r.top, 7);
    if (p) { tip.classList.remove("hidden"); tip.style.left = (e.clientX - r.left + 14) + "px"; tip.style.top = (e.clientY - r.top + 14) + "px";
      tip.innerHTML = `<b>${esc(p.f.id)}</b>${p.f.name ? "<br>" + esc(p.f.name) : ""}`; } else tip.classList.add("hidden");
  });
  window.addEventListener("mouseup", (e) => {
    if (mapDrag && !mapDrag.moved && e.target === $("map")) { const r = $("map").getBoundingClientRect(); const p = mapPick(e.clientX - r.left, e.clientY - r.top, 9); if (p) openDeep(p.f._uid); }
    if (mapDrag && mapDrag.moved) updateShareUI();   // flush the debounced pan/zoom update right when the drag ends
    mapDrag = null;
  });
  $("map_color").addEventListener("change", () => { renderMap(lastRows); saveState(); });
}

// ---------------- AtlasAPI: programmatic surface the assistant drives ----------------
const FILTER_MAP = { length_min: "len_min", length_max: "len_max", plddt_min: "plddt_min", clash_max: "clash_max",
  novelty_max: "tm_max", overlap_max: "ov_max", shape_agr_min: "agr_min", compactness_min: "cr_min",
  paired_min: "bp_min", fold_size_min: "fold_min", seq_cluster_min: "sclust_min", top_n: "topn", rank: "rank_key",
  termini: "termini", overhang_max: "overhang_max" };
const BOOL_MAP = { novel_only: "novel_only", shape_only: "shape_ok", require_tertiary: "req_tert", require_rare: "req_rare", only_with_tm: "tm_has", per_letter: "per_letter", uucg: "uucg" };
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
    else if (k === "conditioning") { const want = new Set((obj[k] || []).map(String)); document.querySelectorAll(".cf").forEach((c) => { c.checked = want.has(c.value); }); }
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
  setColorBy: (f) => { if ($("map_color")) { $("map_color").value = f; if (viewMode === "map") renderMap(lastRows); saveState(); } },
  applyFilters,
  resetFilters: () => { $("reset").click(); return lastRows.length; },
  selectFold: (id) => { const f = foldById(id); if (!f) return false; openDeep(f._uid); return true; },
  // Current address bar already IS the shareable link (kept live via updateShareUI()); this just
  // hands it back as a value so the assistant can quote it in a reply.
  getShareLink: () => { updateShareUI(); return location.href; },
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
