import * as acorn from 'acorn';
import * as walkLib from 'acorn-walk';
import type {
  Confidence,
  Config,
  JsFacts,
  NgDeclaration,
  NgDeclKind,
  ScopeMember,
  Span,
  ValueShape,
} from '../types';
import { parseJsTolerant, propName, stringOf } from './js-common';
import { extractBindings } from './bindings';

const DECL_METHODS = new Set<NgDeclKind>([
  'controller', 'service', 'factory', 'provider', 'directive',
  'filter', 'component', 'value', 'constant',
]);

/**
 * Trich fact tu mot file .js.
 *
 * BAT BUOC la ham thuan cua `source` (docs/kien-truc.md muc 3).
 */
export function extractJs(source: string, config: Config): JsFacts {
  const facts: JsFacts = {
    kind: 'js',
    declarations: [],
    scopeMembers: [],
    moduleAliases: {},
    events: [],
    bindings: [],
    renderCalls: [],
    parseErrors: [],
  };

  const ast = parseJsTolerant(source);
  if (!ast) {
    facts.parseErrors.push({ message: 'Khong parse duoc file', span: { start: 0, end: source.length } });
    return facts;
  }

  facts.bindings = extractBindings(ast);
  collectModuleAliases(ast, facts);

  const aliasSet = new Set([...Object.keys(facts.moduleAliases), ...config.moduleAliases]);

  walkLib.simple(ast, {
    CallExpression(node) {
      tryExtractDeclaration(node, facts, aliasSet, config);
      tryExtractEvent(node, facts);
      tryExtractRender(node, facts);
    },
  });

  for (const decl of facts.declarations) {
    extractScopeMembers(ast, decl, facts);
  }

  return facts;
}

/**
 * Tim cac bien giu ket qua cua `angular.module(...)`.
 *   const appModule = angular.module("cityosDemo", []);
 *   var myApp = angular.module("app");
 */
function collectModuleAliases(ast: acorn.Program, facts: JsFacts): void {
  walkLib.simple(ast, {
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier' || !node.init) return;
      const moduleName = moduleNameOf(node.init);
      if (moduleName !== null) facts.moduleAliases[node.id.name] = moduleName;
    },
    AssignmentExpression(node) {
      if (node.left.type !== 'Identifier') return;
      const moduleName = moduleNameOf(node.right);
      if (moduleName !== null) facts.moduleAliases[node.left.name] = moduleName;
    },
  });
}

/** Tra ve ten module neu `node` la `angular.module('x', ...)`, nguoc lai null. */
function moduleNameOf(node: acorn.Expression | acorn.Node): string | null {
  if (node.type !== 'CallExpression') return null;
  const call = node as acorn.CallExpression;
  const callee = call.callee;
  if (callee.type !== 'MemberExpression') return null;
  if (callee.computed) return null;
  if (callee.property.type !== 'Identifier' || callee.property.name !== 'module') return null;
  if (callee.object.type !== 'Identifier' || callee.object.name !== 'angular') return null;
  return stringOf(call.arguments[0] as acorn.Node) ?? '<dynamic>';
}

/**
 * Nhan dien mot khai bao Angular.
 *
 * QUAN TRONG — phai xac thuc chuoi module truoc khi nhan.
 * Trong repo smart-city, 54/54 lan `.filter(` la `Array.prototype.filter`, KHONG co
 * Angular filter nao. Cach lam dua regex se cho 100% false positive.
 * Xem docs/kien-truc.md phu luc A.2 muc 5.
 *
 * Ba muc do tin cay:
 *   high   - chuoi bat dau tu `angular.module(...)`, hoac bien da biet giu module,
 *            hoac bien nam trong config.moduleAliases
 *   medium - bien la nay chua ro, nhung doi so dau la chuoi va doi so hai la
 *            function/array/object (dung hinh dang mot khai bao Angular)
 *   (khong nhan) - moi truong hop con lai
 */
