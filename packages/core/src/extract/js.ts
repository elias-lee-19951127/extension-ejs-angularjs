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
  TemplateLink,
  ValueShape,
} from '../types';
import { parseJsTolerant, propName, stringOf } from './js-common';
import { extractBindings } from './bindings';

const DECL_METHODS = new Set<NgDeclKind>([
  'controller', 'service', 'factory', 'provider', 'directive',
  'filter', 'component', 'value', 'constant',
]);

/**
 * Extract facts from a .js file.
 *
 * MUST be a pure function of `source` (docs/kien-truc.md section 3).
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
    templateLinks: [],
    parseErrors: [],
  };

  const ast = parseJsTolerant(source);
  if (!ast) {
    facts.parseErrors.push({ message: 'Failed to parse file', span: { start: 0, end: source.length } });
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
      tryExtractRouteLinks(node, facts);
    },
  });

  for (const decl of facts.declarations) {
    extractScopeMembers(ast, decl, facts);
  }

  return facts;
}

/**
 * Find variables holding the result of `angular.module(...)`.
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

/** Returns the module name if `node` is `angular.module('x', ...)`, otherwise null. */
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
 * Recognize an Angular declaration.
 *
 * IMPORTANT — the module chain must be verified before recognizing it.
 * In the smart-city repo, 54/54 occurrences of `.filter(` are `Array.prototype.filter`,
 * NOT an Angular filter. A regex-based approach would give 100% false positives.
 * See docs/kien-truc.md appendix A.2 item 5.
 *
 * Three confidence levels:
 *   high   - the chain starts from `angular.module(...)`, or a variable already known
 *            to hold a module, or a variable listed in config.moduleAliases
 *   medium - the chain's base variable is not yet known, but the first argument is a
 *            string and the second is a function/array/object (matching the shape of
 *            an Angular declaration)
 *   (not recognized) - every other case
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
  if (name === null) return; // `.filter(Boolean)`, `.filter(fn)` -> rejected right here

  const second = node.arguments[1];
  if (!second) return;
  // The second argument must have the shape of an Angular definition. `CallExpression`
  // is accepted because the factory pattern is very common: `.directive("aocsBarChart", barLike("y"))`
  // — skipping it would lose 2/3 of the directives in web/js/charts.js in the smart-city repo.
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
    const obj = ddoObject(second);
    // A component's controller is published on its template's scope as `$ctrl` unless it says otherwise.
    if (obj) pushTemplateLinks(obj, method, name, facts, method === 'component' ? '$ctrl' : null);
  }

  facts.declarations.push(decl);
}

/**
 * Walk back along the `.module(...).controller(...).service(...)` chain to check
 * whether the root is a module.
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

    // Variable: appModule / myApp
    if (cur.type === 'Identifier') {
      const ident = (cur as acorn.Identifier).name;
      if (ident in facts.moduleAliases) {
        return { moduleRef: facts.moduleAliases[ident]!, confidence: 'high' };
      }
      if (config.moduleAliases.includes(ident) || aliasSet.has(ident)) {
        // `myApp` is a global provided by the platform, not declared in this file.
        // See docs/kien-truc.md appendix A.4 item b.
        return { moduleRef: ident, confidence: 'high' };
      }
      // Unknown variable: accept it but lower confidence, letting the user add it to config.
      return { moduleRef: ident, confidence: 'medium' };
    }

    // Chain continues: `.controller(...).directive(...)` — step back one level.
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
 * Extract the list of injected dependencies, supporting all three forms:
 *   function ($scope, UserSvc) {}              - implicit (breaks when minified)
 *   ['$scope', 'UserSvc', function (a, b) {}]  - array annotation
 *   Foo.$inject = ['$scope']                   - handled separately elsewhere
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
    // component({controller: [...]}): get deps from the controller property
    const obj = node as acorn.ObjectExpression;
    for (const prop of obj.properties) {
      if (prop.type !== 'Property') continue;
      if (propName(prop) === 'controller') return extractDeps(prop.value);
    }
  }
  return [];
}

/** The directive definition object: the object itself, or the one its factory returns. */
function ddoObject(node: acorn.Node): acorn.ObjectExpression | null {
  if (node.type === 'ObjectExpression') return node as acorn.ObjectExpression;
  if (node.type === 'ArrayExpression') {
    const last = (node as acorn.ArrayExpression).elements.at(-1);
    if (last && (last.type === 'FunctionExpression' || last.type === 'ArrowFunctionExpression')) {
      return returnedObject(last as acorn.FunctionExpression);
    }
  }
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    return returnedObject(node as acorn.FunctionExpression);
  }
  return null;
}

