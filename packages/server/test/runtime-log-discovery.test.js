/**
 * Seam 1 + 2 of ticket 02a (.scratch/inline-runtime-log/issues/02a-multi-connection-server.md):
 * discover connectable CDP targets at a host:port — the same discovery endpoint
 * (`GET /json/list`) both `node --inspect` and Chrome `--remote-debugging-port` expose.
 *
 * `filterConnectableTargets` itself is a pure function, moved to packages/core/test/runtime-log.test.js
 * (ticket 02's prefactor) — this file keeps only what needs a real HTTP round-trip: the `Host`
 * header requirement and the ws-URL rewrite (both ticket 02, item 2).
 */
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const { discoverTargets } = require('../dist/runtime-log');

/** A fake discovery endpoint: exactly what `GET /json/list` returns on node --inspect / Chrome. */
async function startFakeDiscoveryServer(t, targets) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(targets));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

test('discoverTargets: fetches /json/list from host:port and returns only the connectable targets', async (t) => {
  const port = await startFakeDiscoveryServer(t, [
    { id: 'a', type: 'page', title: 'App', url: 'http://localhost:3000/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/a' },
    { id: 'b', type: 'service_worker', title: 'sw', url: 'http://localhost:3000/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:1/b' },
  ]);
  const targets = await discoverTargets('127.0.0.1', port);
  assert.deepStrictEqual(targets.map((t2) => t2.id), ['a']);
});

test('discoverTargets: nothing listening on host:port rejects instead of throwing uncaught', async () => {
  // Port 1 is a privileged port almost never bound to on a dev machine — connection refused.
  await assert.rejects(() => discoverTargets('127.0.0.1', 1));
});

test('discoverTargets: a non-JSON response rejects instead of throwing uncaught', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  await assert.rejects(() => discoverTargets('127.0.0.1', port));
});

/**
 * Ticket 02, item 2: Chrome and the Node inspector both refuse any `Host` request header that
 * isn't an IP or `localhost` (anti DNS-rebinding). Every probe must send `Host: localhost`
 * regardless of the hostname actually dialed to reach the endpoint.
 */
test('discoverTargets: always sends `Host: localhost`, even when dialed via a plain IP — the endpoint would otherwise refuse it', async (t) => {
  const server = createServer((req, res) => {
    if (req.headers.host !== 'localhost') {
      res.writeHead(400);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  // Dialed via the loopback IP — Node's default `Host` header would be "127.0.0.1:<port>", which
  // a real Chrome/Node inspector (simulated here by the 400 above) would reject.
  const targets = await discoverTargets('127.0.0.1', port);
  assert.deepStrictEqual(targets, []);
});

/**
 * Ticket 02, item 2: the runtime's OWN reported `webSocketDebuggerUrl` must never be used
 * verbatim — it must be rewritten to the host:port actually used to reach discovery. Here the
 * advertised URL points at an unreachable TEST-NET-1 address (RFC 5737); the real inspector is
 * served from the SAME host:port as discovery (exactly how `node --inspect` works: one port for
 * both `/json/list` and the WebSocket upgrade) — so only a correct rewrite can possibly connect.
 */
test('discoverTargets: rewrites webSocketDebuggerUrl to the host:port actually used to reach it, not the runtime-advertised one', async (t) => {
  const server = createServer((req, res) => {
    if (req.url !== '/json/list') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        {
          id: 't1',
          type: 'node',
          title: 'app',
          url: 'file:///app.js',
          // Deliberately wrong/unreachable — the runtime's own bad idea of its address.
          webSocketDebuggerUrl: 'ws://192.0.2.1:1/t1',
        },
      ]),
    );
  });
  const wss = new WebSocketServer({ server, path: '/t1' });
  let sawConnection = false;
  wss.on('connection', (socket) => {
    sawConnection = true;
    socket.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const targets = await discoverTargets('127.0.0.1', port);
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].webSocketDebuggerUrl, `ws://127.0.0.1:${port}/t1`);

  // Prove the rewritten URL is actually connectable — dial it directly with a plain WebSocket.
  const WebSocket = require('ws');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  assert.strictEqual(sawConnection, true);
});
