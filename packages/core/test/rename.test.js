/**
 * Rename (LSP textDocument/rename): rename $scope.foo, synchronized out to templates.
 *
 * Verified by APPLYING the edits to the file content and comparing against a
 * hand-written string, not by comparing span lists: a span that looks plausible but
 * whose text is wrong is still a bug that breaks the user's code.
 */
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const C = require('../dist');
const { at, applyEdits, textAt } = require('./helpers');

const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');
const TPL = 'views/page.ejs';
const JS = 'js/app.js';

function fixtureWs() {
  const ws = new C.Workspace({ root: FIXTURE }, ':memory:');
  ws.index();
  return ws;
}

test('rename $scope.total from JS: fixes both the declaration and the template', () => {
  const ws = fixtureWs();
  const r = ws.renameAt(JS, at(ws, JS, 's.total = 0', { offset: 2 }), 'grandTotal');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.deepStrictEqual(Object.keys(out).sort(), [JS, TPL]);
  assert.ok(out[JS].includes('s.grandTotal = 0;'));
  assert.ok(out[TPL].includes('{{ grandTotal | money }}'));
  assert.ok(!/\btotal\b/.test(out[TPL]));
});

test('rename from a template: also fixes the CALL site inside a nested JS function', () => {
  const ws = fixtureWs();
  const r = ws.renameAt(TPL, at(ws, TPL, 'init()'), 'load');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out[JS].includes('s.load = function () { s.rows = Api.list(); };'));
  assert.ok(out[JS].includes("s.$on('refresh', function () { s.load(); });"));
  assert.ok(out[TPL].includes('data-ng-init="load()"'));
  assert.ok(!/\binit\b/.test(out[JS]));
});

test('rename refuses with a reason and changes NOTHING', async (t) => {
  const ws = fixtureWs();
  const total = at(ws, JS, 's.total = 0', { offset: 2 });
  const cases = [
    ['ng-repeat local variable', TPL, at(ws, TPL, 'row.label'), 'item', /local variable/],
    ['nested property', TPL, at(ws, TPL, 'busy.saving', { offset: 5 }), 'isSaving', /nested property/],
    ['built-in $scope method', JS, at(ws, JS, 's.$on(', { offset: 2 }), 'listen', /built-in/],
    ['new name is not a valid identifier', JS, total, 'grand-total', /valid identifier/],
    ['new name is a reserved keyword', JS, total, 'class', /reserved keyword/],
    ['new name starts with $', JS, total, '$total', /\$/],
    ['new name is the same as the old one', JS, total, 'total', /same as the old one/],
    ['property already exists on scope', JS, total, 'busy', /already exists/],
    // `busy.saving` sits inside <li ng-repeat="row in rows">: renaming it to `row`
    // would make `row.saving` point at the loop variable instead of $scope.
    ['shadowed by the ng-repeat variable at the target site', JS, at(ws, JS, 's.busy = {', { offset: 2 }), 'row', /shadowed/],
  ];
  for (const [what, path, offset, newName, reason] of cases) {
    await t.test(what, () => {
      const r = ws.renameAt(path, offset, newName);
      assert.match(r.reason ?? '(no reason)', reason);
      assert.deepStrictEqual(r.edits, []);
    });
  }
});

test('rename through an attribute resolved by the Linker, and an isolate binding', () => {
  const ws = fixtureWs();

  const onPick = ws.renameAt(JS, at(ws, JS, 's.onPick =', { offset: 2 }), 'onFile');
  assert.strictEqual(onPick.reason, undefined);
  const a = applyEdits(ws, onPick.edits);
  assert.ok(a[JS].includes('s.onFile = function (file)'));
  assert.ok(a[TPL].includes('pick-file="onFile($file)"'));

  const form = ws.renameAt(TPL, at(ws, TPL, 'data="form"', { offset: 6 }), 'model');
  assert.strictEqual(form.reason, undefined);
  const b = applyEdits(ws, form.edits);
  assert.ok(b[JS].includes("s.model = { title: '', body: '' };"));
  assert.ok(b[TPL].includes('data-ng-model="model.title"'));
  assert.ok(b[TPL].includes('<my-widget data="model">'));
});

// ---------------------------------------------------------- temporary workspace

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname } = require('node:path');

/** A workspace on a temp directory, for cases with no matching fixture. */
function tempWs(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-rename-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = new C.Workspace({ root }, ':memory:');
  ws.index();
  return ws;
}

