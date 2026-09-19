/**
 * observed-types ticket 01: `JsFacts.scopeWrites` records EVERY assignment onto a controller's
 * scope — nested ones included — with typed primitives, a nullable flag and whether it runs in a
 * callback. `scopeMembers` keeps only the first assignment, as before.
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist');

const extract = (source) => C.extractJs(source, { ...C.DEFAULT_CONFIG, root: '/tmp' });
const writesOf = (facts, name) => facts.scopeWrites.filter((w) => w.path[0] === name);

test('every assignment is recorded, not just the first — scopeMembers still keeps only the first', () => {
  const facts = extract(`
angular.module('app', []).controller('FormCtrl', function ($scope, Api) {
  $scope.form = { name: '', email: '' };
  $scope.edit = function (u) { $scope.form = { name: u.name, email: u.email, id: u.id }; };
  $scope.close = function () { $scope.form = null; };
});
`);
  const writes = writesOf(facts, 'form');
  assert.strictEqual(writes.length, 3);
  assert.deepStrictEqual(Object.keys(writes[0].shapes[0].props), ['name', 'email']);
  assert.deepStrictEqual(Object.keys(writes[1].shapes[0].props), ['name', 'email', 'id']);
  assert.deepStrictEqual(writes.map((w) => w.nullable), [false, false, true]);
  assert.deepStrictEqual(writes[2].shapes, []);
  assert.deepStrictEqual(writes.map((w) => w.inCallback), [false, true, true]);
  assert.ok(writes.every((w) => w.owner === 'FormCtrl' && w.via === '$scope'));

  assert.strictEqual(facts.scopeMembers.filter((m) => m.name === 'form').length, 1, 'scopeMembers unchanged');
});

test('nested writes record the full path, spanning the last property name', () => {
  const src = `
angular.module('app', []).controller('ListCtrl', function ($scope) {
  $scope.state = {};
  $scope.state.filter.text = 'x';
  $scope.map[key] = 1;
});
`;
  const facts = extract(src);
  const nested = facts.scopeWrites.find((w) => w.path.length === 3);
  assert.deepStrictEqual(nested.path, ['state', 'filter', 'text']);
  assert.strictEqual(src.slice(nested.span.start, nested.span.end), 'text');
  assert.deepStrictEqual(nested.shapes, [{ kind: 'primitive', primitive: 'string' }]);
  assert.ok(!facts.scopeWrites.some((w) => w.path[0] === 'map'), 'a computed key is not a static path');
});

test('each branch of a ternary / logical expression is a shape; an explicit null makes it nullable', () => {
  const facts = extract(`
angular.module('app', []).controller('C', function ($scope, u) {
  $scope.user = u ? { name: u.name } : null;
  $scope.list = u.items || [];
  $scope.label = u.label || undefined;
  $scope.plain = u.x;
});
`);
  const [user] = writesOf(facts, 'user');
  assert.strictEqual(user.nullable, true);
  assert.deepStrictEqual(user.shapes.map((s) => s.kind), ['object']);

  const [list] = writesOf(facts, 'list');
  assert.strictEqual(list.nullable, false);
  assert.deepStrictEqual(list.shapes.map((s) => s.kind), ['unknown', 'array']);

  assert.strictEqual(writesOf(facts, 'label')[0].nullable, true);
  assert.strictEqual(writesOf(facts, 'plain')[0].nullable, false, 'only an EXPLICIT null/undefined counts');
});

test('an assignment inside a .then() callback is marked inCallback and keeps its source text', () => {
  const facts = extract(`
angular.module('app', []).controller('C', ['$scope', '$http', function ($scope, $http) {
  $http.get('/rows').then(function (res) { $scope.rows =   res.data; });
}]);
`);
  const [rows] = writesOf(facts, 'rows');
  assert.strictEqual(rows.inCallback, true);
  assert.deepStrictEqual(rows.shapes, [{ kind: 'unknown' }]);
  assert.strictEqual(rows.rhsText, 'res.data');
});

test('array DI with a renamed $scope parameter is still recognized', () => {
  const facts = extract(`
angular.module('app', []).controller('C', ['$scope', 'aocs', function (s, a) { s.busy = true; }]);
`);
  const [busy] = writesOf(facts, 'busy');
  assert.strictEqual(busy.via, '$scope');
  assert.deepStrictEqual(busy.shapes, [{ kind: 'primitive', primitive: 'boolean' }]);
});

test('`this` inside a nested non-arrow function is not the controller; inside an arrow function it is', () => {
  const facts = extract(`
angular.module('app', []).controller('C', function ($timeout) {
  this.ready = false;
  $timeout(function () { this.ready = true; });
  $timeout(() => { this.ready = true; });
});
`);
  const ready = writesOf(facts, 'ready');
  assert.strictEqual(ready.length, 2);
  assert.deepStrictEqual(ready.map((w) => [w.via, w.inCallback]), [['this', false], ['this', true]]);
});

test('`var vm = this` is the controller, in nested callbacks too; a nested `vm` parameter or `this` capture is not', () => {
  const facts = extract(`
angular.module('app', []).controller('C', function ($http) {
  var vm = this;
  vm.rows = [];
  $http.get('/r').then(function (res) { vm.rows = res.data; vm.state.loaded = true; });
  function other(vm) { vm.notMine = 1; }
  $http.get('/x').then(function () { var self = this; self.alsoNot = 2; });
});
`);
  const rows = writesOf(facts, 'rows');
  assert.deepStrictEqual(rows.map((w) => [w.via, w.inCallback, w.rhsText]), [['this', false, '[]'], ['this', true, 'res.data']]);
  assert.deepStrictEqual(writesOf(facts, 'state').map((w) => w.path), [['state', 'loaded']]);
  assert.deepStrictEqual(writesOf(facts, 'notMine'), []);
  assert.deepStrictEqual(writesOf(facts, 'alsoNot'), []);

  // scopeMembers (definition's declaration site) sees it too — the first assignment only.
  const members = facts.scopeMembers.filter((m) => m.name === 'rows');
  assert.deepStrictEqual(members.map((m) => [m.via, m.owner]), [['this', 'C']]);
  assert.ok(!facts.scopeMembers.some((m) => m.name === 'notMine' || m.name === 'alsoNot'));
});

test('primitives are typed: string, number, boolean, and expressions that obviously yield one', () => {
  const facts = extract(`
angular.module('app', []).controller('C', function ($scope, n, a, b) {
  $scope.s = 'a';
  $scope.n = 1;
  $scope.b = !n;
  $scope.eq = a === b;
  $scope.msg = 'n=' + n;
  $scope.t = \`x\${n}\`;
  $scope.neg = -n;
  $scope.sum = a + b;
});
`);
  const kind = (name) => writesOf(facts, name)[0].shapes[0];
  assert.deepStrictEqual(
    ['s', 'n', 'b', 'eq', 'msg', 't', 'neg'].map((x) => kind(x).primitive),
    ['string', 'number', 'boolean', 'boolean', 'string', 'string', 'number'],
  );
  assert.deepStrictEqual(kind('sum'), { kind: 'unknown' }, 'a + b of unknowns could be either');
});

// ---------------------------------------------------------------- log-variable ticket 01

/** What sits right after each write's `after`: where a logpoint would go. */
const afterOf = (src, facts, name) =>
  writesOf(facts, name).map((w) => (w.after === undefined ? null : JSON.stringify(src.slice(w.after - 1, w.after + 6))));

