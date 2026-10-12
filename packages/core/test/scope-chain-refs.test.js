/**
 * Template names attributed to the controller that really holds them: a component's bindings
 * behind `$ctrl.`, a parent controller's member used inside a nested `ng-controller`, a member
 * reached through a controller-as alias in a directive attribute, and a template bound to its
 * controller by a `templateUrl` elsewhere. Find-references and dead-code detection must see them.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const C = require('../dist');
const { at, textAt } = require('./helpers');

const FILES = {
  'public/js/app.js': `var app = angular.module('board', []);
app.controller('BoardCtrl', function ($scope) {
  $scope.tasks = [];
  $scope.reload = function () {};
});
app.controller('ListCtrl', function () {
  var vm = this;
  vm.toggle = function (task) {};
});
app.component('taskCard', {
  bindings: { task: '<', 'onToggle': '&' },
  templateUrl: 'views/task-card.html',
  controller: function () {
    this.expanded = false;
  },
});
`,
  'public/index.html': `<main ng-controller="BoardCtrl">
  <section ng-controller="ListCtrl as vm">
    <task-card ng-repeat="task in tasks" task="task" on-toggle="vm.toggle(task)"></task-card>
  </section>
  <button ng-click="reload()">Reload</button>
</main>
`,
  'public/views/task-card.html': `<article>
  <input type="checkbox" ng-click="$ctrl.onToggle()">
  {{ $ctrl.task.title }}
  <button ng-click="$ctrl.expanded = !$ctrl.expanded">details</button>
</article>
`,
};

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-scope-chain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const ws = new C.Workspace({ ...C.DEFAULT_CONFIG, root }, ':memory:');
  ws.index();
  ws.link();
  return ws;
}

const JS = 'public/js/app.js';
const CARD = 'public/views/task-card.html';
const PAGE = 'public/index.html';

test('`$ctrl.task` in a component template goes to the binding `task` in `bindings`', (t) => {
  const ws = workspace(t);
  const res = ws.definitionAt(CARD, at(ws, CARD, '$ctrl.task', { offset: 7 }));
  assert.strictEqual(res.targets.length, 1, res.reason);
  const [target] = res.targets;
  assert.strictEqual(target.path, JS);
  assert.strictEqual(target.kind, 'binding');
  assert.strictEqual(textAt(ws, target), 'task');
  assert.strictEqual(target.span.start, at(ws, JS, 'task: '));
});

test('a quoted binding key points at the name, not its quotes', (t) => {
  const ws = workspace(t);
  const [target] = ws.definitionAt(CARD, at(ws, CARD, '$ctrl.onToggle', { offset: 7 })).targets;
  assert.strictEqual(textAt(ws, target), 'onToggle');
});

test('find references on a parent controller member includes its use inside a nested controller', (t) => {
  const ws = workspace(t);
  const refs = ws.referencesAt(JS, at(ws, JS, '$scope.tasks', { offset: 7 }));
  assert.deepStrictEqual(
    refs.locations.map((l) => `${l.path}:${l.span.start}`),
    [`${PAGE}:${at(ws, PAGE, 'tasks"')}`],
  );
});

test('find references from the template side resolves the nested name to the parent controller', (t) => {
  const ws = workspace(t);
  const refs = ws.referencesAt(PAGE, at(ws, PAGE, 'tasks"'));
  assert.strictEqual(refs.query, 'tasks');
  assert.ok(refs.locations.some((l) => l.path === PAGE), JSON.stringify(refs));
});

test('dead code: members used through a parent scope, an alias in a directive attribute, or a templateUrl are used', (t) => {
  const ws = workspace(t);
  const unused = ws.unused().map((s) => `${s.container}.${s.name}`);
  for (const used of ['BoardCtrl.tasks', 'BoardCtrl.reload', 'ListCtrl.toggle', 'taskCard.expanded']) {
    assert.ok(!unused.includes(used), `${used} reported unused: ${unused.join(', ')}`);
  }
});

test('find references on a member of a templateUrl-bound component reaches its template', (t) => {
  const ws = workspace(t);
  const refs = ws.referencesAt(JS, at(ws, JS, 'this.expanded', { offset: 5 }));
  assert.strictEqual(refs.locations.filter((l) => l.path === CARD).length, 2);
});
