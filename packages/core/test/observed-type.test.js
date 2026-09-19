/**
 * observed-types ticket 02: every assignment merged into one Observed Type, queried at a template
 * position through `Workspace.observedTypeAt` — .scratch/observed-types/spec.md decisions #3–#7.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const C = require('../dist');
const { at } = require('./helpers');

function workspace(t, files, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-observed-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const ws = new C.Workspace({ root, ...config }, join(root, '.index.ndjson'));
  t.after(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });
  ws.index();
  return ws;
}

const typeAt = (ws, rel, needle, opts) => ws.observedTypeAt(rel, at(ws, rel, needle, opts));

test('assignments with different keys merge into one object, missing keys optional; an explicit null makes it nullable', (t) => {
  const ws = workspace(t, {
    'app.js': `
angular.module('app', []).controller('FormCtrl', function ($scope) {
  $scope.form = { name: '', email: '' };
  $scope.edit = function (u) { $scope.form = { name: u.name, email: u.email, id: u.id }; };
  $scope.close = function () { $scope.form = null; };
});
`,
    'page.html': '<form ng-controller="FormCtrl">{{ form.name }}</form>\n',
  });
  const r = typeAt(ws, 'page.html', 'form.name');
  assert.strictEqual(r.expression, 'form');
  assert.strictEqual(r.text, '{ name: string, email: string, id?: unknown } | null');
  assert.strictEqual(r.nullable, true);
  assert.strictEqual(r.onlyInCallback, false);
  assert.strictEqual(r.sites.length, 3);

  const name = typeAt(ws, 'page.html', 'name }}');
  assert.strictEqual(name.expression, 'form.name');
  assert.strictEqual(name.text, 'string');
  assert.strictEqual(name.nullable, false);
});

test('assignments of different kinds stay a union', (t) => {
  const ws = workspace(t, {
    'app.js': `angular.module('app', []).controller('C', function ($scope) { $scope.v = 'a'; $scope.reset = function () { $scope.v = 0; }; });`,
    'page.html': '<p ng-controller="C">{{ v }}</p>\n',
  });
  assert.strictEqual(typeAt(ws, 'page.html', 'v }}').text, 'string | number');
});

test('a nested assignment adds its key to the object — optional, not nullable', (t) => {
  const ws = workspace(t, {
    'app.js': `
angular.module('app', []).controller('C', function ($scope) {
  $scope.state = {};
  $scope.load = function () { $scope.state.loading = true; };
});
`,
    'page.html': '<p ng-controller="C" ng-if="state.loading">{{ state }}</p>\n',
  });
  const loading = typeAt(ws, 'page.html', 'loading');
  assert.strictEqual(loading.text, 'boolean');
  assert.strictEqual(loading.nullable, false);
  assert.strictEqual(typeAt(ws, 'page.html', 'state.loading').text, '{ loading?: boolean }');
});

test('a controller declared in two files: only the copy nearest the template counts', (t) => {
  const ctrl = (value) => `angular.module('app', []).controller('C', function ($scope) { $scope.x = ${value}; });`;
  const ws = workspace(t, {
    'a/ctrl.js': ctrl("'text'"),
    'a/page.html': '<p ng-controller="C">{{ x }}</p>\n',
    'b/deep/ctrl.js': ctrl('42'),
  });
  const r = typeAt(ws, 'a/page.html', 'x }}');
  assert.strictEqual(r.text, 'string');
  assert.deepStrictEqual(r.sites.map((s) => s.path), ['a/ctrl.js']);
});

test('an ng-repeat item is the element type of its collection, through a controllerAs alias too', (t) => {
  const ws = workspace(t, {
    'app.js': `angular.module('app', []).controller('ListCtrl', function () { this.rows = [{ id: 1, label: 'x' }]; });`,
    'page.html': '<ul ng-controller="ListCtrl as vm"><li ng-repeat="row in vm.rows">{{ row.label }}</li></ul>\n',
  });
  assert.strictEqual(typeAt(ws, 'page.html', 'rows"').text, '{ id: number, label: string }[]');
  assert.strictEqual(typeAt(ws, 'page.html', 'row.label').text, '{ id: number, label: string }');
  assert.strictEqual(typeAt(ws, 'page.html', 'label }}').text, 'string');
});

test('a template bound by templateUrl gets the types of its linked controller', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', [])
  .controller('ProfileCtrl', function () { this.tags = ['a']; })
  .config(function ($routeProvider) {
    $routeProvider.when('/', { templateUrl: '/views/profile.html', controller: 'ProfileCtrl', controllerAs: 'vm' });
  });
`,
      'src/views/profile.ejs': '<p>{{ vm.tags }}</p>\n',
    },
    { templateRoots: [{ urlPrefix: '/views/', fsPath: 'src/views', extensions: ['.ejs'] }] },
  );
  assert.strictEqual(typeAt(ws, 'src/views/profile.ejs', 'tags').text, 'string[]');
});

test('a value only assigned from an HTTP response is not guessed: no text, the source is named, only in a callback', (t) => {
  const ws = workspace(t, {
    'app.js': `
angular.module('app', []).controller('C', function ($scope, $http) {
  $http.get('/stats').then(function (res) { $scope.stats = res.data; });
});
`,
    'page.html': '<p ng-controller="C">{{ stats }}</p>\n',
  });
  const r = typeAt(ws, 'page.html', 'stats');
  assert.strictEqual(r.text, null);
  assert.strictEqual(r.onlyInCallback, true);
  assert.deepStrictEqual(r.unknownFrom.map((u) => [u.path, u.rhsText]), [['app.js', 'res.data']]);
});

test('an unknown next to a known shape is dropped from the text but flagged partial', (t) => {
  const ws = workspace(t, {
    'app.js': `
angular.module('app', []).controller('C', function ($scope, $http) {
  $scope.items = [];
  $http.get('/i').then(function (res) { $scope.items = res.data; });
});
`,
    'page.html': '<p ng-controller="C">{{ items }}</p>\n',
  });
  const r = typeAt(ws, 'page.html', 'items');
  assert.strictEqual(r.text, 'unknown[]');
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.onlyInCallback, false);
  assert.deepStrictEqual(r.unknownFrom.map((u) => u.rhsText), ['res.data']);
});

test('nothing assigns it, or the cursor is not on a variable -> null', (t) => {
  const ws = workspace(t, {
    'app.js': `angular.module('app', []).controller('C', function ($scope) { $scope.a = 1; });`,
    'page.html': '<p ng-controller="C">{{ nope }} {{ a[0].b }}</p>\n',
  });
  assert.strictEqual(typeAt(ws, 'page.html', 'nope'), null);
  assert.strictEqual(typeAt(ws, 'page.html', 'b }}'), null);
});

test('in a JS file: the assigned property under the cursor gets the type merged over all its assignments', (t) => {
  const ws = workspace(t, {
    'app.js': `
angular.module('app', []).controller('C', function ($scope) {
  $scope.form = { name: '' };
  $scope.reset = function () { $scope.form = null; $scope.form.extra = 1; };
  this.other = 2;
});
`,
  });
  const form = typeAt(ws, 'app.js', 'form = {', { offset: 1 });
  assert.strictEqual(form.expression, 'form');
  assert.strictEqual(form.text, '{ name: string, extra?: number } | null');
  assert.strictEqual(form.sites.length, 2); // the nested `form.extra = 1` is a site of `form.extra`, not of `form`

  const extra = typeAt(ws, 'app.js', 'extra');
  assert.strictEqual(extra.expression, 'form.extra');
  assert.strictEqual(extra.text, 'number');

  assert.strictEqual(typeAt(ws, 'app.js', 'other').text, 'number');

  // `$scope` itself, or the object part of a nested assignment: not the assigned property -> null.
  assert.strictEqual(typeAt(ws, 'app.js', '$scope.form = {'), null);
  assert.strictEqual(typeAt(ws, 'app.js', 'form.extra'), null);
});

test('controllerAs written through `var vm = this`: definition and observed type reach the controller', (t) => {
  const ws = workspace(t, {
    'app.js': `
angular.module('app', []).controller('ListCtrl', function ($http) {
  var vm = this;
  vm.rows = null;
  $http.get('/rows').then(function () { vm.rows = [{ id: 1 }]; });
});
`,
    'page.html': '<ul ng-controller="ListCtrl as vm"><li ng-repeat="row in vm.rows">{{ row.id }}</li></ul>\n',
  });
  const def = ws.definitionAt('page.html', at(ws, 'page.html', 'rows"'));
  assert.deepStrictEqual(def.targets.map((d) => [d.path, ws.source(d.path).slice(d.span.start, d.span.end)]), [['app.js', 'rows']]);

  const rows = typeAt(ws, 'page.html', 'rows"');
  assert.strictEqual(rows.text, '{ id: number }[] | null');
  assert.strictEqual(rows.sites.length, 2);
  assert.strictEqual(typeAt(ws, 'page.html', 'id }}').text, 'number');
});

test('nullableHints: one hint after each variable explicitly assigned null — not for callback-only, unknown, or EJS locals', (t) => {
  const ws = workspace(t, {
    'app.js': `
angular.module('app', []).controller('C', function ($scope, $http) {
  $scope.user = null;
  $scope.state = { error: null };
  $scope.items = [];
  $http.get('/s').then(function (res) { $scope.user = res.data.user; $scope.stats = res.data; $scope.items = res.data; });
});
`,
    'page.ejs':
      '<div ng-controller="C">{{ user.name }} {{ user.name + user.email }}\n' +
      '<p ng-if="state.error">{{ state.error.message }}</p>{{ stats.total }} {{ items.length }} <%= user.name %></div>\n',
  });
  const hints = ws.nullableHints('page.ejs');
  const src = ws.source('page.ejs');
  const shown = hints.map((h) => [h.expression, src.slice(h.offset - h.expression.split('.').pop().length, h.offset)]);
  assert.deepStrictEqual(shown, [
    ['user', 'user'], // {{ user.name }}
    ['user', 'user'], // {{ user.name + user.email }}: once per expression
    ['state.error', 'error'], // ng-if
    ['state.error', 'error'], // {{ state.error.message }}
  ]);
  assert.strictEqual(hints[0].offset, at(ws, 'page.ejs', 'user.name') + 'user'.length);

  // Only the expressions overlapping the range asked for.
  const line2 = at(ws, 'page.ejs', '<p ng-if');
  assert.deepStrictEqual(ws.nullableHints('page.ejs', { start: line2, end: src.length }).map((h) => h.expression), ['state.error', 'state.error']);
});

test('nullableHints: through a controllerAs alias and an ng-repeat item', (t) => {
  const ws = workspace(t, {
    'app.js': `angular.module('app', []).controller('C', function () { var vm = this; vm.rows = [{ owner: null }]; vm.sel = undefined; });`,
    'page.html': '<ul ng-controller="C as vm"><li ng-repeat="row in vm.rows">{{ row.owner.name }} {{ vm.sel.id }}</li></ul>\n',
  });
  assert.deepStrictEqual(ws.nullableHints('page.html').map((h) => h.expression), ['row.owner', 'vm.sel']);
});

test('formatType: 8 keys per object, 2 levels of nesting', () => {
  const props = Object.fromEntries('abcdefghij'.split('').map((k) => [k, { kind: 'primitive', primitive: 'number' }]));
  assert.strictEqual(
    C.formatType(C.fromShape({ kind: 'object', props })),
    '{ a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, …+2 }',
  );
  const deep = { kind: 'object', props: { l1: { kind: 'object', props: { l2: { kind: 'object', props: { x: { kind: 'primitive' } } } } } } };
  assert.strictEqual(C.formatType(C.fromShape(deep)), '{ l1: { l2: {…} } }');
});

// ---------------------------------------------------------------- runtime evidence (observed-types-r1 ticket 04)

/** Feed `ws` runtime evidence the way the server does: a store per connection, each value dug already. */
function withRuntime(ws, stores) {
  ws.setRuntimeEvidence((owner, member) => stores.flatMap((s) => s.forMember(owner, member)));
}

