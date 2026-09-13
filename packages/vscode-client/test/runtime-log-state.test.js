/**
 * Seam 1 of ticket 01 (.scratch/inline-runtime-log/issues/01-vscode-client-v1.md): the pure
 * per-line-latest-value state a `RuntimeLogState` keeps as `ejsng/runtimeLog` notifications
 * arrive — no `vscode` import, so no Extension Host needed to test it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { RuntimeLogState } = require('../out/runtime-log-state');

test('RuntimeLogState: recording an entry for a fresh file returns just that entry', () => {
  const state = new RuntimeLogState();
  const entries = state.record('file:///app.js', { line: 1, character: 8, value: 'hello' });
  assert.deepStrictEqual(entries, [{ line: 1, character: 8, value: 'hello' }]);
});

test('RuntimeLogState: a second hit on the same line overwrites the first — latest value wins, no history', () => {
  const state = new RuntimeLogState();
  state.record('file:///app.js', { line: 1, character: 8, value: 'first' });
  const entries = state.record('file:///app.js', { line: 1, character: 8, value: 'second' });
  assert.deepStrictEqual(entries, [{ line: 1, character: 8, value: 'second' }]);
});

test('RuntimeLogState: hits on different lines of the same file both appear, keyed by line', () => {
  const state = new RuntimeLogState();
  state.record('file:///app.js', { line: 1, character: 8, value: 'a' });
  const entries = state.record('file:///app.js', { line: 4, character: 2, value: 'b' });
  assert.deepStrictEqual(entries.sort((x, y) => x.line - y.line), [
    { line: 1, character: 8, value: 'a' },
    { line: 4, character: 2, value: 'b' },
  ]);
});

test('RuntimeLogState: entriesFor a file with no recorded hits is empty — nothing to redraw', () => {
  const state = new RuntimeLogState();
  assert.deepStrictEqual(state.entriesFor('file:///never-seen.js'), []);
});

test('RuntimeLogState: entriesFor returns what was recorded, without needing a new record() call', () => {
  const state = new RuntimeLogState();
  state.record('file:///app.js', { line: 1, character: 8, value: 'hello' });
  assert.deepStrictEqual(state.entriesFor('file:///app.js'), [{ line: 1, character: 8, value: 'hello' }]);
});

test('RuntimeLogState: clear drops all entries for a file — e.g. the target process restarted', () => {
  const state = new RuntimeLogState();
  state.record('file:///app.js', { line: 1, character: 8, value: 'hello' });
  state.clear('file:///app.js');
  assert.deepStrictEqual(state.entriesFor('file:///app.js'), []);
});

test("RuntimeLogState: clear only affects the file it's given, not other files", () => {
  const state = new RuntimeLogState();
  state.record('file:///app.js', { line: 1, character: 8, value: 'hello' });
  state.record('file:///other.js', { line: 2, character: 0, value: 'still here' });
  state.clear('file:///app.js');
  assert.deepStrictEqual(state.entriesFor('file:///other.js'), [{ line: 2, character: 0, value: 'still here' }]);
});
