/**
 * Showing a logged value (.scratch/expand-log-values/spec.md): a CDP preview carries one level
 * only, so an object inside one reads `[Object]` and an array of objects reads
 * `[Object, Object, …]`. Given a value dug with `digRuntimeValue`, these render it three ways —
 * one line for the decoration beside the code, several lines for the hover, and valid JSON for the
 * tab that opens on "Show full value". Pure: a dug value in, text out.
 */
import type { ObjectPreview, PropertyPreview, RemoteObject } from './runtime-log';
import type { RuntimeProperty, RuntimeValue } from './runtime-shape';

export interface FormatValueLimits {
  /** Levels of nesting rendered before `{…}`. */
  depth: number;
  /** Keys per object. */
  keys: number;
  /** Elements per array. */
  items: number;
  /** Characters of a single string value. */
  maxString: number;
  /** Characters of the whole rendering. */
  maxLength: number;
}

/** Beside the code: one line, short enough to read next to what it annotates (spec #1). */
export const INLINE_VALUE_LIMITS: FormatValueLimits = { depth: 2, keys: 6, items: 6, maxString: 40, maxLength: 200 };
/** In the hover: several lines, still a glance rather than a document (spec #2). */
export const HOVER_VALUE_LIMITS: FormatValueLimits = { depth: 3, keys: 30, items: 10, maxString: 200, maxLength: 8192 };
/** In the JSON tab: everything, within reason (spec #3). */
export const JSON_VALUE_LIMITS: FormatValueLimits = { depth: 6, keys: 50, items: 200, maxString: 10_000, maxLength: 2_000_000 };

/** What a value renders to, before it is written out in one style or another. */
type Node =
  | { kind: 'scalar'; text: string; json: unknown }
  | { kind: 'object'; entries: Array<[string, Node]>; more: number }
  | { kind: 'array'; items: Node[]; more: number };

