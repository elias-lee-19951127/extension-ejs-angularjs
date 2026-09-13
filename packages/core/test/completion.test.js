/**
 * Completion in a template: follow the SHAPE inferred from an object literal when typing `busy.`.
 *
 * Simulates the moment of typing: an unfinished expression (`{{ busy. }}`) CANNOT be
 * parsed — the extractor drops it entirely — so the test puts the in-progress buffer
 * into the overlay instead of using the original file.
 */
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const C = require('../dist');

const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');
const TPL = 'views/page.ejs';

/** Insert `before` + `after` right after `anchor` in the buffer; returns the cursor offset (between the two pieces). */
function typeAt(ws, rel, anchor, before, after = '') {
  const src = ws.source(rel);
  const idx = src.indexOf(anchor);
  assert.notStrictEqual(idx, -1, `${JSON.stringify(anchor)} not found`);
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

test('typing `busy.` -> suggests the keys of the $scope.busy object literal', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<span>', '{{ busy.', ' }}');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['loading', 'saving']);
});

test('typing `row.` inside ng-repeat -> keys of an ELEMENT in $scope.rows', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '{{ row.label }}', ' {{ row.', ' }}');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['id', 'label', 'tags']);
});

test('cursor at the end of a key being typed still gets suggestions: `busy.sa|`', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<span>', '{{ busy.sa', ' }}');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['loading', 'saving']);
});

test('a directive attribute value also gets shape-based suggestions', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<input data-ng-model="form.title"', ' data-ng-click="form.', '"');
  assert.deepStrictEqual(names(ws.completionAt(TPL, offset)), ['body', 'title']);
});

test('typing inside a string gets no suggestions', () => {
  const ws = fixtureWs();
  const offset = typeAt(ws, TPL, '<span>', "{{ 'busy.", "' }}");
  assert.deepStrictEqual(ws.completionAt(TPL, offset), []);
});

const { existsSync } = require('node:fs');
const REAL = '/Volumes/mac-dev/project/smart-city';

test(
  'smart-city: `busy.` and `section.` suggest the real object literal keys',
  { skip: !existsSync(REAL) && 'smart-city repo not available' },
  () => {
    const ws = new C.Workspace({ root: REAL }, ':memory:');
    ws.index();
    const T = 'product/view/content.ejs';
    // Read by hand from product/view/public/javascripts/index.js (2026-09-11): line 53 and lines 32-38.
    const busy = typeAt(ws, T, 'DHA Management</div>', '{{ busy.', ' }}');
    assert.deepStrictEqual(names(ws.completionAt(T, busy)), [
      'docStatus', 'documents', 'ingest', 'maintain', 'search', 'stats', 'upload', 'voicePreview', 'voices',
    ]);
    ws.clearOverlay(T);
    const section = typeAt(ws, T, '<span class="kbm-nav-label">', '{{ section.', ' }}');
    assert.deepStrictEqual(names(ws.completionAt(T, section)), ['enabled', 'icon', 'id', 'label']);
  },
);
