import * as walkLib from 'acorn-walk';
import { parse as parseHtml } from 'angular-html-parser';
import type { Element, Node } from 'angular-html-parser/lib/compiler/src/ml_parser/ast';
import type { AttrCandidate, Config, ScopeFrame, Span, TemplateExpression, TemplateFacts } from '../types';
import { scanEjs, toVirtualHtml, toVirtualJs, mapVirtualJsOffset } from '../ejs/scanner';
import { directiveExprKind, normalizeDirectiveName, NG_REPEAT_LOCALS } from '../ng/normalize';
import { tryParseExpression } from '../ng/parser';
import { collectFilters, collectRoots, type Program } from '../ng/ast';
import { parseOptions, parseRepeat } from '../ng/microsyntax';
import { EJS_GLOBALS, parseJsTolerant } from './js-common';

const INTERPOLATION_RE = /\{\{([\s\S]*?)\}\}/g;

/**
 * Extract facts from a .ejs / .html file.
 *
 * MUST be a pure function of `source` (docs/kien-truc.md section 3): does not read
 * other files, does not query the index. Anything needing cross-file information
 * is done at the resolver layer.
 */
export function extractTemplate(source: string, config: Config): TemplateFacts {
  const facts: TemplateFacts = {
    kind: 'template',
    expressions: [],
    ejsLocals: [],
    ejsIncludes: [],
    controllers: [],
    customElements: [],
    bridges: [],
    attrCandidates: [],
    parseErrors: [],
  };

  const regions = scanEjs(source, config.ejsDelimiter);

  extractEjsAxis(regions, facts);
  extractBridges(source, regions, facts);

  // Virtual HTML: EJS region -> whitespace of the same length, so offsets line up
  // exactly with the original file.
  const virtualHtml = toVirtualHtml(source, regions);
  let parsed;
  try {
    parsed = parseHtml(virtualHtml, { canSelfClose: true, allowHtmComponentClosingTags: true });
  } catch (e) {
    facts.parseErrors.push({
      message: `Failed to parse HTML: ${(e as Error).message}`,
      span: { start: 0, end: source.length },
    });
    return facts;
  }

  // HTML errors are NORMAL with EJS (`<% if %><div><% } %>` breaks tag balance).
  // Just record them, don't stop. See docs/kien-truc.md appendix A.3.
  for (const err of parsed.errors) {
    facts.parseErrors.push({
      message: err.msg,
      span: { start: err.span.start.offset, end: err.span.end.offset },
    });
  }

  for (const node of parsed.rootNodes) {
    visit(node, [{ kind: 'root', locals: [], elementSpan: { start: 0, end: source.length } }], facts, config);
  }

  return facts;
}

/**
 * Does this attribute look like a directive/binding?
 *
 * Excludes standard HTML/ARIA attributes so `aria-label="Search"` doesn't turn
 * into a false reference. Keeps only attributes with a '-' (looks like a custom
 * directive) or unknown attributes on a custom element.
 */
function isCandidateAttr(rawName: string, tagName: string): boolean {
  const lower = rawName.toLowerCase();
  if (lower.startsWith('aria-') || lower.startsWith('data-')) return false;
  if (STANDARD_DASHED_ATTRS.has(lower)) return false;
  if (lower.includes('-')) return true;
  // An attribute without a '-' only looks suspicious when it's on a custom element
  // (isolate binding).
  return tagName.includes('-') && !STANDARD_ATTRS.has(lower);
}

const STANDARD_DASHED_ATTRS = new Set([
  'http-equiv', 'accept-charset', 'accesskey',
]);

const STANDARD_ATTRS = new Set([
  'id', 'class', 'style', 'title', 'href', 'src', 'alt', 'type', 'name', 'value',
  'placeholder', 'disabled', 'readonly', 'checked', 'selected', 'required', 'rel',
  'target', 'width', 'height', 'colspan', 'rowspan', 'role', 'tabindex', 'for',
  'action', 'method', 'accept', 'multiple', 'min', 'max', 'step', 'pattern', 'lang',
]);

function controllerNameOf(chain: ScopeFrame[]): string | null {
  for (const f of chain) if (f.kind === 'controller' && f.controllerName) return f.controllerName;
  return null;
}

/** controllerAs aliases in scope -> their controller; the nearest frame wins a name used twice. */
function aliasesOf(chain: ScopeFrame[]): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const f of chain) {
    if (f.kind !== 'controller' || !f.alias || !f.controllerName) continue;
    out ??= {};
    out[f.alias] ??= f.controllerName;
  }
  return out;
}

