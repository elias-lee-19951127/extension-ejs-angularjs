/**
 * The Remote-WSL report of 2026-09-19, end to end over LSP: `ejsng.runtimeLog.pathMappings` written
 * with Windows `\\wsl.localhost\…` paths and the broad mount listed before the nested one. Every
 * log under the nested mount used to be dropped as "file not readable" with no hint why. Pure
 * pieces are in packages/core/test/runtime-log-wsl-mappings.test.js.
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
    const check = async () => {
      if (await predicate()) return resolve();
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


/** `/a/b` as Windows Explorer shows a path inside a WSL distro: `\\wsl.localhost\AlmaLinux-9\a\b`. */
const asWslUnc = (p) => `\\\\wsl.localhost\\AlmaLinux-9${p.replace(/\//g, '\\')}`;

function logFrom(...urls) {
  return {
    type: 'log',
    args: [{ type: 'string', value: 'done' }],
    stackTrace: { callFrames: urls.map((url) => ({ url, lineNumber: 1, columnNumber: 2 })) },
  };
}

test('LSP: UNC paths + broad-mount-first settings still draw a log under the nested mount, in the nested copy', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ejsng-wsl-mappings-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const lusail = join(base, 'aocs-cityos-lusail'); // the open workspace
  const aocs = join(base, 'aocs'); // mounted over lusail's own aocs/ inside the container
  mkdirSync(join(lusail, 'aocs'), { recursive: true });
  mkdirSync(join(aocs, 'services'), { recursive: true });
  writeFileSync(join(lusail, 'www.js'), 'start();\n');
  writeFileSync(join(aocs, 'services', 'svc.js'), 'function complete() {\n  console.log("done");\n}\n');

  const runtime = await startFakeRuntime(t, [{ id: 't1', type: 'node', title: 'www', url: 'file:///www' }]);
  const { conn, runtimeLogs } = await startServer(t, lusail, {
    runtimeLog: {
      pathMappings: [
        { remote: '/home/cityos/aocs-cityos', local: asWslUnc(lusail) },
        { remote: '/home/cityos/aocs-cityos/aocs', local: asWslUnc(aocs) },
      ],
    },
  });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');
  // `connected` above means "connecting started"; a log sent before the socket opens is lost.
  await waitUntil(async () => (await statusFor(conn, result.key))?.state === 'connected');

  runtime.sendEvent('t1', logFrom('node:events', 'file:///home/cityos/aocs-cityos/aocs/services/svc.js'));
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(aocs, 'services', 'svc.js')).href);
  assert.strictEqual(runtimeLogs[0].range.start.line, 1);

  const status = await statusFor(conn, result.key);
  const events = status.recentLogs[0].frames.find((f) => f.url === 'node:events');
  assert.strictEqual(events.skipReason, 'skip-pattern');
  assert.strictEqual(events.matchedPattern, 'node:*');
});

test('LSP: a mapped file that does not exist is reported with the path tried; the same stack repeated keeps one counted entry', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ejsng-wsl-unreadable-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'app'), { recursive: true });
  writeFileSync(join(base, 'app', 'service.js'), 'function complete() {\n  console.log("done");\n}\n');

  const runtime = await startFakeRuntime(t, [{ id: 't1', type: 'node', title: 'www', url: 'file:///www' }]);
  const { conn, runtimeLogs } = await startServer(t, join(base, 'app'), {
    runtimeLog: { pathMappings: [{ remote: '/srv', local: join(base, 'app') }] },
  });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: runtime.host, port: runtime.port });
  assert.strictEqual(result.status, 'connected');
  // `connected` above means "connecting started"; a log sent before the socket opens is lost.
  await waitUntil(async () => (await statusFor(conn, result.key))?.state === 'connected');

  for (let i = 0; i < 3; i++) runtime.sendEvent('t1', logFrom('/srv/messaging/do.js'));
  runtime.sendEvent('t1', logFrom('/srv/service.js'));
  await waitUntil(() => runtimeLogs.length === 1);

  const status = await statusFor(conn, result.key);
  assert.strictEqual(status.recentLogs.length, 2, 'three identical stacks, one entry');
  const [noisy, drawn] = status.recentLogs;
  assert.strictEqual(noisy.count, 3);
  assert.deepStrictEqual(
    { skipReason: noisy.frames[0].skipReason, hostPath: noisy.frames[0].hostPath },
    { skipReason: 'unreadable-file', hostPath: join(base, 'app', 'messaging', 'do.js') },
  );
  assert.strictEqual(drawn.chosenPath, 'service.js');
});
