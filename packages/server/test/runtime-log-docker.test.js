/**
 * Seam 1 of ticket 04 (.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md):
 * `ejsng/discoverRuntimeTargets` end-to-end over LSP, with a fake `docker` CLI in a temp `PATH`
 * (packages/server/test/docker-fixture.js) standing in for the real thing. Pure parsing/matching
 * is covered in packages/core/test/runtime-log-docker.test.js — this file only exercises what
 * needs the real `execFile('docker', …)` adapter plus a real CDP round-trip: picking the right
 * container, falling back silently with no `docker` on PATH, and the actual connect.
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
const { writeFakeDockerCli, containerFixture, CITYOS_WORKER, CITYOS_DB } = require('./docker-fixture');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

/**
 * A combined discovery + CDP endpoint on a REAL, dynamically-assigned port — same shape as
 * runtime-log-path-mapping.test.js's `startFakeRuntime`. Returns the port so a docker fixture can
 * publish it as a container's "host inspector port", proving the adapter actually dials the port
 * `resolveDockerCandidates` inferred, not a hardcoded one.
 */
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

/**
 * Run `listDockerRuntimeCandidates()` in an ISOLATED child process whose `PATH` includes
 * `dockerDir` — used instead of a plain `require('../dist/docker').listDockerRuntimeCandidates()`
 * call so each test can point at its own fake `docker` without mutating this test file's own
 * `process.env`, which every other test here also relies on.
 */