function tryExtractDeclaration(
  node: acorn.CallExpression,
  facts: JsFacts,
  aliasSet: Set<string>,
  config: Config,
): void {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return;
  if (callee.property.type !== 'Identifier') return;

  const method = callee.property.name as NgDeclKind;
  if (!DECL_METHODS.has(method)) return;

  const name = stringOf(node.arguments[0] as acorn.Node);
  if (name === null) return; // `.filter(Boolean)`, `.filter(fn)` -> loai ngay tai day

  const second = node.arguments[1];
  if (!second) return;
  // Doi so thu hai phai co hinh dang mot dinh nghia Angular. `CallExpression` duoc
  // chap nhan vi mau factory rat pho bien: `.directive("aocsBarChart", barLike("y"))`
  // — bo qua no se mat 2/3 directive trong web/js/charts.js cua repo smart-city.
  const shapeOk =
    second.type === 'FunctionExpression' ||
    second.type === 'ArrowFunctionExpression' ||
    second.type === 'ArrayExpression' ||
    second.type === 'ObjectExpression' ||
    second.type === 'CallExpression' ||
    second.type === 'MemberExpression' ||
    second.type === 'Identifier' ||
    second.type === 'Literal';
  if (!shapeOk) return;

  const { moduleRef, confidence } = resolveModuleChain(callee.object, facts, aliasSet, config);
  if (confidence === null) return;

  const nameNode = node.arguments[0]!;
  const decl: NgDeclaration = {
    kind: method,
    name,
    nameSpan: { start: nameNode.start, end: nameNode.end },
    bodySpan: { start: node.start, end: node.end },
    moduleRef,
    confidence,
    deps: extractDeps(second),
  };

  if (method === 'directive' || method === 'component') {
    decl.ddo = extractDdo(second);
  }

  facts.declarations.push(decl);
}

/**
 * Di nguoc chuoi `.module(...).controller(...).service(...)` de xem goc co phai module khong.
 */
function resolveModuleChain(
  objectNode: acorn.Expression | acorn.Super,
  facts: JsFacts,
  aliasSet: Set<string>,
  config: Config,
): { moduleRef: string | null; confidence: Confidence | null } {
  let cur: acorn.Node = objectNode;

  for (;;) {
    // angular.module('x', [])
    const direct = moduleNameOf(cur);
    if (direct !== null) return { moduleRef: direct, confidence: 'high' };

    // Bien: appModule / myApp
    if (cur.type === 'Identifier') {
      const ident = (cur as acorn.Identifier).name;
      if (ident in facts.moduleAliases) {
        return { moduleRef: facts.moduleAliases[ident]!, confidence: 'high' };
      }
      if (config.moduleAliases.includes(ident) || aliasSet.has(ident)) {
        // `myApp` la global do platform cap, khong khai bao trong file nay.
        // Xem docs/kien-truc.md phu luc A.4 muc b.
        return { moduleRef: ident, confidence: 'high' };
      }
      // Bien la: chap nhan nhung ha do tin cay, de nguoi dung them vao config.
      return { moduleRef: ident, confidence: 'medium' };
    }

    // Chuoi tiep: `.controller(...).directive(...)` — lui ve mot buoc.
    if (cur.type === 'CallExpression') {
      const call = cur as acorn.CallExpression;
      if (call.callee.type === 'MemberExpression' && !call.callee.computed) {
        cur = call.callee.object;
        continue;
      }
    }
    if (cur.type === 'MemberExpression') {
      cur = (cur as acorn.MemberExpression).object;
      continue;
    }

    return { moduleRef: null, confidence: null };
  }
}

/**
 * Trich danh sach dependency inject vao, ho tro ca ba dang:
 *   function ($scope, UserSvc) {}              - implicit (vo khi minify)
 *   ['$scope', 'UserSvc', function (a, b) {}]  - array annotation
 *   Foo.$inject = ['$scope']                   - xu ly rieng o noi khac
 */
function extractDeps(node: acorn.Node): NgDeclaration['deps'] {
  if (node.type === 'ArrayExpression') {
    const arr = node as acorn.ArrayExpression;
    return arr.elements
      .filter((e): e is acorn.Literal => !!e && e.type === 'Literal' && typeof e.value === 'string')
      .map((e) => ({ name: e.value as string, span: { start: e.start, end: e.end } }));
  }
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    const fn = node as acorn.FunctionExpression;
    return fn.params
      .filter((p): p is acorn.Identifier => p.type === 'Identifier')
      .map((p) => ({ name: p.name, span: { start: p.start, end: p.end } }));
  }
  if (node.type === 'ObjectExpression') {
    // component({controller: [...]}): lay deps tu thuoc tinh controller
    const obj = node as acorn.ObjectExpression;
    for (const prop of obj.properties) {
      if (prop.type !== 'Property') continue;
      if (propName(prop) === 'controller') return extractDeps(prop.value);
    }
  }
  return [];
}

