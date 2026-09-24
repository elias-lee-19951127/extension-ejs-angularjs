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

test('route: without templateRoots a .html URL still finds the .ejs file it is served from', (t) => {
  const ws = workspace(t, { 'src/app.js': ROUTE_APP, 'src/views/profile.ejs': '<h1>{{ vm.fullName }}</h1>\n' });

  const d = ws.definitionAt('src/views/profile.ejs', at(ws, 'src/views/profile.ejs', 'fullName'));
  assert.strictEqual(d.targets.length, 1, d.reason);
  assert.strictEqual(d.targets[0].path, 'src/app.js');
  assert.deepStrictEqual(ws.templateLinkIssues(), []);
});

test('route: a URL no file answers to, under any extension, is reported and binds nothing', (t) => {
  const ws = workspace(t, { 'src/app.js': ROUTE_APP, 'src/views/other.ejs': '<h1>{{ vm.fullName }}</h1>\n' });

  const d = ws.definitionAt('src/views/other.ejs', at(ws, 'src/views/other.ejs', 'fullName'));
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
angular.module('app', []).directive('pane', function () {
  return { templateUrl: function (el, attrs) { return attrs.tpl; } };
});
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
});

test('a templateUrl built from a constant of the file links; a click on the constant still goes to it', (t) => {
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
  assert.deepStrictEqual(ws.templateLinkIssues(), []);
  const open = ws.definitionAt('src/app.js', at(ws, 'src/app.js', "'/pane.html'"));
  assert.strictEqual(open.targets[0]?.path, 'src/views/pane.html', open.reason);
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

// A templateUrl is fetched relative to the PAGE, so a correct Angular URL is rarely a path from the
// workspace root. None of these declare templateRoots: the URL alone must find the template.
const pageRelativeApp = (url) => `
angular.module('app', [])
  .controller('ListCtrl', function ($scope) { $scope.items = []; })
  .directive('itemList', function () { return { templateUrl: '${url}', controller: 'ListCtrl' }; });
`;

for (const url of ['views/list.html', '/views/list.html', './views/list.html', 'http://localhost:3000/views/list.html']) {
  test(`no templateRoots: '${url}' from public/js/app.js finds public/views/list.html (the page's directory)`, (t) => {
    const ws = workspace(t, {
      'public/js/app.js': pageRelativeApp(url),
      'public/views/list.html': '<li ng-repeat="i in items">{{ i }}</li>\n',
    });

    assert.deepStrictEqual(ws.templateLinkIssues(), []);
    const open = ws.definitionAt('public/js/app.js', at(ws, 'public/js/app.js', 'views/list.html'));
    assert.strictEqual(open.targets.length, 1, open.reason);
    assert.strictEqual(open.targets[0].path, 'public/views/list.html');
    const d = ws.definitionAt('public/views/list.html', at(ws, 'public/views/list.html', 'items'));
    assert.strictEqual(d.targets.length, 1, d.reason);
    assert.strictEqual(d.targets[0].path, 'public/js/app.js');
  });
}

test('no templateRoots: a page served from a sibling directory is found by the end of the path', (t) => {
  const ws = workspace(t, {
    'client/scripts/app.js': pageRelativeApp('app/components/list/list.html'),
    'web/app/components/list/list.html': '<p>{{ items.length }}</p>\n',
  });

  assert.deepStrictEqual(ws.templateLinkIssues(), []);
  const d = ws.definitionAt('web/app/components/list/list.html', at(ws, 'web/app/components/list/list.html', 'items'));
  assert.strictEqual(d.targets.length, 1, d.reason);
});

test('no templateRoots: of two files ending with the URL, the one nearest the script wins; a tie links none', (t) => {
  const near = workspace(t, {
    'admin/js/app.js': pageRelativeApp('partials/list.html'),
    'admin/static/partials/list.html': '<p>{{ items }}</p>\n',
    'shop/static/partials/list.html': '<p>{{ items }}</p>\n',
  });
  const open = near.definitionAt('admin/js/app.js', at(near, 'admin/js/app.js', 'partials/list.html'));
  assert.strictEqual(open.targets[0]?.path, 'admin/static/partials/list.html', open.reason);

  const tie = workspace(t, {
    'js/app.js': pageRelativeApp('partials/list.html'),
    'admin/partials/list.html': '<p>{{ items }}</p>\n',
    'shop/partials/list.html': '<p>{{ items }}</p>\n',
  });
  assert.strictEqual(tie.templateLinkIssues()[0]?.reason, 'no-file');
});

test('gutter markers: a templateUrl marks its template, and the template marks the templateUrl back', (t) => {
  const ws = workspace(t, {
    'public/js/app.js': pageRelativeApp('views/list.html'),
    'public/views/list.html': '<p>{{ items }}</p>\n',
  });

  const js = ws.templateLinkMarkers('public/js/app.js');
  assert.strictEqual(js.length, 1);
  assert.strictEqual(js[0].kind, 'template');
  assert.strictEqual(js[0].target.path, 'public/views/list.html');
  assert.strictEqual(js[0].controller, 'ListCtrl');

  const html = ws.templateLinkMarkers('public/views/list.html');
  assert.strictEqual(html.length, 1);
  assert.strictEqual(html[0].kind, 'templateUrl');
  assert.strictEqual(html[0].target.path, 'public/js/app.js');
  assert.strictEqual(textAt(ws, html[0].target), "'views/list.html'");
});

// An EJS + Angular app: Express serves the templates, so its own code says where a URL lands.
const linked = (ws, js) => ws.templateLinkMarkers(js).map((m) => m.target.path);

test('express.static with a URL prefix maps the templateUrl into the mounted directory', (t) => {
  const ws = workspace(t, {
    'server/app.js': "const path = require('path');\napp.use('/assets', express.static(path.join(__dirname, '..', 'client')));\n",
    'client/js/app.js': pageRelativeApp('/assets/tpl/list.html'),
    'client/tpl/list.html': '<p>{{ items }}</p>\n',
    'other/assets/tpl/list.html': '<p>decoy</p>\n',
  });
  assert.deepStrictEqual(linked(ws, 'client/js/app.js'), ['client/tpl/list.html']);
});

test('a route rendering a view named by the URL maps /partials/list to views/partials/list.ejs', (t) => {
  const ws = workspace(t, {
    'app.js':
      "app.set('views', __dirname + '/server/views');\n" +
      "app.get('/partials/:name', function (req, res) { res.render('partials/' + req.params.name); });\n",
    'public/js/app.js': pageRelativeApp('/partials/list'),
    'server/views/partials/list.ejs': '<p>{{ items }}</p>\n',
  });
  assert.deepStrictEqual(linked(ws, 'public/js/app.js'), ['server/views/partials/list.ejs']);
  const d = ws.definitionAt('server/views/partials/list.ejs', at(ws, 'server/views/partials/list.ejs', 'items'));
  assert.strictEqual(d.targets[0]?.path, 'public/js/app.js', d.reason);
});

test('with no server code, an extension-less or .html URL finds the one .ejs of that name under views/', (t) => {
  const ws = workspace(t, {
    'public/js/a.js': pageRelativeApp('templates/list.html'),
    'public/js/b.js': pageRelativeApp('templates/card'),
    'views/templates/list.ejs': '<p>{{ items }}</p>\n',
    'views/templates/card.ejs': '<p>{{ items }}</p>\n',
  });
  assert.deepStrictEqual(linked(ws, 'public/js/a.js'), ['views/templates/list.ejs']);
  assert.deepStrictEqual(linked(ws, 'public/js/b.js'), ['views/templates/card.ejs']);
});

test('the exact file name always beats a swapped extension', (t) => {
  const ws = workspace(t, {
    'public/js/app.js': pageRelativeApp('views/list.html'),
    'public/views/list.ejs': '<p>{{ items }}</p>\n',
    'shop/views/list.html': '<p>{{ items }}</p>\n',
  });
  assert.deepStrictEqual(linked(ws, 'public/js/app.js'), ['shop/views/list.html']);
});

// The ways real AngularJS code writes a template's controller and URL that are not a plain string.
const resolvesIn = (ws, tpl, needle) => {
  const d = ws.definitionAt(tpl, at(ws, tpl, needle));
  assert.strictEqual(d.targets.length, 1, `${needle}: ${d.reason}`);
  return d.targets[0];
};

test('component with an inline controller: $ctrl.x in its template reaches this.x', (t) => {
  const ws = workspace(t, {
    'js/list.component.js': `
angular.module('app').component('itemList', {
  templateUrl: 'tpl/list.html',
  controller: function (ItemSvc) { this.items = ItemSvc.all(); }
});`,
    'tpl/list.html': '<li ng-repeat="i in $ctrl.items">{{ i }}</li>\n',
  });
  assert.strictEqual(resolvesIn(ws, 'tpl/list.html', 'items').path, 'js/list.component.js');
});

test('John Papa style: named directive factory, `var ddo = {…}; return ddo;`, controller by variable, link scope', (t) => {
  const ws = workspace(t, {
    'js/card.directive.js': `
angular.module('app').directive('userCard', userCard);
function userCard() {
  var directive = { templateUrl: 'tpl/card.html', controller: CardController, controllerAs: 'vm', link: link };
  return directive;
  function link(scope) { scope.expanded = false; }
}
CardController.$inject = ['$scope'];
function CardController($scope) { var vm = this; vm.title = 'x'; $scope.tags = []; }`,
    'tpl/card.html': '<h1 ng-click="expanded = !expanded">{{ vm.title }} {{ tags.length }}</h1>\n',
  });
  assert.deepStrictEqual(ws.templateLinkIssues(), []);
  assert.strictEqual(resolvesIn(ws, 'tpl/card.html', 'title').path, 'js/card.directive.js');
  assert.strictEqual(resolvesIn(ws, 'tpl/card.html', 'tags').path, 'js/card.directive.js');
});

test('directive with a link function: scope.x set there resolves in the template', (t) => {
  const ws = workspace(t, {
    'js/pane.js': `
angular.module('app').directive('pane', function () {
  return { templateUrl: 'tpl/pane.html', link: function (s, el) { s.open = true; } };
});`,
    'tpl/pane.html': '<div ng-show="open"></div>\n',
  });
  assert.strictEqual(resolvesIn(ws, 'tpl/pane.html', 'open').path, 'js/pane.js');
});

test('$uibModal.open with an inline controller binds the modal template to it', (t) => {
  const ws = workspace(t, {
    'js/list.controller.js': `
angular.module('app').controller('ListCtrl', function ($scope, $uibModal) {
  $scope.edit = function () {
    $uibModal.open({
      templateUrl: 'tpl/edit-modal.html',
      controller: ['$scope', '$uibModalInstance', function ($scope, inst) { $scope.draft = {}; $scope.close = inst.close; }]
    });
  };
});`,
    'tpl/edit-modal.html': '<input ng-model="draft.name"><button ng-click="close()">x</button>\n',
  });
  assert.deepStrictEqual(ws.templateLinkIssues(), []);
  assert.strictEqual(resolvesIn(ws, 'tpl/edit-modal.html', 'draft').path, 'js/list.controller.js');
  assert.strictEqual(resolvesIn(ws, 'tpl/edit-modal.html', 'close').path, 'js/list.controller.js');
  // The made-up controller never shows up as dead code.
  assert.ok(!ws.unused().some((s) => s.name.startsWith('inline:')), JSON.stringify(ws.unused()));
});

test('templateUrl as a function returning one string, a route kept in a variable, and fromTemplateUrl', (t) => {
  const ws = workspace(t, {
    'js/app.js': `
var routes = { templateUrl: 'tpl/a.html', controller: 'ACtrl' };
angular.module('app')
  .directive('b', function () { return { templateUrl: function () { return 'tpl/b.html'; } }; })
  .controller('C', function ($ionicModal) { $ionicModal.fromTemplateUrl('tpl/c.html', {}); });`,
    'tpl/a.html': '<p></p>\n',
    'tpl/b.html': '<p></p>\n',
    'tpl/c.html': '<p></p>\n',
  });
  assert.deepStrictEqual(ws.templateLinkIssues(), []);
  assert.deepStrictEqual(linked(ws, 'js/app.js').sort(), ['tpl/a.html', 'tpl/b.html', 'tpl/c.html']);
});

test('an unknown base plus a static file name finds the file by the end of its path', (t) => {
  const ws = workspace(t, {
    'js/app.js': "angular.module('app').directive('x', function (CONFIG) { return { templateUrl: CONFIG.base + '/widgets/x.html' }; });",
    'web/static/widgets/x.html': '<p></p>\n',
  });
  assert.deepStrictEqual(linked(ws, 'js/app.js'), ['web/static/widgets/x.html']);
});

test('a link set by hand wins, relinks at once, and the hover info says how each URL was found', (t) => {
  const ws = workspace(t, {
    'public/js/app.js': pageRelativeApp('/legacy/list'),
    'public/views/list.html': '<p>{{ items }}</p>\n',
    'old/tpl/list-v2.ejs': '<p>{{ items }}</p>\n',
  });
  const offset = at(ws, 'public/js/app.js', '/legacy/list');
  const before = ws.templateUrlAt('public/js/app.js', offset);
  assert.strictEqual(before.trace.target, null);
  assert.ok(before.trace.tried.length > 2, before.trace.tried.join('\n'));
  assert.strictEqual(ws.templateLinkIssues()[0]?.reason, 'no-file');

  ws.setTemplateUrlMap({ '/legacy/list': 'old/tpl/list-v2.ejs' });
  const after = ws.templateUrlAt('public/js/app.js', offset);
  assert.strictEqual(after.trace.target, 'old/tpl/list-v2.ejs');
  assert.match(after.trace.how, /by hand/);
  assert.deepStrictEqual(ws.templateLinkIssues(), []);
  const d = ws.definitionAt('old/tpl/list-v2.ejs', at(ws, 'old/tpl/list-v2.ejs', 'items'));
  assert.strictEqual(d.targets[0]?.path, 'public/js/app.js', d.reason);
});