test('`after` is right past the statement an assignment is — multi-line, one-line function, one-line if, no semicolon', () => {
  const src = `
angular.module('app', []).controller('C', function ($scope, $http) {
  $http.get('/a').then(function (res) {
    $scope.a = res.data;
    done();
  });
  $http.get('/b').then(function (res) { $scope.b = res.data; });
  var d = function (res) { if (res) { $scope.d = res.data; } return 1; };
  $scope.e = 1
  $scope.f = 2;
});
`;
  const facts = extract(src);
  assert.deepStrictEqual(afterOf(src, facts, 'a'), ['";\\n    d"']);
  assert.deepStrictEqual(afterOf(src, facts, 'b'), ['"; });\\n "']);
  assert.deepStrictEqual(afterOf(src, facts, 'd'), ['"; } ret"']);
  assert.deepStrictEqual(afterOf(src, facts, 'e'), ['"1\\n  $sc"'], 'no `;`: the end of the expression');
  assert.deepStrictEqual(writesOf(facts, 'a').map((w) => w.lhsText), ['$scope.a']);
});

test('`after` climbs a chain of assignments, and is absent when the assignment is inside another expression', () => {
  const src = `
angular.module('app', []).controller('C', function ($scope) {
  $scope.x = $scope.y = 0;
  $scope.load = function () { return $scope.r = 1; };
  if (($scope.i = next())) {}
  call($scope.c = 1);
  for (var k = 0; k < 2; $scope.k = k++) {}
  var go = () => $scope.arrow = 1;
});
`;
  const facts = extract(src);
  const stmtEnd = src.indexOf('0;') + 2;
  assert.deepStrictEqual(writesOf(facts, 'x').map((w) => w.after), [stmtEnd]);
  assert.deepStrictEqual(writesOf(facts, 'y').map((w) => w.after), [stmtEnd]);
  for (const name of ['r', 'i', 'c', 'k', 'arrow']) assert.deepStrictEqual(writesOf(facts, name).map((w) => w.after), [undefined], name);
});

test('`lhsText` is the left side as written: a renamed $scope, a vm alias, this', () => {
  const facts = extract(`
angular.module('app', []).controller('C', ['$scope', function (s) {
  var vm = this;
  s.rows = [];
  vm.form = {};
  this.form.owner = null;
}]);
`);
  assert.deepStrictEqual(facts.scopeWrites.map((w) => w.lhsText), ['s.rows', 'vm.form', 'this.form.owner']);
});
