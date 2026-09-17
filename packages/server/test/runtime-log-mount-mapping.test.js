/**
 * Ticket 05 (.scratch/runtime-remote-env/issues/05-path-mapping-tu-mount.md) end-to-end over LSP:
 * a log whose Runtime Path exists only inside the container is drawn on the right file on this
 * machine, using mappings inferred from the connected container's OWN mounts — through the real
 * `execFile('docker', …)` adapter, with the fake `docker` CLI from ./docker-fixture.js.
 *
 * The pure ordering/matching logic is covered in packages/core/test/runtime-log-docker.test.js.
 * What only this level can prove: the mounts of the container actually connected to reach the
 * connection that draws the log, a user's own mapping beats them, and a path no mapping covers is
 * counted under its own reason instead of vanishing.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, delimiter, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { WebSocketServer } = require('ws');
const { writeFakeDockerCli, containerFixture } = require('./docker-fixture');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

/** The container-internal paths of the spec's real machine — see decisions.md / docker-fixture.js. */
const OUTER_DESTINATION = '/home/cityos/aocs-cityos';
const INNER_DESTINATION = '/home/cityos/aocs-cityos/aocs';
/** A file the container reports from INSIDE the inner mount — i.e. under both mounts' destinations. */
const CONTAINER_LOG_PATH = `${INNER_DESTINATION}/utility/log.js`;

/** A combined discovery + CDP endpoint, same shape as this suite's other runtime-log tests. */
async function startFakeInspector(t, { id = 't1', event } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id, type: 'node', title: 'app', url: 'file:///app.js', webSocketDebuggerUrl: `ws://placeholder/${id}` }]));
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

async function startServer(t, root, { dockerPath, initializationOptions = {} } = {}) {
  const env = { ...process.env };
  env.PATH = dockerPath ? `${dockerPath}${delimiter}${process.env.PATH}` : '';
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

function tmpRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * The nested-mount layout of the spec's real machine, laid out as REAL directories so both
 * candidate resolutions point at a file that actually exists on disk — the only way the test can
 * tell "picked the right one" from "the wrong one happened to be unreadable":
 *
 *   <root>/aocs                 mounted at /home/cityos/aocs-cityos/aocs   (inner — the repo really running)
 *   <root>/lusail               mounted at /home/cityos/aocs-cityos        (outer — shadows the path above)
 *
 * `<root>/lusail/aocs/utility/log.js` exists too: it is the SHADOWED copy, the file a
 * name-based guess (or outer-mount-first ordering) would wrongly draw the log on.
 */
function writeNestedMountLayout(root) {
  const inner = join(root, 'aocs');
  const outer = join(root, 'lusail');
  writeFile(join(inner, 'utility', 'log.js'), 'console.log("running copy");\n');
  writeFile(join(outer, 'aocs', 'utility', 'log.js'), 'console.log("shadowed copy");\n');
  return { inner, outer };
}

function consoleEvent(value, url) {
  return {
    type: 'log',
    args: [{ type: 'string', value }],
    stackTrace: { callFrames: [{ url, lineNumber: 0, columnNumber: 0 }] },
  };
}

function nestedMountContainer(inspectorPort, { inner, outer }) {
  return containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(inspectorPort) }],
      },
    },
    // Listed OUTER FIRST, the order `docker inspect` reports them — the ordering fix must come
    // from the mapping code, not from the fixture happening to be in a convenient order.
    Mounts: [
      { Type: 'bind', Source: outer, Destination: OUTER_DESTINATION, Mode: 'rw', RW: true, Propagation: 'rprivate' },
      { Type: 'bind', Source: inner, Destination: INNER_DESTINATION, Mode: 'rw', RW: true, Propagation: 'rprivate' },
    ],
  });
}

test('nested mounts: a log from the shadowed path is drawn on the repo actually running, not the shadowed one', async (t) => {
  const root = tmpRoot(t, 'ejsng-mounts-nested-');
  const layout = writeNestedMountLayout(root);
  const inspectorPort = await startFakeInspector(t, { event: consoleEvent('from the running repo', CONTAINER_LOG_PATH) });
  const docker = writeFakeDockerCli([nestedMountContainer(inspectorPort, layout)]);
  t.after(docker.cleanup);

  const { conn, runtimeLogs } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].value, 'from the running repo');
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(layout.inner, 'utility', 'log.js')).href);
});

