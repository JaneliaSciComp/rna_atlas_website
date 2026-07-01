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
  const STAGES = [["queued", "Queued"], ["nomsa", "Draft (no MSA)"], ["msa", "MSA build"], ["refined", "MSA-refined"]];
  let results = { nomsa: null, msa: null };   // CIF text per stage
  let viewer = null, shown = null;

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
      return `<div class="job"><span class="jn" title="${esc(x.id)}">${esc(x.name || x.id.slice(0, 10))}</span>`
        + `<span class="jm">${esc(x.model || "default")}</span>`
        + `<span class="js js-${esc(String(x.state || "").toLowerCase())}">${esc(x.state || "")}</span>`
        + (run ? `<button class="jkill" data-id="${esc(x.id)}" title="stop this job">kill</button>` : "")
        + `</div>`;
    }).join("");
    el.querySelectorAll(".jkill").forEach((b) => b.onclick = () => cancelJob(b.dataset.id));
  }
  async function cancelJob(id) {
    if (API) { try { await fetch(`${API}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: id, token: tok() }) }); } catch (e) {} }
    upsertJob({ id, state: "cancelled" });
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
    $("stages").innerHTML = STAGES.map(([k, lbl]) => {
      const st = state[k] || "";
      const cls = st === "done" ? "done" : st === "running" ? "run" : st === "error" ? "err" : "wait";
      return `<div class="stage ${cls}"><i></i>${esc(lbl)}${st === "running" ? " …" : ""}</div>`;
    }).join("");
  }

  // ---------- 3D ----------
  function ensureViewer() {
    if (!viewer && typeof $3Dmol !== "undefined") viewer = $3Dmol.createViewer($("iviewer"), { backgroundColor: "0x0d1117" });
    return viewer;
  }
  function showStructure(text) {
    const v = ensureViewer(); if (!v) return;
    v.removeAllModels();
    const fmt = text.startsWith("data_") || text.includes("_atom_site") ? "cif" : "pdb";
    v.addModel(text, fmt); v.setStyle({}, { cartoon: { color: "spectrum", ringMode: 3 } });
    v.zoomTo(); v.render(); $("iplaceholder").style.display = "none"; $("iview").style.display = "block";
  }
  function renderBadges() {
    const order = [["msa", "MSA-refined"], ["nomsa", "Draft (no MSA)"]];
    $("ibadges").innerHTML = order.filter(([k]) => results[k]).map(([k, lbl]) =>
      `<button class="rbadge ${shown === k ? "active" : ""}" data-k="${k}">${lbl}</button>`).join("")
      + (Object.values(results).some(Boolean) ? `<button class="rbadge dl" id="rdl">&#10515; download</button>` : "");
    $("ibadges").querySelectorAll(".rbadge[data-k]").forEach((b) => b.onclick = () => view(b.dataset.k));
    if ($("rdl")) $("rdl").onclick = () => { const t = results[shown]; if (t) downloadText(t, ($("jobname").value.trim() || "prediction") + "_" + shown + ".cif"); };
  }
  function view(k) { if (!results[k]) return; shown = k; showStructure(results[k]); renderBadges(); }
  function gotResult(k, text) { results[k] = text; if (k === "msa" || !results.msa) view(k); else renderBadges(); }
  function downloadText(t, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([t], { type: "text/plain" })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

  // ---------- backend adapter ----------
  async function fetchCif(s) { if (s.url) return (await fetch(s.url.includes("?") ? s.url : s.url + (tok() ? "?t=" + encodeURIComponent(tok()) : ""))).text(); return s.cif || ""; }
  function mapStatus(j) {       // normalize backend status -> {state, stages:{queued,nomsa,msa,refined}, results}
    const st = j.stages || {}, nm = st.nomsa || {}, ms = st.msa || {};
    return {
      state: j.state || "running", error: j.error,
      flags: { queued: j.state === "queued" ? "running" : "done", nomsa: nm.status || (nm.url || nm.cif ? "done" : "wait"),
               msa: ms.status === "done" || ms.url || ms.cif ? "done" : (ms.status || "running"),
               refined: ms.url || ms.cif ? "done" : "wait" },
      nomsa: nm, msa: ms,
    };
  }
  async function poll(jobId) {
    for (let i = 0; i < 600; i++) {
      if (String((loadJobs().find((x) => x.id === jobId) || {}).state).toLowerCase() === "cancelled") { setStatus("cancelled"); return; }
      let j; try { j = await (await fetch(`${API}/status?job=${encodeURIComponent(jobId)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json(); }
      catch (e) { setStatus("status check failed: " + e.message); return; }
      const m = mapStatus(j);
      upsertJob({ id: jobId, state: m.state });
      renderStages(m.flags);
      if (m.nomsa && (m.nomsa.url || m.nomsa.cif) && !results.nomsa) gotResult("nomsa", await fetchCif(m.nomsa));
      if (m.msa && (m.msa.url || m.msa.cif) && !results.msa) gotResult("msa", await fetchCif(m.msa));
      if (m.state === "error") { setStatus("⚠ " + (m.error || "prediction failed")); return; }
      if (m.state === "done" || (results.nomsa && results.msa)) { setStatus("done"); return; }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  function setStatus(t) { $("infer-status").textContent = t; }

  async function predict() {
    const seq = seqLen();
    if (seq.length < 5) { $("predict-note").textContent = "Enter a sequence of at least 5 nt."; return; }
    if (/[^ACGUN]/.test(seq)) { $("predict-note").textContent = "Sequence has non-RNA characters (allowed: A C G U N)."; return; }
    results = { nomsa: null, msa: null }; shown = null; $("ibadges").innerHTML = ""; $("predict-note").textContent = "";
    const opts = { msa: $("opt_msa").checked, chemmap: $("opt_chemmap").checked };
    const model = curModel(), jobName = $("jobname").value.trim();
    renderStages({ queued: "running" }); setStatus("submitting…");
    if (!API) { return demo(model, jobName); }
    let jobId, j0;
    try {
      const r = await fetch(`${API}/predict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: seq, name: jobName, model, options: opts, token: tok() }) });
      if (!r.ok) throw new Error("HTTP " + r.status); j0 = await r.json(); jobId = j0.job_id;
    } catch (e) { setStatus("submit failed: " + e.message); $("predict-note").textContent = "Could not reach the inference backend."; return; }
    upsertJob({ id: jobId, name: jobName || jobId.slice(0, 10), model, state: (j0.status || "submitted").toLowerCase(), ts: Date.now() });
    if (String(j0.status).toUpperCase() === "CACHED") { $("predict-note").innerHTML = "<b>Cached</b> — this sequence + model was already predicted; showing the stored result."; }
    setStatus("running — job " + jobId); poll(jobId);
  }

  // demo flow (no backend configured): walk the staged UI so the UX is visible
  function demo(model, jobName) {
    const id = "demo-" + Date.now().toString(36);
    upsertJob({ id, name: jobName || "demo", model: model || "default", state: "running", ts: Date.now() });
    $("predict-note").innerHTML = "<b>Demo mode</b> — inference backend not connected yet. Showing the staged flow (incl. model choice, monitoring &amp; kill); real predictions appear once <code>INFER_API</code> is wired to the AWS pipeline.";
    renderStages({ queued: "done", nomsa: "running" });
    setStatus("running (demo)…");
    setTimeout(() => { if (String((loadJobs().find((x) => x.id === id) || {}).state) === "cancelled") return; renderStages({ queued: "done", nomsa: "done", msa: "running" }); $("iplaceholder").textContent = "Draft (no-MSA) would render here…"; }, 1200);
    setTimeout(() => { if (String((loadJobs().find((x) => x.id === id) || {}).state) === "cancelled") return; renderStages({ queued: "done", nomsa: "done", msa: "done", refined: "done" }); $("iplaceholder").textContent = "MSA-refined model would render here. Connect INFER_API for real predictions."; setStatus("done (demo)"); upsertJob({ id, state: "done" }); }, 3200);
  }

  function init() {
    $("seq").addEventListener("input", seqLen);
    $("example-btn").addEventListener("click", () => { $("seq").value = EXAMPLE; seqLen(); });
    $("predict-btn").addEventListener("click", predict);
    if (!API) $("predict-note").innerHTML = "Backend not connected yet — Predict runs a demo of the flow.";
    loadModels(); renderJobs();
    seqLen();
  }
  if (GATED && !tok()) showGate(); else (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init());
})();
