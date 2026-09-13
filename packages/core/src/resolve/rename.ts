import type * as acorn from 'acorn';
import * as walkLib from 'acorn-walk';
import type { Config, JsBinding, NgDeclaration, Span } from '../types';
import { extractJs, findFunctionFor, scopeParamName } from '../extract/js';
import { resolveBinding } from '../extract/bindings';
import { parseJsTolerant } from '../extract/js-common';

/** One access to `$scope.<name>` — the span covers ONLY the property name. */
export interface ScopeAccess {
  name: string;
  span: Span;
}

/**
 * Every access to `$scope.<name>` inside a declaration's body, BOTH reads and writes.
 *
 * Unlike `JsFacts.scopeMembers` — which keeps only the FIRST assignment as the
 * declaration site. Rename needs every site: renaming `s.init = …` while missing
 * `s.init()` breaks the code.
 *
 * The object must be EXACTLY the $scope parameter of this declaration, or a variable
 * assigned straight from it (`var vm = $scope;`). A nested function whose parameter
 * happens to share the name (`function (s) {…}`) is a different variable — shadowing —
 * and is not touched.
 *
 * Also catches bracket-string access (`s['busy']`): missing it would leave JS still
 * writing the old name while the template already reads the new one.
 */
export function scopeAccesses(
  ast: acorn.Program,
  decl: NgDeclaration,
  bindings: JsBinding[],
): ScopeAccess[] {
  const fn = findFunctionFor(ast, decl);
  if (!fn) return [];
  const param = scopeParamName(decl, fn);
  const paramNode = fn.params.find(
    (p): p is acorn.Identifier => p.type === 'Identifier' && p.name === param,
  );
  if (!param || !paramNode) return [];

  // Bindings that point at $scope: the parameter itself, and every `var x = <parameter>`
  // (identified by its declaration span).
  const scopeBindings = new Set([paramNode.start]);
  walkLib.simple(fn.body as acorn.Node, {
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier' || node.init?.type !== 'Identifier') return;
      if (node.init.name !== param) return;
      if (resolveBinding(bindings, param, node.init.start)?.span.start !== paramNode.start) return;
      scopeBindings.add(node.id.start);
    },
  });
  const isScope = (obj: acorn.Node): boolean => {
    if (obj.type !== 'Identifier') return false;
    const binding = resolveBinding(bindings, (obj as acorn.Identifier).name, obj.start);
    return !!binding && scopeBindings.has(binding.span.start);
  };

  const out: ScopeAccess[] = [];
  walkLib.simple(fn.body as acorn.Node, {
    MemberExpression(node) {
      if (!isScope(node.object)) return;
      const prop = node.property;
      if (!node.computed && prop.type === 'Identifier') {
        out.push({ name: prop.name, span: { start: prop.start, end: prop.end } });
      } else if (node.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
        // Only accept a plain string literal: with an escape (`'bu\\x73y'`) the span
        // wouldn't line up with the name.
        if (prop.raw?.slice(1, -1) !== prop.value) return;
        out.push({ name: prop.value, span: { start: prop.start + 1, end: prop.end - 1 } });
      }
    },
  });
  return out;
}

/**
 * Every Angular declaration in a file, with its $scope accesses and the names of the
 * properties ASSIGNED within that declaration.
 * Extracted from the source passed in, NOT from the index — the index can be stale
 * relative to the file.
 */
export function scopeAccessesByDecl(
  source: string,
  config: Config,
): Array<{ decl: NgDeclaration; accesses: ScopeAccess[]; assigned: Set<string> }> {
  const ast = parseJsTolerant(source);
  if (!ast) return [];
  const facts = extractJs(source, config);
  return facts.declarations.map((decl) => ({
    decl,
    accesses: scopeAccesses(ast, decl, facts.bindings),
    assigned: new Set(facts.scopeMembers.filter((m) => m.owner === decl.name).map((m) => m.name)),
  }));
}

/** JavaScript keywords and Angular literals — not usable as a property name. */
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
  'with', 'yield',
]);

/** Why the new name isn't usable, or null if it's valid. */
export function newNameProblem(oldName: string, newName: string): string | null {
  if (newName === oldName) return 'New name is the same as the old one';
  if (newName.startsWith('$')) return "A name starting with '$' is reserved for AngularJS";
  if (!/^[A-Za-z_][\w$]*$/.test(newName)) return `'${newName}' is not a valid identifier`;
  if (RESERVED.has(newName)) return `'${newName}' is a reserved keyword`;
  return null;
}

/** Line number (1-based) of an offset — for conflict messages. */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

const JS_FILE = /\.js$/i;

/** Depth of the common parent directory (from repo root) of two relative paths. */
export function commonDirDepth(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  let n = 0;
  while (n < da.length && n < db.length && da[n] === db[n]) n++;
  return n;
}

/** Files in `candidates` closest to `from` by directory — several files on a tie. */
export function nearestFiles(from: string, candidates: string[]): string[] {
  const depth = candidates.map((c) => commonDirDepth(from, c));
  const best = Math.max(...depth);
  return candidates.filter((_, i) => depth[i] === best);
}

/**
 * A symbol declared under the same name in multiple files (a controller declared twice,
 * on two branches): keep only the copy in the directory nearest to `from`. On a tie,
 * keep all of them.
 *
 * Shared by definition (packages/core/src/resolve/definition.ts) and completion
 * (Workspace.memberCompletions) — both apply the same "nearest copy" rule as rename.
 */
