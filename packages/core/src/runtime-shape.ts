/**
 * The type of a logged value — the pure half of runtime Type Evidence
 * (.scratch/observed-types-r1/spec.md, decisions #4 and #5). A console argument arrives as a CDP
 * `RemoteObject` whose preview is shallow and cut short (5 keys per object, no keys at all for a
 * nested object or an array element — measured, see the spec); the server digs further with
 * `Runtime.getProperties` and hands the result here as a `RuntimeValue` tree. No IO, and never a
 * value kept: only its type comes out.
 */
import type { ObjectPreview, PropertyPreview, RemoteObject } from './runtime-log';
import { mergeTypes, type ObservedType, type Variant } from './resolve/observed-type';

/** A logged value, with the own properties the server dug out of it (when it did). */
export interface RuntimeValue {
  object: RemoteObject;
  /** From `Runtime.getProperties({ownProperties: true})` — absent when this value wasn't dug into. */
  properties?: RuntimeProperty[];
}

export interface RuntimeProperty {
  name: string;
  /** Absent for an accessor: its getter is never run, so its value is never known. */
  value?: RuntimeValue;
  accessor?: boolean;
  /** `false` for `length` of an array and other non-enumerable own properties. */
  enumerable?: boolean;
}

/** Past this many keys an object is taken for a dictionary (decision #5). */
const MAX_RECORD_KEYS = 50;

