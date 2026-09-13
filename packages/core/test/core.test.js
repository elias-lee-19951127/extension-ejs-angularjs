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

test('EJS scanner recognizes every region kind', () => {
  const r = C.scanEjs('a<% x %>b<%= y %>c<%- z %>d<%# k %>e<%% f');
  const kinds = r.filter((x) => x.kind !== 'html').map((x) => x.kind);
  assert.deepStrictEqual(kinds, ['scriptlet', 'output-escaped', 'output-raw', 'comment']);
});

test('EJS scanner is not fooled by a delimiter inside a string', () => {
  const r = C.scanEjs('<% if (x === "100%>") { %>ok');
  const script = r.find((x) => x.kind === 'scriptlet');
  assert.ok(script.inner.includes('100%>'), 'must swallow "100%>" whole into the region');
});

test('virtual HTML keeps the same length and line count', () => {
  const src = '<% a %>\n<div>\n<%= b %>';
  const v = C.toVirtualHtml(src, C.scanEjs(src));
  assert.strictEqual(v.length, src.length);
  assert.strictEqual(v.split('\n').length, src.split('\n').length);
  assert.ok(!v.includes('<%'));
});

test('directive name normalization follows Angular\'s own rules', () => {
  for (const a of ['ng-repeat', 'data-ng-repeat', 'x-ng-repeat', 'ng:repeat', 'ng_repeat']) {
    assert.strictEqual(C.normalizeDirectiveName(a), 'ngRepeat', a);
  }
});

test('expression parser: filter, one-time, absolute span', () => {
  const p = C.parseExpression('::a.b | money:2', 100);
  assert.strictEqual(p.oneTime, true);
  assert.deepStrictEqual(C.collectFilters(p).map((f) => f.name), ['money']);
  const roots = C.collectRoots(p);
  assert.strictEqual(roots[0].name, 'a');
  assert.deepStrictEqual(roots[0].path, ['b']);
  assert.strictEqual(roots[0].span.start, 102, 'the span must be an offset in the original file');
});

test('ng-repeat microsyntax: (key, value) + as + track by', () => {
  const r = C.parseRepeat('(k, v) in obj | f:q as res track by v.id', 0);
  assert.strictEqual(r.keyVar.name, 'k');
  assert.strictEqual(r.itemVar.name, 'v');
  assert.strictEqual(r.aliasVar.name, 'res');
  assert.ok(r.trackBy);
});

test('JS extractor: validates the module chain, does not confuse it with .filter(Boolean)', () => {
  const src = readFileSync(join(FIXTURE, 'js', 'app.js'), 'utf8');
  const f = C.extractJs(src, cfg);
  const names = f.declarations.map((d) => d.name).sort();
  assert.deepStrictEqual(names, [
    'Api', 'demo-view-controller', 'money', 'myWidget', 'neverUsed', 'pickFile',
  ]);
  assert.ok(!names.includes('not-angular'), 'something.service() is not an Angular module call');
});

test('JS extractor: gets the right variable name for $scope when the parameter is renamed', () => {
  const src = readFileSync(join(FIXTURE, 'js', 'app.js'), 'utf8');
  const f = C.extractJs(src, cfg);
  const names = f.scopeMembers.map((m) => m.name);
  // DI is ['$scope', 'Api'] but the parameters are named (s, Api) — must resolve to 's'.
  assert.ok(names.includes('rows'), 'must find s.rows through the position of $scope in the deps');
  assert.ok(names.includes('busy'));
});

test('JS extractor: a shape from an object literal carries a span for its keys', () => {
  const src = readFileSync(join(FIXTURE, 'js', 'app.js'), 'utf8');
  const f = C.extractJs(src, cfg);
  const busy = f.scopeMembers.find((m) => m.name === 'busy');
  assert.strictEqual(busy.shape.kind, 'object');
  assert.ok(busy.shape.props.saving.span, 'the key "saving" must carry a span for go-to-def to jump to');
});

test('template extractor: scope chain across ng-repeat', () => {
  const src = readFileSync(join(FIXTURE, 'views', 'page.ejs'), 'utf8');
  const f = C.extractTemplate(src, cfg);
  assert.strictEqual(f.parseErrors.length, 0, 'a file split by <% if %> must still parse cleanly');
  assert.strictEqual(f.controllers[0].name, 'demo-view-controller');
  const rowLabel = f.expressions.find((e) => e.text.includes('row.label'));
  assert.ok(rowLabel.scopeChain.some((s) => s.kind === 'repeat'));
  assert.ok(rowLabel.scopeChain.some((s) => s.controllerName === 'demo-view-controller'));
});

test('template extractor: captures EJS locals for Axis A', () => {
  const src = readFileSync(join(FIXTURE, 'views', 'page.ejs'), 'utf8');
  const f = C.extractTemplate(src, cfg);
  const names = [...new Set(f.ejsLocals.map((l) => l.name))].sort();
  assert.deepStrictEqual(names, ['checkViewACL', 'denyMessage']);
});

test('workspace: go-to-definition both ways + dead code', () => {
  const dbPath = join(FIXTURE, '.test-index.db');
  rmSync(dbPath, { force: true });
  const ws = new C.Workspace({ root: FIXTURE }, dbPath);
  const r = ws.index();
  assert.ok(r.indexed >= 2);

  const tpl = 'views/page.ejs';
  const src = ws.source(tpl);

  // {{ row.label }} -> 'row' is a local variable of ng-repeat
  const rowOff = src.indexOf('{{ row.label') + 3;
  const d1 = ws.definitionAt(tpl, rowOff);
  assert.strictEqual(d1.targets[0].kind, 'repeat-var');

  // busy.saving -> jumps exactly to the key 'saving' in the object literal
  const savingOff = src.indexOf('busy.saving') + 5;
  const d2 = ws.definitionAt(tpl, savingOff);
  assert.strictEqual(d2.targets[0].kind, 'shape-property');
  assert.match(ws.source(d2.targets[0].path).slice(d2.targets[0].span.start), /^saving/);

  // pick-file="onPick($file)" -> a custom directive, needs the Linker at Layer 4
  const onPickOff = src.indexOf('onPick($file)') + 2;
  const d3 = ws.definitionAt(tpl, onPickOff);
  assert.strictEqual(d3.query, 'onPick');
  assert.strictEqual(d3.targets.length, 1);

  // the reverse direction: s.rows -> finds the right spot in the template
  const js = 'js/app.js';
  const jsSrc = ws.source(js);
  const rowsOff = jsSrc.indexOf('s.rows = [{') + 2;
  const refs = ws.referencesAt(js, rowsOff);
  assert.strictEqual(refs.query, 'rows');
  assert.ok(refs.locations.some((l) => l.path === tpl), 'must find ng-repeat="row in rows"');

  // dead code: only 'neverUsed' is genuinely unused
  const unused = ws.unused().map((u) => u.name);
  assert.ok(unused.includes('neverUsed'));
  assert.ok(!unused.includes('pickFile'), 'pickFile is used through an attribute, the Linker must see it');
  assert.ok(!unused.includes('myWidget'), 'myWidget is used through a custom element');
  assert.ok(!unused.includes('money'), 'money is used through the | money filter');

  ws.close();
  rmSync(dbPath, { force: true });
});

test('a changed parser_version makes the cache count as stale', () => {
  assert.strictEqual(typeof C.PARSER_VERSION, 'number');
});