/** Trich directive definition object. */
function extractDdo(node: acorn.Node): NgDeclaration['ddo'] {
  let obj: acorn.ObjectExpression | null = null;
  if (node.type === 'ObjectExpression') obj = node as acorn.ObjectExpression;
  if (node.type === 'ArrayExpression') {
    const last = (node as acorn.ArrayExpression).elements.at(-1);
    if (last && (last.type === 'FunctionExpression' || last.type === 'ArrowFunctionExpression')) {
      obj = returnedObject(last as acorn.FunctionExpression);
    }
  }
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    obj = returnedObject(node as acorn.FunctionExpression);
  }
  if (!obj) return undefined;

  const ddo: NonNullable<NgDeclaration['ddo']> = {};
  for (const prop of obj.properties) {
    if (prop.type !== 'Property') continue;
    const key = propName(prop);
    if (!key) continue;
    switch (key) {
      case 'controllerAs':
        ddo.controllerAs = stringOf(prop.value) ?? undefined;
        break;
      case 'controller':
        ddo.controllerName = stringOf(prop.value) ?? undefined;
        break;
      case 'templateUrl':
        ddo.templateUrl = stringOf(prop.value) ?? undefined;
        break;
      case 'template':
        ddo.templateInline = true;
        break;
      case 'restrict':
        ddo.restrict = stringOf(prop.value) ?? undefined;
        break;
      case 'transclude':
        ddo.transclude = true;
        break;
      case 'scope':
      case 'bindings':
      case 'bindToController': {
        if (prop.value.type !== 'ObjectExpression') break;
        ddo.scopeBindings = {};
        for (const b of prop.value.properties) {
          if (b.type !== 'Property') continue;
          const bk = propName(b);
          const bv = stringOf(b.value);
          if (bk && bv !== null) ddo.scopeBindings[bk] = bv;
        }
        break;
      }
      default:
        break;
    }
  }
  return ddo;
}

function returnedObject(fn: acorn.FunctionExpression | acorn.ArrowFunctionExpression): acorn.ObjectExpression | null {
  if (fn.body.type === 'ObjectExpression') return fn.body as acorn.ObjectExpression;
  if (fn.body.type !== 'BlockStatement') return null;
  for (const stmt of fn.body.body) {
    if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression') {
      return stmt.argument;
    }
  }
  return null;
}

/**
 * Trich cac property gan len $scope / this trong than mot khai bao.
 *
 * Ten bien giu $scope lay tu VI TRI cua '$scope' trong danh sach deps, khong phai
 * tu ten '$scope' co dinh — nho vay van dung khi code da minify hoac doi ten tham so:
 *   ['$scope', 'aocs', function (s, a) { s.busy = ... }]
 */
function extractScopeMembers(ast: acorn.Program, decl: NgDeclaration, facts: JsFacts): void {
  const fnNode = findFunctionFor(ast, decl);
  if (!fnNode) return;

  const scopeParam = scopeParamName(decl, fnNode);
  const alias = decl.ddo?.controllerAs;

  const seen = new Set<string>();

  walkLib.simple(fnNode.body as acorn.Node, {
    AssignmentExpression(node) {
      if (node.left.type !== 'MemberExpression' || node.left.computed) return;
      if (node.left.property.type !== 'Identifier') return;

      const obj = node.left.object;
      let via: ScopeMember['via'] | null = null;
      if (scopeParam && obj.type === 'Identifier' && obj.name === scopeParam) via = '$scope';
      else if (obj.type === 'ThisExpression') via = 'this';
      if (!via) return;

      const name = node.left.property.name;
      const key = via + '.' + name;
      if (seen.has(key)) return; // chi giu lan gan DAU TIEN lam noi khai bao
      seen.add(key);

      facts.scopeMembers.push({
        name,
        via,
        span: { start: node.left.property.start, end: node.left.property.end },
        owner: decl.name,
        shape: inferShape(node.right),
        isWrite: true,
      });
    },
  });

  void alias;
}