function logValue(store, place, target, value, site, now) {
  store.claim(place, now);
  store.record(place, target, C.typeOfRuntimeValue(value), site, now);
}

const obj = (props) => ({
  object: { type: 'object' },
  properties: Object.entries(props).map(([name, value]) => ({ name, value })),
});
const prim = (type) => ({ object: { type } });
const NULL = { object: { type: 'object', subtype: 'null' } };

const LIST = `
angular.module('app', []).controller('ListCtrl', function ($scope, $http) {
  $scope.rows = [];
  $http.get('/rows').then(function (res) {
    $scope.rows = res.data;
    console.log($scope.rows);
  });
  $scope.sel = find();
});
`;

test('runtime evidence fills in what no assignment could say; the hover still names what was not inferred', (t) => {
  const ws = workspace(t, { 'list.js': LIST, 'list.html': '<ul ng-controller="ListCtrl"><li ng-repeat="row in rows">{{ row.owner.name }} {{ sel }}</li></ul>\n' });
  const before = typeAt(ws, 'list.html', 'rows">');
  assert.strictEqual(before.text, 'unknown[]');
  assert.deepStrictEqual(before.runtime, []);

  const store = new C.RuntimeEvidenceStore('Chrome — localhost:9222');
  const site = { path: 'list.js', span: { start: ws.source('list.js').indexOf('log('), end: 0 } };
  const row = obj({ id: prim('number'), owner: obj({ name: prim('string') }) });
  logValue(store, 'p', { owner: 'ListCtrl', path: ['rows'] }, { object: { type: 'object', subtype: 'array' }, properties: [{ name: '0', value: row }] }, site, 1000);
  logValue(store, 'p2', { owner: 'ListCtrl', path: ['rows'] }, { object: { type: 'object', subtype: 'array' }, properties: [{ name: '0', value: row }] }, site, 2000);
  withRuntime(ws, [store]);

  const after = typeAt(ws, 'list.html', 'rows">');
  assert.strictEqual(after.text, '{ id: number, owner: { name: string } }[]');
  assert.deepStrictEqual(after.unknownFrom.map((u) => u.rhsText), ['res.data'], 'still said: the assignment itself was not inferred');
  assert.deepStrictEqual(after.runtime, [{ connection: 'Chrome — localhost:9222', count: 2, lastSeen: 2000, site }]);
  assert.deepStrictEqual(after.sites.length, 2, '"Assigned at" lists assignments only');
  // Through an ng-repeat item and a nested key.
  assert.strictEqual(typeAt(ws, 'list.html', 'name }}').text, 'string');

  // Gone with the connection.
  withRuntime(ws, []);
  assert.strictEqual(typeAt(ws, 'list.html', 'rows">').text, 'unknown[]');
});