const scalar = (text: string, json: unknown = text): Node => ({ kind: 'scalar', text, json });
/** A branch the dig never reached — not the same as an empty one (spec #1). */
const unexpanded = (array: boolean): Node => ({ kind: 'scalar', text: array ? '[…]' : '{…}', json: '[not expanded]' });

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const NOISE = (name: string): boolean => name.startsWith('$$') || name === '__proto__';

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `function load(a, b) {…}` → `[Function: load]`; an anonymous or arrow function → `[Function]`. */
function functionText(description: string | undefined): string {
  const named = description ? /^\s*(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(description) : null;
  return named ? `[Function: ${named[1]}]` : '[Function]';
}

/** A built-in shown by what the runtime says it is: `Map(3)`, a date's text, `/ab/g`. */
function describedText(o: RemoteObject): string {
  return o.description ?? o.className ?? o.subtype ?? 'object';
}

interface Ctx {
  limits: FormatValueLimits;
  /**
   * Object ids seen on the path from the root. Only catches a repeat of the SAME `RemoteObject`:
   * measured, V8 hands out a fresh objectId for every reference to one object (`…1.1`, `…1.2`), so
   * `a.self = a` cannot be recognised by identity without asking the runtime, which would cost a
   * call per ancestor per node. What stops a cycle is the depth limit, and it renders `{…}`.
   */
  seen: Set<string>;
}

/** The value, as far as it was dug. Never runs a getter; never follows a cycle. */
function nodeOf(value: RuntimeValue, depth: number, ctx: Ctx): Node {
  const o = value.object;
  switch (o.type) {
    case 'string':
      return scalar(`'${cut(String(o.value ?? o.description ?? ''), ctx.limits.maxString)}'`, cut(String(o.value ?? ''), ctx.limits.maxString));
    case 'number': {
      // NaN and Infinity arrive without a `value`, and have no JSON form.
      const text = o.value !== undefined ? String(o.value) : (o.description ?? 'NaN');
      return scalar(text, o.value !== undefined ? (o.value as number) : text);
    }
    case 'boolean':
      return scalar(String(o.value), o.value as boolean);
    case 'undefined':
      return scalar('undefined', 'undefined');
    case 'function':
      return scalar(functionText(o.description));
    case 'bigint':
    case 'symbol':
      return scalar(o.description ?? o.type);
    case 'object': {
      if (o.subtype === 'null') return scalar('null', null);
      if (o.objectId !== undefined && ctx.seen.has(o.objectId)) return scalar('[Circular]');
      if (o.subtype !== undefined && o.subtype !== 'array') return scalar(describedText(o));
      const isArray = o.subtype === 'array';
      if (depth > ctx.limits.depth) return unexpanded(isArray);
      const seen = o.objectId !== undefined ? new Set([...ctx.seen, o.objectId]) : ctx.seen;
      const inner: Ctx = { ...ctx, seen };
      if (value.properties) return fromProperties(value.properties, isArray, depth, inner);
      if (o.preview) return fromPreview(o.preview, isArray, depth, inner);
      return unexpanded(isArray);
    }
    default:
      return scalar(o.description ?? o.type);
  }
}

function fromProperties(properties: RuntimeProperty[], isArray: boolean, depth: number, ctx: Ctx): Node {
  const usable = properties.filter((p) => p.enumerable !== false && !NOISE(p.name));
  if (isArray) {
    const elements = usable.filter((p) => /^\d+$/.test(p.name));
    const shown = elements.slice(0, ctx.limits.items);
    return {
      kind: 'array',
      items: shown.map((p) => (p.accessor ? scalar('[getter]') : p.value ? nodeOf(p.value, depth + 1, ctx) : unexpanded(false))),
      more: elements.length - shown.length,
    };
  }
  const shown = usable.slice(0, ctx.limits.keys);
  return {
    kind: 'object',
    entries: shown.map((p) => [p.name, p.accessor ? scalar('[getter]') : p.value ? nodeOf(p.value, depth + 1, ctx) : unexpanded(false)] as [string, Node]),
    more: usable.length - shown.length,
  };
}

/** A value that wasn't dug: its preview knows one level, and says when it was cut short. */
function fromPreview(preview: ObjectPreview, isArray: boolean, depth: number, ctx: Ctx): Node {
  const properties = Array.isArray(preview.properties) ? preview.properties.filter((p) => p && typeof p.name === 'string' && !NOISE(p.name)) : [];
  const overflow = preview.overflow ? 1 : 0;
  if (isArray) {
    const shown = properties.slice(0, ctx.limits.items);
    return { kind: 'array', items: shown.map((p) => nodeOfPreviewProperty(p, depth, ctx)), more: properties.length - shown.length + overflow };
  }
  const shown = properties.slice(0, ctx.limits.keys);
  return {
    kind: 'object',
    entries: shown.map((p) => [p.name, nodeOfPreviewProperty(p, depth, ctx)] as [string, Node]),
    more: properties.length - shown.length + overflow,
  };
}

function nodeOfPreviewProperty(p: PropertyPreview, depth: number, ctx: Ctx): Node {
  switch (p.type) {
    case 'accessor':
      return scalar('[getter]');
    case 'string':
      return scalar(`'${cut(p.value ?? '', ctx.limits.maxString)}'`, cut(p.value ?? '', ctx.limits.maxString));
    case 'number':
      return scalar(p.value ?? 'NaN', Number.isFinite(Number(p.value)) ? Number(p.value) : (p.value ?? 'NaN'));
    case 'boolean':
      return scalar(p.value ?? 'false', p.value === 'true');
    case 'undefined':
      return scalar('undefined', 'undefined');
    case 'function':
      return scalar(functionText(p.value));
    case 'object': {
      if (p.subtype === 'null') return scalar('null', null);
      if (p.subtype !== undefined && p.subtype !== 'array') return scalar(p.value ?? p.subtype);
      const isArray = p.subtype === 'array';
      if (depth + 1 > ctx.limits.depth) return unexpanded(isArray);
      // A preview's own nested previews are rare (V8 gives none for a console arg), so this is
      // usually where a value that was never dug stops.
      return p.valuePreview ? fromPreview(p.valuePreview, isArray, depth + 1, ctx) : unexpanded(isArray);
    }
    default:
      return scalar(p.value ?? p.type);
  }
}

const node = (value: RuntimeValue, limits: FormatValueLimits): Node => nodeOf(value, 1, { limits, seen: new Set() });

/**
 * One line for the decoration beside the code: `[{id: 0, title: 'Sensor 0', owner: {…}}, …+149]`.
 * The length limit is spent from the outside in — whatever doesn't fit is counted in the trailing
 * `…+N`, so the reader still learns how much was left out.
 */
export function formatRuntimeValueInline(value: RuntimeValue, limits: FormatValueLimits = INLINE_VALUE_LIMITS): string {
  const n = node(value, limits);
  // The `…+N` tails are written after their own budget check, so a deeply nested value can still
  // come out a few characters long: spend a little less until it fits, rather than cut the tail off.
  for (let budget = limits.maxLength; budget > 20; budget -= 16) {
    const text = writeCompact(n, { left: budget });
    if (text.length <= limits.maxLength) return text;
  }
  return cut(writeCompact(n, { left: 20 }), limits.maxLength);
}

/** Several lines for the hover — the same compact style, laid out. */
export function formatRuntimeValuePretty(value: RuntimeValue, limits: FormatValueLimits = HOVER_VALUE_LIMITS): string {
  return cut(writeIndented(node(value, limits), ''), limits.maxLength);
}

/**
 * A console call's arguments, the way a console prints them: a string argument on its own is text,
 * not a quoted string, while a string INSIDE a value keeps its quotes. `separator` is the one the
 * call itself used — a space for `console.log(a, b)`, nothing for a logpoint's message parts.
 */
export function formatRuntimeArgsInline(values: RuntimeValue[], separator: string, limits: FormatValueLimits = INLINE_VALUE_LIMITS): string {
  const share = { ...limits, maxLength: Math.max(40, Math.floor(limits.maxLength / Math.max(1, values.length))) };
  return cut(values.map((v) => bareString(v) ?? formatRuntimeValueInline(v, share)).join(separator), limits.maxLength);
}

/** The same arguments for a hover: each on its own, laid out, blank line between them. */
export function formatRuntimeArgsPretty(values: RuntimeValue[], limits: FormatValueLimits = HOVER_VALUE_LIMITS): string {
  return cut(values.map((v) => bareString(v) ?? formatRuntimeValuePretty(v, limits)).join('\n\n'), limits.maxLength);
}

/** A top-level string argument, as text. `null` for anything else. */
function bareString(value: RuntimeValue): string | null {
  return value.object.type === 'string' ? String(value.object.value ?? value.object.description ?? '') : null;
}

/**
 * Valid JSON for the tab that opens on "Show full value" — so VS Code's own folding, search and
 * copy work on it. What JSON can't hold becomes a string: `"[Function: f]"`, `"[Circular]"`,
 * `"[getter]"`, `"undefined"`, `"[not expanded]"`.
 */
export function formatRuntimeValueJson(value: RuntimeValue, limits: FormatValueLimits = JSON_VALUE_LIMITS): string {
  let current = limits;
  for (;;) {
    const text = JSON.stringify(toJson(node(value, current)), null, 2) ?? 'null';
    if (text.length <= limits.maxLength || current.items <= 1) return cut(text, limits.maxLength);
    // Too big: keep the shape, show fewer elements, rather than hand back broken JSON.
    current = { ...current, items: Math.floor(current.items / 4), keys: Math.max(5, Math.floor(current.keys / 2)) };
  }
}

/**
 * Compact text, stopping when `budget.left` runs out: the parts that did not fit join the `…+N`
 * at the end of their own object or array, so the brackets always close.
 */
function writeCompact(n: Node, budget: { left: number }): string {
  if (n.kind === 'scalar') {
    budget.left -= n.text.length;
    return n.text;
  }
  const items = n.kind === 'array' ? n.items : n.entries;
  const [open, close] = n.kind === 'array' ? ['[', ']'] : ['{', '}'];
  budget.left -= 2;
  const parts: string[] = [];
  let dropped = n.more;
  for (let i = 0; i < items.length; i++) {
    // Room for at least `…+N` plus what encloses this: stop while the tail still fits.
    if (budget.left <= 8 && i > 0) {
      dropped += items.length - i;
      break;
    }
    if (i > 0) budget.left -= 2;
    const item = items[i]!;
    parts.push(n.kind === 'array' ? writeCompact(item as Node, budget) : writeEntry(item as [string, Node], budget));
  }
  if (dropped > 0) parts.push(`…+${dropped}`);
  return `${open}${parts.join(', ')}${close}`;
}

function writeEntry([key, value]: [string, Node], budget: { left: number }): string {
  const name = IDENTIFIER.test(key) ? key : `'${key}'`;
  budget.left -= name.length + 2;
  return `${name}: ${writeCompact(value, budget)}`;
}

function writeIndented(n: Node, indent: string): string {
  const inner = `${indent}  `;
  if (n.kind === 'scalar') return n.text;
  if (n.kind === 'array') {
    if (!n.items.length) return n.more > 0 ? `[…+${n.more}]` : '[]';
    const parts = n.items.map((item) => `${inner}${writeIndented(item, inner)}`);
    if (n.more > 0) parts.push(`${inner}…+${n.more}`);
    return `[\n${parts.join(',\n')}\n${indent}]`;
  }
  if (!n.entries.length) return n.more > 0 ? `{…+${n.more}}` : '{}';
  const parts = n.entries.map(([key, v]) => `${inner}${IDENTIFIER.test(key) ? key : `'${key}'`}: ${writeIndented(v, inner)}`);
  if (n.more > 0) parts.push(`${inner}…+${n.more}`);
  return `{\n${parts.join(',\n')}\n${indent}}`;
}

function toJson(n: Node): unknown {
  if (n.kind === 'scalar') return n.json;
  if (n.kind === 'array') {
    const items = n.items.map(toJson);
    if (n.more > 0) items.push(`[…+${n.more} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of n.entries) out[key] = toJson(v);
  if (n.more > 0) out['…'] = `[+${n.more} more]`;
  return out;
}