test('rename on the JS side respects scope: a same-named parameter in a nested function is a DIFFERENT variable', (t) => {
  const ws = tempWs(t, {
    'c.js': [
      "myApp.controller('c1', ['$scope', function (s) {",
      '  s.count = 0;',
      '  s.inc = function () { s.count++; };',
      "  helper(function (s) { s.count = 'different variable'; });",
      '}]);',
    ].join('\n'),
    'v.html': '<div ng-controller="c1"><b ng-click="inc()">{{ count }}</b></div>',
  });
  const r = ws.renameAt('c.js', at(ws, 'c.js', 's.count = 0', { offset: 2 }), 'total');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out['c.js'].includes('  s.total = 0;'));
  assert.ok(out['c.js'].includes('s.inc = function () { s.total++; };'));
  assert.ok(out['c.js'].includes("helper(function (s) { s.count = 'different variable'; });"));
  assert.ok(out['v.html'].includes('{{ total }}'));
});

test('rename refuses a property that is only READ, never assigned (may be inherited from a parent scope)', (t) => {
  const ws = tempWs(t, {
    'c.js': "myApp.controller('c1', ['$scope', function (s) { s.parentThing(); }]);",
    'v.html': '<div ng-controller="c1">{{ parentThing() }}</div>',
  });
  for (const [path, needle] of [['c.js', 'parentThing'], ['v.html', 'parentThing']]) {
    const r = ws.renameAt(path, at(ws, path, needle), 'x');
    assert.match(r.reason ?? '(no reason)', /could not find|not found/i, path);
    assert.deepStrictEqual(r.edits, []);
  }
});

// ------------------------------------------------------------ real repo

const { existsSync } = require('node:fs');
const REAL = '/Volumes/mac-dev/project/smart-city';

test(
  'smart-city: a controller declared twice in 2 files -> rename only the NEAREST copy by directory',
  { skip: !existsSync(REAL) && 'smart-city repo not available' },
  () => {
    const ws = new C.Workspace({ root: REAL }, ':memory:');
    ws.index();
    const JS_P = 'product/view/public/javascripts/index.js';
    const TPL_P = 'product/view/content.ejs';

    // Counted independently with grep (2026-09-11): 44 occurrences of `$scope.busy` in
    // JS_P and 25 of `busy` in TPL_P. The copy in new-version/ (28 and 16) must stay
    // unchanged.
    for (const [path, offset] of [
      [JS_P, at(ws, JS_P, '$scope.busy = ', { offset: 7 })],
      [TPL_P, at(ws, TPL_P, 'busy.stats')],
    ]) {
      const r = ws.renameAt(path, offset, 'isBusy');
      assert.strictEqual(r.reason, undefined, path);
      const perFile = {};
      for (const e of r.edits) perFile[e.path] = (perFile[e.path] ?? 0) + 1;
      assert.deepStrictEqual(perFile, { [JS_P]: 44, [TPL_P]: 25 }, `starting from ${path}`);
      assert.deepStrictEqual(r.untouched, ['new-version/fe-be/index.js']);
      assert.match(r.note ?? '', /leaving new-version\/fe-be\/index\.js unchanged/);
    }
  },
);

test('a same-named controller where NEITHER copy can be told apart as nearer -> renames all of them and reports it', (t) => {
  const ctrl = (n) => `myApp.controller('c1', ['$scope', function (s) { s.count = ${n}; }]);`;
  const ws = tempWs(t, {
    'a/c.js': ctrl(1),
    'b/c.js': ctrl(2),
    'views/v.html': '<div ng-controller="c1">{{ count }}</div>',
  });
  const r = ws.renameAt('a/c.js', at(ws, 'a/c.js', 'count'), 'total');
  assert.strictEqual(r.reason, undefined);
  const files = [...new Set(r.edits.map((e) => e.path))].sort();
  assert.deepStrictEqual(files, ['a/c.js', 'b/c.js', 'views/v.html']);
  assert.deepStrictEqual(r.untouched, []);
  assert.match(r.note ?? '', /none could be told apart/);
});

test('rename REPORTS leftover occurrences inside an ng-* attribute the parser did not understand, without guessing', (t) => {
  // Indented with U+2003 (EM SPACE) — as seen in smart-city/new-version. The browser
  // does not treat it as whitespace inside a tag, so `␣␣ng-click` is not recognized as
  // a directive.
  const ws = tempWs(t, {
    'c.js': "myApp.controller('c1', ['$scope', function (s) { s.count = 0; }]);",
    'v.html': '<div ng-controller="c1">\n  <b\n  ng-click="count = 1">{{ count }}</b>\n</div>',
  });
  const r = ws.renameAt('c.js', at(ws, 'c.js', 'count'), 'total');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out['v.html'].includes('{{ total }}'));
  assert.ok(out['v.html'].includes('ng-click="count = 1"'), 'does not edit a spot the parser did not understand');
  assert.match(r.note ?? '(no note)', /v\.html:3/);
});

