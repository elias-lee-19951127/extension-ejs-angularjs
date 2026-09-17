/**
 * Ticket 06 (.scratch/runtime-remote-env/issues/06-kiem-tra-noi-dung.md) end-to-end over LSP: a
 * path match is not a content match, so drawing inline is conditional on the file on disk really
 * being what the runtime compiled.
 *
 * The fake runtime here speaks the `Debugger` half of CDP as well as `Runtime`: it answers
 * `Debugger.enable`, pushes `Debugger.scriptParsed` metadata, and serves
 * `Debugger.getScriptSource` — the three things content verification actually depends on. Test
 * timing is explicit (`sendLog`) rather than "push an event on enable", because two of these
 * cases need the file on disk to change AFTER the connection is already open.
 *
 * Pure comparison logic (`sourceMatchesScript`, `candidateHostPaths`) is covered in
 * packages/core/test/runtime-log.test.js, against constants measured on a real `node --inspect`.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { WebSocketServer } = require('ws');

const SERVER = join(__dirname, '..', 'dist', 'index.js');
const TARGET_ID = 't1';
const SCRIPT_ID = '42';

/**
 * A combined discovery + CDP endpoint that also serves the Debugger domain.
 * `scripts`: `{scriptId, url, source}[]` — `scriptParsed` metadata is DERIVED from `source`, the
 * way V8 derives it, so a test states only what the runtime is running and never hand-computes
 * endLine/endColumn/length. `getScriptSource` serves that same source.
 */
async function startFakeRuntime(t, scripts) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: TARGET_ID, type: 'node', title: 'app', url: 'file:///app.js', webSocketDebuggerUrl: `ws://placeholder/${TARGET_ID}` },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  let live = null;
  // Set only once every scriptParsed has been written to the socket. Messages on one WebSocket
  // are ordered, so a log sent after this point is guaranteed to reach the server behind the
  // metadata it needs — without this the test races verification and flakily draws.
  let scriptsDelivered = false;
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    if (req.url.slice(1) !== TARGET_ID) return;
    live = socket;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Debugger.enable') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        for (const s of scripts) {
          const lines = s.source.split('\n');
          socket.send(
            JSON.stringify({
              method: 'Debugger.scriptParsed',
              params: {
                scriptId: s.scriptId,
                url: s.url,
                startLine: 0,
                startColumn: 0,
                endLine: lines.length - 1,
                endColumn: lines[lines.length - 1].length,
                length: s.source.length,
              },
            }),
          );
        }
        scriptsDelivered = true;
        return;
      }
      if (msg.method === 'Debugger.getScriptSource') {
        const found = scripts.find((s) => s.scriptId === msg.params.scriptId);
        socket.send(JSON.stringify({ id: msg.id, result: { scriptSource: found ? found.source : '' } }));
        return;
      }
      socket.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {
    host: '127.0.0.1',
    port: server.address().port,
    /** Push one `Runtime.consoleAPICalled`, anchored to `scriptId` at `line`. */
    sendLog(value, { url, scriptId = SCRIPT_ID, line = 0 }) {
      live.send(
        JSON.stringify({
          method: 'Runtime.consoleAPICalled',
          params: {
            type: 'log',
            args: [{ type: 'string', value }],
            stackTrace: { callFrames: [{ url, scriptId, lineNumber: line, columnNumber: 0 }] },
          },
        }),
      );
    },
    isReady: () => live !== null && scriptsDelivered,
  };
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

/**
 * Wait until `count` logs have been fully HANDLED, not merely received. `received` is bumped
 * synchronously when the event arrives, while the verdict — drawn, or dropped under a reason —
 * lands after the verification round-trip; polling on `received` alone reads the counters in the
 * gap between the two and sees neither.
 */
function settled(status, count = 1) {
  const c = status.connections[0];
  if (!c) return false;
  const dropped = Object.values(c.droppedByReason).reduce((a, b) => a + b, 0);
  return c.drawn + dropped >= count;
}

async function waitForStatus(conn, predicate, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const status = await conn.sendRequest('ejsng/runtimeStatus');
    if (predicate(status)) return status;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; last status: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function tmpRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const RUNTIME_PATH = '/app/src/handler.js';
const RUNNING_SOURCE = 'function handle() {\n  console.log("handling");\n}\nmodule.exports = handle;\n';

test('content matches: the log is drawn, exactly as before this ticket', async (t) => {
  const root = tmpRoot(t, 'ejsng-verify-match-');
  writeFile(join(root, 'src', 'handler.js'), RUNNING_SOURCE);
  const runtime = await startFakeRuntime(t, [{ scriptId: SCRIPT_ID, url: RUNTIME_PATH, source: RUNNING_SOURCE }]);

  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: root }] },
  });
  assert.strictEqual((await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port })).status, 'connected');
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('handling', { url: RUNTIME_PATH, line: 1 });
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'handling');
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'src', 'handler.js')).href);
  assert.strictEqual(runtimeLogs[0].range.start.line, 1);
});

