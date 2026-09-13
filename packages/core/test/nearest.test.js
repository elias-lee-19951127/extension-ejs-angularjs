/**
 * Controller khai bao TRUNG TEN o nhieu file, va y nghia cua `confidence`.
 *
 * Cay thu muc tam dung theo hinh cua smart-city: hai ban cua cung mot controller o hai nhanh
 * (`product/view` va `new-version/fe-be`), moi ban di kem template cua no.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const C = require('../dist');

const CTRL = 'demo-view-controller';
const BRANCHES = ['product/view', 'new-version/fe-be'];

const JS = `myApp.controller('${CTRL}', ['$scope', 'Api', function (s, Api) {
  s.busy = { saving: false };
  s.total = 0;
  s.stats = fetchStats();
  s.rows = [{ a: {} }];
  s.load = function () { return Api.list(); };
}]);
`;

const TPL = `<div data-ng-controller="${CTRL}">
  <span>{{ total }}</span>
  <span>{{ busy.saving }}</span>
  <span>{{ stats.total }}</span>
  <li data-ng-repeat="row in rows">{{ row.a.b }}</li>
</div>
`;

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-nearest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Ban o nhanh xa co them mot property va mot khoa rieng: de thay completion co tron hai ban khong.
  const FAR_JS = JS.replace(
    's.busy = { saving: false };',
    () => 's.busy = { saving: false, xaOnly: true };',
  ).replace('}]);', () => '  s.chiCoBanXa = 1;\n}]);');
  for (const dir of BRANCHES) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'index.js'), dir === BRANCHES[0] ? JS : FAR_JS);
    writeFileSync(join(root, dir, 'content.ejs'), TPL);
  }
  // Factory chi co o mot nhanh — dung cho truong hop DI ben duoi.
  writeFileSync(join(root, 'new-version/fe-be/api.js'), "myApp.factory('Api', function () { return {}; });\n");
  // Template nam o goc: cach deu ca hai ban.
  writeFileSync(join(root, 'shared.ejs'), TPL);
  const ws = new C.Workspace({ root }, ':memory:');
  ws.index();
  return ws;
}

const at = (ws, rel, needle, offset = 0) => {
  const idx = ws.source(rel).indexOf(needle);
  assert.notStrictEqual(idx, -1, `khong tim thay ${JSON.stringify(needle)} trong ${rel}`);
  return idx + offset;
};

test('definition: controller trung ten o 2 file -> chi tra ban gan nhat theo thu muc', (t) => {
  const ws = workspace(t);
  for (const branch of BRANCHES) {
    const rel = `${branch}/content.ejs`;
    const d = ws.definitionAt(rel, at(ws, rel, '{{ total }}', 3));
    assert.strictEqual(d.targets.length, 1, `${branch}: phai con dung 1 dich`);
    assert.strictEqual(d.targets[0].path, `${branch}/index.js`);
    const xa = BRANCHES.find((b) => b !== branch);
    assert.deepStrictEqual(d.otherFiles, [`${xa}/index.js`], 'ban kia phai duoc chi ra, khong giau');
  }
});

test('definition: cach deu ca hai ban thi giu nguyen ca hai — khong phan dinh duoc thi khong doan', (t) => {
  const ws = workspace(t);
  const d = ws.definitionAt('shared.ejs', at(ws, 'shared.ejs', '{{ total }}', 3));
  assert.strictEqual(d.targets.length, 2);
  assert.strictEqual(d.otherFiles, undefined);
});

test('definition: dich khac LOAI thi khong gop — DI van tra ca khai bao Angular lan tham so ham', (t) => {
  const ws = workspace(t);
  const rel = 'product/view/index.js';
  const d = ws.definitionAt(rel, at(ws, rel, 'Api.list()'));
  assert.deepStrictEqual(
    d.targets.map((x) => [x.kind, x.path]),
    [
      ['factory', 'new-version/fe-be/api.js'],
      ['param', rel],
    ],
    'khai bao Angular o file xa hon KHONG duoc bi luat thu-muc-gan-nhat loai',
  );
  assert.strictEqual(d.otherFiles, undefined);
});

test('confidence: medium chi khi khong lan duoc theo shape, khong phai "khong chac"', (t) => {
  const ws = workspace(t);
  const rel = 'product/view/content.ejs';

  const plain = ws.definitionAt(rel, at(ws, rel, '{{ total }}', 3));
  assert.deepStrictEqual([plain.targets[0].kind, plain.targets[0].confidence], ['scope-member', 'high']);

  const nested = ws.definitionAt(rel, at(ws, rel, 'busy.saving', 5));
  assert.deepStrictEqual([nested.targets[0].kind, nested.targets[0].confidence], ['shape-property', 'high']);

  // `s.stats = fetchStats()` — khong suy duoc shape, chi nhay duoc toi chinh `stats`.
  const unknown = ws.definitionAt(rel, at(ws, rel, 'stats.total', 6));
  assert.deepStrictEqual([unknown.targets[0].kind, unknown.targets[0].confidence], ['scope-member', 'medium']);
});

test('completion: chi goi y property cua ban GAN NHAT', (t) => {
  const ws = workspace(t);
  const names = (rel) => ws.completionAt(rel, at(ws, rel, '{{ total }}', 3)).map((c) => c.name);

  const gan = names('product/view/content.ejs');
  assert.ok(gan.includes('total') && gan.includes('busy'), gan.join(','));
  assert.ok(!gan.includes('chiCoBanXa'), 'property chi co o ban xa khong duoc goi y');

  // Va nguoc lai — khong phai lúc nao cung uu tien mot nhanh co dinh.
  assert.ok(names('new-version/fe-be/content.ejs').includes('chiCoBanXa'));
});

test('completion sau dau cham: khoa lay theo shape cua ban gan nhat, khong tron hai ban', (t) => {
  const ws = workspace(t);
  const keys = (rel) => ws.completionAt(rel, at(ws, rel, 'busy.saving', 5)).map((c) => c.name).sort();

  assert.deepStrictEqual(keys('product/view/content.ejs'), ['saving']);
  assert.deepStrictEqual(keys('new-version/fe-be/content.ejs'), ['saving', 'xaOnly']);
});

test('detail goi ten doan duong THUC SU toi duoc, khong phai duong dan da hoi', (t) => {
  const ws = workspace(t);
  const rel = 'product/view/content.ejs';
  // `$scope.rows = [{ a: {} }]` — lan duoc toi `a`, tac o `b`.
  const d = ws.definitionAt(rel, at(ws, rel, 'row.a.b', 6));
  assert.strictEqual(d.targets.length, 1);
  assert.match(d.targets[0].detail, /^row\.a —/, d.targets[0].detail);
  assert.strictEqual(d.targets[0].confidence, 'medium');
});

// `nearestRows`/`preferNearest` (packages/core/src/resolve/rename.ts) la ham thuan — khong can
// dung Workspace/index() de kiem luat "ban gan nhat", chi can mang/object gia (phu luc M candidate C).

test('nearestRows: giu ban gan nhat, hoa thi giu ca hai', () => {
  const rows = [{ path: 'a/x.js' }, { path: 'a/b/y.js' }];
  assert.deepStrictEqual(C.nearestRows('a/b/from.js', rows), [{ path: 'a/b/y.js' }]);
  assert.deepStrictEqual(C.nearestRows('c/from.js', rows), rows); // hoa khoang cach -> giu ca hai
  assert.deepStrictEqual(C.nearestRows('a/b/from.js', [rows[0]]), [rows[0]]); // 1 duong dan -> bo qua luat
});

test('preferNearest: chi loc khi moi target CUNG kind, otherFiles giu ban bi loai', () => {
  const cungKind = {
    targets: [
      { path: 'a/x.js', kind: 'controller' },
      { path: 'a/b/y.js', kind: 'controller' },
    ],
  };
  const loc = C.preferNearest('a/b/from.js', cungKind);
  assert.deepStrictEqual(loc.targets, [{ path: 'a/b/y.js', kind: 'controller' }]);
  assert.deepStrictEqual(loc.otherFiles, ['a/x.js']);

  const khacKind = {
    targets: [
      { path: 'a/x.js', kind: 'param' },
      { path: 'a/b/y.js', kind: 'declaration' },
    ],
  };
  assert.strictEqual(C.preferNearest('a/b/from.js', khacKind), khacKind); // khac kind -> khong gop
});
