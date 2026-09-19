import type { FileFacts, ScopeFrame, Span, ValueShape } from '../types';
import { walk, type Expr } from '../ng/ast';
import { tryParseExpression } from '../ng/parser';
import { aliasOf, controllerOf, findLocal } from './rows';
import { nearestRows } from './rename';
import { expressionAt, inSpan } from './workspace';

/**
 * Observed Type — what a template variable has been seen to hold, merged from every piece of
 * evidence about it (.scratch/observed-types/spec.md). v1 only has static evidence: the
 * assignments `JsFacts.scopeWrites` recorded. Runtime evidence plugs into the same model later.
 *
 * Pure: evidence in, type and text out. Picking WHICH assignments are evidence (the controller,
 * the nearest copy, the member under the cursor) is the caller's job.
 */

/** One piece of evidence about a variable's type (spec decision #8). */
export interface TypeEvidence {
  source: 'static' | 'runtime';
  /** The part of the variable it describes: `['form']`, or `['form', 'extra']` for a nested assignment. */
  path: string[];
  /** Shapes the value was seen/inferred as — null/undefined excluded, see `nullable`. */
  shapes: ValueShape[];
  nullable: boolean;
  /** Static: the assignment it comes from. */
  site?: { path: string; span: Span };
  /** Static: the right side's text, to explain an unknown shape. */
  rhsText?: string;
  /** Static: the left side as written, and where a logpoint would run right after it (`ScopeWrite`). */
  lhsText?: string;
  after?: number;
  /** Static: the assignment only runs in a callback, not when the controller is constructed. */
  inCallback?: boolean;
  /**
   * Runtime: the type read off the logged value (`runtime-shape.ts`), merged in alongside `shapes`.
   * A type rather than a `ValueShape`: a value can hold arrays of mixed elements, objects known to
   * be incomplete, `Record`s — none of which the index's `ValueShape` (persisted, walked by
   * completion) should have to carry. Runtime evidence is never cached, so it needn't serialize.
   */
  type?: ObservedType;
  /** Runtime: the connection it was observed on. */
  connection?: string;
  count: number;
  lastSeen?: number;
}

/** A merged type: a union of variants, one per distinct kind, plus whether it can be null/undefined. */
export interface ObservedType {
  variants: Variant[];
  nullable: boolean;
  /** Some evidence had an unknown shape, dropped because another one was known. */
  partial: boolean;
}

export type Variant =
  /**
   * `open`: seen only in part — a truncated runtime preview — so a key missing from it proves
   * nothing and must not turn optional when merged (observed-types-r1 decision #4).
   */
  | { kind: 'object'; props: Map<string, { type: ObservedType; optional: boolean }>; open?: boolean }
  | { kind: 'array'; element: ObservedType }
  | { kind: 'function'; params: string[] }
  | { kind: 'primitive'; primitive?: string }
  /** A built-in object shown by its class, never walked into: `Date`, `Map`, `Promise`. */
  | { kind: 'named'; name: string }
  /** An object used as a dictionary — its keys are data, so only its values' type is kept. */
  | { kind: 'record'; value: ObservedType }
  | { kind: 'unknown' };

const EMPTY = (): ObservedType => ({ variants: [], nullable: false, partial: false });

/** The type of one shape, on its own. */
export function fromShape(shape: ValueShape): ObservedType {
  switch (shape.kind) {
    case 'primitive':
      if (shape.primitive === 'null' || shape.primitive === 'undefined') return { ...EMPTY(), nullable: true };
      return { ...EMPTY(), variants: [{ kind: 'primitive', ...(shape.primitive ? { primitive: shape.primitive } : {}) }] };
    case 'object': {
      const props = new Map<string, { type: ObservedType; optional: boolean }>();
      for (const [key, value] of Object.entries(shape.props ?? {})) props.set(key, { type: fromShape(value), optional: false });
      return { ...EMPTY(), variants: [{ kind: 'object', props }] };
    }
    case 'array':
      return { ...EMPTY(), variants: [{ kind: 'array', element: fromShape(shape.element ?? { kind: 'unknown' }) }] };
    case 'function':
      return { ...EMPTY(), variants: [{ kind: 'function', params: shape.params ?? [] }] };
    default:
      return { ...EMPTY(), variants: [{ kind: 'unknown' }] };
  }
}

