// Shared RNA secondary-structure module — loaded (as a plain global script) by BOTH the
// main atlas (app.js) and the /inference page (inference.js) so the two never drift.
//
// Provides:
//   ssPairs(dbn)                         multi-level dot-bracket -> [{i,j,pk}]
//   arcDiagram(dbn, n, cw, W)            SVG arc plot of the base pairs
//   ssLayout(n, pairs)                   forna-style spring-embed node layout
//   forna2D(id, dbn, seq, react, box, alt)  forna-style 2D SVG (nodes colored by base)
//   deriveSS(text)                       client-side port of derive_ss.py: parse a
//                                        cif/pdb structure -> canonical WC/wobble pairs ->
//                                        {dbn, pairs, seq, n, bpf, pk, cls}
//
// Depends on nucColor() from viz_style.js (both pages load it first).

function ssPairs(dbn) {   // dot-bracket (multi-level) -> [{i,j,pk}] (pk = crossing/pseudoknot bracket)
  const OPENB = "([{<", CLOSEB = ")]}>", st = [[], [], [], []], pairs = [];
  for (let i = 0; i < dbn.length; i++) {
    const o = OPENB.indexOf(dbn[i]);
    if (o >= 0) { st[o].push(i); continue; }
    const c = CLOSEB.indexOf(dbn[i]);
    if (c >= 0 && st[c].length) pairs.push({ i: st[c].pop(), j: i, pk: c > 0 });
  }
  return pairs;
}
function arcDiagram(dbn, n, cw, W) {   // SVG arc plot of the predicted secondary structure
  const pairs = ssPairs((dbn || "").slice(0, n));
  if (!pairs.length) return "";
  const cap = 120; let maxH = 12;
  const segs = pairs.map((p) => { const h = Math.min(cap, 6 + (p.j - p.i) * cw * 0.55); maxH = Math.max(maxH, h); return { p, h }; });
  const aH = maxH + 8, base = aH - 2;
  let s = `<svg width="${W + 40}" height="${aH}" font-size="9"><line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="#dfe3e8"/>`;
  segs.forEach(({ p, h }) => {
    const xi = p.i * cw + cw / 2, xj = p.j * cw + cw / 2, mx = (xi + xj) / 2;
    s += `<path d="M${xi.toFixed(1)} ${base} Q ${mx.toFixed(1)} ${(base - h).toFixed(1)} ${xj.toFixed(1)} ${base}" fill="none" stroke="${p.pk ? "#c1440e" : "#2e6f95"}" stroke-width="1.2" opacity="0.55"><title>${p.i + 1}–${p.j + 1}${p.pk ? " (pseudoknot)" : ""}</title></path>`;
  });
  return s + "</svg>";
}
// forna-style 2D layout: spring-embed the nucleotide graph (backbone + base pairs), draw nodes.
let _ssCache = {};
function ssLayout(n, pairs) {
  const L = 16, pos = new Array(n);
  for (let i = 0; i < n; i++) { const a = i / n * 6.2832; pos[i] = { x: Math.cos(a) * L * n / 6.2832, y: Math.sin(a) * L * n / 6.2832 }; }
  const iters = n > 400 ? 260 : 420;
  const fx = new Float64Array(n), fy = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters * 0.8;
    fx.fill(0); fy.fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y, d2 = dx * dx + dy * dy || 0.01;
      if (d2 < 9000) { const r = 150 / d2; fx[i] += dx * r; fy[i] += dy * r; fx[j] -= dx * r; fy[j] -= dy * r; }
    }
    const sp = (a, b, str) => { const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y, d = Math.sqrt(dx * dx + dy * dy) || 0.01, f = (d - L) * str, ux = dx / d * f, uy = dy / d * f; fx[a] += ux; fy[a] += uy; fx[b] -= ux; fy[b] -= uy; };
    for (let i = 0; i < n - 1; i++) sp(i, i + 1, 0.22);
    for (const p of pairs) sp(p.i, p.j, 0.28);
    for (let i = 0; i < n; i++) { pos[i].x += Math.max(-8, Math.min(8, fx[i])) * cool; pos[i].y += Math.max(-8, Math.min(8, fy[i])) * cool; }
  }
  return pos;
}
function forna2D(id, dbn, seq, react, box, alt) {
  const n = (seq && seq.length) || (dbn || "").length || 0;
  if (n < 2) return "";
  if (n > 900) return arcDiagram(dbn, n, Math.max(6, Math.min(16, Math.floor(900 / n))), n * Math.max(6, Math.min(16, Math.floor(900 / n))));
  const pairs = ssPairs((dbn || "").slice(0, n));
  let pos = _ssCache[id];
  if (!pos || pos.length !== n) { pos = ssLayout(n, pairs); _ssCache[id] = pos; }
  const xs = pos.map((p) => p.x), ys = pos.map((p) => p.y);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const pad = 12, sc = Math.min((box - 2 * pad) / ((maxx - minx) || 1), (box - 2 * pad) / ((maxy - miny) || 1));
  const X = (v) => (pad + (v - minx) * sc).toFixed(1), Y = (v) => (pad + (v - miny) * sc).toFixed(1);
  const r = Math.max(2.4, Math.min(7, sc * 7));
  let s = `<svg width="${box}" height="${box}" font-size="7">`;
  let path = "M";
  for (let i = 0; i < n; i++) path += `${X(pos[i].x)} ${Y(pos[i].y)}${i < n - 1 ? " L" : ""} `;
  s += `<path d="${path}" fill="none" stroke="#cdd6dd" stroke-width="1.4"/>`;
  for (const p of pairs) s += `<line x1="${X(pos[p.i].x)}" y1="${Y(pos[p.i].y)}" x2="${X(pos[p.j].x)}" y2="${Y(pos[p.j].y)}" stroke="${p.pk ? "#c1440e" : "#9aa7b0"}" stroke-width="1"/>`;
  for (let i = 0; i < n; i++) {
    const ch = (seq && seq[i]) || "N";
    s += `<circle cx="${X(pos[i].x)}" cy="${Y(pos[i].y)}" r="${r.toFixed(1)}" fill="${nucColor(ch, alt)}" stroke="#fff" stroke-width="0.5"><title>${i + 1} ${ch}</title></circle>`;
    if (r >= 6 && seq) s += `<text x="${X(pos[i].x)}" y="${(+Y(pos[i].y) + 2.3).toFixed(1)}" text-anchor="middle" fill="#fff">${ch}</text>`;
  }
  return s + "</svg>";
}

