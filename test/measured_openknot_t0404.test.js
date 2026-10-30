'use strict';
// T-0404: the MEASURED OpenKnot scores (ok_overall, ok_crossed, snr -- experimental chemical mapping; today only the
// OpenKnot Round 9 source carries them) as sortable table columns, sort-menu options and numeric filters, kept apart from
// the PREDICTED crossed_frac. Drives the REAL helpers pulled out of web/app.js into a vm with synthetic records (made-up
// ids, no sequences) and reads web/index.html as text.
//
//   node --test test/
//   WEB_DIR=/path/to/base/web node --test test/measured_openknot_t0404.test.js   # RED on a base without T-0404
//   R9_FOLDS=/path/to/live/openknot_r9/data/folds.json node --test test/measured_openknot_t0404.test.js   # + the live-data check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const WEB = process.env.WEB_DIR || path.join(__dirname, '..', 'web');
const APP = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const AGENT = fs.readFileSync(path.join(WEB, 'agent.js'), 'utf8');

// top-level `function name(` of app.js, brace-matched (as in multi_pickers_t0367.test.js)
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
// a top-level `const|let NAME = ...;` that may span lines: cut at the first line that ends the statement with `;`
function declText(name) {
  const m = new RegExp('^(?:const|let) ' + name + ' = ', 'm').exec(APP);
  if (!m) return null;
  const end = /;[ \t]*(?:\/\/[^\n]*)?\n/g; end.lastIndex = m.index;
  const e = end.exec(APP);
  return e ? APP.slice(m.index, e.index + 1) : null;
}
const need = (name, t) => { assert.ok(t, name + ' not found in app.js'); return t; };

// filter config as filters() would return it with every control at its default (search empty, sliders at their minimum)
function baseCfg(over) {
  return Object.assign({ q: '', lmin: 0, lmax: 2000, plddt: 0, clash: 9999, tmax: 1, tmhas: false, novelOnly: false, ovmax: 1,
    shape: false, agr: -1, crmin: 0, bpmin: 0, cfmin: 0, okovMin: 0, okcrMin: 0, snrMin: -1, foldMin: 0, sclustMin: 0,
    tert: false, rare: false, motifs: [], motifMode: 'any', pk: 'any', sublibOff: new Set(), letters: new Set(), cond: new Set(),
    termini: 'any', ohmax: Infinity, uucg: false, rank: 'best_tm1:asc', topn: 200, perLetter: false }, over || {});
}
// synthetic records: a measured design, one without any measurement, one with overall+SNR but no crossed score (its
// target has crossed pairs that were not scored), and a plain fold from another atlas (predicted crossed_frac only)
const R = {
  hi: { id: 'd-0001', _dsid: 'mx', _uid: 'mx|d-0001', length: 240, ok_overall: 92.9, ok_crossed: 77.8, snr: 20.7, openknot: 85.3, crossed_frac: null },
  lo: { id: 'd-0002', _dsid: 'mx', _uid: 'mx|d-0002', length: 240, ok_overall: 61.5, ok_crossed: 40.0, snr: 0.6, openknot: 50.7, crossed_frac: null },
  neg: { id: 'd-0003', _dsid: 'mx', _uid: 'mx|d-0003', length: 240, ok_overall: 70.0, ok_crossed: 55.0, snr: -0.8, openknot: 62.5, crossed_frac: null },
  none: { id: 'd-0004', _dsid: 'mx', _uid: 'mx|d-0004', length: 240, ok_overall: null, ok_crossed: null, snr: null, openknot: null, crossed_frac: null },
  nocr: { id: 'd-0005', _dsid: 'mx', _uid: 'mx|d-0005', length: 240, ok_overall: 88.0, ok_crossed: null, snr: 9.1, openknot: null, crossed_frac: null },
  plain: { id: 'p-0001', _dsid: 'px', _uid: 'px|p-0001', length: 80, crossed_frac: 0.42, n_tert: 1, n_rare: 0, motifs: [] },
};
const all = () => Object.values(R).map((r) => Object.assign({}, r));