/** Extract the directive definition object. */
function extractDdo(node: acorn.Node): NgDeclaration['ddo'] {
  const obj = ddoObject(node);
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
 * Extract properties assigned onto $scope / this within a declaration's body.
 *
 * The variable name holding $scope is taken from the POSITION of '$scope' in the
 * deps list, not from a fixed '$scope' name — this way it still works when the
 * code is minified or the parameter is renamed:
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
      if (seen.has(key)) return; // keep only the FIRST assignment as the declaration site
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

/** Find the function node corresponding to a declaration (2nd argument, or the last array element). */
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
    // Implicit DI: the parameter name IS the service name.
    const p = fn.params.find((p) => p.type === 'Identifier' && p.name === '$scope');
    return p ? '$scope' : null;
  }
  const param = fn.params[idx];
  return param && param.type === 'Identifier' ? param.name : null;
}

/**
 * Infer shape from the initializer expression. Good enough for completion, not a
 * type system. See docs/kien-truc.md section 5.3 and appendix A.2 item 4 — the
 * real-world pattern is very "well-behaved":
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

/** $emit / $broadcast / $on — a "string-typed variable" that no IDE tracks. */
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

/**
 * `$routeProvider.when('/path', {templateUrl, controller})` and
 * `$stateProvider.state('name', {templateUrl, controller, views: {...}})` (also the
 * `.state({name, ...})` form). Matched by shape — method name plus an object literal carrying
 * `templateUrl` (directly or in a view) — so `$urlRouterProvider.when('/a', '/b')` or any other
 * unrelated `.when()`/`.state()` contributes nothing.
 */
function tryExtractRouteLinks(node: acorn.CallExpression, facts: JsFacts): void {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed) return;
  if (node.callee.property.type !== 'Identifier') return;
  const method = node.callee.property.name;
  if (method !== 'when' && method !== 'state') return;

  const [first, second] = node.arguments;
  const obj =
    second?.type === 'ObjectExpression' ? second : method === 'state' && first?.type === 'ObjectExpression' ? first : null;
  if (!obj) return;

  if (method === 'when') {
    pushTemplateLinks(obj, 'route', stringOf(first as acorn.Node) ?? '?', facts, null);
    return;
  }
  const stateName = (obj === first ? stringOf(propValue(obj, 'name')) : stringOf(first as acorn.Node)) ?? '?';
  pushTemplateLinks(obj, 'state', stateName, facts, null);
  const views = propValue(obj, 'views');
  if (views?.type !== 'ObjectExpression') return;
  for (const prop of (views as acorn.ObjectExpression).properties) {
    if (prop.type !== 'Property' || prop.value.type !== 'ObjectExpression') continue;
    pushTemplateLinks(prop.value, 'state', `${propName(prop) ?? '?'}@${stateName}`, facts, null);
  }
}

/** Record the `templateUrl` of one definition object, if it has one. */
function pushTemplateLinks(
  obj: acorn.ObjectExpression,
  via: TemplateLink['via'],
  owner: string,
  facts: JsFacts,
  defaultAlias: string | null,
): void {
  const urlNode = propValue(obj, 'templateUrl');
  if (!urlNode) return;
  // `controller: 'ProfileCtrl as vm'` is the inline form of controllerAs.
  const ctrl = stringOf(propValue(obj, 'controller'));
  const inline = ctrl ? /^\s*(\S+)\s+as\s+([\w$]+)\s*$/.exec(ctrl) : null;
  facts.templateLinks.push({
    via,
    owner,
    url: staticString(urlNode),
    urlSpan: { start: urlNode.start, end: urlNode.end },
    controller: inline ? inline[1]! : ctrl,
    controllerAs: inline ? inline[2]! : (stringOf(propValue(obj, 'controllerAs')) ?? defaultAlias),
  });
}

function propValue(obj: acorn.ObjectExpression, key: string): acorn.Node | null {
  for (const prop of obj.properties) {
    if (prop.type === 'Property' && propName(prop) === key) return prop.value;
  }
  return null;
}

/** A string literal, or a template literal with no `${}` in it. */
function staticString(node: acorn.Node): string | null {
  if (node.type === 'TemplateLiteral') {
    const tl = node as acorn.TemplateLiteral;
    return tl.expressions.length === 0 ? (tl.quasis[0]?.value.cooked ?? null) : null;
  }
  return stringOf(node);
}

/** Axis A: res.render('view', { user, orders }) */
function tryExtractRender(node: acorn.CallExpression, facts: JsFacts): void {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed) return;
  if (node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'render') return;

  const viewNode = node.arguments[0];
  const viewPath = stringOf(viewNode as acorn.Node);
  if (viewPath === null) return;

  const locals: Array<{ name: string; span: Span }> = [];
  const second = node.arguments[1];
  if (second && second.type === 'ObjectExpression') {
    for (const prop of second.properties) {
      if (prop.type !== 'Property') continue;
      const key = propName(prop);
      if (key) locals.push({ name: key, span: { start: prop.key.start, end: prop.key.end } });
    }
  }
  facts.renderCalls.push({
    viewPath,
    localKeys: locals.map((l) => l.name),
    span: { start: node.start, end: node.end },
    viewSpan: { start: viewNode!.start, end: viewNode!.end },
    locals,
  });
}

export type { Span };
