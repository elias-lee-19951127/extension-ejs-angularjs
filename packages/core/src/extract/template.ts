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
 * Trich fact tu mot file .ejs / .html.
 *
 * BAT BUOC la ham thuan cua `source` (docs/kien-truc.md muc 3): khong doc file khac,
 * khong tra cuu index. Moi thu can thong tin lien file duoc lam o tang resolver.
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

  // Virtual HTML: region EJS -> khoang trang cung do dai, nen offset trung khit file goc.
  const virtualHtml = toVirtualHtml(source, regions);
  let parsed;
  try {
    parsed = parseHtml(virtualHtml, { canSelfClose: true, allowHtmComponentClosingTags: true });
  } catch (e) {
    facts.parseErrors.push({
      message: `Khong parse duoc HTML: ${(e as Error).message}`,
      span: { start: 0, end: source.length },
    });
    return facts;
  }

  // Loi HTML la CHUYEN BINH THUONG voi EJS (`<% if %><div><% } %>` lam ho the).
  // Chi ghi nhan, khong dung lai. Xem docs/kien-truc.md phu luc A.3.
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
 * Thuoc tinh nay co dang mot directive/binding khong?
 *
 * Loai bo thuoc tinh HTML/ARIA chuan de khong bien `aria-label="Search"` thanh
 * mot tham chieu gia. Chi giu lai thuoc tinh co dau '-' (dang directive tu viet)
 * hoac thuoc tinh la tren the custom.
 */
function isCandidateAttr(rawName: string, tagName: string): boolean {
  const lower = rawName.toLowerCase();
  if (lower.startsWith('aria-') || lower.startsWith('data-')) return false;
  if (STANDARD_DASHED_ATTRS.has(lower)) return false;
  if (lower.includes('-')) return true;
  // Thuoc tinh khong dau '-' chi dang ngo khi nam tren the custom (isolate binding).
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
 * Lay dinh danh goc cua mot bieu thuc collection: `vm.orders | filter:q` -> vm.orders.
 * Bo qua filter vi filter khong doi shape phan tu.
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
    // Node text: tim {{ }}
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

  // The custom (co dau '-') co the la directive tu viet.
  if (el.name.includes('-')) {
    facts.customElements.push({
      tag: normalizeDirectiveName(el.name),
      span: { start: el.startSourceSpan.start.offset + 1, end: el.startSourceSpan.start.offset + 1 + el.name.length },
    });
  }

  // Cac tang scope MOI do chinh element nay tao ra.
  const newFrames: ScopeFrame[] = [];

  for (const attr of el.attrs) {
    const normalized = normalizeDirectiveName(attr.name);
    const valueSpan = attr.valueSpan;
    const value = attr.value ?? '';

    // ng-controller: nguon link template<->controller tin cay nhat.
    if (normalized === 'ngController' && valueSpan) {
      const m = value.match(/^\s*([^\s]+)(?:\s+as\s+([$\w]+))?\s*$/);
      if (m) {
        const nameOffset = valueSpan.start.offset + value.indexOf(m[1]!);
        const frame: ScopeFrame = {
          kind: 'controller',
          controllerName: m[1]!,
          alias: m[2],
          locals: [],
          elementSpan,
        };
        if (m[2]) {
          const aliasOffset = valueSpan.start.offset + value.lastIndexOf(m[2]);
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
    const base = valueSpan.start.offset;

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

      // QUAN TRONG: chi luu BIEU THUC CON, khong luu ca chuoi microsyntax.
      // `section in sections` khong phai bieu thuc Angular hop le (`in` khong
      // phai toan tu), nen neu luu ca chuoi thi resolver parse lai se hong va
      // bao "vi tri khong nam trong bieu thuc Angular" — dung cho ve phai
      // `sections` la thu nguoi dung hay Ctrl+Click nhat.
      if (rep.collection) {
        pushExpression(
          rep.collection,
          sliceOf(value, base, rep.collectionSpan),
          rep.collectionSpan.start,
          normalized,
          chain, // collection duoc danh gia o scope CHA, khong phai scope moi
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
          message: `Khong parse duoc bieu thuc cua ${attr.name}`,
          span: { start: base, end: base + value.length },
        });
        continue;
      }
      // ng-init dua bien moi vao scope hien tai.
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

    // Thuoc tinh HTML thuong: van co the chua {{ }}
    if (value.includes('{{')) {
      extractInterpolations(value, base, [...newFrames, ...chain], normalized, facts, config);
      continue;
    }

    // Con lai: chua biet la gi. Ghi lai de Linker phan giai o Layer 4.
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
        locals: localsOf(activeChain),
      });
    }
  }

  const childChain = newFrames.length ? [...newFrames.reverse(), ...chain] : chain;
  for (const child of el.children) visit(child, childChain, facts, config);
}

/** Cat doan text ung voi `span` ra khoi gia tri thuoc tinh bat dau tai `base`. */
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
        message: `Khong parse duoc bieu thuc noi suy {{${inner.trim()}}}`,
        span: { start: innerStart, end: innerStart + inner.length },
      });
      continue;
    }
    pushExpression(program, inner, innerStart, source, chain, facts);
  }
}

/** Truc A: bien locals cua EJS va cac lan include. */
function extractEjsAxis(regions: ReturnType<typeof scanEjs>, facts: TemplateFacts): void {
  const vjs = toVirtualJs(regions);
  if (!vjs.code.trim()) return;

  const ast = parseJsTolerant(vjs.code);
  if (!ast) return;

  // Bien khai bao ngay trong template khong phai locals do server bom vao.
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

      // Gom duong dan property: `user.profile.name` -> path ['profile','name'].
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
 * Giao diem truc A x truc B (docs/kien-truc.md muc 0):
 *   <script>window.BOOT = <%- JSON.stringify(data) %>;</script>
 * Day la cho khong tool nao hien co noi duoc hai dau.
 */
function extractBridges(
  source: string,
  regions: ReturnType<typeof scanEjs>,
  facts: TemplateFacts,
): void {
  for (const r of regions) {
    if (r.kind !== 'output-raw' && r.kind !== 'output-escaped') continue;
    // Nhin nguoc lai tim `<ten> =` ngay truoc region.
    const before = source.slice(Math.max(0, r.span.start - 120), r.span.start);
    const m = before.match(/([$\w.[\]'"]+)\s*=\s*$/);
    if (!m) continue;
    // Chi tinh la bridge khi nam trong the <script>.
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
