/**
 * expand-log-values ticket 01: a logged value rendered three ways — one line beside the code,
 * several lines in a hover, valid JSON in a tab. Against real V8 through `node:inspector`, so the
 * previews, `getProperties` answers and descriptions are the ones a runtime really sends.
 */
const test = require('node:test');
const assert = require('node:assert');
const inspector = require('node:inspector');
const C = require('../dist');

/** Log `value` and hand back its CDP argument, plus a `getProperties` bound to this session. */
async function logged(t, value) {
  const session = new inspector.Session();
  session.connect();
  t.after(() => session.disconnect());
  const post = (method, params) => new Promise((resolve) => session.post(method, params, (err, res) => resolve(err ? null : res)));
  const args = [];
  const onLog = (m) => args.push(m.params.args[0]);
  session.on('Runtime.consoleAPICalled', onLog);
  await post('Runtime.enable');
  console.debug(value);
  await new Promise((r) => setImmediate(r));
  session.removeListener('Runtime.consoleAPICalled', onLog); // the assertions log too
  return {
    arg: args.at(-1),
    getProperties: (objectId) => post('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true }),
  };
}

/** As the server will: dig, then render. */
async function dug(t, value, limits) {
  const { arg, getProperties } = await logged(t, value);
  const { value: runtimeValue, requests } = await C.digRuntimeValue(arg, getProperties, limits ?? { depth: 4, keys: 30, samples: 10, requests: 80, leading: true });
  return { runtimeValue, requests, arg };
}

const ROWS = Array.from({ length: 150 }, (_, i) => ({
  id: i,
  title: `Sensor ${i}`,
  owner: { id: 7, name: 'ops', team: { id: 1, code: 'X' } },
  tags: ['alarm', 'live'],
}));

test('an array of objects reads as objects, not as [Object, Object, …]', async (t) => {
  const { runtimeValue } = await dug(t, ROWS);
  const inline = C.formatRuntimeValueInline(runtimeValue);
  assert.doesNotMatch(inline, /\bObject\b/, inline);
  assert.match(inline, /^\[\{id: 0, title: 'Sensor 0', owner: \{id: 7, name: 'ops', team: \{…\}\}, tags: \['alarm', 'live'\]\}/, inline);
  assert.match(inline, /…\+\d+\]$/, inline); // whatever didn't fit is counted, and the bracket closes
  assert.ok(inline.length <= 200, `${inline.length} characters`);

  const pretty = C.formatRuntimeValuePretty(runtimeValue);
  // Every level that was dug shows; a short one stays on one line, as Node's inspect keeps it.
  assert.match(pretty, /^\[\n  \{\n    id: 0,\n    title: 'Sensor 0',\n    owner: \{id: 7, name: 'ops', team: \{id: 1, code: 'X'\}\},\n    tags: \['alarm', 'live'\]\n  \}/, pretty);
  assert.doesNotMatch(pretty, /\{…\}|\[…\]/, pretty);
});

test('the hover lays out every element it lists, not just the few a dig samples', async (t) => {
  const value = { items: Array.from({ length: 12 }, (_, i) => ({ id: i, meta: { k: i } })) };
  const { runtimeValue } = await dug(t, value, { depth: 4, keys: 30, samples: 10, requests: 80, leading: true });
  const pretty = C.formatRuntimeValuePretty(runtimeValue);
  for (let i = 0; i < 10; i++) assert.match(pretty, new RegExp(`\\{id: ${i}, meta: \\{k: ${i}\\}\\}`), pretty);
  assert.match(pretty, /…\+2\n  \]/, pretty);
});

test('the JSON rendering parses, keeps the values, and says where it stopped', async (t) => {
  const { runtimeValue } = await dug(t, ROWS, { depth: 4, keys: 30, samples: 10, requests: 60 });
  const parsed = JSON.parse(C.formatRuntimeValueJson(runtimeValue));
  assert.strictEqual(parsed.length, 150, 'every element the runtime listed');
  // Sampled elements were dug all the way; the rest keep the preview the runtime sent with them.
  assert.deepStrictEqual(parsed[0], { id: 0, title: 'Sensor 0', owner: { id: 7, name: 'ops', team: { id: 1, code: 'X' } }, tags: ['alarm', 'live'] });
  assert.deepStrictEqual(parsed[1], { id: 1, title: 'Sensor 1', owner: '[not expanded]', tags: '[not expanded]' });
});

test('what JSON cannot hold becomes a string, and nothing ever runs a getter', async (t) => {
  let ran = 0;
  const value = {
    fn: function load(a, b) { return a + b; },
    arrow: (x) => x,
    when: new Date(0),
    re: /ab+/g,
    map: new Map([['a', 1]]),
    nothing: null,
    missing: undefined,
    get computed() { ran++; return 1; },
  };
  const { runtimeValue } = await dug(t, value);
  const parsed = JSON.parse(C.formatRuntimeValueJson(runtimeValue));
  assert.strictEqual(ran, 0, 'a getter must never be evaluated');
  assert.strictEqual(parsed.fn, '[Function: load]');
  assert.strictEqual(parsed.arrow, '[Function]');
  assert.match(parsed.when, /1970/);
  assert.strictEqual(parsed.re, '/ab+/g');
  assert.strictEqual(parsed.map, 'Map(1)');
  assert.strictEqual(parsed.nothing, null);
  assert.strictEqual(parsed.missing, 'undefined');
  assert.strictEqual(parsed.computed, '[getter]');
  const inline = C.formatRuntimeValueInline(runtimeValue);
  assert.match(inline, /^\{fn: \[Function: load\], arrow: \[Function\]/, inline);
  assert.match(C.formatRuntimeValuePretty(runtimeValue), /computed: \[getter\]/);
});

test('a cycle ends at the depth limit — V8 gives no identity to recognise it by', async (t) => {
  const root = { name: 'root', child: { label: 'c' } };
  root.self = root;
  root.child.parent = root;
  const { runtimeValue, requests } = await dug(t, root, { depth: 3, keys: 30, samples: 10, requests: 20 });
  // Measured: the same object comes back with a new objectId per reference, so the dig cannot tell
  // `root.self` from another object. The budget and the depth are what keep it finite.
  assert.ok(requests <= 20, `${requests} requests`);
  const parsed = JSON.parse(C.formatRuntimeValueJson(runtimeValue, { ...C.JSON_VALUE_LIMITS, depth: 3 }));
  assert.strictEqual(parsed.child.label, 'c');
  assert.strictEqual(parsed.self.self.name, 'root', 'it just repeats');
  assert.strictEqual(parsed.self.self.self, '[not expanded]', 'and stops at the depth limit');
});

test('a value that was never dug still shows its first level, and says the rest is not expanded', async (t) => {
  const { arg } = await logged(t, { id: 1, nested: { deep: true }, list: [1, 2, 3] });
  const undugValue = { object: arg }; // straight off the log, as when the rate limit skipped it
  assert.strictEqual(C.formatRuntimeValueInline(undugValue), "{id: 1, nested: {…}, list: […]}");
  const parsed = JSON.parse(C.formatRuntimeValueJson(undugValue));
  assert.deepStrictEqual(parsed, { id: 1, nested: '[not expanded]', list: '[not expanded]' });
});

test('long strings are cut per rendering, and the JSON stays parseable', async (t) => {
  const { runtimeValue } = await dug(t, { note: 'x'.repeat(5000) });
  assert.match(C.formatRuntimeValueInline(runtimeValue), /^\{note: 'x{40}…'\}$/);
  assert.strictEqual(JSON.parse(C.formatRuntimeValueJson(runtimeValue)).note.length, 5000);
  assert.strictEqual(JSON.parse(C.formatRuntimeValueJson(runtimeValue, { ...C.JSON_VALUE_LIMITS, maxString: 10 })).note, 'xxxxxxxxxx…');
});

test('a huge value is reduced until its JSON fits, never cut into broken JSON', async (t) => {
  const { runtimeValue } = await dug(t, ROWS, { depth: 4, keys: 30, samples: 200, requests: 400 });
  const json = C.formatRuntimeValueJson(runtimeValue, { ...C.JSON_VALUE_LIMITS, maxLength: 2000 });
  assert.ok(json.length <= 2000, `${json.length} characters`);
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed) && parsed.length > 1);
  assert.match(String(parsed.at(-1)), /more/);
});

