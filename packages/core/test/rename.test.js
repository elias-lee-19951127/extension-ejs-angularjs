/**
 * Rename (LSP textDocument/rename): doi ten $scope.foo dong bo ra moi template.
 *
 * Kiem bang cach AP edit vao noi dung file roi so voi chuoi viet tay, khong so
 * danh sach span: span nghe hop ly ma text sai van la bug lam hong code nguoi dung.
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

test('rename $scope.total tu JS: sua ca khai bao lan template', () => {
  const ws = fixtureWs();
  const r = ws.renameAt(JS, at(ws, JS, 's.total = 0', { offset: 2 }), 'grandTotal');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.deepStrictEqual(Object.keys(out).sort(), [JS, TPL]);
  assert.ok(out[JS].includes('s.grandTotal = 0;'));
  assert.ok(out[TPL].includes('{{ grandTotal | money }}'));
  assert.ok(!/\btotal\b/.test(out[TPL]));
});

test('rename tu template: sua ca lan GOI nam trong ham long phia JS', () => {
  const ws = fixtureWs();
  const r = ws.renameAt(TPL, at(ws, TPL, 'init()'), 'load');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out[JS].includes('s.load = function () { s.rows = Api.list(); };'));
  assert.ok(out[JS].includes("s.$on('refresh', function () { s.load(); });"));
  assert.ok(out[TPL].includes('data-ng-init="load()"'));
  assert.ok(!/\binit\b/.test(out[JS]));
});

test('rename tu choi kem ly do va KHONG sua gi', async (t) => {
  const ws = fixtureWs();
  const total = at(ws, JS, 's.total = 0', { offset: 2 });
  const cases = [
    ['bien cuc bo cua ng-repeat', TPL, at(ws, TPL, 'row.label'), 'item', /bien cuc bo/],
    ['property long nhau', TPL, at(ws, TPL, 'busy.saving', { offset: 5 }), 'isSaving', /long nhau/],
    ['method dung san cua $scope', JS, at(ws, JS, 's.$on(', { offset: 2 }), 'listen', /dung san/],
    ['ten moi khong phai dinh danh', JS, total, 'grand-total', /dinh danh/],
    ['ten moi la tu khoa', JS, total, 'class', /tu khoa/],
    ['ten moi bat dau bang $', JS, total, '$total', /\$/],
    ['ten moi trung ten cu', JS, total, 'total', /trung ten cu/],
    ['trung property da co tren scope', JS, total, 'busy', /da co/],
    // `busy.saving` nam trong <li ng-repeat="row in rows">: doi thanh `row` thi
    // `row.saving` se tro vao bien vong lap chu khong con la $scope nua.
    ['bi bien ng-repeat che bong tai cho dung', JS, at(ws, JS, 's.busy = {', { offset: 2 }), 'row', /che/],
  ];
  for (const [what, path, offset, newName, reason] of cases) {
    await t.test(what, () => {
      const r = ws.renameAt(path, offset, newName);
      assert.match(r.reason ?? '(khong co ly do)', reason);
      assert.deepStrictEqual(r.edits, []);
    });
  }
});

test('rename qua thuoc tinh do Linker phan giai va isolate binding', () => {
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

// ---------------------------------------------------------- workspace tam

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname } = require('node:path');

/** Workspace tren thu muc tam, dung cho truong hop bien khong co trong fixture. */
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

test('rename phia JS ton trong pham vi: tham so trung ten o ham long la bien KHAC', (t) => {
  const ws = tempWs(t, {
    'c.js': [
      "myApp.controller('c1', ['$scope', function (s) {",
      '  s.count = 0;',
      '  s.inc = function () { s.count++; };',
      "  helper(function (s) { s.count = 'bien khac'; });",
      '}]);',
    ].join('\n'),
    'v.html': '<div ng-controller="c1"><b ng-click="inc()">{{ count }}</b></div>',
  });
  const r = ws.renameAt('c.js', at(ws, 'c.js', 's.count = 0', { offset: 2 }), 'total');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out['c.js'].includes('  s.total = 0;'));
  assert.ok(out['c.js'].includes('s.inc = function () { s.total++; };'));
  assert.ok(out['c.js'].includes("helper(function (s) { s.count = 'bien khac'; });"));
  assert.ok(out['v.html'].includes('{{ total }}'));
});

test('rename tu choi property chi DOC ma khong gan (co the ke thua tu scope cha)', (t) => {
  const ws = tempWs(t, {
    'c.js': "myApp.controller('c1', ['$scope', function (s) { s.parentThing(); }]);",
    'v.html': '<div ng-controller="c1">{{ parentThing() }}</div>',
  });
  for (const [path, needle] of [['c.js', 'parentThing'], ['v.html', 'parentThing']]) {
    const r = ws.renameAt(path, at(ws, path, needle), 'x');
    assert.match(r.reason ?? '(khong co ly do)', /khong tim thay/i, path);
    assert.deepStrictEqual(r.edits, []);
  }
});

// ------------------------------------------------------------ repo that

const { existsSync } = require('node:fs');
const REAL = '/Volumes/mac-dev/project/smart-city';

