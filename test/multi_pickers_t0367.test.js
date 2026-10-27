'use strict';
// T-0367: Method / Sample / Best-by pickers + compare view for datasets whose records carry several
// structures (registry `multi`; first user openknot_r9, data from T-0363). Drives the REAL helpers pulled
// out of web/app.js into a vm (web/ss.js loaded whole for deriveSS / jacobiEig3 / ssParseResidues), with
// synthetic records, samples files, reactivity files and PDB texts -- no real design ids or sequences.
//
//   node --test test/
//   WEB_DIR=/path/to/base/web node --test test/multi_pickers_t0367.test.js   # RED on a base without T-0367
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const WEB = process.env.WEB_DIR || path.join(__dirname, '..', 'web');
const APP = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const SS = fs.readFileSync(path.join(WEB, 'ss.js'), 'utf8');
const DATASETS_JS = fs.readFileSync(path.join(WEB, 'datasets.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

// top-level `function name(` of app.js, brace-matched (strings/comments in app.js never unbalance braces)
function fnText(name) {
  const m = new RegExp('^(?:async )?function ' + name + '\\s*\\(', 'm').exec(APP);
  if (!m) return null;
  const open = APP.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}') { depth--; if (depth === 0) return APP.slice(m.index, i + 1); }
  }
  return null;
}
function lineText(name) { const m = new RegExp('^(?:const|let) ' + name + ' = [^\\n]*?;(?:\\s*//[^\\n]*)?$', 'm').exec(APP); return m ? m[0] : null; }
function multiSelText() { const i = APP.search(/^let multiSel = \(\(\) => \{/m); if (i < 0) return null; const j = APP.indexOf('\n})();', i); return j < 0 ? null : APP.slice(i, j + 6); }
const need = (name, t) => { assert.ok(t, name + ' not found in app.js'); return t; };

const FNS = ['multiOf', 'saveMultiSel', 'bestByLabel', 'resolveBest', 'multiCurrent', 'multiStructPath', 'structPath', 'reactForFrame',
  'sampleOf', 'sampleDbn', 'dbnFor', 'multiShareState', 'applyMultiState', 'renderMultiBar', 'setMulti', 'multiPropRows', 'metricsLabel',
  'designWindow', 'c1Coords', 'superposeC1', 'kabsch', 'transformPDB', 'dsFor', 'fileStem', 'prefix', 'hexCF', 'structFmt', 'canPairFrames', 'validSample'];

// --- synthetic fixtures (made-up dataset, ids, dot-brackets and sequences) ---
const DS_MULTI = { id: 'mx', label: 'Multi (2)', base: 'data/datasets/mx', ext: 'pdb', react: true, motifs: false, cond: [],
  multi: { samples: 5, methods: [
    { id: 'alpha', label: 'Alpha', frame: 'design240' },
    { id: 'beta', label: 'Beta', frame: 'design240' },
    { id: 'gamma', label: 'Gamma', frame: 'construct311', note: 'Gamma folded the whole construct; no confidence' }] } };
const DS_PLAIN = { id: 'px', label: 'Plain', base: 'data/datasets/px', ext: 'pdb', react: true, motifs: true, cond: [] };
const DS_RIBO = { id: 'ribo2', label: 'curated', base: '', ext: 'cif', react: true, motifs: true, cond: [] };
function record(over) {
  return Object.assign({ id: 'design-0001', key: 'design-0001_a1b2c3', _dsid: 'mx', _uid: 'mx|design-0001', length: 240, construct_length: 311,
    default: { method: 'alpha', sample: 2 }, replicate_of: null, n_replicates: 1, n_crossed_bp_target: 12, ok_overall: 70.1, ok_crossed: 55, snr: 4.2, openknot: 66,
    methods: {
      alpha: { best: { react: 2, ranking: 4, plddt: 1 }, plddt: 81.2, ranking_score: 0.83, shape_agr: 0.41 },
      beta: { best: { react: 0, ranking: 3, plddt: 3 }, plddt: 70.5, ranking_score: 0.61, shape_agr: 0.22 },
      gamma: { best: { react: 1, ranking: null, plddt: null }, plddt: null, ranking_score: null, shape_agr: 0.3 } } }, over || {});
}
const dbn240 = (k) => '('.repeat(60 + k) + '.'.repeat(120 - 2 * k) + ')'.repeat(60 + k);
const dbn311 = (k) => '.'.repeat(26) + dbn240(k) + '.'.repeat(45);
function samplesFile() {
  const S = (dbn, k, conf) => Object.assign({ k, dbn, bp_fraction: 0.5, pseudoknot: 0, ss_class: 'hairpin', r2a3: -0.3 - k / 100, shape_agr: 0.3 + k / 100, shape_ok: 1, rdms: -0.2 }, conf);
  const conf = (k) => ({ plddt: 60 + 5 * k, ptm: 0.5 + k / 20, gpde: 0.4, ranking_score: 0.5 + k / 10, has_clash: false });
  const none = { plddt: null, ptm: null, gpde: null, ranking_score: null, has_clash: null };
  return { methods: {
    alpha: { samples: [0, 1, 2, 3, 4].map((k) => S(dbn240(k), k, conf(k))), best: { react: 2, ranking: 4, plddt: 1 } },
    beta: { samples: [0, 1, 2, 3, 4].map((k) => S(dbn240(k + 1), k, conf(k))), best: { react: 0, ranking: 3, plddt: 3 } },
    gamma: { samples: [0, 1, 2, 3, 4].map((k) => S(dbn311(k), k, none)), best: { react: 1, ranking: null, plddt: null } } },
  target_dbn: dbn240(9) };
}
const SEQ311 = 'G'.repeat(26) + 'ACGU'.repeat(60) + 'C'.repeat(45);
function reactRaw() {
  const arr = (o) => Array.from({ length: 311 }, (_, i) => +((i % 7) / 10 + o).toFixed(3));
  return { seq311: SEQ311, design_start: 26, design_end: 266, a23: arr(0), dms: arr(0.05), a23_err: arr(0.01), dms_err: arr(0.02), sn: { a23: 3.1, dms: 2.2 }, reads: { a23: 1000, dms: 900 } };
}
// a C1'-only PDB chain (ss.js parses C1' + WC-edge atoms; with C1' alone deriveSS finds no pairs -> all dots)
function pdbOf(pts) {
  return pts.map((p, i) => 'ATOM  ' + String(i + 1).padStart(5) + '  C1\'   A A' + String(i + 1).padStart(4) + '    ' +
    p[0].toFixed(3).padStart(8) + p[1].toFixed(3).padStart(8) + p[2].toFixed(3).padStart(8) + '  1.00 50.00           C').join('\n') + '\nEND\n';
}
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const randPts = (n, s) => Array.from({ length: n }, (_, i) => [i * 3 + (rnd() - 0.5) * (s || 4), (rnd() - 0.5) * 20, (rnd() - 0.5) * 20]);
function rotXYZ(a, b, c) {
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  const Rx = [[1, 0, 0], [0, ca, -sa], [0, sa, ca]], Ry = [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]], Rz = [[cc, -sc, 0], [sc, cc, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _x, k) => s + A[i][k] * B[k][j], 0)));
  return mul(Rx, mul(Ry, Rz));
}
const apply = (R, t, p) => [0, 1, 2].map((a) => R[a][0] * p[0] + R[a][1] * p[1] + R[a][2] * p[2] + t[a]);
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const det3 = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);

