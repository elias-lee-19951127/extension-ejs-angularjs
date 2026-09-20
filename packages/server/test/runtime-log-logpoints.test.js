/**
 * Inline logpoints end-to-end over LSP (.scratch/inline-logpoints/issues/02-server-set-logpoints.md):
 * `ejsng/setLogpoints` turns into breakpoints this server sets on the runtime itself, whose output
 * comes back as ordinary `ejsng/runtimeLog` notifications — without ever pausing the runtime.
 *
 * The first test runs against a REAL `node --inspect`, because what matters most here is V8's own
 * behaviour: that the condition never pauses, that a module loaded later still binds, and that the
 * log doesn't leak to the app's stdout. Pure pieces (condition building, message parsing, reverse
 * mapping) are covered in packages/core/test/logpoint.test.js.
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

async function startServer(t, root) {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start `node --inspect` on a free port; resolves once the inspector is listening. */
async function startInspectedNode(t, cwd, entry) {
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', entry], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '' };
  child.stdout.on('data', (c) => (output.stdout += c));
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
      const m = /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', () => reject(new Error(`node exited early: ${stderr}`)));
  });
  return { port, output };
}

test('LSP + real node --inspect: logpoints draw inline on their lines, never pause, bind in a module loaded later, and stay off stdout', async (t) => {
  // Under os.tmpdir(), which on macOS is itself behind a symlink — the runtime reports realpaths,
  // the editor doesn't, and the logpoint must still bind.
  const root = mkdtempSync(join(tmpdir(), 'ejsng-logpoints-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'app.js'),
    [
      "const later = () => require('./lazy.js');",
      'let n = 0;',
      'setInterval(() => {',
      '  n++;',
      "  const obj = { a: n, b: 'x' };",
      '  if (n >= 3) later().double(n);',
      '}, 50);',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'lazy.js'), ['exports.double = function (k) {', '  const doubled = k * 2;', '  return doubled;', '};', ''].join('\n'));

  const { port, output } = await startInspectedNode(t, root, 'app.js');
  const { conn, runtimeLogs } = await startServer(t, root);
  conn.sendNotification('ejsng/setLogpoints', {
    logpoints: [
      { uri: pathToFileURL(join(root, 'app.js')).href, line: 5, logMessage: 'n = {n}, obj = {obj}' },
      { uri: pathToFileURL(join(root, 'lazy.js')).href, line: 2, logMessage: 'doubled = {doubled}', condition: 'k % 2 === 0' },
    ],
  });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port });
  assert.strictEqual(result.status, 'connected');

  const appUri = pathToFileURL(join(root, 'app.js')).href;
  const lazyUri = pathToFileURL(join(root, 'lazy.js')).href;
  // Several logs from the same line prove the runtime keeps running rather than sitting paused.
  await waitUntil(() => runtimeLogs.filter((l) => l.uri === appUri).length >= 3 && runtimeLogs.some((l) => l.uri === lazyUri));

  const appLog = runtimeLogs.find((l) => l.uri === appUri);
  assert.strictEqual(appLog.range.start.line, 5);
  assert.match(appLog.value, /^n = (\d+), obj = \{a: \1, b: x\}$/);
  const lazyLogs = runtimeLogs.filter((l) => l.uri === lazyUri);
  assert.strictEqual(lazyLogs[0].range.start.line, 2);
  for (const l of lazyLogs) {
    const m = /^doubled = (\d+)$/.exec(l.value);
    assert.ok(m, l.value);
    assert.strictEqual(Number(m[1]) % 4, 0, 'the condition (k even) must filter');
  }
  assert.strictEqual(output.stdout, '', 'a logpoint must not print to the app’s own stdout');

  // Removing every logpoint stops the logs.
  conn.sendNotification('ejsng/setLogpoints', { logpoints: [] });
  await sleep(300);
  const settled = runtimeLogs.length;
  await sleep(500);
  assert.strictEqual(runtimeLogs.length, settled);
});

