/**
 * A feature-matrix test covering the WHOLE feature set, run against a real repo
 * (smart-city) and a small fixture.
 *
 * Locates positions by STRING rather than line/column numbers: counting columns by hand
 * has led to wrong conclusions about the product more than once (landing on
 * `id="kbm-file-input"` instead of the `kbm-file` attribute, landing in the middle of
 * `data-ng-class=` instead of inside the expression).
 */
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { existsSync, rmSync } = require('node:fs');
const C = require('../dist');
const { at, textAt } = require('./helpers');

const REAL = '/Volumes/mac-dev/project/smart-city';
const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');

// --------------------------------------------------------------- fixture

test('fixture: every kind of navigation', async (t) => {
  const db = join(FIXTURE, '.features.ndjson');
  rmSync(db, { force: true });
  const ws = new C.Workspace({ root: FIXTURE }, db);
  ws.index();

  const TPL = 'views/page.ejs';
  const JS = 'js/app.js';

  await t.test('ng-controller -> the controller\'s declaration', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'demo-view-controller', { nth: 1 }));
    assert.strictEqual(d.targets[0].kind, 'controller');
    assert.strictEqual(d.targets[0].path, JS);
  });

  await t.test('ng-click calls a function on scope', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'pick(row)'));
    assert.strictEqual(d.targets.length, 1);
    assert.strictEqual(textAt(ws, d.targets[0]), 'pick');
  });

  await t.test('an ng-repeat variable', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'row.label'));
    assert.strictEqual(d.targets[0].kind, 'repeat-var');
  });

  await t.test('a PROPERTY of an ng-repeat variable (a bug the user reported)', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'row.label', { offset: 4 }));
    assert.strictEqual(d.targets.length, 1, 'must resolve row.label');
    assert.strictEqual(d.targets[0].kind, 'shape-property');
  });

  await t.test('an empty array: cannot infer the element shape, must fall back gracefully', () => {
    const facts = ws.facts('js/app.js');
    const empty = facts.scopeMembers.find((m) => m.name === 'emptyRows');
    assert.strictEqual(empty.shape.kind, 'array');
    assert.strictEqual(empty.shape.element.kind, 'unknown');
  });

  await t.test('a nested property on $scope', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'busy.saving', { offset: 5 }));
    assert.strictEqual(d.targets[0].kind, 'shape-property');
    assert.strictEqual(textAt(ws, d.targets[0]), 'saving');
  });

  await t.test('ng-model points at a property of form', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'form.title', { offset: 5 }));
    assert.strictEqual(textAt(ws, d.targets[0]), 'title');
  });

  await t.test('a custom filter', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'money'));
    assert.ok(d.targets.length, 'must find .filter("money")');
  });

  await t.test('a custom element -> a component', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'my-widget', { offset: 1 }));
    assert.ok(d.targets.length, 'must find the myWidget component');
  });

  await t.test('an isolate binding on a custom element', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'data="form"', { offset: 6 }));
    assert.ok(d.targets.length, 'data="form" must resolve to $scope.form');
    assert.strictEqual(textAt(ws, d.targets[0]), 'form');
  });

  await t.test('a directive expressed as an attribute + the expression inside it', () => {
    const onName = ws.definitionAt(TPL, at(ws, TPL, 'pick-file', { offset: 1 }));
    assert.ok(onName.targets.length, 'the attribute name must point to .directive("pickFile")');

    const inValue = ws.definitionAt(TPL, at(ws, TPL, 'onPick($file)'));
    assert.strictEqual(textAt(ws, inValue.targets[0]), 'onPick');
  });

  await t.test('DI in JS -> a factory declaration', () => {
    const d = ws.definitionAt(JS, at(ws, JS, 'Api.list()'));
    assert.ok(d.targets.length, "'Api' must point to .factory('Api')");
  });

  await t.test('find-references from JS out to a template', () => {
    const r = ws.referencesAt(JS, at(ws, JS, 's.rows = [{', { offset: 2 }));
    assert.strictEqual(r.query, 'rows');
    assert.ok(r.locations.some((l) => l.path === TPL));
  });

  await t.test('hover reports the scope chain', () => {
    const chain = ws.scopeChainAt(TPL, at(ws, TPL, 'row.label'));
    assert.ok(chain.some((f) => f.kind === 'repeat'));
    assert.ok(chain.some((f) => f.controllerName === 'demo-view-controller'));
  });

  await t.test('completion lists the properties of the scope', () => {
    const items = ws.completionAt(TPL, at(ws, TPL, 'busy.saving'));
    const names = items.map((i) => i.name);
    assert.ok(names.includes('busy'));
    assert.ok(names.includes('rows'));
    assert.ok(names.includes('row'), 'must also include the ng-repeat local variable');
  });

  await t.test('EJS locals of Axis A', () => {
    const facts = ws.facts(TPL);
    const names = [...new Set(facts.ejsLocals.map((l) => l.name))].sort();
    assert.deepStrictEqual(names, ['checkViewACL', 'denyMessage']);
  });

  await t.test('dead code: only flags what is genuinely unused', () => {
    const unused = ws.unused().map((u) => u.name);
    assert.ok(unused.includes('neverUsed'));
    for (const used of ['pickFile', 'myWidget', 'money', 'Api', 'pick', 'rows']) {
      assert.ok(!unused.includes(used), `${used} is used, must not be reported as dead`);
    }
  });

  t.after(() => {
    ws.close();
    rmSync(db, { force: true });
  });
});

