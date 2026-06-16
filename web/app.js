// RNA Atlas Explorer — client-side filtering/ranking + lazy deep view.
let FOLDS = [], MOTIFS = {}, MOTIF_SET = [], LETTERS = [];
let sortOverride = null;  // {key, dir} from header click

const $ = (id) => document.getElementById(id);
const num = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x)) ? "" : (+x).toFixed(d);

async function boot() {
  FOLDS = await (await fetch("data/folds.json")).json();
  MOTIFS = await (await fetch("data/motifs.json")).json();
  const ms = new Set(), ls = new Set();
  let maxLen = 0;
  for (const f of FOLDS) {
    (f.motifs || []).forEach((m) => ms.add(m));
    if (f.letter) ls.add(f.letter);
    if (f.length > maxLen) maxLen = f.length;
  }
  MOTIF_SET = [...ms].sort();
  LETTERS = [...ls].sort();
  $("len_max").value = maxLen;
  buildMotifFilter();
  buildLetterFilter();
  wireControls();
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

function wireControls() {
  document.querySelectorAll("#config input, #config select").forEach((el) =>
    el.addEventListener("input", () => { syncLabels(); render(); }));
  $("reset").addEventListener("click", () => {
    document.querySelectorAll(".mf").forEach((c) => c.checked = false);
    document.querySelectorAll(".lf").forEach((c) => c.checked = true);
    ["plddt_min", "tm_max", "ov_max", "r2a3_max"].forEach((id) => $(id).value = $(id).max);
    $("plddt_min").value = 0; $("clash_max").value = 9999; $("len_min").value = 0;
    $("len_max").value = Math.max(...FOLDS.map((f) => f.length || 0));
    ["shape_ok", "req_tert", "req_rare", "tm_has", "per_letter"].forEach((id) => $(id).checked = false);
    $("pk").value = "any"; $("rank_key").value = "best_tm1:asc"; $("topn").value = 200;
    sortOverride = null; syncLabels(); render();
  });
  $("deep-close").addEventListener("click", () => $("deep").classList.add("hidden"));
  $("deep").addEventListener("click", (e) => { if (e.target.id === "deep") $("deep").classList.add("hidden"); });
  syncLabels();
}
function syncLabels() {
  $("plddt_min_v").textContent = $("plddt_min").value;
  $("tm_max_v").textContent = (+$("tm_max").value).toFixed(2);
  $("ov_max_v").textContent = (+$("ov_max").value).toFixed(2);
  $("r2a3_max_v").textContent = (+$("r2a3_max").value).toFixed(2);
}

function filters() {
  const lf = [...document.querySelectorAll(".lf:checked")].map((c) => c.value);
  const mf = [...document.querySelectorAll(".mf:checked")].map((c) => c.value);
  return {
    lmin: +$("len_min").value, lmax: +$("len_max").value,
    plddt: +$("plddt_min").value, clash: +$("clash_max").value,
    tmax: +$("tm_max").value, tmhas: $("tm_has").checked,
    ovmax: +$("ov_max").value,
    shape: $("shape_ok").checked, r2a3: +$("r2a3_max").value,
    tert: $("req_tert").checked, rare: $("req_rare").checked, motifs: mf,
    pk: $("pk").value, letters: new Set(lf),
    rank: $("rank_key").value, topn: +$("topn").value, perLetter: $("per_letter").checked,
  };
}

function pass(f, c) {
  if (f.length != null && (f.length < c.lmin || f.length > c.lmax)) return false;
  if ((f.plddt || 0) < c.plddt) return false;
  if (f.clashscore != null && f.clashscore > c.clash) return false;
  if (c.tmhas && f.best_tm1 == null) return false;
  if (f.best_tm1 != null && f.best_tm1 > c.tmax) return false;
  if (f.overlap_ae != null && f.overlap_ae > c.ovmax) return false;
  if (c.shape && !f.shape_ok) return false;
  if (f.r2a3 != null && f.r2a3 > c.r2a3) return false;
  if (c.tert && f.n_tert < 1) return false;
  if (c.rare && f.n_rare < 1) return false;
  if (c.motifs.length && !c.motifs.some((m) => (f.motifs || []).includes(m))) return false;
  if (c.pk !== "any" && String(f.pseudoknot) !== c.pk) return false;
  if (f.letter && !c.letters.has(f.letter)) return false;
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
  $("count").textContent = `${rows.length} shown`;
  drawTable(rows);
}

const COLS = [
  ["id", "seq_id"], ["name", "name"], ["letter", "L"], ["length", "len"], ["plddt", "pLDDT"],
  ["best_tm1", "best_tm1"], ["near", "nearest"], ["overlap_ae", "ovlp_AE"],
  ["shape_ok", "SHAPE"], ["r2a3", "r(2A3)"], ["n_tert", "tert"], ["n_rare", "rare"],
  ["pseudoknot", "PK"], ["motifs", "motifs"],
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
    const shape = f.shape_ok ? `<span class="pill" style="background:#3a7d44">yes</span>` : `<span class="muted">no</span>`;
    return `<tr data-id="${f.id}">
      <td>${f.id}</td><td>${f.name || ""}</td><td>${f.letter}</td>
      <td class="num">${f.length ?? ""}</td><td class="num">${plbar}</td>
      <td class="num">${num(f.best_tm1, 3)}</td><td>${f.near || ""}</td>
      <td class="num">${num(f.overlap_ae, 2)}</td><td>${shape}</td>
      <td class="num">${num(f.r2a3, 2)}</td><td class="num">${f.n_tert}</td><td class="num">${f.n_rare}</td>
      <td>${f.pseudoknot ? "&#10003;" : ""}</td><td>${chips}</td></tr>`;
  }).join("");
  $("tbody").innerHTML = body;
  $("tbody").querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => openDeep(tr.dataset.id)));
}

