/**
 * observed-types-r1 ticket 01: the type of a logged value, from CDP `RemoteObject`s and
 * `Runtime.getProperties` results captured from real V8 (fixtures/v8-console-args.json) —
 * .scratch/observed-types-r1/spec.md decisions #4, #5.
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist');
const { cases } = require('./fixtures/v8-console-args.json');

/**
 * A fixture case as the server would hand it over: the console arg alone (`preview`), or dug —
 * its own properties, plus one more level for the properties the capture dug into.
 */
function value(name, { dug = false } = {}) {
  const c = cases[name];
  const v = { object: c.arg };
  if (!dug) return v;
  v.properties = C.runtimeProperties(c.props).map((p) =>
    c.children?.[p.name] && p.value ? { ...p, value: { ...p.value, properties: C.runtimeProperties(c.children[p.name]) } } : p,
  );
  return v;
}

const text = (v) => C.formatType(C.typeOfRuntimeValue(v), { depth: 3, keys: 20 });

test('primitives are typed; null and undefined are nullable with no variant', () => {
  assert.strictEqual(text(value('str')), 'string');
  assert.strictEqual(text(value('num')), 'number');
  assert.strictEqual(text(value('bool')), 'boolean');
  for (const name of ['nul', 'undef']) {
    const t = C.typeOfRuntimeValue(value(name));
    assert.deepStrictEqual([t.variants, t.nullable], [[], true], name);
  }
});

test('functions keep their parameter names; built-ins show by class', () => {
  assert.strictEqual(text(value('fn')), '(a, b) => …');
  assert.strictEqual(text(value('arrow')), '(x) => …');
  assert.strictEqual(text(value('arrowMany')), '(a, {…}, c) => …');
  assert.strictEqual(text(value('date')), 'Date');
  assert.deepStrictEqual(C.paramsOf('x => x'), ['x']);
  assert.deepStrictEqual(C.paramsOf('class Foo {}'), []);
  assert.deepStrictEqual(C.paramsOf('function (...rest) {}'), ['...rest']);
});

test('a preview cut at 5 keys is an open object: its keys, then … — never passed off as complete', () => {
  const preview = C.typeOfRuntimeValue(value('big'));
  assert.strictEqual(C.formatType(preview), '{ k0: number, k1: number, k2: number, k3: number, k4: number, … }');
  // Dug: all 12 keys, complete.
  assert.strictEqual(text(value('big', { dug: true })), `{ ${Array.from({ length: 12 }, (_, i) => `k${i}: number`).join(', ')} }`);
});

test('an open object merged with a complete one: keys it lacks do not turn optional', () => {
  const open = C.typeOfRuntimeValue(value('big'));
  const full = C.typeOfRuntimeValue(value('big', { dug: true }));
  const merged = C.mergeTypes(open, full);
  const obj = merged.variants[0];
  assert.strictEqual(obj.open, undefined, 'one complete side makes the merge complete');
  assert.deepStrictEqual([...obj.props.values()].filter((p) => p.optional), []);
  // Two open ones stay open, still nothing optional.
  const both = C.mergeTypes(open, open).variants[0];
  assert.strictEqual(both.open, true);
  assert.deepStrictEqual([...both.props.values()].filter((p) => p.optional), []);
  // A complete object missing a key the other complete one has: optional, as in v1.
  const a = C.typeOfRuntimeValue({ object: { type: 'object' }, properties: [{ name: 'id', value: { object: { type: 'number' } } }] });
  const b = C.typeOfRuntimeValue({
    object: { type: 'object' },
    properties: [
      { name: 'id', value: { object: { type: 'number' } } },
      { name: 'extra', value: { object: { type: 'string' } } },
    ],
  });
  assert.strictEqual(C.formatType(C.mergeTypes(a, b)), '{ id: number, extra?: string }');
});