// ------------------------------------------------------------ real repo

test('real repo: smart-city', { skip: !existsSync(REAL) && 'smart-city repo not available' }, async (t) => {
  const db = join('/tmp', 'ejsng-features-real.ndjson');
  rmSync(db, { force: true });
  const ws = new C.Workspace({ root: REAL }, db);
  const r = ws.index();
  const TPL = 'product/view/content.ejs';

  await t.test('indexes the whole repo', () => {
    assert.ok(r.indexed > 100, `only indexed ${r.indexed} files`);
    const s = ws.stats();
    assert.strictEqual(s.scopeMembers, 76, 'must match the count of unique $scope.<name> counted with grep');
  });

  await t.test('data-ng-click -> $scope.selectSection', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'selectSection(section)'));
    assert.ok(d.targets.length);
    assert.strictEqual(textAt(ws, d.targets[0]), 'selectSection');
  });

  await t.test('section.id / .icon / .label / .enabled (a bug the user reported)', () => {
    for (const [needle, prop] of [
      ['section.id', 'id'],
      ['section.icon', 'icon'],
      ['section.label', 'label'],
      ['section.enabled', 'enabled'],
    ]) {
      const d = ws.definitionAt(TPL, at(ws, TPL, needle, { offset: 8 }));
      assert.ok(d.targets.length, `${needle} must resolve`);
      assert.strictEqual(textAt(ws, d.targets[0]), prop, `${needle} must jump exactly to the key`);
    }
  });

  await t.test('ng-repeat: BOTH sides navigate', () => {
    // The right side (the collection) — a bug the user reported a second time. It used
    // to break because we stored the whole microsyntax string "section in sections" as
    // the expression's text, and `in` is not an Angular operator, so re-parsing it broke.
    const rhs = ws.definitionAt(TPL, at(ws, TPL, 'section in sections', { offset: 11 }));
    assert.ok(rhs.targets.length, "'sections' must point to \$scope.sections");
    assert.strictEqual(textAt(ws, rhs.targets[0]), 'sections');

    // The left side is the DECLARATION SITE — must return itself, must never report an error.
    const lhs = ws.definitionAt(TPL, at(ws, TPL, 'section in sections', { offset: 0 }));
    assert.strictEqual(lhs.targets[0].kind, 'repeat-var');

    // A different ng-repeat in the same file
    const other = ws.definitionAt(TPL, at(ws, TPL, 'row in statRows', { offset: 7 }));
    assert.strictEqual(textAt(ws, other.targets[0]), 'statRows');
  });

  await t.test('a controller declared under the same name in 2 files: definition returns only the NEAREST copy', () => {
    // Used to return both copies -> the IDE popped up a picker at 168/244 positions.
    const d = ws.definitionAt(TPL, at(ws, TPL, 'section in sections', { offset: 11 }));
    assert.strictEqual(d.targets.length, 1);
    assert.ok(d.targets[0].path.startsWith('product/'), d.targets[0].path);
    assert.deepStrictEqual(d.otherFiles, ['new-version/fe-be/index.js']);
  });

  await t.test('nested properties: busy.stats, searchForm.query', () => {
    for (const [needle, prop] of [
      ['busy.stats', 'stats'],
      ['searchForm.query', 'query'],
    ]) {
      const d = ws.definitionAt(TPL, at(ws, TPL, needle, { offset: needle.indexOf('.') + 1 }));
      assert.strictEqual(textAt(ws, d.targets[0]), prop);
    }
  });

  await t.test('data-ng-controller -> the controller\'s declaration', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, 'data-ng-controller="', { offset: 20 }));
    assert.ok(d.targets.length);
    assert.strictEqual(d.targets[0].kind, 'controller');
  });

  await t.test('the kbm-file attribute-style directive', () => {
    const d = ws.definitionAt(TPL, at(ws, TPL, ' kbm-file=', { offset: 1 }));
    assert.ok(d.targets.length, 'kbm-file must point to .directive("kbmFile")');
  });

  await t.test('find-references: $scope.busy used in multiple templates', () => {
    const js = 'product/view/public/javascripts/index.js';
    const refs = ws.referencesAt(js, at(ws, js, '$scope.busy = ', { offset: 7 }));
    assert.strictEqual(refs.query, 'busy');
    assert.ok(refs.locations.length > 20, `only found ${refs.locations.length} references`);
  });

  await t.test('navigation within the .js file itself', () => {
    const js = 'product/view/public/javascripts/index.js';

    // a const in the same file -> its declaration
    const c = ws.definitionAt(js, at(ws, js, 'serviceId: SERVICE_ID', { offset: 11 }));
    assert.strictEqual(c.targets[0].kind, 'const');
    assert.strictEqual(textAt(ws, c.targets[0]), 'SERVICE_ID');

    // an injected name -> the Angular declaration takes priority, then the function parameter
    const di = ws.definitionAt(js, at(ws, js, 'aocs.http.post'));
    assert.strictEqual(di.targets[0].kind, 'factory');
    assert.strictEqual(di.targets[1].kind, 'param');

    // $scope.foo in JS -> a scope-member
    const sm = ws.definitionAt(js, at(ws, js, 'busy.search = true'));
    assert.ok(sm.targets.some((x) => x.kind === 'scope-member'));

    // a global variable: no definition, but NOT an error
    for (const g of ['window.localStorage', 'JSON.parse(window']) {
      const d = ws.definitionAt(js, at(ws, js, g));
      assert.strictEqual(d.targets.length, 0);
      assert.strictEqual(d.builtin, true, `${g} must be flagged as built-in`);
    }
  });

  await t.test('a cross-file global (<script>-tag style)', () => {
    // DHA_STATUS declared in dha.const.js, used in dha.controller.js
    const js = 'dha.controller.js';
    const d = ws.definitionAt(js, at(ws, js, 'DHA_STATUS', { nth: 2 }));
    assert.ok(d.targets.length, 'must find the declaration in the other file');
    assert.ok(d.targets.some((x) => x.path === 'dha.const.js'));
  });

  await t.test('coverage on the main controller file', () => {
    const js = 'product/view/public/javascripts/index.js';
    let total = 0;
    let missed = 0;
    for (const off of ws.jsReferenceOffsets(js)) {
      total++;
      const d = ws.definitionAt(js, off);
      if (!d.targets.length && !d.builtin) missed++;
    }
    assert.ok(total > 400, `only found ${total} references`);
    assert.ok(missed / total < 0.02, `missed ${missed}/${total} — over the 2% threshold`);
  });

  await t.test('does not mistake .filter(Boolean) for an Angular filter', () => {
    const facts = ws.facts('tests/_refs/vector-db/chunker.js');
    assert.strictEqual(facts.declarations.length, 0);
  });

  await t.test('a template split by <% if %> still parses cleanly', () => {
    const facts = ws.facts(TPL);
    assert.strictEqual(facts.parseErrors.length, 0);
    assert.ok(facts.expressions.length > 100);
  });

  t.after(() => {
    ws.close();
    rmSync(db, { force: true });
  });
});

test('linkedSpans: what in a template JavaScript answers for, and nothing the template declares', () => {
  const db = join(FIXTURE, '.linked.ndjson');
  rmSync(db, { force: true });
  const ws = new C.Workspace({ root: FIXTURE }, db);
  ws.index();
  const TPL = 'views/page.ejs';
  const src = ws.source(TPL);
  const got = ws.linkedSpans(TPL).map((l) => `${l.kind}:${src.slice(l.span.start, l.span.end)}`);
  assert.deepStrictEqual(got, [
    'declaration:demo-view-controller',
    'scope:init',
    'scope:rows',
    'scope:pick',
    'scope:busy',
    'scope:saving',
    'scope:form',
    'scope:title',
    'scope:total',
    'declaration:money',
    'declaration:my-widget',
    'declaration:pick-file',
  ]);
  // `row` is the ng-repeat's own variable: the template declares it, not a script.
  assert.ok(!got.some((g) => g.endsWith(':row')), got.join(', '));
  assert.deepStrictEqual(ws.linkedSpans('js/app.js'), [], 'only templates');
  rmSync(db, { force: true });
});
