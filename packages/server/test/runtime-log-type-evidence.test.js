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

async function startServer(t, root) {
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
