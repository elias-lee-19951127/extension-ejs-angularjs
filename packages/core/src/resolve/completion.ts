import type { Config, JsFacts, NgDeclaration, ScopeFrame, ScopeMember, TemplateFacts, ValueShape } from '../types';
import type { SymbolRow } from '../index/store';
import { extractTemplate } from '../extract/template';
import { jsMemberContextAt, serviceShapeIn } from '../extract/js';
import { unwind } from '../ng/ast';
import { BUILTIN_FILTERS, denormalize, normalizeDirectiveName } from '../ng/normalize';
import { factsToRows, findLocal } from './rows';
import { nearestRows } from './rename';
import { type FactSource, shapeAtPath } from './shape';
import { expressionAt, inSpan } from './workspace';

/**
 * Completion in templates and in JS files (.scratch/template-completion/spec.md). Pure over what
 * the index knows: no type system, only what the code assigns and the shapes of its object
 * literals — the same ground go-to-definition stands on.
 */

export interface CompletionEntry {
  name: string;
  kind: 'variable' | 'property' | 'method' | 'alias' | 'filter' | 'component' | 'directive' | 'binding' | 'service';
  detail: string;
  /** What to insert instead of `name`, in snippet syntax (`pick($1)`, `data="$1"`). */
  snippet?: string;
  /** Orders the list: nearer scopes first (spec #11). */
  sortText?: string;
}

/** What completion reads from the Workspace, nothing more. */
export interface CompletionSource extends FactSource {
  config: Config;
  symbolsOfKind(kind: string): SymbolRow[];
  membersOf(controllerName: string, from?: string): SymbolRow[];
  bindTemplate(relPath: string, facts: TemplateFacts): TemplateFacts;
  templateBinding(relPath: string): { controller: string; alias: string | null } | null;
}

/** Placeholder identifier put at the cursor so an expression still being typed parses. */
const CURSOR = '__ejsngCursor__';

// ---------------------------------------------------------------------------------------------
// Scope chain
// ---------------------------------------------------------------------------------------------

/**
 * The controller frames of a scope chain, nearest first, as AngularJS inherits them: every
 * enclosing controller, up to (not past) an isolate scope (spec #1).
 */
export function controllerFrames(chain: ScopeFrame[]): Array<ScopeFrame & { controllerName: string }> {
  const out: Array<ScopeFrame & { controllerName: string }> = [];
  for (const f of chain) {
    if (f.kind === 'controller' && f.controllerName) out.push(f as ScopeFrame & { controllerName: string });
    if (f.kind === 'isolate') break;
  }
  return out;
}

/**
 * The scope member a row stands for, in its file's current facts. A file open with unsaved edits
 * has facts from the buffer but rows from the index (the file as last saved), so when the span no
 * longer lines up the member is found by name and owner instead.
 */
function memberOf(src: FactSource, row: SymbolRow): ScopeMember | null {
  const facts = src.facts(row.path);
  if (facts?.kind !== 'js') return null;
  return (
    facts.scopeMembers.find((m) => m.span.start === row.span.start && m.name === row.name) ??
    facts.scopeMembers.find((m) => m.name === row.name && m.owner === row.container) ??
    null
  );
}

/** How a scope member was assigned — `$scope.x` or `this.x`. */
function viaOf(src: FactSource, row: SymbolRow): '$scope' | 'this' | null {
  return memberOf(src, row)?.via ?? null;
}

/** The shape a scope member's first assignment inferred. */
function shapeOf(src: FactSource, row: SymbolRow): ValueShape | null {
  return memberOf(src, row)?.shape ?? null;
}

/**
 * The frame whose scope holds `name` bare — the nearest one that assigns it, skipping `this.`
 * members of a controller-as frame, which are not on the scope (spec #3). `null` when none does.
 */