function localsOf(chain: ScopeFrame[]): string[] {
  const out: string[] = [];
  for (const f of chain) {
    if (f.kind === 'controller') {
      if (f.alias) out.push(f.alias);
      continue;
    }
    for (const l of f.locals) out.push(l.name);
  }
  return out;
}

/**
 * Get the root identifier of a collection expression: `vm.orders | filter:q` -> vm.orders.
 * Filters are skipped since they don't change the element's shape.
 */
function firstRootOf(program: Program): { root: string; path: string[] } | undefined {
  const roots = collectRoots(program);
  const first = roots[0];
  return first ? { root: first.name, path: first.path } : undefined;
}

function isElement(node: Node): node is Element {
  return (node as Element).name !== undefined && Array.isArray((node as Element).attrs);
}

function visit(node: Node, chain: ScopeFrame[], facts: TemplateFacts, config: Config): void {
  if (!isElement(node)) {
    // Text node: look for {{ }}
    const text = (node as { value?: string }).value;
    const span = node.sourceSpan;
    if (typeof text === 'string' && span) {
      extractInterpolations(text, span.start.offset, chain, 'interpolation', facts, config);
    }
    return;
  }

  const el = node;
  const elementSpan: Span = {
    start: el.sourceSpan.start.offset,
    end: el.sourceSpan.end.offset,
  };

  // Custom element (has a '-') may be a custom directive.
  if (el.name.includes('-')) {
    facts.customElements.push({
      tag: normalizeDirectiveName(el.name),
      span: { start: el.startSourceSpan.start.offset + 1, end: el.startSourceSpan.start.offset + 1 + el.name.length },
    });
  }

  // The NEW scope frames created by this very element.
  const newFrames: ScopeFrame[] = [];

  for (const attr of el.attrs) {
    const normalized = normalizeDirectiveName(attr.name);
    const valueSpan = attr.valueSpan;
    const value = attr.value ?? '';

    // ng-controller: the most reliable template<->controller link source.
    if (normalized === 'ngController' && valueSpan) {
      const m = value.match(/^\s*([^\s]+)(?:\s+as\s+([$\w]+))?\s*$/);
      if (m) {
        const nameOffset = valueStartOf(valueSpan) + value.indexOf(m[1]!);
        const frame: ScopeFrame = {
          kind: 'controller',
          controllerName: m[1]!,
          alias: m[2],
          locals: [],
          elementSpan,
        };
        if (m[2]) {
          const aliasOffset = valueStartOf(valueSpan) + value.lastIndexOf(m[2]);
          frame.locals.push({
            name: m[2],
            span: { start: aliasOffset, end: aliasOffset + m[2].length },
          });
        }
        newFrames.push(frame);
        facts.controllers.push({
          name: m[1]!,
          alias: m[2],
          span: { start: nameOffset, end: nameOffset + m[1]!.length },
          elementSpan,
        });
      }
      continue;
    }

    if (!valueSpan) continue;
    const base = valueStartOf(valueSpan);

    const kind = directiveExprKind(normalized, config.customDirectives);

    if (kind === 'repeat-microsyntax') {
      const rep = parseRepeat(value, base);
      if (rep.error) facts.parseErrors.push({ message: rep.error, span: { start: base, end: base + value.length } });
      const locals: ScopeFrame['locals'] = [];
      const collectionRef = rep.collection ? firstRootOf(rep.collection) : undefined;
      if (rep.itemVar) {
        locals.push({
          name: rep.itemVar.name,
          span: rep.itemVar.span,
          fromExpr: value,
          collection: collectionRef,
        });
      }
      if (rep.keyVar) locals.push({ name: rep.keyVar.name, span: rep.keyVar.span });
      if (rep.aliasVar) locals.push({ name: rep.aliasVar.name, span: rep.aliasVar.span });
      for (const b of NG_REPEAT_LOCALS) {
        locals.push({ name: b, span: { start: base, end: base } });
      }
      newFrames.push({ kind: 'repeat', locals, elementSpan });

      // IMPORTANT: store only the SUB-EXPRESSION, not the whole microsyntax string.
      // `section in sections` is not a valid Angular expression (`in` is not an
      // operator), so storing the whole string would make the resolver's re-parse
      // fail and report "position not inside an Angular expression" — which is
      // exactly what's on the right-hand side, `sections`, the thing users most
      // often Ctrl+Click.
      if (rep.collection) {
        pushExpression(
          rep.collection,
          sliceOf(value, base, rep.collectionSpan),
          rep.collectionSpan.start,
          normalized,
          chain, // the collection is evaluated in the PARENT scope, not the new one
          facts,
        );
      }
      if (rep.trackBy && rep.trackBySpan) {
        pushExpression(
          rep.trackBy,
          sliceOf(value, base, rep.trackBySpan),
          rep.trackBySpan.start,
          normalized,
          [...newFrames, ...chain],
          facts,
        );
      }
      continue;
    }

    if (kind === 'options-microsyntax') {
      const opt = parseOptions(value, base);
      const locals: ScopeFrame['locals'] = [];
      const optCollection = opt.collection ? firstRootOf(opt.collection) : undefined;
      if (opt.itemVar) {
        locals.push({ name: opt.itemVar.name, span: opt.itemVar.span, collection: optCollection });
      }
      if (opt.keyVar) locals.push({ name: opt.keyVar.name, span: opt.keyVar.span });
      newFrames.push({ kind: 'repeat', locals, elementSpan });
      if (opt.collection && opt.collectionSpan) {
        pushExpression(
          opt.collection,
          sliceOf(value, base, opt.collectionSpan),
          opt.collectionSpan.start,
          normalized,
          chain,
          facts,
        );
      }
      for (const extra of opt.extras) {
        pushExpression(
          extra.program,
          sliceOf(value, base, extra.span),
          extra.span.start,
          normalized,
          [...newFrames, ...chain],
          facts,
        );
      }
      continue;
    }

    if (kind === 'expression' || kind === 'statement' || kind === 'assignable') {
      const program = tryParseExpression(value, base);
      if (!program) {
        facts.parseErrors.push({
          message: `Failed to parse expression for ${attr.name}`,
          span: { start: base, end: base + value.length },
        });
        continue;
      }
      // ng-init introduces new variables into the current scope.
      if (normalized === 'ngInit') {
        const frame: ScopeFrame = { kind: 'init', locals: [], elementSpan };
        for (const root of collectRoots(program)) {
          if (root.isWrite) frame.locals.push({ name: root.name, span: root.span });
        }
        if (frame.locals.length) newFrames.push(frame);
      }
      pushExpression(program, value, base, normalized, [...newFrames, ...chain], facts);
      continue;
    }

    // A regular HTML attribute: can still contain {{ }}
    if (value.includes('{{')) {
      extractInterpolations(value, base, [...newFrames, ...chain], normalized, facts, config);
      continue;
    }

    // Otherwise: unknown for now. Recorded so the Linker can resolve it at Layer 4.
    if (kind === undefined && value.trim() && isCandidateAttr(attr.name, el.name)) {
      const activeChain = [...newFrames, ...chain];
      facts.attrCandidates.push({
        tag: normalizeDirectiveName(el.name),
        attr: normalized,
        value,
        valueSpan: { start: base, end: base + value.length },
        attrSpan: {
          start: attr.sourceSpan.start.offset,
          end: attr.sourceSpan.start.offset + attr.name.length,
        },
        container: controllerNameOf(activeChain),
        aliases: aliasesOf(activeChain),
        locals: localsOf(activeChain),
      });
    }
  }

  const childChain = newFrames.length ? [...newFrames.reverse(), ...chain] : chain;
  for (const child of el.children) visit(child, childChain, facts, config);
}

