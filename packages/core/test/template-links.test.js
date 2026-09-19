/**
 * template-roots-config ticket 01: `templateUrl` (directive, component, $routeProvider,
 * $stateProvider) mapped to a file through `templateRoots`, `res.render()` views through
 * `expressViewsDir`, and the linked controller joined into the template's scope — all through
 * the public `Workspace` API.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const C = require('../dist');
const { at, textAt } = require('./helpers');

function workspace(t, files, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-tpl-links-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const ws = new C.Workspace({ root, ...config }, join(root, '.index.ndjson'));
  // One hook, in this order: close() writes the index file, so the directory must outlive it.
  t.after(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });
  ws.index();
  return ws;
}

const ROOTS = { templateRoots: [{ urlPrefix: '/views/', fsPath: 'src/views', extensions: ['.ejs', '.html'] }] };

const ROUTE_APP = `
angular.module('app', ['ngRoute'])
  .controller('ProfileCtrl', function () { this.fullName = 'x'; })
  .config(function ($routeProvider) {
    $routeProvider.when('/profile', { templateUrl: '/views/profile.html', controller: 'ProfileCtrl', controllerAs: 'vm' });
  });
`;

test('route: templateUrl mapped through templateRoots (.html URL -> .ejs file) binds the controller to the template', (t) => {
  const ws = workspace(t, { 'src/app.js': ROUTE_APP, 'src/views/profile.ejs': '<h1>{{ vm.fullName }}</h1>\n' }, ROOTS);

  const d = ws.definitionAt('src/views/profile.ejs', at(ws, 'src/views/profile.ejs', 'fullName'));
  assert.strictEqual(d.targets.length, 1, d.reason);
  assert.strictEqual(d.targets[0].path, 'src/app.js');
  assert.strictEqual(textAt(ws, d.targets[0]), 'fullName');
  assert.deepStrictEqual(ws.templateLinkIssues(), []);
});

test('route: without templateRoots the same URL maps to no file, is reported, and binds nothing', (t) => {
  const ws = workspace(t, { 'src/app.js': ROUTE_APP, 'src/views/profile.ejs': '<h1>{{ vm.fullName }}</h1>\n' });

  const d = ws.definitionAt('src/views/profile.ejs', at(ws, 'src/views/profile.ejs', 'fullName'));
  assert.strictEqual(d.targets.length, 0);
  const issues = ws.templateLinkIssues();
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].reason, 'no-file');
  assert.strictEqual(issues[0].url, '/views/profile.html');
  assert.strictEqual(issues[0].path, 'src/app.js');
});

test('Ctrl+click on a templateUrl string opens the template it maps to', (t) => {
  const ws = workspace(t, { 'src/app.js': ROUTE_APP, 'src/views/profile.ejs': '<h1>{{ vm.fullName }}</h1>\n' }, ROOTS);

  const d = ws.definitionAt('src/app.js', at(ws, 'src/app.js', '/views/profile.html'));
  assert.strictEqual(d.targets.length, 1, d.reason);
  assert.strictEqual(d.targets[0].path, 'src/views/profile.ejs');
  assert.strictEqual(d.targets[0].kind, 'template');
});

test('directive DDO: `controller: "Name as alias"` binds, $scope members resolve too', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', [])
  .controller('CardCtrl', function ($scope) { $scope.title = 't'; this.count = 1; })
  .directive('userCard', function () {
    return { restrict: 'E', templateUrl: '/views/card.html', controller: 'CardCtrl as card' };
  });
`,
      'src/views/card.html': '<div>{{ title }} {{ card.count }}</div>\n',
    },
    ROOTS,
  );
  const tpl = 'src/views/card.html';

  const title = ws.definitionAt(tpl, at(ws, tpl, 'title'));
  assert.strictEqual(title.targets.length, 1, title.reason);
  assert.strictEqual(textAt(ws, title.targets[0]), 'title');

  const count = ws.definitionAt(tpl, at(ws, tpl, 'count'));
  assert.strictEqual(count.targets.length, 1, count.reason);
  assert.strictEqual(textAt(ws, count.targets[0]), 'count');
});

test('component: the controller is published as $ctrl when controllerAs is omitted', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', [])
  .controller('BadgeCtrl', function () { this.label = 'x'; })
  .component('badge', { templateUrl: '/views/badge.html', controller: 'BadgeCtrl' });
`,
      'src/views/badge.ejs': '<span>{{ $ctrl.label }}</span>\n',
    },
    ROOTS,
  );
  const d = ws.definitionAt('src/views/badge.ejs', at(ws, 'src/views/badge.ejs', 'label'));
  assert.strictEqual(d.targets.length, 1, d.reason);
  assert.strictEqual(textAt(ws, d.targets[0]), 'label');
});

test('$stateProvider: a named view binds its own controller to its own template', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', ['ui.router'])
  .controller('MenuCtrl', function () { this.items = []; })
  .config(function ($stateProvider) {
    $stateProvider.state('home', {
      url: '/',
      views: { menu: { templateUrl: '/views/menu.html', controller: 'MenuCtrl', controllerAs: 'm' } },
    });
  });
`,
      'src/views/menu.ejs': '<li ng-repeat="i in m.items">{{ i }}</li>\n',
    },
    ROOTS,
  );
  const d = ws.definitionAt('src/views/menu.ejs', at(ws, 'src/views/menu.ejs', 'items'));
  assert.strictEqual(d.targets.length, 1, d.reason);
  assert.strictEqual(textAt(ws, d.targets[0]), 'items');
});

test('an ng-controller inside the template still wins over the linked controller', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', [])
  .controller('OuterCtrl', function ($scope) { $scope.name = 'outer'; })
  .controller('InnerCtrl', function ($scope) { $scope.name = 'inner'; })
  .config(function ($routeProvider) {
    $routeProvider.when('/', { templateUrl: '/views/page.html', controller: 'OuterCtrl' });
  });
`,
      'src/views/page.html': '<div ng-controller="InnerCtrl">{{ name }}</div>\n',
    },
    ROOTS,
  );
  const d = ws.definitionAt('src/views/page.html', at(ws, 'src/views/page.html', 'name }}'));
  assert.strictEqual(d.targets.length, 1, d.reason);
  const src = ws.source(d.targets[0].path);
  assert.ok(src.slice(0, d.targets[0].span.start).includes("controller('InnerCtrl'"), 'expected the InnerCtrl declaration');
});

test('dynamic templateUrl is reported as unresolved, not guessed', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
var base = '/views';
angular.module('app', []).directive('pane', function () { return { templateUrl: base + '/pane.html' }; });
`,
      'src/views/pane.html': '<div></div>\n',
    },
    ROOTS,
  );
  const issues = ws.templateLinkIssues();
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].reason, 'dynamic');
  assert.strictEqual(issues[0].url, null);
  assert.strictEqual(issues[0].owner, 'pane');

  // The expression is still ordinary code: `base` jumps to its declaration.
  const d = ws.definitionAt('src/app.js', at(ws, 'src/app.js', "base + '/pane"));
  assert.strictEqual(d.targets.length, 1, d.reason);
  assert.strictEqual(d.targets[0].span.start, at(ws, 'src/app.js', 'base'));
});

test('one template given two different controllers is reported and bound to neither', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', [])
  .controller('ACtrl', function ($scope) { $scope.x = 1; })
  .controller('BCtrl', function ($scope) { $scope.x = 2; })
  .config(function ($routeProvider) {
    $routeProvider
      .when('/a', { templateUrl: '/views/shared.html', controller: 'ACtrl' })
      .when('/b', { templateUrl: '/views/shared.html', controller: 'BCtrl' });
  });
`,
      'src/views/shared.html': '<p>{{ x }}</p>\n',
    },
    ROOTS,
  );
  const issues = ws.templateLinkIssues();
  assert.strictEqual(issues.length, 2);
  assert.ok(issues.every((i) => i.reason === 'ambiguous-controller'));
  assert.deepStrictEqual(ws.scopeChainAt('src/views/shared.html', at(ws, 'src/views/shared.html', 'x }}')).map((f) => f.kind), ['root']);
});

test('res.render: the view name maps through expressViewsDir, and an EJS local jumps to the key passed', (t) => {
  const ws = workspace(
    t,
    {
      'server/routes.js': `
app.get('/me', function (req, res) {
  res.render('user/profile', { user: req.user, theme: 'dark' });
});
`,
      'server/templates/user/profile.ejs': '<h1><%= user.name %></h1>\n',
    },
    { expressViewsDir: 'server/templates' },
  );

  const view = ws.definitionAt('server/routes.js', at(ws, 'server/routes.js', 'user/profile'));
  assert.strictEqual(view.targets.length, 1, view.reason);
  assert.strictEqual(view.targets[0].path, 'server/templates/user/profile.ejs');

  const tpl = 'server/templates/user/profile.ejs';
  const local = ws.definitionAt(tpl, at(ws, tpl, 'user.name'));
  assert.strictEqual(local.targets.length, 1, local.reason);
  assert.strictEqual(local.targets[0].path, 'server/routes.js');
  assert.strictEqual(textAt(ws, local.targets[0]), 'user');
});

test('completion in a bound template offers the linked controller scope members', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', [])
  .controller('ListCtrl', function ($scope) { $scope.rows = []; $scope.loading = false; })
  .config(function ($routeProvider) { $routeProvider.when('/', { templateUrl: '/views/list.html', controller: 'ListCtrl' }); });
`,
      'src/views/list.html': '<p>{{ loading }}</p>\n',
    },
    ROOTS,
  );
  const names = ws.completionAt('src/views/list.html', at(ws, 'src/views/list.html', 'loading')).map((c) => c.name);
  assert.deepStrictEqual(names.sort(), ['loading', 'rows']);
});

test('rename of a $scope member also edits the template bound to it by templateUrl', (t) => {
  const ws = workspace(
    t,
    {
      'src/app.js': `
angular.module('app', [])
  .controller('ListCtrl', function ($scope) { $scope.loading = false; })
  .config(function ($routeProvider) { $routeProvider.when('/', { templateUrl: '/views/list.html', controller: 'ListCtrl' }); });
`,
      'src/views/list.html': '<p ng-if="loading">{{ loading }}</p>\n',
    },
    ROOTS,
  );
  const r = ws.renameAt('src/app.js', at(ws, 'src/app.js', 'loading'), 'busy');
  assert.deepStrictEqual(
    r.edits.map((e) => e.path).sort(),
    ['src/app.js', 'src/views/list.html', 'src/views/list.html'],
    r.reason,
  );
});