// ---------- derive secondary structure from a 3D model (client-side port of derive_ss.py) ----------
// Only CANONICAL Watson-Crick / wobble pairs: complementary bases (A-U, G-C, G-U) whose WC-edge
// atoms sit within H-bond distance. C1'-C1' must be ~8-12.5 A and >=2 WC-edge H-bonds present.
const SS_HB = 3.4;                          // H-bond cutoff (A)
const SS_HB2 = SS_HB * SS_HB;
const SS_MIN_STEM = 2;
const SS_PAIR_HB = {                        // PAIR_HB[b1|b2] = [[atom_on_b1, atom_on_b2], ...]
  "A|U": [["N1", "N3"], ["N6", "O4"]],
  "G|C": [["N1", "N3"], ["N2", "O2"], ["O6", "N4"]],
  "G|U": [["N1", "O2"], ["O6", "N3"]],
};
const SS_NEED = { A: ["N1", "N6"], U: ["N3", "O4", "O2"], G: ["N1", "N2", "O6"], C: ["N3", "N4", "O2"] };
const SS_BASEMAP = {
  RA: "A", RG: "G", RC: "C", RU: "U", ADE: "A", GUA: "G", CYT: "C", URA: "U",
  DA: "A", DG: "G", DC: "C", DU: "U", DT: "U", A: "A", G: "G", C: "C", U: "U", T: "U",
};
function ssBaseOf(nm) { nm = String(nm || "").trim().toUpperCase(); return SS_BASEMAP[nm] || nm; }
function ssHbList(bi, bj) {
  if (SS_PAIR_HB[bi + "|" + bj]) return SS_PAIR_HB[bi + "|" + bj];
  if (SS_PAIR_HB[bj + "|" + bi]) return SS_PAIR_HB[bj + "|" + bi].map((pr) => [pr[1], pr[0]]);
  return null;
}
function ssCrosses(p, q) { const a = p[0], b = p[1], c = q[0], d = q[1]; return (a < c && c < b && b < d) || (c < a && a < d && d < b); }
function ssToDbn(n, pairs) {                // multi-level dot-bracket + list of crossing (pk) pairs
  const OPEN = "([{<", CLOSE = ")]}>";
  const dbn = new Array(n).fill(".");
  const levels = [], pkPairs = [];
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [i, j] of sorted) {
    let lvl = 0;
    for (; ;) {
      if (lvl >= levels.length) levels.push([]);
      if (!levels[lvl].some((pq) => ssCrosses([i, j], pq))) {
        levels[lvl].push([i, j]);
        const o = lvl < 4 ? OPEN[lvl] : OPEN[3], c = lvl < 4 ? CLOSE[lvl] : CLOSE[3];
        dbn[i] = o; dbn[j] = c;
        if (lvl > 0) pkPairs.push([i, j]);
        break;
      }
      lvl++;
    }
  }
  return { dbn: dbn.join(""), pkPairs };
}
function ssStems(pairs) {                   // maximal stacked runs -> [{pair:[i,j], len}]
  const P = new Set(pairs.map((p) => p[0] + "," + p[1])), out = [];
  for (const [i, j] of pairs) {
    if (P.has((i - 1) + "," + (j + 1))) continue;
    let a = i, b = j, L = 1;
    while (P.has((a + 1) + "," + (b - 1))) { a++; b--; L++; }
    out.push({ pair: [i, j], len: L });
  }
  return out;
}
function ssNHelices(pairs) {                // hairpins backed by a >=MIN_STEM stem (topology-correct)
  const P = pairs.map((p) => [p[0], p[1]]);
  const has = new Set(P.map((p) => p[0] + "," + p[1]));
  let cnt = 0;
  for (const [i, j] of P) {
    if (P.some(([k, l]) => i < k && k < l && l < j)) continue;   // encloses another pair
    let a = i, b = j, L = 1;
    while (has.has((a - 1) + "," + (b + 1))) { a--; b++; L++; }
    if (L >= SS_MIN_STEM) cnt++;
  }
  return cnt;
}
// Parse ATOM records (PDB) or an _atom_site loop (mmCIF) into ordered residues of the FIRST chain,
// keeping only the WC-edge atoms + C1' we need. Mirrors derive_ss.read_chain (model[0], chain[0]).
function ssParseResidues(text) {
  const isCif = text.startsWith("data_") || text.includes("_atom_site.");
  const residues = [];
  let firstChain = null, cur = null;
  const add = (chain, resSeq, resName, atomName, x, y, z) => {
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return;
    if (firstChain === null) firstChain = chain;
    if (chain !== firstChain) return;                            // first chain only
    let an = atomName.replace(/["']/g, "'");                     // C1* / C1' variants
    if (an === "C1'" || an === "C1*") an = "C1'";
    const base = ssBaseOf(resName);
    if (!cur || cur.chain !== chain || cur.resSeq !== resSeq) {
      cur = { chain, resSeq, base, atoms: {} };
      residues.push(cur);
    }
    if (an === "C1'" || (SS_NEED[base] && SS_NEED[base].indexOf(an) >= 0)) cur.atoms[an] = [x, y, z];
  };
  if (isCif) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "loop_") continue;
      const tags = []; let j = i + 1;
      while (j < lines.length && lines[j].trim().startsWith("_")) { tags.push(lines[j].trim()); j++; }
      if (!tags.length || !tags[0].startsWith("_atom_site.")) { i = j - 1; continue; }
      const col = {}; tags.forEach((t, k) => (col[t.replace("_atom_site.", "")] = k));
      const cAtom = col.label_atom_id != null ? col.label_atom_id : col.auth_atom_id;
      const cComp = col.label_comp_id != null ? col.label_comp_id : col.auth_comp_id;
      const cAsym = col.label_asym_id != null ? col.label_asym_id : col.auth_asym_id;
      const cSeq = col.auth_seq_id != null ? col.auth_seq_id : col.label_seq_id;
      const cx = col.Cartn_x, cy = col.Cartn_y, cz = col.Cartn_z;
      for (; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === "" || t === "#" || t === "loop_" || t.startsWith("_") || t.startsWith("data_")) break;
        const f = t.split(/\s+/);
        if (f.length < tags.length) continue;
        const an = (f[cAtom] || "").replace(/^['"]|['"]$/g, "");
        add(String(f[cAsym]), String(f[cSeq]), String(f[cComp]), an,
          parseFloat(f[cx]), parseFloat(f[cy]), parseFloat(f[cz]));
      }
      i = j - 1;
    }
  } else {
    for (const l of text.split("\n")) {
      if (!(l.startsWith("ATOM") || l.startsWith("HETATM"))) continue;
      add((l.slice(21, 22).trim() || "A"), l.slice(22, 27).trim(), l.slice(17, 20).trim(),
        l.slice(12, 16).trim(), parseFloat(l.slice(30, 38)), parseFloat(l.slice(38, 46)), parseFloat(l.slice(46, 54)));
    }
  }
  return residues;
}
function ssD2(p, q) { const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2]; return dx * dx + dy * dy + dz * dz; }
// text (cif/pdb) -> {dbn, pairs:[[i,j]], seq, n, bpf, pk, cls}. Returns {n:0} if not parseable.
function deriveSS(text) {
  const res = ssParseResidues(text || "");
  const n = res.length;
  if (!n) return { dbn: "", pairs: [], seq: "", n: 0, bpf: 0, pk: 0, cls: "unpaired" };
  const bases = res.map((r) => r.base);
  const cand = [];
  for (let i = 0; i < n; i++) {
    const ci = res[i].atoms;
    if (!ci["C1'"] || !SS_NEED[bases[i]]) continue;
    for (let j = i + 4; j < n; j++) {
      const cj = res[j].atoms;
      if (!cj["C1'"] || !SS_NEED[bases[j]]) continue;
      const dd = ssD2(ci["C1'"], cj["C1'"]);
      if (dd < 64 || dd > 156) continue;                 // C1'-C1' ~8-12.5 A for a WC pair
      const hl = ssHbList(bases[i], bases[j]);
      if (!hl) continue;
      let nb = 0;
      for (const [ai, aj] of hl) if (ci[ai] && cj[aj] && ssD2(ci[ai], cj[aj]) <= SS_HB2) nb++;
      if (nb >= 2) cand.push([-nb, dd, i, j]);            // prefer more H-bonds, then closer
    }
  }
  cand.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  const used = new Array(n).fill(false), pairs = [];
  for (const c of cand) {
    const i = c[2], j = c[3];
    if (!used[i] && !used[j]) { used[i] = used[j] = true; pairs.push([i, j]); }
  }
  const { dbn, pkPairs } = ssToDbn(n, pairs);
  const pkset = new Set(pkPairs.map((p) => p[0] + "," + p[1]));
  const pk = ssStems(pairs).some((s) => s.len >= SS_MIN_STEM && pkset.has(s.pair[0] + "," + s.pair[1])) ? 1 : 0;
  const helices = ssNHelices(pairs);
  const bpf = n ? Math.round(2 * pairs.length / n * 1e4) / 1e4 : 0;
  let cls;
  if (pk) cls = "pseudoknot";
  else if (helices === 0) cls = "unpaired";
  else if (helices === 1) cls = "hairpin";
  else if (helices === 2) cls = "two-helix";
  else cls = "multiloop (3+ helices)";
  return { dbn, pairs, seq: bases.join(""), n, bpf, pk, cls };
}
