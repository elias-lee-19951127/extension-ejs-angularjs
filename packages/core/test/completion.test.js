/**
 * Completion trong template: di theo SHAPE suy tu object literal khi go `busy.`.
 *
 * Mo phong dung luc dang go: bieu thuc chua xong (`{{ busy. }}`) KHONG parse duoc —
 * extractor bo han no — nen test dat buffer dang go vao overlay, khong dung file goc.
 */
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const C = require('../dist');

const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');
const TPL = 'views/page.ejs';

/** Chen `before` + `after` ngay sau `anchor` trong buffer; tra ve offset con tro (giua hai doan). */
function typeAt(ws, rel, anchor, before, after = '') {
  const src = ws.source(rel);
  const idx = src.indexOf(anchor);
  assert.notStrictEqual(idx, -1, `khong tim thay ${JSON.stringify(anchor)}`);
  const cut = idx + anchor.length;
  ws.setOverlay(rel, src.slice(0, cut) + before + after + src.slice(cut));
  return cut + before.length;
}

const names = (items) => items.map((i) => i.name).sort();

function fixtureWs() {
  const ws = new C.Workspace({ root: FIXTURE }, ':memory:');
  ws.index();
  return ws;
}

test('go `busy.` -> goi y cac khoa trong object literal cua $scope.busy', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<span>', '{{ busy.', ' }}');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['loading', 'saving']);
});

test('go `row.` trong ng-repeat -> khoa cua PHAN TU trong $scope.rows', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '{{ row.label }}', ' {{ row.', ' }}');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['id', 'label', 'tags']);
});

test('con tro o cuoi mot khoa dang go do van goi y cung cap: `busy.sa|`', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<span>', '{{ busy.sa', ' }}');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['loading', 'saving']);
});

test('trong gia tri thuoc tinh directive cung goi y theo shape', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<input data-ng-model="form.title"', ' data-ng-click="form.', '"');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['body', 'title']);
});

test('dang go trong chuoi thi khong goi y', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<span>', "{{ 'busy.", "' }}");
  assert.deepStrictEqual(ws.completionAt(TPL, offset), []);
});

const { existsSync } = require('node:fs');
const REAL = '/Volumes/mac-dev/project/smart-city';

test(
  'smart-city: `busy.` va `section.` goi y dung khoa trong object literal that',
  { skip: !existsSync(REAL) && 'khong co repo smart-city' },
  () => {
    const ws = new C.Workspace({ root: REAL }, ':memory:');
    ws.index();
    const T = 'product/view/content.ejs';
    // Doc tay tu product/view/public/javascripts/index.js (2026-09-11): dong 53 va dong 32-38.
    const busy = typeAt(ws, T, 'DHA Management</div>', '{{ busy.', ' }}');
    assert.deepStrictEqual(names(ws.completionAt(T, busy)), [
      'docStatus', 'documents', 'ingest', 'maintain', 'search', 'stats', 'upload', 'voicePreview', 'voices',
    ]);
    ws.clearOverlay(T);
    const section = typeAt(ws, T, '<span class="kbm-nav-label">', '{{ section.', ' }}');
    assert.deepStrictEqual(names(ws.completionAt(T, section)), ['enabled', 'icon', 'id', 'label']);
  },
);
