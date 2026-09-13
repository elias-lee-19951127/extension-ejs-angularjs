/**
 * Seam 3 of ticket 02a (.scratch/inline-runtime-log/issues/02a-multi-connection-server.md):
 * `ejsng/connectRuntime` takes {host, port}, discovers targets there (fake HTTP discovery
 * server, same idea as runtime-log-discovery.test.js), and the server manages MULTIPLE
 * concurrent CDP connections instead of ticket 01's single-socket-replaces-the-old-one model.
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

/** A fake CDP endpoint: answers Runtime.enable, then pushes one consoleAPICalled event. */
async function startFakeInspector(t, event) {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => wss.close());
  let socketRef = null;
  wss.on('connection', (socket) => {
    socketRef = socket;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.enable') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: event }));
      }
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;
  return {
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
    sendAnother: (params) => socketRef?.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params })),
  };
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

async function startServer(t, root) {
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

test('LSP: ejsng/connectRuntime auto-connects when discovery finds exactly one connectable target', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const inspector = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'hello' }],
    stackTrace: { callFrames: [{ url: join(root, 'app.js'), lineNumber: 0, columnNumber: 0 }] },
  });
  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'node', title: 'app.js', url: 'file:///app.js', webSocketDebuggerUrl: inspector.webSocketDebuggerUrl },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });
  assert.strictEqual(result.status, 'connected');
  assert.strictEqual(typeof result.key, 'string');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'hello');
});

test('LSP: ejsng/connectRuntime asks the client to choose when discovery finds multiple targets', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const a = await startFakeInspector(t, { type: 'log', args: [], stackTrace: { callFrames: [{ url: '/a.js', lineNumber: 0, columnNumber: 0 }] } });
  const b = await startFakeInspector(t, { type: 'log', args: [], stackTrace: { callFrames: [{ url: '/b.js', lineNumber: 0, columnNumber: 0 }] } });
  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'page', title: 'Tab A', url: 'http://localhost:3000/a', webSocketDebuggerUrl: a.webSocketDebuggerUrl },
    { id: 't2', type: 'page', title: 'Tab B', url: 'http://localhost:3000/b', webSocketDebuggerUrl: b.webSocketDebuggerUrl },
  ]);

  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });
  assert.strictEqual(result.status, 'choose');
  assert.deepStrictEqual(
    result.targets.map((x) => x.id).sort(),
    ['t1', 't2'],
  );
});

test('LSP: ejsng/connectRuntime reports not-found when discovery finds nothing connectable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'service_worker', title: 'sw', url: 'http://x/sw.js', webSocketDebuggerUrl: 'ws://x/sw' },
  ]);

  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });
  assert.deepStrictEqual(result, { status: 'not-found' });
});

test('LSP: ejsng/connectRuntimeTarget connects to a specific target by id after a "choose" response', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'b.js'), 'console.log(1);\n');

  const a = await startFakeInspector(t, { type: 'log', args: [{ type: 'string', value: 'from a' }], stackTrace: { callFrames: [{ url: '/a.js', lineNumber: 0, columnNumber: 0 }] } });
  const b = await startFakeInspector(t, { type: 'log', args: [{ type: 'string', value: 'from b' }], stackTrace: { callFrames: [{ url: join(root, 'b.js'), lineNumber: 0, columnNumber: 0 }] } });
  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'page', title: 'Tab A', url: 'http://localhost:3000/a', webSocketDebuggerUrl: a.webSocketDebuggerUrl },
    { id: 't2', type: 'page', title: 'Tab B', url: 'http://localhost:3000/b', webSocketDebuggerUrl: b.webSocketDebuggerUrl },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntimeTarget', { host: discovery.host, port: discovery.port, targetId: 't2' });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'from b');
});

test('LSP: two simultaneous connections both deliver logs independently', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'server.js'), 'console.log(1);\n');
  writeFileSync(join(root, 'browser.js'), 'console.log(1);\n');

  const serverTarget = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'server log' }],
    stackTrace: { callFrames: [{ url: join(root, 'server.js'), lineNumber: 0, columnNumber: 0 }] },
  });
  const browserTarget = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'browser log' }],
    stackTrace: { callFrames: [{ url: join(root, 'browser.js'), lineNumber: 0, columnNumber: 0 }] },
  });
  const serverDiscovery = await startFakeDiscovery(t, [
    { id: 'n1', type: 'node', title: 'server.js', url: 'file:///server.js', webSocketDebuggerUrl: serverTarget.webSocketDebuggerUrl },
  ]);
  const browserDiscovery = await startFakeDiscovery(t, [
    { id: 'p1', type: 'page', title: 'Browser', url: 'http://localhost:3000/', webSocketDebuggerUrl: browserTarget.webSocketDebuggerUrl },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const r1 = await conn.sendRequest('ejsng/connectRuntime', { host: serverDiscovery.host, port: serverDiscovery.port });
  const r2 = await conn.sendRequest('ejsng/connectRuntime', { host: browserDiscovery.host, port: browserDiscovery.port });
  assert.strictEqual(r1.status, 'connected');
  assert.strictEqual(r2.status, 'connected');
  assert.notStrictEqual(r1.key, r2.key);

  await waitUntil(() => runtimeLogs.length >= 2);
  assert.deepStrictEqual(
    runtimeLogs.map((l) => l.value).sort(),
    ['browser log', 'server log'],
  );
});