test('prepareRename: span and current name for the IDE input, or a refusal reason', () => {
  const ws = fixtureWs();
  const text = (path, span) => ws.source(path).slice(span.start, span.end);

  const tpl = ws.prepareRenameAt(TPL, at(ws, TPL, 'busy.saving', { offset: 2 }));
  assert.strictEqual(tpl.reason, undefined);
  assert.strictEqual(text(TPL, tpl.span), 'busy');
  assert.strictEqual(tpl.placeholder, 'busy');

  const js = ws.prepareRenameAt(JS, at(ws, JS, 's.total = 0', { offset: 4 }));
  assert.strictEqual(text(JS, js.span), 'total');

  const no = ws.prepareRenameAt(TPL, at(ws, TPL, 'row.label'));
  assert.match(no.reason ?? '(no reason)', /local variable/);
  assert.strictEqual(no.span, undefined);
});

test(
  'smart-city: after renaming, navigation in the template still works as before',
  { skip: !existsSync(REAL) && 'smart-city repo not available' },
  () => {
    const ws = new C.Workspace({ root: REAL }, ':memory:');
    ws.index();
    const JS_P = 'product/view/public/javascripts/index.js';
    const TPL_P = 'product/view/content.ejs';

    const r = ws.renameAt(JS_P, at(ws, JS_P, '$scope.busy = ', { offset: 7 }), 'isBusy');
    assert.strictEqual(r.reason, undefined);
    // Apply the edits to the in-memory overlay + index — do NOT write to the real repo.
    for (const [path, src] of Object.entries(applyEdits(ws, r.edits))) {
      ws.setOverlay(path, src);
      ws.flushOverlay(path);
    }
    ws.link();

    const d = ws.definitionAt(TPL_P, at(ws, TPL_P, 'isBusy.stats', { offset: 7 }));
    assert.strictEqual(textAt(ws, d.targets[0]), 'stats');

    const missed = [];
    for (const expr of ws.facts(TPL_P).expressions) {
      for (const root of expr.roots) {
        const def = ws.definitionAt(TPL_P, root.span.start);
        if (!def.targets.length && !def.builtin) missed.push(`${root.name}: ${def.reason}`);
      }
    }
    assert.deepStrictEqual(missed, []);
  },
);

// ------------------------------------------------ regression tests from review (Appendix I.7)

test('review: also renames references through a $scope alias and bracket-string access', (t) => {
  const ws = tempWs(t, {
    'c.js': [
      "myApp.controller('c1', ['$scope', function (s) {",
      '  var vm = s;',
      '  s.busy = false;',
      '  vm.busy = true;',
      "  s['busy'] = 1;",
      '}]);',
    ].join('\n'),
    'v.html': '<div ng-controller="c1">{{ busy }}</div>',
  });
  const r = ws.renameAt('c.js', at(ws, 'c.js', 's.busy', { offset: 2 }), 'isBusy');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out['c.js'].includes('  vm.isBusy = true;'));
  assert.ok(out['c.js'].includes("  s['isBusy'] = 1;"));
  assert.ok(!/\bbusy\b/.test(out['c.js']), out['c.js']);
});

test('review: does NOT false-warn on a spot the parser understood but that is not a target', (t) => {
  const ws = tempWs(t, {
    'c.js': [
      "myApp.controller('a', ['$scope', function (s) { s.busy = 1; }]);",
      "myApp.controller('b', ['$scope', function (s) { s.busy = 2; s.list = []; }]);",
    ].join('\n'),
    'v.html': [
      '<div ng-controller="a"><i data-ng-class="{ busy: busy }">{{ busy }}</i></div>',
      '<div ng-controller="b">{{ busy }}<p ng-repeat="busy in list">{{ busy }}</p></div>',
    ].join('\n'),
  });
  const r = ws.renameAt('v.html', at(ws, 'v.html', '{{ busy }}', { offset: 3 }), 'isBusy');
  assert.strictEqual(r.reason, undefined);
  assert.strictEqual(r.note, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out['v.html'].startsWith('<div ng-controller="a"><i data-ng-class="{ busy: isBusy }">{{ isBusy }}</i></div>'));
});

test('review: when the nearest copy is renamed, that SAME copy must ASSIGN the property', (t) => {
  const ws = tempWs(t, {
    'a/c.js': "myApp.controller('c1', ['$scope', function (s) { s.foo = 1; }]);",
    'b/c.js': "myApp.controller('c1', ['$scope', function (s) { s.other = 1; }]);",
    'a/v.html': '<div ng-controller="c1">{{ foo }}</div>',
    'b/v.html': '<div ng-controller="c1">{{ foo }}</div>',
  });
  const r = ws.renameAt('b/v.html', at(ws, 'b/v.html', 'foo'), 'bar');
  assert.match(r.reason ?? '(no reason)', /could not find an assignment/i);
  assert.deepStrictEqual(r.edits, []);
});
