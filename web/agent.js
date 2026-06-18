// Atlas assistant — an in-page Claude agent that drives the explorer (filters, search,
// fold selection, map view) and does analysis (data + stats + charts) via window.AtlasAPI.
// Token: localStorage "atlas_claude_key" (user-supplied) else window.CLAUDE_KEY (shared,
// injected into the gated config). Calls the Anthropic Messages API directly from the browser.
(function () {
  const API = "https://api.anthropic.com/v1/messages";
  function model() { const s = $("agent-model"); return (s && s.value) || localStorage.getItem("atlas_model") || window.CLAUDE_MODEL || "claude-sonnet-4-6"; }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let messages = [];

  function key() { return localStorage.getItem("atlas_claude_key") || window.CLAUDE_KEY || ""; }

  const SYSTEM = `You are the assistant embedded in the RNA Atlas Explorer, a web tool over a predicted RNA structure atlas (Ribonanza-2 curated A–H plus Ribo-1 pseudolabel / OpenKnot / RFAM-PDB). Each row is an RNA "fold" with fields like: id, name, letter (library A–H), length, plddt, best_tm1 (novelty vs PDB; lower=more novel), is_novel_v341, near (nearest PDB), rna_type, rfam_id/rfam_name, fold_size & global_fold_id (structural cluster + member count), seq_cluster_size & global_seq_cluster_id, contact_ratio (compactness), bp_fraction, pseudoknot, n_tert/n_rare (tertiary motifs), motifs, shape_ok/shape_agr, ex/ey (2D t-SNE embedding coords).

You can DO anything the user can: change filters, search, switch to the Map (scatter of the embedding), select/open a fold. And you can analyze: pull the current results, compute field stats, and draw charts.

CRITICAL: actually CALL the tools — never just say "let me…" or "now I'll draw…" and end your turn. Every action you describe must be an actual tool call in the SAME turn; only stop once the work is truly done. To chart, the simplest and most reliable way is to give draw_chart FIELD references and let the app build the data: scatter/line need x_field and y_field; histogram/bar need field. You usually do NOT need get_results first just to chart. Use over:'results' (current view) unless asked otherwise. Keep replies short. Filters are AND-combined over the active data sources.`;

  const TOOLS = [
    { name: "get_state", description: "Current view, # shown, active data sources, available columns, motif types, libraries.", input_schema: { type: "object", properties: {} } },
    { name: "set_filters", description: "Set one or more filters (then re-renders). Keys: length_min,length_max,plddt_min,clash_max,novelty_max (best_tm1<=),overlap_max,shape_agr_min,compactness_min,paired_min,fold_size_min,seq_cluster_min,top_n,rank (e.g. 'best_tm1:asc','fold_size:desc','plddt:desc','length:desc'),novel_only(bool),shape_only(bool),require_tertiary(bool),require_rare(bool),per_letter(bool),pseudoknot('any'|'1'|'0'),search(str),motifs(string[]),letters(string[] of A–H). Returns # shown.", input_schema: { type: "object", properties: { filters: { type: "object" } }, required: ["filters"] } },
    { name: "reset_filters", description: "Clear all filters back to defaults.", input_schema: { type: "object", properties: {} } },
    { name: "set_view", description: "Switch view to 'table' or 'map' (the embedding scatter). Optional color_by for the map: best_tm1, plddt, fold_size, bp_fraction, contact_ratio, rna_type, letter.", input_schema: { type: "object", properties: { mode: { type: "string", enum: ["table", "map"] }, color_by: { type: "string" } }, required: ["mode"] } },
    { name: "select_fold", description: "Open the deep view (3D + tracks + metadata) for a fold by its id.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "get_results", description: "Return the current filtered+sorted folds (after top-N). Use to read/analyze data, incl. ex/ey embedding coords.", input_schema: { type: "object", properties: { limit: { type: "integer" }, fields: { type: "array", items: { type: "string" } } } } },
    { name: "get_field_stats", description: "Summary stats + histogram (numeric) or value counts (categorical) for a field, over 'results' (current) or 'all' folds in the active sources.", input_schema: { type: "object", properties: { field: { type: "string" }, over: { type: "string", enum: ["results", "all"] } }, required: ["field"] } },
    { name: "draw_chart", description: "Render a chart in the chat. PREFERRED: give field references and the app builds the data — histogram/bar: field (a fold field); scatter/line: x_field and y_field (fold fields, e.g. length, n_tert, n_rare, best_tm1, plddt, fold_size, bp_fraction, contact_ratio, seq_cluster_size, ex, ey). over='results' (current view, default) or 'all'. Alternatively pass explicit data: [{label,value}] for histogram/bar or [{x,y,label?}] for scatter/line.", input_schema: { type: "object", properties: { chart_type: { type: "string", enum: ["histogram", "bar", "scatter", "line"] }, title: { type: "string" }, field: { type: "string" }, x_field: { type: "string" }, y_field: { type: "string" }, over: { type: "string", enum: ["results", "all"] }, x_label: { type: "string" }, y_label: { type: "string" }, data: { type: "array", items: { type: "object" } } }, required: ["chart_type"] } },
  ];

  function tool(name, inp) {
    const A = window.AtlasAPI;
    try {
      if (name === "get_state") return A.getState();
      if (name === "set_filters") return { shown: A.applyFilters(inp.filters || {}) };
      if (name === "reset_filters") return { shown: A.resetFilters() };
      if (name === "set_view") { A.setView(inp.mode); if (inp.color_by) A.setColorBy(inp.color_by); return { ok: true, view: inp.mode }; }
      if (name === "select_fold") return { ok: A.selectFold(inp.id) };
      if (name === "get_results") return { results: A.getResults(inp.limit || 50, inp.fields) };
      if (name === "get_field_stats") return A.fieldStats(inp.field, inp.over || "results");
      if (name === "draw_chart") { return { ok: true, points: drawChart(inp) }; }
      return { error: "unknown tool " + name };
    } catch (e) { return { error: String(e && e.message || e) }; }
  }

  function drawChart(spec) {
    const A = window.AtlasAPI, type = spec.chart_type, over = spec.over || "results";
    let data = spec.data;
    if (!data || !data.length) {                     // build from field references
      if ((type === "histogram" || type === "bar") && spec.field) {
        const st = A.fieldStats(spec.field, over);
        data = st.counts ? Object.entries(st.counts).map(([l, v]) => ({ label: l, value: v }))
          : (st.histogram || []).map((h) => ({ label: h.x0, value: h.count }));
        spec.title = spec.title || spec.field;
      } else if ((type === "scatter" || type === "line") && spec.x_field && spec.y_field) {
        data = A.getResults(5000, [spec.x_field, spec.y_field, "id"])
          .map((f) => ({ x: f[spec.x_field], y: f[spec.y_field], label: f.id }))
          .filter((d) => typeof d.x === "number" && typeof d.y === "number");
        spec.x_label = spec.x_label || spec.x_field; spec.y_label = spec.y_label || spec.y_field;
      }
    }
    data = data || [];
    if (!data.length) { bubble("bot err", "⚠ nothing to chart (no data / unknown field)"); return 0; }
    const W = 380, H = 220, pad = 36, cv = document.createElement("canvas");
    cv.width = W * 2; cv.height = H * 2; cv.style.width = W + "px"; cv.style.height = H + "px"; cv.className = "agent-chart";
    const ctx = cv.getContext("2d"); ctx.scale(2, 2); ctx.font = "10px sans-serif"; ctx.fillStyle = "#15242c";
    if (spec.title) ctx.fillText(spec.title, pad, 12);
    const x0 = pad, y0 = H - pad, x1 = W - 10, y1 = 22;
    ctx.strokeStyle = "#cdd6dd"; ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
    const type = spec.chart_type;
    if (type === "bar" || type === "histogram") {
      const vals = data.map((d) => +d.value || 0), mx = Math.max(...vals, 1), n = data.length, bw = (x1 - x0) / n;
      data.forEach((d, i) => { const h = (d.value / mx) * (y0 - y1); ctx.fillStyle = "#2e6f95";
        ctx.fillRect(x0 + i * bw + 1, y0 - h, Math.max(1, bw - 2), h);
        if (n <= 16) { ctx.save(); ctx.translate(x0 + i * bw + bw / 2, y0 + 3); ctx.rotate(-Math.PI / 4); ctx.fillStyle = "#647179"; ctx.fillText(String(d.label).slice(0, 10), -20, 0); ctx.restore(); } });
    } else {
      const xs = data.map((d) => +d.x), ys = data.map((d) => +d.y);
      const xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
      const sx = (v) => x0 + (xhi > xlo ? (v - xlo) / (xhi - xlo) : .5) * (x1 - x0);
      const sy = (v) => y0 - (yhi > ylo ? (v - ylo) / (yhi - ylo) : .5) * (y0 - y1);
      if (type === "line") { ctx.strokeStyle = "#2e6f95"; ctx.beginPath(); data.forEach((d, i) => { const X = sx(+d.x), Y = sy(+d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke(); }
      else { ctx.fillStyle = "rgba(46,111,149,.6)"; data.forEach((d) => { ctx.beginPath(); ctx.arc(sx(+d.x), sy(+d.y), 2.5, 0, 6.3); ctx.fill(); }); }
      ctx.fillStyle = "#647179"; ctx.fillText((spec.x_label || "x") + "", x1 - 30, y0 + 14); ctx.save(); ctx.translate(10, y1 + 20); ctx.rotate(-Math.PI / 2); ctx.fillText((spec.y_label || "y") + "", 0, 0); ctx.restore();
    }
    const b = document.createElement("div"); b.className = "msg bot"; b.appendChild(cv); $("agent-log").appendChild(b); scroll();
    return data.length;
  }

  function bubble(role, html) { const d = document.createElement("div"); d.className = "msg " + role; d.innerHTML = html; $("agent-log").appendChild(d); scroll(); return d; }
  function scroll() { const l = $("agent-log"); l.scrollTop = l.scrollHeight; }
  function inlineMd(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>"); }
  function splitRow(line) { let s = line.trim(); if (s.startsWith("|")) s = s.slice(1); if (s.endsWith("|")) s = s.slice(0, -1); return s.split("|").map((c) => c.trim()); }
  function md(t) {
    const lines = String(t == null ? "" : t).split("\n");
    const html = []; let buf = [];
    const flush = () => { if (buf.length) { html.push("<div>" + buf.map(inlineMd).join("<br>") + "</div>"); buf = []; } };
    let i = 0;
    while (i < lines.length) {
      const isTbl = lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && /^[\s|:-]+$/.test(lines[i + 1].trim());
      if (isTbl) {
        flush();
        const head = splitRow(lines[i]); i += 2; const body = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { body.push(splitRow(lines[i])); i++; }
        html.push("<table class='agent-tbl'><thead><tr>" + head.map((h) => "<th>" + inlineMd(h) + "</th>").join("") + "</tr></thead><tbody>"
          + body.map((r) => "<tr>" + r.map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>");
      } else { buf.push(lines[i]); i++; }
    }
    flush();
    return html.join("");
  }

  async function callAPI() {
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: model(), max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages }),
    });
    if (!r.ok) throw new Error("API " + r.status + ": " + (await r.text()).slice(0, 300));
    return r.json();
  }

  function describe(name, inp) {
    inp = inp || {};
    if (name === "set_filters") { const e = Object.entries(inp.filters || {}); const s = e.slice(0, 4).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`).join(", "); return "Filtering" + (s ? ` — ${s}${e.length > 4 ? " …" : ""}` : ""); }
    if (name === "reset_filters") return "Resetting filters";
    if (name === "search") return `Searching "${inp.query || ""}"`;
    if (name === "set_view") return `Switching to ${inp.mode} view` + (inp.color_by ? ` · color by ${inp.color_by}` : "");
    if (name === "select_fold") return `Opening ${inp.id}`;
    if (name === "get_results") return `Reading ${inp.limit || 50} results`;
    if (name === "get_field_stats") return `Computing ${inp.field} stats over ${inp.over || "results"}`;
    if (name === "get_state") return "Checking current state";
    if (name === "draw_chart") return `Drawing ${inp.chart_type || ""} chart` + (inp.title ? ` — ${inp.title}` : "");
    return name;
  }
  async function run(userText) {
    messages.push({ role: "user", content: userText });
    bubble("user", md(userText));
    const status = bubble("bot thinking", "Thinking…");
    const setStatus = (t) => { status.textContent = t + "…"; $("agent-log").appendChild(status); scroll(); };
    try {
      for (let i = 0; i < 10; i++) {
        setStatus("Claude is thinking");
        const resp = await callAPI();
        messages.push({ role: "assistant", content: resp.content });
        for (const b of resp.content) if (b.type === "text" && b.text.trim()) bubble("bot", md(b.text));
        const calls = resp.content.filter((b) => b.type === "tool_use");
        if (!calls.length || resp.stop_reason !== "tool_use") break;
        setStatus(calls.map((c) => describe(c.name, c.input)).join(" · "));
        const results = calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(tool(c.name, c.input || {})) }));
        messages.push({ role: "user", content: results });
      }
    } catch (e) { bubble("bot err", "⚠ " + esc(e.message)); }
    status.remove();
  }

  const EXAMPLES = [
    "Switch to the map and color by RNA type",
    "Filter to novel FMN riboswitches and open the best one",
    "Plot a histogram of fold sizes for what's shown",
    "Show the 10 most novel folds",
  ];
  function showWelcome() {
    const d = document.createElement("div"); d.className = "msg bot welcome";
    d.innerHTML = "<b>Atlas assistant</b><br>I can drive the explorer for you — change filters, search, "
      + "switch to the embedding <b>map</b>, open a fold's 3D deep view — and analyze the data with stats &amp; charts. "
      + "Pick an example or type your own:<div class=\"ex\">"
      + EXAMPLES.map((e) => `<button class="ex-chip">${esc(e)}</button>`).join("") + "</div>";
    $("agent-log").appendChild(d);
    d.querySelectorAll(".ex-chip").forEach((b, i) => b.addEventListener("click", () => {
      if (!ensureKey()) { bubble("bot err", "No API key set."); return; } run(EXAMPLES[i]);
    }));
    scroll();
  }
  function ensureKey() {
    if (key()) return true;
    const k = prompt("Anthropic API key for the Atlas assistant (stored only in this browser):");
    if (k) { localStorage.setItem("atlas_claude_key", k.trim()); return true; }
    return false;
  }

  function init() {
    if (!$("agent-btn")) return;
    $("agent-btn").addEventListener("click", () => { $("agent").classList.toggle("hidden"); if (!$("agent").classList.contains("hidden")) $("agent-input").focus(); });
    $("agent-close").addEventListener("click", () => $("agent").classList.add("hidden"));
    const ms = $("agent-model"); if (ms) { const saved = localStorage.getItem("atlas_model"); if (saved) ms.value = saved; ms.addEventListener("change", () => localStorage.setItem("atlas_model", ms.value)); }
    $("agent-clear").addEventListener("click", () => { messages = []; $("agent-log").innerHTML = ""; showWelcome(); });
    const send = () => { const t = $("agent-input").value.trim(); if (!t) return; if (!ensureKey()) { bubble("bot err", "No API key set."); return; } $("agent-input").value = ""; run(t); };
    $("agent-send").addEventListener("click", send);
    $("agent-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    showWelcome();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