/** CDP subtypes shown by their class name rather than walked into. */
const NAMED_SUBTYPES: Record<string, string> = {
  date: 'Date',
  regexp: 'RegExp',
  map: 'Map',
  set: 'Set',
  weakmap: 'WeakMap',
  weakset: 'WeakSet',
  promise: 'Promise',
  error: 'Error',
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const empty = (): ObservedType => ({ variants: [], nullable: false, partial: false });
const one = (v: Variant): ObservedType => ({ variants: [v], nullable: false, partial: false });
const nullable = (): ObservedType => ({ variants: [], nullable: true, partial: false });

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isRemoteObject(v: unknown): v is RemoteObject {
  return isRecordObject(v) && typeof v.type === 'string';
}

/**
 * The own properties `Runtime.getProperties` returned, as `RuntimeProperty`s — descriptors that
 * aren't well-formed are dropped: the runtime is a network peer. Children are not dug here; the
 * caller attaches `properties` to the values it digs further into.
 */
export function runtimeProperties(descriptors: unknown): RuntimeProperty[] {
  if (!Array.isArray(descriptors)) return [];
  const out: RuntimeProperty[] = [];
  for (const d of descriptors) {
    if (!isRecordObject(d) || typeof d.name !== 'string') continue;
    const prop: RuntimeProperty = { name: d.name };
    if (d.get !== undefined || d.set !== undefined) prop.accessor = true;
    else if (isRemoteObject(d.value)) prop.value = { object: d.value };
    if (d.enumerable === false) prop.enumerable = false;
    out.push(prop);
  }
  return out;
}

/** The type of a logged value. `null` and `undefined` come out as `nullable` with no variant. */
export function typeOfRuntimeValue(value: RuntimeValue): ObservedType {
  const o = value.object;
  switch (o.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return one({ kind: 'primitive', primitive: o.type });
    case 'undefined':
      return nullable();
    case 'function':
      return one({ kind: 'function', params: paramsOf(o.description) });
    case 'object':
      if (o.subtype === 'null') return nullable();
      if (o.subtype === 'array') return arrayType(value);
      if (o.subtype) return one({ kind: 'named', name: NAMED_SUBTYPES[o.subtype] ?? o.className ?? o.subtype });
      return objectType(value);
    default:
      // bigint, symbol: a value, but not one a template shows by a TypeScript-like name.
      return one({ kind: 'primitive' });
  }
}

/** Keys that are never data of the developer's: Angular's own `$$hashKey`, `$$phase`… and `__proto__`. */
function isNoiseKey(name: string): boolean {
  return name.startsWith('$$') || name === '__proto__';
}

function objectType(value: RuntimeValue): ObservedType {
  let entries: Array<[string, ObservedType]>;
  let open: boolean;
  if (value.properties) {
    entries = value.properties
      .filter((p) => p.enumerable !== false && !p.accessor && !isNoiseKey(p.name))
      .map((p) => [p.name, p.value ? typeOfRuntimeValue(p.value) : empty()]);
    open = false;
  } else if (value.object.preview) {
    entries = previewEntries(value.object.preview);
    open = value.object.preview.overflow;
  } else {
    // Seen as an object, nothing more.
    return one({ kind: 'object', props: new Map(), open: true });
  }
  return objectFromEntries(entries, open);
}

function objectFromEntries(entries: Array<[string, ObservedType]>, open: boolean): ObservedType {
  // A dictionary's keys are data (ids, e-mails): listing them is noise, and can leak (decision #5).
  if (entries.length > MAX_RECORD_KEYS || entries.some(([name]) => !IDENTIFIER.test(name))) {
    return one({ kind: 'record', value: entries.map(([, t]) => t).reduce(mergeTypes, empty()) });
  }
  const props = new Map(entries.map(([name, type]) => [name, { type, optional: false }]));
  return one(open ? { kind: 'object', props, open: true } : { kind: 'object', props });
}

function arrayType(value: RuntimeValue): ObservedType {
  const elements: ObservedType[] = value.properties
    ? value.properties
        .filter((p) => /^\d+$/.test(p.name))
        .map((p) => (p.value ? typeOfRuntimeValue(p.value) : empty()))
    : value.object.preview
      ? previewEntries(value.object.preview).map(([, t]) => t)
      : [];
  return one({ kind: 'array', element: elements.reduce(mergeTypes, empty()) });
}

/** Keys of a preview, accessors and noise dropped. */
function previewEntries(preview: ObjectPreview): Array<[string, ObservedType]> {
  if (!Array.isArray(preview.properties)) return [];
  const out: Array<[string, ObservedType]> = [];
  for (const p of preview.properties) {
    if (!isRecordObject(p) || typeof p.name !== 'string' || p.type === 'accessor' || isNoiseKey(p.name)) continue;
    out.push([p.name, typeOfPreviewProperty(p)]);
  }
  return out;
}

/** A property inside a preview: a type name, a short text value, and a nested preview only sometimes. */
function typeOfPreviewProperty(p: PropertyPreview): ObservedType {
  switch (p.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return one({ kind: 'primitive', primitive: p.type });
    case 'undefined':
      return nullable();
    case 'function':
      return one({ kind: 'function', params: [] });
    case 'object': {
      if (p.subtype === 'null') return nullable();
      if (p.subtype === 'array') {
        const element = p.valuePreview ? previewEntries(p.valuePreview).map(([, t]) => t).reduce(mergeTypes, empty()) : empty();
        return one({ kind: 'array', element });
      }
      if (p.subtype) return one({ kind: 'named', name: NAMED_SUBTYPES[p.subtype] ?? p.value ?? p.subtype });
      if (!p.valuePreview) return one({ kind: 'object', props: new Map(), open: true });
      return objectFromEntries(previewEntries(p.valuePreview), p.valuePreview.overflow);
    }
    default:
      return one({ kind: 'primitive' });
  }
}

/**
 * Parameter names from a function's source text as V8 describes it: `function load(a, b) {…}`,
 * `(x) => x`, `x => x`, `async (a, { b }, c = 1) => a`. A destructured parameter shows as `{…}` /
 * `[…]`, a default is dropped. Anything else (a class, native code) → no parameters.
 */
export function paramsOf(description: string | undefined): string[] {
  if (!description) return [];
  const single = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(description);
  if (single) return [single[1]!];
  const open = /^\s*(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*|[\w$]+\s*)?\(/.exec(description);
  if (!open) return [];
  const params: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = open[0].length; i < description.length; i++) {
    const ch = description[i]!;
    if (depth === 0 && (ch === ',' || ch === ')')) {
      if (current.trim()) params.push(paramName(current));
      current = '';
      if (ch === ')') return params;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    current += ch;
  }
  return []; // never closed: not a parameter list after all
}

function paramName(text: string): string {
  const t = text.trim();
  if (t.startsWith('{')) return '{…}';
  if (t.startsWith('[')) return '[…]';
  const m = /^(\.\.\.)?\s*([A-Za-z_$][\w$]*)/.exec(t);
  return m ? `${m[1] ?? ''}${m[2]}` : '_';
}

/**
 * A stable text for a type, the same whatever order keys arrived in — what the server dedupes
 * evidence by (decision #6). Not for display: no limits, no `…`.
 */
export function typeSignature(type: ObservedType): string {
  const parts = type.variants.map(variantSignature).sort();
  if (type.nullable) parts.push('null');
  return parts.join('|');
}

function variantSignature(v: Variant): string {
  switch (v.kind) {
    case 'primitive':
      return v.primitive ?? 'primitive';
    case 'function':
      return `fn(${v.params.length})`;
    case 'named':
      return `@${v.name}`;
    case 'unknown':
      return '?';
    case 'array':
      return `[${typeSignature(v.element)}]`;
    case 'record':
      return `rec<${typeSignature(v.value)}>`;
    case 'object': {
      const keys = [...v.props.keys()].sort().map((k) => {
        const p = v.props.get(k)!;
        return `${k}${p.optional ? '?' : ''}:${typeSignature(p.type)}`;
      });
      return `{${keys.join(',')}${v.open ? ',…' : ''}}`;
    }
  }
}
