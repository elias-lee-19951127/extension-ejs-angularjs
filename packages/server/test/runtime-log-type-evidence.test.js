/**
 * observed-types-r1 ticket 03: logs of scope variables become runtime Type Evidence on their
 * connection — end to end over LSP against a REAL `node --inspect`, so the values, previews and
 * `Runtime.getProperties` answers are V8's own. The digging budget and the store's rules are
 * covered in packages/core/test/runtime-evidence.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

async function startServer(t, root, initializationOptions = undefined) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  const runtimeLogs = [];
  conn.onNotification('ejsng/runtimeLog', (p) => runtimeLogs.push(p));
  conn.onNotification(() => {});
  conn.onRequest(() => null);
  conn.listen();
  t.after(async () => {
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    const fallback = setTimeout(() => child.kill(), 3000);
    try {
      await Promise.race([conn.sendRequest('shutdown'), exited]);
      conn.sendNotification('exit');
    } catch {
      /* already shut down */
    }
    await exited;
    clearTimeout(fallback);
    conn.dispose();
  });
  const rootUri = pathToFileURL(root).href;
  await conn.sendRequest('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'tmp' }],
    capabilities: {},
    initializationOptions,
  });
  conn.sendNotification('initialized', {});
  await conn.sendRequest('ejsng/stats');
  return { conn, runtimeLogs };
}

async function waitForStatus(conn, predicate, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const status = await conn.sendRequest('ejsng/runtimeStatus');
    if (predicate(status)) return status;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; last status: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function waitFor(predicate, what, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startInspectedNode(t, cwd, entry) {
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', entry], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
      const m = /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', () => reject(new Error(`node exited early: ${stderr}`)));
  });
  return { child, port };
}

// A controller the index recognises, run by a stand-in `angular` so plain Node can execute it.
const CONTROLLER = [
  'var angular = { module: function () { return { controller: function (n, f) { f.call({}, {}); return this; } }; } };',
  "angular.module('app', []).controller('ListCtrl', function ($scope) {",
  '  var vm = this;',
  '  var n = 0;',
  '  setInterval(function () {',
  '    n++;',
  "    $scope.rows = [{ id: n, name: 'x', owner: { id: 1, name: 'o' } }];",
  "    console.log('rows', $scope.rows, n);",
  "    vm.form = { title: 't' + n };",
  '    n = n + 0;', // line 9: the logpoint's line, after `vm.form` is set
  '  }, 40);',
  '});',
  '',
].join('\n');

test('LSP + real node --inspect: a console.log and a logpoint of scope variables become type evidence, once per distinct type', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-type-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'list.controller.js'), CONTROLLER);

  const { child, port } = await startInspectedNode(t, root, 'list.controller.js');
  const { conn, runtimeLogs } = await startServer(t, root);
  conn.sendNotification('ejsng/setLogpoints', {
    logpoints: [{ uri: pathToFileURL(join(root, 'list.controller.js')).href, line: 9, logMessage: 'form = {vm.form}, n = {n}' }],
  });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port });
  assert.strictEqual(result.status, 'connected');

  // `$scope.rows` (console.log) and `vm.form` (logpoint): two variables, one type each. `n` — a
  // local, in both — is never evidence.
  await waitForStatus(conn, (s) => s.connections[0]?.typeEvidence === 2);
  const drawnBefore = runtimeLogs.length;
  await waitForStatus(conn, () => runtimeLogs.length >= drawnBefore + 10);
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  assert.strictEqual(status.connections[0].typeEvidence, 2, 'the same types logged again are counted, not added');
  // Logs keep drawing exactly as before.
  assert.ok(runtimeLogs.some((l) => /^rows \[.+\] \d+$/.test(l.value)), JSON.stringify(runtimeLogs.slice(0, 2)));
  assert.ok(runtimeLogs.some((l) => /^form = \{title: t\d+\}, n = \d+$/.test(l.value)));

  // The runtime going away takes its evidence with it.
  child.kill();
  await waitForStatus(conn, (s) => s.connections[0]?.state === 'failed');
  assert.strictEqual((await conn.sendRequest('ejsng/runtimeStatus')).connections[0].typeEvidence, 0);
});

function positionOf(text, needle, offset = 0) {
  const idx = text.indexOf(needle);
  assert.notStrictEqual(idx, -1, `${needle} not found`);
  const before = text.slice(0, idx + offset);
  const line = before.split('\n').length - 1;
  return { line, character: before.length - before.lastIndexOf('\n') - 1 };
}

