/**
 * Ma tran kiem thu TOAN BO chuc nang, chay tren repo that (smart-city) va tren
 * fixture thu nho.
 *
 * Dinh vi bang CHUOI chu khong bang so dong/cot: dem cot bang tay da vai lan
 * lam ket luan sai ve san pham (tro nham vao `id="kbm-file-input"` thay vi thuoc
 * tinh `kbm-file`, tro vao giua `data-ng-class=` thay vi vao bieu thuc).
 */
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { existsSync, rmSync } = require('node:fs');
const C = require('../dist');

const REAL = '/Volumes/mac-dev/project/smart-city';
const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');

/** Vi tri cua lan xuat hien thu `nth` cua `needle`, dich them `offset` ky tu. */
function at(ws, rel, needle, { nth = 1, offset = 0 } = {}) {
  const src = ws.source(rel);
  assert.ok(src, `khong doc duoc ${rel}`);
  let idx = -1;
  for (let n = 0; n < nth; n++) {
    idx = src.indexOf(needle, idx + 1);
    assert.notStrictEqual(idx, -1, `khong tim thay lan ${nth} cua ${JSON.stringify(needle)} trong ${rel}`);
  }
  return idx + offset;
}

function textAt(ws, target) {
  const src = ws.source(target.path) ?? '';
  return src.slice(target.span.start, target.span.end);
}

// --------------------------------------------------------------- fixture

test('fixture: day du cac loai dieu huong', async (t) => {
  const db = join(FIXTURE, '.features.ndjson');
  rmSync(db, { force: true });
  const ws = new C.Workspace({ root: FIXTURE }, db);
  ws.index();

  const TPL = 'views/page.ejs';
  const JS = 'js/app.js';

  await t.test('ng-controller -> khai bao controller', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'demo-view-controller', { nth: 1 }));
    assert.strictEqual(d.targets[0].kind, 'controller');
    assert.strictEqual(d.targets[0].path, JS);
  });

  await t.test('ng-click goi ham tren scope', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'pick(row)'));
    assert.strictEqual(d.targets.length, 1);
    assert.strictEqual(textAt(ws, d.targets[0]), 'pick');
  });

  await t.test('bien ng-repeat', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'row.label'));
    assert.strictEqual(d.targets[0].kind, 'repeat-var');
  });

  await t.test('PROPERTY cua bien ng-repeat (bug nguoi dung bao)', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'row.label', { offset: 4 }));
    assert.strictEqual(d.targets.length, 1, 'phai resolve duoc row.label');
    assert.strictEqual(d.targets[0].kind, 'shape-property');
  });

  await t.test('mang rong: khong suy duoc shape phan tu, phai fallback tu te', () => {
    const facts = ws.facts('js/app.js');
    const empty = facts.scopeMembers.find((m) => m.name === 'emptyRows');
    assert.strictEqual(empty.shape.kind, 'array');
    assert.strictEqual(empty.shape.element.kind, 'unknown');
  });

  await t.test('property long nhau tren $scope', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'busy.saving', { offset: 5 }));
    assert.strictEqual(d.targets[0].kind, 'shape-property');
    assert.strictEqual(textAt(ws, d.targets[0]), 'saving');
  });

  await t.test('ng-model tro toi property cua form', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'form.title', { offset: 5 }));
    assert.strictEqual(textAt(ws, d.targets[0]), 'title');
  });

  await t.test('filter tu viet', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'money'));
    assert.ok(d.targets.length, 'phai tim thay .filter("money")');
  });

  await t.test('the custom -> component', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'my-widget', { offset: 1 }));
    assert.ok(d.targets.length, 'phai tim thay component myWidget');
  });

  await t.test('isolate binding tren the custom', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'data="form"', { offset: 6 }));
    assert.ok(d.targets.length, 'data="form" phai resolve ve $scope.form');
    assert.strictEqual(textAt(ws, d.targets[0]), 'form');
  });

  await t.test('directive dang thuoc tinh + bieu thuc ben trong', () => {
    const onName = ws.definitionAt(TPL, at(ws, TPL, 'pick-file', { offset: 1 }));
    assert.ok(onName.targets.length, 'ten thuoc tinh phai tro toi .directive("pickFile")');

    const inValue = ws.definitionAt(TPL, at(ws, TPL, 'onPick($file)'));
    assert.strictEqual(textAt(ws, inValue.targets[0]), 'onPick');
  });

  await t.test('DI trong JS -> khai bao factory', () => {
    const d = ws.definitionAt(JS, at(ws, JS, 'Api.list()'));
    assert.ok(d.targets.length, "'Api' phai tro toi .factory('Api')");
  });

  await t.test('find-references tu JS ra template', () => {
    const r = ws.referencesAt(JS, at(ws, JS, 's.rows = [{', { offset: 2 }));
    assert.strictEqual(r.query, 'rows');
    assert.ok(r.locations.some((l) => l.path === TPL));
  });

  await t.test('hover cho biet chuoi scope', () => {
    const chain = ws.scopeChainAt(TPL, at(ws, TPL, 'row.label'));
    assert.ok(chain.some((f) => f.kind === 'repeat'));
    assert.ok(chain.some((f) => f.controllerName === 'demo-view-controller'));
  });

  await t.test('completion liet ke property cua scope', () => {
    const items = ws.completionAt(TPL, at(ws, TPL, 'busy.saving'));
    const names = items.map((i) => i.name);
    assert.ok(names.includes('busy'));
    assert.ok(names.includes('rows'));
    assert.ok(names.includes('row'), 'phai co ca bien cuc bo cua ng-repeat');
  });

  await t.test('EJS locals cua truc A', () => {
    const facts = ws.facts(TPL);
    const names = [...new Set(facts.ejsLocals.map((l) => l.name))].sort();
    assert.deepStrictEqual(names, ['checkViewACL', 'denyMessage']);
  });

  await t.test('dead code: chi bao dung cai that su khong dung', () => {
    const unused = ws.unused().map((u) => u.name);
    assert.ok(unused.includes('neverUsed'));
    for (const used of ['pickFile', 'myWidget', 'money', 'Api', 'pick', 'rows']) {
      assert.ok(!unused.includes(used), `${used} co dung, khong duoc bao la dead`);
    }
  });

  t.after(() => {
    ws.close();
    rmSync(db, { force: true });
  });
});

