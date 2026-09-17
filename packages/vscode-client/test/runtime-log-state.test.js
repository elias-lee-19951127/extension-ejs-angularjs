/**
 * Seam 1 of ticket 01 (.scratch/inline-runtime-log/issues/01-vscode-client-v1.md): the pure
 * per-line-latest-value state a `RuntimeLogState` keeps as `ejsng/runtimeLog` notifications
 * arrive — no `vscode` import, so no Extension Host needed to test it.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  RuntimeLogState,
  summarizeRuntimeStatus,
  formatRuntimeStatusBarText,
  formatSkipReason,
  formatWrapperSuggestionText,
  escapeGlobPath,
} = require('../out/runtime-log-state');

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
    recentLogs: [],
    wrapperSuggestion: null,
    outsideWorkspaceDirs: [],
    urlMappings: [],
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
    recentLogs: [],
    wrapperSuggestion: null,
    outsideWorkspaceDirs: [],
    urlMappings: [],
  });
});

/**
 * recentLogs/wrapperSuggestion (ticket 03, .scratch/runtime-remote-env/issues/03-chon-frame.md,
 * items 6-7): purely additive fields on the same `ejsng/runtimeStatus` per-connection object.
 */
test('summarizeRuntimeStatus: merges recentLogs across every connection', () => {
  const logA = { frames: [], chosenPath: 'a.js', at: 100 };
  const logB = { frames: [], chosenPath: 'b.js', at: 200 };
  const connections = [
    { key: 'a', state: 'connected', received: 1, drawn: 1, droppedByReason: {}, recentLogs: [logA], wrapperSuggestion: null },
    { key: 'b', state: 'connected', received: 1, drawn: 1, droppedByReason: {}, recentLogs: [logB], wrapperSuggestion: null },
  ];
  assert.deepStrictEqual(summarizeRuntimeStatus(connections).recentLogs, [logA, logB]);
});

test('summarizeRuntimeStatus: caps merged recentLogs to the most recent few, even across several connections', () => {
  const logs = Array.from({ length: 4 }, (_, i) => ({ frames: [], chosenPath: `f${i}.js`, at: i }));
  const connections = [
    { key: 'a', state: 'connected', received: 4, drawn: 4, droppedByReason: {}, recentLogs: logs.slice(0, 2), wrapperSuggestion: null },
    { key: 'b', state: 'connected', received: 4, drawn: 4, droppedByReason: {}, recentLogs: logs.slice(2), wrapperSuggestion: null },
  ];
  // MAX_SUMMARY_RECENT_LOGS is 5 — a 4-log merge fits, so this proves the cap doesn't trim early
  // when nothing needs trimming. The cap itself is exercised by a larger fixture below.
  assert.strictEqual(summarizeRuntimeStatus(connections).recentLogs.length, 4);

  const many = [
    {
      key: 'a',
      state: 'connected',
      received: 8,
      drawn: 8,
      droppedByReason: {},
      recentLogs: Array.from({ length: 8 }, (_, i) => ({ frames: [], chosenPath: 'x.js', at: i })),
      wrapperSuggestion: null,
    },
  ];
  assert.strictEqual(summarizeRuntimeStatus(many).recentLogs.length, 5);
});

/**
 * The bug this guards against: with several LIVE runtime connections (ticket 02a supports
 * more than one at once), naively concatenating each connection's recentLogs and slicing from
 * the end would keep whichever connection happens to be iterated last, not whichever entries are
 * actually most recent — e.g. an OLDER log from a connection iterated later could survive the cap
 * while a NEWER log from a connection iterated earlier gets dropped. Sorting by `at` before
 * capping (summarizeRuntimeStatus) fixes this.
 */
test('summarizeRuntimeStatus: keeps the chronologically most-recent entries across connections, not just the last-iterated connection\'s', () => {
  const connections = [
    // Connection 'a' is iterated FIRST but has the NEWER timestamps.
    {
      key: 'a',
      state: 'connected',
      received: 3,
      drawn: 3,
      droppedByReason: {},
      recentLogs: [
        { frames: [], chosenPath: 'newest.js', at: 300 },
        { frames: [], chosenPath: 'newer.js', at: 200 },
      ],
      wrapperSuggestion: null,
    },
    // Connection 'b' is iterated LAST but has the OLDER timestamps.
    {
      key: 'b',
      state: 'connected',
      received: 1,
      drawn: 1,
      droppedByReason: {},
      recentLogs: [{ frames: [], chosenPath: 'oldest.js', at: 100 }],
      wrapperSuggestion: null,
    },
  ];
  // Every entry fits under MAX_SUMMARY_RECENT_LOGS (5), so this checks ORDER: oldest -> newest.
  const paths = summarizeRuntimeStatus(connections).recentLogs.map((l) => l.chosenPath);
  assert.deepStrictEqual(paths, ['oldest.js', 'newer.js', 'newest.js']);
});

test('summarizeRuntimeStatus: reports the STRONGEST wrapper suggestion (highest share) across connections', () => {
  const connections = [
    { key: 'a', state: 'connected', received: 1, drawn: 1, droppedByReason: {}, recentLogs: [], wrapperSuggestion: { path: 'weak.js', share: 0.6 } },
    { key: 'b', state: 'connected', received: 1, drawn: 1, droppedByReason: {}, recentLogs: [], wrapperSuggestion: { path: 'strong.js', share: 0.9 } },
  ];
  assert.deepStrictEqual(summarizeRuntimeStatus(connections).wrapperSuggestion, { path: 'strong.js', share: 0.9 });
});

test('summarizeRuntimeStatus: no connection has a suggestion -> null, not undefined or a stray object', () => {
  const connections = [{ key: 'a', state: 'connected', received: 1, drawn: 1, droppedByReason: {}, recentLogs: [], wrapperSuggestion: null }];
  assert.strictEqual(summarizeRuntimeStatus(connections).wrapperSuggestion, null);
});

