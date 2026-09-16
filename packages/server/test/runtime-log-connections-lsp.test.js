/**
 * Seam 3 of ticket 02a (.scratch/inline-runtime-log/issues/02a-multi-connection-server.md):
 * `ejsng/connectRuntime` takes {host, port}, discovers targets there (fake HTTP discovery
 * server, same idea as runtime-log-discovery.test.js), and the server manages MULTIPLE
 * concurrent CDP connections instead of ticket 01's single-socket-replaces-the-old-one model.
 *
 * Also covers ticket 02's real-status and drop-count behavior (item 4): `ejsng/connectRuntime`
 * itself keeps reporting `'connected'` synchronously for back-compat (item 5 — the future
 * IntelliJ client must not break), but the REAL connecting/connected/failed lifecycle and the
 * received/drawn/dropped-by-reason counters are only visible through the new
 * `ejsng/runtimeStatus` request and `ejsng/runtimeStatusChanged` notification.
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
 * `/json/list` and every target's WebSocket upgrade from the SAME host:port. Needed because
 * `discoverTargets` rewrites `webSocketDebuggerUrl` to the host:port actually used to reach
 * discovery (ticket 02, item 2) — a fake target on a genuinely different port would no longer be
 * reachable through it. `targets`: `{id, type, title, url, event}[]`; `event` is the
 * `Runtime.consoleAPICalled` params pushed once that target's socket sends `Runtime.enable`.
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
  const sockets = new Map();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const id = req.url.slice(1);
    sockets.set(id, socket);
    const target = targets.find((tg) => tg.id === id);
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
  return {
    host: '127.0.0.1',
    port: server.address().port,
    sendAnother: (id, params) => sockets.get(id)?.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params })),
  };
}

async function startServer(t, root) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(child.stdout),
    new rpc.StreamMessageWriter(child.stdin),
  );
  const runtimeLogs = [];
  const statusChanges = [];
  conn.onNotification('ejsng/runtimeLog', (p) => runtimeLogs.push(p));
  conn.onNotification('ejsng/runtimeStatusChanged', (p) => statusChanges.push(p));
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

  return { conn, runtimeLogs, statusChanges };
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

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app.js',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'hello' }],
        stackTrace: { callFrames: [{ url: join(root, 'app.js'), lineNumber: 0, columnNumber: 0 }] },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');
  assert.strictEqual(typeof result.key, 'string');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'hello');
});

/**
 * Ticket 02, item 2: "every probe" means both the HTTP discovery request (covered in
 * runtime-log-discovery.test.js) AND the CDP WebSocket handshake itself — Chrome/Node inspect
 * the `Host` header on the WS upgrade too, not just on `/json/list`.
 */
test('LSP: connectRuntimeLog sends `Host: localhost` on the CDP WebSocket handshake too, not just on HTTP discovery', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-wshost-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 't1', type: 'node', title: 'app', url: 'file:///app.js', webSocketDebuggerUrl: 'ws://placeholder/t1' }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    server,
    // Reject the upgrade outright if the Host header isn't what a real Chrome/Node inspector
    // would require — proves connectRuntimeLog sets it, not just discoverTargets.
    verifyClient: (info) => info.req.headers.host === 'localhost',
  });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.enable') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        socket.send(
          JSON.stringify({
            method: 'Runtime.consoleAPICalled',
            params: { type: 'log', args: [{ type: 'string', value: 'ok' }], stackTrace: { callFrames: [{ url: join(root, 'app.js'), lineNumber: 0, columnNumber: 0 }] } },
          }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'ok');
});

test('LSP: ejsng/connectRuntime asks the client to choose when discovery finds multiple targets', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runtime = await startFakeRuntime(t, [
    { id: 't1', type: 'page', title: 'Tab A', url: 'http://localhost:3000/a', event: { type: 'log', args: [], stackTrace: { callFrames: [{ url: '/a.js', lineNumber: 0, columnNumber: 0 }] } } },
    { id: 't2', type: 'page', title: 'Tab B', url: 'http://localhost:3000/b', event: { type: 'log', args: [], stackTrace: { callFrames: [{ url: '/b.js', lineNumber: 0, columnNumber: 0 }] } } },
  ]);

  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'choose');
  assert.deepStrictEqual(
    result.targets.map((x) => x.id).sort(),
    ['t1', 't2'],
  );
});

