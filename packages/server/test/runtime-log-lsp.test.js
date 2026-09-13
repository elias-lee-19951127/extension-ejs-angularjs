/**
 * Seam 3 of the inline runtime log feature (.scratch/inline-runtime-log/spec.md): the full
 * server-side wiring — `ejsng/connectRuntime` opens a real CDP client (packages/server/src
 * /runtime-log.ts connectRuntimeLog) to a WebSocket endpoint, and a `Runtime.consoleAPICalled`
 * event received there comes back out as an `ejsng/runtimeLog` notification.
 *
 * The endpoint here is a FAKE CDP server (just enough of the wire protocol: reply to
 * `Runtime.enable`, then push one `consoleAPICalled` event) — not a real `node --inspect`
 * process. Attaching to a real target process is Seam 4 in the spec, left for manual
 * verification; this test exercises the real WebSocket client code path in production code,
 * just against a stand-in server instead of a live Node target.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { WebSocketServer } = require('ws');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

/**
 * A fake CDP endpoint: answers Runtime.enable, then pushes one consoleAPICalled event —
 * after `delayMs` (default 0), so a test can control exactly when it arrives relative to
 * other actions (e.g. a reconnect).
 */
async function startFakeInspector(t, event, delayMs = 0) {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => wss.close());
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.enable') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        setTimeout(() => socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: event })), delayMs);
      }
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  return `ws://127.0.0.1:${wss.address().port}`;
}

/** Wait until `predicate()` is true, or fail after `timeoutMs`. */
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

async function startServer(t, root) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(child.stdout),
    new rpc.StreamMessageWriter(child.stdin),
  );
  const runtimeLogs = [];
  conn.onNotification('ejsng/runtimeLog', (p) => runtimeLogs.push(p));
  conn.onNotification(() => {}); // log, diagnostics…
  conn.onRequest(() => null); // client/registerCapability, etc.
  conn.listen();
  t.after(async () => {
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    const fallback = setTimeout(() => child.kill(), 3000);
    try {
      await Promise.race([conn.sendRequest('shutdown'), exited]);
      conn.sendNotification('exit');
    } catch {
      /* the server has already shut down */
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
  await conn.sendRequest('ejsng/stats'); // wait for initial indexing, like lsp.test.js does

  return { conn, runtimeLogs };
}

test('LSP: ejsng/connectRuntime turns a CDP consoleAPICalled event into an ejsng/runtimeLog notification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-runtime-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fileContent = 'const a = 1;\nconsole.log(a);\nconst b = 2;\n';
  writeFileSync(join(root, 'app.js'), fileContent);

  const wsUrl = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'hello' }],
    stackTrace: {
      callFrames: [
        { functionName: '', scriptId: '1', url: join(root, 'app.js'), lineNumber: 1, columnNumber: 8 },
      ],
    },
  });

  const { conn, runtimeLogs } = await startServer(t, root);
  const connectResult = await conn.sendRequest('ejsng/connectRuntime', { url: wsUrl });
  assert.deepStrictEqual(connectResult, { connected: true });

  await waitUntil(() => runtimeLogs.length > 0);

  assert.strictEqual(runtimeLogs.length, 1);
  const log = runtimeLogs[0];
  assert.strictEqual(log.value, 'hello');
  assert.strictEqual(log.severity, 'log');
  // Line 1, character 8 in fileContent is the 'l' of 'log' in 'console.log(a);' — offset 21.
  assert.deepStrictEqual(log.range, { start: { line: 1, character: 8 }, end: { line: 1, character: 8 } });
});

test('LSP: ejsng/connectRuntime does not crash the server when the target is unreachable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-runtime-log-unreachable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // A port nothing is listening on: bind then immediately close it, so connecting there fails.
  const probe = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => probe.once('listening', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const { conn } = await startServer(t, root);
  const connectResult = await conn.sendRequest('ejsng/connectRuntime', { url: `ws://127.0.0.1:${deadPort}` });
  assert.deepStrictEqual(connectResult, { connected: true });

  // Before the fix, the socket's unhandled 'error' event would have already crashed the server
  // process by now. Prove it's still alive and responsive to an unrelated request.
  const stats = await conn.sendRequest('ejsng/stats');
  assert.ok(stats);
});

test('LSP: a runtime log whose reported file resolves outside the workspace root is dropped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-runtime-log-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  // A file that exists on disk, but is a SIBLING of root, not inside it — `workspace.toRelative`
  // resolves this to something like '../outside.js'.
  const outsideDir = mkdtempSync(join(tmpdir(), 'ejsng-runtime-log-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'outside.js'), 'console.log(2);\n');

  const wsUrl = await startFakeInspector(t, {
    type: 'log',
    args: [{ type: 'string', value: 'should not surface' }],
    stackTrace: {
      callFrames: [{ functionName: '', scriptId: '1', url: join(outsideDir, 'outside.js'), lineNumber: 0, columnNumber: 0 }],
    },
  });

  const { conn, runtimeLogs } = await startServer(t, root);
  await conn.sendRequest('ejsng/connectRuntime', { url: wsUrl });

  // No deterministic event to wait FOR here (we're proving something does NOT happen) — wait
  // long enough that, if the containment check were missing, the notification would have
  // arrived by now (comfortably longer than this suite's other event round-trips take).
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(runtimeLogs.length, 0);

  // The server itself must still be healthy — this wasn't a crash, just a dropped event.
  const stats = await conn.sendRequest('ejsng/stats');
  assert.ok(stats);
});

test('LSP: reconnecting to a new target supersedes the old one — only the new target\'s logs surface', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-runtime-log-reconnect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'const a = 1;\nconsole.log(a);\nconst b = 2;\n');

  const frame = { functionName: '', scriptId: '1', url: join(root, 'app.js'), lineNumber: 1, columnNumber: 8 };
  // Old target's event is delayed well past the reconnect below, simulating a message that was
  // already in flight on the old connection when a newer `ejsng/connectRuntime` superseded it.
  const oldUrl = await startFakeInspector(t, { type: 'log', args: [{ type: 'string', value: 'stale' }], stackTrace: { callFrames: [frame] } }, 200);
  const newUrl = await startFakeInspector(t, { type: 'log', args: [{ type: 'string', value: 'fresh' }], stackTrace: { callFrames: [frame] } });

  const { conn, runtimeLogs } = await startServer(t, root);
  await conn.sendRequest('ejsng/connectRuntime', { url: oldUrl });
  await conn.sendRequest('ejsng/connectRuntime', { url: newUrl }); // supersedes oldUrl before its delayed event fires

  await waitUntil(() => runtimeLogs.length > 0);
  // Give the old target's delayed event time to arrive too, if it were going to get through.
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.deepStrictEqual(
    runtimeLogs.map((l) => l.value),
    ['fresh'],
  );
});