// fake DOM element: enough for renderMultiBar / classList toggles
function fakeEl(id) {
  const cls = new Set();
  return { id, innerHTML: '', value: '', dataset: {}, _cls: cls, querySelectorAll: () => [],
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => { if (on === undefined) on = !cls.has(c); if (on) cls.add(c); else cls.delete(c); return on; } } };
}
function sandbox(opts) {
  opts = opts || {};
  const store = {}, els = {}, calls = { load3D: 0, drawTracks: 0, drawProps: 0, drawReactChart: 0, saveState: 0 };
  const sb = {
    console, JSON, Math, Number, Array, Object, String, parseFloat,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    $: (id) => (els[id] = els[id] || fakeEl(id)),
    DATASETS: [DS_RIBO, DS_PLAIN, DS_MULTI], DSBYID: { ribo2: DS_RIBO, px: DS_PLAIN, mx: DS_MULTI },
    PAIRING_BY_DS: { px: { 'design-0001': '((..))' } },
    currentDeep: null, panoViewers: [], nucColor: () => '#888888',   // viz_style.js palette, not under test
    load3D: () => { calls.load3D++; }, drawTracks: () => { calls.drawTracks++; }, drawProps: () => { calls.drawProps++; },
    drawReactChart: () => { calls.drawReactChart++; }, saveState: () => { calls.saveState++; }, refreshProjIfActive: () => {},
  };
  vm.createContext(sb);
  vm.runInContext(SS, sb);                                  // deriveSS, jacobiEig3, ssParseResidues, ...
  const parts = [need('esc', lineText('esc')), need('num', lineText('num')), need('MULTI_BESTBY', lineText('MULTI_BESTBY')),
    need('MULTI_KEY', lineText('MULTI_KEY')), need('OVERLAY_COLORS', lineText('OVERLAY_COLORS')), need('multiSel', multiSelText())];
  FNS.forEach((n) => parts.push(need(n, fnText(n))));
  // `let`/`const` at a script's top level are not properties of the vm global; re-declare them with var so
  // the tests can read multiSel / the constants the way the functions do (by name).
  vm.runInContext(parts.join('\n').replace(/^(?:let|const) (multiSel|MULTI_BESTBY|MULTI_KEY|OVERLAY_COLORS|esc|num) = /gm, 'var $1 = '), sb);
  sb._store = store; sb._els = els; sb._calls = calls;
  return sb;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
function deferred() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }
const ticks = async (n) => { for (let i = 0; i < (n || 20); i++) await new Promise((r) => setImmediate(r)); };
// the async deep-view entry points (openDeep / load3D / closeDeep) with the DOM, 3Dmol and the fetches stubbed:
// fetch returns a deferred per URL so a test can settle responses out of order
function asyncSandbox() {
  const sb = sandbox();
  const pending = [];
  Object.assign(sb, {
    fetch: (url) => { const d = deferred(); pending.push({ url: String(url), d }); return d.p; },
    durl: (p) => p, foldById: (key) => sb._fold, setDeepMode: () => {}, currentMode: () => 'modal', updateLayout: () => {},
    _projRaf: 0, cancelAnimationFrame: () => {}, disposePano: () => {}, loseGL: () => {}, ensureViewerResizeObserver: () => {},
    renderMultiBar: () => {}, renderChannelGallery: () => {}, renderMolstar: () => {}, refreshProjIfActive: () => {},
    viewer: null, viewerModel: null, mstar: null, deepEngine: '3dmol', renderCompare: async () => { sb._calls.compare = (sb._calls.compare || 0) + 1; },
  });
  const parts = [need('openDeep', fnText('openDeep')), need('load3D', fnText('load3D')), need('closeDeep', fnText('closeDeep')),
    need('_openSeq', lineText('_openSeq')), need('_load3DSeq', lineText('_load3DSeq'))];
  vm.runInContext(parts.join('\n').replace(/^(?:let|const) (_openSeq|_load3DSeq) = /gm, 'var $1 = '), sb);
  sb._pending = pending;
  return sb;
}
const okJson = (v) => ({ ok: true, json: async () => v, text: async () => JSON.stringify(v) });
const okText = (s) => ({ ok: true, json: async () => { throw new Error('not json'); }, text: async () => s });

