/**
 * Seam 1 of ticket 10 (.scratch/runtime-remote-env/issues/10-launch-trinh-duyet-phia-ui.md): the
 * two probes the client's Launch flow runs over LSP. Starting the browser itself (registry,
 * WSL interop, spawning) is deliberately not automated — see the manual checklist in the ticket.
 *
 * - `ejsng/listDockerContainers` gives the app ports to open WITHOUT connecting to anything.
 * - `ejsng/findBrowserTarget` looks once for the app's tab; the client polls it, then connects
 *   with the existing `ejsng/connectRuntimeTarget`.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, delimiter } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { WebSocketServer } = require('ws');
const { writeFakeDockerCli, CITYOS_WEB, CITYOS_WORKER } = require('./docker-fixture');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

async function startServer(t, root, { dockerPath } = {}) {
  const env = { ...process.env };
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
  await conn.sendRequest('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'tmp' }], capabilities: {} });
  conn.sendNotification('initialized', {});
  await conn.sendRequest('ejsng/stats');
  return { conn, runtimeLogs };
}

function tmpRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A fake browser debug endpoint whose tab list the test changes over time, like a tab navigating through a login. */
async function startFakeBrowser(t) {
  const state = { pages: [] };
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          state.pages.map((p) => ({ id: p.id, type: 'page', title: p.id, url: p.url, webSocketDebuggerUrl: `ws://placeholder/${p.id}` })),
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  state.connectedIds = [];
  wss.on('connection', (socket, req) => {
    state.connectedIds.push(req.url.slice(1));
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  state.port = server.address().port;
  return state;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('listDockerContainers: reports every Node container with its app ports, and connects to none of them', async (t) => {
  const root = tmpRoot(t, 'ejsng-launch-containers-');
  const docker = writeFakeDockerCli([CITYOS_WEB, CITYOS_WORKER]);
  t.after(docker.cleanup);
  const { conn } = await startServer(t, root, { dockerPath: docker.dir });

  const { containers } = await conn.sendRequest('ejsng/listDockerContainers');
  assert.deepStrictEqual(
    containers.map((c) => [c.name, c.appPorts]),
    [
      ['cityos-web', [5000]],
      ['cityos-worker', []],
    ],
  );
  const status = await conn.sendRequest('ejsng/runtimeStatus');
  assert.deepStrictEqual(status.connections, []);
});

test('listDockerContainers: no docker on PATH is simply an empty list', async (t) => {
  const root = tmpRoot(t, 'ejsng-launch-nodocker-');
  const { conn } = await startServer(t, root);
  assert.deepStrictEqual(await conn.sendRequest('ejsng/listDockerContainers'), { containers: [] });
});

test('findBrowserTarget: nothing listening on the debug port is unreachable', async (t) => {
  const root = tmpRoot(t, 'ejsng-launch-unreachable-');
  const { conn } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/findBrowserTarget', { host: '127.0.0.1', port: await freePort(), appUrl: 'http://localhost:5000/' });
  assert.strictEqual(result.status, 'unreachable');
});

test('findBrowserTarget: waits through a login on another origin, then finds the app tab, which connectRuntimeTarget attaches to', async (t) => {
  const root = tmpRoot(t, 'ejsng-launch-login-');
  const browser = await startFakeBrowser(t);
  const { conn } = await startServer(t, root);
  const ask = () => conn.sendRequest('ejsng/findBrowserTarget', { host: '127.0.0.1', port: browser.port, appUrl: 'http://localhost:5000/' });

  assert.deepStrictEqual(await ask(), { status: 'waiting', urls: [] });

  browser.pages = [{ id: 'tab1', url: 'https://sso.example.com/realms/cityos/protocol/openid-connect/auth?client_id=web' }];
  assert.deepStrictEqual(await ask(), { status: 'waiting', urls: [browser.pages[0].url] });

  browser.pages = [
    { id: 'other', url: 'http://localhost:5001/' },
    { id: 'tab1', url: 'http://localhost:5000/#/dashboard' },
  ];
  const found = await ask();
  assert.deepStrictEqual(found, { status: 'found', targetId: 'tab1', url: 'http://localhost:5000/#/dashboard' });

  const connected = await conn.sendRequest('ejsng/connectRuntimeTarget', { host: '127.0.0.1', port: browser.port, targetId: found.targetId });
  assert.strictEqual(connected.status, 'connected');
  const start = Date.now();
  while (!browser.connectedIds.includes('tab1')) {
    if (Date.now() - start > 3000) throw new Error('never connected to the app tab');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepStrictEqual(browser.connectedIds, ['tab1']);
});