// Values no assignment can type: they come from a function call. Only the runtime can say.
const LOADING_CONTROLLER = [
  'var angular = { module: function () { return { controller: function (n, f) { f.call({}, {}); return this; } }; } };',
  "function load(n) { return [{ id: n, name: 'x', owner: { id: 1, name: 'o' } }]; }",
  "function find(n) { return n % 2 ? { title: 't' } : null; }",
  "angular.module('app', []).controller('ListCtrl', function ($scope) {",
  '  var n = 0;',
  '  $scope.rows = [];',
  '  setInterval(function () {',
  '    n++;',
  '    $scope.rows = load(n);',
  '    $scope.sel = find(n);',
  '    console.log($scope.rows, $scope.sel);',
  '  }, 40);',
  '});',
  '',
].join('\n');

test('LSP + real node --inspect: hover merges what the runtime logged, says where and when; the inline hint does not move', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-type-hover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'list.controller.js'), LOADING_CONTROLLER);
  const html = '<ul ng-controller="ListCtrl"><li ng-repeat="row in rows">{{ row.owner.name }}</li>{{ sel.title }}</ul>\n';
  writeFileSync(join(root, 'list.html'), html);

  const { child, port } = await startInspectedNode(t, root, 'list.controller.js');
  const { conn } = await startServer(t, root);
  const uri = pathToFileURL(join(root, 'list.html')).href;
  conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'html', version: 1, text: html } });
  const hover = (needle, offset = 0) =>
    conn.sendRequest('textDocument/hover', { textDocument: { uri }, position: positionOf(html, needle, offset) }).then((h) => h.contents.value);
  const hints = () => conn.sendRequest('textDocument/inlayHint', { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } });

  const before = await hover('rows">');
  assert.match(before, /```ts\nunknown\[\]\n```/, before);
  assert.match(before, /_Some assignments could not be inferred and are left out:_ `load\(n\)`/, before);
  assert.doesNotMatch(before, /Seen at runtime/, before);
  const hintsBefore = await hints();

  assert.strictEqual((await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port })).status, 'connected');
  await waitForStatus(conn, (s) => s.connections[0]?.typeEvidence >= 3); // rows, sel as object, sel as null

  const rows = await hover('rows">');
  assert.match(rows, /```ts\n\{ id: number, name: string, owner: \{ id: number, name: string \} \}\[\]\n```/, rows);
  assert.match(rows, /_Not inferred statically_ \(`load\(n\)` \(\[list\.controller\.js:9\]\(\S*#L9\)\)\) _— shape from runtime_/, rows);
  assert.match(rows, /_Seen at runtime:_ \d+× — last \d\d:\d\d:\d\d via `[^`]+`, logged at \[list\.controller\.js:11\]\(\S*#L11\)/, rows);
  assert.match(await hover('name }}'), /```ts\nstring\n```/);

  const sel = await hover('sel.title');
  assert.match(sel, /```ts\n\{ title: string \} \| null\n```/, sel);
  assert.match(sel, /_Seen `null`\/`undefined` at runtime_/, sel);
  assert.doesNotMatch(sel, /_Can be empty when rendered_/, sel);
  assert.deepStrictEqual(await hints(), hintsBefore, 'runtime evidence never adds an inline hint');

  // The runtime going away takes its part of the hover with it.
  child.kill();
  await waitForStatus(conn, (s) => s.connections[0]?.state === 'failed');
  assert.strictEqual(await hover('rows">'), before);
});

// log-variable ticket 02: the assignment lives in a one-line callback — the line starts OUTSIDE it.
const ONE_LINER = [
  'var angular = { module: function () { return { controller: function (n, f) { f.call({}, {}); return this; } }; } };',
  'function load(n, cb) { cb({ data: [{ id: n }] }); }',
  "angular.module('app', []).controller('ListCtrl', function ($scope) {",
  '  var n = 0;',
  '  setInterval(function () { n++; load(n, function (res) { $scope.rows = res.data; }); }, 40);',
  '});',
  '',
].join('\n');

test('LSP + real node --inspect: a logpoint at a column right after an assignment in a one-line function logs the new value', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-column-logpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'list.controller.js'), ONE_LINER);

  const { port } = await startInspectedNode(t, root, 'list.controller.js');
  const { conn, runtimeLogs } = await startServer(t, root);
  const at = positionOf(ONE_LINER, 'res.data;', 'res.data;'.length);
  conn.sendNotification('ejsng/setLogpoints', {
    logpoints: [{ uri: pathToFileURL(join(root, 'list.controller.js')).href, line: at.line, character: at.character, logMessage: 'rows = {$scope.rows}' }],
  });
  assert.strictEqual((await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port })).status, 'connected');

  await waitForStatus(conn, (s) => s.connections[0]?.typeEvidence === 1);
  await waitForStatus(conn, () => runtimeLogs.filter((l) => l.value.startsWith('rows = ')).length >= 3);
  const values = runtimeLogs.filter((l) => l.value.startsWith('rows = ')).map((l) => l.value);
  // Before the assignment it would be `undefined` on the first run; after it, always the array.
  assert.ok(values.every((v) => v !== 'rows = undefined'), values.join(' | '));
  assert.strictEqual(runtimeLogs.find((l) => l.value.startsWith('rows = ')).range.start.line, at.line);

  // `$scope` resolved at the column (inside the callback), so it became evidence for `rows`.
  const uri = pathToFileURL(join(root, 'list.controller.js')).href;
  conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text: ONE_LINER } });
  const hover = await conn.sendRequest('textDocument/hover', { textDocument: { uri }, position: positionOf(ONE_LINER, 'rows = res', 1) });
  assert.match(hover.contents.value, /```ts\n\{ id: number \}\[\]\n```/, hover.contents.value);
});

// ---------------------------------------------------------------- expand-log-values ticket 02

const LOOPING = [
  'var rows = Array.from({ length: 150 }, function (_, i) { return { id: i, title: "Sensor " + i, owner: { id: 7, name: "ops" } }; });',
  'setInterval(function () {',
  '  console.log("rows", rows);',
  '}, 30);',
  '',
].join('\n');

async function startWithLogs(t, root, options) {
  writeFileSync(join(root, 'loop.js'), LOOPING);
  const { port } = await startInspectedNode(t, root, 'loop.js');
  const { conn, runtimeLogs } = await startServer(t, root, options);
  const expanded = [];
  conn.onNotification('ejsng/runtimeLogExpanded', (p) => expanded.push(p));
  assert.strictEqual((await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port })).status, 'connected');
  return { conn, runtimeLogs, expanded };
}

test('LSP + real node --inspect: a logged array of objects is expanded into readable text, without delaying the log', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-expand-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtimeLogs, expanded } = await startWithLogs(t, root);

  await waitFor(() => expanded.length > 0, 'the expanded rendering');
  // The log itself was drawn first, unexpanded. (V8 replays the console entries buffered before
  // the client attached, and a replayed one carries no preview at all — hence `Array(150)` there.)
  const drawn = runtimeLogs.find((l) => l.logId === expanded[0].logId);
  assert.ok(drawn, 'the expansion belongs to a log that was already drawn');
  assert.match(drawn.value, /^rows (\[Object|Array\(150\))/, drawn.value);

  const first = expanded[0];
  assert.doesNotMatch(first.inline, /\bObject\b/, first.inline);
  assert.match(first.inline, /^rows \[\{id: 0, title: 'Sensor 0', owner: \{…\}\}/, first.inline);
  assert.ok(first.inline.length <= 210, `${first.inline.length} characters`);
  assert.match(first.expanded, /owner: \{\n\s+id: 7,\n\s+name: 'ops'\n\s+\}/, first.expanded);
});

test('LSP + real node --inspect: logging in a loop is rate limited per line, and the setting turns it off', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-expand-rate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtimeLogs, expanded } = await startWithLogs(t, root);

  await waitFor(() => runtimeLogs.length >= 30, 'plenty of logs from the same line');
  // ~30 logs/second from one line over ~1 s: at one dig per 300 ms, a handful of expansions.
  assert.ok(expanded.length <= 1 + Math.ceil(runtimeLogs.length / 9), `${expanded.length} expansions for ${runtimeLogs.length} logs`);

  const off = mkdtempSync(join(tmpdir(), 'ejsng-expand-off-'));
  t.after(() => rmSync(off, { recursive: true, force: true }));
  const quiet = await startWithLogs(t, off, { runtimeLog: { expandValues: false } });
  await waitFor(() => quiet.runtimeLogs.length >= 5, 'logs with expanding turned off');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepStrictEqual(quiet.expanded, []);
  assert.strictEqual(quiet.runtimeLogs[0].logId, undefined, 'nothing to ask to expand');
});

test('LSP + real node --inspect: ejsng/expandRuntimeLog digs the whole value as JSON, and says when the runtime lost it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-expand-full-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { conn, runtimeLogs, expanded } = await startWithLogs(t, root);
  await waitFor(() => expanded.length > 0, 'a log whose value the server still holds');

  const logId = expanded[0].logId;
  const full = await conn.sendRequest('ejsng/expandRuntimeLog', { logId });
  assert.strictEqual(full.stale, false);
  const parsed = JSON.parse(full.json);
  assert.ok(Array.isArray(parsed), 'two arguments: the label and the array');
  assert.strictEqual(parsed[0], 'rows');
  assert.strictEqual(parsed[1].length, 150, 'every element, not a sample');
  assert.deepStrictEqual(parsed[1][149], { id: 149, title: 'Sensor 149', owner: { id: 7, name: 'ops' } });
  // Deeper than what was dug at draw time: `owner` is an object there, not "[not expanded]".
  const drawn = runtimeLogs.find((l) => l.logId === logId);
  assert.ok(drawn);

  const unknown = await conn.sendRequest('ejsng/expandRuntimeLog', { logId: 999999 });
  assert.deepStrictEqual(unknown, { json: 'null', stale: true });
});