/**
 * Offset of the FIRST CHARACTER in the attribute value.
 *
 * angular-html-parser's `valueSpan` starts at the QUOTE CHARACTER when the value
 * is quoted (`x="v"` -> points at `"`), and at the value itself when unquoted
 * (`x=v`). Using `valueSpan.start.offset` directly as the base would shift every
 * span inside the attribute one character to the left. Navigation still worked
 * (`inSpan` counts both endpoints), so the bug stayed hidden until rename was
 * implemented — see docs/kien-truc.md appendix I.
 */
function valueStartOf(valueSpan: { start: { offset: number; file: { content: string } } }): number {
  const at = valueSpan.start.offset;
  const c = valueSpan.start.file.content[at];
  return c === '"' || c === "'" ? at + 1 : at;
}

/** Slice the text corresponding to `span` out of an attribute value starting at `base`. */
function sliceOf(value: string, base: number, span: Span): string {
  return value.slice(span.start - base, span.end - base);
}

function pushExpression(
  program: ReturnType<typeof tryParseExpression>,
  text: string,
  base: number,
  source: string,
  chain: ScopeFrame[],
  facts: TemplateFacts,
): void {
  if (!program) return;
  facts.expressions.push({
    text,
    span: { start: base, end: base + text.length },
    source,
    roots: collectRoots(program).map((r) => ({
      name: r.name,
      span: r.span,
      path: r.path,
      isCall: r.isCall,
    })),
    filters: collectFilters(program),
    scopeChain: chain,
  });
}

