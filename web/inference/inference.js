// RNAnix inference page — paste a sequence, get a structure. Progressive two-stage result:
// fast no-MSA draft first, then MSA-refined model when the MSA pipeline returns.
//
// BACKEND ADAPTER (fill in once the AWS pipeline entry point + output convention are known):
//   window.INFER_API  — base URL of the submit/status API (API Gateway). Empty => demo flow.
//   submit:  POST  {INFER_API}/predict   body {sequence,name,options,token}  -> {job_id}
//   status:  GET   {INFER_API}/status?job=<id>&t=<token>
//            -> { state:"queued|running|done|error", error?,
//                 stages:{ nomsa:{status, url?|cif?}, msa:{status, url?|cif?} } }
//   (status fields are read defensively; tweak mapStatus() to match the real shape.)
(function () {
  const $ = (id) => document.getElementById(id);
  const GATED = !!window.GATED;
  const API = (window.INFER_API || "").replace(/\/$/, "");
  const tok = () => (GATED ? localStorage.getItem("atlas_token") || "" : "");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const EXAMPLE = "GGGAACGACUCGAGUAGAGUCGAAAAGAGUGCUCCGAGAUGCGGUGAGAUUCCGCACCUGUGGUCAAAGCCCACAAACCAGCGCAAGCUGGCCUGGCAGGUGAAAUUCCUGCGCAG";
  const EXAMPLE_ENTITIES = [{ type: "rna", seq: EXAMPLE, count: 2 }];   // homodimer — showcases the copy-count field
  const STAGES_MSA = [["queued", "Queued"], ["msa", "MSA build"], ["refined", "Predict & refine"]];
  const STAGES_NOMSA = [["queued", "Queued"], ["nomsa", "Predicting"], ["refined", "Done"]];
  let curMsa = false;                          // whether the current job uses MSA (drives the timeline)
  let results = { nomsa: null, msa: null };   // CIF text per stage
  let shown = null, dmol = null, mstar = null, activeV = null, lastText = null, molstarLoading = null, curJobId = null;
  let openModels = [], _colorSeq = 0;          // session model registry (multi-model view — Feature 1)
  let vmode = (() => { try { return localStorage.getItem("infer_viewer") || "molstar"; } catch (e) { return "molstar"; } })();
  let ssMode = (() => { try { return localStorage.getItem("infer_ss") || "forna"; } catch (e) { return "forna"; } })();
  let curSS = null;                            // derived secondary structure of the shown model (Feature 2)
  let jobFilter = "";                          // live search filter over the Recent-jobs list

  // ---------- input entities (AF3-style: RNA / protein / DNA / ligand, each with a copy count) ----------
  const ENT_TYPES = {
    rna:     { label: "RNA",     unit: "nt", ph: "RNA sequence (A C G U). FASTA header optional.", msa: true },
    protein: { label: "Protein", unit: "aa", ph: "Protein sequence (20 aa). FASTA header optional.", msa: false },
    dna:     { label: "DNA",     unit: "bp", ph: "DNA sequence (A C G T). FASTA header optional.", msa: false },
    ligand:  { label: "Ligand",  unit: "",   ph: "CCD code (e.g. ATP, MG) or SMILES string", msa: false },
  };
  const ENT_ALPHA = { rna: /[^ACGUN]/, dna: /[^ACGTN]/, protein: /[^ACDEFGHIKLMNPQRSTVWYX]/ };
  const MAX_ENTITIES = 16, MAX_COUNT = 8, MIN_POLY = 5, MAX_RESIDUES = 5000;
  let entities = [{ type: "rna", seq: "", count: 1 }];   // ordered list of input entities

  // ---------- models ----------
  const MODELS_FALLBACK = [
    { id: "daslab-ptnx1", label: "Protenix (ptnx1)" },
    { id: "daslab-base", label: "daslab base" },
    { id: "daslab-v0", label: "daslab v0" },
  ];
  async function loadModels() {
    const sel = $("model"); if (!sel) return;
    let list = null;
    if (API) { try { const j = await (await fetch(`${API}/models${tok() ? "?t=" + encodeURIComponent(tok()) : ""}`)).json(); list = j.models || j; } catch (e) {} }
    if (!Array.isArray(list) || !list.length) list = MODELS_FALLBACK;
    const cur = sel.value;
    sel.innerHTML = list.map((m) => `<option value="${esc(m.id || "")}">${esc(m.label || m.id || "default")}</option>`).join("");
    if (cur) sel.value = cur;
  }
  const curModel = () => ($("model") ? $("model").value : "");
  function updateFleetHint() {
    const el = $("fleet_hint"); if (!el) return;
    const s = Math.max(1, Math.min(5, parseInt($("opt_seeds") && $("opt_seeds").value, 10) || 3));
    const n = Math.max(1, Math.min(5, parseInt($("opt_samples") && $("opt_samples").value, 10) || 5));
    const isFleet = /v0|base/i.test(curModel() || "");
    el.innerHTML = isFleet
      ? `Fleet: 5 models × ${s} seeds × ${n} samples = <b>${5 * s * n}</b> structures → top-5 kept. More = slower, usually more accurate.`
      : `Protenix (single-model) ignores seeds/samples — one pass, fast. Pick a fleet model (daslab-v0/base) to use these.`;
  }

  // ---------- jobs (monitor + cancel) ----------
  const JOBS_KEY = "infer_jobs";
  const RUNNING = new Set(["queued", "running", "submitted", "pending"]);
  const TERMINAL = new Set(["done", "error", "cancelled"]);
  function loadJobs() { try { return JSON.parse(localStorage.getItem(JOBS_KEY) || "[]"); } catch (e) { return []; } }
  function saveJobs(j) { try { localStorage.setItem(JOBS_KEY, JSON.stringify(j.slice(0, 50))); } catch (e) {} }
  function upsertJob(job) {
    const j = loadJobs(); const i = j.findIndex((x) => x.id === job.id);
    if (i >= 0) j[i] = { ...j[i], ...job }; else j.unshift(job);
    saveJobs(j); renderJobs();
  }
  // dedupe by target_id (id parts[1]) so the SAME job never shows twice — e.g. an older local
  // entry (3-part exec id) alongside the server-synced one (2-part id). Falls back to the whole
  // id when there's no target part; keeps the first occurrence (the user's own labeled entry).
  function uniqueJobs() {
    const seen = new Set(), out = [];
    for (const x of loadJobs()) {
      const key = String(x.id).split(":")[1] || String(x.id);
      if (seen.has(key)) continue;
      seen.add(key); out.push(x);
    }
    return out;
  }
  // live substring match on name / id / model, used by both the list render and the search box
  function filteredJobs() {
    const j = uniqueJobs();
    if (!jobFilter) return j;
    return j.filter((x) => (String(x.name || "") + " " + String(x.id || "") + " " + String(x.model || "")).toLowerCase().includes(jobFilter));
  }
  function renderJobs() {
    const el = $("jobs"); if (!el) return;
    const total = uniqueJobs().length;
    if (!total) { el.innerHTML = ""; return; }
    const j = filteredJobs();
    const count = jobFilter ? `${j.length} of ${total}` : `${total}`;
    const rows = j.map((x) => {
      const run = RUNNING.has(String(x.state || "").toLowerCase());
      // server-recovered jobs (fromServer) show the internal target_id — the friendly label
      // was browser-only. Show it muted + a ✎ to relabel; user labels persist in localStorage.
      const label = x.name || x.id.slice(0, 10);
      return `<div class="job"><span class="jn jopen${x.fromServer && x.name === x.id.split(":")[1] ? " jn-id" : ""}" data-id="${esc(x.id)}" title="open this result">${esc(label)}</span>`
        + `<button class="jren" data-id="${esc(x.id)}" title="rename this job">&#9998;</button>`
        + `<span class="jm">${esc(x.model || "default")}</span>`
        + `<span class="js js-${esc(String(x.state || "").toLowerCase())}">${esc(x.state || "")}</span>`
        + (run ? `<button class="jkill" data-id="${esc(x.id)}" title="stop this job">kill</button>` : "")
        + `</div>`;
    }).join("");
    el.innerHTML = `<div class="jobs-h">Recent jobs <span class="jobs-count">${count}</span></div>`
      + `<div class="jobs-list">${rows || '<div class="jobs-empty">no matching jobs</div>'}</div>`;
    el.querySelectorAll(".jkill").forEach((b) => b.onclick = (e) => { e.stopPropagation(); cancelJob(b.dataset.id); });
    el.querySelectorAll(".jren").forEach((b) => b.onclick = (e) => { e.stopPropagation(); renameJob(b.dataset.id); });
    el.querySelectorAll(".jopen").forEach((b) => b.onclick = () => reopenJob(b.dataset.id));
  }
  function renameJob(id) {
    const cur = loadJobs().find((x) => x.id === id) || {};
    const nm = prompt("Label for this job:", cur.name && cur.name !== id.split(":")[1] ? cur.name : "");
    if (nm == null) return;
    upsertJob({ id, name: nm.trim() || id.split(":")[1] || id.slice(0, 10) });
  }
  async function cancelJob(id) {
    if (API) { try { await fetch(`${API}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: id, token: tok() }) }); } catch (e) {} }
    upsertJob({ id, state: "cancelled" });
  }
  // click a job in the list to re-open its result (re-polls /status, renders the structure)
  async function reopenJob(id) {
    if (String(id).startsWith("demo-")) { setStatus("demo job — no real structure was produced. Submit a prediction to get one" + (API ? "." : " (backend not connected here).")); return; }
    if (!API) { setStatus("backend not connected — can't open stored results here."); return; }
    curMsa = ((loadJobs().find((x) => x.id === id) || {}).mode || "protenix-mt") !== "none";
    results = { nomsa: null, msa: null }; shown = null; $("ibadges").innerHTML = ""; updateSS();
    if ($("why-picks")) $("why-picks").hidden = true;
    setLoading("Loading structure… (large models can take ~20 s to fetch and render)"); setStatus("opening job " + String(id).slice(0, 16) + "…"); poll(id);
  }
  // "Open by ID": visualize ANY submitted job, even one not in this browser's list. Accepts a full
  // job id (model:target[:exec]) or a bare target hash — for a bare hash we probe each model for a
  // stored result and open the first that resolves, adding it to the local list.
  async function openById(raw) {
    raw = String(raw || "").trim();
    if (!raw) return;
    if (!API) { setStatus("backend not connected — can't open stored results here."); return; }
    if (raw.includes(":")) { const el = $("openid"); if (el) el.value = ""; return reopenJob(raw); }
    setLoading("Looking up " + raw.slice(0, 24) + "…");
    const ids = ($("model") ? Array.from($("model").options).map((o) => o.value).filter(Boolean) : []);
    const models = ids.length ? ids : MODELS_FALLBACK.map((x) => x.id);
    for (const m of models) {
      const jid = m + ":" + raw;
      try {
        const j = await (await fetch(`${API}/status?job=${encodeURIComponent(jid)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json();
        const hasR = j.stages && Object.values(j.stages).some((s) => s && (s.cif || s.url));
        if (j.state === "done" || hasR) {
          upsertJob({ id: jid, name: raw, model: m, state: "done", fromServer: true, ts: Date.now() });
          const el = $("openid"); if (el) el.value = "";
          setLoading(false); return reopenJob(jid);
        }
      } catch (e) {}
    }
    setLoading(false); setStatus("no stored result found for id: " + raw);
  }
  // Enter / Open button: if the live filter narrowed to exactly one job, open it; otherwise treat
  // the text as an id to look up (full id or bare target hash).
  function openFromSearch() {
    const v = ($("openid") ? $("openid").value : "").trim();
    if (!v) return;
    const m = filteredJobs();
    if (m.length === 1) { $("openid").value = ""; jobFilter = ""; renderJobs(); return reopenJob(m[0].id); }
    return openById(v);
  }

  // ---------- gate ----------
  function showGate(msg) {
    const g = $("gate"); g.classList.remove("hidden"); $("gate-msg").textContent = msg || "";
    const inp = $("gate-input"); inp.value = ""; inp.focus();
    const go = () => { const v = inp.value.trim(); if (!v) return; localStorage.setItem("atlas_token", v); g.classList.add("hidden"); init(); };
    $("gate-go").onclick = go; inp.onkeydown = (e) => { if (e.key === "Enter") go(); };
  }

  // ---------- entities: clean / measure / render / validate ----------
  function cleanEntity(type, raw) {
    if (type === "ligand") return String(raw || "").trim();                 // SMILES is case-sensitive
    let s = String(raw || "").split("\n").filter((l) => !l.startsWith(">")).join("").replace(/\s/g, "").toUpperCase();
    if (type === "rna") s = s.replace(/T/g, "U");
    if (type === "dna") s = s.replace(/U/g, "T");
    return s;
  }
  function polyLen(e) { return e.type === "ligand" ? 0 : cleanEntity(e.type, e.seq).length; }
  function totalResidues() { return entities.reduce((t, e) => t + polyLen(e) * (e.count || 1), 0); }
  function clampCount(v) { let n = parseInt(v, 10); if (!isFinite(n) || n < 1) n = 1; if (n > MAX_COUNT) n = MAX_COUNT; return n; }
  function entSummary(list) {
    return (list || []).map((e) => {
      if (e.type === "ligand") return "ligand(" + (cleanEntity("ligand", e.seq) || "?") + ")";
      const lbl = (ENT_TYPES[e.type] || {}).label || e.type;
      return ((e.count || 1) > 1 ? (e.count + "×") : "") + lbl;
    }).join(" + ");
  }
  function updateTotals() { $("seqlen").textContent = totalResidues() + " residues"; }
  function updateEntLen(i) {
    const el = $("entities") && $("entities").querySelector('.ent-len[data-i="' + i + '"]'); if (!el) return;
    const e = entities[i], t = ENT_TYPES[e.type] || ENT_TYPES.rna;
    el.textContent = e.type === "ligand" ? (cleanEntity("ligand", e.seq) ? "ligand" : "") : (cleanEntity(e.type, e.seq).length + " " + t.unit);
  }
  function renderEntities() {
    const wrap = $("entities"); if (!wrap) return;
    wrap.innerHTML = entities.map((e, i) => {
      const t = ENT_TYPES[e.type] || ENT_TYPES.rna;
      const opts = Object.keys(ENT_TYPES).map((k) => `<option value="${k}"${k === e.type ? " selected" : ""}>${ENT_TYPES[k].label}</option>`).join("");
      const caveat = (e.type === "protein" || e.type === "dna") ? `<span class="ent-caveat">single-sequence — no MSA yet</span>` : "";
      const del = entities.length > 1 ? `<button class="ent-del" data-i="${i}" type="button" title="remove entity">&times;</button>` : "";
      return `<div class="entity" data-i="${i}">`
        + `<div class="ent-head">`
        + `<select class="ent-type" data-i="${i}">${opts}</select>`
        + `<input class="ent-count" data-i="${i}" type="number" min="1" max="${MAX_COUNT}" step="1" value="${e.count || 1}" title="copies">`
        + `<button class="ent-up" data-i="${i}" type="button" title="move up"${i === 0 ? " disabled" : ""}>&#9650;</button>`
        + `<button class="ent-down" data-i="${i}" type="button" title="move down"${i === entities.length - 1 ? " disabled" : ""}>&#9660;</button>`
        + del
        + `</div>`
        + `<textarea class="ent-seq" data-i="${i}" rows="${e.type === "ligand" ? 2 : 4}" placeholder="${esc(t.ph)}">${esc(e.seq)}</textarea>`
        + `<div class="ent-info">${caveat}<span class="ent-len" data-i="${i}"></span></div>`
        + `</div>`;
    }).join("");
    wrap.querySelectorAll(".ent-type").forEach((s) => (s.onchange = () => { entities[+s.dataset.i].type = s.value; renderEntities(); }));
    wrap.querySelectorAll(".ent-count").forEach((inp) => (inp.oninput = () => { entities[+inp.dataset.i].count = clampCount(inp.value); updateTotals(); }));
    wrap.querySelectorAll(".ent-seq").forEach((ta) => (ta.oninput = () => { const i = +ta.dataset.i; entities[i].seq = ta.value; updateEntLen(i); updateTotals(); }));
    wrap.querySelectorAll(".ent-del").forEach((b) => (b.onclick = () => removeEntity(+b.dataset.i)));
    wrap.querySelectorAll(".ent-up").forEach((b) => (b.onclick = () => moveEntity(+b.dataset.i, -1)));
    wrap.querySelectorAll(".ent-down").forEach((b) => (b.onclick = () => moveEntity(+b.dataset.i, 1)));
    entities.forEach((_, i) => updateEntLen(i));
    updateTotals();
  }
  function addEntity(type) { if (entities.length >= MAX_ENTITIES) return; entities.push({ type: type || "rna", seq: "", count: 1 }); renderEntities(); }
  function removeEntity(i) { if (entities.length > 1) { entities.splice(i, 1); renderEntities(); } }
  function moveEntity(i, d) { const j = i + d; if (j < 0 || j >= entities.length) return; const t = entities[i]; entities[i] = entities[j]; entities[j] = t; renderEntities(); }
  function loadExample() { entities = EXAMPLE_ENTITIES.map((e) => ({ ...e })); renderEntities(); }
  function validateEntities() {
    if (!entities.length) return { ok: false, msg: "Add at least one entity." };
    let hasPoly = false;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i], n = i + 1, t = ENT_TYPES[e.type];
      if (!t) return { ok: false, i, msg: `Entity ${n}: unknown type.` };
      const s = cleanEntity(e.type, e.seq);
      if (e.type === "ligand") {
        if (!s) return { ok: false, i, msg: `Entity ${n} (ligand): enter a CCD code or SMILES.` };
        const ccd = /^[A-Za-z0-9]{1,5}$/.test(s), smiles = /^[A-Za-z0-9@+\-\[\]()=#$%.\/\\:*]+$/.test(s);
        if (!ccd && !smiles) return { ok: false, i, msg: `Entity ${n} (ligand): not a valid CCD code or SMILES.` };
        continue;
      }
      hasPoly = true;
      if (s.length < MIN_POLY) return { ok: false, i, msg: `Entity ${n} (${t.label}) must be ≥ ${MIN_POLY} ${t.unit}.` };
      if (ENT_ALPHA[e.type].test(s)) return { ok: false, i, msg: `Entity ${n} (${t.label}) has invalid characters (allowed: ${e.type === "rna" ? "A C G U N" : e.type === "dna" ? "A C G T N" : "20 aa + X"}).` };
    }
    if (!hasPoly) return { ok: false, msg: "Add at least one polymer (RNA / protein / DNA) — a ligand alone can't be folded." };
    if (totalResidues() > MAX_RESIDUES) return { ok: false, msg: `Total ${totalResidues()} residues exceeds the ${MAX_RESIDUES} limit for the web submitter.` };
    return { ok: true };
  }
  function markInvalid(i) {
    const rows = $("entities") ? $("entities").querySelectorAll(".entity") : [];
    rows.forEach((r, k) => r.classList.toggle("invalid", k === i));
  }
  function isSingleChainJob() {
    const jb = loadJobs().find((x) => x.id === curJobId);
    if (!jb || !jb.entities) return true;                 // legacy / server-recovered jobs: keep old single-chain behavior
    const poly = jb.entities.filter((e) => e.type !== "ligand");
    return poly.length === 1 && (poly[0].count || 1) === 1;
  }

  // ---------- stage timeline ----------
  function renderStages(state) {
    const list = curMsa ? STAGES_MSA : STAGES_NOMSA;
    $("stages").innerHTML = list.map(([k, lbl]) => {
      const st = state[k] || "wait";
      const cls = st === "done" ? "done" : st === "running" ? "run" : (st === "error" || st === "err") ? "err" : "wait";
      return `<div class="stage ${cls}"><i></i>${esc(lbl)}${st === "running" ? " …" : ""}</div>`;
    }).join("");
  }

  // ---------- 3D viewers + session model registry (Feature 1) ----------
  // Opening a result ADDS a model; each can be shown/hidden/closed independently instead of
  // reloading the page to clear. 3Dmol keeps a per-model GLModel handle (show/hide via setStyle,
  // removeModel on close); Mol* clears + reloads the visible set on each change (the wrapper's
  // loadStructureFromData returns no handle) — which also fixes the old missing-clear that let
  // Mol* structures stack unintentionally.
  const MODEL_COLORS = ["#2e6f95", "#e8862e", "#3a7d44", "#c1440e", "#6a4c93", "#16a0a0", "#d1495b", "#5b7c99"];
  const modelUid = (k) => (curJobId || "job") + ":" + k;
  const fmtOf = (text) => (text.startsWith("data_") || text.includes("_atom_site") ? "cif" : "pdb");
  function loadMolstarLib() {                       // lazy-load the vendored ~5MB bundle on first use
    if (window.molstar) return Promise.resolve();
    if (molstarLoading) return molstarLoading;
    molstarLoading = new Promise((res, rej) => {
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "molstar.css"; document.head.appendChild(css);
      const s = document.createElement("script"); s.src = "molstar.js"; s.onload = () => res(); s.onerror = () => rej(new Error("molstar")); document.head.appendChild(s);
    });
    return molstarLoading;
  }
  function resetContainer() {
    try { if (mstar && mstar.dispose) mstar.dispose(); } catch (e) {}
    $("iviewer").innerHTML = ""; dmol = null; mstar = null; activeV = null;
    openModels.forEach((m) => (m.dHandle = null));   // GLModel handles die with the viewer
  }
  function markViewerButtons() {
    const t = $("vtoggle"); if (!t) return;
    t.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === vmode));
  }
  function setViewer(v) {
    if (v === vmode) return;
    vmode = v; try { localStorage.setItem("infer_viewer", v); } catch (e) {}
    markViewerButtons();
    if (openModels.length) renderModels(true);
  }
  function showResultArea() { $("iplaceholder").style.display = "none"; $("iview").classList.add("show"); }
  // add (or re-show) a stage's structure in the registry, then render + focus it
  async function openModel(k) {
    if (!results[k]) return;
    const uid = modelUid(k);
    let m = openModels.find((x) => x.uid === uid);
    if (!m) {
      const jb = loadJobs().find((x) => x.id === curJobId) || {};
      const nm = jb.name || (curJobId ? String(curJobId).split(":")[1] : "") || "prediction";
      const stageLbl = k === "msa" ? "MSA-refined" : "Draft (no-MSA)";
      m = { uid, k, label: nm + " · " + stageLbl, text: results[k], visible: true,
            dHandle: null, color: MODEL_COLORS[_colorSeq++ % MODEL_COLORS.length] };
      openModels.push(m);
    } else { m.visible = true; m.text = results[k]; }
    shown = k; lastText = m.text;
    showResultArea();
    // data-driven UI (download/export, model list, 2D structure) is derived from the result text
    // and MUST NOT depend on the 3D viewer — render it first so a slow/failed 3D render can never
    // hide the export button. Then attempt the 3D render separately, tolerating failure.
    renderBadges(); renderModelPanel(); updateSS();
    try { await renderModels(true); }
    catch (e) { setStatus("3D preview failed to render — the structure is still available to download. " + e.message); }
  }
  async function renderModels(fit) {
    if (!openModels.length) return;
    showResultArea();
    // Respect the chosen viewer. Mol* handles big structures now that the data path is fast
    // (presigned URL); if it ever genuinely stalls, renderModelsMolstar's timeout falls back to
    // 3Dmol on its own — so we no longer force big ones away from Mol*.
    if (vmode === "molstar") await renderModelsMolstar(fit);
    else renderModels3Dmol(fit);
  }
  function renderModels3Dmol(fit) {
    if (activeV !== "3dmol") resetContainer();
    activeV = "3dmol";
    if (typeof $3Dmol === "undefined") { setStatus("3Dmol not loaded"); return; }
    if (!dmol) dmol = $3Dmol.createViewer($("iviewer"), { backgroundColor: "0x0d1117" });
    let added = false;
    for (const m of openModels) {
      if (!m.dHandle) { m.dHandle = dmol.addModel(m.text, fmtOf(m.text)); added = true; }
      if (m.visible) m.dHandle.setStyle({}, { cartoon: { color: m.color, ringMode: 3 } });
      else m.dHandle.setStyle({}, {});           // empty style => hidden
    }
    if (fit || added) dmol.zoomTo();
    dmol.render(); dmol.resize();
  }
  let _molstarSeq = 0;
  async function renderModelsMolstar(fit) {
    if (activeV !== "molstar") resetContainer();
    activeV = "molstar";
    try { await loadMolstarLib(); }
    catch (e) { vmode = "3dmol"; markViewerButtons(); return renderModels3Dmol(fit); }
    try {
      if (!mstar) mstar = await molstar.Viewer.create($("iviewer"), {
        layoutIsExpanded: false, layoutShowControls: true, layoutShowSequence: true,
        layoutShowLog: false, viewportShowExpand: true, viewportShowSelectionMode: false,
      });
    } catch (e) { setStatus("Mol* init failed — using 3Dmol"); return renderModels3Dmol(fit); }
    const seq = ++_molstarSeq;
    try {
      await mstar.plugin.clear();                  // FIX: clear so visible models don't stack
      for (const m of openModels) {
        if (!m.visible) continue;
        if (seq !== _molstarSeq) return;           // a newer render superseded this one
        // Big / non-standard structures (e.g. a 6+ MB CASP PFRMAT-TS multi-model PDB) can stall
        // Mol*. Cap the wait and fall back to the lighter, more tolerant 3Dmol viewer so the
        // structure always shows rather than silently never appearing.
        await Promise.race([
          mstar.loadStructureFromData(m.text, fmtOf(m.text) === "cif" ? "mmcif" : "pdb"),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Mol* timed out")), 45000)),
        ]);
      }
    } catch (e) { setStatus("Mol* couldn't render this one — using 3Dmol"); return renderModels3Dmol(fit); }
  }
  function toggleModel(uid, visible) {
    const m = openModels.find((x) => x.uid === uid); if (!m) return;
    m.visible = visible; renderModels(false); renderModelPanel();
  }
  function closeModel(uid) {
    const i = openModels.findIndex((x) => x.uid === uid); if (i < 0) return;
    const m = openModels[i];
    if (dmol && m.dHandle) { try { dmol.removeModel(m.dHandle); } catch (e) {} }
    openModels.splice(i, 1);
    if (shown && modelUid(shown) === uid) { shown = null; lastText = null; }
    if (openModels.length) renderModels(false);
    else {
      if (dmol) dmol.render();
      if (mstar) { try { mstar.plugin.clear(); } catch (e) {} }
      $("iview").classList.remove("show"); $("iplaceholder").style.display = "";
    }
    renderModelPanel(); renderBadges(); updateSS();
  }
  function setAllModels(visible) {
    if (!openModels.length) return;
    openModels.forEach((m) => (m.visible = visible));
    renderModels(visible); renderModelPanel();
  }
  function clearModels() {
    if (dmol) openModels.forEach((m) => { if (m.dHandle) { try { dmol.removeModel(m.dHandle); } catch (e) {} } });
    openModels = []; shown = null; lastText = null;
    if (dmol) dmol.render();
    if (mstar) { try { mstar.plugin.clear(); } catch (e) {} }
    $("iview").classList.remove("show"); $("iplaceholder").style.display = "";
    renderModelPanel(); renderBadges(); updateSS();
  }
  function renderModelPanel() {
    const el = $("models"); if (!el) return;
    if (!openModels.length) { el.innerHTML = ""; return; }
    const anyVis = openModels.some((m) => m.visible);
    el.innerHTML = '<div class="jobs-h">Models <span class="mh-actions">'
      + `<button class="mh-btn" id="m-toggleall">${anyVis ? "hide all" : "show all"}</button>`
      + `<button class="mh-btn" id="m-clearall">clear all</button></span></div>`
      + openModels.map((m) =>
        `<div class="model">`
        + `<input type="checkbox" class="mvis" data-uid="${esc(m.uid)}"${m.visible ? " checked" : ""} title="show / hide">`
        + `<span class="msw" style="background:${m.color}"></span>`
        + `<span class="mn${shown && modelUid(shown) === m.uid ? " mn-cur" : ""}" title="${esc(m.label)}">${esc(m.label)}</span>`
        + `<button class="mclose" data-uid="${esc(m.uid)}" title="close this model">&times;</button>`
        + `</div>`).join("");
    el.querySelectorAll(".mvis").forEach((c) => (c.onchange = () => toggleModel(c.dataset.uid, c.checked)));
    el.querySelectorAll(".mclose").forEach((b) => (b.onclick = () => closeModel(b.dataset.uid)));
    $("m-toggleall").onclick = () => setAllModels(!anyVis);
    $("m-clearall").onclick = clearModels;
  }

  // ---------- secondary structure, derived client-side from the shown model's 3D (Feature 2) ----------
  function deriveCurrentSS() {
    if (!shown || !results[shown]) { curSS = null; return; }
    const uid = modelUid(shown);
    if (curSS && curSS.uid === uid) return;        // cached for the current model
    try { curSS = Object.assign({ uid }, deriveSS(results[shown])); }
    catch (e) { curSS = null; }
  }
  function updateSS() {
    const blk = $("issblock"); if (!blk) return;
    // the client SS derivation reads the first chain of the top model only. For a complex that's
    // "chain A" (labeled as such in renderSS) rather than the whole assembly — still useful, so we
    // show it instead of hiding. It naturally disappears (n==0) when chain A has no RNA pairs
    // (e.g. a protein-first complex).
    deriveCurrentSS();
    if (!curSS || !curSS.n) { blk.setAttribute("hidden", ""); if ($("ss-svg")) $("ss-svg").innerHTML = ""; return; }
    blk.removeAttribute("hidden"); renderSS();
  }
  function renderSS() {
    if (!curSS) return;
    const n = curSS.n;
    let svg;
    if (ssMode === "arc") {
      const cw = Math.max(6, Math.min(16, Math.floor(900 / Math.max(1, n))));
      svg = arcDiagram(curSS.dbn, n, cw, n * cw);
    } else {
      svg = forna2D("infer:" + curSS.uid, curSS.dbn, curSS.seq, null, 380, false);
    }
    $("ss-svg").innerHTML = svg || '<div class="muted" style="padding:6px 0">No canonical base pairs detected — the model looks single-stranded.</div>';
    const scope = isSingleChainJob() ? "" : "chain A only · ";
    $("ss-info").textContent = `${scope}${curSS.cls} · ${(curSS.bpf * 100).toFixed(0)}% paired · ${n} nt`;
    if ($("ss-mode")) $("ss-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.m === ssMode));
  }
  function setSSMode(m) {
    if (m === ssMode) return;
    ssMode = m; try { localStorage.setItem("infer_ss", m); } catch (e) {}
    renderSS();
  }
  function exportDbn() {
    deriveCurrentSS();
    if (!curSS || !curSS.n) return;
    const jb = loadJobs().find((x) => x.id === curJobId) || {};
    const base = safeName(jb.name || (curJobId ? String(curJobId).split(":")[1] : "") || "prediction") || "prediction";
    const hdr = `>${base}${shown ? " " + shown : ""} len=${curSS.n} class=${curSS.cls} bp_fraction=${curSS.bpf}`;
    const body = `${hdr}\n${curSS.seq}\n${curSS.dbn}\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    a.download = base + ".dbn"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportSSPng() {
    const svgEl = $("ss-svg") && $("ss-svg").querySelector("svg"); if (!svgEl) return;
    const w = parseFloat(svgEl.getAttribute("width")) || 380, h = parseFloat(svgEl.getAttribute("height")) || 380;
    const xml = new XMLSerializer().serializeToString(svgEl);
    const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
    const img = new Image();
    img.onload = () => {
      const scale = 2, c = document.createElement("canvas");
      c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.drawImage(img, 0, 0);
      const jb = loadJobs().find((x) => x.id === curJobId) || {};
      const base = safeName(jb.name || (curJobId ? String(curJobId).split(":")[1] : "") || "prediction") || "prediction";
      const a = document.createElement("a"); a.href = c.toDataURL("image/png");
      a.download = base + "_ss.png"; document.body.appendChild(a); a.click(); a.remove();
    };
    img.src = url;
  }
  function renderBadges() {
    const order = [["msa", "MSA-refined"], ["nomsa", "Draft (no MSA)"]];
    // the full sample pool lives at predictions/<target>/<model>/ — available for any
    // real API job (parts[1] = target_id), including cached ones.
    const canPool = !!(API && curJobId && curJobId.split(":")[1] && !String(curJobId).startsWith("demo-"));
    const dl = Object.values(results).some(Boolean)
      ? `<span class="dlwrap">`
        + `<button class="rbadge dl" id="rdl">&#10515; export zip</button>`
        + (canPool ? `<button class="rbadge dlcaret" id="rdlmenu" title="More downloads" aria-haspopup="true" aria-expanded="false">&#9662;</button>`
          + `<div class="dlmenu" id="dlmenu" hidden>`
          + `<button class="dlmi" id="dlpool">&#10515; Download all predictions</button>`
          + `<div class="dlmi-sub">the entire model sample pool (all seeds &amp; samples)</div>`
          + `</div>` : "")
        + `</span>`
      : "";
    $("ibadges").innerHTML = order.filter(([k]) => results[k]).map(([k, lbl]) =>
      `<button class="rbadge ${shown === k ? "active" : ""}" data-k="${k}">${lbl}</button>`).join("") + dl;
    $("ibadges").querySelectorAll(".rbadge[data-k]").forEach((b) => b.onclick = () => view(b.dataset.k));
    if ($("rdl")) $("rdl").onclick = exportZip;
    const menuBtn = $("rdlmenu"), menu = $("dlmenu");
    if (menuBtn && menu) {
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const open = menu.hasAttribute("hidden");
        if (open) menu.removeAttribute("hidden"); else menu.setAttribute("hidden", "");
        menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      };
      if ($("dlpool")) $("dlpool").onclick = () => { menu.setAttribute("hidden", ""); menuBtn.setAttribute("aria-expanded", "false"); exportPool(); };
      if (!renderBadges._docClose) {   // close on outside click, wired once
        renderBadges._docClose = true;
        document.addEventListener("click", () => { const m = $("dlmenu"), b = $("rdlmenu"); if (m) m.setAttribute("hidden", ""); if (b) b.setAttribute("aria-expanded", "false"); });
      }
    }
  }
  function view(k) { return openModel(k); }   // a stage badge opens that stage into the model registry
  async function gotResult(k, text) { results[k] = text; if (k === "msa" || !results.msa) await view(k); else renderBadges(); }

  // ---------- export bundle (pdb + cif + png + txt -> zip; same store-zip as the main atlas) ----------
  const _enc = (s) => new TextEncoder().encode(s);
  function safeName(s) { return String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 90); }
  let _CRCT = null;
  function crc32(u8) {
    if (!_CRCT) { _CRCT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; _CRCT[n] = c >>> 0; } }
    let crc = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) crc = _CRCT[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const parts = [], central = []; let off = 0;
    for (const f of files) {
      const nb = _enc(f.name), d = f.data, crc = crc32(d);
      const lh = new Uint8Array(30 + nb.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true);
      lv.setUint16(26, nb.length, true); lh.set(nb, 30); parts.push(lh, d);
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
  function dataURIBytes(uri) { const bin = atob(uri.split(",")[1]), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
  function pdbToCif(text, id) {   // derive mmCIF from the PDB atoms (viewer-independent)
    let s = "data_" + id + "\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\n_atom_site.type_symbol\n_atom_site.label_atom_id\n" +
      "_atom_site.label_comp_id\n_atom_site.label_asym_id\n_atom_site.label_seq_id\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\n_atom_site.occupancy\n_atom_site.B_iso_or_equiv\n";
    let i = 0;
    for (const l of text.split("\n")) {
      if (!(l.startsWith("ATOM") || l.startsWith("HETATM"))) continue;
      i++;
      const atom = l.slice(12, 16).trim() || "X", resn = l.slice(17, 20).trim() || "X", chain = l.slice(21, 22).trim() || "A",
        resi = l.slice(22, 26).trim() || "1", x = l.slice(30, 38).trim(), y = l.slice(38, 46).trim(), z = l.slice(46, 54).trim(),
        b = l.slice(60, 66).trim() || "0", el = l.slice(76, 78).trim() || atom.slice(0, 1);
      s += ["ATOM", i, el, atom, resn, chain, resi, x, y, z, "1.00", b].join(" ") + "\n";
    }
    return s + "#\n";
  }
  function viewerPNG() {
    try { if (activeV === "3dmol" && dmol) return dataURIBytes(dmol.pngURI()); } catch (e) {}
    try { const c = $("iviewer").querySelector("canvas"); if (c) { const u = c.toDataURL("image/png"); if (u && u.length > 3000) return dataURIBytes(u); } } catch (e) {}
    return null;
  }
  async function exportZip() {
    if (!lastText) return;
    const jb = loadJobs().find((x) => x.id === curJobId) || {};
    const base = safeName(jb.name || shown || "prediction") || "prediction";
    const meta = [
      "name: " + (jb.name || ""), "model: " + (jb.model || "default"), "alignment: " + (jb.mode || ""),
      "stage: " + (shown || ""), "job_id: " + (curJobId || ""),
    ];
    if (jb.entities && jb.entities.length) {
      meta.push("entities: " + (jb.summary || ""));
      jb.entities.forEach((e, i) => meta.push(`  [${i + 1}] ${e.type} x${e.count || 1}: ${e.sequence}`));
    } else if (jb.seq) {
      meta.push("length: " + jb.seq.length + " nt"); meta.push("sequence:\n" + jb.seq);
    }
    const files = [
      { name: base + ".txt", data: _enc(meta.join("\n") + "\n") },
      { name: base + ".pdb", data: _enc(lastText) },
      { name: base + ".cif", data: _enc(pdbToCif(lastText, base)) },
    ];
    const png = viewerPNG(); if (png) files.push({ name: base + ".png", data: png });
    // client-derived secondary structure of the shown model (dot-bracket)
    deriveCurrentSS();
    if (curSS && curSS.n) files.push({ name: base + ".dbn", data: _enc(`>${base} class=${curSS.cls} bp_fraction=${curSS.bpf}\n${curSS.seq}\n${curSS.dbn}\n`) });
    // include the MSA/rMSA alignment files when the job used them
    if (API && jb.mode && jb.mode !== "none" && curJobId) {
      setStatus("bundling alignments…");
      try {
        const r = await (await fetch(`${API}/msa?job=${encodeURIComponent(curJobId)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json();
        (r.files || []).forEach((mf) => { if (mf.content) files.push({ name: base + "_" + mf.name.replace(/[\/]/g, "_"), data: _enc(mf.content) }); });
      } catch (e) {}
      setStatus("done");
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipStore(files)); a.download = base + ".zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- download the ENTIRE prediction pool (every seed/sample, not just the top-5) ----------
  // The pipeline persists the raw model output at predictions/<target>/<model>/<branch>/…/
  // seed_<N>/predictions/<target>_sample_<i>.cif (+ per-sample confidence json). We list it
  // via /pool then stream each file through /poolfile and store-zip client-side, so the whole
  // pool ships even when it exceeds the API's single-response size limit.
  async function exportPool() {
    if (!API || !curJobId) return;
    const jb = loadJobs().find((x) => x.id === curJobId) || {};
    const base = safeName(jb.name || curJobId.split(":")[1] || "prediction") || "prediction";
    setStatus("listing prediction pool…");
    let list;
    try { list = await (await fetch(`${API}/pool?job=${encodeURIComponent(curJobId)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json(); }
    catch (e) { setStatus("pool list failed: " + e.message); return; }
    const items = (list && list.files) || [];
    if (!items.length) { setStatus("no prediction pool found for this job"); return; }
    const files = [];
    let done = 0;
    const q = items.slice();
    async function worker() {
      while (q.length) {
        const it = q.shift();
        try {
          const r = await fetch(`${API}/poolfile?job=${encodeURIComponent(curJobId)}&key=${encodeURIComponent(it.key)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`);
          if (r.ok) files.push({ name: it.name, data: _enc(await r.text()) });  // keep the pool's folder structure in the zip
        } catch (e) {}
        setStatus(`downloading pool ${++done}/${items.length}…`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
    if (!files.length) { setStatus("pool download failed"); return; }
    // a small manifest so the zip is self-describing
    const meta = [
      "name: " + (jb.name || ""), "model: " + (jb.model || "default"), "alignment: " + (jb.mode || ""),
      "job_id: " + curJobId, "pool_members: " + files.length + " of " + items.length,
    ];
    if (jb.entities && jb.entities.length) {
      meta.push("entities: " + (jb.summary || ""));
      jb.entities.forEach((e, i) => meta.push(`  [${i + 1}] ${e.type} x${e.count || 1}: ${e.sequence}`));
    } else if (jb.seq) {
      meta.push("length: " + jb.seq.length + " nt"); meta.push("sequence:\n" + jb.seq);
    }
    files.unshift({ name: "README.txt", data: _enc(meta.join("\n") + "\n") });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipStore(files)); a.download = base + "_pool.zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus("done — " + files.length + " pool files");
  }

  // ---------- backend adapter ----------
  async function fetchCif(s) { if (s.url) return (await fetch(s.url.includes("?") ? s.url : s.url + (tok() ? "?t=" + encodeURIComponent(tok()) : ""))).text(); return s.cif || ""; }
  function mapStatus(j) {       // normalize backend status -> {state, stages:{queued,nomsa,msa,refined}, results}
    const st = j.stages || {}, nm = st.nomsa || {}, ms = st.msa || {};
    const hasR = nm.url || nm.cif || ms.url || ms.cif;
    const done = j.state === "done" || hasR;
    const err = j.state === "error";
    const mid = done ? "done" : (err ? "err" : "running");
    // don't coincidentally default a missing/malformed state to "running" — that reads as
    // real progress. "unknown" is the honest label when the backend gave us nothing usable.
    return {
      state: j.state || "unknown", error: j.error,
      flags: { queued: "done", msa: mid, nomsa: mid, refined: done ? "done" : (err ? "err" : "wait") },
      nomsa: nm, msa: ms,
    };
  }
  async function poll(jobId) {
    curJobId = jobId;
    // if this job already reached a terminal state locally (done/error/cancelled — e.g. the
    // user is just re-opening an old result), a single ambiguous re-poll must never downgrade
    // it back to "running"/"unknown". That's exactly what happened for jobs whose execution no
    // longer resolves against the current backend (recreated pipeline, different STAGE, a
    // job_id from a prior backend generation, ...): the server can't confirm anything, but
    // that's not evidence the job started running again.
    const wasTerminal = TERMINAL.has(String((loadJobs().find((x) => x.id === jobId) || {}).state || "").toLowerCase());
    for (let i = 0; i < 600; i++) {
      if (String((loadJobs().find((x) => x.id === jobId) || {}).state).toLowerCase() === "cancelled") { setLoading(false); setStatus("cancelled"); return; }
      let j; try { j = await (await fetch(`${API}/status?job=${encodeURIComponent(jobId)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json(); }
      catch (e) { setLoading(false); setStatus("status check failed: " + e.message); return; }
      const m = mapStatus(j);
      const newState = String(m.state || "").toLowerCase();
      if (!wasTerminal || newState === "done" || newState === "error") upsertJob({ id: jobId, state: m.state });
      renderStages(m.flags);
      try {
        if (m.nomsa && (m.nomsa.url || m.nomsa.cif) && !results.nomsa) await gotResult("nomsa", await fetchCif(m.nomsa));
        if (m.msa && (m.msa.url || m.msa.cif) && !results.msa) await gotResult("msa", await fetchCif(m.msa));
      } catch (e) { setStatus("could not render structure: " + e.message); }
      setLoading(false);   // response received + structure rendered (or fell back / failed)
      if (m.state === "error") { setStatus("⚠ " + (m.error || "prediction failed")); notifyDone(jobId, false, m.error); return; }
      if (m.state === "done" || (results.nomsa && results.msa)) { setStatus("done"); notifyDone(jobId, true); showWhyPicks(jobId); return; }
      if (wasTerminal) {
        // already had a terminal result cached and this re-poll didn't reconfirm it — stop
        // instead of hammering an unresolvable job every 3s for up to 30 minutes.
        setStatus(newState === "unknown" ? "note: this job's backend record is no longer resolvable — showing the last known result." : "done");
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // Expert-mode "Why these picks" panel — best-effort, non-blocking; silently stays hidden for
  // non-expert jobs (empty brief/rationale) or if the fetch fails.
  async function showWhyPicks(jobId) {
    if (!API || !jobId) return;
    let r;
    try { r = await (await fetch(`${API}/brief?job=${encodeURIComponent(jobId)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json(); }
    catch (e) { return; }
    const panel = $("why-picks");
    if (!panel || (!r.brief && !r.rationale && !r.thinking && !(r.template_pdb_ids || []).length)) { if (panel) panel.hidden = true; return; }
    $("why-gate").textContent = r.gate === "TRUST" ? "template used" : "no template";
    $("why-family").textContent = (r.template_pdb_ids || []).length ? "Templates: " + r.template_pdb_ids.join(", ") : "";
    $("why-brief").textContent = r.brief || "";
    $("why-rationale").textContent = r.rationale || "";
    const thinkWrap = $("why-thinking-wrap");
    if (thinkWrap) {
      thinkWrap.hidden = !r.thinking;
      if (r.thinking) $("why-thinking").textContent = r.thinking;
    }
    panel.hidden = false;
  }
  function setStatus(t) { $("infer-status").textContent = t; }
  // top banner shown while a stored result is being fetched/rendered (big structures take a moment)
  function setLoading(msg) {
    const el = $("iloading"); if (!el) return;
    if (msg) { el.textContent = msg; el.removeAttribute("hidden"); }
    else el.setAttribute("hidden", "");
  }
  // ---------- browser notification + tab-title flash on completion ----------
  const baseTitle = document.title;
  function flashTitle(tag) {
    if (!document.hidden) return;
    document.title = tag + " — " + baseTitle;
    const restore = () => { document.title = baseTitle; document.removeEventListener("visibilitychange", restore); };
    document.addEventListener("visibilitychange", restore);
  }
  function notifyDone(jobId, ok, err) {
    const jn = (loadJobs().find((x) => x.id === jobId) || {}).name || "prediction";
    flashTitle(ok ? "✅ done" : "⚠ failed");
    try {
      if (window.Notification && Notification.permission === "granted") {
        new Notification(ok ? "✅ Prediction ready" : "⚠ Prediction failed",
          { body: ok ? jn + " — structure is ready" : jn + " — " + (err || "failed"), icon: "../icon.png" });
      }
    } catch (e) {}
  }

  async function predict() {
    const v = validateEntities();
    if (!v.ok) { markInvalid(v.i == null ? -1 : v.i); $("predict-note").textContent = v.msg; return; }
    markInvalid(-1);
    const ents = entities.map((e) => ({ type: e.type, sequence: cleanEntity(e.type, e.seq), count: clampCount(e.count) }));
    const summary = entSummary(entities);
    // backward-compat: still send a single `sequence` (the first RNA) so an un-upgraded bridge works
    const firstRna = ents.find((e) => e.type === "rna");
    const legacySeq = firstRna ? firstRna.sequence : "";
    results = { nomsa: null, msa: null }; shown = null; $("ibadges").innerHTML = ""; $("predict-note").textContent = ""; updateSS();
    if ($("why-picks")) $("why-picks").hidden = true;
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
    const mode = $("msa_mode").value || "protenix-mt";
    const nSeeds = Math.max(1, Math.min(5, parseInt($("opt_seeds").value, 10) || 3));
    const nSamples = Math.max(1, Math.min(5, parseInt($("opt_samples").value, 10) || 5));
    const relax = $("opt_relax") ? $("opt_relax").checked : true;
    const expert = $("opt_expert") ? $("opt_expert").checked : false;
    const description = $("opt_description") ? $("opt_description").value.trim() : "";
    const opts = { mode, seeds: nSeeds, samples: nSamples, relax, expert, description };
    curMsa = mode !== "none";
    const model = curModel(), jobName = $("jobname").value.trim();
    renderStages({ queued: "running" }); setStatus("submitting…");
    if (!API) { return demo(model, jobName); }
    let jobId, j0;
    try {
      const r = await fetch(`${API}/predict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: legacySeq, entities: ents, name: jobName, model, options: opts, token: tok() }) });
      if (!r.ok) throw new Error("HTTP " + r.status); j0 = await r.json(); jobId = j0.job_id;
    } catch (e) { setStatus("submit failed: " + e.message); $("predict-note").textContent = "Could not reach the inference backend."; return; }
    upsertJob({ id: jobId, name: jobName || jobId.slice(0, 10), model, mode, seq: legacySeq, entities: ents, summary, state: (j0.status || "submitted").toLowerCase(), ts: Date.now() });
    if (String(j0.status).toUpperCase() === "CACHED") { $("predict-note").innerHTML = "<b>Cached</b> — this input + model was already predicted; showing the stored result."; }
    setStatus("running — job " + jobId); poll(jobId);
  }

  // demo flow (no backend configured): walk the staged UI so the UX is visible
  function demo(model, jobName) {
    const id = "demo-" + Date.now().toString(36);
    curMsa = ($("msa_mode").value || "") !== "none";
    upsertJob({ id, name: jobName || "demo", model: model || "default", mode: $("msa_mode").value, entities: entities.map((e) => ({ type: e.type, sequence: cleanEntity(e.type, e.seq), count: clampCount(e.count) })), summary: entSummary(entities), state: "running", ts: Date.now() });
    $("predict-note").innerHTML = "<b>Demo mode</b> — inference backend not connected yet. Showing the staged flow (incl. model choice, monitoring &amp; kill); real predictions appear once <code>INFER_API</code> is wired to the AWS pipeline.";
    renderStages({ queued: "done", nomsa: "running" });
    setStatus("running (demo)…");
    setTimeout(() => { if (String((loadJobs().find((x) => x.id === id) || {}).state) === "cancelled") return; renderStages({ queued: "done", nomsa: "done", msa: "running" }); $("iplaceholder").textContent = "Draft (no-MSA) would render here…"; }, 1200);
    setTimeout(() => { if (String((loadJobs().find((x) => x.id === id) || {}).state) === "cancelled") return; renderStages({ queued: "done", nomsa: "done", msa: "done", refined: "done" }); $("iplaceholder").textContent = "MSA-refined model would render here. Connect INFER_API for real predictions."; setStatus("done (demo)"); upsertJob({ id, state: "done" }); }, 3200);
  }

  // on load, re-check any job still marked running/submitted so a finished job
  // doesn't stay stuck showing "running" after a reload (the poll had stopped).
  async function refreshJobs() {
    if (!API) return;
    for (const j of loadJobs()) {
      if (String(j.id).startsWith("demo-") || !RUNNING.has(String(j.state || "").toLowerCase())) continue;
      try {
        const r = await (await fetch(`${API}/status?job=${encodeURIComponent(j.id)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json();
        const hasR = r.stages && Object.values(r.stages).some((s) => s && (s.cif || s.url));
        const st = (r.state === "done" || hasR) ? "done" : (r.state === "error" ? "error" : (r.state || j.state));
        if (st !== j.state) upsertJob({ id: j.id, state: st });
      } catch (e) {}
    }
  }
  // Recent-jobs list lives in localStorage (per browser), so clearing site data loses it.
  // The server still knows recent web executions (+ cached results) — merge them back so the
  // list self-heals. Server ids are 3-part (model:target:exec); /status re-opens them fine.
  async function syncServerJobs() {
    if (!API) return;
    let data;
    try { data = await (await fetch(`${API}/jobs${tok() ? "?t=" + encodeURIComponent(tok()) : ""}`)).json(); }
    catch (e) { return; }
    const server = (data && data.jobs) || [];
    if (!server.length) return;
    const local = loadJobs();
    // dedupe by target_id (parts[1]) so both live 3-part exec ids and 2-part stored ids merge
    // cleanly — the same job never shows twice, and completed jobs from other browsers appear.
    const haveTgt = new Set(local.map((x) => String(x.id).split(":")[1]).filter(Boolean));
    let added = 0;
    for (const s of server) {
      const tgt = String(s.job_id || "").split(":")[1];
      if (!tgt || haveTgt.has(tgt)) continue;   // already tracked locally (by target)
      local.push({ id: s.job_id, name: s.name, model: s.model, state: s.state, fromServer: true });
      haveTgt.add(tgt); added++;
    }
    if (added) { saveJobs(local); renderJobs(); }
  }
  function init() {
    renderEntities();
    $("add-entity").addEventListener("click", () => addEntity("rna"));
    $("example-btn").addEventListener("click", loadExample);
    $("predict-btn").addEventListener("click", predict);
    if (!API) $("predict-note").innerHTML = "Backend not connected yet — Predict runs a demo of the flow.";
    markViewerButtons();
    $("vtoggle").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setViewer(b.dataset.v)));
    if ($("ss-mode")) $("ss-mode").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setSSMode(b.dataset.m)));
    if ($("ss-dbn")) $("ss-dbn").addEventListener("click", exportDbn);
    if ($("ss-png")) $("ss-png").addEventListener("click", exportSSPng);
    ["opt_seeds", "opt_samples", "model"].forEach((id) => { const e = $(id); if (e) e.addEventListener("change", updateFleetHint); });
    if ($("opt_expert") && $("opt_description")) {
      $("opt_expert").addEventListener("change", () => { $("opt_description").hidden = !$("opt_expert").checked; });
    }
    if ($("openid-go")) $("openid-go").addEventListener("click", openFromSearch);
    if ($("openid")) {
      $("openid").addEventListener("input", () => { jobFilter = $("openid").value.trim().toLowerCase(); renderJobs(); });
      $("openid").addEventListener("keydown", (e) => { if (e.key === "Enter") openFromSearch(); });
    }
    loadModels().then(updateFleetHint); renderJobs(); refreshJobs(); syncServerJobs(); renderModelPanel();
    updateFleetHint();
  }
  if (GATED && !tok()) showGate(); else (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init());
})();
