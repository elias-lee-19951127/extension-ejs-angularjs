/**
 * Seam 1 of ticket 09 (.scratch/runtime-remote-env/issues/09-panel-danh-sach-kiem-tra.md): the
 * checklist and "Copy report" end-to-end over LSP. The wording of each step is covered by
 * packages/core/test/runtime-log-checklist.test.js; this file proves the server feeds it the REAL
 * state of the Connect chain — the environment the client reported, what Docker found, which
 * container a connection came from, which mount carried a drawn log, and why logs were dropped.
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
const { writeFakeDockerCli, containerFixture, CITYOS_WORKER } = require('./docker-fixture');

const SERVER = join(__dirname, '..', 'dist', 'index.js');
const MOUNT_DESTINATION = '/home/cityos/aocs-cityos/aocs';

async function startFakeInspector(t, { id = 't1', events = [] } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id, type: 'node', title: 'www', url: 'file:///www.js', webSocketDebuggerUrl: `ws://placeholder/${id}` }]));
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
      socket.send(JSON.stringify({ id: msg.id, result: {} }));
      if (msg.method === 'Runtime.enable') {
        for (const params of events) socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

async function startServer(t, root, { dockerPath, home, environment } = {}) {
  const env = { ...process.env, HOME: home ?? process.env.HOME };
  env.PATH = dockerPath ? `${dockerPath}${delimiter}${process.env.PATH}` : '';
  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'], env });
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
    initializationOptions: { runtimeLog: { environment } },
  });
  conn.sendNotification('initialized', {});
  await conn.sendRequest('ejsng/stats');
  return { conn, runtimeLogs };
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

function consoleEvent(value, url) {
  return { type: 'log', args: [{ type: 'string', value }], stackTrace: { callFrames: [{ url, lineNumber: 0, columnNumber: 0 }] } };
}

function webContainer(inspectorPort, source) {
  return containerFixture({
    Id: 'w1'.padEnd(64, '1'),
    Name: '/cityos-web',
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'bin/www'], Env: [] },
    NetworkSettings: {
      Ports: {
        '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
        '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: String(inspectorPort) }],
      },
    },
    Mounts: [
      { Type: 'bind', Source: source, Destination: MOUNT_DESTINATION, Mode: 'rw', RW: true, Propagation: 'rprivate' },
      // A config mount no log ever goes through — must not be offered for saving.
      { Type: 'bind', Source: join(source, '..', 'config'), Destination: '/etc/cityos', Mode: 'ro', RW: false, Propagation: 'rprivate' },
    ],
  });
}

async function waitForChecklist(conn, predicate, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const { steps } = await conn.sendRequest('ejsng/runtimeChecklist', {});
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    if (predicate(byId)) return byId;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for checklist: ${JSON.stringify(byId, null, 2)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('checklist: before Connect runs, every step is pending and nothing has been probed', async (t) => {
  const root = tmpRoot(t, 'ejsng-checklist-idle-');
  const { conn } = await startServer(t, root);
  const { steps } = await conn.sendRequest('ejsng/runtimeChecklist', {});
  assert.deepStrictEqual(
    steps.map((s) => [s.id, s.status]),
    [
      ['environment', 'pending'],
      ['docker', 'pending'],
      ['node', 'pending'],
      ['browser', 'pending'],
      ['path-mapping', 'pending'],
      ['logs', 'pending'],
    ],
  );
});

test('checklist: the environment the client reported via initializationOptions, plus Docker, show up after detection', async (t) => {
  const root = tmpRoot(t, 'ejsng-checklist-env-');
  const docker = writeFakeDockerCli([]);
  t.after(docker.cleanup);
  const { conn } = await startServer(t, root, { dockerPath: docker.dir, environment: { remoteName: 'ssh-remote', clientPlatform: 'win32' } });

  const environment = await conn.sendRequest('ejsng/detectRuntimeEnvironment');
  assert.strictEqual(environment.kind, 'ssh');
  assert.strictEqual(environment.remoteName, 'ssh-remote');
  assert.strictEqual(environment.clientPlatform, 'win32');
  assert.deepStrictEqual(environment.docker, { state: 'available', version: '27.1.1-fake' });

  const steps = await waitForChecklist(conn, (s) => s.environment.status === 'ok');
  assert.match(steps.environment.detail, /Remote-SSH/);
  assert.match(steps.docker.detail, /27\.1\.1-fake/);
});

test('checklist: no docker on PATH is reported as skipped, not as an error', async (t) => {
  const root = tmpRoot(t, 'ejsng-checklist-nodocker-');
  const { conn } = await startServer(t, root);
  const environment = await conn.sendRequest('ejsng/detectRuntimeEnvironment');
  assert.deepStrictEqual(environment.docker, { state: 'missing' });
  const steps = await waitForChecklist(conn, () => true);
  assert.strictEqual(steps.docker.status, 'skipped');
});

test('checklist: the full chain — container, connection, the mount a drawn log used, and drop reasons', async (t) => {
  const root = tmpRoot(t, 'ejsng-checklist-chain-');
  const aocs = join(root, 'aocs');
  writeFile(join(aocs, 'routes', 'index.js'), 'console.log("hit");\n');
  const inspectorPort = await startFakeInspector(t, {
    events: [
      consoleEvent('drawn', `${MOUNT_DESTINATION}/routes/index.js`),
      consoleEvent('unmapped', '/opt/elsewhere/job.js'),
    ],
  });
  const docker = writeFakeDockerCli([webContainer(inspectorPort, aocs), CITYOS_WORKER]);
  t.after(docker.cleanup);
  const { conn, runtimeLogs } = await startServer(t, root, { dockerPath: docker.dir });

  await conn.sendRequest('ejsng/detectRuntimeEnvironment');
  const discovered = await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  assert.strictEqual(discovered.status, 'connected');

  const steps = await waitForChecklist(conn, (s) => s.logs.counts.received === 2 && s.logs.counts.drawn + s.logs.counts.dropped === 2);
  assert.strictEqual(runtimeLogs.length, 1);

  assert.strictEqual(steps.docker.status, 'warn'); // cityos-worker never published its inspector
  assert.match(steps.docker.detail, /cityos-web: 5000/);
  assert.deepStrictEqual(steps.docker.fixes.map((f) => f.kind), ['copy-compose']);
  assert.match(steps.docker.fixes[0].snippet, /cityos-worker/);

  assert.strictEqual(steps.node.status, 'ok');
  assert.match(steps.node.detail, /cityos-web/);

  assert.strictEqual(steps['path-mapping'].status, 'fail');
  assert.deepStrictEqual(
    steps['path-mapping'].fixes.filter((f) => f.kind === 'save-mapping').map((f) => [f.remote, f.local]),
    [[MOUNT_DESTINATION, aocs]],
  );

  assert.deepStrictEqual(steps.logs.counts, { received: 2, drawn: 1, dropped: 1 });
  assert.deepStrictEqual(steps.logs.dropGroups.map((g) => [g.reason, g.count]), [['no-path-mapping', 1]]);
});

test('report: markdown of the same state, with the home directory replaced by ~', async (t) => {
  const home = tmpRoot(t, 'ejsng-checklist-home-');
  const root = join(home, 'projects', 'app');
  const aocs = join(root, 'aocs');
  writeFile(join(aocs, 'routes', 'index.js'), 'console.log("hit");\n');
  const inspectorPort = await startFakeInspector(t, { events: [consoleEvent('drawn', `${MOUNT_DESTINATION}/routes/index.js`)] });
  const docker = writeFakeDockerCli([webContainer(inspectorPort, aocs)]);
  t.after(docker.cleanup);
  const { conn } = await startServer(t, root, { dockerPath: docker.dir, home, environment: { remoteName: 'wsl', clientPlatform: 'win32' } });

  await conn.sendRequest('ejsng/detectRuntimeEnvironment');
  await conn.sendRequest('ejsng/discoverRuntimeTargets', {});
  await waitForChecklist(conn, (s) => s.logs.counts.drawn === 1);

  const { markdown } = await conn.sendRequest('ejsng/runtimeReport', { browser: 'chrome.exe', version: '9.9.9' });
  assert.match(markdown, /Version: 9\.9\.9/);
  assert.match(markdown, /Environment: Remote-WSL/);
  assert.match(markdown, /Docker: available \(27\.1\.1-fake\)/);
  assert.match(markdown, /Endpoints: node cityos-web \(127\.0\.0\.1:\d+\) connected/);
  assert.match(markdown, /Browser: chrome\.exe/);
  assert.ok(markdown.includes('~/projects/app/aocs'), markdown);
  assert.ok(!markdown.includes(home), markdown);
});