/**
 * Merge two types (spec decision #4): the same kind merges into one — objects key by key, a key
 * missing from either side becoming optional — and different kinds stay a union. An unknown next
 * to anything known is dropped, leaving `partial` set so the hover can say so.
 */
export function mergeTypes(a: ObservedType, b: ObservedType): ObservedType {
  const out: ObservedType = { variants: [], nullable: a.nullable || b.nullable, partial: a.partial || b.partial };
  for (const v of [...a.variants, ...b.variants]) {
    const same = out.variants.findIndex((w) => variantKey(w) === variantKey(v));
    if (same === -1) out.variants.push(v);
    else out.variants[same] = mergeVariants(out.variants[same]!, v);
  }
  if (out.variants.length > 1 && out.variants.some((v) => v.kind === 'unknown')) {
    out.variants = out.variants.filter((v) => v.kind !== 'unknown');
    out.partial = true;
  }
  return out;
}

function variantKey(v: Variant): string {
  if (v.kind === 'primitive') return `primitive:${v.primitive ?? '?'}`;
  if (v.kind === 'named') return `named:${v.name}`;
  return v.kind;
}

function mergeVariants(a: Variant, b: Variant): Variant {
  if (a.kind === 'object' && b.kind === 'object') {
    const props = new Map<string, { type: ObservedType; optional: boolean }>();
    for (const key of new Set([...a.props.keys(), ...b.props.keys()])) {
      const x = a.props.get(key);
      const y = b.props.get(key);
      if (x && y) props.set(key, { type: mergeTypes(x.type, y.type), optional: x.optional || y.optional });
      // Missing from one side makes a key optional only if that side lists every key it has.
      else if (x) props.set(key, { type: x.type, optional: x.optional || !b.open });
      else props.set(key, { type: y!.type, optional: y!.optional || !a.open });
    }
    // One complete side is enough to know the whole key set.
    return a.open && b.open ? { kind: 'object', props, open: true } : { kind: 'object', props };
  }
  if (a.kind === 'array' && b.kind === 'array') return { kind: 'array', element: mergeTypes(a.element, b.element) };
  if (a.kind === 'record' && b.kind === 'record') return { kind: 'record', value: mergeTypes(a.value, b.value) };
  return a; // functions, primitives of the same kind, unknowns: nothing more to learn from the second
}

/**
 * The type of `path[0]` on a scope, built from its assignments: each whole assignment
 * (`$scope.form = …`, `path.length === 1`) is merged in; each nested one (`$scope.form.extra = …`)
 * adds its key — optional, since it wasn't there at every point — to the object at that path.
 */
export function typeFromEvidence(writes: Array<Pick<TypeEvidence, 'path' | 'shapes' | 'nullable' | 'type'>>): ObservedType {
  let type = EMPTY();
  for (const w of writes.filter((x) => x.path.length === 1)) type = mergeTypes(type, writeType(w));
  for (const w of writes.filter((x) => x.path.length > 1)) type = withNestedKey(type, w.path.slice(1), writeType(w));
  return type;
}

function writeType(w: Pick<TypeEvidence, 'shapes' | 'nullable' | 'type'>): ObservedType {
  let t: ObservedType = { ...EMPTY(), nullable: w.nullable };
  for (const s of w.shapes) t = mergeTypes(t, fromShape(s));
  if (w.type) t = mergeTypes(t, w.type);
  return t;
}