test('LSP: ejsng/connectRuntime reports not-found when discovery finds nothing connectable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await startFakeRuntime(t, [{ id: 't1', type: 'service_worker', title: 'sw', url: 'http://x/sw.js' }]);

  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.deepStrictEqual(result, { status: 'not-found' });
});

test('LSP: ejsng/connectRuntimeTarget connects to a specific target by id after a "choose" response', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'b.js'), 'console.log(1);\n');

  const runtime = await startFakeRuntime(t, [
    { id: 't1', type: 'page', title: 'Tab A', url: 'http://localhost:3000/a', event: { type: 'log', args: [{ type: 'string', value: 'from a' }], stackTrace: { callFrames: [{ url: '/a.js', lineNumber: 0, columnNumber: 0 }] } } },
    { id: 't2', type: 'page', title: 'Tab B', url: 'http://localhost:3000/b', event: { type: 'log', args: [{ type: 'string', value: 'from b' }], stackTrace: { callFrames: [{ url: join(root, 'b.js'), lineNumber: 0, columnNumber: 0 }] } } },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntimeTarget', { host: runtime.host, port: runtime.port, targetId: 't2' });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'from b');
});

test('LSP: two simultaneous connections both deliver logs independently', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'server.js'), 'console.log(1);\n');
  writeFileSync(join(root, 'browser.js'), 'console.log(1);\n');

  const serverRuntime = await startFakeRuntime(t, [
    { id: 'n1', type: 'node', title: 'server.js', url: 'file:///server.js', event: { type: 'log', args: [{ type: 'string', value: 'server log' }], stackTrace: { callFrames: [{ url: join(root, 'server.js'), lineNumber: 0, columnNumber: 0 }] } } },
  ]);
  const browserRuntime = await startFakeRuntime(t, [
    { id: 'p1', type: 'page', title: 'Browser', url: 'http://localhost:3000/', event: { type: 'log', args: [{ type: 'string', value: 'browser log' }], stackTrace: { callFrames: [{ url: join(root, 'browser.js'), lineNumber: 0, columnNumber: 0 }] } } },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const r1 = await conn.sendRequest('ejsng/connectRuntime', { host: serverRuntime.host, port: serverRuntime.port });
  const r2 = await conn.sendRequest('ejsng/connectRuntime', { host: browserRuntime.host, port: browserRuntime.port });
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

  const ra1 = await startFakeRuntime(t, [
    { id: 'a1', type: 'node', title: 'a', url: 'file:///a.js', event: { type: 'log', args: [{ type: 'string', value: 'a' }], stackTrace: { callFrames: [{ url: join(root, 'a.js'), lineNumber: 0, columnNumber: 0 }] } } },
  ]);
  const rb1 = await startFakeRuntime(t, [
    { id: 'b1', type: 'node', title: 'b', url: 'file:///b.js', event: { type: 'log', args: [{ type: 'string', value: 'b' }], stackTrace: { callFrames: [{ url: join(root, 'b.js'), lineNumber: 0, columnNumber: 0 }] } } },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const ra = await conn.sendRequest('ejsng/connectRuntime', { host: ra1.host, port: ra1.port });
  const rb = await conn.sendRequest('ejsng/connectRuntime', { host: rb1.host, port: rb1.port });
  await waitUntil(() => runtimeLogs.length >= 2);

  const disc = await conn.sendRequest('ejsng/disconnectRuntime', { key: ra.key });
  assert.deepStrictEqual(disc, { disconnected: true });

  // Disconnecting an already-gone key is a no-op, not an error.
  const discAgain = await conn.sendRequest('ejsng/disconnectRuntime', { key: ra.key });
  assert.deepStrictEqual(discAgain, { disconnected: false });

  runtimeLogs.length = 0;
  ra1.sendAnother('a1', { type: 'log', args: [{ type: 'string', value: 'a again' }], stackTrace: { callFrames: [{ url: join(root, 'a.js'), lineNumber: 0, columnNumber: 0 }] } });
  rb1.sendAnother('b1', { type: 'log', args: [{ type: 'string', value: 'b again' }], stackTrace: { callFrames: [{ url: join(root, 'b.js'), lineNumber: 0, columnNumber: 0 }] } });

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

test('LSP: ejsng/connectRuntime does not crash the server when discovery finds a target whose socket is unreachable, and eventually reports it failed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-dead-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Discovery works, but the advertised target path has NO WebSocket upgrade handler behind it
  // (the server only speaks plain HTTP on `/json/list`) — a real-world stand-in for a target
  // whose socket has gone away between discovery and connect.
  const discovery = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 't1', type: 'node', title: 'dead', url: 'file:///dead.js', webSocketDebuggerUrl: 'ws://placeholder/t1' }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => discovery.listen(0, '127.0.0.1', resolve));
  t.after(() => discovery.close());
  const port = discovery.address().port;

  const { conn, statusChanges } = await startServer(t, root);
  // Discovery itself succeeds (exactly one target) — the server optimistically reports
  // 'connected' the same way ticket 01 did, for backward compatibility (ejsng/connectRuntime's
  // shape must not change — ticket 02, item 5); the REAL state is only visible via
  // ejsng/runtimeStatus / ejsng/runtimeStatusChanged (ticket 02, item 4).
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => statusChanges.some((s) => s.key === result.key && s.state === 'failed'));
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  const conn1 = status.connections.find((c) => c.key === result.key);
  assert.strictEqual(conn1.state, 'failed');
  assert.strictEqual(typeof conn1.reason, 'string');

  const stats = await conn.sendRequest('ejsng/stats');
  assert.ok(stats);
});

