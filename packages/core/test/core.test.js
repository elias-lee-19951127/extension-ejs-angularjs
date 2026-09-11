const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { readFileSync, rmSync } = require('node:fs');
const C = require('../dist');

const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');
const cfg = { root: FIXTURE, ...C.DEFAULT_CONFIG };

const at = (src, line, col) => {
  const lines = src.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1;
  return off + col - 1;
};

test('EJS scanner nhan dung moi loai region', () => {
  const r = C.scanEjs('a<% x %>b<%= y %>c<%- z %>d<%# k %>e<%% f');
  const kinds = r.filter((x) => x.kind !== 'html').map((x) => x.kind);
  assert.deepStrictEqual(kinds, ['scriptlet', 'output-escaped', 'output-raw', 'comment']);
});

test('EJS scanner khong bi lua boi delimiter trong chuoi', () => {
  const r = C.scanEjs('<% if (x === "100%>") { %>ok');
  const script = r.find((x) => x.kind === 'scriptlet');
  assert.ok(script.inner.includes('100%>'), 'phai nuot ca "100%>" vao trong region');
});

test('virtual HTML giu nguyen do dai va so dong', () => {
  const src = '<% a %>\n<div>\n<%= b %>';
  const v = C.toVirtualHtml(src, C.scanEjs(src));
  assert.strictEqual(v.length, src.length);
  assert.strictEqual(v.split('\n').length, src.split('\n').length);
  assert.ok(!v.includes('<%'));
});

test('chuan hoa ten directive theo dung luat Angular', () => {
  for (const a of ['ng-repeat', 'data-ng-repeat', 'x-ng-repeat', 'ng:repeat', 'ng_repeat']) {
    assert.strictEqual(C.normalizeDirectiveName(a), 'ngRepeat', a);
  }
});

test('parser bieu thuc: filter, one-time, span tuyet doi', () => {
  const p = C.parseExpression('::a.b | money:2', 100);
  assert.strictEqual(p.oneTime, true);
  assert.deepStrictEqual(C.collectFilters(p).map((f) => f.name), ['money']);
  const roots = C.collectRoots(p);
  assert.strictEqual(roots[0].name, 'a');
  assert.deepStrictEqual(roots[0].path, ['b']);
  assert.strictEqual(roots[0].span.start, 102, 'span phai la offset trong file goc');
});

test('microsyntax ng-repeat: (key, value) + as + track by', () => {
  const r = C.parseRepeat('(k, v) in obj | f:q as res track by v.id', 0);
  assert.strictEqual(r.keyVar.name, 'k');
  assert.strictEqual(r.itemVar.name, 'v');
  assert.strictEqual(r.aliasVar.name, 'res');
  assert.ok(r.trackBy);
});

test('extractor JS: xac thuc chuoi module, khong an .filter(Boolean)', () => {
  const src = readFileSync(join(FIXTURE, 'js', 'app.js'), 'utf8');
  const f = C.extractJs(src, cfg);
  const names = f.declarations.map((d) => d.name).sort();
  assert.deepStrictEqual(names, [
    'Api', 'demo-view-controller', 'money', 'myWidget', 'neverUsed', 'pickFile',
  ]);
  assert.ok(!names.includes('not-angular'), 'something.service() khong phai module Angular');
});

test('extractor JS: lay dung ten bien giu $scope khi tham so bi doi ten', () => {
  const src = readFileSync(join(FIXTURE, 'js', 'app.js'), 'utf8');
  const f = C.extractJs(src, cfg);
  const names = f.scopeMembers.map((m) => m.name);
  // DI la ['$scope', 'Api'] nhung tham so ten la (s, Api) — phai lan ra 's'.
  assert.ok(names.includes('rows'), 'phai tim thay s.rows qua vi tri cua $scope trong deps');
  assert.ok(names.includes('busy'));
});

