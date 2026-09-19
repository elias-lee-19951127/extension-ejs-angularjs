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

test('formatType: 8 keys per object, 2 levels of nesting', () => {
  const props = Object.fromEntries('abcdefghij'.split('').map((k) => [k, { kind: 'primitive', primitive: 'number' }]));
  assert.strictEqual(
    C.formatType(C.fromShape({ kind: 'object', props })),
    '{ a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, …+2 }',
  );
  const deep = { kind: 'object', props: { l1: { kind: 'object', props: { l2: { kind: 'object', props: { x: { kind: 'primitive' } } } } } } };
  assert.strictEqual(C.formatType(C.fromShape(deep)), '{ l1: { l2: {…} } }');
});