function withNestedKey(type: ObservedType, path: string[], value: ObservedType): ObservedType {
  const [key, ...rest] = path;
  if (!key) return type;
  const variants = [...type.variants];
  let idx = variants.findIndex((v) => v.kind === 'object');
  if (idx === -1) {
    // Assigning `x.key = …` proves x is an object even if no whole assignment said so.
    variants.push({ kind: 'object', props: new Map() });
    idx = variants.length - 1;
  }
  const obj = variants[idx] as Extract<Variant, { kind: 'object' }>;
  const props = new Map(obj.props);
  const existing = props.get(key);
  const inner = rest.length ? withNestedKey(existing?.type ?? EMPTY(), rest, value) : mergeTypes(existing?.type ?? EMPTY(), value);
  props.set(key, { type: inner, optional: existing ? existing.optional : true });
  variants[idx] = { kind: 'object', props };
  // A key assigned onto it proves it's an object: an unknown whole assignment no longer hides that.
  const hadUnknown = variants.some((v) => v.kind === 'unknown');
  return { ...type, variants: variants.filter((v) => v.kind !== 'unknown'), partial: type.partial || hadUnknown };
}

/** Step along a property path; through arrays into their element, like Shape Walking. `null` when a key isn't known. */
export function typeAtPath(type: ObservedType, path: string[]): ObservedType | null {
  let cur: ObservedType = type;
  for (const seg of path) {
    let next: ObservedType | null = null;
    for (const v of cur.variants) {
      const holders = v.kind === 'array' ? v.element.variants : [v];
      for (const holder of holders) {
        // A dictionary has every key; its value type is what any of them holds.
        const found = holder.kind === 'object' ? holder.props.get(seg)?.type : holder.kind === 'record' ? holder.value : undefined;
        if (!found) continue;
        // An optional key is NOT nullable: only an explicit null counts (spec decision #3).
        next = next ? mergeTypes(next, found) : found;
      }
    }
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** The element type of an array type (for an `ng-repeat` item), or `null` when it isn't one. */
export function elementType(type: ObservedType): ObservedType | null {
  const arrays = type.variants.filter((v): v is Extract<Variant, { kind: 'array' }> => v.kind === 'array');
  if (!arrays.length) return null;
  return arrays.map((a) => a.element).reduce(mergeTypes);
}

export interface FormatLimits {
  /** Levels of object nesting shown before `{…}`. */
  depth: number;
  /** Keys shown per object before `…+N`. */
  keys: number;
}

/** The spec's hover limits (decision #4): 2 levels, 8 keys. */
export const HOVER_LIMITS: FormatLimits = { depth: 2, keys: 8 };

/** TypeScript-like text: `{ id: number, tags?: string[] } | null`. `null` when nothing at all is known. */
export function formatType(type: ObservedType, limits: FormatLimits = HOVER_LIMITS): string | null {
  const known = type.variants.filter((v) => v.kind !== 'unknown');
  if (!known.length && !type.nullable) return null;
  const parts = type.variants.map((v) => formatVariant(v, limits, 1));
  if (type.nullable) parts.push('null');
  return parts.join(' | ');
}

function formatVariant(v: Variant, limits: FormatLimits, level: number): string {
  switch (v.kind) {
    case 'primitive':
      return v.primitive ?? 'primitive';
    case 'function':
      return `(${v.params.join(', ')}) => …`;
    case 'unknown':
      return 'unknown';
    case 'named':
      return v.name;
    case 'record':
      return `Record<string, ${formatNested(v.value, limits, level + 1)}>`;
    case 'array': {
      const inner = formatNested(v.element, limits, level);
      return /[|\s]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'object': {
      if (level > limits.depth) return '{…}';
      const entries = [...v.props.entries()];
      if (!entries.length) return v.open ? '{…}' : '{}';
      const shown = entries
        .slice(0, limits.keys)
        .map(([key, p]) => `${key}${p.optional ? '?' : ''}: ${formatNested(p.type, limits, level + 1)}`);
      if (entries.length > limits.keys) shown.push(`…+${entries.length - limits.keys}`);
      // Only part of it was seen: say so rather than pass the listed keys off as all of them.
      else if (v.open) shown.push('…');
      return `{ ${shown.join(', ')} }`;
    }
  }
}

function formatNested(type: ObservedType, limits: FormatLimits, level: number): string {
  const parts = type.variants.map((v) => formatVariant(v, limits, level));
  if (type.nullable) parts.push('null');
  return parts.length ? parts.join(' | ') : 'unknown';
}

// ---------------------------------------------------------------- query

/** What `observedTypeOf` needs from Workspace. */
export interface ObservedTypeSource {
  facts(relPath: string): FileFacts | null;
  jsPaths(): string[];
  /** Runtime evidence about `member` on `owner`'s scope, from every live connection (observed-types-r1). */
  runtimeEvidence?(owner: string, member: string): TypeEvidence[];
}

/** Runtime evidence behind a type, per connection — the hover's "Seen at runtime" line. */
export interface RuntimeSighting {
  connection: string;
  count: number;
  lastSeen: number;
  /** The log that last showed it. */
  site: { path: string; span: Span };
}

export interface ObservedTypeResult {
  /** The expression described, as written: `vm.form.name`, `row`. */
  expression: string;
  /** TypeScript-like text within the hover limits, or `null` when nothing is known. */
  text: string | null;
  /**
   * Some assignment explicitly sets it to null/undefined (spec decision #3). Static only: what a
   * runtime happened to log never makes it here, so the inline hint stays put (r1 decision #9).
   */
  nullable: boolean;
  /** Some evidence couldn't be inferred and was left out of `text`. */
  partial: boolean;
  /** Every assignment feeding it runs in a callback — nothing is there at the first render. */
  onlyInCallback: boolean;
  /** Up to 5 assignments that feed it, from the nearest copy of the controller. */
  sites: Array<{ path: string; span: Span; inCallback: boolean }>;
  /**
   * The assignments whose value couldn't be inferred — what a hover names instead of a bare
   * "unknown". `after`/`lhsText`: where and what to log to find out (log-variable spec #3, #4).
   */
  unknownFrom: Array<{ path: string; span: Span; rhsText: string; lhsText?: string; after?: number }>;
  /** Runtime evidence merged into `text`, one per connection, most recently seen first, at most 3. */
  runtime: RuntimeSighting[];
  /** A runtime log showed `null`/`undefined` where no assignment says so — hover only (r1 decision #9). */
  seenNullAtRuntime: boolean;
}

const MAX_SITES = 5;
const MAX_RUNTIME_SIGHTINGS = 3;

/**
 * The observed type of `memberPath` on `controller`'s scope (`['form', 'name']`), as seen from
 * `from` — only the copy of the controller nearest `from` counts (spec decision #5). With
 * `elementPath`, the member is an array and the result describes `elementPath` on one element
 * (an `ng-repeat` item).
 */
export function observedTypeOf(
  src: ObservedTypeSource,
  from: string,
  controller: string,
  memberPath: string[],
  expression: string,
  elementPath?: string[],
): ObservedTypeResult | null {
  const member = memberPath[0];
  if (!member) return null;

  const all: TypeEvidence[] = [];
  for (const path of src.jsPaths()) {
    const facts = src.facts(path);
    if (facts?.kind !== 'js') continue;
    for (const w of facts.scopeWrites ?? []) {
      if (w.owner !== controller || w.path[0] !== member) continue;
      all.push({
        source: 'static',
        path: w.path,
        shapes: w.shapes,
        nullable: w.nullable,
        site: { path, span: w.span },
        rhsText: w.rhsText,
        lhsText: w.lhsText,
        ...(w.after !== undefined ? { after: w.after } : {}),
        inCallback: w.inCallback,
        count: 1,
      });
    }
  }
  // Runtime evidence was logged inside the controller's own body, so its site says which copy it's from.
  all.push(...(src.runtimeEvidence?.(controller, member) ?? []).filter((e) => e.site));
  const evidence = nearestRows(from, all.map((e) => ({ ...e, path: e.site!.path, evidence: e }))).map((r) => r.evidence);
  if (!evidence.length) return null;
  const statics = evidence.filter((e) => e.source === 'static');
  const runtimes = evidence.filter((e) => e.source === 'runtime');

  const at = (pieces: TypeEvidence[]): ObservedType | null => {
    if (!pieces.length) return null;
    let t: ObservedType | null = typeAtPath(typeFromEvidence(pieces), memberPath.slice(1));
    if (t && elementPath) {
      t = elementType(t);
      if (t) t = typeAtPath(t, elementPath);
    }
    return t;
  };
  const type = at(evidence);
  const staticType = runtimes.length ? at(statics) : type;

  // Evidence about the target itself or an object containing it — not about a sibling key.
  const covers = (e: TypeEvidence) => e.path.length <= memberPath.length && e.path.every((seg, i) => memberPath[i] === seg);
  const relevant = statics.filter(covers);
  const sites = relevant.map((e) => ({ path: e.site!.path, span: e.site!.span, inCallback: !!e.inCallback }));
  // Runtime: also a log of a key inside the target (`vm.form.owner` for `vm.form`) — it told us about it.
  const seen = runtimes.filter((e) => covers(e) || memberPath.every((seg, i) => e.path[i] === seg));
  return {
    expression,
    text: type ? formatType(type) : null,
    nullable: staticType?.nullable ?? false,
    partial: type?.partial ?? false,
    onlyInCallback: sites.length > 0 && sites.every((s) => s.inCallback),
    sites: sites.slice(0, MAX_SITES),
    unknownFrom: relevant
      .filter((e) => e.shapes.some((sh) => sh.kind === 'unknown'))
      .map((e) => ({
        path: e.site!.path,
        span: e.site!.span,
        rhsText: e.rhsText ?? '',
        ...(e.lhsText !== undefined ? { lhsText: e.lhsText } : {}),
        ...(e.after !== undefined ? { after: e.after } : {}),
      })),
    runtime: sightings(seen),
    seenNullAtRuntime: seen.length > 0 && !!at(runtimes)?.nullable && !(staticType?.nullable ?? false),
  };
}

function sightings(evidence: TypeEvidence[]): RuntimeSighting[] {
  const byConnection = new Map<string, RuntimeSighting>();
  for (const e of evidence) {
    const connection = e.connection ?? '';
    const cur = byConnection.get(connection);
    const lastSeen = e.lastSeen ?? 0;
    if (!cur) byConnection.set(connection, { connection, count: e.count, lastSeen, site: e.site! });
    else {
      cur.count += e.count;
      if (lastSeen > cur.lastSeen) Object.assign(cur, { lastSeen, site: e.site! });
    }
  }
  return [...byConnection.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_RUNTIME_SIGHTINGS);
}

/**
 * The observed type of the template variable at `offset`: a scope member (`rows`, `vm.rows`), a
 * key inside one (`vm.form.name` — up to the segment under the cursor), or an `ng-repeat` item
 * (`row`, `row.id`). In a JS file: the property assigned by a `$scope.x = …` / `this.x = …` under
 * the cursor (`x`, or `extra` in `$scope.form.extra = …`), merged over every assignment to it.
 * `null` when the cursor isn't on one, or nothing assigns it.
 */
export function observedTypeAt(src: ObservedTypeSource, relPath: string, offset: number): ObservedTypeResult | null {
  const facts = src.facts(relPath);
  if (facts?.kind === 'js') {
    const write = facts.scopeWrites?.find((w) => inSpan(w.span, offset));
    return write ? observedTypeOf(src, relPath, write.owner, write.path, write.path.join('.')) : null;
  }
  if (facts?.kind !== 'template') return null;
  const hit = expressionAt(facts, offset);
  if (!hit) return null;

  const segs = segmentsOf(hit.node);
  if (!segs.length) return null;
  const at = segs.findIndex((sg) => inSpan(sg.span, offset));
  if (at === -1) return null; // on a computed key, a call's parentheses… — not a variable we can name
  return typeOfNames(src, relPath, hit.expr.scopeChain, segs.slice(0, at + 1).map((sg) => sg.name));
}

/**
 * `names` (`['vm', 'form', 'name']`) read in a template under `chain`: member, key inside one, or
 * `ng-repeat` item. `memo` caches by what is looked up, for a caller asking about many variables.
 */
function typeOfNames(
  src: ObservedTypeSource,
  relPath: string,
  chain: ScopeFrame[],
  names: string[],
  memo?: Map<string, ObservedTypeResult | null>,
): ObservedTypeResult | null {
  const expression = names.join('.');
  const query = (controller: string, memberPath: string[], elementPath?: string[]) => {
    if (!memo) return observedTypeOf(src, relPath, controller, memberPath, expression, elementPath);
    const key = [controller, memberPath.join('.'), elementPath?.join('.') ?? '\0'].join('\n');
    if (!memo.has(key)) memo.set(key, observedTypeOf(src, relPath, controller, memberPath, expression, elementPath));
    const hit = memo.get(key)!;
    return hit && { ...hit, expression };
  };
  const controller = controllerOf(chain);
  if (!controller) return null;
  const alias = aliasOf(chain);
  const unalias = (path: string[]) => (alias && path[0] === alias ? path.slice(1) : path);

  const local = findLocal(names[0]!, chain);
  if (local) {
    if (!local.collection) return null; // ng-init and friends: out of scope for v1
    const collection = unalias([local.collection.root, ...local.collection.path]);
    return query(controller, collection, names.slice(1));
  }
  return query(controller, unalias(names));
}

/** Where a template can be empty when rendered: after the variable that is `nullable` (spec decision #2). */
export interface NullableHint {
  /** End of the variable's last identifier — where the hint goes. */
  offset: number;
  /** The variable as written: `user`, `vm.user`, `state.user`. */
  expression: string;
}

/**
 * Every place in a template's Angular expressions where a variable can be empty when rendered
 * (spec decisions #2, #3): for each property chain (`vm.user.name`), the first prefix whose
 * observed type is `nullable` — explicitly assigned null/undefined somewhere. One hint per
 * variable per expression. Only in callbacks, unknown, not nullable: no hint. EJS locals aren't
 * Angular expressions, so they never get one. `range`: only expressions overlapping it.
 */
export function nullableHints(src: ObservedTypeSource, relPath: string, range?: Span): NullableHint[] {
  const facts = src.facts(relPath);
  if (facts?.kind !== 'template') return [];
  const out: NullableHint[] = [];
  const memo = new Map<string, ObservedTypeResult | null>();
  for (const expr of facts.expressions) {
    if (range && (expr.span.end < range.start || expr.span.start > range.end)) continue;
    const program = tryParseExpression(expr.text, expr.span.start);
    if (!program) continue;
    const seen = new Set<string>();
    for (const top of chainTops(program)) {
      const segs = segmentsOf(top);
      for (let i = 0; i < segs.length; i++) {
        const names = segs.slice(0, i + 1).map((sg) => sg.name);
        const t = typeOfNames(src, relPath, expr.scopeChain, names, memo);
        if (!t) {
          if (i === 0) continue; // `vm` of `vm.user`: the alias itself has no type, its members do
          break;
        }
        if (!t.nullable) continue;
        if (!seen.has(t.expression)) {
          seen.add(t.expression);
          out.push({ offset: segs[i]!.span.end, expression: t.expression });
        }
        break;
      }
    }
  }
  return out;
}

/** The outermost property chains of an expression: `a.b.c` once, not also `a.b` and `a`. */
function chainTops(program: Parameters<typeof walk>[0]): Expr[] {
  const nodes: Expr[] = [];
  const objects = new Set<Expr>();
  walk(program, (n) => {
    if (n.type === 'MemberExpression') {
      nodes.push(n);
      objects.add(n.object);
    } else if (n.type === 'Identifier') nodes.push(n);
  });
  return nodes.filter((n) => !objects.has(n));
}

/** `vm.form.name` -> the identifiers `vm`, `form`, `name` with their spans; stops at a computed key. */
function segmentsOf(node: Expr): Array<{ name: string; span: Span }> {
  const segs: Array<{ name: string; span: Span }> = [];
  let cur: Expr = node;
  for (;;) {
    if (cur.type === 'CallExpression') {
      cur = cur.callee;
      continue;
    }
    if (cur.type === 'MemberExpression') {
      if (cur.computed || cur.property.type !== 'Identifier') segs.length = 0; // `a[b].c`: only `a` is addressable
      else segs.unshift({ name: cur.property.name, span: cur.property.span });
      cur = cur.object;
      continue;
    }
    break;
  }
  if (cur.type !== 'Identifier') return [];
  segs.unshift({ name: cur.name, span: cur.span });
  return segs;
}
