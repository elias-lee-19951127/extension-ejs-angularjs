/**
 * Seam 1 of the inline runtime log feature (.scratch/inline-runtime-log/spec.md): convert a
 * 0-based {line, character} location — the shape both the V8 Inspector Protocol's
 * `Runtime.CallFrame` and LSP `Position` use — into a character offset in the file's source.
 */
const test = require('node:test');
const assert = require('node:assert');
const { offsetForLocation, parseConsoleApiCalled, parseRuntimeLogMessage } = require('../dist/runtime-log');

test('offsetForLocation: mid-file location maps to the correct character offset', () => {
  const source = 'const a = 1;\nconsole.log(a);\nconst b = 2;\n';
  // Line 1 is 'console.log(a);', starting right after line 0's 13 characters ('const a = 1;\n').
  // Character 8 on that line lands on the 'l' of 'log'.
  const offset = offsetForLocation(source, 1, 8);
  assert.strictEqual(offset, 21);
  assert.strictEqual(source.slice(offset, offset + 3), 'log');
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
  });
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
});

test('parseRuntimeLogMessage: non-JSON frames are rejected instead of throwing', () => {
  assert.strictEqual(parseRuntimeLogMessage('not json at all {'), null);
  assert.strictEqual(parseRuntimeLogMessage(''), null);
});

test('parseRuntimeLogMessage: JSON that is not an object, or has no method, is rejected', () => {
  assert.strictEqual(parseRuntimeLogMessage('42'), null);
  assert.strictEqual(parseRuntimeLogMessage('null'), null);
  assert.strictEqual(parseRuntimeLogMessage(JSON.stringify({ id: 1, result: {} })), null); // a request reply, not an event
});

test('parseRuntimeLogMessage: a well-formed consoleAPICalled frame parses through to a log', () => {
  const raw = JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: {
      args: [{ type: 'string', value: 'hi' }],
      stackTrace: { callFrames: [{ url: '/app.js', lineNumber: 0, columnNumber: 0 }] },
    },
  });
  assert.deepStrictEqual(parseRuntimeLogMessage(raw), { url: '/app.js', line: 0, character: 0, value: 'hi' });
});