test('stale file: edited after the runtime loaded it — not drawn, counted as stale-file', async (t) => {
  const root = tmpRoot(t, 'ejsng-verify-stale-');
  const file = join(root, 'src', 'handler.js');
  writeFile(file, RUNNING_SOURCE);
  const runtime = await startFakeRuntime(t, [{ scriptId: SCRIPT_ID, url: RUNTIME_PATH, source: RUNNING_SOURCE }]);

  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: root }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  // Edit AFTER connecting: the runtime is still running the old bytes, and every line below the
  // insertion has shifted — drawing on the reported line would land on the wrong statement.
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFile(file, `// a new comment line\n${RUNNING_SOURCE}`);

  runtime.sendLog('handling', { url: RUNTIME_PATH, line: 1 });
  const status = await waitForStatus(conn, (s) => settled(s));
  assert.strictEqual(status.connections[0].drawn, 0);
  assert.strictEqual(status.connections[0].droppedByReason['stale-file'], 1);
  assert.strictEqual(runtimeLogs.length, 0);
});

test('shadowed file: another mapped copy is what the runtime runs — named, and not drawn', async (t) => {
  const root = tmpRoot(t, 'ejsng-verify-shadowed-');
  // Two mappings cover the same container path (the shape nested mounts produce). The FIRST is
  // what the path resolves to and would have been drawn on; the runtime is really running the
  // second.
  const shadowed = join(root, 'shadowed');
  const running = join(root, 'running');
  writeFile(join(shadowed, 'src', 'handler.js'), 'function handle() {\n  console.log("a completely different body");\n}\n');
  writeFile(join(running, 'src', 'handler.js'), RUNNING_SOURCE);
  const runtime = await startFakeRuntime(t, [{ scriptId: SCRIPT_ID, url: RUNTIME_PATH, source: RUNNING_SOURCE }]);

  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: {
      pathMappings: [
        { remote: '/app', local: shadowed },
        { remote: '/app', local: running },
      ],
    },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('handling', { url: RUNTIME_PATH, line: 1 });
  const status = await waitForStatus(conn, (s) => settled(s));
  const [c] = status.connections;
  assert.strictEqual(c.drawn, 0);
  assert.strictEqual(c.droppedByReason['shadowed-file'], 1);
  assert.strictEqual(runtimeLogs.length, 0);
  // The panel can name the file the runtime IS running — proven by content, not guessed.
  const frame = c.recentLogs[0].frames.at(-1);
  assert.strictEqual(frame.skipReason, 'shadowed-file');
  assert.strictEqual(frame.runtimePath, join(running, 'src', 'handler.js'));
});

test('an edit that changes bytes but not length or line structure is still caught', async (t) => {
  // This is the case the cheap metadata check CANNOT see, and the reason the exact
  // Debugger.getScriptSource confirmation exists: same length, same lines, different code.
  const root = tmpRoot(t, 'ejsng-verify-samesize-');
  const onDisk = RUNNING_SOURCE.replace('"handling"', '"HANDLING"');
  assert.strictEqual(onDisk.length, RUNNING_SOURCE.length);
  writeFile(join(root, 'src', 'handler.js'), onDisk);
  const runtime = await startFakeRuntime(t, [{ scriptId: SCRIPT_ID, url: RUNTIME_PATH, source: RUNNING_SOURCE }]);

  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: root }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('handling', { url: RUNTIME_PATH, line: 1 });
  const status = await waitForStatus(conn, (s) => settled(s));
  assert.strictEqual(status.connections[0].drawn, 0);
  assert.strictEqual(status.connections[0].droppedByReason['content-mismatch'], 1);
  assert.strictEqual(runtimeLogs.length, 0);
});

test('a runtime that reports no script metadata still draws — verification degrades, it does not block', async (t) => {
  // A target that never sends Debugger.scriptParsed (or a frame with no scriptId) cannot be
  // verified. It must keep working exactly as it did before this ticket rather than going silent.
  const root = tmpRoot(t, 'ejsng-verify-none-');
  writeFile(join(root, 'src', 'handler.js'), RUNNING_SOURCE);
  const runtime = await startFakeRuntime(t, []); // no scriptParsed at all

  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: root }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('handling', { url: RUNTIME_PATH, line: 1 });
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'handling');
});

test('logs stay in the order the runtime emitted them, despite the async verification round-trip', async (t) => {
  const root = tmpRoot(t, 'ejsng-verify-order-');
  writeFile(join(root, 'src', 'handler.js'), RUNNING_SOURCE);
  const runtime = await startFakeRuntime(t, [{ scriptId: SCRIPT_ID, url: RUNTIME_PATH, source: RUNNING_SOURCE }]);

  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: root }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  for (let i = 0; i < 10; i++) runtime.sendLog(`log ${i}`, { url: RUNTIME_PATH, line: 1 });
  await waitUntil(() => runtimeLogs.length === 10);
  assert.deepStrictEqual(
    runtimeLogs.map((l) => l.value),
    Array.from({ length: 10 }, (_, i) => `log ${i}`),
  );
});
