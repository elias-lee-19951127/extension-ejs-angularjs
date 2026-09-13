/**
 * A controller declared under the SAME NAME in multiple files, and what `confidence` means.
 *
 * A temp directory tree shaped like smart-city: two copies of the same controller on two
 * branches (`product/view` and `new-version/fe-be`), each with its own template.
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
  // The copy on the far branch has one extra property and one property of its own: to
  // check whether completion mixes the two copies.
  const FAR_JS = JS.replace(
    's.busy = { saving: false };',
    () => 's.busy = { saving: false, farOnly: true };',
  ).replace('}]);', () => '  s.farBranchOnly = 1;\n}]);');
  for (const dir of BRANCHES) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'index.js'), dir === BRANCHES[0] ? JS : FAR_JS);
    writeFileSync(join(root, dir, 'content.ejs'), TPL);
  }
  // The factory exists on only one branch — used for the DI case below.
  writeFileSync(join(root, 'new-version/fe-be/api.js'), "myApp.factory('Api', function () { return {}; });\n");
  // A template at the root: sits equidistant from both copies.
  writeFileSync(join(root, 'shared.ejs'), TPL);
  const ws = new C.Workspace({ root }, ':memory:');
  ws.index();
  return ws;
}

const at = (ws, rel, needle, offset = 0) => {
  const idx = ws.source(rel).indexOf(needle);
  assert.notStrictEqual(idx, -1, `${JSON.stringify(needle)} not found in ${rel}`);
  return idx + offset;
};

test('definition: a controller declared under the same name in 2 files -> returns only the directory-nearest copy', (t) => {
  const ws = workspace(t);
  for (const branch of BRANCHES) {
    const rel = `${branch}/content.ejs`;
    const d = ws.definitionAt(rel, at(ws, rel, '{{ total }}', 3));
    assert.strictEqual(d.targets.length, 1, `${branch}: should end up with exactly 1 target`);
    assert.strictEqual(d.targets[0].path, `${branch}/index.js`);
    const far = BRANCHES.find((b) => b !== branch);
    assert.deepStrictEqual(d.otherFiles, [`${far}/index.js`], 'the other copy must be reported, not hidden');
  }
});

test('definition: equidistant from both copies keeps both — no telling them apart means no guessing', (t) => {
  const ws = workspace(t);
  const d = ws.definitionAt('shared.ejs', at(ws, 'shared.ejs', '{{ total }}', 3));
  assert.strictEqual(d.targets.length, 2);
  assert.strictEqual(d.otherFiles, undefined);
});

test('definition: targets of a DIFFERENT kind are never merged — DI still returns both the Angular declaration and the function parameter', (t) => {
  const ws = workspace(t);
  const rel = 'product/view/index.js';
  const d = ws.definitionAt(rel, at(ws, rel, 'Api.list()'));
  assert.deepStrictEqual(
    d.targets.map((x) => [x.kind, x.path]),
    [
      ['factory', 'new-version/fe-be/api.js'],
      ['param', rel],
    ],
    'an Angular declaration in a farther file must NOT be filtered out by the nearest-directory rule',
  );
  assert.strictEqual(d.otherFiles, undefined);
});

test('confidence: medium ONLY when the shape could not be walked, not "not sure"', (t) => {
  const ws = workspace(t);
  const rel = 'product/view/content.ejs';

  const plain = ws.definitionAt(rel, at(ws, rel, '{{ total }}', 3));
  assert.deepStrictEqual([plain.targets[0].kind, plain.targets[0].confidence], ['scope-member', 'high']);

  const nested = ws.definitionAt(rel, at(ws, rel, 'busy.saving', 5));
  assert.deepStrictEqual([nested.targets[0].kind, nested.targets[0].confidence], ['shape-property', 'high']);

  // `s.stats = fetchStats()` — the shape can't be inferred, so it only jumps to `stats` itself.
  const unknown = ws.definitionAt(rel, at(ws, rel, 'stats.total', 6));
  assert.deepStrictEqual([unknown.targets[0].kind, unknown.targets[0].confidence], ['scope-member', 'medium']);
});

test('completion: only suggests properties of the NEAREST copy', (t) => {
  const ws = workspace(t);
  const names = (rel) => ws.completionAt(rel, at(ws, rel, '{{ total }}', 3)).map((c) => c.name);

  const near = names('product/view/content.ejs');
  assert.ok(near.includes('total') && near.includes('busy'), near.join(','));
  assert.ok(!near.includes('farBranchOnly'), 'a property that only exists on the far copy must not be suggested');

  // And the reverse — it's not always the same branch that wins.
  assert.ok(names('new-version/fe-be/content.ejs').includes('farBranchOnly'));
});

test('completion after a dot: keys come from the nearest copy\'s shape, the two copies are not mixed', (t) => {
  const ws = workspace(t);
  const keys = (rel) => ws.completionAt(rel, at(ws, rel, 'busy.saving', 5)).map((c) => c.name).sort();

  assert.deepStrictEqual(keys('product/view/content.ejs'), ['saving']);
  assert.deepStrictEqual(keys('new-version/fe-be/content.ejs'), ['farOnly', 'saving']);
});

test('detail names the segment ACTUALLY reached, not the path that was asked for', (t) => {
  const ws = workspace(t);
  const rel = 'product/view/content.ejs';
  // `$scope.rows = [{ a: {} }]` — reaches `a`, gets stuck at `b`.
  const d = ws.definitionAt(rel, at(ws, rel, 'row.a.b', 6));
  assert.strictEqual(d.targets.length, 1);
  assert.match(d.targets[0].detail, /^row\.a —/, d.targets[0].detail);
  assert.strictEqual(d.targets[0].confidence, 'medium');
});

// `nearestRows`/`preferNearest` (packages/core/src/resolve/rename.ts) are pure functions —
// no need for Workspace/index() to check the "nearest copy" rule, just fake arrays/objects
// (Appendix M, candidate C).

test('nearestRows: keeps the nearest copy, keeps both on a tie', () => {
  const rows = [{ path: 'a/x.js' }, { path: 'a/b/y.js' }];
  assert.deepStrictEqual(C.nearestRows('a/b/from.js', rows), [{ path: 'a/b/y.js' }]);
  assert.deepStrictEqual(C.nearestRows('c/from.js', rows), rows); // a tie in distance -> keeps both
  assert.deepStrictEqual(C.nearestRows('a/b/from.js', [rows[0]]), [rows[0]]); // 1 path -> the rule doesn't apply
});

test('preferNearest: only filters when every target is the SAME kind; otherFiles keeps the filtered-out copy', () => {
  const sameKind = {
    targets: [
      { path: 'a/x.js', kind: 'controller' },
      { path: 'a/b/y.js', kind: 'controller' },
    ],
  };
  const loc = C.preferNearest('a/b/from.js', sameKind);
  assert.deepStrictEqual(loc.targets, [{ path: 'a/b/y.js', kind: 'controller' }]);
  assert.deepStrictEqual(loc.otherFiles, ['a/x.js']);

  const diffKind = {
    targets: [
      { path: 'a/x.js', kind: 'param' },
      { path: 'a/b/y.js', kind: 'declaration' },
    ],
  };
  assert.strictEqual(C.preferNearest('a/b/from.js', diffKind), diffKind); // different kind -> never merged
});
