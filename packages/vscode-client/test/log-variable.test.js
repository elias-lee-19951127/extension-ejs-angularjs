/**
 * The pure half of `ejsng.logVariable` (.scratch/log-variable/issues/03-hover-link-and-command.md):
 * checking the hover link's argument, and never setting a second logpoint at the same spot.
 */
const test = require('node:test');
const assert = require('node:assert');
const { fileNameOf, parseLogVariableArgs, planLogVariable } = require('../out/log-variable');

const ARGS = { uri: 'file:///app/list.controller.js', line: 4, character: 61, expression: '$scope.rows', logMessage: '$scope.rows = {$scope.rows}' };

function bp(line, character, extra = {}) {
  return { enabled: true, location: { uri: { scheme: 'file', toString: () => ARGS.uri }, range: { start: { line, character } } }, ...extra };
}

test('parseLogVariableArgs: a well-formed argument passes; anything off is refused', () => {
  assert.deepStrictEqual(parseLogVariableArgs(ARGS), ARGS);
  for (const bad of [
    null,
    'x',
    { ...ARGS, uri: 'untitled:1' },
    { ...ARGS, line: -1 },
    { ...ARGS, character: 1.5 },
    { ...ARGS, expression: ' ' },
    { ...ARGS, logMessage: undefined },
  ]) {
    assert.strictEqual(parseLogVariableArgs(bad), null, JSON.stringify(bad));
  }
});

test('planLogVariable: add when nothing is there; the same spot is matched by line AND column', () => {
  assert.deepStrictEqual(planLogVariable(ARGS, []), { kind: 'add' });
  assert.deepStrictEqual(planLogVariable(ARGS, [bp(4, 0, { logMessage: ARGS.logMessage })]), { kind: 'add' }, 'a gutter logpoint on the line is another spot');
  assert.deepStrictEqual(planLogVariable(ARGS, [bp(5, 61, { logMessage: ARGS.logMessage })]), { kind: 'add' });
});

test('planLogVariable: the same logpoint already there is left alone — or turned back on if it was off', () => {
  assert.deepStrictEqual(planLogVariable(ARGS, [bp(4, 61, { logMessage: ARGS.logMessage })]), { kind: 'exists', index: 0, sameMessage: true });
  assert.deepStrictEqual(planLogVariable(ARGS, [bp(1, 0), bp(4, 61, { enabled: false, logMessage: ARGS.logMessage })]), { kind: 'enable', index: 1 });
});

test('planLogVariable: another breakpoint at that spot is never replaced, even a disabled one', () => {
  assert.deepStrictEqual(planLogVariable(ARGS, [bp(4, 61)]), { kind: 'exists', index: 0, sameMessage: false });
  assert.deepStrictEqual(planLogVariable(ARGS, [bp(4, 61, { enabled: false, logMessage: 'x = {x}' })]), { kind: 'exists', index: 0, sameMessage: false });
});

test('fileNameOf: the last path segment, decoded', () => {
  assert.strictEqual(fileNameOf('file:///app/my%20list.controller.js'), 'my list.controller.js');
});

// ---------------------------------------------------------------- log-lens ticket 02

const { logLenses } = require('../out/log-variable');

const TARGETS = [
  { lensLine: 1, line: 1, character: 20, expression: '$scope.rows', logMessage: 'rows = {$scope.rows}', inferred: true },
  { lensLine: 2, line: 2, character: 61, expression: '$scope.rows', logMessage: 'rows = {$scope.rows}', inferred: false },
];

test('logLenses: by default only the assignments the index could not type', () => {
  const lenses = logLenses(TARGETS, 'unknown', ARGS.uri, []);
  assert.deepStrictEqual(lenses.map((l) => l.line), [2]);
  assert.match(lenses[0].title, /Log rows at runtime$/);
  assert.deepStrictEqual(lenses[0].args, { ...ARGS, line: 2, character: 61, logMessage: 'rows = {$scope.rows}', toggle: true });

  assert.deepStrictEqual(logLenses(TARGETS, 'all', ARGS.uri, []).map((l) => l.line), [1, 2]);
  assert.deepStrictEqual(logLenses(TARGETS, 'off', ARGS.uri, []), []);
});

test('logLenses: a line already logging says so, and its click removes it', () => {
  const existing = bp(2, 61, { logMessage: 'rows = {$scope.rows}' });
  const [lens] = logLenses(TARGETS, 'unknown', ARGS.uri, [existing]);
  assert.match(lens.title, /Logging rows — click to remove$/);
  assert.strictEqual(lens.args.toggle, true);
  // Another breakpoint at that spot is someone else's: the lens still offers to log.
  const other = bp(2, 61, { logMessage: 'something else' });
  assert.match(logLenses(TARGETS, 'unknown', ARGS.uri, [other])[0].title, /Log rows at runtime$/);
});