test('$$hashKey and other Angular noise never appears', async (t) => {
  const { runtimeValue } = await dug(t, [{ $$hashKey: 'object:3', id: 1 }]);
  assert.strictEqual(C.formatRuntimeValueInline(runtimeValue), '[{id: 1}]');
});

test('a string argument prints as text; a string inside a value keeps its quotes', async (t) => {
  const { arg: label } = await logged(t, 'rows');
  const { runtimeValue } = await dug(t, [{ title: 'Sensor 0' }]);
  const args = [{ object: label }, runtimeValue];
  assert.strictEqual(C.formatRuntimeArgsInline(args, ' '), "rows [{title: 'Sensor 0'}]");
  assert.strictEqual(C.formatRuntimeArgsPretty(args).split('\n')[0], 'rows');
  // A logpoint's parts carry their own spacing, so they join with nothing.
  assert.strictEqual(C.formatRuntimeArgsInline([{ object: label }, { object: label }], ''), 'rowsrows');
});

test('a label ending in = or : stays on the line of the value it names, so the hover colors it as an object', async (t) => {
  const { arg: label } = await logged(t, 'version = ');
  const { runtimeValue } = await dug(t, { versionNo: 2, note: 'Re-chunked' });
  const text = C.formatRuntimeArgsPretty([{ object: label }, runtimeValue]);
  assert.strictEqual(text, "version = {\n  versionNo: 2,\n  note: 'Re-chunked'\n}");
  // A string that names nothing still stands apart from the value after it.
  const { arg: plain } = await logged(t, 'loaded');
  assert.match(C.formatRuntimeArgsPretty([{ object: plain }, runtimeValue]), /^loaded\n\n\{/);
});

test('the Values panel tree: names from labels, kinds for coloring, class names, and JSON on every leaf', async (t) => {
  class Doc {
    constructor() {
      this.id = 'DOC-1';
      this.versionNo = 2;
      this.active = false;
      this.error = null;
      this.tags = ['a', 'b', 'c'];
      this.load = function load() {};
    }
  }
  const { arg: label } = await logged(t, 'doc = ');
  const { runtimeValue } = await dug(t, new Doc());
  const roots = C.formatRuntimeArgsTree([{ object: label }, runtimeValue]);
  assert.strictEqual(roots.length, 1, 'the label names the value instead of being a node');
  const [doc] = roots;
  assert.strictEqual(doc.name, 'doc');
  assert.strictEqual(doc.kind, 'object');
  assert.strictEqual(doc.type, 'Doc');
  const byName = Object.fromEntries(doc.children.map((c) => [c.name, c]));
  assert.deepStrictEqual(
    [byName.id.kind, byName.versionNo.kind, byName.active.kind, byName.error.kind, byName.load.kind],
    ['string', 'number', 'boolean', 'null', 'function'],
  );
  assert.strictEqual(byName.id.json, 'DOC-1');
  assert.strictEqual(byName.versionNo.json, 2);
  assert.strictEqual(byName.tags.type, 'Array(3)');
  assert.deepStrictEqual(byName.tags.children.map((c) => [c.name, c.json]), [['0', 'a'], ['1', 'b'], ['2', 'c']]);
  assert.match(doc.text, /^\{id: 'DOC-1', versionNo: 2/);
});

test('the Values panel tree: arguments without a label are named by position, and what was cut says how much', async (t) => {
  const { runtimeValue } = await dug(t, ROWS, { depth: 2, keys: 30, samples: 10, requests: 60 });
  const [rows] = C.formatRuntimeArgsTree([runtimeValue], { ...C.JSON_VALUE_LIMITS, items: 5 });
  assert.strictEqual(rows.name, 'arg0');
  assert.strictEqual(rows.type, 'Array(150)');
  assert.strictEqual(rows.children.length, 6);
  assert.deepStrictEqual(rows.children.at(-1), { name: '…', kind: 'more', text: '145 more not shown' });
});
