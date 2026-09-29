/**
 * Completion that follows AngularJS itself (.scratch/template-completion/spec.md): inherited
 * scopes, controller-as aliases and `$ctrl`, filters after `|`, component/directive tags and
 * attributes, and the JS side — `$scope.`, `vm.`, an injected service.
 *
 * Every case types into the buffer (an overlay), `§` marking the cursor, as an editor would.
 */
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const C = require('../dist');

const ROOT = join(__dirname, '..', '..', '..', 'fixtures', 'completion');

function workspace() {
  const ws = new C.Workspace({ ...C.DEFAULT_CONFIG, root: ROOT }, ':memory:');
  ws.index();
  ws.link();
  return ws;
}

/** Suggestions with `text` as the buffer of `rel`, at `§`. */
function complete(ws, rel, text) {
  const at = text.indexOf('§');
  assert.notStrictEqual(at, -1, 'the text needs a § cursor');
  ws.setOverlay(rel, text.replace('§', ''));
  try {
    return ws.completionAt(rel, at);
  } finally {
    ws.clearOverlay(rel);
  }
}

/** Suggestions after inserting `typed` (with its `§`) right after `anchor` in a file as it is on disk. */
function completeAfter(ws, rel, anchor, typed) {
  const src = ws.source(rel);
  const cut = src.indexOf(anchor);
  assert.notStrictEqual(cut, -1, `${JSON.stringify(anchor)} not found`);
  return complete(ws, rel, src.slice(0, cut + anchor.length) + typed + src.slice(cut + anchor.length));
}

const names = (items) => items.map((i) => i.name).sort();
const byName = (items, name) => items.find((i) => i.name === name);

test('a nested controller sees its parent scope: `user.` resolves on OuterCtrl', () => {
  const ws = workspace();
  const tpl = '<div ng-controller="OuterCtrl"><div ng-controller="InnerCtrl">{{ user.§ }}</div></div>';
  assert.deepStrictEqual(names(complete(ws, 'views/t.html', tpl)), ['name', 'roles']);
});

test('at the root, the nearest scope comes first and inherited members say where they are from', () => {
  const ws = workspace();
  const items = complete(ws, 'views/t.html', '<div ng-controller="OuterCtrl"><div ng-controller="InnerCtrl">{{ § }}</div></div>');
  assert.deepStrictEqual(names(items), ['form', 'items', 'load', 'logout', 'user']);
  assert.match(byName(items, 'items').detail, /on the \$scope of InnerCtrl/);
  assert.match(byName(items, 'user').detail, /inherited from OuterCtrl/);
  assert.ok(byName(items, 'items').sortText < byName(items, 'user').sortText, 'the nearer scope sorts first');
});

test('controller-as: the root offers the alias, not the controller\'s `this` members; `vm.` and `vm.model.` do', () => {
  const ws = workspace();
  const tpl = (s) => `<form ng-controller="FormCtrl as vm">${s}</form>`;
  const root = complete(ws, 'views/t.html', tpl('{{ § }}'));
  assert.deepStrictEqual(names(root), ['vm']);
  assert.strictEqual(byName(root, 'vm').kind, 'alias');
  assert.deepStrictEqual(names(complete(ws, 'views/t.html', tpl('{{ vm.§ }}'))), ['model', 'submit']);
  assert.deepStrictEqual(names(complete(ws, 'views/t.html', tpl('{{ vm.model.§ }}'))), ['age', 'email']);
});

test('an alias names its own frame: `outer.` inside a nested controller-as', () => {
  const ws = workspace();
  const tpl = '<div ng-controller="FormCtrl as outer"><div ng-controller="InnerCtrl as inner">{{ outer.§ }}</div></div>';
  assert.deepStrictEqual(names(complete(ws, 'views/t.html', tpl)), ['model', 'submit']);
});

test('`$ctrl.` in a component\'s template: its bindings and its controller\'s members', () => {
  const ws = workspace();
  const items = complete(ws, 'views/card.html', '<div class="card">{{ $ctrl.§ }}</div>');
  assert.deepStrictEqual(names(items), ['expanded', 'onSelect', 'toggle', 'user']);
  assert.strictEqual(byName(items, 'user').kind, 'binding');
  assert.match(byName(items, 'onSelect').detail, /binding '&' of userCard/);
});

test('after `|` only filters are offered — the workspace\'s and the built-in ones; `||` is not a filter', () => {
  const ws = workspace();
  const items = complete(ws, 'views/t.html', '<div ng-controller="InnerCtrl">{{ items | § }}</div>');
  assert.ok(items.every((i) => i.kind === 'filter'));
  assert.ok(names(items).includes('money'));
  assert.ok(names(items).includes('orderBy'));
  const or = complete(ws, 'views/t.html', '<div ng-controller="InnerCtrl">{{ items || § }}</div>');
  assert.ok(names(or).includes('items'));
  assert.ok(!names(or).includes('money'));
});