// ---------------- deep view ----------------
const FBY = {};
function foldById(id) { if (!FBY[id]) FOLDS.forEach((f) => FBY[f.id] = f); return FBY[id]; }

async function openDeep(id) {
  const f = foldById(id);
  $("deep").classList.remove("hidden");
  $("deep-title").textContent = `${id}${f.name ? "  —  " + f.name : ""}`;
  drawProps(f);
  let react = null;
  try { react = await (await fetch("react/" + id)).json(); } catch (e) { react = null; }
  drawTracks(f, react);
  load3D(id, react);
}

function drawProps(f) {
  const verdict = f.best_tm1 == null ? "n/a (not scored vs v341)"
    : f.best_tm1 < 0.40 ? "novel" : f.best_tm1 < 0.45 ? "borderline" : "matches known fold";
  const rowsHtml = [
    ["Source", `${f.source} (lib ${f.letter})`],
    ["Sublibrary", f.sublibrary],
    ["Length", `${f.length} nt`],
    ["pLDDT / gpde", `${num(f.plddt)} / ${num(f.gpde, 3)}`],
    ["Clashscore", num(f.clashscore, 2)],
    ["Novelty (best_tm1 vs v341)", f.best_tm1 == null ? "&mdash;" : `${num(f.best_tm1, 3)} (nearest ${f.near}) &mdash; ${verdict}`],
    ["Distinct vs A&ndash;E (overlap)", num(f.overlap_ae, 3)],
    ["SHAPE-supported", `${f.shape_ok ? "yes" : "no"} (r(2A3,is-paired) = ${num(f.r2a3, 3)}, mean prot = ${num(f.mean_prot_2a3, 3)})`],
    ["OpenKnot score", num(f.openknot, 3)],
    ["Pseudoknot", f.pseudoknot ? "yes" : "no"],
    ["Secondary-structure class", f.ss_class],
    ["Tertiary motifs", `${f.n_tert} (rare ${f.n_rare})`],
  ];
  const chips = (f.motifs || []).map((m) =>
    `<span class="motif-chip" style="background:${motifColor(m)}">${m.replace(/_/g, " ").toLowerCase()}</span>`).join(" ");
  $("props").innerHTML = "<table>" + rowsHtml.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("")
    + `<tr><td class="muted">Motifs</td><td>${chips}</td></tr></table>`;
}

function spansFor(id) {
  return (MOTIFS[id] || []).map(([type, res]) => {
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
  const motifs = spansFor(f.id);
  // lane assignment
  const lanes = [];
  motifs.forEach((m) => {
    const lo = Math.min(...m.ranges.map((r) => r[0])), hi = Math.max(...m.ranges.map((r) => r[1]));
    let li = lanes.findIndex((end) => end < lo);
    if (li < 0) { li = lanes.length; lanes.push(0); }
    lanes[li] = hi; m.lane = li;
  });
  const laneH = 9, mh = lanes.length * (laneH + 2);
  const yMot = pad, ySeq = yMot + mh + 4, yDms = ySeq + 16, yA23 = yDms + 16, H = yA23 + 18;
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
    svg += `<rect x="${i * cw}" y="${ySeq}" width="${cw - 0.5}" height="13" fill="${NUC_COLORS[ch] || "#ccc"}"/>`;
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
  svg += "</svg>";
  $("tracks").innerHTML = `<div style="font-size:11px;color:#5b6670;margin-bottom:3px">motif lanes &middot; sequence &middot; DMS &middot; 2A3 reactivity (white=protected &rarr; red=reactive)</div>` + svg;
}

let viewer = null;
async function load3D(id, react) {
  const el = $("viewer3d");
  el.innerHTML = "";
  if (typeof $3Dmol === "undefined") { el.innerHTML = '<p style="color:#fff;padding:8px">3Dmol.js not loaded.</p>'; return; }
  let data;
  try { data = await (await fetch("struct/" + id)).text(); }
  catch (e) { el.innerHTML = '<p style="color:#fff;padding:8px">structure unavailable</p>'; return; }
  viewer = $3Dmol.createViewer(el, { backgroundColor: "0x0d1117" });
  const fmt = data.startsWith("data_") || data.includes("_atom_site") ? "cif" : "pdb";
  viewer.addModel(data, fmt);
  const a23 = react && react.a23;
  if (a23) {
    viewer.setStyle({}, { cartoon: { colorfunc: (atom) => {
      const v = a23[atom.resi - 1];
      if (v == null || Number.isNaN(v)) return "0xf7f7f7";
      const t = Math.max(-0.3, Math.min(1, v));
      const f = (t + 0.3) / 1.3;  // 0..1 blue->white->red
      const c = f < 0.5 ? $3Dmol.CC.color(shapeMix(PROT_STOPS[0], PROT_STOPS[1], f * 2))
                        : $3Dmol.CC.color(shapeMix(PROT_STOPS[1], PROT_STOPS[2], (f - 0.5) * 2));
      return c;
    }, ringMode: 3 } });
  } else {
    viewer.setStyle({}, { cartoon: { color: "spectrum", ringMode: 3 } });
  }
  spansFor(id).forEach((m) => {
    const resi = [];
    m.ranges.forEach(([a, b]) => { for (let r = a; r <= b; r++) resi.push(r); });
    viewer.addStyle({ resi }, { stick: { color: motifColor(m.type), radius: 0.28 } });
  });
  viewer.zoomTo(); viewer.render();
}
function shapeMix(a, b, t) {
  return "0x" + [0, 1, 2].map((i) => Math.round((a[i] + (b[i] - a[i]) * t) * 255).toString(16).padStart(2, "0")).join("");
}

boot();