test('registry: every multi entry is well-formed and openknot_r9 declares the three methods in order', () => {
  const w = {}; vm.runInContext(DATASETS_JS, vm.createContext({ window: w }));
  const multi = w.DATASETS.filter((d) => d.multi);
  assert.ok(multi.length >= 1, 'no multi dataset registered');
  for (const d of multi) {
    assert.ok(Number.isInteger(d.multi.samples) && d.multi.samples >= 1, d.id + ': samples');
    assert.ok(Array.isArray(d.multi.methods) && d.multi.methods.length, d.id + ': methods');
    const ids = d.multi.methods.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, d.id + ': duplicate method id');
    d.multi.methods.forEach((m) => {
      assert.ok(m.id && m.label, d.id + ': method id/label');
      assert.ok(['design240', 'construct311'].includes(m.frame), d.id + '/' + m.id + ': frame ' + m.frame);
      if (m.frame === 'construct311') assert.ok(m.note, d.id + '/' + m.id + ': a whole-construct method needs its note');
    });
    assert.equal(d.motifs, false, d.id + ': a multi dataset ships no pairing.json/motifs.json');
    assert.equal(d.react, true, d.id + ': react');
  }
  const ok9 = w.DATASETS.find((d) => d.id === 'openknot_r9');
  assert.ok(ok9, 'openknot_r9 missing');
  assert.deepEqual(plain(ok9.multi.methods.map((m) => m.id)), ['rnanix', 'protenix', 'rnetdiff']);
  assert.equal(ok9.multi.samples, 5);
  assert.equal(ok9.base, 'data/datasets/openknot_r9');
  assert.equal(ok9.ext, 'pdb');
  assert.equal(ok9.multi.methods[2].frame, 'construct311');
  assert.equal(w.DATASETS.filter((d) => d.id === 'openknot_r9').length, 1);
});