test('LSP: ejsng/disconnectRuntime stops a specific connection without affecting others', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.js'), 'console.log(1);\n');
  writeFileSync(join(root, 'b.js'), 'console.log(1);\n');

  const a = await startFakeInspector(t, { type: 'log', args: [{ type: 'string', value: 'a' }], stackTrace: { callFrames: [{ url: join(root, 'a.js'), lineNumber: 0, columnNumber: 0 }] } });
  const b = await startFakeInspector(t, { type: 'log', args: [{ type: 'string', value: 'b' }], stackTrace: { callFrames: [{ url: join(root, 'b.js'), lineNumber: 0, columnNumber: 0 }] } });
  const da = await startFakeDiscovery(t, [{ id: 'a1', type: 'node', title: 'a', url: 'file:///a.js', webSocketDebuggerUrl: a.webSocketDebuggerUrl }]);
  const db = await startFakeDiscovery(t, [{ id: 'b1', type: 'node', title: 'b', url: 'file:///b.js', webSocketDebuggerUrl: b.webSocketDebuggerUrl }]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const ra = await conn.sendRequest('ejsng/connectRuntime', { host: da.host, port: da.port });
  const rb = await conn.sendRequest('ejsng/connectRuntime', { host: db.host, port: db.port });
  await waitUntil(() => runtimeLogs.length >= 2);

  const disc = await conn.sendRequest('ejsng/disconnectRuntime', { key: ra.key });
  assert.deepStrictEqual(disc, { disconnected: true });

  // Disconnecting an already-gone key is a no-op, not an error.
  const discAgain = await conn.sendRequest('ejsng/disconnectRuntime', { key: ra.key });
  assert.deepStrictEqual(discAgain, { disconnected: false });

  runtimeLogs.length = 0;
  a.sendAnother({ type: 'log', args: [{ type: 'string', value: 'a again' }], stackTrace: { callFrames: [{ url: join(root, 'a.js'), lineNumber: 0, columnNumber: 0 }] } });
  b.sendAnother({ type: 'log', args: [{ type: 'string', value: 'b again' }], stackTrace: { callFrames: [{ url: join(root, 'b.js'), lineNumber: 0, columnNumber: 0 }] } });

  await waitUntil(() => runtimeLogs.length > 0);
  // Give the (disconnected) `a` a fair chance to wrongly arrive too, if disconnect didn't work.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(runtimeLogs.map((l) => l.value), ['b again']);
});

test('LSP: ejsng/connectRuntime does not crash the server when the discovery endpoint is unreachable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-unreachable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port: 1 }); // privileged port, refused
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(typeof result.message, 'string');

  // Before the fix (ticket 01) an unhandled socket error crashed the process; prove discovery
  // failures are equally survivable — the server answers an unrelated request afterward.
  const stats = await conn.sendRequest('ejsng/stats');
  assert.ok(stats);
});

test('LSP: ejsng/connectRuntime does not crash the server when discovery finds a target whose socket is unreachable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-dead-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Bind then immediately close: a port nothing is listening on.
  const probe = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => probe.once('listening', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'node', title: 'dead', url: 'file:///dead.js', webSocketDebuggerUrl: `ws://127.0.0.1:${deadPort}` },
  ]);

  const { conn } = await startServer(t, root);
  // Discovery itself succeeds (exactly one target) — the server optimistically reports
  // 'connected' the same way ticket 01 did (real status reporting is ticket 06, not yet built);
  // what this test guards is that the WebSocket connecting to that dead target doesn't crash it.
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });
  assert.strictEqual(result.status, 'connected');

  const stats = await conn.sendRequest('ejsng/stats');
  assert.ok(stats);
});

test('LSP: a runtime log whose reported file resolves outside the workspace root is dropped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  // A file that exists on disk, but is a SIBLING of root, not inside it — `workspace.toRelative`
  // resolves this to something like '../outside.js'.
  const outsideDir = mkdtempSync(join(tmpdir(), 'ejsng-conn-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'outside.js'), 'console.log(2);\n');

  const inspector = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'should not surface' }],
    stackTrace: { callFrames: [{ url: join(outsideDir, 'outside.js'), lineNumber: 0, columnNumber: 0 }] },
  });
  const discovery = await startFakeDiscovery(t, [
    { id: 't1', type: 'node', title: 'outside', url: 'file:///outside.js', webSocketDebuggerUrl: inspector.webSocketDebuggerUrl },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  await conn.sendRequest('ejsng/connectRuntime', { host: discovery.host, port: discovery.port });

  // No deterministic event to wait FOR here (we're proving something does NOT happen) — wait
  // long enough that, if the containment check were missing, the notification would have
  // arrived by now (comfortably longer than this suite's other event round-trips take).
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(runtimeLogs.length, 0);

  const stats = await conn.sendRequest('ejsng/stats');
  assert.ok(stats);
});
