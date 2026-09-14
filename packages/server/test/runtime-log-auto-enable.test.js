/**
 * Seam 1+2 of ticket 10 (.scratch/inline-runtime-log/issues/10-auto-enable-inspector.md):
 * find the OS process listening on a port, and retry discovery while a signaled inspector
 * is still coming up.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');
const { findPidListeningOnPort, waitForTargets } = require('../dist/runtime-log');

const SERVER = join(__dirname, '..', 'dist', 'index.js');

test('findPidListeningOnPort: finds the real PID of a process listening on a real port', async (t) => {
  if (process.platform === 'win32') return t.skip('lsof is POSIX-only');
  const server = createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const pid = await findPidListeningOnPort(port);
  assert.strictEqual(pid, process.pid); // this test process itself owns the listening socket
});

test('findPidListeningOnPort: a port nothing listens on returns null, not an error', async (t) => {
  if (process.platform === 'win32') return t.skip('lsof is POSIX-only');
  const pid = await findPidListeningOnPort(1); // privileged port, essentially never bound in dev
  assert.strictEqual(pid, null);
});

test('waitForTargets: retries until a discovery endpoint that starts late becomes reachable', async (t) => {
  // Grab a free port up front, then release it — the late server reuses the same number.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const fixedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  let server;
  const startLate = setTimeout(() => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([]));
    });
    server.listen(fixedPort, '127.0.0.1');
  }, 300);
  t.after(() => {
    clearTimeout(startLate);
    server?.close();
  });

  const targets = await waitForTargets('127.0.0.1', fixedPort, 3000, 50);
  assert.deepStrictEqual(targets, []);
});

test('waitForTargets: times out with an error if nothing ever comes online', async () => {
  await assert.rejects(() => waitForTargets('127.0.0.1', 1, 300, 50));
});

test('end-to-end: a plain app port with no --inspect gets a real inspector via SIGUSR1', async (t) => {
  if (process.platform === 'win32') return t.skip('SIGUSR1 is POSIX-only');
  const { discoverTargets } = require('../dist/runtime-log');

  // The signal always enables the inspector on Node's DEFAULT port (9229) unless the process
  // set --inspect-port itself — this child doesn't, so that's where discovery must succeed.
  // Skip rather than false-fail if something on this machine already owns that port.
  const already = await discoverTargets('127.0.0.1', 9229).catch(() => null);
  if (already) return t.skip('something is already listening on 9229 on this machine');

  // A real child process with NO --inspect flag at all — exactly the "gõ port app thật" case.
  const child = spawn(
    process.execPath,
    ['-e', "const s = require('node:http').createServer((q,r)=>r.end('ok')); s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port)); setInterval(()=>{},1000);"],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => child.kill());

  const appPort = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('child never reported its port')), 3000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });

  // Before enabling: the app's own HTTP port doesn't speak the debug protocol.
  await assert.rejects(() => discoverTargets('127.0.0.1', appPort));

  const pid = await findPidListeningOnPort(appPort);
  assert.strictEqual(pid, child.pid);
  process.kill(pid, 'SIGUSR1');

  const targets = await waitForTargets('127.0.0.1', 9229, 5000, 100);
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].type, 'node');
});

/** Minimal LSP server bring-up, reused by the request-level test below. */
async function startServer(t, root) {
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
  });
  conn.sendNotification('initialized', {});
  await conn.sendRequest('ejsng/stats');
  return { conn, runtimeLogs };
}

function waitUntil(predicate, timeoutMs = 5000) {
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

test('LSP: ejsng/connectRuntime with a plain app port auto-enables the inspector and connects', async (t) => {
  if (process.platform === 'win32') return t.skip('SIGUSR1 is POSIX-only');
  const { discoverTargets } = require('../dist/runtime-log');
  const already = await discoverTargets('127.0.0.1', 9229).catch(() => null);
  if (already) return t.skip('something is already listening on 9229 on this machine');

  // realpathSync: macOS's tmpdir() is itself a symlink (/var/folders/... -> /private/var/...),
  // and Node reports a script's REALPATH in stack traces — an un-resolved root would make every
  // log from this app look like it's outside the workspace. See ticket 12.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ejsng-autoenable-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appFile = join(root, 'auto-app.js');
  writeFileSync(
    appFile,
    "const s = require('node:http').createServer((q,r)=>r.end('ok'));\n" +
      "s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port));\n" +
      "setInterval(() => console.log('tick'), 200);\n",
  );

  const child = spawn(process.execPath, [appFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const appPort = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('child never reported its port')), 3000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });

  const { conn, runtimeLogs } = await startServer(t, root);
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port: appPort });
  assert.strictEqual(result.status, 'connected');

  await waitUntil(() => runtimeLogs.some((l) => l.value === 'tick'));
});
