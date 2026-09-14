/**
 * Seam of ticket 11 (.scratch/inline-runtime-log/issues/11-docker-path-mapping.md): rewrite a
 * container-internal path (what a Dockerized target's CDP events report) to the matching path
 * on the host, via user-configured {remote, local} pairs.
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
const { mapContainerPath } = require('../dist/runtime-log');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

test('mapContainerPath: no mappings configured — path passes through unchanged', () => {
  assert.strictEqual(mapContainerPath('/app/app.js', []), '/app/app.js');
});

test('mapContainerPath: a matching remote prefix is rewritten to the local path', () => {
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/app/src/index.js', mappings), '/Users/me/project/src/index.js');
});

test('mapContainerPath: a path that matches no configured remote passes through unchanged', () => {
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/other/index.js', mappings), '/other/index.js');
});

test('mapContainerPath: does not rewrite a path that merely starts with the same characters as remote, not the same directory', () => {
  // '/app2/x.js' must NOT match remote '/app' — that would rewrite an unrelated directory.
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/app2/x.js', mappings), '/app2/x.js');
});

test('mapContainerPath: the first matching mapping wins when several are configured', () => {
  const mappings = [
    { remote: '/app/src', local: '/Users/me/project/src-only' },
    { remote: '/app', local: '/Users/me/project' },
  ];
  assert.strictEqual(mapContainerPath('/app/src/index.js', mappings), '/Users/me/project/src-only/index.js');
});

test('mapContainerPath: an exact match of remote (no trailing separator) still rewrites correctly', () => {
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/app', mappings), '/Users/me/project');
});

/** A fake CDP endpoint: answers Runtime.enable, then pushes one consoleAPICalled event. */
async function startFakeInspector(t, event) {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => wss.close());
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.enable') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: event }));
      }
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  return `ws://127.0.0.1:${wss.address().port}`;
}

/** A fake discovery endpoint (`GET /json/list`) returning whatever target list the test wants. */
async function startFakeDiscovery(t, targets) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(targets));
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

  const inspector = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'from container' }],
    // The container reports its OWN internal path — not anything under `root`.
    stackTrace: { callFrames: [{ url: '/app/app.js', lineNumber: 0, columnNumber: 0 }] },
  });
  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'node', title: 'app.js', url: 'file:///app/app.js', webSocketDebuggerUrl: inspector },
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

  const inspector = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'should not surface' }],
    stackTrace: { callFrames: [{ url: '/app/app.js', lineNumber: 0, columnNumber: 0 }] },
  });
  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'node', title: 'app.js', url: 'file:///app/app.js', webSocketDebuggerUrl: inspector },
  ]);

  // No pathMappings configured at all — same as today's behavior.
  const { conn, runtimeLogs } = await startServer(t, root, {});
  await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(runtimeLogs.length, 0);
});
