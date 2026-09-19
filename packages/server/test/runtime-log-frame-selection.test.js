/**
 * Seam of ticket 03 (.scratch/runtime-remote-env/issues/03-chon-frame.md): the naive
 * `callFrames[0]` frame-anchoring from ticket 01/02 is replaced by real selection — skip
 * library/logger frames by pattern, skip obfuscated/minified files by content, and never
 * silently drop a log when every frame gets skipped.
 *
 * `classifyFrameCandidates`, `isLikelyMinified`, `stripAnsi`, and `suggestWrapperFile` themselves
 * are pure functions tested directly in packages/core/test/runtime-log.test.js — this file covers
 * the end-to-end LSP behavior: the frame-selection LOOP in packages/server/src/index.ts's `onLog`
 * (which needs real workspace/file access the pure layer doesn't have), the new `all-frames-skipped`
 * drop reason, and the `recentLogs`/`wrapperSuggestion` fields on `ejsng/runtimeStatus`.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { WebSocketServer } = require('ws');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

/**
 * A combined discovery + CDP endpoint (same shape as runtime-log-connections-lsp.test.js) that
 * can push MULTIPLE consoleAPICalled events on demand via `sendEvent`, not just one at connect
 * time — needed here to build up enough "recently chosen" samples for wrapper-suggestion tests.
 */
async function startFakeRuntime(t, targets) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          targets.map((tg) => ({ id: tg.id, type: tg.type, title: tg.title, url: tg.url, webSocketDebuggerUrl: `ws://placeholder/${tg.id}` })),
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
    sendEvent: (id, params) => sockets.get(id)?.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params })),
  };
}

async function startServer(t, root, initializationOptions = {}) {
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin));
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

async function statusFor(conn, key) {
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  return status.connections.find((c) => c.key === key);
}

test('LSP: a log4js-vendored frame (default skip pattern) is skipped — the log lands on the user code frame that called it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-log4js-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'aocs', 'utility', 'log4js'), { recursive: true });
  writeFileSync(join(root, 'aocs', 'utility', 'log4js', 'appender.js'), 'function write() { console.log(arguments); }\n');
  writeFileSync(join(root, 'controller.js'), 'function handle() { log.info("hit"); }\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'hit' }],
        stackTrace: {
          callFrames: [
            { url: join(root, 'aocs', 'utility', 'log4js', 'appender.js'), lineNumber: 0, columnNumber: 20 },
            { url: join(root, 'controller.js'), lineNumber: 0, columnNumber: 22 },
          ],
        },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'controller.js')).href);

  const status = await statusFor(conn, result.key);
  const chosenLog = status.recentLogs[0];
  assert.strictEqual(chosenLog.chosenPath, 'controller.js');
  const log4jsFrame = chosenLog.frames.find((f) => f.url.includes('log4js'));
  assert.strictEqual(log4jsFrame.skipReason, 'skip-pattern');
  assert.strictEqual(log4jsFrame.matchedPattern, '**/log4js/**');
});

test('LSP: ejsng.runtimeLog.skipFrames adds a user pattern for a team-vendored logger wrapper, without disabling the built-in defaults', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-userskip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'shared', 'our-logger'), { recursive: true });
  writeFileSync(join(root, 'shared', 'our-logger', 'index.js'), 'function log() { console.log(); }\n');
  writeFileSync(join(root, 'service.js'), 'function run() { ourLogger.log("go"); }\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'go' }],
        stackTrace: {
          callFrames: [
            { url: join(root, 'shared', 'our-logger', 'index.js'), lineNumber: 0, columnNumber: 17 },
            { url: join(root, 'service.js'), lineNumber: 0, columnNumber: 17 },
          ],
        },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root, { runtimeLog: { skipFrames: ['**/our-logger/**'] } });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'service.js')).href);
});

test('LSP: an obfuscated/minified top frame (almost no newlines) is skipped — the log falls back to the nearest readable frame', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-obfuscated-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A large single-line "bundle" — no source map, effectively unreadable at any specific line.
  writeFileSync(join(root, 'bundle.min.js'), `(function(){${'a=1;'.repeat(200)}})();`);
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'from bundle' }],
        stackTrace: {
          callFrames: [
            { url: join(root, 'bundle.min.js'), lineNumber: 0, columnNumber: 5 },
            { url: join(root, 'app.js'), lineNumber: 0, columnNumber: 0 },
          ],
        },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'app.js')).href);

  const status = await statusFor(conn, result.key);
  const obfuscatedFrame = status.recentLogs[0].frames.find((f) => f.url.includes('bundle.min.js'));
  assert.strictEqual(obfuscatedFrame.skipReason, 'obfuscated');
});

