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
  DEFAULT_SKIP_FRAME_PATTERNS,
  matchesSkipPattern,
  classifyFrameCandidates,
  isLikelyMinified,
  stripAnsi,
  suggestWrapperFile,
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
/**
 * Ticket 03 (.scratch/runtime-remote-env/issues/03-chon-frame.md) changed this function's return
 * shape: it used to pick `callFrames[0]` itself and return an already-anchored
 * `{url, line, character}`. Frame selection (skip patterns, obfuscation heuristic) needs file
 * content this pure layer has no IO to read — so it now hands back every candidate call frame,
 * unpicked, and lets packages/server/src/index.ts's `onLog` choose one.
 */
test('parseConsoleApiCalled: joins primitive args and carries every call frame through, in original order', () => {
  const event = {
    type: 'log',
    args: [
      { type: 'string', value: 'total' },
      { type: 'number', value: 42 },
    ],
    stackTrace: {
      callFrames: [
        { functionName: 'render', scriptId: '1', url: 'file:///app/views/profile.js', lineNumber: 5, columnNumber: 2 },
        { functionName: 'caller', scriptId: '2', url: 'file:///app/index.js', lineNumber: 10, columnNumber: 0 },
      ],
    },
  };
  assert.deepStrictEqual(parseConsoleApiCalled(event), {
    callFrames: [
      { url: 'file:///app/views/profile.js', lineNumber: 5, columnNumber: 2 },
      { url: 'file:///app/index.js', lineNumber: 10, columnNumber: 0 },
    ],
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
    log: { callFrames: [{ url: '/app.js', lineNumber: 0, columnNumber: 0 }], value: 'hi', severity: 'log' },
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

// ============================================================================================
// Ticket 03 (.scratch/runtime-remote-env/issues/03-chon-frame.md) — skip library/logger frames
// by pattern, skip obfuscated/minified files by content, strip ANSI, suggest a wrapper file.
// ============================================================================================

test('matchesSkipPattern: node:internal/** matches a Node internal module specifier', () => {
  assert.strictEqual(
    matchesSkipPattern('node:internal/modules/cjs/loader', DEFAULT_SKIP_FRAME_PATTERNS),
    'node:internal/**',
  );
});

test('matchesSkipPattern: **/node_modules/** matches a dependency file, plain path or file:// URL alike', () => {
  assert.strictEqual(
    matchesSkipPattern('/Users/me/project/node_modules/lodash/index.js', DEFAULT_SKIP_FRAME_PATTERNS),
    '**/node_modules/**',
  );
  assert.strictEqual(
    matchesSkipPattern('file:///Users/me/project/node_modules/lodash/index.js', DEFAULT_SKIP_FRAME_PATTERNS),
    '**/node_modules/**',
  );
});

test('matchesSkipPattern: a common vendored logger directory (log4js) is matched by default, without any user config', () => {
  assert.strictEqual(
    matchesSkipPattern('/Users/me/project/aocs/utility/log4js/appenders/console.js', DEFAULT_SKIP_FRAME_PATTERNS),
    '**/log4js/**',
  );
});

test('matchesSkipPattern: ordinary user code matches nothing', () => {
  assert.strictEqual(matchesSkipPattern('/Users/me/project/src/controllers/profile.js', DEFAULT_SKIP_FRAME_PATTERNS), null);
});

test('classifyFrameCandidates: keeps frame order, marking each as skipped-by-pattern or not', () => {
  const frames = [
    { url: '/app/node_modules/x/index.js', lineNumber: 1, columnNumber: 0 },
    { url: '/app/src/controller.js', lineNumber: 5, columnNumber: 2 },
  ];
  assert.deepStrictEqual(classifyFrameCandidates(frames, []), [
    { frame: frames[0], skippedByPattern: '**/node_modules/**' },
    { frame: frames[1], skippedByPattern: null },
  ]);
});

test('classifyFrameCandidates: ejsng.runtimeLog.skipFrames ADDS to the default list, never replaces it', () => {
  const frames = [
    { url: '/app/team-wrapper/log.js', lineNumber: 0, columnNumber: 0 },
    { url: '/app/node_modules/x/index.js', lineNumber: 0, columnNumber: 0 }, // still caught by the DEFAULT list
  ];
  const result = classifyFrameCandidates(frames, ['**/team-wrapper/**']);
  assert.strictEqual(result[0].skippedByPattern, '**/team-wrapper/**');
  assert.strictEqual(result[1].skippedByPattern, '**/node_modules/**');
});

test('classifyFrameCandidates: an empty pattern list (no user skipFrames) still applies the defaults', () => {
  const frames = [{ url: 'node:internal/timers', lineNumber: 0, columnNumber: 0 }];
  assert.strictEqual(classifyFrameCandidates(frames, [])[0].skippedByPattern, 'node:internal/**');
});

/**
 * isLikelyMinified (ticket 03, checklist item 3): "almost no newline characters relative to the
 * file's size" — measured as average characters per line, so short files are never flagged just
 * for being short (a one-line test fixture is not "obfuscated").
 */
test('isLikelyMinified: a short one-line file is NOT flagged — too small to mean anything', () => {
  assert.strictEqual(isLikelyMinified('console.log(1);\n'), false);
  assert.strictEqual(isLikelyMinified('const x = 1;'), false);
});

test('isLikelyMinified: an ordinary multi-line source file is not flagged', () => {
  const line = 'function add(a, b) { return a + b; }';
  const source = Array(60).fill(line).join('\n'); // ~60 short lines, well above the size floor
  assert.strictEqual(isLikelyMinified(source), false);
});

test('isLikelyMinified: a large file crammed onto one long line IS flagged', () => {
  const source = 'var a=1,b=2,c=3;'.repeat(200); // one line, thousands of characters
  assert.strictEqual(isLikelyMinified(source), true);
});

test('isLikelyMinified: a large file with a FEW long lines (not truly one-line) is still flagged', () => {
  const longLine = 'x'.repeat(1000);
  const source = [longLine, longLine, longLine].join('\n'); // 3 lines, ~333 chars average
  assert.strictEqual(isLikelyMinified(source), true);
});

test('isLikelyMinified: a large file that IS properly broken into many lines is not flagged', () => {
  const line = 'x'.repeat(40);
  const source = Array(100).fill(line).join('\n'); // 4000 chars, but avg line length is only 40
  assert.strictEqual(isLikelyMinified(source), false);
});

/** stripAnsi (ticket 03, checklist item 5) — the log4js colored layout the spec targets. */
test('stripAnsi: removes SGR color codes, leaving the plain text', () => {
  assert.strictEqual(stripAnsi('[32mhello[39m'), 'hello');
});

test('stripAnsi: removes multiple escape sequences in one string', () => {
  assert.strictEqual(stripAnsi('[1m[31merror:[39m[22m something broke'), 'error: something broke');
});

test('stripAnsi: a string with no escape codes is returned unchanged', () => {
  assert.strictEqual(stripAnsi('plain text, nothing to strip'), 'plain text, nothing to strip');
});

test('stripAnsi: an empty string stays empty', () => {
  assert.strictEqual(stripAnsi(''), '');
});

/** suggestWrapperFile (ticket 03, checklist item 7). */
test('suggestWrapperFile: too few samples yet — no suggestion even if one file dominates', () => {
  const recent = Array(10).fill('src/log.js');
  assert.strictEqual(suggestWrapperFile(recent), null);
});

test('suggestWrapperFile: one file accounting for most recent logs is suggested, with its share', () => {
  const recent = [...Array(15).fill('src/log.js'), ...Array(5).fill('src/other.js')];
  assert.deepStrictEqual(suggestWrapperFile(recent), { path: 'src/log.js', share: 0.75 });
});

test('suggestWrapperFile: a healthy spread across many files is not suggested', () => {
  const recent = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  assert.strictEqual(suggestWrapperFile(recent), null);
});

test('suggestWrapperFile: an empty history suggests nothing', () => {
  assert.strictEqual(suggestWrapperFile([]), null);
});

test('suggestWrapperFile: minSamples/shareThreshold are configurable', () => {
  const recent = [...Array(2).fill('src/log.js'), ...Array(2).fill('src/other.js')]; // share 0.5
  // Enough samples (custom minSamples: 4) but 0.5 share doesn't clear the DEFAULT 0.6 threshold.
  assert.strictEqual(suggestWrapperFile(recent, { minSamples: 4 }), null);
  // Lowering the threshold to 0.5 as well now clears it.
  assert.deepStrictEqual(suggestWrapperFile(recent, { minSamples: 4, shareThreshold: 0.5 }), {
    path: 'src/log.js',
    share: 0.5,
  });
});