test('shell: the picker bar is in index.html, app.js wires it and every JS file passes node --check', () => {
  for (const id of ['multi-bar', 'mb-methods', 'mb-samples', 'mb-bestby', 'mb-cmpmode', 'mb-note']) assert.ok(INDEX.includes('id="' + id + '"'), 'index.html lacks #' + id);
  assert.ok(/data-cmp="side"/.test(INDEX) && /data-cmp="overlay"/.test(INDEX), 'compare layout toggle');
  assert.ok(/^\s+wireMultiBar\(\);/m.test(APP), 'wireStatic does not call wireMultiBar()');
  assert.ok(/openDeep\(initial\.deep, \{ keepSample: !!\(initial\.multi && validSample\(initial\.multi\.sample\)\) \}\)/.test(APP), 'a shared link keeps its sample only when the link names a valid one');
  assert.ok(/applyMultiState\(initial\.multi\)/.test(APP), 'enterState does not apply the link state');
  assert.ok(/s\.multi = multiShareState\(\)/.test(APP), 'fullSnapshot does not record the pickers');
  assert.ok(!/PAIRING_BY_DS\[f\._dsid\] \|\| \{\}\)\[f\.id\] \|\| ""/.test(APP.replace(fnText('dbnFor'), '')), 'a dot-bracket site still bypasses dbnFor()');
  assert.ok(!/PAIRING_BY_DS\[fold\._dsid\]/.test(APP), 'refreshProjIfActive still bypasses dbnFor()');
  for (const f of ['app.js', 'datasets.js', 'ss.js', 'agent.js', 'viz_style.js', 'config.js']) {
    const r = spawnSync(process.execPath, ['--check', path.join(WEB, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, f + ': ' + r.stderr);
  }
});

test('resolveBest: react -> ranking -> sample 1, each fallback with its note; explicit rules fall back once', () => {
  const sb = sandbox();
  const r = (block, by, mdef) => plain(sb.resolveBest(block, by, mdef || { id: 'g', label: 'Gamma' }));
  assert.deepEqual(r({ best: { react: 3, ranking: 1, plddt: 0 } }, 'react'), { k: 3, by: 'react', note: '' });
  assert.deepEqual(r({ best: { react: null, ranking: 1, plddt: 0 } }, 'react'), { k: 1, by: 'ranking', note: 'no reactivity for this design: best by ranking score' });
  assert.deepEqual(r({ best: { react: null, ranking: null, plddt: null } }, 'react'), { k: 0, by: null, note: 'no reactivity for this design and no confidence for Gamma: showing sample 1' });
  assert.deepEqual(r({ best: { react: 2, ranking: 4, plddt: 1 } }, 'ranking'), { k: 4, by: 'ranking', note: '' });
  assert.deepEqual(r({ best: { react: 2, ranking: 4, plddt: 1 } }, 'plddt'), { k: 1, by: 'plddt', note: '' });
  assert.deepEqual(r({ best: { react: 2, ranking: null, plddt: null } }, 'plddt'), { k: 0, by: null, note: 'no confidence for Gamma: showing sample 1' });
  assert.deepEqual(r({}, 'ranking'), { k: 0, by: null, note: 'no confidence for Gamma: showing sample 1' });
  assert.deepEqual(plain(sb.resolveBest(null, 'react', null)), { k: 0, by: null, note: 'no reactivity for this design and no confidence for this method: showing sample 1' });
  assert.equal(r({ best: { react: -1, ranking: 2.5, plddt: '1' } }, 'react').k, 0, 'non-index values are not indices');
});

test('multiCurrent: record default, sticky method, unknown method, explicit sample clamped, frames', () => {
  const sb = sandbox();
  const f = record();
  let c = sb.multiCurrent(f);
  assert.equal(c.method, 'alpha'); assert.equal(c.k, 2); assert.equal(c.by, 'react'); assert.equal(c.frame, 'design240'); assert.equal(c.nS, 5);
  sb.multiSel.method = 'gamma';
  c = sb.multiCurrent(f);
  assert.equal(c.method, 'gamma'); assert.equal(c.k, 1); assert.equal(c.frame, 'construct311');
  sb.multiSel.bestBy = 'ranking';
  c = sb.multiCurrent(f);
  assert.equal(c.k, 0); assert.match(c.note, /no confidence for Gamma/);
  sb.multiSel.method = 'nope';
  assert.equal(sb.multiCurrent(f).method, 'alpha', 'an unknown sticky method falls back to the record default');
  sb.multiSel.method = null; sb.multiSel.sample = 9;
  assert.equal(sb.multiCurrent(f).k, 4, 'explicit sample clamped to samples-1');
  sb.multiSel.sample = 3;
  assert.deepEqual([sb.multiCurrent(f).k, sb.multiCurrent(f).by, sb.multiCurrent(f).note], [3, null, '']);
  assert.equal(sb.multiCurrent(f, 'beta', 'best').k, 3, 'override: beta best by ranking');
  assert.equal(sb.multiCurrent(record({ default: { method: 'zzz', sample: 0 } })).method, 'alpha', 'a bad record default -> first registry method');
  assert.equal(sb.multiCurrent({ id: 'p', _dsid: 'px' }), null, 'one-structure dataset');
});

test('structPath: multi names by key, method and 0-based sample; plain datasets keep the legacy names', () => {
  const sb = sandbox();
  const f = record();
  assert.equal(sb.structPath(f, DS_MULTI), 'data/datasets/mx/structs/design-0001_a1b2c3__alpha__s2.pdb');
  sb.multiSel.method = 'gamma'; sb.multiSel.sample = 4;
  assert.equal(sb.structPath(f, DS_MULTI), 'data/datasets/mx/structs/design-0001_a1b2c3__gamma__s4.pdb');
  assert.equal(sb.multiStructPath(f, DS_MULTI, 'beta', 0), 'data/datasets/mx/structs/design-0001_a1b2c3__beta__s0.pdb');
  assert.equal(sb.structPath({ id: 'x', key: 'x_k', _dsid: 'px' }, DS_PLAIN), 'data/datasets/px/structs/x_k.pdb');
  assert.equal(sb.structPath({ id: 'rid', key: 'rid_k', _dsid: 'ribo2' }, DS_RIBO), 'structs/rid.cif');
});

test('reactForFrame: design window for design240, whole construct for construct311, sn/reads adapted, legacy untouched', () => {
  const sb = sandbox();
  const raw = reactRaw();
  const d = sb.reactForFrame(raw, 'design240');
  assert.equal(d.seq, 'ACGU'.repeat(60)); assert.equal(d.a23.length, 240); assert.equal(d.dms.length, 240); assert.equal(d.a23_err.length, 240);
  assert.equal(d.a23[0], raw.a23[26]); assert.equal(d.a23[239], raw.a23[265]);
  assert.deepEqual(plain(d.sn), [2.2, 3.1]);
  assert.equal(d.frame, 'design240');
  assert.deepEqual(Object.keys(plain(d)).sort(), ['a23', 'a23_err', 'dms', 'dms_err', 'frame', 'seq', 'sn'], 'only what the drawing code reads, plus the frame tag');
  const c = sb.reactForFrame(raw, 'construct311');
  assert.equal(c.seq, SEQ311); assert.equal(c.a23.length, 311); assert.equal(c.frame, 'construct311');
  const legacy = { seq: 'ACGU', a23: [1, 2, 3, 4], dms: null, sn: [null, 2] };
  assert.equal(sb.reactForFrame(legacy, 'design240'), legacy, 'legacy files pass through by identity');
  assert.equal(sb.reactForFrame(null, 'design240'), null);
  const noA = sb.reactForFrame(Object.assign(reactRaw(), { a23: null, dms: null, sn: null }), 'design240');
  assert.equal(noA.a23, null); assert.equal(noA.dms, null); assert.equal(noA.sn, null); assert.equal(noA.seq.length, 240);
});

test('dbnFor: the shown sample from the samples file, derived from the 3D when that file is missing, pairing.json otherwise', () => {
  const sb = sandbox();
  const f = record();
  sb.currentDeep = { f, samples: samplesFile().methods, structSel: { method: 'alpha', k: 2 }, structText: 'x' };
  assert.equal(sb.dbnFor(f), dbn240(2));
  sb.multiSel.method = 'gamma';
  assert.equal(sb.dbnFor(f), dbn311(1), "gamma's best-by-react sample 1, 311 nt");
  sb.multiSel.sample = 4;
  assert.equal(sb.dbnFor(f), dbn311(4));
  // no samples file: derive from the loaded structure, only when it IS the shown selection
  const text = pdbOf(randPts(12));
  sb.currentDeep = { f, samples: null, structSel: { method: 'gamma', k: 4 }, structText: text };
  const derived = sb.dbnFor(f);
  assert.equal(derived.length, 12, 'derived dot-bracket has one symbol per residue');
  assert.ok(sb.currentDeep._dbnDerived && sb.currentDeep._dbnDerived['gamma/4'] === derived, 'cached per method/sample');
  sb.currentDeep.structSel = { method: 'gamma', k: 3 };
  assert.equal(sb.dbnFor(f), '', 'a structure of another sample is not used');
  sb.currentDeep = null;
  assert.equal(sb.dbnFor({ id: 'design-0001', _dsid: 'px' }), '((..))', 'plain datasets: pairing.json');
  assert.equal(sb.dbnFor({ id: 'other', _dsid: 'px' }), '');
});

test('share state: round trip through multiShareState/applyMultiState; junk is ignored', () => {
  const sb = sandbox();
  sb.multiSel.method = 'beta'; sb.multiSel.sample = 3; sb.multiSel.bestBy = 'plddt'; sb.multiSel.compare = true; sb.multiSel.cmpMode = 'overlay';
  const s = plain(sb.multiShareState());
  assert.deepEqual(s, { method: 'beta', sample: 3, bestBy: 'plddt', compare: true, cmpMode: 'overlay' });
  const sb2 = sandbox();
  sb2.applyMultiState(s);
  assert.deepEqual(plain(sb2.multiShareState()), s);
  sb2.applyMultiState({ method: 7, sample: -1, bestBy: 'nope', compare: 'yes', cmpMode: 'diagonal' });
  assert.deepEqual(plain(sb2.multiShareState()), s, 'invalid values leave the state alone');
  sb2.applyMultiState(null); sb2.applyMultiState('x');
  assert.deepEqual(plain(sb2.multiShareState()), s);
  assert.deepEqual(['best', 0, 4].map(sb2.validSample), [true, true, true]);
  assert.deepEqual([-1, 2.5, '2', null, undefined, 'x'].map(sb2.validSample), [false, false, false, false, false, false]);
  sb2.saveMultiSel();
  const saved = JSON.parse(sb2._store.atlas_multi);
  assert.deepEqual(saved, { method: 'beta', bestBy: 'plddt', compare: true, cmpMode: 'overlay' }, 'the explicit sample is not persisted across folds');
});

test('kabsch: recovers a rigid motion exactly, refuses a reflection, handles planar sets, rejects degenerate input', () => {
  const sb = sandbox();
  const P = randPts(30);
  const R = rotXYZ(0.4, 1.1, -0.7), t = [3, -2, 5];
  const Q = P.map((p) => apply(R, t, p));
  const fit = sb.kabsch(P, Q);
  assert.ok(fit && fit.n === 30);
  assert.ok(fit.rmsd < 1e-6, 'rmsd ' + fit.rmsd);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) assert.ok(Math.abs(fit.R[a][b] - R[a][b]) < 1e-6, 'R mismatch');
  assert.ok(t.every((v, a) => Math.abs(fit.t[a] - v) < 1e-6), 't mismatch');
  const mirror = P.map((p) => [-p[0], p[1], p[2]]);
  const mf = sb.kabsch(P, mirror);
  assert.ok(mf && det3(mf.R) > 0.999, 'a reflection must come back as a proper rotation');
  assert.ok(mf.rmsd > 1, 'a mirror image cannot be fitted by a rotation');
  const flat = P.map((p) => [p[0], p[1], 0]);
  const ff = sb.kabsch(flat, flat.map((p) => apply(R, t, p)));
  assert.ok(ff && ff.rmsd < 1e-6, 'planar set');
  const line = Array.from({ length: 5 }, (_, i) => [i, 2 * i, 3 * i]);
  assert.equal(sb.kabsch(line, line.map((p) => apply(R, t, p))), null, 'collinear points have no unique rotation');
  assert.equal(sb.kabsch(P.slice(0, 2), Q.slice(0, 2)), null, 'fewer than 3 points');
  assert.equal(sb.kabsch(P, Q.slice(0, 10)), null, 'length mismatch');
});

