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
      let j; try { j = await (await fetch(`${API}/status?job=${encodeURIComponent(jobId)}${tok() ? "&t=" + encodeURIComponent(tok()) : ""}`)).json(); }
      catch (e) { setStatus("status check failed: " + e.message); return; }
      const m = mapStatus(j);
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
    renderStages({ queued: "running" }); setStatus("submitting…");
    if (!API) { return demo(); }
    let jobId;
    try {
      const r = await fetch(`${API}/predict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: seq, name: $("jobname").value.trim(), options: opts, token: tok() }) });
      if (!r.ok) throw new Error("HTTP " + r.status); jobId = (await r.json()).job_id;
    } catch (e) { setStatus("submit failed: " + e.message); $("predict-note").textContent = "Could not reach the inference backend."; return; }
    setStatus("running — job " + jobId); poll(jobId);
  }

  // demo flow (no backend configured): walk the staged UI so the UX is visible
  function demo() {
    $("predict-note").innerHTML = "<b>Demo mode</b> — inference backend not connected yet. Showing the staged flow; real 3D appears once <code>INFER_API</code> is wired to the AWS pipeline.";
    renderStages({ queued: "done", nomsa: "running" });
    setStatus("running (demo)…");
    setTimeout(() => { renderStages({ queued: "done", nomsa: "done", msa: "running" }); $("iplaceholder").textContent = "Draft (no-MSA) would render here…"; }, 1200);
    setTimeout(() => { renderStages({ queued: "done", nomsa: "done", msa: "done", refined: "done" }); $("iplaceholder").textContent = "MSA-refined model would render here. Connect INFER_API for real predictions."; setStatus("done (demo)"); }, 3200);
  }

  function init() {
    $("seq").addEventListener("input", seqLen);
    $("example-btn").addEventListener("click", () => { $("seq").value = EXAMPLE; seqLen(); });
    $("predict-btn").addEventListener("click", predict);
    if (!API) $("predict-note").innerHTML = "Backend not connected yet — Predict runs a demo of the flow.";
    seqLen();
  }
  if (GATED && !tok()) showGate(); else (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init());
})();