test('LSP: a top frame outside the workspace does not block a later, perfectly good frame — selection keeps trying, not just the top of the stack', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-fallthrough-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const outsideDir = mkdtempSync(join(tmpdir(), 'ejsng-frame-fallthrough-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'outside.js'), 'console.log(2);\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'still lands' }],
        stackTrace: {
          callFrames: [
            { url: join(outsideDir, 'outside.js'), lineNumber: 0, columnNumber: 0 }, // sibling of root, not inside it
            { url: join(root, 'app.js'), lineNumber: 0, columnNumber: 0 },
          ],
        },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'app.js')).href);
  assert.strictEqual(runtimeLogs[0].value, 'still lands');

  const status = await statusFor(conn, result.key);
  assert.strictEqual(status.drawn, 1);
  assert.deepStrictEqual(status.droppedByReason, {});
  const outsideFrame = status.recentLogs[0].frames.find((f) => f.url.includes('outside.js'));
  assert.strictEqual(outsideFrame.skipReason, 'outside-workspace');
});

test('LSP: every candidate frame is outside the workspace — dropped under the SPECIFIC reason (outside-workspace), not a generic all-frames-skipped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-alloutside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const outsideDir = mkdtempSync(join(tmpdir(), 'ejsng-frame-alloutside-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'a.js'), 'console.log(1);\n');
  writeFileSync(join(outsideDir, 'b.js'), 'console.log(2);\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'nope' }],
        stackTrace: {
          callFrames: [
            { url: join(outsideDir, 'a.js'), lineNumber: 0, columnNumber: 0 },
            { url: join(outsideDir, 'b.js'), lineNumber: 0, columnNumber: 0 },
          ],
        },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  let status;
  const deadline = Date.now() + 3000;
  for (;;) {
    status = await statusFor(conn, result.key);
    if (status?.received === 1) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for the log to be received');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.strictEqual(runtimeLogs.length, 0);
  assert.deepStrictEqual(status.droppedByReason, { 'outside-workspace': 1 });
});

test('LSP: every frame skipped (all node_modules) — the log draws nowhere, is counted under all-frames-skipped, and the panel still sees the full attempt', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-allskip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app',
      url: 'file:///app.js',
      event: {
        type: 'log',
        args: [{ type: 'string', value: 'should not draw' }],
        stackTrace: {
          callFrames: [
            { url: join(root, 'node_modules', 'a', 'index.js'), lineNumber: 0, columnNumber: 0 },
            { url: 'node:internal/modules/cjs/loader', lineNumber: 1, columnNumber: 0 },
          ],
        },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  // No deterministic event to wait FOR (proving something does NOT happen) — poll runtimeStatus
  // (an async request) until the log has been received and processed.
  let status;
  const deadline = Date.now() + 3000;
  for (;;) {
    status = await statusFor(conn, result.key);
    if (status?.received === 1) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for the log to be received');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.strictEqual(runtimeLogs.length, 0);
  assert.strictEqual(status.drawn, 0);
  assert.deepStrictEqual(status.droppedByReason, { 'all-frames-skipped': 1 });

  const diagnostic = status.recentLogs[0];
  assert.strictEqual(diagnostic.chosenPath, null);
  assert.strictEqual(diagnostic.frames.length, 2);
  assert.strictEqual(diagnostic.frames[0].skipReason, 'skip-pattern');
  assert.strictEqual(diagnostic.frames[0].matchedPattern, '**/node_modules/**');
  assert.strictEqual(diagnostic.frames[1].skipReason, 'skip-pattern');
  assert.strictEqual(diagnostic.frames[1].matchedPattern, 'node:internal/**');
});

test('LSP: ANSI color codes are stripped from the log value before it is drawn', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-ansi-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'app.js'), 'console.log(1);\n');

  const runtime = await startFakeRuntime(t, [
    {
      id: 't1',
      type: 'node',
      title: 'app',
      url: 'file:///app.js',
      event: {
        // Simulates log4js's colored layout: SGR codes wrapping the actual text.
        type: 'log',
        args: [{ type: 'string', value: '[32m[INFO][39m request handled' }],
        stackTrace: { callFrames: [{ url: join(root, 'app.js'), lineNumber: 0, columnNumber: 0 }] },
      },
    },
  ]);

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, '[INFO] request handled');
});

test('LSP: ejsng/runtimeStatus reports a wrapper-file suggestion once one file dominates recently chosen frames', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-frame-wrapper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'log.js'), 'function w() { console.log(1); }\n');

  const runtime = await startFakeRuntime(t, [{ id: 't1', type: 'node', title: 'app', url: 'file:///app.js' }]);
  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');

  // 20 logs, all anchored to the SAME file — well over the default wrapper-suggestion threshold.
  for (let i = 0; i < 20; i++) {
    runtime.sendEvent('t1', {
      type: 'log',
      args: [{ type: 'string', value: `hit ${i}` }],
      stackTrace: { callFrames: [{ url: join(root, 'log.js'), lineNumber: 0, columnNumber: 15 }] },
    });
  }

  let status;
  // An upper bound only — the loop leaves as soon as all 20 are drawn. 3 s was too tight once the
  // suite also ran real `node --inspect` tests in parallel (each log waits on a verification round-trip).
  const deadline = Date.now() + 10000;
  for (;;) {
    status = await statusFor(conn, result.key);
    if (status?.drawn === 20) break;
    if (Date.now() > deadline) throw new Error('timed out waiting for all 20 logs to be drawn');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.deepStrictEqual(status.wrapperSuggestion, { path: 'log.js', share: 1 });
});
