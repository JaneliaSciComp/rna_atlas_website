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
  const STAGES_MSA = [["queued", "Queued"], ["msa", "MSA build"], ["refined", "Predict & refine"]];
  const STAGES_NOMSA = [["queued", "Queued"], ["nomsa", "Predicting"], ["refined", "Done"]];
  let curMsa = false;                          // whether the current job uses MSA (drives the timeline)
  let results = { nomsa: null, msa: null };   // CIF text per stage
  let shown = null, dmol = null, mstar = null, activeV = null, lastText = null, molstarLoading = null, curJobId = null;
  let vmode = (() => { try { return localStorage.getItem("infer_viewer") || "molstar"; } catch (e) { return "molstar"; } })();

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

  // ---------- jobs (monitor + cancel) ----------
  const JOBS_KEY = "infer_jobs";
  const RUNNING = new Set(["queued", "running", "submitted", "pending"]);
  function loadJobs() { try { return JSON.parse(localStorage.getItem(JOBS_KEY) || "[]"); } catch (e) { return []; } }
  function saveJobs(j) { try { localStorage.setItem(JOBS_KEY, JSON.stringify(j.slice(0, 20))); } catch (e) {} }
  function upsertJob(job) {
    const j = loadJobs(); const i = j.findIndex((x) => x.id === job.id);
    if (i >= 0) j[i] = { ...j[i], ...job }; else j.unshift(job);
    saveJobs(j); renderJobs();
  }
  function renderJobs() {
    const el = $("jobs"); if (!el) return;
    const j = loadJobs();
    if (!j.length) { el.innerHTML = ""; return; }
    el.innerHTML = '<div class="jobs-h">Recent jobs</div>' + j.map((x) => {
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
    results = { nomsa: null, msa: null }; shown = null; $("ibadges").innerHTML = "";
    setStatus("opening job " + String(id).slice(0, 16) + "…"); poll(id);
  }

  // ---------- gate ----------
  function showGate(msg) {
    const g = $("gate"); g.classList.remove("hidden"); $("gate-msg").textContent = msg || "";
    const inp = $("gate-input"); inp.value = ""; inp.focus();
    const go = () => { const v = inp.value.trim(); if (!v) return; localStorage.setItem("atlas_token", v); g.classList.add("hidden"); init(); };
    $("gate-go").onclick = go; inp.onkeydown = (e) => { if (e.key === "Enter") go(); };
  }

  // ---------- sequence ----------
  function cleanSeq(raw) {
    return raw.split("\n").filter((l) => !l.startsWith(">")).join("").replace(/\s/g, "").toUpperCase().replace(/T/g, "U");
  }
  function seqLen() { const s = cleanSeq($("seq").value); $("seqlen").textContent = s.length + " nt"; return s; }

  // ---------- stage timeline ----------
  function renderStages(state) {
    const list = curMsa ? STAGES_MSA : STAGES_NOMSA;
    $("stages").innerHTML = list.map(([k, lbl]) => {
      const st = state[k] || "wait";
      const cls = st === "done" ? "done" : st === "running" ? "run" : (st === "error" || st === "err") ? "err" : "wait";
      return `<div class="stage ${cls}"><i></i>${esc(lbl)}${st === "running" ? " …" : ""}</div>`;
    }).join("");
  }

  // ---------- 3D viewers: Mol* (default) or 3Dmol, user-selectable ----------
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
  }
  function markViewerButtons() {
    const t = $("vtoggle"); if (!t) return;
    t.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === vmode));
  }
  function setViewer(v) {
    if (v === vmode) return;
    vmode = v; try { localStorage.setItem("infer_viewer", v); } catch (e) {}
    markViewerButtons();
    if (lastText) showStructure(lastText);
  }
  function showStructure(text) {
    lastText = text;
    $("iplaceholder").style.display = "none"; $("iview").classList.add("show");
    if (vmode === "molstar") showMolstar(text); else showDmol(text);
  }
  function showDmol(text) {
    if (activeV !== "3dmol") resetContainer();
    activeV = "3dmol";
    if (typeof $3Dmol === "undefined") { setStatus("3Dmol not loaded"); return; }
    if (!dmol) dmol = $3Dmol.createViewer($("iviewer"), { backgroundColor: "0x0d1117" });
    dmol.removeAllModels();
    const fmt = text.startsWith("data_") || text.includes("_atom_site") ? "cif" : "pdb";
    dmol.addModel(text, fmt); dmol.setStyle({}, { cartoon: { color: "spectrum", ringMode: 3 } });
    dmol.zoomTo(); dmol.render(); dmol.resize();
  }
  async function showMolstar(text) {
    if (activeV !== "molstar") resetContainer();
    activeV = "molstar";
    try { await loadMolstarLib(); }
    catch (e) { vmode = "3dmol"; markViewerButtons(); return showDmol(text); }
    try {
      if (!mstar) mstar = await molstar.Viewer.create($("iviewer"), {
        layoutIsExpanded: false, layoutShowControls: true, layoutShowSequence: true,
        layoutShowLog: false, viewportShowExpand: true, viewportShowSelectionMode: false,
      });
      await mstar.loadStructureFromData(text, "pdb");
    } catch (e) { setStatus("Mol* render failed: " + e.message); }
  }
  function renderBadges() {
    const order = [["msa", "MSA-refined"], ["nomsa", "Draft (no MSA)"]];
    $("ibadges").innerHTML = order.filter(([k]) => results[k]).map(([k, lbl]) =>
      `<button class="rbadge ${shown === k ? "active" : ""}" data-k="${k}">${lbl}</button>`).join("")
      + (Object.values(results).some(Boolean) ? `<button class="rbadge dl" id="rdl">&#10515; export zip</button>` : "");
    $("ibadges").querySelectorAll(".rbadge[data-k]").forEach((b) => b.onclick = () => view(b.dataset.k));
    if ($("rdl")) $("rdl").onclick = exportZip;
  }
  function view(k) { if (!results[k]) return; shown = k; showStructure(results[k]); renderBadges(); }
  function gotResult(k, text) { results[k] = text; if (k === "msa" || !results.msa) view(k); else renderBadges(); }

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
      "length: " + ((jb.seq || "").length || "") + " nt",
    ];
    if (jb.seq) meta.push("sequence:\n" + jb.seq);
    const files = [
      { name: base + ".txt", data: _enc(meta.join("\n") + "\n") },
      { name: base + ".pdb", data: _enc(lastText) },
      { name: base + ".cif", data: _enc(pdbToCif(lastText, base)) },
    ];
    const png = viewerPNG(); if (png) files.push({ name: base + ".png", data: png });
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

  // ---------- backend adapter ----------
  async function fetchCif(s) { if (s.url) return (await fetch(s.url.includes("?") ? s.url : s.url + (tok() ? "?t=" + encodeURIComponent(tok()) : ""))).text(); return s.cif || ""; }
  function mapStatus(j) {       // normalize backend status -> {state, stages:{queued,nomsa,msa,refined}, results}
    const st = j.stages || {}, nm = st.nomsa || {}, ms = st.msa || {};
    const hasR = nm.url || nm.cif || ms.url || ms.cif;
    const done = j.state === "done" || hasR;
    const err = j.state === "error";
    const mid = done ? "done" : (err ? "err" : "running");
    return {
      state: j.state || "running", error: j.error,
      flags: { queued: "done", msa: mid, nomsa: mid, refined: done ? "done" : (err ? "err" : "wait") },
      nomsa: nm, msa: ms,
    };
  }
  async function poll(jobId) {
    curJobId = jobId;
    for (let i = 0; i < 600; i++) {
      if (String((loadJobs().find((x) => x.id === jobId) || {}).state).toLowerCase() === "cancelled") { setStatus("cancelled"); return; }
      let j; try { j = await (await fetch(`${API}/status?job=${encodeURIComponent(jobId)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json(); }
      catch (e) { setStatus("status check failed: " + e.message); return; }
      const m = mapStatus(j);
      upsertJob({ id: jobId, state: m.state });
      renderStages(m.flags);
      if (m.nomsa && (m.nomsa.url || m.nomsa.cif) && !results.nomsa) gotResult("nomsa", await fetchCif(m.nomsa));
      if (m.msa && (m.msa.url || m.msa.cif) && !results.msa) gotResult("msa", await fetchCif(m.msa));
      if (m.state === "error") { setStatus("⚠ " + (m.error || "prediction failed")); notifyDone(jobId, false, m.error); return; }
      if (m.state === "done" || (results.nomsa && results.msa)) { setStatus("done"); notifyDone(jobId, true); return; }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  function setStatus(t) { $("infer-status").textContent = t; }
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
    const seq = seqLen();
    if (seq.length < 5) { $("predict-note").textContent = "Enter a sequence of at least 5 nt."; return; }
    if (/[^ACGUN]/.test(seq)) { $("predict-note").textContent = "Sequence has non-RNA characters (allowed: A C G U N)."; return; }
    results = { nomsa: null, msa: null }; shown = null; $("ibadges").innerHTML = ""; $("predict-note").textContent = "";
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
    const mode = $("msa_mode").value || "protenix-mt";
    const opts = { mode };
    curMsa = mode !== "none";
    const model = curModel(), jobName = $("jobname").value.trim();
    renderStages({ queued: "running" }); setStatus("submitting…");
    if (!API) { return demo(model, jobName); }
    let jobId, j0;
    try {
      const r = await fetch(`${API}/predict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: seq, name: jobName, model, options: opts, token: tok() }) });
      if (!r.ok) throw new Error("HTTP " + r.status); j0 = await r.json(); jobId = j0.job_id;
    } catch (e) { setStatus("submit failed: " + e.message); $("predict-note").textContent = "Could not reach the inference backend."; return; }
    upsertJob({ id: jobId, name: jobName || jobId.slice(0, 10), model, mode, seq, state: (j0.status || "submitted").toLowerCase(), ts: Date.now() });
    if (String(j0.status).toUpperCase() === "CACHED") { $("predict-note").innerHTML = "<b>Cached</b> — this sequence + model was already predicted; showing the stored result."; }
    setStatus("running — job " + jobId); poll(jobId);
  }

  // demo flow (no backend configured): walk the staged UI so the UX is visible
  function demo(model, jobName) {
    const id = "demo-" + Date.now().toString(36);
    curMsa = ($("msa_mode").value || "") !== "none";
    upsertJob({ id, name: jobName || "demo", model: model || "default", mode: $("msa_mode").value, state: "running", ts: Date.now() });
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
    const haveExec = new Set(local.map((x) => String(x.id).split(":")[2]).filter(Boolean));
    let added = 0;
    for (const s of server) {
      const exec = String(s.job_id || "").split(":")[2];
      if (!exec || haveExec.has(exec)) continue;   // already tracked locally
      local.push({ id: s.job_id, name: s.name, model: s.model, state: s.state, fromServer: true });
      haveExec.add(exec); added++;
    }
    if (added) { saveJobs(local); renderJobs(); }
  }
  function init() {
    $("seq").addEventListener("input", seqLen);
    $("example-btn").addEventListener("click", () => { $("seq").value = EXAMPLE; seqLen(); });
    $("predict-btn").addEventListener("click", predict);
    if (!API) $("predict-note").innerHTML = "Backend not connected yet — Predict runs a demo of the flow.";
    markViewerButtons();
    $("vtoggle").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setViewer(b.dataset.v)));
    loadModels(); renderJobs(); refreshJobs(); syncServerJobs();
    seqLen();
  }
  if (GATED && !tok()) showGate(); else (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init());
})();
