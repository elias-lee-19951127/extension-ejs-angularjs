/**
 * Ticket 07 (.scratch/runtime-remote-env/issues/07-khop-duoi-url-trinh-duyet.md) end-to-end over
 * LSP: a log from a browser carries a URL, not a filesystem path, and no mount can say what file
 * it is. Matching the tail of the URL against the indexed files is the last resort, after every
 * Path Mapping has had its say — and only for URLs.
 *
 * The suffix-matching logic itself is covered in packages/core/test/runtime-log.test.js. What
 * only this level can prove: it runs against the REAL index, a tie refuses to draw, a file path
 * never takes this route, and ticket 06's content verification still gates the result.
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
const SCRIPT_ID = '9';

/**
 * A discovery + CDP endpoint that can also play a browser: `scripts` (optional) are served as
 * `Debugger.scriptParsed` metadata derived from their source, exactly as V8 derives it, plus
 * `Debugger.getScriptSource`. Leaving `scripts` empty makes every frame unverifiable, which keeps
 * a test about URL matching alone.
 */
async function startFakeRuntime(t, scripts = []) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: TARGET_ID, type: 'page', title: 'app', url: 'http://localhost:5000/', webSocketDebuggerUrl: `ws://placeholder/${TARGET_ID}` },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  let live = null;
  let ready = false;
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    if (req.url.slice(1) !== TARGET_ID) return;
    live = socket;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Debugger.getScriptSource') {
        const found = scripts.find((s) => s.scriptId === msg.params.scriptId);
        socket.send(JSON.stringify({ id: msg.id, result: { scriptSource: found ? found.source : '' } }));
        return;
      }
      socket.send(JSON.stringify({ id: msg.id, result: {} }));
      if (msg.method !== 'Debugger.enable') return;
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
      // Only now: messages on one socket are ordered, so a log sent after this reaches the
      // server behind the metadata it needs.
      ready = true;
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {
    host: '127.0.0.1',
    port: server.address().port,
    sendLog(value, url, { line = 0, scriptId } = {}) {
      const frame = { url, lineNumber: line, columnNumber: 0 };
      if (scriptId) frame.scriptId = scriptId;
      live.send(
        JSON.stringify({
          method: 'Runtime.consoleAPICalled',
          params: { type: 'log', args: [{ type: 'string', value }], stackTrace: { callFrames: [frame] } },
        }),
      );
    },
    isReady: () => ready,
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
  await conn.sendRequest('ejsng/stats'); // also waits for the initial index to finish
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

/** Wait on a HANDLED log — `received` is bumped before the verdict lands (ticket 06). */
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

const SOURCE = 'function boot() {\n  console.log("booted");\n}\nboot();\n';

function tmpRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function connect(conn, runtime) {
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');
  await waitUntil(() => runtime.isReady());
}

test('a browser URL is matched to the indexed file sharing the longest tail', async (t) => {
  const root = tmpRoot(t, 'ejsng-urlmatch-');
  writeFile(join(root, 'public', 'javascripts', 'index.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root);
  await connect(conn, runtime);

  runtime.sendLog('booted', 'http://localhost:5000/javascripts/index.js', { line: 1 });
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'public', 'javascripts', 'index.js')).href);
  assert.strictEqual(runtimeLogs[0].range.start.line, 1);
});

