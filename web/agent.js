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

  const SYSTEM = `You are the assistant embedded in the RNA Atlas Explorer, a web tool over a predicted RNA structure atlas (Ribonanza-2 curated A–H plus Ribo-1 pseudolabel / OpenKnot / RFAM-PDB). Each row is an RNA "fold" with fields like: id, name, letter (library A–H), length, plddt, best_tm1 (novelty vs PDB; lower=more novel), is_novel_v341, near (nearest PDB), rna_type, rfam_id/rfam_name, fold_size & global_fold_id (structural cluster + member count), seq_cluster_size & global_seq_cluster_id, contact_ratio (compactness), bp_fraction, pseudoknot, n_tert/n_rare (tertiary motifs), motifs, shape_ok/shape_agr, ex/ey (2D t-SNE embedding coords), termini_bp (5′ & 3′ ends base-pair to each other, nt1↔ntN — useful for scaffolding), termini_trim (first-paired base pairs with last-paired, so single-stranded ends can be trimmed) with overhang5/overhang3 (trimmable end lengths), uucg_tetraloop (contains a UUCG tetraloop), conditioning (how the structure was conditioned at prediction time: 'msa'/'tbm'/'chemmap', or sequence-only if none).

You can DO anything the user can: change filters, search, switch to the Map (scatter of the embedding), select/open a fold. And you can analyze: pull the current results, compute field stats, and draw charts.

CRITICAL: actually CALL the tools — never just say "let me…" or "now I'll draw…" and end your turn. Every action you describe must be an actual tool call in the SAME turn; only stop once the work is truly done. To chart, the simplest and most reliable way is to give draw_chart FIELD references and let the app build the data: scatter/line need x_field and y_field; histogram/bar need field. You usually do NOT need get_results first just to chart. Use over:'results' (current view) unless asked otherwise. Keep replies short. Filters are AND-combined over the active data sources.`;

  const TOOLS = [
    { name: "get_state", description: "Current view, # shown, active data sources, available columns, motif types, libraries.", input_schema: { type: "object", properties: {} } },
    { name: "set_filters", description: "Set one or more filters (then re-renders). Keys: length_min,length_max,plddt_min,clash_max,novelty_max (best_tm1<=),overlap_max,shape_agr_min,compactness_min,paired_min,fold_size_min,seq_cluster_min,top_n,rank (e.g. 'best_tm1:asc','fold_size:desc','plddt:desc','length:desc'),novel_only(bool),shape_only(bool),require_tertiary(bool),require_rare(bool),per_letter(bool),pseudoknot('any'|'1'|'0'),termini('any'|'bp' (ends paired nt1↔ntN)|'trim' (ends paired with trimmable overhangs)),overhang_max(int nt; cap on trimmable overhang when termini='trim'),uucg(bool; UUCG tetraloop only),conditioning(string[] of 'msa'|'tbm'|'chemmap'|'none'; how the structure was conditioned at prediction time, 'none'=sequence-only),search(str),motifs(string[]),letters(string[] of A–H). Returns # shown.", input_schema: { type: "object", properties: { filters: { type: "object" } }, required: ["filters"] } },
    { name: "reset_filters", description: "Clear all filters back to defaults.", input_schema: { type: "object", properties: {} } },
    { name: "set_view", description: "Switch view to 'table' or 'map' (the embedding scatter). Optional color_by for the map: best_tm1, plddt, fold_size, bp_fraction, contact_ratio, rna_type, letter.", input_schema: { type: "object", properties: { mode: { type: "string", enum: ["table", "map"] }, color_by: { type: "string" } }, required: ["mode"] } },
    { name: "select_fold", description: "Open the deep view (3D + tracks + metadata) for a fold by its id.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "get_results", description: "Return the current filtered+sorted folds (after top-N). Use to read/analyze data, incl. ex/ey embedding coords.", input_schema: { type: "object", properties: { limit: { type: "integer" }, fields: { type: "array", items: { type: "string" } } } } },
    { name: "get_field_stats", description: "Summary stats + histogram (numeric) or value counts (categorical) for a field, over 'results' (current) or 'all' folds in the active sources.", input_schema: { type: "object", properties: { field: { type: "string" }, over: { type: "string", enum: ["results", "all"] } }, required: ["field"] } },
    { name: "draw_chart", description: "Render a 2D chart in the chat (expandable + downloadable as PNG). PREFERRED: give field references and the app builds the data — histogram/bar: field (a fold field); scatter/line: x_field and y_field (fold fields, e.g. length, n_tert, n_rare, best_tm1, plddt, fold_size, bp_fraction, contact_ratio, seq_cluster_size, ex, ey). over='results' (current view, default) or 'all'. Alternatively pass explicit data: [{label,value}] for histogram/bar or [{x,y,label?}] for scatter/line.", input_schema: { type: "object", properties: { chart_type: { type: "string", enum: ["histogram", "bar", "scatter", "line"] }, title: { type: "string" }, field: { type: "string" }, x_field: { type: "string" }, y_field: { type: "string" }, over: { type: "string", enum: ["results", "all"] }, x_label: { type: "string" }, y_label: { type: "string" }, data: { type: "array", items: { type: "object" } } }, required: ["chart_type"] } },
    { name: "interactive_plot", description: "Open an INTERACTIVE 3D scatter (three.js, drag-rotate/scroll-zoom) that the user can expand fullscreen and download as a standalone interactive HTML. Use when the user wants an interactive/3D plot. Give x_field, y_field, z_field (numeric fold fields) and optional color_field. over='results' (default) or 'all'.", input_schema: { type: "object", properties: { x_field: { type: "string" }, y_field: { type: "string" }, z_field: { type: "string" }, color_field: { type: "string" }, over: { type: "string", enum: ["results", "all"] }, title: { type: "string" } }, required: ["x_field", "y_field", "z_field"] } },
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
      if (name === "interactive_plot") { return { ok: true, points: interactivePlot(inp) }; }
      return { error: "unknown tool " + name };
    } catch (e) { return { error: String(e && e.message || e) }; }
  }

  function renderChart2D(cv, spec, data, W, H) {
    const pad = 42, dpr = 2;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.font = "11px sans-serif"; ctx.fillStyle = "#15242c";
    if (spec.title) ctx.fillText(spec.title, pad, 13);
    const x0 = pad, y0 = H - pad, x1 = W - 14, y1 = 24;
    ctx.strokeStyle = "#cdd6dd"; ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
    const type = spec.chart_type;
    if (type === "bar" || type === "histogram") {
      const mx = Math.max(...data.map((d) => +d.value || 0), 1), n = data.length, bw = (x1 - x0) / n;
      data.forEach((d, i) => { const h = ((+d.value || 0) / mx) * (y0 - y1); ctx.fillStyle = "#2e6f95";
        ctx.fillRect(x0 + i * bw + 1, y0 - h, Math.max(1, bw - 2), h);
        if (n <= 20) { ctx.save(); ctx.translate(x0 + i * bw + bw / 2, y0 + 3); ctx.rotate(-Math.PI / 4); ctx.fillStyle = "#647179"; ctx.fillText(String(d.label).slice(0, 14), -24, 0); ctx.restore(); } });
      ctx.fillStyle = "#9aa7b0"; ctx.fillText("0", x0 - 10, y0); ctx.fillText(String(mx), x0 - 18, y1 + 4);
    } else {
      const xs = data.map((d) => +d.x), ys = data.map((d) => +d.y);
      const xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
      const sx = (v) => x0 + (xhi > xlo ? (v - xlo) / (xhi - xlo) : .5) * (x1 - x0);
      const sy = (v) => y0 - (yhi > ylo ? (v - ylo) / (yhi - ylo) : .5) * (y0 - y1);
      if (type === "line") { ctx.strokeStyle = "#2e6f95"; ctx.beginPath(); data.forEach((d, i) => { i ? ctx.lineTo(sx(+d.x), sy(+d.y)) : ctx.moveTo(sx(+d.x), sy(+d.y)); }); ctx.stroke(); }
      else { ctx.fillStyle = "rgba(46,111,149,.55)"; data.forEach((d) => { ctx.beginPath(); ctx.arc(sx(+d.x), sy(+d.y), W > 600 ? 3 : 2.3, 0, 6.3); ctx.fill(); }); }
      ctx.fillStyle = "#647179"; ctx.fillText(spec.x_label || "x", (x0 + x1) / 2 - 10, y0 + 22);
      ctx.save(); ctx.translate(12, (y0 + y1) / 2 + 10); ctx.rotate(-Math.PI / 2); ctx.fillText(spec.y_label || "y", 0, 0); ctx.restore();
      ctx.fillStyle = "#9aa7b0"; ctx.fillText(xlo.toFixed(1), x0, y0 + 14); ctx.fillText(xhi.toFixed(1), x1 - 26, y0 + 14);
      ctx.fillText(yhi.toFixed(1), 16, y1 + 6); ctx.fillText(ylo.toFixed(1), 16, y0);
    }
  }
  function chartTools(spec, data) {
    const t = document.createElement("div"); t.className = "chart-tools";
    const ex = document.createElement("button"); ex.textContent = "⤢ expand"; ex.onclick = () => openChart2D(spec, data);
    const dl = document.createElement("button"); dl.textContent = "⤓ png"; dl.onclick = () => { const c = document.createElement("canvas"); renderChart2D(c, spec, data, 1000, 600); downloadURL(c.toDataURL("image/png"), (spec.title || "chart") + ".png"); };
    t.appendChild(ex); t.appendChild(dl); return t;
  }
  function drawChart(spec) {
    const A = window.AtlasAPI, type = spec.chart_type, over = spec.over || "results";
    let data = spec.data;
    if (!data || !data.length) {
      if ((type === "histogram" || type === "bar") && spec.field) {
        const st = A.fieldStats(spec.field, over);
        data = st.counts ? Object.entries(st.counts).map(([l, v]) => ({ label: l, value: v })) : (st.histogram || []).map((h) => ({ label: h.x0, value: h.count }));
        spec.title = spec.title || spec.field;
      } else if ((type === "scatter" || type === "line") && spec.x_field && spec.y_field) {
        data = A.getResults(5000, [spec.x_field, spec.y_field, "id"]).map((f) => ({ x: f[spec.x_field], y: f[spec.y_field], label: f.id })).filter((d) => typeof d.x === "number" && typeof d.y === "number");
        spec.x_label = spec.x_label || spec.x_field; spec.y_label = spec.y_label || spec.y_field;
      }
    }
    data = data || [];
    if (!data.length) { bubble("bot err", "⚠ nothing to chart (no data / unknown field)"); return 0; }
    const cv = document.createElement("canvas"); cv.className = "agent-chart"; renderChart2D(cv, spec, data, 360, 210);
    const b = document.createElement("div"); b.className = "msg bot"; b.appendChild(cv); b.appendChild(chartTools(spec, data)); $("agent-log").appendChild(b); scroll();
    return data.length;
  }
  function downloadURL(url, name) { const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function downloadText(text, name, mime) { downloadURL(URL.createObjectURL(new Blob([text], { type: mime || "text/plain" })), name); }
  function openModal(title) { $("cm-title").textContent = title || ""; $("cm-body").innerHTML = ""; $("chartmodal").classList.remove("hidden"); return $("cm-body"); }
  function openChart2D(spec, data) {
    const body = openModal(spec.title || "chart"); const cv = document.createElement("canvas"); body.appendChild(cv);
    renderChart2D(cv, spec, data, body.clientWidth - 8, body.clientHeight - 8);
    $("cm-dl").onclick = () => { const c = document.createElement("canvas"); renderChart2D(c, spec, data, 1400, 900); downloadURL(c.toDataURL("image/png"), (spec.title || "chart") + ".png"); };
  }

  // ---- interactive 3D scatter (three.js) ----
  let threeP = null;
  function ensureThree() {
    if (window.THREE && window.THREE.OrbitControls) return Promise.resolve();
    if (threeP) return threeP;
    threeP = new Promise((res, rej) => {
      const load = (src, cb) => { const s = document.createElement("script"); s.src = src; s.onload = cb; s.onerror = () => rej(new Error("load " + src)); document.head.appendChild(s); };
      load("lib/three.min.js", () => load("lib/OrbitControls.js", res));
    });
    return threeP;
  }
  function build3D(spec) {
    const A = window.AtlasAPI, xf = spec.x_field, yf = spec.y_field, zf = spec.z_field, cf = spec.color_field;
    return A.getResults(8000, [xf, yf, zf, cf, "id", "name"].filter(Boolean))
      .filter((f) => [xf, yf, zf].every((k) => typeof f[k] === "number"))
      .map((f) => ({ x: f[xf], y: f[yf], z: f[zf], c: cf ? f[cf] : null, id: f.id }));
  }
  function interactivePlot(spec) {
    const pts = build3D(spec);
    if (!pts.length) { bubble("bot err", "⚠ interactive 3D needs numeric x_field, y_field, z_field"); return 0; }
    const b = document.createElement("div"); b.className = "msg bot";
    b.innerHTML = `<b>Interactive 3D plot</b> — ${esc(spec.title || spec.x_field + " · " + spec.y_field + " · " + spec.z_field)} (${pts.length} pts) `;
    const op = document.createElement("button"); op.className = "open3d"; op.textContent = "⤢ open / download"; op.onclick = () => open3D(spec, pts); b.appendChild(op);
    $("agent-log").appendChild(b); scroll();
    open3D(spec, pts);
    return pts.length;
  }
  async function open3D(spec, pts) {
    const body = openModal(spec.title || "3D scatter"); body.innerHTML = "<div class='cm-loading'>loading 3D…</div>";
    $("cm-dl").onclick = () => downloadText(html3D(spec, pts), (spec.title || "plot").replace(/[^\w.-]+/g, "_") + ".html", "text/html");
    try { await ensureThree(); } catch (e) { body.innerHTML = "<div class='cm-loading'>3D library failed to load</div>"; return; }
    if ($("chartmodal").classList.contains("hidden")) return;
    body.innerHTML = "";
    const THREE = window.THREE, W = body.clientWidth, H = body.clientHeight;
    const r = new THREE.WebGLRenderer({ antialias: true }); r.setSize(W, H); r.setClearColor(0x0d1117); body.appendChild(r.domElement);
    const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(55, W / H, 0.1, 100); cam.position.set(1.7, 1.4, 1.9);
    const ct = new THREE.OrbitControls(cam, r.domElement); ct.enableDamping = true;
    const ax = ["x", "y", "z"].map((k) => { const v = pts.map((p) => p[k]); const lo = Math.min(...v), hi = Math.max(...v); return { lo, rng: hi > lo ? hi - lo : 1 }; });
    const cs = pts.map((p) => p.c), numeric = cs.some((v) => typeof v === "number");
    let lo, rng, pal = [0x2e6f95, 0xe8a317, 0x2e7d32, 0xd32f2f, 0x7b5ea7, 0x1f6fb2, 0xc1440e, 0x0d9aa6], map = {}, vi = 0;
    if (numeric) { const nn = cs.filter((v) => typeof v === "number"); lo = Math.min(...nn); const h = Math.max(...nn); rng = h > lo ? h - lo : 1; }
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(pts.length * 3), col = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => {
      pos[i * 3] = ((p.x - ax[0].lo) / ax[0].rng - .5) * 2; pos[i * 3 + 1] = ((p.y - ax[1].lo) / ax[1].rng - .5) * 2; pos[i * 3 + 2] = ((p.z - ax[2].lo) / ax[2].rng - .5) * 2;
      let hex; if (numeric && typeof p.c === "number") { const t = (p.c - lo) / rng; hex = (Math.round(33 + t * 178) << 16) | (Math.round(102 - t * 28) << 8) | Math.round(172 - t * 103); }
      else if (p.c != null) { if (!(p.c in map)) map[p.c] = pal[vi++ % pal.length]; hex = map[p.c]; } else hex = 0x888888;
      const c = new THREE.Color(hex); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    });
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    sc.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.035, vertexColors: true }))); sc.add(new THREE.AxesHelper(1.15));
    (function anim() { if ($("chartmodal").classList.contains("hidden")) return; requestAnimationFrame(anim); ct.update(); r.render(sc, cam); })();
  }
  function html3D(spec, pts) {
    return `<!doctype html><html><head><meta charset=utf-8><title>${esc(spec.title || "RNA Atlas 3D plot")}</title>
<style>body{margin:0;background:#0d1117;color:#cdd6dd;font:13px sans-serif}#i{position:fixed;top:8px;left:10px;pointer-events:none}</style></head><body>
<div id=i>${esc(spec.title || "")} &mdash; x=${esc(spec.x_field)} y=${esc(spec.y_field)} z=${esc(spec.z_field)}${spec.color_field ? " color=" + esc(spec.color_field) : ""} &middot; drag rotate, scroll zoom</div>
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"><\/script>
<script src="https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js"><\/script>
<script>
var PTS=${JSON.stringify(pts)};
var W=innerWidth,H=innerHeight,r=new THREE.WebGLRenderer({antialias:true});r.setSize(W,H);r.setClearColor(0x0d1117);document.body.appendChild(r.domElement);
var sc=new THREE.Scene(),cam=new THREE.PerspectiveCamera(55,W/H,0.1,100);cam.position.set(1.7,1.4,1.9);
var ct=new THREE.OrbitControls(cam,r.domElement);ct.enableDamping=true;
function ext(k){var v=PTS.map(function(p){return p[k]}),lo=Math.min.apply(0,v),hi=Math.max.apply(0,v);return{lo:lo,rng:hi>lo?hi-lo:1}}
var ax={x:ext('x'),y:ext('y'),z:ext('z')},cs=PTS.map(function(p){return p.c}),num=cs.some(function(v){return typeof v==='number'}),lo,rng,pal=[0x2e6f95,0xe8a317,0x2e7d32,0xd32f2f,0x7b5ea7,0x1f6fb2,0xc1440e,0x0d9aa6],m={},vi=0;
if(num){var nn=cs.filter(function(v){return typeof v==='number'});lo=Math.min.apply(0,nn);var h2=Math.max.apply(0,nn);rng=h2>lo?h2-lo:1}
var g=new THREE.BufferGeometry(),pos=new Float32Array(PTS.length*3),col=new Float32Array(PTS.length*3);
PTS.forEach(function(p,i){pos[i*3]=((p.x-ax.x.lo)/ax.x.rng-.5)*2;pos[i*3+1]=((p.y-ax.y.lo)/ax.y.rng-.5)*2;pos[i*3+2]=((p.z-ax.z.lo)/ax.z.rng-.5)*2;var hex;if(num&&typeof p.c==='number'){var t=(p.c-lo)/rng;hex=(Math.round(33+t*178)<<16)|(Math.round(102-t*28)<<8)|Math.round(172-t*103)}else if(p.c!=null){if(!(p.c in m))m[p.c]=pal[vi++%pal.length];hex=m[p.c]}else hex=0x888888;var c=new THREE.Color(hex);col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b});
g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('color',new THREE.BufferAttribute(col,3));
sc.add(new THREE.Points(g,new THREE.PointsMaterial({size:0.035,vertexColors:true})));sc.add(new THREE.AxesHelper(1.15));
addEventListener('resize',function(){W=innerWidth;H=innerHeight;cam.aspect=W/H;cam.updateProjectionMatrix();r.setSize(W,H)});
(function a(){requestAnimationFrame(a);ct.update();r.render(sc,cam)})();
<\/script></body></html>`;
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
    if (name === "interactive_plot") return `Building 3D plot — ${inp.x_field} · ${inp.y_field} · ${inp.z_field}`;
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
    saveConv();
  }

  // client-side cache of the conversation
  const CONV_KEY = "atlas_conv";
  function saveConv() {
    try { localStorage.setItem(CONV_KEY, JSON.stringify(messages)); }
    catch (e) { while (messages.length > 6) { messages.shift(); try { localStorage.setItem(CONV_KEY, JSON.stringify(messages)); return; } catch (e2) {} } }
  }
  function loadConv() {
    try { messages = JSON.parse(localStorage.getItem(CONV_KEY) || "[]") || []; } catch (e) { messages = []; }
    $("agent-log").innerHTML = ""; let any = false;
    for (const m of messages) {
      if (m.role === "user" && typeof m.content === "string") { bubble("user", md(m.content)); any = true; }
      else if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === "text" && b.text && b.text.trim()) { bubble("bot", md(b.text)); any = true; }
      }
    }
    if (!any) showWelcome();
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
    $("agent-clear").addEventListener("click", () => { messages = []; try { localStorage.removeItem(CONV_KEY); } catch (e) {} $("agent-log").innerHTML = ""; showWelcome(); });
    if ($("cm-close")) $("cm-close").addEventListener("click", () => $("chartmodal").classList.add("hidden"));
    if ($("chartmodal")) $("chartmodal").addEventListener("click", (e) => { if (e.target.id === "chartmodal") $("chartmodal").classList.add("hidden"); });
    const send = () => { const t = $("agent-input").value.trim(); if (!t) return; if (!ensureKey()) { bubble("bot err", "No API key set."); return; } $("agent-input").value = ""; run(t); };
    $("agent-send").addEventListener("click", send);
    $("agent-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    loadConv();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