test('a tag name: components and element directives, kebab-case', () => {
  const ws = workspace();
  const items = complete(ws, 'views/t.html', '<div ng-controller="InnerCtrl"><user-§</div>');
  assert.deepStrictEqual(names(items), ['user-card']);
  assert.strictEqual(items[0].kind, 'component');
});

test('an attribute name: the tag\'s bindings (not the ones already there), then attribute directives', () => {
  const ws = workspace();
  const items = complete(ws, 'views/t.html', '<div ng-controller="InnerCtrl"><user-card user="items" §></user-card></div>');
  assert.deepStrictEqual(names(items), ['on-select', 'pick-file']);
  assert.strictEqual(byName(items, 'on-select').snippet, 'on-select="$1"');
  assert.ok(byName(items, 'on-select').sortText < byName(items, 'pick-file').sortText);
});

test('the value of a binding or an ng-* attribute is an expression; plain text and HTML attributes get nothing', () => {
  const ws = workspace();
  const tpl = (s) => `<div ng-controller="InnerCtrl">${s}</div>`;
  assert.ok(names(complete(ws, 'views/t.html', tpl('<user-card user="§"></user-card>'))).includes('items'));
  assert.ok(names(complete(ws, 'views/t.html', tpl('<button ng-click="§"></button>'))).includes('load'));
  assert.deepStrictEqual(complete(ws, 'views/t.html', tpl('<p class="§">x</p>')), []);
  assert.deepStrictEqual(complete(ws, 'views/t.html', tpl('hello wor§')), []);
  assert.deepStrictEqual(complete(ws, 'views/t.ejs', tpl('<% var a = user.§ %>')), []);
});

test('a function is a method, inserted as a call with the cursor between the parentheses when it takes arguments', () => {
  const ws = workspace();
  const items = complete(ws, 'views/t.html', '<div ng-controller="InnerCtrl"><button ng-click="§"></button></div>');
  const load = byName(items, 'load');
  assert.strictEqual(load.kind, 'method');
  assert.strictEqual(load.snippet, 'load($1)');
  assert.match(load.detail, /\(page\)/);
});

test('go-to-definition follows the same inheritance: `user.name` in InnerCtrl lands on OuterCtrl', () => {
  const ws = workspace();
  const src = ws.source('views/page.html');
  const def = ws.definitionAt('views/page.html', src.indexOf('user.name') + 'user.'.length + 1);
  assert.strictEqual(def.targets.length, 1);
  assert.match(def.targets[0].detail, /user\.name on the scope of OuterCtrl/);
});

// ------------------------------------------------------------------------------------------ JS

test('JS: `s.` ($scope under another name) lists the members, the ones assigned after the cursor too', () => {
  const ws = workspace();
  const items = completeAfter(ws, 'js/app.js', "s.items = [{ id: 1, title: 't' }];", '\n  s.§');
  assert.deepStrictEqual(names(items), ['form', 'items', 'load']);
  assert.strictEqual(byName(items, 'load').snippet, undefined, 'no call inserted in JS');
});

test('JS: a nested key includes what a later assignment adds (`s.form.extra = true`)', () => {
  const ws = workspace();
  assert.deepStrictEqual(names(completeAfter(ws, 'js/app.js', "s.items = [{ id: 1, title: 't' }];", '\n  s.form.§')), ['email', 'extra']);
});

test('JS: `vm.` and `this.` in a controller-as controller; `this.` in a component includes its bindings', () => {
  const ws = workspace();
  assert.deepStrictEqual(names(completeAfter(ws, 'js/app.js', 'vm.submit = function () {};', '\n  vm.§')), ['model', 'submit']);
  assert.deepStrictEqual(names(completeAfter(ws, 'js/app.js', 'this.expanded = false;', '\n    this.§')), ['expanded', 'onSelect', 'toggle', 'user']);
});

test('JS: an injected factory, renamed by the DI array (`us`), lists what the factory returns', () => {
  const ws = workspace();
  const items = completeAfter(ws, 'js/app.js', "s.form.extra = true;", '\n  us.§');
  assert.deepStrictEqual(names(items), ['cache', 'fetch', 'meta', 'save']);
  assert.strictEqual(byName(items, 'fetch').kind, 'method', 'a function declared in the factory body and returned by name');
  assert.deepStrictEqual(names(completeAfter(ws, 'js/app.js', "s.form.extra = true;", '\n  us.meta.§')), ['total']);
});

test('JS: a constant\'s keys, and a service\'s `this` members', () => {
  const ws = workspace();
  assert.deepStrictEqual(names(completeAfter(ws, 'js/app.js', "s.form.extra = true;", '\n  settings.theme.§')), ['dark']);
  const src = ws.source('js/app.js');
  const withClock = src.replace("app.controller('FormCtrl', function () {", "app.controller('FormCtrl', function (Clock) {\n  Clock.§");
  assert.deepStrictEqual(names(complete(ws, 'js/app.js', withClock)), ['now', 'zone']);
});

test('JS: `this.` inside a nested non-arrow function is not the controller — nothing', () => {
  const ws = workspace();
  assert.deepStrictEqual(completeAfter(ws, 'js/app.js', 'vm.submit = function () {', ' this.§'), []);
});
