/**
 * Seam 1 + 2 of ticket 02a (.scratch/inline-runtime-log/issues/02a-multi-connection-server.md):
 * discover connectable CDP targets at a host:port — the same discovery endpoint
 * (`GET /json/list`) both `node --inspect` and Chrome `--remote-debugging-port` expose.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { filterConnectableTargets, discoverTargets } = require('../dist/runtime-log');

test('filterConnectableTargets: keeps page and node targets, drops everything else', () => {
  const targets = [
    { id: 'a', type: 'page', title: 'My App', url: 'http://localhost:3000/', webSocketDebuggerUrl: 'ws://x/a' },
    { id: 'b', type: 'service_worker', title: 'sw.js', url: 'http://localhost:3000/sw.js', webSocketDebuggerUrl: 'ws://x/b' },
    { id: 'c', type: 'node', title: 'app.js', url: 'file:///app.js', webSocketDebuggerUrl: 'ws://x/c' },
    { id: 'd', type: 'background_page', title: 'ext', url: 'chrome-extension://x', webSocketDebuggerUrl: 'ws://x/d' },
  ];
  assert.deepStrictEqual(
    filterConnectableTargets(targets).map((t) => t.id),
    ['a', 'c'],
  );
});

test('filterConnectableTargets: an empty list stays empty', () => {
  assert.deepStrictEqual(filterConnectableTargets([]), []);
});

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