// ------------------------------------------------------------ repo that

test('repo that smart-city', { skip: !existsSync(REAL) && 'khong co repo smart-city' }, async (t) => {
  const db = join('/tmp', 'ejsng-features-real.ndjson');
  rmSync(db, { force: true });
  const ws = new C.Workspace({ root: REAL }, db);
  const r = ws.index();
  const TPL = 'product/view/content.ejs';

  await t.test('index duoc toan bo repo', () => {
    assert.ok(r.indexed > 100, `chi index duoc ${r.indexed} file`);
    const s = ws.stats();
    assert.strictEqual(s.scopeMembers, 76, 'khop voi so $scope.<ten> duy nhat dem bang grep');
  });

  await t.test('data-ng-click -> $scope.selectSection', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'selectSection(section)'));
    assert.ok(d.targets.length);
    assert.strictEqual(textAt(ws, d.targets[0]), 'selectSection');
  });

  await t.test('section.id / .icon / .label / .enabled (bug nguoi dung bao)', () => {
    for (const [needle, prop] of [
      ['section.id', 'id'],
      ['section.icon', 'icon'],
      ['section.label', 'label'],
      ['section.enabled', 'enabled'],
    ]) {
      const d = ws.definitionAt(TPL, at(ws, TPL, needle, { offset: 8 }));
      assert.ok(d.targets.length, `${needle} phai resolve duoc`);
      assert.strictEqual(textAt(ws, d.targets[0]), prop, `${needle} phai nhay dung vao khoa`);
    }
  });

  await t.test('ng-repeat: CA HAI ve deu dieu huong duoc', () => {
    // Ve phai (collection) — bug nguoi dung bao lan 2. Truoc day hong vi ta luu
    // ca chuoi microsyntax "section in sections" lam text cua bieu thuc, ma `in`
    // khong phai toan tu Angular nen parse lai se hong.
    const rhs = ws.definitionAt(TPL, at(ws, TPL, 'section in sections', { offset: 11 }));
    assert.ok(rhs.targets.length, "'sections' phai tro toi \$scope.sections");
    assert.strictEqual(textAt(ws, rhs.targets[0]), 'sections');

    // Ve trai la CHO KHAI BAO — phai tra ve chinh no, khong duoc bao loi.
    const lhs = ws.definitionAt(TPL, at(ws, TPL, 'section in sections', { offset: 0 }));
    assert.strictEqual(lhs.targets[0].kind, 'repeat-var');

    // ng-repeat khac trong cung file
    const other = ws.definitionAt(TPL, at(ws, TPL, 'row in statRows', { offset: 7 }));
    assert.strictEqual(textAt(ws, other.targets[0]), 'statRows');
  });

  await t.test('property long nhau: busy.stats, searchForm.query', () => {
    for (const [needle, prop] of [
      ['busy.stats', 'stats'],
      ['searchForm.query', 'query'],
    ]) {
      const d = ws.definitionAt(TPL, at(ws, TPL, needle, { offset: needle.indexOf('.') + 1 }));
      assert.strictEqual(textAt(ws, d.targets[0]), prop);
    }
  });

  await t.test('data-ng-controller -> khai bao controller', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'data-ng-controller="', { offset: 20 }));
    assert.ok(d.targets.length);
    assert.strictEqual(d.targets[0].kind, 'controller');
  });

  await t.test('directive dang thuoc tinh kbm-file', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, ' kbm-file=', { offset: 1 }));
    assert.ok(d.targets.length, 'kbm-file phai tro toi .directive("kbmFile")');
  });

  await t.test('find-references: $scope.busy dung o nhieu template', () => {
    const js = 'product/view/public/javascripts/index.js';
    const refs = ws.referencesAt(js, at(ws, js, '$scope.busy = ', { offset: 7 }));
    assert.strictEqual(refs.query, 'busy');
    assert.ok(refs.locations.length > 20, `chi thay ${refs.locations.length} tham chieu`);
  });

  await t.test('dieu huong trong chinh file .js', () => {
    const js = 'product/view/public/javascripts/index.js';

    // const cung file -> khai bao
    const c = ws.definitionAt(js, at(ws, js, 'serviceId: SERVICE_ID', { offset: 11 }));
    assert.strictEqual(c.targets[0].kind, 'const');
    assert.strictEqual(textAt(ws, c.targets[0]), 'SERVICE_ID');

    // ten duoc inject -> uu tien khai bao Angular, roi moi toi tham so ham
    const di = ws.definitionAt(js, at(ws, js, 'aocs.http.post'));
    assert.strictEqual(di.targets[0].kind, 'factory');
    assert.strictEqual(di.targets[1].kind, 'param');

    // $scope.foo trong JS -> scope-member
    const sm = ws.definitionAt(js, at(ws, js, 'busy.search = true'));
    assert.ok(sm.targets.some((x) => x.kind === 'scope-member'));

    // bien toan cuc: khong co dinh nghia nhung KHONG phai loi
    for (const g of ['window.localStorage', 'JSON.parse(window']) {
      const d = ws.definitionAt(js, at(ws, js, g));
      assert.strictEqual(d.targets.length, 0);
      assert.strictEqual(d.builtin, true, `${g} phai duoc danh dau la dung san`);
    }
  });

  await t.test('global lien file (kieu <script> tag)', () => {
    // DHA_STATUS khai bao o dha.const.js, dung o dha.controller.js
    const js = 'dha.controller.js';
    const d = ws.definitionAt(js, at(ws, js, 'DHA_STATUS', { nth: 2 }));
    assert.ok(d.targets.length, 'phai tim thay khai bao o file khac');
    assert.ok(d.targets.some((x) => x.path === 'dha.const.js'));
  });

  await t.test('do phu tren file controller chinh', () => {
    const js = 'product/view/public/javascripts/index.js';
    let total = 0;
    let missed = 0;
    for (const off of ws.jsReferenceOffsets(js)) {
      total++;
      const d = ws.definitionAt(js, off);
      if (!d.targets.length && !d.builtin) missed++;
    }
    assert.ok(total > 400, `chi thay ${total} tham chieu`);
    assert.ok(missed / total < 0.02, `sot ${missed}/${total} — vuot nguong 2%`);
  });

  await t.test('khong nham .filter(Boolean) la Angular filter', () => {
    const facts = ws.facts('tests/_refs/vector-db/chunker.js');
    assert.strictEqual(facts.declarations.length, 0);
  });

  await t.test('template bi cat boi <% if %> van parse sach', () => {
    const facts = ws.facts(TPL);
    assert.strictEqual(facts.parseErrors.length, 0);
    assert.ok(facts.expressions.length > 100);
  });

  t.after(() => {
    ws.close();
    rmSync(db, { force: true });
  });
});