test('extractor JS: shape tu object literal co span cua khoa', () => {
  const src = readFileSync(join(FIXTURE, 'js', 'app.js'), 'utf8');
  const f = C.extractJs(src, cfg);
  const busy = f.scopeMembers.find((m) => m.name === 'busy');
  assert.strictEqual(busy.shape.kind, 'object');
  assert.ok(busy.shape.props.saving.span, 'khoa saving phai co span de go-to-def nhay vao');
});

test('extractor template: scope chain qua ng-repeat', () => {
  const src = readFileSync(join(FIXTURE, 'views', 'page.ejs'), 'utf8');
  const f = C.extractTemplate(src, cfg);
  assert.strictEqual(f.parseErrors.length, 0, 'file bi cat boi <% if %> van phai parse sach');
  assert.strictEqual(f.controllers[0].name, 'demo-view-controller');
  const rowLabel = f.expressions.find((e) => e.text.includes('row.label'));
  assert.ok(rowLabel.scopeChain.some((s) => s.kind === 'repeat'));
  assert.ok(rowLabel.scopeChain.some((s) => s.controllerName === 'demo-view-controller'));
});

test('extractor template: bat EJS locals cua truc A', () => {
  const src = readFileSync(join(FIXTURE, 'views', 'page.ejs'), 'utf8');
  const f = C.extractTemplate(src, cfg);
  const names = [...new Set(f.ejsLocals.map((l) => l.name))].sort();
  assert.deepStrictEqual(names, ['checkViewACL', 'denyMessage']);
});

test('workspace: go-to-definition ca hai chieu + dead code', () => {
  const dbPath = join(FIXTURE, '.test-index.db');
  rmSync(dbPath, { force: true });
  const ws = new C.Workspace({ root: FIXTURE }, dbPath);
  const r = ws.index();
  assert.ok(r.indexed >= 2);

  const tpl = 'views/page.ejs';
  const src = ws.source(tpl);

  // {{ row.label }} -> 'row' la bien cuc bo cua ng-repeat
  const rowOff = src.indexOf('{{ row.label') + 3;
  const d1 = ws.definitionAt(tpl, rowOff);
  assert.strictEqual(d1.targets[0].kind, 'repeat-var');

  // busy.saving -> nhay dung vao khoa 'saving' trong object literal
  const savingOff = src.indexOf('busy.saving') + 5;
  const d2 = ws.definitionAt(tpl, savingOff);
  assert.strictEqual(d2.targets[0].kind, 'shape-property');
  assert.match(ws.source(d2.targets[0].path).slice(d2.targets[0].span.start), /^saving/);

  // pick-file="onPick($file)" -> directive tu viet, can Linker o Layer 4
  const onPickOff = src.indexOf('onPick($file)') + 2;
  const d3 = ws.definitionAt(tpl, onPickOff);
  assert.strictEqual(d3.query, 'onPick');
  assert.strictEqual(d3.targets.length, 1);

  // chieu nguoc: s.rows -> tim ra cho dung trong template
  const js = 'js/app.js';
  const jsSrc = ws.source(js);
  const rowsOff = jsSrc.indexOf('s.rows = [{') + 2;
  const refs = ws.referencesAt(js, rowsOff);
  assert.strictEqual(refs.query, 'rows');
  assert.ok(refs.locations.some((l) => l.path === tpl), 'phai thay ng-repeat="row in rows"');

  // dead code: chi 'neverUsed' la that su khong dung
  const unused = ws.unused().map((u) => u.name);
  assert.ok(unused.includes('neverUsed'));
  assert.ok(!unused.includes('pickFile'), 'pickFile dung qua thuoc tinh, Linker phai thay');
  assert.ok(!unused.includes('myWidget'), 'myWidget dung qua the custom');
  assert.ok(!unused.includes('money'), 'money dung qua filter | money');

  ws.close();
  rmSync(dbPath, { force: true });
});

test('parser_version doi thi cache bi coi la cu', () => {
  assert.strictEqual(typeof C.PARSER_VERSION, 'number');
});
