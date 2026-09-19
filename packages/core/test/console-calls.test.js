/**
 * observed-types-r1 ticket 02: which scope variable a logged value shows — `JsFacts.consoleCalls`
 * for `console.*` calls, `scopeTargetAt` for logpoint expressions. .scratch/observed-types-r1/spec.md
 * decisions #1, #2, #10.
 */
const test = require('node:test');
const assert = require('node:assert');
const inspector = require('node:inspector');
const vm = require('node:vm');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const C = require('../dist');

const extract = (source) => C.extractJs(source, { ...C.DEFAULT_CONFIG, root: '/tmp' });
const targets = (call) => call.args.map((a) => (a ? `${a.owner}:${a.path.join('.')}` : null));

function workspace(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-console-'));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content);
  const ws = new C.Workspace({ root }, join(root, '.index.ndjson'));
  t.after(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });
  ws.index();
  return ws;
}

test('each argument of a console call maps to the scope variable it reads, or null', () => {
  const src = `
angular.module('app', []).controller('ListCtrl', ['$http', '$scope', function ($http, s) {
  var vm = this;
  console.log('rows', s.rows, vm.form.owner, s.rows[0], s.count(), res);
  $http.get('/x').then(function (res) {
    console.info(vm.rows, this.rows);
  });
}]);
`;
  const facts = extract(src);
  assert.strictEqual(facts.consoleCalls.length, 2);
  const [first, second] = facts.consoleCalls;
  assert.deepStrictEqual(targets(first), [null, 'ListCtrl:rows', 'ListCtrl:form.owner', null, null, null]);
  assert.strictEqual(src.slice(first.method.start, first.method.end), 'log');
  // In a callback: `vm` still is the controller, `this` no longer is.
  assert.deepStrictEqual(targets(second), ['ListCtrl:rows', null]);
});

test('not a console call to map: a local console, console["log"], a wrapper, a call with no scope argument', () => {
  const facts = extract(`
angular.module('app', []).controller('C', function ($scope, logger) {
  console['log']($scope.rows);
  logger.debug($scope.rows);
  console.log('plain text', 42);
  (function (console) { console.log($scope.rows); })(window.console);
});
console.log($scope.rows); // outside any declaration
`);
  assert.deepStrictEqual(facts.consoleCalls, []);
});

test('arguments after a spread no longer line up with what the runtime gets', () => {
  const facts = extract(`
angular.module('app', []).controller('C', function ($scope) {
  console.log($scope.a, ...$scope.list, $scope.b);
});
`);
  assert.deepStrictEqual(targets(facts.consoleCalls[0]), ['C:a', null, null]);
});

test('V8 reports a console call where consoleCallAt looks for it — the method name', async (t) => {
  // Run the file for real and take the frame V8 reports, instead of trusting a column counted by hand.
  const src = `var angular = { module: function () { return { controller: function (n, f) { f({ rows: [1] }); return this; } }; } };
angular.module('app', []).controller('C', function ($scope) {
  if ($scope) { console
    . warn ( 'x', $scope.rows ); }
});
`;
  const session = new inspector.Session();
  session.connect();
  t.after(() => session.disconnect());
  const frames = [];
  session.on('Runtime.consoleAPICalled', (m) => frames.push(m.params.stackTrace.callFrames[0]));
  await new Promise((r) => session.post('Runtime.enable', r));
  // The real console: a stub would not be a console API call, and V8 would report nothing.
  vm.runInThisContext(src, { filename: 'console-call-position.js' });
  await new Promise((r) => setImmediate(r));
  const frame = frames.find((f) => f.url === 'console-call-position.js');
  assert.ok(frame, 'the console call was observed');
  const call = C.consoleCallAt(extract(src), C.offsetForLocation(src, frame.lineNumber, frame.columnNumber));
  assert.ok(call, 'the frame points at a recorded call');
  assert.deepStrictEqual(targets(call), [null, 'C:rows']);
});

test('logpoint expressions resolve where the logpoint runs, through Workspace', (t) => {
  const ws = workspace(t, {
    'list.js': `
angular.module('app', []).controller('ListCtrl', function ($scope, $http) {
  var vm = this;
  $scope.rows = [];
  $http.get('/x').then(function (res) {
    var local = res.data;
    $scope.rows = local;
  });
});
angular.module('app').controller('OtherCtrl', function ($scope) {
  $scope.rows = 1;
});
`,
  });
  const src = ws.source('list.js');
  const inList = src.indexOf('$scope.rows = [];');
  const inCallback = src.indexOf('$scope.rows = local;');
  const inOther = src.indexOf('$scope.rows = 1;');
  const target = (offset, expr) => {
    const r = ws.scopeTargetAt('list.js', offset, expr);
    return r ? `${r.owner}:${r.path.join('.')}` : null;
  };

  assert.strictEqual(target(inList, '$scope.rows'), 'ListCtrl:rows');
  assert.strictEqual(target(inList, ' vm.form.owner '), 'ListCtrl:form.owner');
  assert.strictEqual(target(inList, 'this.rows'), 'ListCtrl:rows');
  assert.strictEqual(target(inCallback, 'vm.rows'), 'ListCtrl:rows');
  assert.strictEqual(target(inCallback, 'this.rows'), null, '`this` of the callback is not the controller');
  assert.strictEqual(target(inOther, '$scope.rows'), 'OtherCtrl:rows');
  assert.strictEqual(target(inOther, 'vm.rows'), null, '`vm` is not declared in OtherCtrl');
  for (const expr of ['local', 'res.data', 'rows.length', '$scope.rows || []', '$scope.rows[0]', '$scope.count()', 'a b', '']) {
    assert.strictEqual(target(inCallback, expr), null, expr);
  }
  assert.strictEqual(target(0, '$scope.rows'), null, 'outside every declaration');
});

test('a console call is found through Workspace at its method name only', (t) => {
  const ws = workspace(t, {
    'a.js': `angular.module('app', []).controller('C', function ($scope) { console.log($scope.rows); });\n`,
  });
  const offset = ws.source('a.js').indexOf('log(');
  assert.deepStrictEqual(targets(ws.consoleCallAt('a.js', offset)), ['C:rows']);
  assert.strictEqual(ws.consoleCallAt('a.js', offset + 1), null);
});