test('superposeC1 + transformPDB: the construct frame aligns on its design window; coordinates are rewritten in place', () => {
  const sb = sandbox();
  const ref = randPts(240);                                           // design240 reference, residues 0..239
  const R = rotXYZ(-0.9, 0.3, 2.0), t = [-4, 8, 1];
  const pad5 = randPts(26, 1).map((p) => [p[0] - 100, p[1], p[2]]), pad3 = randPts(45, 1).map((p) => [p[0] + 800, p[1], p[2]]);
  const mob = pad5.concat(ref.map((p) => apply(R, t, p)), pad3);      // 311: pads + the moved design
  assert.equal(mob.length, 311);
  const fit = sb.superposeC1(mob, [26, 266], ref, null);
  assert.ok(fit && fit.n === 240 && fit.rmsd < 1e-6, 'window alignment: ' + JSON.stringify(fit && { n: fit.n, rmsd: fit.rmsd }));
  const moved = sb.transformPDB(pdbOf(mob), fit.R, fit.t);
  const back = sb.c1Coords(moved);
  assert.equal(back.length, 311);
  for (let i = 0; i < 240; i++) assert.ok(dist(back[26 + i], ref[i]) < 2e-3, 'residue ' + i + ' not on the reference');
  const lines = moved.split('\n');
  assert.ok(lines[0].startsWith('ATOM  ') && lines[0].length === pdbOf(mob).split('\n')[0].length, 'fixed columns kept');
  assert.equal(lines[lines.length - 2], 'END');
  assert.equal(sb.superposeC1(mob.slice(0, 2), null, ref.slice(0, 2), null), null);
  // designWindow reads the open fold's react file
  sb.currentDeep = { reactRaw: reactRaw() };
  assert.deepEqual(plain(sb.designWindow({ frame: 'construct311' })), [26, 266]);
  assert.equal(sb.designWindow({ frame: 'design240' }), null);
  sb.currentDeep = { reactRaw: null };
  assert.equal(sb.designWindow({ frame: 'construct311' }), null, 'no react file: no window');
  // without a window a whole-construct chain must not be index-paired with a design chain (26-nt offset -> bogus RMSD)
  assert.equal(sb.canPairFrames('construct311', null, 'design240', null), false);
  assert.equal(sb.canPairFrames('design240', null, 'construct311', null), false);
  assert.equal(sb.canPairFrames('construct311', [26, 266], 'design240', null), true);
  assert.equal(sb.canPairFrames('design240', null, 'construct311', [26, 266]), true);
  assert.equal(sb.canPairFrames('construct311', null, 'construct311', null), true, 'same frame pairs by index');
  assert.equal(sb.canPairFrames('design240', null, 'design240', null), true);
  assert.equal(sb.transformPDB('data_x\nloop_\n', fit.R, fit.t), null, 'CIF: no transform, so the legend says not aligned');
  assert.equal(sb.structFmt('data_x\nloop_\n'), 'cif'); assert.equal(sb.structFmt('ATOM      1'), 'pdb');
});