test('LSP: a runtime log whose reported file resolves outside the workspace root is dropped and counted', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  // A file that exists on disk, but is a SIBLING of root, not inside it — `workspace.toRelative`
  // resolves this to something like '../outside.js'.
  const outsideDir = mkdtempSync(join(tmpdir(), 'ejsng-conn-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'outside.js'), 'console.log(2);\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'outside',
      url: 'file:///outside.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'should not surface' }],
        stackTrace: { callFrames: [{ url: join(outsideDir, 'outside.js'), lineNumber: 0, columnNumber: 0 }] },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });

  // No deterministic event to wait FOR here (we're proving something does NOT happen) — wait
  // long enough that, if the containment check were missing, the notification would have
  // arrived by now (comfortably longer than this suite's other event round-trips take).
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(runtimeLogs.length, 0);

  const status = await conn.sendRequest('ejsng/runtimeStatus');
  const conn1 = status.connections.find((c) => c.key === result.key);
  assert.strictEqual(conn1.received, 1);
  assert.strictEqual(conn1.drawn, 0);
  assert.deepStrictEqual(conn1.droppedByReason, { 'outside-workspace': 1 });

  const stats = await conn.sendRequest('ejsng/stats');
  assert.ok(stats);
});

test('LSP: ejsng/runtimeStatus reports connecting -> connected and received/drawn counts for a live connection', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app.js',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'hello' }],
        stackTrace: { callFrames: [{ url: join(root, 'app.js'), lineNumber: 0, columnNumber: 0 }] },
      },
    },
  ]);

  const { conn, runtimeLogs, statusChanges } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  // The real state transition is pushed as a notification, not just visible via polling.
  await waitUntil(() => statusChanges.some((s) => s.key === result.key && s.state === 'connected'));

  await waitUntil(() => runtimeLogs.length > 0);
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  const conn1 = status.connections.find((c) => c.key === result.key);
  assert.strictEqual(conn1.state, 'connected');
  assert.strictEqual(conn1.received, 1);
  assert.strictEqual(conn1.drawn, 1);
  assert.deepStrictEqual(conn1.droppedByReason, {});
});

test('LSP: a consoleAPICalled event with no stack trace is counted as dropped, not silently lost', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-conn-unanchored-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runtime = await startFakeRuntime(t, [
    { id: 't1', type: 'node', title: 'app.js', url: 'file:///app.js', event: { type: 'log', args: [{ type: 'string', value: 'no location' }] } },
  ]);

  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  // `waitUntil` only supports a synchronous predicate — poll `ejsng/runtimeStatus` (an async
  // request) directly instead of forcing it through that helper.
  const deadline = Date.now() + 3000;
  let status;
  for (;;) {
    status = await conn.sendRequest('ejsng/runtimeStatus');
    if (status.connections.find((c) => c.key === result.key)?.received === 1) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for the unanchored log to be received');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const conn1 = status.connections.find((c) => c.key === result.key);
  assert.strictEqual(conn1.drawn, 0);
  assert.deepStrictEqual(conn1.droppedByReason, { 'no-stack-trace': 1 });
});