/** Tim node function ung voi mot khai bao (doi so thu 2, hoac phan tu cuoi cua array). */
export function findFunctionFor(
  ast: acorn.Program,
  decl: NgDeclaration,
): acorn.FunctionExpression | acorn.ArrowFunctionExpression | null {
  let found: acorn.FunctionExpression | acorn.ArrowFunctionExpression | null = null;

  walkLib.simple(ast, {
    CallExpression(node) {
      if (node.start !== decl.bodySpan.start || node.end !== decl.bodySpan.end) return;
      const arg = node.arguments[1];
      if (!arg) return;
      if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
        found = arg;
        return;
      }
      if (arg.type === 'ArrayExpression') {
        const last = arg.elements.at(-1);
        if (last && (last.type === 'FunctionExpression' || last.type === 'ArrowFunctionExpression')) {
          found = last;
        }
        return;
      }
      if (arg.type === 'ObjectExpression') {
        for (const prop of arg.properties) {
          if (prop.type !== 'Property' || propName(prop) !== 'controller') continue;
          if (prop.value.type === 'FunctionExpression' || prop.value.type === 'ArrowFunctionExpression') {
            found = prop.value;
          } else if (prop.value.type === 'ArrayExpression') {
            const last = prop.value.elements.at(-1);
            if (last && (last.type === 'FunctionExpression' || last.type === 'ArrowFunctionExpression')) {
              found = last;
            }
          }
        }
      }
    },
  });

  return found;
}

export function scopeParamName(
  decl: NgDeclaration,
  fn: acorn.FunctionExpression | acorn.ArrowFunctionExpression,
): string | null {
  const idx = decl.deps.findIndex((d) => d.name === '$scope');
  if (idx === -1) {
    // DI implicit: ten tham so CHINH LA ten service.
    const p = fn.params.find((p) => p.type === 'Identifier' && p.name === '$scope');
    return p ? '$scope' : null;
  }
  const param = fn.params[idx];
  return param && param.type === 'Identifier' ? param.name : null;
}

/**
 * Suy shape tu bieu thuc khoi tao. Du cho completion, khong phai type system.
 * Xem docs/kien-truc.md muc 5.3 va phu luc A.2 muc 4 — pattern thuc te rat "ngoan":
 *   $scope.busy = { search: false, ingest: false, ... }
 */
export function inferShape(node: acorn.Node, depth = 0): ValueShape {
  if (depth > 4) return { kind: 'unknown' };

  switch (node.type) {
    case 'ObjectExpression': {
      const props: Record<string, ValueShape> = {};
      for (const prop of (node as acorn.ObjectExpression).properties) {
        if (prop.type !== 'Property') continue;
        const key = propName(prop);
        if (!key) continue;
        props[key] = {
          ...inferShape(prop.value, depth + 1),
          span: { start: prop.key.start, end: prop.key.end },
        };
      }
      return { kind: 'object', props };
    }
    case 'ArrayExpression': {
      const first = (node as acorn.ArrayExpression).elements.find((e) => e && e.type !== 'SpreadElement');
      return { kind: 'array', element: first ? inferShape(first, depth + 1) : { kind: 'unknown' } };
    }
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const fn = node as acorn.FunctionExpression;
      return {
        kind: 'function',
        params: fn.params.map((p) => (p.type === 'Identifier' ? p.name : '_')),
      };
    }
    case 'Literal':
      return { kind: 'primitive' };
    default:
      return { kind: 'unknown' };
  }
}

/** $emit / $broadcast / $on — "bien dang chuoi" ma khong IDE nao track duoc. */
function tryExtractEvent(node: acorn.CallExpression, facts: JsFacts): void {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed) return;
  if (node.callee.property.type !== 'Identifier') return;
  const m = node.callee.property.name;
  if (m !== '$emit' && m !== '$broadcast' && m !== '$on') return;
  const nameNode = node.arguments[0];
  const name = stringOf(nameNode as acorn.Node);
  if (name === null || !nameNode) return;
  facts.events.push({
    name,
    direction: m === '$on' ? 'on' : m === '$emit' ? 'emit' : 'broadcast',
    span: { start: nameNode.start, end: nameNode.end },
  });
}

/** Truc A: res.render('view', { user, orders }) */
function tryExtractRender(node: acorn.CallExpression, facts: JsFacts): void {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed) return;
  if (node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'render') return;

  const viewNode = node.arguments[0];
  const viewPath = stringOf(viewNode as acorn.Node);
  if (viewPath === null) return;

  const localKeys: string[] = [];
  const second = node.arguments[1];
  if (second && second.type === 'ObjectExpression') {
    for (const prop of second.properties) {
      if (prop.type !== 'Property') continue;
      const key = propName(prop);
      if (key) localKeys.push(key);
    }
  }
  facts.renderCalls.push({
    viewPath,
    localKeys,
    span: { start: node.start, end: node.end },
  });
}

export type { Span };
