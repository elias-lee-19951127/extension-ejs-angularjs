/**
 * Ticket 08 (.scratch/runtime-remote-env/issues/08-log-ngoai-workspace.md) end-to-end over LSP:
 * with nested mounts the file the runtime is really running often lives in a repo the user hasn't
 * opened. Those logs used to vanish silently; they are drawn now — but only for files under the
 * host side of a Path Mapping, because a Runtime Path arrives from a network peer and must never
 * be able to steer a read anywhere else.
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

/** Discovery + CDP endpoint. No `Debugger.scriptParsed` here: content verification is ticket 06's subject, and leaving it out keeps these cases about the read boundary alone. */
async function startFakeRuntime(t) {
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
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    if (req.url.slice(1) !== TARGET_ID) return;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ id: msg.id, result: {} }));
      if (msg.method === 'Debugger.enable') live = socket; // ready only once both enables are in
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {
    host: '127.0.0.1',
    port: server.address().port,
    sendLog(value, url, line = 0) {
      live.send(
        JSON.stringify({
          method: 'Runtime.consoleAPICalled',
          params: {
            type: 'log',
            args: [{ type: 'string', value }],
            stackTrace: { callFrames: [{ url, lineNumber: line, columnNumber: 0 }] },
          },
        }),
      );
    },
    isReady: () => live !== null,
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

/** Wait on a HANDLED log — `received` is bumped before the verdict lands (see ticket 06). */
async function waitForSettled(conn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const status = await conn.sendRequest('ejsng/runtimeStatus');
    const c = status.connections[0];
    if (c && c.drawn + Object.values(c.droppedByReason).reduce((a, b) => a + b, 0) > 0) return status;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; last status: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const SOURCE = 'function handle() {\n  console.log("from the other repo");\n}\n';

/**
 * The shape nested mounts produce: the workspace the user has open is one repo, while the code
 * the runtime is really running lives in a sibling directory that is mounted into the container
 * but never opened in the editor.
 */
function layout(t) {
  const base = mkdtempSync(join(tmpdir(), 'ejsng-outside-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'workspace');
  const other = join(base, 'other-repo');
  mkdirSync(root, { recursive: true });
  writeFile(join(other, 'src', 'handler.js'), SOURCE);
  return { base, root, other };
}

test('a file outside the workspace but under a mapping is drawn, at its own absolute URI', async (t) => {
  const { root, other } = layout(t);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: other }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('from the other repo', '/app/src/handler.js', 1);
  await waitUntil(() => runtimeLogs.length > 0);
  // Addressed by absolute path, not through the workspace root it has no relation to — that URI
  // is what makes the decoration land when the user opens the file (item 3).
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(other, 'src', 'handler.js')).href);
  assert.strictEqual(runtimeLogs[0].range.start.line, 1);
  // The value shown is the LOG's value; the file was read only to locate the line (item 2).
  assert.strictEqual(runtimeLogs[0].value, 'from the other repo');
});

test('the panel is offered that directory to add, and nothing is added automatically', async (t) => {
  const { root, other } = layout(t);
  const runtime = await startFakeRuntime(t);
  const { conn } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: other }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('from the other repo', '/app/src/handler.js', 1);
  const status = await waitForSettled(conn);
  assert.deepStrictEqual(status.connections[0].outsideWorkspaceDirs, [join(other, 'src')]);
});

test('a file outside every mapping is refused, not read, and counted', async (t) => {
  // "Refused" is the point: the file below is real and readable, so passing this proves the
  // boundary rule stopped the read, not a missing file.
  const { base, root, other } = layout(t);
  // A real, readable file that no mapping covers — the server must refuse it on the boundary
  // rule alone, not merely because it happens to be missing.
  const offLimits = join(base, 'not-mapped', 'secret.js');
  writeFile(offLimits, SOURCE);

  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: other }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  // The runtime reports this file's absolute path directly, so no mapping rewrites it.
  runtime.sendLog('should never surface', offLimits, 1);
  const status = await waitForSettled(conn);
  assert.strictEqual(status.connections[0].drawn, 0);
  // Counted as `no-path-mapping` rather than `outside-workspace`: mappings are configured and
  // none of them covers this path, which is the more useful of the two diagnoses (ticket 05).
  assert.strictEqual(status.connections[0].droppedByReason['no-path-mapping'], 1);
  assert.strictEqual(runtimeLogs.length, 0);
  assert.deepStrictEqual(status.connections[0].outsideWorkspaceDirs, []);
});

test('a real host path already under a mapping is drawn even though no mapping rewrote it', async (t) => {
  // The runtime reports the host path directly — a bind mount whose container path equals its
  // host path, or a process running outside Docker on a directory the user mapped. No rewrite
  // happens, so this is admitted purely by the read boundary.
  const { root, other } = layout(t);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: other }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('from the other repo', join(other, 'src', 'handler.js'), 1);
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(other, 'src', 'handler.js')).href);
});

test('a sibling directory sharing a mapping\'s name prefix is not treated as being under it', async (t) => {
  // `<other>-old` starts with the same characters as `<other>` but is a different directory;
  // matching by string prefix instead of whole path segments would read it. Paired with the test
  // above, which is the same shape one segment boundary away and DOES draw.
  const { root, other } = layout(t);
  const lookalike = `${other}-old`;
  writeFile(join(lookalike, 'src', 'handler.js'), SOURCE);

  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: other }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('should never surface', join(lookalike, 'src', 'handler.js'), 1);
  const status = await waitForSettled(conn);
  assert.strictEqual(status.connections[0].drawn, 0);
  assert.strictEqual(runtimeLogs.length, 0);
});

test('a log inside the workspace still draws even when unrelated mappings are configured', async (t) => {
  // Regression: a local `node --inspect` reports paths that are already correct and need no
  // mapping. Once ANY mapping existed, "no mapping covered this path" used to drop them.
  const { root, other } = layout(t);
  writeFile(join(root, 'app.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: '/app', local: other }] },
  });
  await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  await waitUntil(() => runtime.isReady());

  runtime.sendLog('inside', join(root, 'app.js'), 1);
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'app.js')).href);
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  assert.deepStrictEqual(status.connections[0].outsideWorkspaceDirs, []);
});