test('LSP + real node --inspect: a logpoint set at a column draws on its OWN line, not on the one V8 binds it to', async (t) => {
  // The regression this pins: `setBreakpointByUrl` binds to the first breakable position at or
  // AFTER the requested column. The column asked for here is the one right after `;` — so the
  // value logged is the one just assigned — and nothing further along that line is breakable, so
  // V8 binds on the NEXT statement. Drawing from the resulting stack frame put the value a line
  // below the assignment the user clicked. The existing tests above all set logpoints from the
  // gutter (no column), where V8 binds on the line asked for and the bug cannot show.
  const root = mkdtempSync(join(tmpdir(), 'ejsng-logpoints-column-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines = [
    'let n = 0;',
    'setInterval(() => {',
    '  n++;',
    '  const rows = [n];',
    '  const other = n * 2;',
    "  console.log('plain', other);",
    '}, 50);',
    '',
  ];
  writeFileSync(join(root, 'app.js'), lines.join('\n'));
  const ROWS_LINE = 3;
  const PLAIN_LINE = 5;
  // Right after the `;` of `  const rows = [n];` — the position the CodeLens and `logHere` ask for.
  const afterSemicolon = lines[ROWS_LINE].length;

  const { port } = await startInspectedNode(t, root, 'app.js');
  const { conn, runtimeLogs } = await startServer(t, root);
  conn.sendNotification('ejsng/setLogpoints', {
    logpoints: [{ uri: pathToFileURL(join(root, 'app.js')).href, line: ROWS_LINE, character: afterSemicolon, logMessage: 'rows = {rows}' }],
  });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port });
  assert.strictEqual(result.status, 'connected');

  const logpointLogs = () => runtimeLogs.filter((l) => /^rows = \[\d+\]$/.test(l.value));
  const plainLogs = () => runtimeLogs.filter((l) => /^plain \d+$/.test(l.value));
  await waitUntil(() => logpointLogs().length >= 2 && plainLogs().length >= 2);

  for (const l of logpointLogs()) {
    assert.strictEqual(l.range.start.line, ROWS_LINE, `drawn on the assignment, not on line ${l.range.start.line}`);
  }
  // A plain console call is still drawn where its own frame says it ran — only logpoints are
  // re-anchored, so this must not have moved with them.
  for (const l of plainLogs()) assert.strictEqual(l.range.start.line, PLAIN_LINE);
});

/**
 * A fake browser page that records every CDP command, answers each one, and reports one script
 * by URL — enough to see WHICH breakpoints the server sets and removes.
 */
async function startFakePage(t, scriptUrl) {
  const commands = [];
  let nextBreakpoint = 1;
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'p1', type: 'page', title: 'app', url: 'http://localhost:5000/', webSocketDebuggerUrl: 'ws://placeholder/p1' }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      commands.push(msg);
      const result = msg.method === 'Debugger.setBreakpointByUrl' ? { breakpointId: `bp${nextBreakpoint++}`, locations: [] } : {};
      socket.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method === 'Debugger.enable') {
        socket.send(
          JSON.stringify({
            method: 'Debugger.scriptParsed',
            params: { scriptId: '9', url: scriptUrl, startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, length: 0 },
          }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port: server.address().port, commands };
}

test('LSP: a browser script only a forward (URL-tail) match can place gets its logpoint by exact url; clearing removes every breakpoint set', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-logpoints-browser-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'public', 'javascripts'), { recursive: true });
  writeFileSync(join(root, 'public', 'javascripts', 'index.js'), 'function go(x) {\n  return x;\n}\n');

  const scriptUrl = 'http://localhost:5000/javascripts/index.js?v=3';
  const page = await startFakePage(t, scriptUrl);
  const { conn } = await startServer(t, root);
  conn.sendNotification('ejsng/setLogpoints', {
    logpoints: [{ uri: pathToFileURL(join(root, 'public', 'javascripts', 'index.js')).href, line: 1, logMessage: 'x = {x}' }],
  });
  const result = await conn.sendRequest('ejsng/connectRuntime', { host: '127.0.0.1', port: page.port });
  assert.strictEqual(result.status, 'connected');

  const sets = () => page.commands.filter((c) => c.method === 'Debugger.setBreakpointByUrl');
  await waitUntil(() => sets().some((c) => c.params.url === scriptUrl));
  const exact = sets().filter((c) => c.params.url === scriptUrl);
  assert.strictEqual(exact.length, 1, 'set once, not once per scriptParsed/re-check');
  assert.strictEqual(exact[0].params.lineNumber, 1);
  assert.match(exact[0].params.condition, /sourceURL=ejsng-logpoint-\d+$/);
  // Enable must come first: a breakpoint sent before `Debugger.enable` is refused by the runtime.
  const enableAt = page.commands.findIndex((c) => c.method === 'Debugger.enable');
  const firstSetAt = page.commands.findIndex((c) => c.method === 'Debugger.setBreakpointByUrl');
  assert.ok(enableAt !== -1 && enableAt < firstSetAt);

  const setCount = sets().length;
  conn.sendNotification('ejsng/setLogpoints', { logpoints: [] });
  await waitUntil(() => page.commands.filter((c) => c.method === 'Debugger.removeBreakpoint').length === setCount);
  const removed = page.commands.filter((c) => c.method === 'Debugger.removeBreakpoint').map((c) => c.params.breakpointId).sort();
  assert.deepStrictEqual(removed, Array.from({ length: setCount }, (_, i) => `bp${i + 1}`).sort());
});
