/**
 * Seam 1 of ticket 01 (.scratch/inline-runtime-log/issues/01-vscode-client-v1.md): the pure
 * per-line-latest-value state a `RuntimeLogState` keeps as `ejsng/runtimeLog` notifications
 * arrive — no `vscode` import, so no Extension Host needed to test it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { RuntimeLogState, summarizeRuntimeStatus, formatRuntimeStatusBarText } = require('../out/runtime-log-state');

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

/**
 * summarizeRuntimeStatus / formatRuntimeStatusBarText (ticket 02, item 4): the status bar and
 * panel must show "received / drawn / dropped" instead of just a connection count, and the
 * REAL connecting/connected/failed state instead of trusting connectRuntime's back-compat,
 * always-optimistic 'connected' response.
 */
test('summarizeRuntimeStatus: an empty connection list summarizes to all zeros', () => {
  assert.deepStrictEqual(summarizeRuntimeStatus([]), {
    received: 0,
    drawn: 0,
    dropped: 0,
    connecting: 0,
    connected: 0,
    failed: 0,
  });
});

test('summarizeRuntimeStatus: sums received/drawn across connections, and dropped across every reason of every connection', () => {
  const connections = [
    { key: 'a', state: 'connected', received: 10, drawn: 7, droppedByReason: { 'outside-workspace': 2, 'no-stack-trace': 1 } },
    { key: 'b', state: 'connected', received: 5, drawn: 5, droppedByReason: {} },
  ];
  assert.deepStrictEqual(summarizeRuntimeStatus(connections), {
    received: 15,
    drawn: 12,
    dropped: 3,
    connecting: 0,
    connected: 2,
    failed: 0,
  });
});

test('summarizeRuntimeStatus: counts connections by state, including connecting and failed', () => {
  const connections = [
    { key: 'a', state: 'connecting', received: 0, drawn: 0, droppedByReason: {} },
    { key: 'b', state: 'connected', received: 1, drawn: 1, droppedByReason: {} },
    { key: 'c', state: 'failed', reason: 'ECONNREFUSED', received: 0, drawn: 0, droppedByReason: {} },
  ];
  const summary = summarizeRuntimeStatus(connections);
  assert.deepStrictEqual([summary.connecting, summary.connected, summary.failed], [1, 1, 1]);
});

test('formatRuntimeStatusBarText: no connections at all reads "off"', () => {
  assert.strictEqual(
    formatRuntimeStatusBarText(0, { received: 0, drawn: 0, dropped: 0, connecting: 0, connected: 0, failed: 0 }),
    'EJS/NG Runtime: off',
  );
});

test('formatRuntimeStatusBarText: a live connection shows received/drawn/dropped, not just a count', () => {
  const text = formatRuntimeStatusBarText(1, { received: 120, drawn: 34, dropped: 86, connecting: 0, connected: 1, failed: 0 });
  assert.strictEqual(text, 'EJS/NG Runtime: received 120 / drawn 34 / dropped 86');
});

test('formatRuntimeStatusBarText: a still-connecting connection is flagged, not silently shown as if it were live', () => {
  const text = formatRuntimeStatusBarText(1, { received: 0, drawn: 0, dropped: 0, connecting: 1, connected: 0, failed: 0 });
  assert.match(text, /connecting/);
});

test('formatRuntimeStatusBarText: a failed connection is flagged, not silently shown as if it were live', () => {
  const text = formatRuntimeStatusBarText(1, { received: 0, drawn: 0, dropped: 0, connecting: 0, connected: 0, failed: 1 });
  assert.match(text, /failed/);
});