export function frameHolding(
  src: FactSource,
  name: string,
  frames: Array<ScopeFrame & { controllerName: string }>,
): (ScopeFrame & { controllerName: string }) | null {
  for (const f of frames) {
    const rows = src.findSymbols(name, f.controllerName).filter((r) => r.kind === 'scope-member');
    if (rows.some((r) => !f.alias || viaOf(src, r) !== 'this')) return f;
  }
  return null;
}

/** The Angular declaration a symbol row stands for, read from its file's facts. */
function declOf(src: CompletionSource, row: SymbolRow): NgDeclaration | null {
  const facts = src.facts(row.path);
  if (facts?.kind !== 'js') return null;
  return (
    facts.declarations.find((d) => d.name === row.name && d.nameSpan.start === row.span.start) ??
    facts.declarations.find((d) => d.name === row.name && d.kind === row.kind) ??
    null
  );
}

/** Component/directive bindings published on a controller (`bindings: { user: '<' }`) (spec #4). */
function bindingsOf(src: CompletionSource, controller: string): Array<{ name: string; mode: string; owner: string }> {
  const out: Array<{ name: string; mode: string; owner: string }> = [];
  const decls = [...src.symbolsOfKind('component'), ...src.symbolsOfKind('directive')];
  for (const row of decls) {
    const decl = declOf(src, row);
    const bindings = decl?.ddo?.scopeBindings;
    if (!decl || !bindings) continue;
    if (decl.name !== controller && decl.ddo?.controllerName !== controller) continue;
    for (const [name, mode] of Object.entries(bindings)) out.push({ name, mode, owner: decl.name });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------

function memberEntry(name: string, shape: ValueShape | null | undefined, detail: string, sortText: string, call: boolean): CompletionEntry {
  if (shape?.kind === 'function') {
    const params = shape.params ?? [];
    return {
      name,
      kind: 'method',
      detail: `${detail} — (${params.join(', ')})`,
      ...(call ? { snippet: params.length ? `${name}($1)` : `${name}()` } : {}),
      sortText,
    };
  }
  return { name, kind: 'property', detail, sortText };
}

function dedupe(entries: CompletionEntry[]): CompletionEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => !e.name.includes(CURSOR) && (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

/**
 * The keys under `path` on a controller's scope: those of the shape its first assignment
 * inferred, plus every nested assignment (`$scope.form.extra = …`) (spec #9).
 */
function keysAt(src: CompletionSource, from: string, controller: string, path: string[], call: boolean): CompletionEntry[] {
  const [head, ...rest] = path;
  if (head === undefined) return [];
  const out: CompletionEntry[] = [];
  const rows = nearestRows(from, src.findSymbols(head, controller).filter((r) => r.kind === 'scope-member'));
  const label = path.join('.');
  for (const row of rows) {
    const shape = shapeAtPath(shapeOf(src, row) ?? undefined, rest);
    const obj = shape?.kind === 'array' ? shape.element : shape;
    if (obj?.kind === 'object') {
      for (const [name, prop] of Object.entries(obj.props ?? {})) {
        out.push(memberEntry(name, prop, `key of ${label} (${prop.kind})`, '1', call));
      }
    }
  }
  for (const file of new Set(rows.map((r) => r.path))) {
    const facts = src.facts(file);
    if (facts?.kind !== 'js') continue;
    for (const w of facts.scopeWrites) {
      if (w.owner !== controller || w.path.length !== path.length + 1) continue;
      if (!path.every((seg, i) => w.path[i] === seg)) continue;
      out.push(memberEntry(w.path.at(-1)!, w.shapes[0], `assigned onto ${label}`, '1', call));
    }
  }
  return dedupe(out);
}

/** A controller's own members as `alias.` or `this.` shows them: its `this.` members and bindings. */
function instanceMembers(src: CompletionSource, from: string, controller: string, via: '$scope' | 'this' | null, call: boolean): CompletionEntry[] {
  const out: CompletionEntry[] = [];
  for (const b of bindingsOf(src, controller)) {
    out.push({ name: b.name, kind: 'binding', detail: `binding '${b.mode}' of ${b.owner}`, sortText: '0' });
  }
  for (const row of src.membersOf(controller, from)) {
    if (via && viaOf(src, row) !== via) continue;
    out.push(memberEntry(row.name, shapeOf(src, row), via === '$scope' ? `on the $scope of ${controller}` : `member of ${controller}`, '1', call));
  }
  return dedupe(out);
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

/** Suggestions at a position in a template. */
export function templateCompletions(src: CompletionSource, relPath: string, offset: number): CompletionEntry[] {
  const facts = src.facts(relPath);
  const source = src.source(relPath);
  if (facts?.kind !== 'template' || source === null) return [];
  const before = source.slice(0, offset);

  // Inside EJS code (`<% … %>`): JavaScript of the server, not Angular.
  if (before.lastIndexOf('<%') > before.lastIndexOf('%>')) return [];

  // An expression still being typed (`{{ busy. }}`) can't be parsed, so the extractor drops it.
  // With a dummy identifier at the cursor it parses, and the node holding the dummy says which
  // property chain is being typed.
  const patched = before + CURSOR + source.slice(offset);
  const hit = expressionAt(src.bindTemplate(relPath, extractTemplate(patched, src.config)), offset);
  if (hit) {
    if (hit.node.type === 'Literal') return []; // typing inside a string
    if (isFilterPosition(source.slice(hit.expr.span.start, offset))) return filterCompletions(src);
    const { root, path } = unwind(hit.node);
    if (root && path.at(-1)?.includes(CURSOR)) return memberCompletions(src, relPath, root.name, path.slice(0, -1), hit.expr.scopeChain);
    return rootCompletions(src, relPath, hit.expr.scopeChain);
  }

  // Still unparseable after the dummy (`{{ a | }}`): the original expression's scope chain.
  for (const expr of facts.expressions) {
    if (offset >= expr.span.start && offset <= expr.span.end + 1) {
      if (isFilterPosition(source.slice(expr.span.start, offset))) return filterCompletions(src);
      return rootCompletions(src, relPath, expr.scopeChain);
    }
  }

  // An interpolation opened but not closed yet: `{{` just typed.
  const open = before.lastIndexOf('{{');
  if (open > before.lastIndexOf('}}')) {
    if (isFilterPosition(before.slice(open + 2))) return filterCompletions(src);
    return rootCompletions(src, relPath, chainAt(src, relPath, facts, offset));
  }

  const markup = markupContext(before);
  if (!markup) return []; // plain text: no scope variables there (spec #8)
  if (markup.kind === 'tag') return tagCompletions(src);
  if (markup.kind === 'attribute') return attributeCompletions(src, markup.tag, markup.present);
  return isExpressionAttribute(src, markup.tag, markup.attr) ? rootCompletions(src, relPath, chainAt(src, relPath, facts, offset)) : [];
}

/** After a `|` (not `||`) and the start of a name: where a filter goes (spec #6). */
function isFilterPosition(textBefore: string): boolean {
  return /(?:^|[^|])\|\s*[A-Za-z_$]?[\w$]*$/.test(textBefore.replace(CURSOR, ''));
}

/** Controllers around `offset` from the markup alone — for a place no parsed expression covers. */
function chainAt(src: CompletionSource, relPath: string, facts: TemplateFacts, offset: number): ScopeFrame[] {
  const frames: ScopeFrame[] = facts.controllers
    .filter((c) => inSpan(c.elementSpan, offset))
    .sort((a, b) => b.elementSpan.start - a.elementSpan.start)
    .map((c) => ({ kind: 'controller', controllerName: c.name, ...(c.alias ? { alias: c.alias } : {}), locals: [], elementSpan: c.elementSpan }));
  const bound = src.templateBinding(relPath);
  if (bound) {
    frames.push({ kind: 'controller', controllerName: bound.controller, ...(bound.alias ? { alias: bound.alias } : {}), locals: [], elementSpan: { start: 0, end: 0 } });
  }
  return frames;
}

/** Template variables, then each controller's scope, nearest first (spec #1, #3). */
function rootCompletions(src: CompletionSource, from: string, chain: ScopeFrame[]): CompletionEntry[] {
  const out: CompletionEntry[] = [];
  for (const frame of chain) {
    if (frame.kind === 'controller') continue;
    for (const local of frame.locals) out.push({ name: local.name, kind: 'variable', detail: `${frame.kind} variable of the template`, sortText: '0' });
  }
  controllerFrames(chain).forEach((f, i) => {
    const sort = String(i + 1).padStart(2, '0');
    const where = i === 0 ? `on the $scope of ${f.controllerName}` : `inherited from ${f.controllerName}`;
    if (f.alias) out.push({ name: f.alias, kind: 'alias', detail: `${f.controllerName} as ${f.alias}`, sortText: `${sort}0` });
    for (const row of src.membersOf(f.controllerName, from)) {
      if (f.alias && viaOf(src, row) === 'this') continue; // on the controller, reached through the alias
      out.push(memberEntry(row.name, shapeOf(src, row), where, `${sort}1`, true));
    }
  });
  return dedupe(out);
}

/**
 * Suggestions after a dot:
 *   `busy.`    -> keys of $scope.busy
 *   `section.` -> keys of an ELEMENT of $scope.sections (an ng-repeat variable)
 *   `vm.`      -> the controller behind the alias: its `this.` members and bindings (spec #2, #4)
 *   `user.`    -> keys of `user` on the nearest scope that has it, inherited ones too (spec #1)
 */
function memberCompletions(src: CompletionSource, from: string, rootName: string, path: string[], chain: ScopeFrame[]): CompletionEntry[] {
  const frames = controllerFrames(chain);
  const local = findLocal(rootName, chain);
  if (local) {
    if (!local.collection) return [];
    const owner = frameHolding(src, local.collection.root, frames) ?? frames[0];
    if (!owner) return [];
    return elementKeys(src, from, owner.controllerName, local.collection, path);
  }

  const aliased = frames.find((f) => f.alias === rootName);
  if (aliased) {
    return path.length ? keysAt(src, from, aliased.controllerName, path, true) : instanceMembers(src, from, aliased.controllerName, 'this', true);
  }
  const owner = frameHolding(src, rootName, frames);
  return owner ? keysAt(src, from, owner.controllerName, [rootName, ...path], true) : [];
}

/** Keys of an element of an ng-repeat collection, then down `path`. */
function elementKeys(
  src: CompletionSource,
  from: string,
  controller: string,
  collection: { root: string; path: string[] },
  path: string[],
): CompletionEntry[] {
  const out: CompletionEntry[] = [];
  const owner = [collection.root, ...collection.path].join('.');
  for (const row of nearestRows(from, src.findSymbols(collection.root, controller).filter((r) => r.kind === 'scope-member'))) {
    let shape = shapeAtPath(shapeOf(src, row) ?? undefined, collection.path);
    shape = shape?.kind === 'array' ? shape.element : undefined;
    shape = shapeAtPath(shape, path);
    if (shape?.kind !== 'object') continue;
    for (const [name, prop] of Object.entries(shape.props ?? {})) {
      out.push(memberEntry(name, prop, `key of an element of ${owner} (${prop.kind})`, '1', true));
    }
  }
  return dedupe(out);
}

function filterCompletions(src: CompletionSource): CompletionEntry[] {
  const out: CompletionEntry[] = src.symbolsOfKind('filter').map((r) => ({ name: r.name, kind: 'filter', detail: `filter — ${r.path}`, sortText: '0' }));
  for (const name of BUILTIN_FILTERS) out.push({ name, kind: 'filter', detail: 'built-in AngularJS filter', sortText: '1' });
  return dedupe(out);
}

// ---------------------------------------------------------------------------------------------
// Markup: tag and attribute names (spec #7)
// ---------------------------------------------------------------------------------------------

type Markup =
  | { kind: 'tag' }
  | { kind: 'attribute'; tag: string; present: Set<string> }
  | { kind: 'value'; tag: string; attr: string };

/** Where in a start tag the cursor is, from the text before it; `null` outside any tag. */
function markupContext(before: string): Markup | null {
  const lt = before.lastIndexOf('<');
  if (lt === -1 || lt < before.lastIndexOf('>')) return null;
  const inner = before.slice(lt + 1);
  if (/^[A-Za-z][\w-]*$|^$/.test(inner)) return { kind: 'tag' };
  const tag = /^([A-Za-z][\w-]*)\s/.exec(inner)?.[1];
  if (!tag) return null;

  // Walk the attributes, tracking quotes: the cursor is in a name, or in a value.
  const present = new Set<string>();
  const attrRe = /([^\s"'=<>/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]*))?/g;
  const rest = inner.slice(tag.length);
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = attrRe.exec(rest))) {
    lastEnd = m.index + m[0].length;
    present.add(normalizeDirectiveName(m[1]!));
  }
  const open = /([^\s"'=<>/]+)\s*=\s*(["'])([^"']*)$/.exec(rest);
  if (open && (rest.split(open[2]!).length - 1) % 2 === 1) return { kind: 'value', tag, attr: open[1]! };
  const typing = /(?:^|\s)([^\s"'=<>/]*)$/.exec(rest);
  if (!typing || (typing[1] && lastEnd !== rest.length)) return null;
  if (typing[1]) present.delete(normalizeDirectiveName(typing[1]));
  return { kind: 'attribute', tag, present };
}

/** Components, and directives that may be elements (`restrict` with `E`, `EA` by default). */
function tagCompletions(src: CompletionSource): CompletionEntry[] {
  const out: CompletionEntry[] = [];
  for (const row of src.symbolsOfKind('component')) {
    out.push({ name: denormalize(row.name), kind: 'component', detail: `component ${row.name} — ${row.path}`, sortText: '0' });
  }
  for (const row of src.symbolsOfKind('directive')) {
    const restrict = declOf(src, row)?.ddo?.restrict ?? 'EA';
    if (restrict.includes('E')) out.push({ name: denormalize(row.name), kind: 'directive', detail: `directive ${row.name} (${restrict}) — ${row.path}`, sortText: '1' });
  }
  return dedupe(out);
}

/** The bindings of the tag's own component/directive, then directives usable as attributes. */
function attributeCompletions(src: CompletionSource, tag: string, present: Set<string>): CompletionEntry[] {
  const out: CompletionEntry[] = [];
  const tagName = normalizeDirectiveName(tag);
  for (const row of [...src.symbolsOfKind('component'), ...src.symbolsOfKind('directive')]) {
    if (row.name !== tagName) continue;
    for (const [name, mode] of Object.entries(declOf(src, row)?.ddo?.scopeBindings ?? {})) {
      if (present.has(name)) continue;
      const attr = denormalize(name);
      out.push({ name: attr, kind: 'binding', detail: `binding '${mode}' of ${row.name}`, snippet: `${attr}="$1"`, sortText: '0' });
    }
  }
  for (const row of src.symbolsOfKind('directive')) {
    const restrict = declOf(src, row)?.ddo?.restrict ?? 'EA';
    if (!restrict.includes('A') || present.has(row.name)) continue;
    const attr = denormalize(row.name);
    out.push({ name: attr, kind: 'directive', detail: `directive ${row.name} (${restrict}) — ${row.path}`, snippet: `${attr}="$1"`, sortText: '1' });
  }
  return dedupe(out);
}

/** Is an attribute's value an Angular expression: `ng-*`, a workspace directive, or a binding of the tag's? */
function isExpressionAttribute(src: CompletionSource, tag: string, attr: string): boolean {
  const name = normalizeDirectiveName(attr);
  if (/^ng[A-Z]/.test(name)) return true;
  if (src.findSymbols(name, null).some((r) => r.kind === 'directive')) return true;
  const tagName = normalizeDirectiveName(tag);
  return [...src.findSymbols(tagName, null)].some((r) => (r.kind === 'component' || r.kind === 'directive') && name in (declOf(src, r)?.ddo?.scopeBindings ?? {}));
}

// ---------------------------------------------------------------------------------------------
// JS files (spec #9, #10)
// ---------------------------------------------------------------------------------------------

const SERVICE_KINDS = new Set(['factory', 'service', 'value', 'constant']);

/** Suggestions after `$scope.` / `this.` / `vm.` / an injected service's name in a `.js` file. */
export function jsCompletions(src: CompletionSource, relPath: string, offset: number): CompletionEntry[] {
  const source = src.source(relPath);
  if (source === null) return [];
  const hit = jsMemberContextAt(source, offset, src.config);
  if (!hit) return [];
  const { buffer, ...ctx } = hit;
  src = withBuffer(src, relPath, buffer.source, buffer.facts);

  if (ctx.kind === 'scope') {
    if (ctx.path.length) return keysAt(src, relPath, ctx.owner, ctx.path, false);
    const members = instanceMembers(src, relPath, ctx.owner, ctx.via, false);
    // Bindings live on `this` for a component (and bindToController), on the isolate `scope` for a directive's link.
    return ctx.via === '$scope' ? members.filter((m) => m.kind !== 'binding' || isDirective(src, ctx.owner)) : members;
  }

  const rows = nearestRows(relPath, src.findSymbols(ctx.name, null).filter((r) => SERVICE_KINDS.has(r.kind)));
  for (const row of rows) {
    const decl = declOf(src, row);
    const file = src.source(row.path);
    if (!decl || file === null) continue;
    const shape = shapeAtPath(serviceShapeIn(file, decl) ?? undefined, ctx.path);
    if (shape?.kind !== 'object') continue;
    const label = [ctx.name, ...ctx.path].join('.');
    return Object.entries(shape.props ?? {}).map(([name, prop]) => memberEntry(name, prop, `${row.kind} ${label}`, '1', false));
  }
  return [];
}

/**
 * `src` with one file read from the buffer being typed rather than the index: the index keeps the
 * file as last saved, whose spans no longer line up with the buffer's facts — and whose members,
 * the one being typed aside, are the ones worth suggesting.
 */
function withBuffer(src: CompletionSource, relPath: string, source: string, facts: JsFacts): CompletionSource {
  const own: SymbolRow[] = factsToRows(facts).symbols.map((s, i) => ({ ...s, id: -1 - i, path: relPath }));
  const swap = (rows: SymbolRow[], keep: (r: SymbolRow) => boolean) => [...rows.filter((r) => r.path !== relPath), ...own.filter(keep)];
  return {
    config: src.config,
    moduleAliases: src.moduleAliases,
    facts: (p) => (p === relPath ? facts : src.facts(p)),
    source: (p) => (p === relPath ? source : src.source(p)),
    findSymbols: (name, container) => swap(src.findSymbols(name, container), (r) => r.name === name && r.container === container),
    symbolsOfKind: (kind) => swap(src.symbolsOfKind(kind), (r) => r.kind === kind),
    membersOf: (controller, from) => {
      const rows = swap(src.membersOf(controller), (r) => r.kind === 'scope-member' && r.container === controller);
      return from === undefined ? rows : nearestRows(from, rows);
    },
    bindTemplate: (p, f) => src.bindTemplate(p, f),
    templateBinding: (p) => src.templateBinding(p),
  };
}

function isDirective(src: CompletionSource, name: string): boolean {
  return src.findSymbols(name, null).some((r) => r.kind === 'directive');
}