function fakeEl(id) {
  const cls = new Set();
  return { id, innerHTML: '', value: '', textContent: '', style: {}, dataset: {}, hidden: false, disabled: false,
    querySelectorAll: () => [], addEventListener: () => {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => { if (on === undefined) on = !cls.has(c); if (on) cls.add(c); else cls.delete(c); return on; } } };
}
function sandbox() {
  const els = {}, options = [{ className: 'okopt', hidden: false, disabled: false }, { className: 'okopt', hidden: false, disabled: false }, { className: 'okopt', hidden: false, disabled: false }];
  const sb = {
    console, JSON, Math, Number, Array, Object, String, Set, Infinity, parseFloat,
    $: (id) => (els[id] = els[id] || fakeEl(id)),
    document: { querySelectorAll: (sel) => (sel === '#rank_key option.okopt' ? options : []) },
    DSBYID: {}, SUBLIB_OFF: new Set(), motifColor: () => '#888888', openDeep: () => {},
  };
  vm.createContext(sb);
  const parts = [need('esc', declText('esc')), need('num', declText('num')), need('sortOverride', declText('sortOverride')),
    need('FIELD_IDS', declText('FIELD_IDS')), need('COLS', declText('COLS')), need('OK_COLS', declText('OK_COLS')), need('HAS_OK', declText('HAS_OK')),
    need('hasMeasuredOK', declText('hasMeasuredOK')), need('FILTER_MAP', declText('FILTER_MAP')),
    need('cols', fnText('cols')), need('toggleMeasuredOK', fnText('toggleMeasuredOK')), need('pass', fnText('pass')), need('ranker', fnText('ranker')),
    need('drawTable', fnText('drawTable')), need('filters', fnText('filters'))];
  // top-level let/const are not vm-global properties; re-declare as var so the tests can read and set them by name
  vm.runInContext(parts.join('\n').replace(/^(?:let|const) (\w+) = /gm, 'var $1 = '), sb);
  sb._els = els; sb._options = options;
  return sb;
}

test('index.html: three measured-OpenKnot sliders in their own fieldset, hidden until data carries the scores', () => {
  const fs = /<fieldset id="okfilt"[^>]*>([\s\S]*?)<\/fieldset>/.exec(INDEX);
  assert.ok(fs, 'fieldset#okfilt missing');
  assert.match(fs[0], /style="display:none"/, 'the fieldset starts hidden (toggleMeasuredOK shows it)');
  assert.match(fs[1], /<legend[^>]*>Measured OpenKnot<\/legend>/);
  const input = (id) => { const m = new RegExp('<input type="range" id="' + id + '" ([^>]*)>').exec(fs[1]); assert.ok(m, id + ' slider missing'); return m[1]; };
  assert.match(input('okov_min'), /min="0" max="100" value="0" step="1"/);
  assert.match(input('okcr_min'), /min="0" max="100" value="0" step="1"/);
  assert.match(input('snr_min'), /min="-1" max="30" value="-1" step="0\.5"/);   // -1 = any (SNR can be slightly negative)
  assert.match(fs[1], /<span id="snr_min_v">any<\/span>/);
  for (const id of ['okov_min_v', 'okcr_min_v']) assert.match(fs[1], new RegExp('<span id="' + id + '">0</span>'));
});

test('index.html: sort menu gains the three measured keys (desc), the predicted crossed-pairs entry and slider are untouched', () => {
  const sel = /<select id="rank_key">([\s\S]*?)<\/select>/.exec(INDEX)[1];
  for (const k of ['ok_overall', 'ok_crossed', 'snr']) {
    const m = new RegExp('<option value="' + k + ':desc" class="okopt">([^<]*)</option>').exec(sel);
    assert.ok(m, k + ':desc option missing or not class okopt');
    assert.match(m[1], /^measured OpenKnot /, 'label says MEASURED: ' + m[1]);
  }
  assert.match(sel, /<option value="crossed_frac:desc">tertiary complexity \(crossed-pairs\)<\/option>/, 'predicted sort option unchanged');
  assert.match(INDEX, /tertiary \(crossed\) &ge;<\/label><input type="range" id="cf_min" min="0" max="1" value="0" step="0\.01">/, 'predicted slider unchanged');
  assert.equal((sel.match(/class="okopt"/g) || []).length, 3);
});

