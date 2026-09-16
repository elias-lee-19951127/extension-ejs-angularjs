/**
 * Pure functions behind the runtime-log feature — parsing, formatting, and matching. Moved down
 * from packages/server (ticket 02's prefactor: .scratch/runtime-remote-env/issues/02-probe-an-toan-va-trang-thai-that.md)
 * so later tickets (03-11, blocked on this one) have somewhere to put their own pure logic.
 * IO adapters (the actual `docker`/HTTP/WebSocket calls) stay in packages/server.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  offsetForLocation,
  parseConsoleApiCalled,
  parseRuntimeLogMessage,
  filterConnectableTargets,
  mapContainerPath,
  rewriteWebSocketUrl,
} = require('../dist');

test('offsetForLocation: mid-file location maps to the correct character offset', () => {
  const source = 'const a = 1;\nconsole.log(a);\nconst b = 2;\n';
  // Line 1 is 'console.log(a);', starting right after line 0's 12 characters + '\n'.
  // Character 8 on that line lands on the 'l' of 'log'.
  const offset = offsetForLocation(source, 1, 8);
  assert.strictEqual(offset, 21);
  assert.strictEqual(source.slice(offset, offset + 3), 'log');
});

test('offsetForLocation: line 0 needs no preceding newline count', () => {
  const source = 'console.log(1);\n';
  assert.strictEqual(offsetForLocation(source, 0, 8), 8);
});

/**
 * Fixture shape follows the `Runtime.consoleAPICalled` event as documented in
 * docs/research/console-ninja-inline-log.md section 2 (citing CDP's js_protocol.json,
 * domain Runtime, event consoleAPICalled / types StackTrace, CallFrame) — not a live capture.
 */
test('parseConsoleApiCalled: joins primitive args and reads location from the top call frame', () => {
  const event = {
    type: 'log',
    args: [
      { type: 'string', value: 'total' },
      { type: 'number', value: 42 },
    ],
    stackTrace: {
      callFrames: [
        { functionName: 'render', scriptId: '1', url: 'file:///app/views/profile.js', lineNumber: 5, columnNumber: 2 },
      ],
    },
  };
  assert.deepStrictEqual(parseConsoleApiCalled(event), {
    url: 'file:///app/views/profile.js',
    line: 5,
    character: 2,
    value: 'total 42',
    severity: 'log',
  });
});

test('parseConsoleApiCalled: maps the CDP event type to a simplified severity', () => {
  const build = (type) => ({
    type,
    args: [{ type: 'string', value: 'x' }],
    stackTrace: { callFrames: [{ url: '/app.js', lineNumber: 0, columnNumber: 0 }] },
  });
  assert.strictEqual(parseConsoleApiCalled(build('log')).severity, 'log');
  assert.strictEqual(parseConsoleApiCalled(build('info')).severity, 'log');
  assert.strictEqual(parseConsoleApiCalled(build('debug')).severity, 'log'); // unknown types fall back to 'log'
  assert.strictEqual(parseConsoleApiCalled(build('warning')).severity, 'warning');
  assert.strictEqual(parseConsoleApiCalled(build('error')).severity, 'error');
  assert.strictEqual(parseConsoleApiCalled(build('assert')).severity, 'error');
});

test('parseConsoleApiCalled: an object/array arg is formatted from its CDP preview, not just "Object"', () => {
  const event = {
    type: 'log',
    args: [
      {
        type: 'object',
        subtype: 'array',
        description: 'Array(2)',
        preview: {
          subtype: 'array',
          overflow: false,
          properties: [
            { name: '0', type: 'string', value: 'a' },
            { name: '1', type: 'string', value: 'b' },
          ],
        },
      },
      {
        type: 'object',
        description: 'Object',
        preview: {
          overflow: false,
          properties: [
            { name: 'name', type: 'string', value: 'phu' },
            { name: 'role', type: 'string', value: 'guest' },
          ],
        },
      },
    ],
    stackTrace: { callFrames: [{ url: '/app.js', lineNumber: 0, columnNumber: 0 }] },
  };
  assert.strictEqual(parseConsoleApiCalled(event).value, "[a, b] {name: phu, role: guest}");
});

test('parseConsoleApiCalled: a preview marked overflow gets a trailing ellipsis', () => {
  const event = {
    type: 'log',
    args: [
      {
        type: 'object',
        description: 'Object',
        preview: { overflow: true, properties: [{ name: 'a', type: 'number', value: '1' }] },
      },
    ],
    stackTrace: { callFrames: [{ url: '/app.js', lineNumber: 0, columnNumber: 0 }] },
  };
  assert.strictEqual(parseConsoleApiCalled(event).value, '{a: 1, …}');
});

test('parseConsoleApiCalled: an object arg with no preview falls back to its description', () => {
  const event = {
    type: 'log',
    args: [{ type: 'object', className: 'HTTPServer', description: 'Server' }],
    stackTrace: { callFrames: [{ url: '/app.js', lineNumber: 0, columnNumber: 0 }] },
  };
  assert.strictEqual(parseConsoleApiCalled(event).value, 'Server');
});

test('parseConsoleApiCalled: no stack trace means no usable location, so it returns null', () => {
  const event = { type: 'log', args: [{ type: 'string', value: 'no location' }] };
  assert.strictEqual(parseConsoleApiCalled(event), null);
});

/**
 * Crash-risk regression tests: the CDP endpoint is a network peer, not a trusted collaborator.
 * Any malformed input here must return null, never throw — a throw inside the WebSocket
 * 'message' handler would be uncaught and would crash the whole LSP server process.
 */
