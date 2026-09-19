/**
 * observed-types-r1 ticket 03 (core half): digging a logged value with a budget, against real V8
 * through `node:inspector`, and the per-connection evidence store — .scratch/observed-types-r1/spec.md
 * decisions #3, #6.
 */
const test = require('node:test');
const assert = require('node:assert');
const inspector = require('node:inspector');
const C = require('../dist');

/** Log `value` through the real console and hand back its CDP argument plus a counting `getProperties`. */
async function logged(t, value) {
  const session = new inspector.Session();
  session.connect();
  t.after(() => session.disconnect());
  const post = (method, params) => new Promise((resolve) => session.post(method, params, (err, res) => resolve(err ? null : res)));
  const args = [];
  session.on('Runtime.consoleAPICalled', (m) => args.push(m.params.args[0]));
  await post('Runtime.enable');
  console.debug(value);
  await new Promise((r) => setImmediate(r));
  const calls = [];
  const getProperties = (objectId) => {
    calls.push(objectId);
    return post('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
  };
  return { arg: args.at(-1), getProperties, calls };
}

const typeText = (value) => C.formatType(C.typeOfRuntimeValue(value));

test('an array of objects: dug to the hover depth, elements sampled, within 12 requests', async (t) => {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: i,
    name: 'n',
    owner: { id: 1, name: 'x', address: { city: 'c' } },
    tags: ['a'],
  }));
  const { arg, getProperties, calls } = await logged(t, rows);
  const { value, requests } = await C.digRuntimeValue(arg, getProperties);
  assert.strictEqual(requests, calls.length);
  assert.ok(requests <= 12, `${requests} requests`);
  assert.strictEqual(typeText(value), '{ id: number, name: string, owner: { id: number, name: string, address: {…} }, tags: string[] }[]');
});

test('a wide, deep object stops at the budget; what is left undug reads as incomplete, never wrong', async (t) => {
  const wide = {};
  for (let i = 0; i < 20; i++) wide[`k${i}`] = { a: 1, b: { c: 2 } };
  const { arg, getProperties, calls } = await logged(t, wide);
  const { value, requests } = await C.digRuntimeValue(arg, getProperties, { ...C.DIG_LIMITS, requests: 4 });
  assert.strictEqual(requests, 4);
  assert.strictEqual(calls.length, 4);
  const type = C.typeOfRuntimeValue(value);
  const top = type.variants[0];
  assert.strictEqual(top.props.size, 20, 'the top level was dug: every key');
  assert.strictEqual(top.open, undefined);
  // 4 requests: the top, then k0..k2 — the rest keep the preview they came with, one level shallower.
  assert.strictEqual(C.formatType(C.typeAtPath(type, ['k0'])), '{ a: number, b: { c: number } }');
  assert.strictEqual(C.formatType(C.typeAtPath(type, ['k19'])), '{ a: number, b: {…} }');
});

test('built-ins, primitives and null are never dug', async (t) => {
  for (const v of [new Date(0), 'text', 42, null, [1, 2, 3]]) {
    const { arg, getProperties, calls } = await logged(t, v);
    await C.digRuntimeValue(arg, getProperties);
    assert.strictEqual(calls.length, Array.isArray(v) ? 1 : 0, String(v));
  }
});

test('a runtime that does not answer leaves the preview, and nothing throws', async (t) => {
  const { arg } = await logged(t, { a: 1 });
  for (const getProperties of [async () => null, async () => ({ result: 'nope' }), async () => { throw new Error('gone'); }]) {
    const { value } = await C.digRuntimeValue(arg, getProperties);
    assert.strictEqual(typeText(value), '{ a: number }');
  }
});

const site = (start) => ({ path: 'list.js', span: { start, end: start + 3 } });
const num = { variants: [{ kind: 'primitive', primitive: 'number' }], nullable: false, partial: false };
const str = { variants: [{ kind: 'primitive', primitive: 'string' }], nullable: false, partial: false };

test('store: one piece per distinct type; the same type again only counts', () => {
  const store = new C.RuntimeEvidenceStore('Chrome — localhost:9222');
  const target = { owner: 'ListCtrl', path: ['count'] };
  assert.ok(store.claim('a', 0));
  store.record('a', target, num, site(10), 0);
  assert.ok(store.claim('b', 1));
  store.record('b', target, num, site(20), 1);
  assert.ok(store.claim('c', 2));
  store.record('c', target, str, site(30), 2);
  const ev = store.forMember('ListCtrl', 'count');
  assert.deepStrictEqual(ev.map((e) => [C.formatType(e.type), e.count, e.lastSeen, e.source, e.connection]), [
    ['number', 2, 1, 'runtime', 'Chrome — localhost:9222'],
    ['string', 1, 2, 'runtime', 'Chrome — localhost:9222'],
  ]);
  assert.strictEqual(store.size, 2);
  assert.deepStrictEqual(store.forMember('OtherCtrl', 'count'), []);
});

test('store: a place logging again within 30 s is counted without digging — even while the first dig runs', () => {
  const store = new C.RuntimeEvidenceStore('x');
  const target = { owner: 'C', path: ['rows'] };
  assert.strictEqual(store.claim('p', 0), true);
  assert.strictEqual(store.claim('p', 5), false, 'dig still in flight: counted as pending');
  store.record('p', target, num, site(1), 10);
  assert.strictEqual(store.forMember('C', 'rows')[0].count, 2);
  assert.strictEqual(store.claim('p', 29_999), false);
  assert.strictEqual(store.forMember('C', 'rows')[0].count, 3);
  assert.strictEqual(store.forMember('C', 'rows')[0].lastSeen, 29_999);
  assert.strictEqual(store.claim('p', 30_000), true, 'dug again after 30 s');
});

test('store: at most 20 types per variable and 2000 in all, dropping the least recently seen', () => {
  const store = new C.RuntimeEvidenceStore('x', { perVariable: 2, total: 3, redigAfterMs: 30_000 });
  const typeWithKey = (k) => ({ variants: [{ kind: 'object', props: new Map([[k, { type: num, optional: false }]]) }], nullable: false, partial: false });
  const put = (member, key, now) => {
    store.claim(`${member}${key}${now}`, now);
    store.record(`${member}${key}${now}`, { owner: 'C', path: [member] }, typeWithKey(key), site(now), now);
  };
  put('a', 'x', 1);
  put('a', 'y', 2);
  put('a', 'z', 3); // evicts a:x — per variable
  assert.deepStrictEqual(store.forMember('C', 'a').map((e) => [...e.type.variants[0].props.keys()][0]), ['y', 'z']);
  put('b', 'x', 4);
  put('c', 'x', 5); // total 3: evicts a:y, the oldest anywhere
  assert.strictEqual(store.size, 3);
  assert.deepStrictEqual(store.forMember('C', 'a').map((e) => [...e.type.variants[0].props.keys()][0]), ['z']);
  store.clear();
  assert.strictEqual(store.size, 0);
  assert.deepStrictEqual(store.forMember('C', 'b'), []);
});

test('store: keys inside a member count as evidence about the member', () => {
  const store = new C.RuntimeEvidenceStore('x');
  store.claim('p', 0);
  store.record('p', { owner: 'C', path: ['form', 'owner'] }, num, site(0), 0);
  assert.deepStrictEqual(store.forMember('C', 'form').map((e) => e.path), [['form', 'owner']]);
});
