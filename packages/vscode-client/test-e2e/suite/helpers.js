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
 * the way V8 derives it), and pushes console calls when the test says so.
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
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    if (req.url.slice(1) !== id) return;
    state.socket = socket;
    socket.on('close', () => {
      state.closed = true;
    });
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ id: msg.id, result: msg.method === 'Debugger.getScriptSource' ? scriptSource(msg) : {} }));
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
    sendLog(value, { url, line = 0, scriptId }) {
      const frame = { url, lineNumber: line, columnNumber: 0 };
      if (scriptId) frame.scriptId = scriptId;
      state.socket.send(
        JSON.stringify({
          method: 'Runtime.consoleAPICalled',
          params: { type: 'log', args: [{ type: 'string', value }], stackTrace: { callFrames: [frame] } },
        }),
      );
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
