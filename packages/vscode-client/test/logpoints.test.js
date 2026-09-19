/**
 * Which VS Code breakpoints are sent to the server as logpoints
 * (.scratch/inline-logpoints/issues/03-vscode-client.md).
 */
const test = require('node:test');
const assert = require('node:assert');
const { logpointsFrom } = require('../out/logpoints');

function sourceBreakpoint(uri, line, extra = {}) {
  const scheme = uri.slice(0, uri.indexOf(':'));
  return { enabled: true, location: { uri: { scheme, toString: () => uri }, range: { start: { line } } }, ...extra };
}

test('logpointsFrom: an enabled logpoint on a file is sent with its line, message and condition', () => {
  const bps = [sourceBreakpoint('file:///app/a.js', 4, { logMessage: 'n = {n}', condition: 'n > 1' })];
  assert.deepStrictEqual(logpointsFrom(bps, true), [{ uri: 'file:///app/a.js', line: 4, logMessage: 'n = {n}', condition: 'n > 1' }]);
});

test('logpointsFrom: plain breakpoints, disabled ones, non-file documents and function breakpoints are left out', () => {
  const bps = [
    sourceBreakpoint('file:///app/a.js', 1),
    sourceBreakpoint('file:///app/a.js', 2, { logMessage: '   ' }),
    sourceBreakpoint('file:///app/a.js', 3, { logMessage: 'x', enabled: false }),
    sourceBreakpoint('untitled:Untitled-1', 0, { logMessage: 'x' }),
    { enabled: true, logMessage: 'x', functionName: 'go' },
    sourceBreakpoint('file:///app/a.js', 5, { logMessage: 'kept', condition: ' ' }),
  ];
  assert.deepStrictEqual(logpointsFrom(bps, true), [{ uri: 'file:///app/a.js', line: 5, logMessage: 'kept' }]);
});

test('logpointsFrom: the setting turned off sends an empty list, clearing every logpoint', () => {
  assert.deepStrictEqual(logpointsFrom([sourceBreakpoint('file:///app/a.js', 4, { logMessage: 'x' })], false), []);
});