test('renderMultiBar: hidden for one-structure datasets; buttons, Best label, notes and tooltips for a multi record', () => {
  const sb = sandbox();
  sb.renderMultiBar({ id: 'p', _dsid: 'px' });
  assert.ok(sb._els['multi-bar']._cls.has('hidden'));
  assert.ok(!sb._els.deep._cls.has('cmp-on'));
  const f = record();
  sb.currentDeep = { f, samples: samplesFile().methods, reactRaw: reactRaw() };
  sb.renderMultiBar(f);
  assert.ok(!sb._els['multi-bar']._cls.has('hidden'));
  const m = sb._els['mb-methods'].innerHTML, s = sb._els['mb-samples'].innerHTML;
  assert.equal((m.match(/<button/g) || []).length, 4, '3 methods + Compare');
  assert.ok(/data-m="alpha" class="active"/.test(m), 'the shown method is active');
  assert.ok(/data-m="compare" class=""/.test(m));
  assert.equal((s.match(/<button/g) || []).length, 6, 'Best + 5 samples');
  assert.ok(/data-k="best" class="active"[^>]*>Best \(3\)</.test(s), 'Best names the sample it resolved to (1-based)');
  assert.ok(/data-k="1"[^>]*title="pLDDT 65.0 · ranking 0.600 · agreement 0.31"/.test(s), 'per-sample tooltip from the samples file');
  assert.ok(/<option value="react" selected>reactivity agreement<\/option>/.test(sb._els['mb-bestby'].innerHTML));
  assert.ok(/<option value="ranking">ranking score<\/option><option value="plddt">mean pLDDT<\/option>/.test(sb._els['mb-bestby'].innerHTML), 'ruled order');
  assert.equal(sb._els['mb-note'].innerHTML, '', 'alpha at its reactivity best: nothing to note');
  assert.ok(sb._els['mb-cmpmode']._cls.has('hidden'));
  sb.multiSel.method = 'gamma'; sb.multiSel.bestBy = 'ranking';
  sb.renderMultiBar(f);
  const note = sb._els['mb-note'].innerHTML;
  assert.ok(/no confidence for Gamma: showing sample 1/.test(note), 'fallback note');
  assert.ok(/Gamma folded the whole construct/.test(note), 'frame note when the whole-construct method is shown');
  assert.ok(/Best \(1\)/.test(sb._els['mb-samples'].innerHTML));
  sb.multiSel.method = 'alpha'; sb.multiSel.sample = 3; sb.multiSel.compare = true;
  sb.renderMultiBar(f);
  assert.ok(/data-k="3" class="active"/.test(sb._els['mb-samples'].innerHTML));
  assert.ok(/data-m="compare" class="active"/.test(sb._els['mb-methods'].innerHTML));
  assert.ok(!sb._els['mb-cmpmode']._cls.has('hidden'), 'compare layout toggle shows in compare');
  assert.ok(sb._els.deep._cls.has('cmp-on'), 'compare widens the 3D region');
  const cmpNotes = sb._els['mb-note'].innerHTML;
  assert.equal((cmpNotes.match(/no confidence for Gamma: showing sample 1/g) || []).length, 1, "compare lists the other methods' fallbacks once");
  assert.ok(!/Gamma: no confidence for Gamma/.test(cmpNotes), 'no doubled method name');
  sb.multiSel.compare = false; sb.renderMultiBar(f);
  assert.ok(!sb._els.deep._cls.has('cmp-on') && sb._els['mb-cmpmode']._cls.has('hidden'));
  sb.multiSel.compare = true;
  sb.renderMultiBar(record({ replicate_of: 'design-0000', n_replicates: 3 }));
  assert.ok(/replicate of design-0000/.test(sb._els['mb-note'].innerHTML));
});

