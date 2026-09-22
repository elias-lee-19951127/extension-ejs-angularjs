/**
 * The Runtime Values panel's rows: every logged line, newest first, and the hits of one line —
 * worked out from `RuntimeLogState` without an Extension Host.
 */
const test = require('node:test');
const assert = require('node:assert');
const { RuntimeLogState } = require('../out/runtime-log-state');
const V = require('../out/runtime-values');

const entry = (line, value, at, extra = {}) => ({ line, character: 0, value, severity: 'log', source: 'node 127.0.0.1:9229', at, ...extra });

test('a site id carries its line and a URI with anything in it', () => {
  const uri = 'file:///a/b@c/x.js';
  assert.deepStrictEqual(V.parseSiteId(V.siteId(uri, 41)), { uri, line: 41 });
  assert.strictEqual(V.parseSiteId('nope'), null);
  assert.strictEqual(V.parseSiteId('-1@file:///x.js'), null);
});

test('every logged line is listed, most recently hit first, 1-based, with its latest value on one line', () => {
  const state = new RuntimeLogState();
  state.record('file:///w/a.js', entry(9, 'old', 1000));
  state.record('file:///w/b.js', entry(2, '{\n  id: 1\n}', 3000, { severity: 'error' }));
  state.record('file:///w/a.js', entry(9, 'new', 2000, { inline: 'new (expanded)' }));
  const rows = V.valueSites(state, (uri) => uri.replace('file:///w/', ''));
  assert.deepStrictEqual(
    rows.map((r) => [r.file, r.line, r.severity, r.count, r.preview]),
    [
      ['b.js', 3, 'error', 1, '{ id: 1 }'],
      ['a.js', 10, 'log', 2, 'new (expanded)'],
    ],
  );
});

test('the hits of a line: most recent first, with how many were counted but not kept', () => {
  const state = new RuntimeLogState();
  for (let i = 0; i < 12; i++) state.record('file:///w/a.js', entry(0, `v${i}`, i * 1000));
  const [line] = state.linesFor('file:///w/a.js');
  const { hits, dropped } = V.valueHits(line);
  assert.strictEqual(hits.length, 10);
  assert.strictEqual(hits[0].preview, 'v11');
  assert.strictEqual(dropped, 2);
});

test('Clear forgets every file and names them, so their decorations can be redrawn empty', () => {
  const state = new RuntimeLogState();
  state.record('file:///w/a.js', entry(0, 'x', 1));
  state.record('file:///w/b.js', entry(0, 'y', 2));
  assert.deepStrictEqual(state.clearAll().sort(), ['file:///w/a.js', 'file:///w/b.js']);
  assert.deepStrictEqual(state.files(), []);
});
