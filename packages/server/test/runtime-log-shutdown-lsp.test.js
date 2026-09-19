/**
 * Ticket 07 (.scratch/inline-runtime-log/issues/07-cleanup-socket-on-shutdown.md): the LSP
 * `shutdown` request closes every live runtime-log connection explicitly. The check runs between
 * `shutdown` and `exit` — the server process is still alive — and requires a clean close frame
 * (code 1000), which a socket torn down by the process dying never produces (that shows as 1006).
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { WebSocketServer } = require('ws');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

/** A discovery + CDP endpoint on one host:port that records how each target's socket closed. */
async function startFakeRuntime(t, ids) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          ids.map((id) => ({ id, type: 'node', title: id, url: `file:///${id}.js`, webSocketDebuggerUrl: `ws://placeholder/${id}` })),
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const opened = new Set();
  const closes = new Map();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const id = req.url.slice(1);
    opened.add(id);
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    socket.on('close', (code) => closes.set(id, code));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    server.close();
  });
  return { host: '127.0.0.1', port: server.address().port, opened, closes };
}

function waitUntil(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(check, 20);
    };
    check();
  });
}

test('LSP: shutdown closes every runtime-log connection with a clean close frame before exit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-shutdown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const runtime = await startFakeRuntime(t, ['t1', 't2']);

  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => child.kill());
  const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
  conn.onNotification(() => {});
  conn.onRequest(() => null);
  conn.listen();
  t.after(() => conn.dispose());

  const rootUri = pathToFileURL(root).href;
  await conn.sendRequest('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'tmp' }], capabilities: {} });
  conn.sendNotification('initialized', {});

  // Two targets on one endpoint: connectRuntime answers with a choice, then each is connected.
  const choice = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(choice.status, 'choose');
  for (const targetId of ['t1', 't2']) {
    const result = await conn.sendRequest('ejsng/connectRuntimeTarget', { host: runtime.host, port: runtime.port, targetId });
    assert.strictEqual(result.status, 'connected');
  }
  await waitUntil(() => runtime.opened.size === 2);

  await conn.sendRequest('shutdown');
  await waitUntil(() => runtime.closes.size === 2);
  assert.strictEqual(child.exitCode, null, 'server must still be running — the close came from shutdown, not exit');
  assert.deepStrictEqual(Object.fromEntries(runtime.closes), { t1: 1000, t2: 1000 });

  const status = await conn.sendRequest('ejsng/runtimeStatus');
  assert.deepStrictEqual(status.connections, [], 'shutdown forgets the closed connections');

  conn.sendNotification('exit');
  await exited;
});