test('setMulti: reloads the 3D only when the structure changes, re-slices the reactivity when the frame changes', () => {
  const sb = sandbox();
  const f = record();
  sb.currentDeep = { f, samples: samplesFile().methods, reactRaw: reactRaw(), react: null };
  sb.currentDeep.react = sb.reactForFrame(sb.currentDeep.reactRaw, 'design240');
  sb.setMulti({ bestBy: 'react' });                                   // same structure (alpha s2)
  assert.deepEqual([sb._calls.load3D, sb._calls.drawTracks, sb._calls.drawProps, sb._calls.saveState], [0, 1, 1, 1]);
  sb.setMulti({ bestBy: 'ranking' });                                 // alpha s4: new structure
  assert.equal(sb._calls.load3D, 1); assert.equal(sb._calls.drawTracks, 2, 'tracks follow the selection in every 2D mode, not only in "3D projection"');
  sb.setMulti({ method: 'gamma', compare: false });                   // frame changes -> 311-nt reactivity
  assert.equal(sb._calls.load3D, 2); assert.equal(sb._calls.drawTracks, 3);
  assert.equal(sb.currentDeep.react.seq.length, 311); assert.equal(sb.currentDeep.react.frame, 'construct311');
  sb.setMulti({ method: 'beta', compare: false });
  assert.equal(sb.currentDeep.react.seq.length, 240);
  sb.setMulti({ compare: true });                                     // compare on: 3D rebuilt
  assert.equal(sb._calls.load3D, 4);
  sb.setMulti({ cmpMode: 'overlay' });                                // layout change in compare: 3D rebuilt
  assert.equal(sb._calls.load3D, 5);
  sb.setMulti({ bestBy: 'plddt' });                                   // beta's own sample is unchanged (ranking 3 -> plddt 3) but the OTHER cells follow the rule
  assert.equal(sb.multiCurrent(f).k, 3);
  assert.equal(sb._calls.load3D, 6, 'compare rebuilds on a Best-by change even when the selected method keeps its sample');
  sb.setMulti({ compare: false });
  assert.equal(sb._calls.load3D, 7);
  sb.setMulti({ bestBy: 'ranking' });                                 // single view, same sample: no reload
  assert.equal(sb._calls.load3D, 7);
  assert.equal(JSON.parse(sb._store.atlas_multi).method, 'beta', 'persisted');
  sb.currentDeep = null;
  sb.setMulti({ method: 'alpha' });
  assert.equal(sb._calls.load3D, 7, 'nothing open: only the selection changes');
  assert.equal(sb.multiSel.method, 'alpha');
});

test('multiPropRows: structure shown, frame, this sample, per-method summary, replicate, target, measured score', () => {
  const sb = sandbox();
  assert.deepEqual(plain(sb.multiPropRows({ id: 'p', _dsid: 'px' })), []);
  const f = record();
  sb.currentDeep = { f, samples: samplesFile().methods, reactRaw: reactRaw(), targetDbn: dbn240(9) };
  let rows = Object.fromEntries(plain(sb.multiPropRows(f)));
  assert.match(rows['Structure shown'], /^Alpha · sample 3 of 5 \(best by reactivity agreement\)$/);
  assert.match(rows['This sample'], /pLDDT 70\.0 · pTM 0\.600 · gpde 0\.400 · ranking 0\.700 · no clash · 2A3 agreement 0\.320/);
  assert.match(rows['Methods (best-by-reactivity sample)'], /Alpha: pLDDT 81\.2 · ranking 0\.830 · agreement 0\.410<br>Beta: .*<br>Gamma: pLDDT n\/a · ranking n\/a · agreement 0\.300/);
  assert.match(rows['Design target'], /12 crossed base pairs/);
  assert.match(rows['Measured OpenKnot'], /overall 70\.1 · crossed 55\.0 · SNR 4\.20/);
  assert.equal(rows.Frame, undefined); assert.equal(rows.Replicate, undefined);
  sb.multiSel.method = 'gamma'; sb.multiSel.sample = 0;
  const f2 = record({ replicate_of: 'design-0000', n_replicates: 2 });
  sb.currentDeep.f = f2;                                                // the design window comes from the OPEN fold's react file
  rows = Object.fromEntries(plain(sb.multiPropRows(f2)));
  assert.match(rows['Structure shown'], /^Gamma · sample 1 of 5 \(chosen\)$/);
  assert.match(rows.Frame, /full 311-nt construct as folded; the design is positions 27–266/);
  assert.match(rows.Replicate, /same design sequence as design-0000 \(2 constructs\)/);
  sb.currentDeep.samples = null;
  rows = Object.fromEntries(plain(sb.multiPropRows(f2)));
  assert.match(rows['This sample'], /unavailable/);
});