function extractInterpolations(
  text: string,
  baseOffset: number,
  chain: ScopeFrame[],
  source: string,
  facts: TemplateFacts,
  _config: Config,
): void {
  INTERPOLATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTERPOLATION_RE.exec(text)) !== null) {
    const inner = m[1]!;
    const innerStart = baseOffset + m.index + 2;
    const program = tryParseExpression(inner, innerStart);
    if (!program) {
      facts.parseErrors.push({
        message: `Failed to parse interpolation expression {{${inner.trim()}}}`,
        span: { start: innerStart, end: innerStart + inner.length },
      });
      continue;
    }
    pushExpression(program, inner, innerStart, source, chain, facts);
  }
}

/** Axis A: EJS local variables and include calls. */
function extractEjsAxis(regions: ReturnType<typeof scanEjs>, facts: TemplateFacts): void {
  const vjs = toVirtualJs(regions);
  if (!vjs.code.trim()) return;

  const ast = parseJsTolerant(vjs.code);
  if (!ast) return;

  // Variables declared directly in the template are not locals injected by the server.
  const declared = new Set<string>();
  walkLib.simple(ast, {
    VariableDeclarator(n) {
      if (n.id.type === 'Identifier') declared.add(n.id.name);
    },
    FunctionDeclaration(n) {
      if (n.id) declared.add(n.id.name);
      for (const p of n.params) if (p.type === 'Identifier') declared.add(p.name);
    },
  });

  walkLib.ancestor(ast, {
    Identifier(n, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      if (parent?.type === 'Property' && parent.key === n && !parent.computed) return;
      if (declared.has(n.name) || EJS_GLOBALS.has(n.name)) return;
      const src = mapVirtualJsOffset(vjs, n.start);
      if (src === -1) return;

      // Collect the property path: `user.profile.name` -> path ['profile','name'].
      const path: string[] = [];
      for (let i = ancestors.length - 2; i >= 0; i--) {
        const a = ancestors[i];
        if (a?.type !== 'MemberExpression' || a.computed) break;
        if (a.property.type === 'Identifier') path.push(a.property.name);
        else break;
      }

      facts.ejsLocals.push({
        name: n.name,
        path,
        span: { start: src, end: src + (n.end - n.start) },
      });
    },
    CallExpression(n) {
      if (n.callee.type !== 'Identifier' || n.callee.name !== 'include') return;
      const first = n.arguments[0];
      if (!first || first.type !== 'Literal' || typeof first.value !== 'string') return;

      const second = n.arguments[1];
      const passedKeys: string[] = [];
      if (second && second.type === 'ObjectExpression') {
        for (const prop of second.properties) {
          if (prop.type !== 'Property') continue;
          if (prop.key.type === 'Identifier') passedKeys.push(prop.key.name);
          else if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') {
            passedKeys.push(prop.key.value);
          }
        }
      }

      const src = mapVirtualJsOffset(vjs, n.start);
      if (src === -1) return;
      facts.ejsIncludes.push({
        viewPath: first.value,
        passedKeys,
        span: { start: src, end: src + (n.end - n.start) },
      });
    },
  });
}

/**
 * The intersection of axis A and axis B (docs/kien-truc.md section 0):
 *   <script>window.BOOT = <%- JSON.stringify(data) %>;</script>
 * This is the spot no existing tool can currently connect both ends of.
 */
function extractBridges(
  source: string,
  regions: ReturnType<typeof scanEjs>,
  facts: TemplateFacts,
): void {
  for (const r of regions) {
    if (r.kind !== 'output-raw' && r.kind !== 'output-escaped') continue;
    // Look backward for `<name> =` right before the region.
    const before = source.slice(Math.max(0, r.span.start - 120), r.span.start);
    const m = before.match(/([$\w.[\]'"]+)\s*=\s*$/);
    if (!m) continue;
    // Only counts as a bridge when it's inside a <script> tag.
    const scriptOpen = source.lastIndexOf('<script', r.span.start);
    const scriptClose = source.lastIndexOf('</script', r.span.start);
    const inScript = scriptOpen !== -1 && scriptOpen > scriptClose;
    const inNgAttr = /ng[-:_]init\s*=\s*["'][^"']*$/i.test(before);
    if (!inScript && !inNgAttr) continue;
    facts.bridges.push({
      jsTarget: m[1]!,
      ejsExpr: r.inner.trim(),
      span: r.span,
    });
  }
}