test('index.html + agent.js: the glossary and the assistant tool text name the measured scores and keep them apart from the prediction', () => {
  const dd = /<dt>Measured OpenKnot \(overall · crossed · SNR\)<\/dt><dd>([\s\S]*?)<\/dd>/.exec(INDEX);
  assert.ok(dd, 'glossary entry missing');
  assert.match(dd[1], /<b>Experimental<\/b>/);
  assert.match(dd[1], /<b>not<\/b> the predicted <i>tertiary complexity \(crossed-pairs\)<\/i>/);
  assert.match(dd[1], /mean of overall and crossed/);
  assert.match(AGENT, /ok_overall_min,ok_crossed_min,snr_min \(measured experimental OpenKnot scores/);
  assert.match(AGENT, /'ok_overall:desc'/);
});

test('FIELD_IDS persists and shares the three sliders; FILTER_MAP exposes them to the assistant', () => {
  const sb = sandbox();
  for (const id of ['okov_min', 'okcr_min', 'snr_min']) assert.ok(sb.FIELD_IDS.includes(id), id + ' not in FIELD_IDS');
  assert.deepEqual([sb.FILTER_MAP.ok_overall_min, sb.FILTER_MAP.ok_crossed_min, sb.FILTER_MAP.snr_min], ['okov_min', 'okcr_min', 'snr_min']);
});

test('filters() reads the sliders; a missing slider reads as "any" (0 / 0 / -1)', () => {
  const sb = sandbox();
  sb._els.okov_min = Object.assign(fakeEl('okov_min'), { value: '80' });
  sb._els.okcr_min = Object.assign(fakeEl('okcr_min'), { value: '65' });
  sb._els.snr_min = Object.assign(fakeEl('snr_min'), { value: '2.5' });
  sb._els.search = Object.assign(fakeEl('search'), { value: '' });
  sb._els.agr_min = Object.assign(fakeEl('agr_min'), { value: '-1' });
  let c = sb.filters();
  assert.deepEqual([c.okovMin, c.okcrMin, c.snrMin], [80, 65, 2.5]);
  const sb2 = sandbox();
  sb2.$ = (id) => (['okov_min', 'okcr_min', 'snr_min'].includes(id) ? null : (sb2._els[id] = sb2._els[id] || fakeEl(id)));
  vm.runInContext('var $ = (id) => (["okov_min","okcr_min","snr_min"].includes(id) ? null : $$(id));', Object.assign(sb2, { $$: sb2.$ }));
  c = sb2.filters();
  assert.deepEqual([c.okovMin, c.okcrMin, c.snrMin], [0, 0, -1]);
});

test('pass(): sliders at their minimum keep every row, measured or not', () => {
  const sb = sandbox(); sb.HAS_OK = true;
  const c = baseCfg();
  for (const f of all()) assert.equal(sb.pass(f, c), true, f.id + ' dropped at the minimum');
});

test('pass(): a raised slider keeps the rows at/above it and drops below-threshold AND unscored rows', () => {
  const sb = sandbox(); sb.HAS_OK = true;
  const ids = (c) => all().filter((f) => sb.pass(f, c)).map((f) => f.id);
  assert.deepEqual(ids(baseCfg({ okovMin: 90 })), ['d-0001']);
  assert.deepEqual(ids(baseCfg({ okovMin: 70 })), ['d-0001', 'd-0003', 'd-0005']);
  assert.deepEqual(ids(baseCfg({ okcrMin: 50 })), ['d-0001', 'd-0003']);            // d-0005 has overall but no crossed score
  assert.deepEqual(ids(baseCfg({ snrMin: 5 })), ['d-0001', 'd-0005']);
  assert.deepEqual(ids(baseCfg({ snrMin: 0 })), ['d-0001', 'd-0002', 'd-0005']);    // 0 is a real threshold: the negative-SNR design goes
  assert.deepEqual(ids(baseCfg({ snrMin: -0.5 })), ['d-0001', 'd-0002', 'd-0005']);
  assert.deepEqual(ids(baseCfg({ okovMin: 60, okcrMin: 40, snrMin: 0.5 })), ['d-0001', 'd-0002']);
  // the predicted crossed_frac filter is a different quantity: it never consults the measured fields
  assert.deepEqual(ids(baseCfg({ cfmin: 0.4 })), ['p-0001']);
});

test('pass(): while no loaded source carries the scores (controls hidden) the measured filters are inert', () => {
  const sb = sandbox(); sb.HAS_OK = false;
  const c = baseCfg({ okovMin: 99, okcrMin: 99, snrMin: 30 });
  for (const f of all()) assert.equal(sb.pass(f, c), true, f.id + ' dropped by a hidden filter');
});

test('ranker(): measured keys sort numerically with unscored rows last in both directions', () => {
  const sb = sandbox();
  const order = (rank) => { sb.sortOverride = null; return all().sort(sb.ranker(baseCfg({ rank }))).map((f) => f.id); };
  assert.deepEqual(order('ok_overall:desc'), ['d-0001', 'd-0005', 'd-0003', 'd-0002', 'd-0004', 'p-0001']);
  assert.deepEqual(order('ok_overall:asc'), ['d-0002', 'd-0003', 'd-0005', 'd-0001', 'd-0004', 'p-0001']);
  assert.deepEqual(order('ok_crossed:desc'), ['d-0001', 'd-0003', 'd-0002', 'd-0004', 'd-0005', 'p-0001']);
  assert.deepEqual(order('snr:desc'), ['d-0001', 'd-0005', 'd-0002', 'd-0003', 'd-0004', 'p-0001']);   // -0.8 sorts below 0.6, not as 0
  assert.deepEqual(order('snr:asc'), ['d-0003', 'd-0002', 'd-0005', 'd-0001', 'd-0004', 'p-0001']);
});

test('cols()/drawTable: the three columns appear right after the predicted "crossed" column only while HAS_OK', () => {
  const sb = sandbox();
  sb.HAS_OK = false;
  assert.deepEqual(Array.from(sb.cols(), (c) => c[0]), Array.from(sb.COLS, (c) => c[0]));   // Array.from: vm arrays have another realm's prototype
  sb.drawTable(all());
  let thead = sb._els.thead.innerHTML, tbody = sb._els.tbody.innerHTML;
  assert.equal((thead.match(/<th /g) || []).length, sb.COLS.length);
  assert.doesNotMatch(thead, /OpenKnot/);
  assert.equal((tbody.match(/<td/g) || []).length, sb.COLS.length * all().length);
  sb.HAS_OK = true;
  const keys = Array.from(sb.cols(), (c) => c[0]);
  const i = keys.indexOf('crossed_frac');
  assert.deepEqual(keys.slice(i, i + 4), ['crossed_frac', 'ok_overall', 'ok_crossed', 'snr']);
  assert.equal(keys.length, sb.COLS.length + 3);
  sb.drawTable(all());
  thead = sb._els.thead.innerHTML; tbody = sb._els.tbody.innerHTML;
  assert.match(thead, /<th data-k="ok_overall" class="" title="MEASURED OpenKnot score, overall[^"]*">OpenKnot overall<\/th>/);
  assert.match(thead, /<th data-k="ok_crossed" class="" title="MEASURED OpenKnot score on the design[^"]*not the predicted crossed-pairs fraction">OpenKnot crossed<\/th>/);
  assert.match(thead, /<th data-k="snr" class="" title="signal-to-noise[^"]*">OpenKnot SNR<\/th>/);
  assert.match(thead, /<th data-k="crossed_frac" class="" title="PREDICTED tertiary complexity[^"]*">crossed<\/th>/, 'the predicted header keeps its label and gains a disambiguating tooltip');
  assert.equal((tbody.match(/<td/g) || []).length, (sb.COLS.length + 3) * all().length);
  // cell formatting = the deep view's "Measured OpenKnot" row: scores 1 decimal, SNR 2 decimals, unscored blank
  const row = (id) => new RegExp('<tr data-id="' + id + '"[\\s\\S]*?</tr>').exec(tbody)[0];
  assert.match(row('d-0001'), /<td class="num"><\/td><td class="num">92\.9<\/td><td class="num">77\.8<\/td><td class="num">20\.70<\/td>/);
  assert.match(row('d-0004'), /<td class="num"><\/td><td class="num"><\/td><td class="num"><\/td><td class="num"><\/td>/);
  assert.match(row('d-0005'), /<td class="num"><\/td><td class="num">88\.0<\/td><td class="num"><\/td><td class="num">9\.10<\/td>/);
  assert.match(row('p-0001'), /<td class="num">0\.42<\/td><td class="num"><\/td><td class="num"><\/td><td class="num"><\/td>/);
});

test('header click on a measured column sorts by it (sortOverride marks the header)', () => {
  const sb = sandbox(); sb.HAS_OK = true;
  sb.sortOverride = { key: 'ok_crossed', dir: 'desc' };
  sb.drawTable(all());
  assert.match(sb._els.thead.innerHTML, /<th data-k="ok_crossed" class="sorted"/);
  const c = baseCfg({ rank: 'best_tm1:asc' });
  assert.deepEqual(all().sort(sb.ranker(c)).map((f) => f.id).slice(0, 3), ['d-0001', 'd-0003', 'd-0002']);
});

test('hasMeasuredOK / toggleMeasuredOK: the fieldset and the sort options follow the loaded data', () => {
  const sb = sandbox();
  assert.equal(sb.hasMeasuredOK([R.plain, R.none]), false);
  assert.equal(sb.hasMeasuredOK([R.plain, R.nocr]), true);
  assert.equal(sb.hasMeasuredOK([{ snr: 3 }]), true);
  sb.HAS_OK = false; sb.toggleMeasuredOK();
  assert.equal(sb._els.okfilt.style.display, 'none');
  assert.ok(sb._options.every((o) => o.hidden && o.disabled));
  sb.HAS_OK = true; sb.toggleMeasuredOK();
  assert.equal(sb._els.okfilt.style.display, '');
  assert.ok(sb._options.every((o) => !o.hidden && !o.disabled));
});

// With R9_FOLDS set, the same code runs over the REAL folds.json (gzip or plain): the column must not come out empty and the
// sliders at their minimum must keep every row, including the unmeasured ones. Skipped when the file is not given.
test('live data: the measured columns are populated and the minimum sliders keep every row', { skip: !process.env.R9_FOLDS && 'set R9_FOLDS=<folds.json>' }, () => {
  let buf = fs.readFileSync(process.env.R9_FOLDS);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const folds = JSON.parse(buf.toString('utf8'));
  folds.forEach((f) => { f._dsid = 'live'; f._uid = 'live|' + f.id; });
  const sb = sandbox();
  assert.equal(sb.hasMeasuredOK(folds), true, 'no row carries a measured score: the column would be empty');
  const nOv = folds.filter((f) => f.ok_overall != null).length, nCr = folds.filter((f) => f.ok_crossed != null).length, nSnr = folds.filter((f) => f.snr != null).length;
  console.log(`live folds=${folds.length} ok_overall=${nOv} ok_crossed=${nCr} snr=${nSnr}`);
  assert.ok(nOv > folds.length * 0.9 && nCr > folds.length * 0.9 && nSnr > folds.length * 0.9, 'coverage below 90%');
  assert.ok(nOv < folds.length, 'the fixture has no unmeasured row, so it cannot show that the minimum keeps them');
  sb.HAS_OK = true;
  assert.equal(folds.filter((f) => sb.pass(f, baseCfg())).length, folds.length, 'a minimum slider dropped rows');
  const kept = folds.filter((f) => sb.pass(f, baseCfg({ okovMin: 90 })));
  assert.ok(kept.length > 0 && kept.every((f) => f.ok_overall >= 90));
  console.log(`live ok_overall>=90: ${kept.length}`);
  const sorted = folds.slice().sort(sb.ranker(baseCfg({ rank: 'ok_overall:desc' })));
  assert.equal(sorted[0].ok_overall, Math.max(...folds.map((f) => f.ok_overall).filter((v) => v != null)));
  assert.equal(sorted[sorted.length - 1].ok_overall, null, 'unscored rows sort last');
});