test('the match becomes a directory mapping the panel offers to save, and settings stay untouched', async (t) => {
  const root = tmpRoot(t, 'ejsng-urlmatch-save-');
  writeFile(join(root, 'public', 'javascripts', 'index.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn } = await startServer(t, root);
  await connect(conn, runtime);

  runtime.sendLog('booted', 'http://localhost:5000/javascripts/index.js', { line: 1 });
  const status = await waitForSettled(conn);
  // A DIRECTORY mapping, not one file's location — that is what makes every other script from the
  // same directory resolve with no further index scanning.
  assert.deepStrictEqual(status.connections[0].urlMappings, [
    { remote: 'http://localhost:5000', local: join(root, 'public') },
  ]);
});

test('a second URL from the same directory resolves through that mapping', async (t) => {
  const root = tmpRoot(t, 'ejsng-urlmatch-second-');
  writeFile(join(root, 'public', 'javascripts', 'index.js'), SOURCE);
  writeFile(join(root, 'public', 'javascripts', 'other.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root);
  await connect(conn, runtime);

  runtime.sendLog('first', 'http://localhost:5000/javascripts/index.js', { line: 1 });
  await waitUntil(() => runtimeLogs.length === 1);
  runtime.sendLog('second', 'http://localhost:5000/javascripts/other.js', { line: 1 });
  await waitUntil(() => runtimeLogs.length === 2);
  assert.strictEqual(runtimeLogs[1].uri, pathToFileURL(join(root, 'public', 'javascripts', 'other.js')).href);
  // Still exactly one discovered mapping: the second URL never needed the index.
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  assert.strictEqual(status.connections[0].urlMappings.length, 1);
});

test('a query string on the URL does not stop it resolving', async (t) => {
  const root = tmpRoot(t, 'ejsng-urlmatch-query-');
  writeFile(join(root, 'public', 'javascripts', 'index.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root);
  await connect(conn, runtime);

  runtime.sendLog('booted', 'http://localhost:5000/javascripts/index.js?v=3', { line: 1 });
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'public', 'javascripts', 'index.js')).href);
});

test('several files tying for the longest tail refuse to draw, and the panel names them', async (t) => {
  const root = tmpRoot(t, 'ejsng-urlmatch-tie-');
  writeFile(join(root, 'a', 'index.js'), SOURCE);
  writeFile(join(root, 'b', 'index.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root);
  await connect(conn, runtime);

  runtime.sendLog('booted', 'http://localhost:5000/index.js', { line: 1 });
  const status = await waitForSettled(conn);
  const [c] = status.connections;
  assert.strictEqual(c.drawn, 0);
  assert.strictEqual(c.droppedByReason['ambiguous-url-match'], 1);
  assert.strictEqual(runtimeLogs.length, 0);
  const frame = c.recentLogs[0].frames.at(-1);
  assert.strictEqual(frame.skipReason, 'ambiguous-url-match');
  assert.deepStrictEqual(frame.candidates.slice().sort(), ['a/index.js', 'b/index.js']);
  assert.deepStrictEqual(c.urlMappings, []);
});

test('a Node file path is never suffix-matched, even when a file with that tail exists', async (t) => {
  // Checklist item 1, and the reason for it: with nested mounts a tail match on a FILE path is
  // wrong in a way that looks convincing. `<root>/aocs/utility/log.js` would match the tail of
  // the container path below, and must not be used.
  const root = tmpRoot(t, 'ejsng-urlmatch-filepath-');
  writeFile(join(root, 'aocs', 'utility', 'log.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root);
  await connect(conn, runtime);

  runtime.sendLog('booted', '/home/cityos/aocs-cityos/aocs/utility/log.js', { line: 1 });
  const status = await waitForSettled(conn);
  assert.strictEqual(status.connections[0].drawn, 0);
  assert.strictEqual(runtimeLogs.length, 0);
  assert.deepStrictEqual(status.connections[0].urlMappings, []);
});

test('a user mapping for the URL wins, and no suffix matching happens at all', async (t) => {
  const root = tmpRoot(t, 'ejsng-urlmatch-user-');
  writeFile(join(root, 'public', 'javascripts', 'index.js'), SOURCE);
  writeFile(join(root, 'declared', 'javascripts', 'index.js'), SOURCE);
  const runtime = await startFakeRuntime(t);
  const { conn, runtimeLogs } = await startServer(t, root, {
    runtimeLog: { pathMappings: [{ remote: 'http://localhost:5000', local: '${workspaceFolder}/declared' }] },
  });
  await connect(conn, runtime);

  runtime.sendLog('booted', 'http://localhost:5000/javascripts/index.js', { line: 1 });
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'declared', 'javascripts', 'index.js')).href);
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  assert.deepStrictEqual(status.connections[0].urlMappings, []);
});

test("content verification still gates a URL match: the server is serving a bundle, not this source", async (t) => {
  // Checklist item 5. The URL matches a perfectly readable workspace file, but what the browser
  // actually compiled is the built bundle — drawing on the source would be the "wrong line that
  // looks right" this whole chain exists to prevent.
  const root = tmpRoot(t, 'ejsng-urlmatch-verify-');
  writeFile(join(root, 'public', 'javascripts', 'index.js'), SOURCE);
  const served = 'function boot(){console.log("booted")}boot();\n';
  const runtime = await startFakeRuntime(t, [
    { scriptId: SCRIPT_ID, url: 'http://localhost:5000/javascripts/index.js', source: served },
  ]);
  const { conn, runtimeLogs } = await startServer(t, root);
  await connect(conn, runtime);

  runtime.sendLog('booted', 'http://localhost:5000/javascripts/index.js', { line: 0, scriptId: SCRIPT_ID });
  const status = await waitForSettled(conn);
  assert.strictEqual(status.connections[0].drawn, 0);
  assert.strictEqual(runtimeLogs.length, 0);
  const reasons = Object.keys(status.connections[0].droppedByReason);
  assert.deepStrictEqual(reasons, ['content-mismatch']);
});
