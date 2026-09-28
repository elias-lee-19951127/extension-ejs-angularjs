/**
 * log-here ticket 01: what the cursor asks to log, where the logpoint goes, and when the answer is
 * "no" with a reason — .scratch/log-here/spec.md decisions #2, #3, #4, #5.
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist');

const SRC = `
angular.module('app', []).controller('ListCtrl', function ($scope, $http) {
  var vm = this;
  $scope.rows = [];
  $http.get('/rows').then(function (res) {
    var local = res.data;
    $scope.rows = res.data;
    if (local.length) { vm.form.owner = local[0].owner; }
    this.wrong = 1;
  });
  console.log(load());
});
function load() { return 1; }
`;

const facts = C.extractJs(SRC, { ...C.DEFAULT_CONFIG, root: '/tmp' });
/** Ask at the position of `needle` (plus an offset into it), like a cursor there. */
const ask = (needle, { offset = 0, selection } = {}) => C.logHereAt(SRC, facts, SRC.indexOf(needle) + offset, selection);
const lineText = (line) => SRC.split('\n')[line];

test('the selection wins, and is logged where the line is about to use it', () => {
  const r = ask('res.data;\n    if', { selection: 'res.data' });
  assert.strictEqual(r.target.expression, 'res.data');
  assert.strictEqual(r.target.logMessage, 'data = {res.data}');
  // Placed at the start of that line: the value as the line is about to use it.
  assert.strictEqual(lineText(r.target.line).slice(r.target.character, r.target.character + 6), '$scope');
});

test('no selection: the property chain under the cursor, wherever in it the cursor sits', () => {
  for (const offset of [0, 3, 8]) {
    const r = ask('vm.form.owner', { offset });
    assert.strictEqual(r.target.expression, 'vm.form.owner', `offset ${offset}`);
    assert.strictEqual(r.target.logMessage, 'owner = {vm.form.owner}');
  }
  const local = ask('local.length');
  assert.strictEqual(local.target.expression, 'local.length');
});

test('an assignment target is logged right AFTER its statement, so the value is the new one', () => {
  const r = ask('$scope.rows = res.data', { offset: 2 });
  assert.strictEqual(r.target.expression, '$scope.rows');
  const text = lineText(r.target.line);
  assert.strictEqual(text.slice(r.target.character - 9, r.target.character), 'res.data;');
});

test('cursor on nothing in particular: what the line assigns, like the CodeLens', () => {
  const r = ask('  $scope.rows = [];', { offset: 1 }); // the indentation, not a word
  assert.strictEqual(r.target.expression, '$scope.rows');
  assert.strictEqual(lineText(r.target.line).slice(r.target.character - 3, r.target.character), '[];');
});

test('a const/let/var is logged AFTER its declaration, never in its temporal dead zone', () => {
  const src = `
angular.module('app', []).controller('SearchCtrl', function ($scope, call) {
  $scope.search = function (query) {
    const payload = $scope.form.scope === 'uploaded'
      ? { query: query }
      : {
          query: query,
          topK: 5
        };
    console.log('test: ', payload);
    for (const row of $scope.rows) { row.seen = true; }
  };
});
`;
  const f = C.extractJs(src, { ...C.DEFAULT_CONFIG, root: '/tmp' });
  const at = (needle, offset = 0) => C.logHereAt(src, f, src.indexOf(needle) + offset);
  const line = (n) => src.split('\n')[n];

  for (const r of [at('payload ='), at('const payload')]) {
    assert.strictEqual(r.target.expression, 'payload');
    assert.strictEqual(r.target.logMessage, 'payload = {payload}');
    // Right after the whole multi-line declaration, not at its first line.
    assert.strictEqual(line(r.target.line).slice(0, r.target.character).trim(), '};');
  }
  // A loop variable has no "after" of its own: logged where the line is about to use it.
  const row = at('row of');
  assert.strictEqual(line(row.target.line).trim().slice(0, 5), 'for (');
});

test('refused, with a reason: a call, `this` in a callback, nonsense, a blank line', () => {
  assert.deepStrictEqual(ask('load())', { selection: 'load()' }), { reason: 'call' });
  assert.deepStrictEqual(ask('load())'), { reason: 'call' }, 'the chain under the cursor is a call');
  assert.deepStrictEqual(ask('this.wrong'), { reason: 'this-in-callback' });
  assert.deepStrictEqual(ask('vm.form.owner', { selection: 'a +' }), { reason: 'unparsable' });
  assert.deepStrictEqual(C.logHereAt(SRC, facts, 0), { reason: 'nothing-here' }, 'the blank first line');
});

test('a file that barely parses gives a reason, never a throw or a guess', () => {
  // `parseJsTolerant` recovers what it can, so this is "nothing here", not a parse failure.
  assert.deepStrictEqual(C.logHereAt('function ( {', facts, 5), { reason: 'nothing-here' });
  assert.doesNotThrow(() => C.logHereAt('', facts, 0));
});