test('formatSkipReason: a chosen frame reads "chosen"', () => {
  assert.strictEqual(formatSkipReason({ url: '/a.js', lineNumber: 0, columnNumber: 0, skipReason: null }), 'chosen');
});

test('formatSkipReason: a pattern-skipped frame names the matched pattern', () => {
  const entry = { url: '/app/node_modules/x.js', lineNumber: 0, columnNumber: 0, skipReason: 'skip-pattern', matchedPattern: '**/node_modules/**' };
  assert.match(formatSkipReason(entry), /\*\*\/node_modules\/\*\*/);
});

test('formatSkipReason: an obfuscated frame explains why, without needing a matched pattern', () => {
  assert.match(formatSkipReason({ url: '/bundle.min.js', lineNumber: 0, columnNumber: 0, skipReason: 'obfuscated' }), /minified|obfuscated/);
});

test('formatSkipReason: outside-workspace and unreadable-file each get their own distinct explanation', () => {
  const outside = formatSkipReason({ url: '/elsewhere.js', lineNumber: 0, columnNumber: 0, skipReason: 'outside-workspace' });
  const unreadable = formatSkipReason({ url: '/gone.js', lineNumber: 0, columnNumber: 0, skipReason: 'unreadable-file' });
  assert.notStrictEqual(outside, unreadable);
  assert.match(outside, /workspace/);
  assert.match(unreadable, /readable|read/);
});

test('formatWrapperSuggestionText: names the file and its share as a percentage', () => {
  assert.strictEqual(
    formatWrapperSuggestionText({ path: 'shared/log.js', share: 0.85 }),
    '"shared/log.js" accounts for 85% of recent logs — looks like a wrapper.',
  );
});

/**
 * escapeGlobPath (ticket 03, item 7): the "Skip this file" pattern is built from a real
 * workspace-relative path, which can legitimately contain glob-special characters — those must
 * be escaped so the saved skipFrames pattern still matches the literal file, not something else.
 */
test('escapeGlobPath: an ordinary path is left untouched', () => {
  assert.strictEqual(escapeGlobPath('src/utils/log.js'), 'src/utils/log.js');
});

test('escapeGlobPath: parentheses, brackets, and a leading bang are escaped', () => {
  assert.strictEqual(escapeGlobPath('src/(shared)/log.js'), 'src/\\(shared\\)/log.js');
  assert.strictEqual(escapeGlobPath('lib/[legacy]/wrap.js'), 'lib/\\[legacy\\]/wrap.js');
  assert.strictEqual(escapeGlobPath('!important/log.js'), '\\!important/log.js');
});

test('escapeGlobPath: star and question-mark wildcards are escaped', () => {
  assert.strictEqual(escapeGlobPath('a*b?c.js'), 'a\\*b\\?c.js');
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

/**
 * Ticket 08, item 4 (.scratch/runtime-remote-env/issues/08-log-ngoai-workspace.md): directories
 * logs are drawn in that aren't part of the workspace, merged across connections so the panel
 * offers each one once. Suggestions only — nothing here adds a folder.
 */
test('summarizeRuntimeStatus: outside-the-workspace directories are merged and de-duplicated across connections', () => {
  const connections = [
    { key: 'a', state: 'connected', received: 1, drawn: 1, droppedByReason: {}, outsideWorkspaceDirs: ['/host/aocs/utility'] },
    {
      key: 'b',
      state: 'connected',
      received: 1,
      drawn: 1,
      droppedByReason: {},
      outsideWorkspaceDirs: ['/host/aocs/utility', '/host/other/src'],
    },
  ];
  assert.deepStrictEqual(summarizeRuntimeStatus(connections).outsideWorkspaceDirs, ['/host/aocs/utility', '/host/other/src']);
});

test('summarizeRuntimeStatus: a connection from an older server with no outsideWorkspaceDirs field is fine', () => {
  const connections = [{ key: 'a', state: 'connected', received: 1, drawn: 1, droppedByReason: {} }];
  assert.deepStrictEqual(summarizeRuntimeStatus(connections).outsideWorkspaceDirs, []);
});

/**
 * Ticket 07, item 4 (.scratch/runtime-remote-env/issues/07-khop-duoi-url-trinh-duyet.md): URL
 * mappings the server worked out by suffix matching, offered to the panel for saving. Merged
 * across connections so the same discovery isn't offered twice.
 */
test('summarizeRuntimeStatus: URL mappings are merged and de-duplicated across connections', () => {
  const mapping = { remote: 'http://localhost:5000', local: '/ws/public' };
  const connections = [
    { key: 'a', state: 'connected', received: 1, drawn: 1, droppedByReason: {}, urlMappings: [mapping] },
    {
      key: 'b',
      state: 'connected',
      received: 1,
      drawn: 1,
      droppedByReason: {},
      urlMappings: [mapping, { remote: 'http://localhost:5001', local: '/ws/admin' }],
    },
  ];
  assert.deepStrictEqual(summarizeRuntimeStatus(connections).urlMappings, [
    mapping,
    { remote: 'http://localhost:5001', local: '/ws/admin' },
  ]);
});

test('formatSkipReason: an ambiguous URL match names the files it was torn between', () => {
  const text = formatSkipReason({
    url: 'http://localhost:5000/index.js',
    lineNumber: 0,
    columnNumber: 0,
    skipReason: 'ambiguous-url-match',
    candidates: ['public/a/index.js', 'public/b/index.js'],
  });
  assert.ok(text.includes('public/a/index.js'));
  assert.ok(text.includes('public/b/index.js'));
});
