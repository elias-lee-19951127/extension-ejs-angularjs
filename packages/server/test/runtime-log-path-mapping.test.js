/**
 * Seam of ticket 11 (.scratch/inline-runtime-log/issues/11-docker-path-mapping.md): rewrite a
 * container-internal path (what a Dockerized target's CDP events report) to the matching path
 * on the host, via user-configured {remote, local} pairs.
 *
 * `mapContainerPath` itself is a pure function, moved to packages/core/test/runtime-log.test.js
 * (ticket 02's prefactor) — this file keeps the LSP-level integration tests.
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

/**
 * A combined discovery + CDP endpoint — exactly how `node --inspect` and Chrome serve BOTH
 * `/json/list` and every target's WebSocket upgrade from the SAME host:port (unlike this suite's
 * old convention of two separate fake servers, which broke once discoverTargets started
 * rewriting webSocketDebuggerUrl to the host:port actually used to reach discovery — ticket 02).
 * `targets`: `{id, type, title, url, event}[]`; `event` is the `Runtime.consoleAPICalled` params
 * pushed once that target's socket sends `Runtime.enable`.
 */
async function startFakeRuntime(t, targets) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          targets.map((tg) => ({
            id: tg.id,
            type: tg.type,
            title: tg.title,
            url: tg.url,
            webSocketDebuggerUrl: `ws://placeholder/${tg.id}`, // host:port gets rewritten regardless
          })),
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const target = targets.find((tg) => tg.id === req.url.slice(1));
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.enable') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        if (target?.event) socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: target.event }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { host: '127.0.0.1', port: server.address().port };
}

async function startServer(t, root, initializationOptions = {}) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(child.stdout),
    new rpc.StreamMessageWriter(child.stdin),
  );
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

test('LSP: a container-path log is mapped to the host path via ejsng.runtimeLog.pathMappings', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-pathmap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const discovery = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app.js',
      url: 'file:///app/app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'from container' }],
        // The container reports its OWN internal path — not anything under `root`.
        stackTrace: { callFrames: [{ url: '/app/app.js', lineNumber: 0, columnNumber: 0 }] },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: root }] },
  });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'from container');
  // Mapped to the real file under `root` — not dropped by the outside-workspace guard.
  assert.ok(runtimeLogs[0].uri.endsWith('/app.js'));
  assert.ok(!runtimeLogs[0].uri.includes('/app/app.js') || runtimeLogs[0].uri.includes(root));
});

test('LSP: without a matching mapping, a container-path log is still dropped as outside the workspace', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-pathmap-none-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const discovery = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app.js',
      url: 'file:///app/app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'should not surface' }],
        stackTrace: { callFrames: [{ url: '/app/app.js', lineNumber: 0, columnNumber: 0 }] },
      },
    },
  ]);

  // No pathMappings configured at all — same as today's behavior.
  const { conn, runtimeLogs } = await startServer(t, root, {});
  await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(runtimeLogs.length, 0);
});