test('metricsLabel: the sample values, else the record summary only for the best-by-reactivity cell', () => {
  const sb = sandbox();
  const f = record();
  sb.currentDeep = { f, samples: samplesFile().methods };
  assert.equal(sb.metricsLabel(f, { method: 'alpha', k: 2, by: 'react' }), ' · pLDDT 70.0 · rank 0.70 · agr 0.32');
  sb.currentDeep = { f, samples: null };
  assert.equal(sb.metricsLabel(f, { method: 'alpha', k: 2, by: 'react' }), ' · pLDDT 81.2 · rank 0.83 · agr 0.41');
  assert.equal(sb.metricsLabel(f, { method: 'alpha', k: 2, by: 'ranking' }), '', 'the summary describes another sample');
  assert.equal(sb.metricsLabel(f, { method: 'gamma', k: 1, by: 'react' }), ' · agr 0.30');
});

test('load3D: two loads of the same fold settle out of order -> only the newest renders (3D matches the pickers)', async () => {
  const sb = asyncSandbox();
  const f = record();
  sb.currentDeep = { f, samples: samplesFile().methods, reactRaw: reactRaw(), react: null };
  sb.multiSel.sample = 0;
  const p0 = sb.load3D(f, null);                                      // fetches ...__alpha__s0.pdb
  await ticks();
  sb.multiSel.sample = 1;
  const p1 = sb.load3D(f, null);                                      // fetches ...__alpha__s1.pdb
  await ticks();
  assert.equal(sb._pending.length, 2);
  assert.match(sb._pending[0].url, /__alpha__s0\.pdb$/); assert.match(sb._pending[1].url, /__alpha__s1\.pdb$/);
  sb._pending[1].d.resolve(okText('PDB-ONE'));                        // the newer request answers first ...
  await p1; await ticks();
  sb._pending[0].d.resolve(okText('PDB-ZERO'));                       // ... then the stale one
  await p0; await ticks();
  assert.equal(sb.currentDeep.structText, 'PDB-ONE', 'a stale load must not overwrite the newer structure');
  assert.deepEqual(plain(sb.currentDeep.structSel), { method: 'alpha', k: 1 });
  assert.equal(sb._calls.drawTracks, 1, 'tracks drawn once, for the structure that stayed');
  // a compare load started after a single load wins the same way
  sb.multiSel.compare = true;
  const p2 = sb.load3D(f, null); await ticks(); await p2;
  assert.equal(sb._calls.compare, 1);
  sb.multiSel.compare = false; sb.multiSel.sample = 2;
  const p3 = sb.load3D(f, null); await ticks();
  sb._pending[2].d.resolve(okText('PDB-TWO')); await p3; await ticks();
  assert.equal(sb.currentDeep.structText, 'PDB-TWO');
});

test('openDeep + closeDeep: closing the view while its fetches are in flight leaves nothing behind', async () => {
  const sb = asyncSandbox();
  const f = record(); sb._fold = f;
  sb.$('deep').classList.add('hidden');
  const p = sb.openDeep('mx|design-0001');
  await ticks();
  assert.equal(sb._pending.length, 2, 'react + samples requested in parallel');
  assert.ok(!sb._els.deep._cls.has('hidden'));
  sb.closeDeep();
  assert.equal(sb.currentDeep, null); assert.ok(sb._els.deep._cls.has('hidden'));
  const saves = sb._calls.saveState;
  sb._pending[0].d.resolve(okJson(reactRaw())); sb._pending[1].d.resolve(okJson(samplesFile()));
  await p; await ticks();
  assert.equal(sb.currentDeep, null, 'the closed view must not be repopulated by late responses');
  assert.equal(sb._pending.length, 2, 'no structure fetched into a hidden view (the real load3D runs in this sandbox)');
  assert.equal(sb._calls.saveState, saves, 'the share link keeps the closed state');
  // the normal path still works afterwards: open, answers arrive, the view fills
  const p2 = sb.openDeep('mx|design-0001'); await ticks();
  sb._pending[2].d.resolve(okJson(reactRaw())); sb._pending[3].d.resolve(okJson(samplesFile()));
  await p2; await ticks();
  assert.ok(sb.currentDeep && sb.currentDeep.f === f && sb.currentDeep.samples && sb.currentDeep.react.seq.length === 240);
  assert.equal(sb._pending.length, 5, 'the structure of the record default (alpha, best by reactivity = sample 3) is fetched');
  assert.match(sb._pending[4].url, /__alpha__s2\.pdb$/);
  assert.equal(sb.multiSel.sample, 'best', 'opening a fold resets an explicit sample');
});

test('forna 2D layout: the node geometry follows the shown dot-bracket of one record, and repeats for the same one', () => {
  const sb = sandbox();                                               // ss.js is loaded whole: real forna2D / ssLayout / _ssCache
  const seq = 'ACGU'.repeat(15);
  const nodes = (svg) => (svg.match(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"/g) || []).map((c) => c.replace(/.*cx="([\d.]+)".*cy="([\d.]+)".*/, '$1,$2'));
  const a = sb.forna2D('rec-1', '((((((((((..........))))))))))' + '.'.repeat(30), seq, null, 340, true);
  const b = sb.forna2D('rec-1', '.'.repeat(30) + '((((((((((..........))))))))))', seq, null, 340, true);
  const a2 = sb.forna2D('rec-1', '((((((((((..........))))))))))' + '.'.repeat(30), seq, null, 340, true);
  assert.equal(nodes(a).length, 60); assert.equal(nodes(b).length, 60);
  assert.notDeepEqual(nodes(a), nodes(b), 'a different dot-bracket under the same id must get its own layout');
  assert.deepEqual(nodes(a2), nodes(a), 'the same dot-bracket reuses the cached layout');
});