test('an array of objects: the console preview knows no element keys, the dug elements do', () => {
  // Measured: V8 gives array elements no nested preview in a console arg.
  assert.strictEqual(text(value('rows')), '{…}[]');
  // Dug: element 0..2 are complete (dug one level more), 74 and 149 carry a 5-key preview.
  assert.strictEqual(
    text(value('rows', { dug: true })),
    '{ id: number, name: string, owner: { id: number, name: string }, tags: string[], a: number, b: number }[]',
  );
});

test('getters are never run and never listed; $$hashKey is dropped; non-enumerable length is not a key', () => {
  assert.strictEqual(text(value('getter', { dug: true })), '{ id: number }');
  assert.strictEqual(text(value('getter')), '{ id: number }');
  assert.strictEqual(text(value('hashKey', { dug: true })), '{ id: number, name: string }');
  assert.strictEqual(text(value('hashKey')), '{ id: number, name: string }');
  assert.strictEqual(text(value('primitives', { dug: true })), '(number | string | null)[]');
});

test('a dictionary becomes Record<string, T>: e-mail keys, or more than 50 keys', () => {
  assert.strictEqual(text(value('dict', { dug: true })), 'Record<string, { id: number }>');
  assert.strictEqual(text(value('dict')), 'Record<string, {…}>');
  assert.strictEqual(text(value('wide', { dug: true })), 'Record<string, number>');
  // A record is walkable by any key.
  const t = C.typeAtPath(C.typeOfRuntimeValue(value('dict', { dug: true })), ['anything', 'id']);
  assert.strictEqual(C.formatType(t), 'number');
});

test('a nested object without a preview is open and empty; one level dug shows the next preview; {} is {}', () => {
  assert.strictEqual(text(value('nested')), '{ a: {…}, list: unknown[] }');
  assert.strictEqual(text(value('nested', { dug: true })), '{ a: { b: { c: number } }, list: number[] }');
  assert.strictEqual(text(value('empty', { dug: true })), '{}');
});

test('the signature ignores key order, and tells apart what the hover would', () => {
  const t1 = C.typeOfRuntimeValue({ object: { type: 'object' }, properties: [
    { name: 'a', value: { object: { type: 'number' } } },
    { name: 'b', value: { object: { type: 'string' } } },
  ] });
  const t2 = C.typeOfRuntimeValue({ object: { type: 'object' }, properties: [
    { name: 'b', value: { object: { type: 'string' } } },
    { name: 'a', value: { object: { type: 'number' } } },
  ] });
  assert.strictEqual(C.typeSignature(t1), C.typeSignature(t2));
  assert.notStrictEqual(C.typeSignature(t1), C.typeSignature(C.typeOfRuntimeValue(value('big'))));
  assert.notStrictEqual(C.typeSignature(C.typeOfRuntimeValue(value('big'))), C.typeSignature(C.typeOfRuntimeValue(value('big', { dug: true }))));
});

test('runtime evidence carries a type that merges with static shapes', () => {
  const t = C.typeFromEvidence([
    { path: ['rows'], shapes: [{ kind: 'array', element: { kind: 'object', props: { id: { kind: 'primitive', primitive: 'number' } } } }], nullable: false },
    { path: ['rows'], shapes: [], nullable: false, type: C.typeOfRuntimeValue(value('rows', { dug: true })) },
  ]);
  assert.strictEqual(
    C.formatType(t),
    '{ id: number, name?: string, owner?: { id: number, name: string }, tags?: string[], a?: number, b?: number }[]',
  );
});

test('malformed descriptors from the runtime are dropped, never thrown on', () => {
  assert.deepStrictEqual(C.runtimeProperties(null), []);
  assert.deepStrictEqual(C.runtimeProperties([null, 1, { name: 2 }, { name: 'x', value: 'nope' }]), [{ name: 'x' }]);
  assert.doesNotThrow(() => C.typeOfRuntimeValue({ object: { type: 'object', preview: { overflow: false, properties: [null, { name: 'a' }] } } }));
});