export function nearestRows<T extends { path: string }>(from: string, rows: T[]): T[] {
  const paths = [...new Set(rows.map((r) => r.path))];
  if (paths.length < 2) return rows;
  const nearest = new Set(nearestFiles(from, paths));
  return rows.filter((r) => nearest.has(r.path));
}

/**
 * Multiple targets of the SAME kind live in multiple files: keep only the copy nearest
 * the file being viewed, and return the rest in `otherFiles`. Uses the same matching
 * rule rename already uses (Appendix I.1), so the two features answer consistently.
 *
 * Measured on smart-city: 168/244 positions in templates returned 2 targets — always a
 * controller declared under the same name in `product/…` and `new-version/fe-be/…` — and
 * this rule brings all 168 down to exactly 1 target, i.e. the IDE jumps straight there
 * instead of popping up a picker.
 *
 * Only merges when every target is of the SAME `kind`: jsDefinition deliberately returns
 * both an Angular declaration and a same-named function parameter (Appendix H.3) — two
 * different kinds, and neither should be dropped. On a tie (the template sits equidistant
 * from both copies), keep both: when it can't be told apart, don't guess.
 */
export function preferNearest<
  R extends { targets: Array<{ path: string; kind: string }>; otherFiles?: string[] },
>(from: string, result: R): R {
  const paths = [...new Set(result.targets.map((t) => t.path))];
  if (paths.length < 2 || new Set(result.targets.map((t) => t.kind)).size > 1) return result;

  const nearest = new Set(nearestFiles(from, paths));
  if (nearest.size === paths.length) return result;
  return {
    ...result,
    targets: result.targets.filter((t) => nearest.has(t.path)),
    otherFiles: paths.filter((p) => !nearest.has(p)),
  };
}

export interface RenameScope {
  js: string[];
  templates: string[];
  /** Files that declare the same-named controller but are intentionally NOT touched. */
  untouched: string[];
  /** Note to the user when the controller is declared in multiple files. */
  note?: string;
}

/**
 * Rename scope when a controller is declared in MULTIPLE .js files (a duplicate, an
 * old/new version…). Chosen behavior (docs/kien-truc.md Appendix I): pair each template
 * with its directory-nearest .js file, then rename only the GROUP containing the
 * starting point.
 *
 * A template sitting between two copies (tied distance) pulls both copies into the
 * group — renaming only one would break that template against the other. This grows
 * iteratively until stable; if it pulls in everything, everything gets renamed and the
 * user is told.
 */
export function renameScope(
  from: string,
  declFiles: string[],
  templates: string[],
  controller: string,
): RenameScope {
  if (declFiles.length <= 1) return { js: declFiles, templates, untouched: [] };

  const nearest = new Map(templates.map((t) => [t, nearestFiles(t, declFiles)]));
  const selected = new Set(
    JS_FILE.test(from) && declFiles.includes(from) ? [from] : nearestFiles(from, declFiles),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const group of nearest.values()) {
      if (!group.some((f) => selected.has(f))) continue;
      for (const f of group) {
        if (selected.has(f)) continue;
        selected.add(f);
        grew = true;
      }
    }
  }

  const untouched = declFiles.filter((f) => !selected.has(f));
  return {
    js: declFiles.filter((f) => selected.has(f)),
    templates: templates.filter((t) => nearest.get(t)!.some((f) => selected.has(f))),
    untouched,
    note: untouched.length
      ? `'${controller}' is declared in ${declFiles.length} files — renaming only the nearest copy, leaving ${untouched.join(', ')} unchanged`
      : `'${controller}' is declared in ${declFiles.length} files and none could be told apart as nearer — renamed all ${declFiles.length}`,
  };
}

/**
 * A position containing `name` sitting in Angular-LOOKING context — the value of an
 * attribute with `ng-` in its name, or inside {{ }} — but NOT inside a `parsed` region
 * (a region the extractor understood: an expression, a local-variable declaration site…).
 * A position the extractor parsed but intentionally didn't rename (a different
 * controller, an ng-repeat variable, an object key) doesn't count as a miss.
 *
 * This is where the extractor could NOT extract anything. Rename doesn't touch these
 * (no guessing) — it only flags them for the user to check by hand. A real cause seen in
 * practice (smart-city/new-version): indentation using U+2003 — the browser doesn't treat
 * it as whitespace inside a tag, so `␣␣data-ng-disabled` isn't recognized as a directive,
 * and the Angular lexer rejects the `{{` that contains it.
 */
export function unparsedOccurrences(source: string, name: string, parsed: Span[]): number[] {
  const regions: Span[] = [];
  // JS's `\s` also matches U+2003, so the attribute name still splits correctly even
  // with the odd indentation character.
  for (const m of source.matchAll(/([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (!/(?:^|[-:_])ng[-:_]/i.test(m[1]!)) continue;
    const value = m[2] ?? m[3] ?? '';
    const start = m.index! + m[0].length - value.length - 1;
    regions.push({ start, end: start + value.length });
  }
  for (const m of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    regions.push({ start: m.index! + 2, end: m.index! + 2 + m[1]!.length });
  }

  const escaped = name.replace(/\$/g, '\\$');
  const out: number[] = [];
  for (const m of source.matchAll(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, 'g'))) {
    const at = m.index!;
    if (parsed.some((p) => at >= p.start && at < p.end)) continue;
    const region = regions.find((r) => at >= r.start && at < r.end);
    if (!region) continue;
    // `'busy'` inside an expression is a STRING, not a reference.
    const before = source[at - 1];
    if (at !== region.start && (before === "'" || before === '"')) continue;
    out.push(at);
  }
  return out;
}