test('nested mounts: the inferred mapping survives the choose-container follow-up connect, not just the immediate one', async (t) => {
  // Two connectable containers -> the client gets `choose-container` and follows up with a plain
  // ejsng/connectRuntime on the picked host:port, which carries no container identity at all.
  const root = tmpRoot(t, 'ejsng-mounts-choose-');
  const layout = writeNestedMountLayout(root);
  const webPort = await startFakeInspector(t, { id: 'web-target', event: consoleEvent('from the running repo', CONTAINER_LOG_PATH) });
  const otherPort = await startFakeInspector(t, { id: 'other-target' });
  const other = containerFixture({
    Id: 'a2'.padEnd(64, '2'),
    Name: '/cityos-app',
    Config: { Cmd: [], Env: ['NODE_OPTIONS=--inspect=0.0.0.0:9229'] },
    NetworkSettings: {
      Ports: {
        '5001/tcp': [{ HostIp: '0.0.0.0', HostPort: '5001' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(otherPort) }],
      },
    },
  });
  const docker = writeFakeDockerCli([nestedMountContainer(webPort, layout), other]);
  t.after(docker.cleanup);

  const { conn, runtimeLogs } = await startServer(t, root, { dockerPath: docker.dir });
  const result = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.strictEqual(result.status, 'choose-container');
  const web = result.candidates.find((c) => c.label === 'cityos-web: 5000');
  const connected = await conn.sendRequest('ejsng/connectRuntime', { host: web.host, port: web.port });
  assert.strictEqual(connected.status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(layout.inner, 'utility', 'log.js')).href);
});

test('a user-declared pathMapping beats the mapping inferred from the container mount', async (t) => {
  const root = tmpRoot(t, 'ejsng-mounts-user-wins-');
  const layout = writeNestedMountLayout(root);
  const override = join(root, 'override');
  writeFile(join(override, 'utility', 'log.js'), 'console.log("user override");\n');
  const inspectorPort = await startFakeInspector(t, { event: consoleEvent('user mapping wins', CONTAINER_LOG_PATH) });
  const docker = writeFakeDockerCli([nestedMountContainer(inspectorPort, layout)]);
  t.after(docker.cleanup);

  const { conn, runtimeLogs } = await startServer(t, root, {
    dockerPath: docker.dir,
    initializationOptions: { runtimeLog: { pathMappings: [{ remote: INNER_DESTINATION, local: override }] } },
  });
  assert.strictEqual((await conn.sendRequest('ejsng/discoverRuntimeTargets', {})).status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(override, 'utility', 'log.js')).href);
});

test('a user-declared pathMapping may write its local side as ${workspaceFolder}/…', async (t) => {
  const root = tmpRoot(t, 'ejsng-mounts-workspacefolder-');
  const layout = writeNestedMountLayout(root);
  const inspectorPort = await startFakeInspector(t, { event: consoleEvent('resolved via variable', CONTAINER_LOG_PATH) });
  const docker = writeFakeDockerCli([nestedMountContainer(inspectorPort, layout)]);
  t.after(docker.cleanup);

  const { conn, runtimeLogs } = await startServer(t, root, {
    dockerPath: docker.dir,
    // The same override the previous test writes as an absolute path — proving a mapping like
    // this can be committed to a repo's settings instead of hardcoding one machine's path.
    initializationOptions: { runtimeLog: { pathMappings: [{ remote: INNER_DESTINATION, local: '${workspaceFolder}/lusail/aocs' }] } },
  });
  assert.strictEqual((await conn.sendRequest('ejsng/discoverRuntimeTargets', {})).status, 'connected');

  await waitUntil(() => runtimeLogs.length > 0);
  assert.strictEqual(runtimeLogs[0].uri, pathToFileURL(join(layout.outer, 'aocs', 'utility', 'log.js')).href);
});

test('a path no mapping covers is dropped and counted as no-path-mapping, never silently', async (t) => {
  const root = tmpRoot(t, 'ejsng-mounts-uncovered-');
  const layout = writeNestedMountLayout(root);
  // Reported from a directory NO mount covers — a nested/sibling container path the user never
  // mounted (a dependency baked into the image, say).
  const inspectorPort = await startFakeInspector(t, { event: consoleEvent('nowhere to draw this', '/opt/vendor/lib/thing.js') });
  const docker = writeFakeDockerCli([nestedMountContainer(inspectorPort, layout)]);
  t.after(docker.cleanup);

  const { conn, runtimeLogs } = await startServer(t, root, { dockerPath: docker.dir });
  assert.strictEqual((await conn.sendRequest('ejsng/discoverRuntimeTargets', {})).status, 'connected');

  // Wait on a HANDLED log, not merely a received one: `received` is bumped synchronously when the
  // event arrives, while the verdict lands after ticket 06's verification round-trip.
  const status = await waitForStatus(conn, (s) => {
    const c = s.connections[0];
    return c != null && c.drawn + Object.values(c.droppedByReason).reduce((a, b) => a + b, 0) > 0;
  });
  const [connection] = status.connections;
  assert.strictEqual(connection.drawn, 0);
  assert.strictEqual(connection.droppedByReason['no-path-mapping'], 1);
  assert.strictEqual(runtimeLogs.length, 0);
  // The panel can show WHICH frame had no mapping, not just a total (ticket 03's diagnostics).
  assert.deepStrictEqual(
    connection.recentLogs[0].frames.map((f) => f.skipReason),
    ['no-path-mapping'],
  );
});

async function waitForStatus(conn, predicate, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const status = await conn.sendRequest('ejsng/runtimeStatus');
    if (predicate(status)) return status;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for runtime status');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
