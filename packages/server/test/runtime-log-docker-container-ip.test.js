/**
 * A Docker container whose inspector port was never published (`--inspect=0.0.0.0:9229`, no
 * `9229` in `ports`) is still connected to, at the container's own IP — routable when Docker
 * Engine runs on the same Linux host as the extension (inside WSL, say). Nothing about the
 * container is touched: one GET of `/json/list` decides. The fake `docker inspect` reports
 * 127.0.0.1 as the container IP, which is what makes that probe answerable on any test machine.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, delimiter } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { WebSocketServer } = require('ws');
const { writeFakeDockerCli, containerFixture } = require('./docker-fixture');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

async function startFakeInspector(t, { id = 't1', title = 'app', url = 'file:///app.js', event } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id, type: 'node', title, url, webSocketDebuggerUrl: `ws://placeholder/${id}` }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    if (req.url.slice(1) !== id) return;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.enable') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
        if (event) socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: event }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

/** A fake `docker` CLI reporting no containers at all — same effective shape as `docker` not being installed for this adapter's purposes, but exercises the real subprocess path instead of ENOENT. */
function fakeDockerWithNoContainers() {
  return writeFakeDockerCli([]);
}

async function startServer(t, root, { dockerPath } = {}) {
  const env = { ...process.env };
  if (dockerPath) {
    env.PATH = `${dockerPath}${delimiter}${process.env.PATH}`;
  } else {
    // Simulate "no docker on PATH" precisely, regardless of what's actually installed on the
    // machine running this test — an empty PATH means every `execFile('docker', …)` call fails
    // with ENOENT, the real-world "not on PATH" case (checklist item 1).
    env.PATH = '';
  }
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'], env });
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

function tmpRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}


/** `cityos-app` as reported 2026-09-19: Node 16 with `--inspect=0.0.0.0:<port>`, app ports published, inspector not. */
function unpublishedApp(inspectorPort, ip, mounts = []) {
  return containerFixture({
    Id: 'a1'.padEnd(64, '1'),
    Name: '/cityos-app',
    Config: { Cmd: ['node', `--inspect=0.0.0.0:${inspectorPort}`, '/home/cityos/aocs-cityos/aocs/runtime/bin/www'], Env: [] },
    NetworkSettings: {
      Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }], [`${inspectorPort}/tcp`]: null },
      Networks: { cityos: { IPAddress: ip } },
    },
    Mounts: mounts,
  });
}

test('ejsng/discoverRuntimeTargets: an unpublished inspector answering at the container IP connects there, with the container mounts as mappings', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-container-ip-');
  writeFileSync(join(root, 'service.js'), 'function complete() {\n  console.log("done");\n}\n');
  const inspectorPort = await startFakeInspector(t, {
    event: {
      type: 'log',
      args: [{ type: 'string', value: 'done' }],
      stackTrace: { callFrames: [{ url: '/home/cityos/app/service.js', lineNumber: 1, columnNumber: 2 }] },
    },
  });
  const docker = writeFakeDockerCli([unpublishedApp(inspectorPort, '127.0.0.1', [{ Source: root, Destination: '/home/cityos/app' }])]);
  t.after(docker.cleanup);

  const { conn, runtimeLogs } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.deepStrictEqual({ status: result.status, host: result.host, port: result.port, unreachable: result.unreachable }, {
    status: 'connected',
    host: '127.0.0.1',
    port: inspectorPort,
    unreachable: [],
  });

  // The mount-inferred mapping followed the connection to its container-IP endpoint.
  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(root, 'service.js')).href);
  assert.strictEqual(runtimeLogs[0].source, 'cityos-app', 'the hover names the container');

});

test('ejsng/discoverRuntimeTargets: nothing answering at the container IP leaves it reported as unreachable, as before', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-container-ip-dead-');
  // A port that was just free: connection refused, fast.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const docker = writeFakeDockerCli([unpublishedApp(deadPort, '127.0.0.1')]);
  t.after(docker.cleanup);
  const { conn } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.deepStrictEqual(result, { status: 'unreachable-containers', containers: ['cityos-app'] });
});