test(
  'smart-city: controller khai bao trung o 2 file -> chi doi ban GAN NHAT theo thu muc',
  { skip: !existsSync(REAL) && 'khong co repo smart-city' },
  () => {
    const ws = new C.Workspace({ root: REAL }, ':memory:');
    ws.index();
    const JS_P = 'product/view/public/javascripts/index.js';
    const TPL_P = 'product/view/content.ejs';

    // Dem doc lap bang grep (2026-09-11): 44 lan `$scope.busy` trong JS_P va 25 lan
    // `busy` trong TPL_P. Ban sao o new-version/ (28 va 16) phai giu nguyen.
    for (const [path, offset] of [
      [JS_P, at(ws, JS_P, '$scope.busy = ', { offset: 7 })],
      [TPL_P, at(ws, TPL_P, 'busy.stats')],
    ]) {
      const r = ws.renameAt(path, offset, 'isBusy');
      assert.strictEqual(r.reason, undefined, path);
      const perFile = {};
      for (const e of r.edits) perFile[e.path] = (perFile[e.path] ?? 0) + 1;
      assert.deepStrictEqual(perFile, { [JS_P]: 44, [TPL_P]: 25 }, `bat dau tu ${path}`);
      assert.deepStrictEqual(r.untouched, ['new-version/fe-be/index.js']);
      assert.match(r.note ?? '', /giu nguyen new-version\/fe-be\/index\.js/);
    }
  },
);

test('controller trung ten ma KHONG phan dinh duoc ban nao gan hon -> doi het va bao', (t) => {
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
  assert.match(r.note ?? '', /khong phan dinh/);
});

test('rename BAO chu con sot trong thuoc tinh ng-* ma parser khong hieu, khong doan bua', (t) => {
  // Thut le bang U+2003 (EM SPACE) — nhu smart-city/new-version. Trinh duyet khong
  // coi no la khoang trang trong the, nen `␣␣ng-click` khong phai directive.
  const ws = tempWs(t, {
    'c.js': "myApp.controller('c1', ['$scope', function (s) { s.count = 0; }]);",
    'v.html': '<div ng-controller="c1">\n  <b\n\u2003\u2003ng-click="count = 1">{{ count }}</b>\n</div>',
  });
  const r = ws.renameAt('c.js', at(ws, 'c.js', 'count'), 'total');
  assert.strictEqual(r.reason, undefined);
  const out = applyEdits(ws, r.edits);
  assert.ok(out['v.html'].includes('{{ total }}'));
  assert.ok(out['v.html'].includes('ng-click="count = 1"'), 'khong sua cho parser khong hieu');
  assert.match(r.note ?? '(khong co note)', /v\.html:3/);
});

test('prepareRename: span va ten hien tai de IDE hien o nhap, hoac ly do tu choi', () => {
  const ws = fixtureWs();
  const text = (path, span) => ws.source(path).slice(span.start, span.end);

  const tpl = ws.prepareRenameAt(TPL, at(ws, TPL, 'busy.saving', { offset: 2 }));
  assert.strictEqual(tpl.reason, undefined);
  assert.strictEqual(text(TPL, tpl.span), 'busy');
  assert.strictEqual(tpl.placeholder, 'busy');

  const js = ws.prepareRenameAt(JS, at(ws, JS, 's.total = 0', { offset: 4 }));
  assert.strictEqual(text(JS, js.span), 'total');

  const no = ws.prepareRenameAt(TPL, at(ws, TPL, 'row.label'));
  assert.match(no.reason ?? '(khong co ly do)', /bien cuc bo/);
  assert.strictEqual(no.span, undefined);
});

test(
  'smart-city: sau khi doi ten, dieu huong trong template van dung nhu truoc',
  { skip: !existsSync(REAL) && 'khong co repo smart-city' },
  () => {
    const ws = new C.Workspace({ root: REAL }, ':memory:');
    ws.index();
    const JS_P = 'product/view/public/javascripts/index.js';
    const TPL_P = 'product/view/content.ejs';

    const r = ws.renameAt(JS_P, at(ws, JS_P, '$scope.busy = ', { offset: 7 }), 'isBusy');
    assert.strictEqual(r.reason, undefined);
    // Ap edit vao overlay + index trong bo nho — KHONG ghi xuong repo that.
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

// ------------------------------------------------ hoi quy tu review (phu luc I.7)

test('review: doi ca tham chieu qua bi danh cua $scope va truy cap bang chuoi', (t) => {
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

test('review: KHONG canh bao nham cho da parse duoc nhung khong phai muc tieu', (t) => {
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

test('review: ban gan nhat duoc doi thi chinh ban do phai GAN property', (t) => {
  const ws = tempWs(t, {
    'a/c.js': "myApp.controller('c1', ['$scope', function (s) { s.foo = 1; }]);",
    'b/c.js': "myApp.controller('c1', ['$scope', function (s) { s.other = 1; }]);",
    'a/v.html': '<div ng-controller="c1">{{ foo }}</div>',
    'b/v.html': '<div ng-controller="c1">{{ foo }}</div>',
  });
  const r = ws.renameAt('b/v.html', at(ws, 'b/v.html', 'foo'), 'bar');
  assert.match(r.reason ?? '(khong co ly do)', /khong tim thay lan gan/i);
  assert.deepStrictEqual(r.edits, []);
});