test('null seen at runtime shows in the hover, never in the inline hint', (t) => {
  const ws = workspace(t, { 'list.js': LIST, 'list.html': '<p ng-controller="ListCtrl">{{ sel.name }}</p>\n' });
  const store = new C.RuntimeEvidenceStore('node');
  const site = { path: 'list.js', span: { start: 0, end: 0 } };
  logValue(store, 'a', { owner: 'ListCtrl', path: ['sel'] }, NULL, site, 1);
  logValue(store, 'b', { owner: 'ListCtrl', path: ['sel'] }, obj({ name: prim('string') }), site, 2);
  withRuntime(ws, [store]);

  const r = typeAt(ws, 'list.html', 'sel.name');
  assert.strictEqual(r.text, '{ name: string } | null');
  assert.strictEqual(r.nullable, false, 'no assignment sets it to null');
  assert.strictEqual(r.seenNullAtRuntime, true);
  assert.deepStrictEqual(ws.nullableHints('list.html'), []);
});

test('a member only a runtime has seen still gets a type; two connections give two sightings', (t) => {
  const ws = workspace(t, {
    'a.js': `angular.module('app', []).controller('C', function ($scope, data) { angular.extend($scope, data); console.log($scope.extra); });`,
    'page.html': '<p ng-controller="C">{{ extra }}</p>\n',
  });
  assert.strictEqual(typeAt(ws, 'page.html', 'extra'), null);
  const one = new C.RuntimeEvidenceStore('container-a');
  const two = new C.RuntimeEvidenceStore('container-b');
  const site = { path: 'a.js', span: { start: 0, end: 0 } };
  logValue(one, 'x', { owner: 'C', path: ['extra'] }, prim('number'), site, 5);
  logValue(two, 'x', { owner: 'C', path: ['extra'] }, prim('string'), site, 9);
  withRuntime(ws, [one, two]);
  const r = typeAt(ws, 'page.html', 'extra');
  assert.strictEqual(r.text, 'number | string');
  assert.deepStrictEqual(r.runtime.map((s) => s.connection), ['container-b', 'container-a'], 'most recent first');
  assert.deepStrictEqual(r.sites, []);
});

