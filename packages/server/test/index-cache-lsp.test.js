/**
 * The LSP server writes the index cache on `shutdown`, so the IDE's next start is warm — before,
 * only the CLI wrote it (docs/kien-truc.md J.6) and every IDE start re-parsed every file. The
 * cache directory ignores itself, so it never shows up in the user's `git status`.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

/** Start the server on `root`, wait for indexing, shut it down cleanly; return its log lines. */
async function runOnce(t, root) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => child.kill());
  const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  const logs = [];
  conn.onNotification('window/logMessage', (p) => logs.push(p.message));
  conn.onNotification(() => {});
  conn.onRequest(() => null);
  conn.listen();

  const rootUri = pathToFileURL(root).href;
  await conn.sendRequest('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'tmp' }], capabilities: {} });
  conn.sendNotification('initialized', {});
  await conn.sendRequest('ejsng/stats'); // answered after indexing, which runs on `initialized`
  await conn.sendRequest('shutdown');
  conn.sendNotification('exit');
  await exited;
  conn.dispose();
  return logs;
}

test('LSP: shutdown writes the index cache, so the next start re-parses nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), "angular.module('app', []).controller('A', function ($scope) { $scope.x = 1; });\n");
  writeFileSync(join(root, 'page.html'), '<div ng-controller="A">{{ x }}</div>\n');

  const cold = await runOnce(t, root);
  assert.ok(cold.some((l) => /done — 2 new file\(s\), 0 unchanged/.test(l)), cold.join('\n'));
  assert.ok(existsSync(join(root, '.ejsng-cache', 'index.ndjson')), 'cache written on shutdown');
  assert.match(readFileSync(join(root, '.ejsng-cache', '.gitignore'), 'utf8'), /^\*$/m);

  const warm = await runOnce(t, root);
  assert.ok(warm.some((l) => /done — 0 new file\(s\), 2 unchanged/.test(l)), warm.join('\n'));
});
