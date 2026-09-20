/**
 * Shared pieces for the ticket 11 UI tests: a test registry the runner in index.js walks, a fake
 * CDP runtime, and the few stubs needed to drive commands that would otherwise wait on a human
 * (an input box, a Quick Pick).
 */
const assert = require('node:assert');
const { createServer } = require('node:http');
const { join } = require('node:path');
const vscode = require('vscode');
const { WebSocketServer } = require('ws');

const EXTENSION_ID = 'phule.ejs-angularjs-navigator';

/** @type {Array<{ name: string, fn: () => Promise<void>, cleanup: Array<() => unknown> }>} */
const registeredTests = [];
let current = null;

function test(name, fn) {
  const entry = { name, cleanup: [], fn: null };
  entry.fn = async () => {
    current = entry;
    await fn();
  };
  registeredTests.push(entry);
}

/** Run `step` after the current test, pass or fail, in reverse registration order. */
function onCleanup(step) {
  current.cleanup.push(step);
}

function workspacePath(...parts) {
  return join(process.env.EJSNG_E2E_WORKSPACE, ...parts);
}

function workspaceUri(...parts) {
  return vscode.Uri.file(workspacePath(...parts));
}

/** The extension's test API (see `EjsngTestApi` in src/extension.ts). */
async function extensionApi() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not loaded`);
  const api = await extension.activate();
  assert.ok(api, 'activate() returned no test API — is EJSNG_EXTENSION_TEST=1 set?');
  return api;
}

/** Poll `predicate` (sync or async) until it is truthy; the failure names what was awaited. */
async function waitFor(predicate, what, { timeoutMs = 15_000, intervalMs = 50 } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Replace `vscode.window[name]` for the rest of the current test. */
function stubWindow(name, implementation) {
  const original = vscode.window[name];
  vscode.window[name] = implementation;
  onCleanup(() => {
    vscode.window[name] = original;
  });
}

/**
 * A fake runtime: `/json/list` discovery plus a CDP WebSocket that answers every request, serves
 * the `Debugger` domain from `scripts` (`{scriptId, url, source}`, metadata derived from the source
 * the way V8 derives it), and pushes console calls when the test says so. Every command received
 * is kept in `commands`; `Debugger.setBreakpointByUrl` answers with a fresh `breakpointId`.
 */
async function startFakeRuntime({ id = 'target', title = 'node app', scripts = [] } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id, type: 'node', title, url: 'file:///app.js', webSocketDebuggerUrl: `ws://placeholder/${id}` }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const state = { socket: null, scriptsDelivered: false, closed: false };
  const commands = [];
  /** objectId -> the property descriptors `Runtime.getProperties` answers with. */
  const objects = new Map();
  let nextBreakpoint = 1;
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    if (req.url.slice(1) !== id) return;
    state.socket = socket;
    socket.on('close', () => {
      state.closed = true;
    });
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      commands.push(msg);
      socket.send(JSON.stringify({ id: msg.id, result: resultFor(msg) }));
      if (msg.method === 'Debugger.enable') {
        for (const s of scripts) {
          const lines = s.source.split('\n');
          socket.send(
            JSON.stringify({
              method: 'Debugger.scriptParsed',
              params: {
                scriptId: s.scriptId,
                url: s.url,
                startLine: 0,
                startColumn: 0,
                endLine: lines.length - 1,
                endColumn: lines[lines.length - 1].length,
                length: s.source.length,
              },
            }),
          );
        }
        state.scriptsDelivered = true;
      }
    });
  });
  function resultFor(msg) {
    if (msg.method === 'Debugger.getScriptSource') return scriptSource(msg);
    if (msg.method === 'Debugger.setBreakpointByUrl') return { breakpointId: `bp${nextBreakpoint++}`, locations: [] };
    // expand-log-values: the properties of an object this runtime "holds", as V8 would answer.
    if (msg.method === 'Runtime.getProperties') return { result: objects.get(msg.params.objectId) ?? [] };
    return {};
  }
  function scriptSource(msg) {
    const found = scripts.find((s) => s.scriptId === msg.params.scriptId);
    return { scriptSource: found ? found.source : '' };
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(() => {
    wss.close();
    server.close();
  });
  return {
    port: server.address().port,
    /** Connected, and every `scriptParsed` written — a log sent after this lands behind the metadata it needs. */
    isReady: () => state.socket !== null && state.scriptsDelivered,
    isClosed: () => state.closed,
    commands,
    /**
     * `value` may be an array: one string argument each. `logpointId` puts that logpoint's
     * condition frame on top of the stack, the way V8 reports a logpoint's console call.
     */
    /**
     * Log one object argument the runtime "holds": `tree` is plain data, turned into the
     * `RemoteObject` + `getProperties` answers V8 would give (one level of preview, the rest only
     * when asked). Returns nothing; the value is found through the log's `logId`.
     */
    sendObjectLog(label, tree, { url, line = 0, scriptId }) {
      let next = 1;
      const remote = (value) => {
        if (value === null) return { type: 'object', subtype: 'null', value: null };
        if (Array.isArray(value) || typeof value === 'object') {
          const objectId = `obj${next++}`;
          const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
          objects.set(
            objectId,
            entries.map(([name, v]) => ({ name, value: remote(v), enumerable: true, isOwn: true, configurable: true, writable: true })),
          );
          return {
            type: 'object',
            ...(Array.isArray(value) ? { subtype: 'array', className: 'Array', description: `Array(${value.length})` } : { className: 'Object', description: 'Object' }),
            objectId,
            // One level, like a real console preview: nested objects show no keys at all.
            preview: {
              type: 'object',
              ...(Array.isArray(value) ? { subtype: 'array' } : {}),
              description: Array.isArray(value) ? `Array(${value.length})` : 'Object',
              overflow: entries.length > 5,
              properties: entries.slice(0, 5).map(([name, v]) => ({
                name,
                ...(v !== null && typeof v === 'object'
                  ? { type: 'object', value: Array.isArray(v) ? `Array(${v.length})` : 'Object', ...(Array.isArray(v) ? { subtype: 'array' } : {}) }
                  : { type: typeof v, value: String(v) }),
              })),
            },
          };
        }
        return { type: typeof value, value, description: String(value) };
      };
      const frame = { url, lineNumber: line, columnNumber: 0 };
      if (scriptId) frame.scriptId = scriptId;
      state.socket.send(
        JSON.stringify({
          method: 'Runtime.consoleAPICalled',
          params: { type: 'log', args: [{ type: 'string', value: label }, remote(tree)], stackTrace: { callFrames: [frame] } },
        }),
      );
    },
    sendLog(value, { url, line = 0, scriptId, logpointId }) {
      const frame = { url, lineNumber: line, columnNumber: 0 };
      if (scriptId) frame.scriptId = scriptId;
      const callFrames = logpointId === undefined ? [frame] : [{ url: `ejsng-logpoint-${logpointId}`, lineNumber: 0, columnNumber: 0 }, frame];
      const args = (Array.isArray(value) ? value : [value]).map((v) => ({ type: 'string', value: v }));
      state.socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args, stackTrace: { callFrames } } }));
    },
  };
}