async function listDockerRuntimeCandidatesWithFakeDocker(dockerDir) {
  const childEnv = { ...process.env, PATH: `${dockerDir}${delimiter}${process.env.PATH}` };
  const script =
    "const { listDockerRuntimeCandidates } = require(process.argv[1]);" +
    'listDockerRuntimeCandidates().then((c) => process.stdout.write(JSON.stringify(c)));';
  const child = spawn(process.execPath, ['-e', script, join(__dirname, '..', 'dist', 'docker.js')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: childEnv,
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  await new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture child exited ${code}`))));
    child.on('error', reject);
  });
  return JSON.parse(out);
}

test('ejsng/discoverRuntimeTargets: no docker on PATH falls back silently, no error', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-none-');
  const { conn } = await startServer(t, root); // no dockerPath -> empty PATH -> ENOENT on every call
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.deepStrictEqual(result, { status: 'no-docker-target' });
});

test('ejsng/discoverRuntimeTargets: docker present but no containers at all falls back silently', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-empty-');
  const docker = fakeDockerWithNoContainers();
  t.after(docker.cleanup);
  const { conn } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.deepStrictEqual(result, { status: 'no-docker-target' });
});

test('ejsng/discoverRuntimeTargets: exactly one connectable container connects immediately, including an unusual remapped port (9228->9229-shaped)', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-one-');
  // A real file under `root`, so the log isn't dropped by the outside-workspace guard — this
  // test is about discovery/connect, not path mapping (ticket 05's concern), so the CDP event
  // reports a URL that's already a real on-disk path rather than a container-internal one.
  writeFileSync(join(root, 'server.js'), 'console.log("hello from cityos-web");\n');
  const inspectorPort = await startFakeInspector(t, {
    event: {
      type: 'log',
      args: [{ type: 'string', value: 'hello from cityos-web' }],
      stackTrace: { callFrames: [{ url: pathToFileURL(join(root, 'server.js')).href, lineNumber: 0, columnNumber: 0 }] },
    },
  });
  // The fixture's inspector-port CONTAINER side (9229) deliberately does NOT equal the host port
  // actually dialed (`inspectorPort`, a random ephemeral port) — exactly the 9228->9229 shape:
  // matching must go by the CONTAINER side of the pair, never by assuming host === container.
  const web = containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(inspectorPort) }],
      },
    },
  });
  const docker = writeFakeDockerCli([web]);
  t.after(docker.cleanup);

  const { conn, runtimeLogs } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.strictEqual(result.status, 'connected');
  assert.strictEqual(result.host, '127.0.0.1');
  assert.strictEqual(result.port, inspectorPort);

  await waitUntil(() => runtimeLogs.some((l) => l.value === 'hello from cityos-web'));
});

test('ejsng/discoverRuntimeTargets: typing the app port finds the container that publishes it', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-appport-');
  const webInspectorPort = await startFakeInspector(t, { id: 'web-target' });
  const appInspectorPort = await startFakeInspector(t, { id: 'app-target' });
  const web = containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(webInspectorPort) }],
      },
    },
  });
  const appC = containerFixture({
    Id: 'a2'.padEnd(64, '2'),
    Name: '/cityos-app',
    Config: { Cmd: [], Env: ['NODE_OPTIONS=--inspect=0.0.0.0:9229'] },
    NetworkSettings: {
      Ports: {
        '5001/tcp': [{ HostIp: '0.0.0.0', HostPort: '5001' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(appInspectorPort) }],
      },
    },
  });
  const docker = writeFakeDockerCli([web, appC]);
  t.after(docker.cleanup);

  const { conn } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', { appPort: 5001 });
  assert.strictEqual(result.status, 'connected');
  assert.strictEqual(result.port, appInspectorPort); // cityos-app's inspector, not cityos-web's
});

test('ejsng/discoverRuntimeTargets: multiple connectable containers -> choose-container, labeled "<name>: <app port>"', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-multi-');
  const webInspectorPort = await startFakeInspector(t, { id: 'web-target' });
  const appInspectorPort = await startFakeInspector(t, { id: 'app-target' });
  const web = containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(webInspectorPort) }],
      },
    },
  });
  const appC = containerFixture({
    Id: 'a2'.padEnd(64, '2'),
    Name: '/cityos-app',
    Config: { Cmd: [], Env: ['NODE_OPTIONS=--inspect=0.0.0.0:9229'] },
    NetworkSettings: {
      Ports: {
        '5001/tcp': [{ HostIp: '0.0.0.0', HostPort: '5001' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(appInspectorPort) }],
      },
    },
  });
  const docker = writeFakeDockerCli([web, appC]);
  t.after(docker.cleanup);

  const { conn } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.strictEqual(result.status, 'choose-container');
  const labels = result.candidates.map((c) => c.label).sort();
  assert.deepStrictEqual(labels, ['cityos-app: 5001', 'cityos-web: 5000']);
  const webCandidate = result.candidates.find((c) => c.label === 'cityos-web: 5000');
  assert.strictEqual(webCandidate.port, webInspectorPort);

  // The chosen candidate's host:port is directly usable with the EXISTING, unchanged
  // ejsng/connectRuntime — no new follow-up request needed for this step.
  const connected = await conn.sendRequest('ejsng/connectRuntime', { host: webCandidate.host, port: webCandidate.port });
  assert.strictEqual(connected.status, 'connected');
});

test('ejsng/discoverRuntimeTargets: a container running Node with no published inspector port is reported by name, not silently dropped', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-unreachable-');
  const docker = writeFakeDockerCli([CITYOS_WORKER]);
  t.after(docker.cleanup);
  const { conn } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.deepStrictEqual(result, { status: 'unreachable-containers', containers: ['cityos-worker'] });
});

test('ejsng/discoverRuntimeTargets: an unreachable container is still reported even when another one connects fine', async (t) => {
  // Regression: connecting cityos-web must not make cityos-worker (Node, --inspect enabled, no
  // published inspector port) silently disappear — checklist item 6 applies regardless of
  // whether something else happened to be connectable.
  const root = tmpRoot(t, 'ejsng-docker-mixed-');
  writeFileSync(join(root, 'server.js'), 'console.log("hi");\n');
  const inspectorPort = await startFakeInspector(t, { id: 'web-target' });
  const web = containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(inspectorPort) }],
      },
    },
  });
  const docker = writeFakeDockerCli([web, CITYOS_WORKER]);
  t.after(docker.cleanup);

  const { conn } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.strictEqual(result.status, 'connected');
  assert.deepStrictEqual(result.unreachable, ['cityos-worker']);
});

test('ejsng/discoverRuntimeTargets: a non-Node container is never surfaced as a candidate at all', async (t) => {
  const root = tmpRoot(t, 'ejsng-docker-nonnode-');
  const docker = writeFakeDockerCli([CITYOS_DB]);
  t.after(docker.cleanup);
  const { conn } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.deepStrictEqual(result, { status: 'no-docker-target' });
});

test('listDockerRuntimeCandidates: mounts survive the real docker/JSON round-trip, nested/overlapping included (ticket 05 depends on this shape)', async (t) => {
  // This ticket only needs to prove the shape survives end-to-end through the REAL
  // execFile('docker', …) adapter (not just parseDockerInspect on synthetic already-parsed JSON,
  // which packages/core/test/runtime-log-docker.test.js already covers) — ticket 05 (blocked on
  // this one) is the one that actually applies longest-destination-wins path mapping from it.
  // Runs the adapter in an isolated child process (its own PATH) rather than mutating this test
  // process's env, which every other test in this file also relies on.
  const web = containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: '19229' }],
      },
    },
    Mounts: [
      { Type: 'bind', Source: '/home/user/projects/aocs-cityos-lusail', Destination: '/home/cityos/aocs-cityos', Mode: 'rw', RW: true, Propagation: 'rprivate' },
      { Type: 'bind', Source: '/home/user/projects/aocs', Destination: '/home/cityos/aocs-cityos/aocs', Mode: 'rw', RW: true, Propagation: 'rprivate' },
    ],
  });
  const docker = writeFakeDockerCli([web]);
  t.after(docker.cleanup);

  const candidates = await listDockerRuntimeCandidatesWithFakeDocker(docker.dir);
  assert.strictEqual(candidates.length, 1);
  assert.deepStrictEqual(candidates[0].mounts, [
    { source: '/home/user/projects/aocs-cityos-lusail', destination: '/home/cityos/aocs-cityos' },
    { source: '/home/user/projects/aocs', destination: '/home/cityos/aocs-cityos/aocs' },
  ]);
});

test('listDockerRuntimeCandidates: a container that vanishes between `ps` and `inspect` does not blank out every other candidate', async (t) => {
  // Real `docker inspect id1 id2` still prints the JSON it found for id1 even when id2 has
  // already stopped/been removed (exiting non-zero for id2 alone) — a genuine race between this
  // adapter's two calls on a host with short-lived containers, not a hypothetical. The fix: parse
  // whatever stdout DID come back rather than discarding it on any non-zero exit.
  const web = containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: '19229' }],
      },
    },
  });
  const docker = writeFakeDockerCli([web], { vanishedIds: ['deadbeef0000'] });
  t.after(docker.cleanup);

  const candidates = await listDockerRuntimeCandidatesWithFakeDocker(docker.dir);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].containerName, 'cityos-web');
});