test('runtime evidence from the farther copy of a duplicated controller is left out, like its assignments', (t) => {
  const ctrl = (v) => `angular.module('app', []).controller('Dup', function ($scope) { $scope.v = ${v}; });`;
  const ws = workspace(t, { 'near/c.js': ctrl('1'), 'near/page.html': '<p ng-controller="Dup">{{ v }}</p>\n', 'far/away/c.js': ctrl('2') });
  const store = new C.RuntimeEvidenceStore('x');
  logValue(store, 'far', { owner: 'Dup', path: ['v'] }, prim('string'), { path: 'far/away/c.js', span: { start: 0, end: 0 } }, 1);
  withRuntime(ws, [store]);
  const r = typeAt(ws, 'near/page.html', 'v }}');
  assert.strictEqual(r.text, 'number');
  assert.deepStrictEqual(r.runtime, []);
});

test('an assignment that could not be inferred carries where to log it and what (log-variable ticket 01)', (t) => {
  const ws = workspace(t, { 'list.js': LIST, 'list.html': '<p ng-controller="ListCtrl">{{ rows }} {{ sel }}</p>\n' });
  const src = ws.source('list.js');
  const [rows] = typeAt(ws, 'list.html', 'rows }}').unknownFrom;
  assert.strictEqual(rows.lhsText, '$scope.rows');
  assert.strictEqual(rows.after, src.indexOf('res.data;') + 'res.data;'.length);
  const [sel] = typeAt(ws, 'list.html', 'sel }}').unknownFrom;
  assert.deepStrictEqual([sel.rhsText, sel.lhsText, sel.after], ['find()', '$scope.sel', src.indexOf('find();') + 'find();'.length]);
});