/**
 * Connect through the real `EJS/NG: Connect to Runtime` command, answering its input box with
 * the runtime's host:port (Docker discovery finds nothing: run.js puts an empty `docker` first on
 * PATH). Resolves once the runtime has seen the connection.
 */
async function connectThroughCommand(api, runtime) {
  stubWindow('showInputBox', async () => `127.0.0.1:${runtime.port}`);
  const before = new Set(api.connectionKeys());
  await vscode.commands.executeCommand('ejsng.connectRuntime');
  const key = await waitFor(() => api.connectionKeys().find((k) => !before.has(k)), 'a new connection key');
  await waitFor(() => runtime.isReady(), 'the runtime to see the connection');
  onCleanup(() => disconnect(api, key));
  return key;
}

/** Disconnect `key` through the real `EJS/NG: Disconnect Runtime` command, picking it in the Quick Pick. */
async function disconnect(api, key) {
  if (!api.connectionKeys().includes(key)) return;
  const original = vscode.window.showQuickPick;
  vscode.window.showQuickPick = async (items) => (await items).find((item) => item.key === key);
  try {
    await vscode.commands.executeCommand('ejsng.disconnectRuntime');
  } finally {
    vscode.window.showQuickPick = original;
  }
}

/** Ask the server now, then check — the extension otherwise only polls every 2 s. */
async function refreshed(api, predicate) {
  await api.refreshRuntimeStatus();
  return predicate();
}

module.exports = {
  registeredTests,
  test,
  onCleanup,
  workspacePath,
  workspaceUri,
  extensionApi,
  waitFor,
  stubWindow,
  startFakeRuntime,
  connectThroughCommand,
  disconnect,
  refreshed,
};
