import type * as acorn from 'acorn';
import * as walkLib from 'acorn-walk';
import type { Config, JsBinding, NgDeclaration, Span } from '../types';
import { extractJs, findFunctionFor, scopeParamName } from '../extract/js';
import { resolveBinding } from '../extract/bindings';
import { parseJsTolerant } from '../extract/js-common';

/** Mot lan truy cap `$scope.<ten>` — span la cua RIENG ten property. */
export interface ScopeAccess {
  name: string;
  span: Span;
}

/**
 * Moi lan truy cap `$scope.<ten>` trong than mot khai bao, CA DOC LAN GHI.
 *
 * Khac `JsFacts.scopeMembers` — chi giu lan GAN dau tien lam noi khai bao. Rename
 * can moi cho: doi ten `s.init = …` ma bo sot `s.init()` thi code hong.
 *
 * Doi tuong phai la DUNG tham so $scope cua khai bao nay, hoac mot bien bi danh khai
 * bao thang tu no (`var vm = $scope;`). Mot ham long co tham so trung ten
 * (`function (s) {…}`) la bien khac — che bong — khong dong toi.
 *
 * Nhan ca truy cap bang chuoi viet thang (`s['busy']`): bo sot thi JS van ghi ten cu
 * trong khi template da doc ten moi.
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

  // Binding tro toi $scope: chinh tham so, va moi `var x = <tham so>` (theo span khai bao).
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
        // Chi nhan chuoi viet thang: co escape (`'bu\\x73y'`) thi span khong trung ten.
        if (prop.raw?.slice(1, -1) !== prop.value) return;
        out.push({ name: prop.value, span: { start: prop.start + 1, end: prop.end - 1 } });
      }
    },
  });
  return out;
}

/**
 * Moi khai bao Angular trong file, kem cac lan truy cap $scope cua no va ten cac
 * property duoc GAN trong chinh khai bao do.
 * Trich tu noi dung duoc truyen vao, KHONG tu index — index co the cu hon file.
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

/** Tu khoa JavaScript va literal cua Angular — khong dung lam ten property duoc. */
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
  'with', 'yield',
]);

/** Ly do ten moi khong dung duoc, hoac null neu hop le. */
export function newNameProblem(oldName: string, newName: string): string | null {
  if (newName === oldName) return 'Ten moi trung ten cu';
  if (newName.startsWith('$')) return "Ten bat dau bang '$' la danh rieng cho AngularJS";
  if (!/^[A-Za-z_][\w$]*$/.test(newName)) return `'${newName}' khong phai dinh danh hop le`;
  if (RESERVED.has(newName)) return `'${newName}' la tu khoa`;
  return null;
}

/** So dong (1-based) cua mot offset — cho thong bao xung dot. */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

const JS_FILE = /\.js$/i;

/** So thu muc cha chung (tinh tu goc repo) cua hai duong dan tuong doi. */
export function commonDirDepth(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  let n = 0;
  while (n < da.length && n < db.length && da[n] === db[n]) n++;
  return n;
}

/** Cac file trong `candidates` gan `from` nhat theo thu muc — nhieu file neu hoa. */
export function nearestFiles(from: string, candidates: string[]): string[] {
  const depth = candidates.map((c) => commonDirDepth(from, c));
  const best = Math.max(...depth);
  return candidates.filter((_, i) => depth[i] === best);
}

export interface RenameScope {
  js: string[];
  templates: string[];
  /** File khai bao controller cung ten nhung co tinh KHONG sua. */
  untouched: string[];
  /** Thong bao cho nguoi dung khi controller bi khai bao o nhieu file. */
  note?: string;
}

/**
 * Pham vi doi ten khi mot controller bi khai bao o NHIEU file .js (ban sao, phien
 * ban cu/moi…). Lua chon cua nguoi dung (docs/kien-truc.md phu luc I): ghep moi
 * template voi file .js gan no nhat theo thu muc, roi chi doi NHOM chua noi bat dau.
 *
 * Template nam giua hai ban (hoa khoang cach) keo ca hai ban vao nhom — chi doi mot
 * ben thi template do hong voi ben kia. Lan dan toi khi on dinh; keo het thi doi het
 * va bao cho nguoi dung.
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
      ? `'${controller}' duoc khai bao o ${declFiles.length} file — chi doi ban gan nhat, giu nguyen ${untouched.join(', ')}`
      : `'${controller}' duoc khai bao o ${declFiles.length} file va khong phan dinh duoc ban nao gan hon — da doi ca ${declFiles.length}`,
  };
}

/**
 * Vi tri chua `name` nam trong ngu canh TRONG GIONG Angular — gia tri cua thuoc tinh
 * co `ng-` trong ten, hoac ben trong {{ }} — nhung KHONG nam trong vung `parsed`
 * (vung extractor da hieu: bieu thuc, cho khai bao bien cuc bo…). Cho da parse duoc ma
 * khong duoc doi (controller khac, bien ng-repeat, khoa object) khong phai cho sot.
 *
 * Day la cho extractor KHONG trich duoc. Rename khong sua chung (khong doan bua) ma
 * chi bao de nguoi dung kiem tay. Nguyen nhan da gap that (smart-city/new-version):
 * thut le bang U+2003 — trinh duyet khong coi la khoang trang trong the, nen
 * `␣␣data-ng-disabled` khong phai directive, va lexer Angular tu choi `{{` chua no.
 */
export function unparsedOccurrences(source: string, name: string, parsed: Span[]): number[] {
  const regions: Span[] = [];
  // `\s` cua JS khop ca U+2003, nen van tach dung ten thuoc tinh du thut le bang ky tu la.
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
    // `'busy'` trong bieu thuc la CHUOI, khong phai tham chieu.
    const before = source[at - 1];
    if (at !== region.start && (before === "'" || before === '"')) continue;
    out.push(at);
  }
  return out;
}