test('parseConsoleApiCalled: malformed input is rejected instead of throwing', () => {
  assert.strictEqual(parseConsoleApiCalled(null), null);
  assert.strictEqual(parseConsoleApiCalled(undefined), null);
  assert.strictEqual(parseConsoleApiCalled('not an object'), null);
  assert.strictEqual(parseConsoleApiCalled({}), null); // no `args` at all
  assert.strictEqual(parseConsoleApiCalled({ args: 'not an array' }), null);
  assert.strictEqual(parseConsoleApiCalled({ args: [{ type: 'string', value: 'x' }], stackTrace: {} }), null); // stackTrace with no callFrames
  assert.strictEqual(
    parseConsoleApiCalled({
      args: [{ type: 'string', value: 'x' }],
      stackTrace: { callFrames: [{ url: '/a.js', lineNumber: 0, columnNumber: 0 }] },
    }),
    null,
  ); // no `type` on the event itself
});

/**
 * parseRuntimeLogMessage's return shape (ticket 02): a discriminated outcome instead of a bare
 * `ParsedConsoleLog | null`, so the caller can count a dropped log BY REASON — 'ignored' (not a
 * console call at all: a JSON-RPC reply, a heartbeat, unparsable JSON) is never counted, while
 * 'unanchored' (a real console call with no usable call frame) must be — see
 * packages/server/src/index.ts's per-connection drop counters.
 */
test('parseRuntimeLogMessage: non-JSON frames are ignored instead of throwing', () => {
  assert.deepStrictEqual(parseRuntimeLogMessage('not json at all {'), { kind: 'ignored' });
  assert.deepStrictEqual(parseRuntimeLogMessage(''), { kind: 'ignored' });
});

test('parseRuntimeLogMessage: JSON that is not an object, or has no matching method, is ignored', () => {
  assert.deepStrictEqual(parseRuntimeLogMessage('42'), { kind: 'ignored' });
  assert.deepStrictEqual(parseRuntimeLogMessage('null'), { kind: 'ignored' });
  assert.deepStrictEqual(parseRuntimeLogMessage(JSON.stringify({ id: 1, result: {} })), { kind: 'ignored' }); // a request reply, not an event
});

test('parseRuntimeLogMessage: a consoleAPICalled event with no usable call frame is "unanchored", not silently dropped', () => {
  const raw = JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log', args: [{ type: 'string', value: 'x' }] }, // no stackTrace
  });
  assert.deepStrictEqual(parseRuntimeLogMessage(raw), { kind: 'unanchored' });
});

test('parseRuntimeLogMessage: a well-formed consoleAPICalled frame parses through to a log', () => {
  const raw = JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: {
      type: 'log',
      args: [{ type: 'string', value: 'hi' }],
      stackTrace: { callFrames: [{ url: '/app.js', lineNumber: 0, columnNumber: 0 }] },
    },
  });
  assert.deepStrictEqual(parseRuntimeLogMessage(raw), {
    kind: 'log',
    log: { url: '/app.js', line: 0, character: 0, value: 'hi', severity: 'log' },
  });
});

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

test('mapContainerPath: no mappings configured — path passes through unchanged', () => {
  assert.strictEqual(mapContainerPath('/app/app.js', []), '/app/app.js');
});

test('mapContainerPath: a matching remote prefix is rewritten to the local path', () => {
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/app/src/index.js', mappings), '/Users/me/project/src/index.js');
});

test('mapContainerPath: a path that matches no configured remote passes through unchanged', () => {
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/other/index.js', mappings), '/other/index.js');
});

test('mapContainerPath: does not rewrite a path that merely starts with the same characters as remote, not the same directory', () => {
  // '/app2/x.js' must NOT match remote '/app' — that would rewrite an unrelated directory.
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/app2/x.js', mappings), '/app2/x.js');
});

test('mapContainerPath: the first matching mapping wins when several are configured', () => {
  const mappings = [
    { remote: '/app/src', local: '/Users/me/project/src-only' },
    { remote: '/app', local: '/Users/me/project' },
  ];
  assert.strictEqual(mapContainerPath('/app/src/index.js', mappings), '/Users/me/project/src-only/index.js');
});

test('mapContainerPath: an exact match of remote (no trailing separator) still rewrites correctly', () => {
  const mappings = [{ remote: '/app', local: '/Users/me/project' }];
  assert.strictEqual(mapContainerPath('/app', mappings), '/Users/me/project');
});

/**
 * rewriteWebSocketUrl (ticket 02, item 2): the runtime's own advertised `webSocketDebuggerUrl`
 * can be wrong or unreachable (e.g. it advertises 0.0.0.0, or an interface only reachable from
 * inside a container) — it must be rewritten to the host:port ACTUALLY used to reach discovery,
 * never used verbatim.
 */
test('rewriteWebSocketUrl: replaces the host and port with the ones actually used to reach the endpoint', () => {
  assert.strictEqual(
    rewriteWebSocketUrl('ws://127.0.0.1:9229/abcd-1234', 'localhost', 9229),
    'ws://localhost:9229/abcd-1234',
  );
});

test('rewriteWebSocketUrl: rewrites even when the runtime advertises an unreachable interface', () => {
  assert.strictEqual(
    rewriteWebSocketUrl('ws://0.0.0.0:9229/target-1', '172.17.0.2', 9228),
    'ws://172.17.0.2:9228/target-1',
  );
});

test('rewriteWebSocketUrl: preserves the path and query string', () => {
  assert.strictEqual(
    rewriteWebSocketUrl('ws://10.0.0.5:9229/devtools/page/ABC?foo=bar', 'localhost', 9229),
    'ws://localhost:9229/devtools/page/ABC?foo=bar',
  );
});

test('rewriteWebSocketUrl: a malformed URL is returned unchanged rather than throwing', () => {
  assert.strictEqual(rewriteWebSocketUrl('not a url', 'localhost', 9229), 'not a url');
});
