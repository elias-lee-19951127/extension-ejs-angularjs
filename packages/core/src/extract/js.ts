import * as acorn from 'acorn';
import * as walkLib from 'acorn-walk';
import { posix } from 'node:path';
import type {
  Confidence,
  Config,
  ConsoleCall,
  JsBinding,
  JsFacts,
  NgDeclaration,
  NgDeclKind,
  ScopeMember,
  ScopeTarget,
  ScopeWrite,
  ServerRoot,
  Span,
  TemplateLink,
  ValueShape,
} from '../types';
import { parseJsTolerant, propName, stringOf } from './js-common';
import { extractBindings, resolveBinding } from './bindings';

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
    scopeWrites: [],
    consoleCalls: [],
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
  const ctx = fileContext(ast, source);

  walkLib.simple(ast, {
    CallExpression(node) {
      tryExtractDeclaration(node, facts, aliasSet, config, ctx);
      tryExtractEvent(node, facts);
      tryExtractRender(node, facts);
      tryExtractRouteLinks(node, facts, ctx);
      tryExtractServerRoots(node, facts);
    },
  });
  extractOtherTemplateLinks(ast, facts, ctx);

  for (const decl of facts.declarations) {
    extractScopeMembers(ast, decl, facts);
    extractScopeWrites(ast, decl, facts, source);
    extractConsoleCalls(ast, decl, facts);
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
  ctx: FileContext,
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
    const obj = ddoObject(second, ctx.ast);
    decl.ddo = obj ? extractDdo(obj) : undefined;
    // A component's controller is published on its template's scope as `$ctrl` unless it says otherwise.
    if (obj) pushTemplateLinks(obj, method, name, facts, method === 'component' ? '$ctrl' : null, ctx, name);
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
function ddoObject(node: acorn.Node, ast?: acorn.Program): acorn.ObjectExpression | null {
  if (node.type === 'ObjectExpression') return node as acorn.ObjectExpression;
  // `.directive('x', xDirective)` with `function xDirective() { … }` elsewhere in the file.
  if (node.type === 'Identifier' && ast) {
    const fn = localFunction(ast, (node as acorn.Identifier).name);
    return fn ? returnedObject(fn) : null;
  }
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
function extractDdo(obj: acorn.ObjectExpression): NgDeclaration['ddo'] {
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
    // `var directive = { … }; return directive;`
    if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'Identifier') {
      const name = stmt.argument.name;
      for (const other of fn.body.body) {
        if (other.type !== 'VariableDeclaration') continue;
        for (const d of other.declarations) {
          if (d.id.type === 'Identifier' && d.id.name === name && d.init?.type === 'ObjectExpression') return d.init;
        }
      }
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
  const seen = new Set<string>();
  for (const { fn, scopeParam } of scopeFunctionsFor(ast, decl)) extractScopeMembersIn(fn, scopeParam, decl, facts, seen);
}

function extractScopeMembersIn(
  fnNode: FnNode,
  scopeParam: string | null,
  decl: NgDeclaration,
  facts: JsFacts,
  seen: Set<string>,
): void {
  const isThisAlias = thisAliasTest(fnNode, facts.bindings);

  walkLib.simple(fnNode.body as acorn.Node, {
    AssignmentExpression(node) {
      if (node.left.type !== 'MemberExpression' || node.left.computed) return;
      if (node.left.property.type !== 'Identifier') return;

      const obj = node.left.object;
      let via: ScopeMember['via'] | null = null;
      if (scopeParam && obj.type === 'Identifier' && obj.name === scopeParam) via = '$scope';
      else if (obj.type === 'ThisExpression' || isThisAlias(obj)) via = 'this';
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
}

/** Find the function node corresponding to a declaration (2nd argument, or the last array element). */
export function findFunctionFor(
  ast: acorn.Program,
  decl: NgDeclaration,
): acorn.FunctionExpression | acorn.ArrowFunctionExpression | null {
  let found: acorn.FunctionExpression | acorn.ArrowFunctionExpression | null = null;

  if (decl.inline) {
    // An inline controller's body span IS its function.
    walkLib.simple(ast, {
      Function(node) {
        if (node.start === decl.bodySpan.start && node.end === decl.bodySpan.end) found = node as unknown as FnNode;
      },
    });
    return found;
  }

  walkLib.simple(ast, {
    CallExpression(node) {
      if (node.start !== decl.bodySpan.start || node.end !== decl.bodySpan.end) return;
      const arg = node.arguments[1];
      if (!arg) return;
      if (arg.type === 'Identifier') {
        found = localFunction(ast, arg.name); // `.controller('ListCtrl', ListCtrl)`
        return;
      }
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
 * Tests whether a node is a variable holding the controller instance: `var vm = this;` (or
 * `self`, `ctrl`…) declared in the controller's own body — the usual controllerAs style. Resolved
 * through the bindings, so a nested parameter that happens to be called `vm` doesn't count.
 *
 * Unlike `this`, such a variable still means the controller inside a nested callback. A
 * `var x = this` inside a nested non-arrow function captures THAT function's `this` — ignored.
 */
function thisAliasTest(
  fn: acorn.FunctionExpression | acorn.ArrowFunctionExpression,
  bindings: JsBinding[],
): (node: acorn.Node) => boolean {
  if (fn.type === 'ArrowFunctionExpression') return () => false; // an arrow has no `this` of its own
  const declared = new Set<number>();
  walkLib.ancestor(fn.body as acorn.Node, {
    VariableDeclarator(node, _state, ancestors) {
      if (node.id.type !== 'Identifier' || node.init?.type !== 'ThisExpression') return;
      const ownThis = (ancestors as acorn.Node[]).some(
        (a) => a !== node && (a.type === 'FunctionExpression' || a.type === 'FunctionDeclaration'),
      );
      if (!ownThis) declared.add(node.id.start);
    },
  });
  if (!declared.size) return () => false;
  return (node) => {
    if (node.type !== 'Identifier') return false;
    const binding = resolveBinding(bindings, (node as acorn.Identifier).name, node.start);
    return !!binding && declared.has(binding.span.start);
  };
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
    case 'Literal': {
      const lit = node as acorn.Literal;
      if (lit.regex || lit.bigint) return { kind: 'primitive' };
      const v = lit.value;
      if (v === null) return { kind: 'primitive', primitive: 'null' };
      if (typeof v === 'string') return { kind: 'primitive', primitive: 'string' };
      if (typeof v === 'number') return { kind: 'primitive', primitive: 'number' };
      if (typeof v === 'boolean') return { kind: 'primitive', primitive: 'boolean' };
      return { kind: 'primitive' };
    }
    case 'TemplateLiteral':
      return { kind: 'primitive', primitive: 'string' };
    case 'Identifier':
      return (node as acorn.Identifier).name === 'undefined' ? { kind: 'primitive', primitive: 'undefined' } : { kind: 'unknown' };
    case 'UnaryExpression': {
      const op = (node as acorn.UnaryExpression).operator;
      if (op === '!' || op === 'delete') return { kind: 'primitive', primitive: 'boolean' };
      if (op === 'typeof') return { kind: 'primitive', primitive: 'string' };
      if (op === 'void') return { kind: 'primitive', primitive: 'undefined' };
      return { kind: 'primitive', primitive: 'number' }; // - + ~
    }
    case 'BinaryExpression': {
      const bin = node as acorn.BinaryExpression;
      if (COMPARISON_OPS.has(bin.operator)) return { kind: 'primitive', primitive: 'boolean' };
      if (bin.operator !== '+') return { kind: 'primitive', primitive: 'number' };
      // `+` is a string as soon as either side is one; two numbers stay a number; anything else is unknown.
      const l = inferShape(bin.left as acorn.Node, depth + 1);
      const r = inferShape(bin.right, depth + 1);
      if (l.primitive === 'string' || r.primitive === 'string') return { kind: 'primitive', primitive: 'string' };
      if (l.primitive === 'number' && r.primitive === 'number') return { kind: 'primitive', primitive: 'number' };
      return { kind: 'unknown' };
    }
    default:
      return { kind: 'unknown' };
  }
}

const COMPARISON_OPS = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=', 'instanceof', 'in']);

/**
 * Every assignment onto the declaration's scope, nested ones included — see `ScopeWrite`.
 *
 * Recognizes the scope the same way `extractScopeMembers` does (the `$scope` parameter by its DI
 * position, `this`, or a `var vm = this` alias), with one difference: `this` inside a non-arrow function nested in the
 * body is that function's own `this`, not the controller, so it is not counted here.
 */
function extractScopeWrites(ast: acorn.Program, decl: NgDeclaration, facts: JsFacts, source: string): void {
  for (const { fn, scopeParam } of scopeFunctionsFor(ast, decl)) extractScopeWritesIn(fn, scopeParam, decl, facts, source);
}

function extractScopeWritesIn(fnNode: FnNode, scopeParam: string | null, decl: NgDeclaration, facts: JsFacts, source: string): void {
  const isThisAlias = thisAliasTest(fnNode, facts.bindings);

  walkLib.ancestor(fnNode.body as acorn.Node, {
    AssignmentExpression(node, _state, ancestors) {
      const target = scopePath(node.left as acorn.Node, scopeParam, isThisAlias);
      if (!target) return;

      // Functions between the declaration's own function and this assignment.
      const nested = (ancestors as acorn.Node[]).filter(
        (a) => a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression' || a.type === 'FunctionDeclaration',
      );
      if (target.thisKeyword && nested.some((f) => f.type !== 'ArrowFunctionExpression')) return;

      let right: acorn.Node = node.right;
      while (right.type === 'AssignmentExpression') right = (right as acorn.AssignmentExpression).right; // a = b = 0
      const leaves = valueLeaves(right);
      const nullish = leaves.filter(isNullish);

      const after = statementEnd(ancestors as acorn.Node[]);
      facts.scopeWrites.push({
        owner: decl.name,
        via: target.via,
        path: target.path,
        span: target.span,
        shapes: leaves.filter((l) => !isNullish(l)).map((l) => inferShape(l)),
        nullable: nullish.length > 0,
        inCallback: nested.length > 0,
        rhsText: source.slice(right.start, right.end).replace(/\s+/g, ' ').slice(0, 40),
        lhsText: source.slice(node.left.start, node.left.end),
        ...(after !== null ? { after } : {}),
      });
    },
  });
}

/**
 * Direct `console.<method>(…)` calls in a declaration's body whose arguments read the scope
 * (observed-types-r1 decisions #1, #2): each argument that is a plain `$scope.a.b` / `this.a` /
 * `vm.a` chain becomes a `ScopeTarget`, by the same rules as `extractScopeWrites` — `this` in a
 * nested non-arrow function is not the controller. Not a console call: a `console` that is a
 * local variable, `console['log']`, a wrapper (`logger.debug(x)` — it may add or drop arguments).
 * Arguments after a spread (`...xs`) no longer line up with what the runtime receives: `null`.
 */
function extractConsoleCalls(ast: acorn.Program, decl: NgDeclaration, facts: JsFacts): void {
  for (const { fn, scopeParam } of scopeFunctionsFor(ast, decl)) extractConsoleCallsIn(fn, scopeParam, decl, facts);
}

function extractConsoleCallsIn(fnNode: FnNode, scopeParam: string | null, decl: NgDeclaration, facts: JsFacts): void {
  const isThisAlias = thisAliasTest(fnNode, facts.bindings);

  walkLib.ancestor(fnNode.body as acorn.Node, {
    CallExpression(node, _state, ancestors) {
      const callee = node.callee;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
      if (callee.object.type !== 'Identifier' || callee.object.name !== 'console') return;
      if (resolveBinding(facts.bindings, 'console', callee.object.start)) return; // a local `console`, not the global one
      const method = { start: callee.property.start, end: callee.property.end };
      // Nested declarations share a body: record each call once.
      if (facts.consoleCalls.some((c) => c.method.start === method.start)) return;

      const inOwnFunction = !(ancestors as acorn.Node[]).some(
        (a) => a !== node && (a.type === 'FunctionExpression' || a.type === 'FunctionDeclaration'),
      );
      let spread = false;
      const args = node.arguments.map((arg): ScopeTarget | null => {
        if (arg.type === 'SpreadElement') spread = true;
        if (spread) return null;
        const target = scopePath(arg as acorn.Node, scopeParam, isThisAlias);
        if (!target || (target.thisKeyword && !inOwnFunction)) return null;
        return { owner: decl.name, path: target.path };
      });
      if (args.some((a) => a)) facts.consoleCalls.push({ method, args });
    },
  });
}

/** A place a logpoint can be set with its message already written (log-lens spec #1). */
export interface LogTarget {
  /** Line of the assignment — where the CodeLens goes (0-based). */
  lensLine: number;
  /** Right after the assignment's statement, where the logpoint runs AFTER it (0-based). */
  line: number;
  character: number;
  /** The left side as written: `$scope.rows`. */
  expression: string;
  /** `rows = {$scope.rows}`. */
  logMessage: string;
  /**
   * The index worked out what this assignment holds. `false` — assigned from a call, a response —
   * is where logging teaches the most, and is what the lens shows by default (spec #2).
   */
  inferred: boolean;
}

/**
 * Every assignment to a scope in a file that a logpoint could follow (log-lens ticket 01). One per
 * line: two assignments on one line would put two lenses on top of each other. Assignments with no
 * "right after" (`return $scope.x = y`, a concise arrow body) are left out — there is nowhere for
 * the logpoint to run after them.
 */
export function logTargetsIn(facts: JsFacts, source: string): LogTarget[] {
  const byLine = new Map<number, LogTarget>();
  for (const w of facts.scopeWrites) {
    if (w.after === undefined || !w.lhsText) continue;
    const lensLine = lineOf(source, w.span.start);
    if (byLine.has(lensLine)) continue;
    const after = lineOf(source, w.after);
    byLine.set(lensLine, {
      lensLine,
      line: after,
      character: w.after - (source.lastIndexOf('\n', w.after - 1) + 1),
      expression: w.lhsText,
      logMessage: `${w.path[w.path.length - 1] ?? w.lhsText} = {${w.lhsText}}`,
      inferred: !w.shapes.some((sh) => sh.kind === 'unknown'),
    });
  }
  return [...byLine.values()];
}

function lineOf(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** Why there is nothing to log at a position (log-here spec #4) — the client turns these into sentences. */
export type LogHereReason = 'call' | 'this-in-callback' | 'unparsable' | 'nothing-here';

export type LogHereResult =
  | { target: Omit<LogTarget, 'lensLine' | 'inferred'> }
  | { reason: LogHereReason };

/**
 * What to log for the cursor (log-here ticket 01): the selection if there is one, else the property
 * chain under the cursor, else whatever the line assigns. Placed right after the statement when it
 * is that statement's assignment target — so the value logged is the one just assigned — and at the
 * start of the line otherwise, where it is the value the line is about to use.
 *
 * Refuses, rather than logging something misleading: a call would RUN on every hit, and `this`
 * inside a nested non-arrow function is not the controller any more.
 */
export function logHereAt(source: string, facts: JsFacts, offset: number, selection?: string): LogHereResult {
  const ast = parseJsTolerant(source);
  if (!ast) return { reason: 'unparsable' };
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEnd = source.indexOf('\n', offset) === -1 ? source.length : source.indexOf('\n', offset);

  const picked = pickExpression(ast, source, offset, lineStart, lineEnd, selection);
  if ('reason' in picked) return picked;
  const { expression, node } = picked;
  // A call would RUN on every hit. Both when the cursor is inside one and when it is on the name
  // being called — pointing at `load` in `load()` means the call, not the function object.
  if (/\(/.test(expression) || (node && isCallee(ast, node))) return { reason: 'call' };

  // `this` only means the controller in the declaration's own body (same rule as scopeWrites).
  if (/^\s*this\b/.test(expression) && node && inNestedFunction(ast, node.start)) return { reason: 'this-in-callback' };

  const after = node ? statementEndFor(ast, node) : null;
  const at = after ?? lineStart + (/^\s*/.exec(source.slice(lineStart, lineEnd))?.[0].length ?? 0);
  const name = expression.slice(expression.lastIndexOf('.') + 1).trim() || expression;
  return {
    target: {
      line: countLines(source, at),
      character: at - (source.lastIndexOf('\n', Math.max(0, at - 1)) + 1),
      expression,
      logMessage: `${name} = {${expression}}`,
    },
  };
}

/** The selection, the chain under the cursor, or what the line assigns — in that order (spec #2). */
function pickExpression(
  ast: acorn.Program,
  source: string,
  offset: number,
  lineStart: number,
  lineEnd: number,
  selection?: string,
): { expression: string; node: acorn.Node | null } | { reason: LogHereReason } {
  const selected = selection?.trim();
  if (selected) {
    try {
      const expr = acorn.parseExpressionAt(selected, 0, { ecmaVersion: 'latest' });
      if (selected.slice(expr.end).trim()) return { reason: 'unparsable' };
    } catch {
      return { reason: 'unparsable' };
    }
    // Anchored at the cursor: that is where the selection sits, and what decides its placement.
    return { expression: selected, node: nodeAt(ast, offset) };
  }

  const chain = chainAt(ast, offset);
  if (chain) return { expression: source.slice(chain.start, chain.end), node: chain };

  // Nothing under the cursor: fall back to what this line assigns, like the CodeLens.
  const write = assignmentOnLine(ast, lineStart, lineEnd);
  if (write) return { expression: source.slice(write.left.start, write.left.end), node: write.left as acorn.Node };
  return { reason: 'nothing-here' };
}

/** The outermost `a.b.c` (or bare identifier) covering `offset`, computed keys and calls aside. */
function chainAt(ast: acorn.Program, offset: number): acorn.Node | null {
  let found: acorn.Node | null = null;
  walkLib.full(ast, (node) => {
    if (node.start > offset || node.end < offset) return;
    if (node.type === 'Identifier' || node.type === 'ThisExpression') {
      if (!found || node.start <= found.start) found = node;
      return;
    }
    if (node.type !== 'MemberExpression') return;
    const m = node as acorn.MemberExpression;
    if (m.computed || m.property.type !== 'Identifier') return;
    // Prefer the longest chain that still ends at or before the cursor's own segment.
    if (!found || (node.start <= found.start && node.end >= found.end)) found = node;
  });
  return found;
}

/** The innermost node covering `offset`, for placement when a selection gave no node of its own. */
function nodeAt(ast: acorn.Program, offset: number): acorn.Node | null {
  let found: acorn.Node | null = null;
  walkLib.full(ast, (node) => {
    if (node.start <= offset && node.end >= offset && (!found || node.start >= found.start)) found = node;
  });
  return found;
}

/**
 * An assignment — or an initialized `const`/`let`/`var` — whose left side is on this line: what
 * the line is "about".
 */
function assignmentOnLine(ast: acorn.Program, lineStart: number, lineEnd: number): { left: acorn.Node } | null {
  let found: { left: acorn.Node } | null = null;
  const onLine = (left: acorn.Node) => !found && left.start >= lineStart && left.start <= lineEnd;
  walkLib.simple(ast, {
    AssignmentExpression(node) {
      if (onLine(node.left as acorn.Node)) found = { left: node.left as acorn.Node };
    },
    VariableDeclarator(node) {
      if (node.init && node.id.type === 'Identifier' && onLine(node.id)) found = { left: node.id };
    },
  });
  return found;
}

/**
 * End of the statement `node` belongs to, when `node` is that statement's assignment target — or
 * is declared by it (`const payload = …`): logging a `const`/`let` before its declaration has run
 * reads it in its temporal dead zone (TDZ) and fails, so it must go after. A loop head
 * (`for (const x of xs)`) has no "after" of its own: `null`.
 */
function statementEndFor(ast: acorn.Program, node: acorn.Node): number | null {
  let end: number | null = null;
  walkLib.ancestor(ast, {
    AssignmentExpression(assignment, _state, ancestors) {
      if (assignment.left.start !== node.start || assignment.left.end !== node.end) return;
      end = statementEnd([...(ancestors as acorn.Node[])]);
    },
    VariableDeclarator(declarator, _state, ancestors) {
      if (!declarator.init || node.start < declarator.id.start || node.end > declarator.id.end) return;
      const chain = ancestors as acorn.Node[];
      const declaration = chain[chain.length - 2];
      const holder = chain[chain.length - 3];
      if (declaration?.type !== 'VariableDeclaration' || !holder || /^For/.test(holder.type)) return;
      end = declaration.end;
    },
  });
  return end;
}

/** Is `node` the thing being called in `f()` / `a.b()`? */
function isCallee(ast: acorn.Program, node: acorn.Node): boolean {
  let callee = false;
  walkLib.simple(ast, {
    CallExpression(call) {
      if (call.callee.start <= node.start && call.callee.end >= node.end) callee = true;
    },
  });
  return callee;
}

/** Is `offset` inside a non-arrow function nested in the file — where `this` is that function's? */
function inNestedFunction(ast: acorn.Program, offset: number): boolean {
  let nested = false;
  walkLib.ancestor(ast, {
    ThisExpression(node, _state, ancestors) {
      if (node.start !== offset && !(node.start <= offset && node.end >= offset)) return;
      const functions = (ancestors as acorn.Node[]).filter((a) => a.type === 'FunctionExpression' || a.type === 'FunctionDeclaration');
      // The declaration's own function is the first; anything further in owns its own `this`.
      if (functions.length > 1) nested = true;
    },
  });
  return nested;
}

function countLines(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** The `console.*` call whose method name starts at `offset` — where V8 puts the frame of a console call. */
export function consoleCallAt(facts: JsFacts, offset: number): ConsoleCall | null {
  return (facts.consoleCalls ?? []).find((c) => c.method.start === offset) ?? null;
}

/**
 * The scope variable a logpoint expression (`vm.rows`, `$scope.form.owner`) reads when it runs at
 * `offset` in a file — by the rules `extractConsoleCalls` applies to a console argument, in the
 * innermost Angular declaration whose function contains `offset`. `null` for anything that isn't
 * a plain property chain on the scope (`rows.length` of a local, `a || b`, `x[0]`, a call).
 */
export function scopeTargetAt(source: string, facts: JsFacts, offset: number, expression: string): ScopeTarget | null {
  let expr: acorn.Expression;
  try {
    expr = acorn.parseExpressionAt(expression, 0, { ecmaVersion: 'latest' });
  } catch {
    return null;
  }
  if (expression.slice(expr.end).trim()) return null; // `a.b c`: more than one expression
  const ast = parseJsTolerant(source);
  if (!ast) return null;

  let best: { decl: NgDeclaration; fn: acorn.FunctionExpression | acorn.ArrowFunctionExpression } | null = null;
  for (const decl of facts.declarations) {
    const fn = findFunctionFor(ast, decl);
    if (!fn || offset < fn.body.start || offset >= fn.body.end) continue;
    if (!best || fn.body.start >= best.fn.body.start) best = { decl, fn };
  }
  if (!best) return null;
  const { decl, fn } = best;

  // The expression's root identifier is resolved where the logpoint runs, not where it was parsed.
  const isThisAlias = thisAliasTest(fn, facts.bindings);
  const atOffset = (node: acorn.Node): acorn.Node => (node.type === 'Identifier' ? { ...node, start: offset, end: offset } : node);
  const target = scopePath(expr as acorn.Node, scopeParamName(decl, fn), (node) => isThisAlias(atOffset(node)));
  if (!target) return null;
  if (target.thisKeyword) {
    let ownThis = true;
    walkLib.simple(fn.body as acorn.Node, {
      Function(node) {
        if (node.type !== 'ArrowFunctionExpression' && node.body.start <= offset && offset < node.body.end) ownThis = false;
      },
    });
    if (!ownThis) return null;
  }
  return { owner: decl.name, path: target.path };
}

/**
 * End of the expression statement an assignment is — `ancestors` ends with the assignment itself.
 * Climbs through chained assignments (`a = b = x;`: `b = x` is the right side of `a = …`); any
 * other parent (`return`, a call, an `if` test, a concise arrow body) means it isn't a statement
 * of its own, and there is no "right after it" to put a logpoint.
 */
function statementEnd(ancestors: acorn.Node[]): number | null {
  let i = ancestors.length - 1;
  while (i > 0) {
    const parent = ancestors[i - 1]!;
    const node = ancestors[i]!;
    if (parent.type === 'AssignmentExpression' && (parent as acorn.AssignmentExpression).right === node) {
      i--;
      continue;
    }
    if (parent.type === 'ExpressionStatement' && (parent as acorn.ExpressionStatement).expression === node) return parent.end;
    return null;
  }
  return null;
}

/**
 * `$scope.a.b` / `this.a.b` / `vm.a.b` (`vm = this`) -> `{ via, path: ['a', 'b'] }`; anything else
 * (computed keys included) -> null. `thisKeyword`: written with `this` itself, whose meaning a
 * nested function changes.
 */
function scopePath(
  node: acorn.Node,
  scopeParam: string | null,
  isThisAlias: (node: acorn.Node) => boolean,
): { via: ScopeWrite['via']; path: string[]; span: Span; thisKeyword: boolean } | null {
  const path: string[] = [];
  let cur = node;
  let span: Span | null = null;
  while (cur.type === 'MemberExpression') {
    const m = cur as acorn.MemberExpression;
    if (m.computed || m.property.type !== 'Identifier') return null;
    path.unshift(m.property.name);
    span ??= { start: m.property.start, end: m.property.end };
    cur = m.object;
  }
  if (!span) return null;
  if (cur.type === 'ThisExpression') return { via: 'this', path, span, thisKeyword: true };
  if (isThisAlias(cur)) return { via: 'this', path, span, thisKeyword: false };
  if (scopeParam && cur.type === 'Identifier' && (cur as acorn.Identifier).name === scopeParam) {
    return { via: '$scope', path, span, thisKeyword: false };
  }
  return null;
}

/** The values an expression can evaluate to: each branch of `a ? b : c`, both sides of `a || b` / `a ?? b` / `a && b`. */
function valueLeaves(node: acorn.Node): acorn.Node[] {
  if (node.type === 'ConditionalExpression') {
    const c = node as acorn.ConditionalExpression;
    return [...valueLeaves(c.consequent), ...valueLeaves(c.alternate)];
  }
  if (node.type === 'LogicalExpression') {
    const l = node as acorn.LogicalExpression;
    return [...valueLeaves(l.left), ...valueLeaves(l.right)];
  }
  return [node];
}

function isNullish(node: acorn.Node): boolean {
  if (node.type === 'Literal') return (node as acorn.Literal).value === null && !(node as acorn.Literal).regex;
  if (node.type === 'Identifier') return (node as acorn.Identifier).name === 'undefined';
  return node.type === 'UnaryExpression' && (node as acorn.UnaryExpression).operator === 'void';
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
function tryExtractRouteLinks(node: acorn.CallExpression, facts: JsFacts, ctx: FileContext): void {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed) return;
  if (node.callee.property.type !== 'Identifier') return;
  const method = node.callee.property.name;
  if (method !== 'when' && method !== 'state') return;

  const [first, second] = node.arguments;
  const obj =
    second?.type === 'ObjectExpression' ? second : method === 'state' && first?.type === 'ObjectExpression' ? first : null;
  if (!obj) return;

  if (method === 'when') {
    pushTemplateLinks(obj, 'route', stringOf(first as acorn.Node) ?? '?', facts, null, ctx);
    return;
  }
  const stateName = (obj === first ? stringOf(propValue(obj, 'name')) : stringOf(first as acorn.Node)) ?? '?';
  pushTemplateLinks(obj, 'state', stateName, facts, null, ctx);
  const views = propValue(obj, 'views');
  if (views?.type !== 'ObjectExpression') return;
  for (const prop of (views as acorn.ObjectExpression).properties) {
    if (prop.type !== 'Property' || prop.value.type !== 'ObjectExpression') continue;
    pushTemplateLinks(prop.value, 'state', `${propName(prop) ?? '?'}@${stateName}`, facts, null, ctx);
  }
}

/**
 * Record the `templateUrl` of one definition object, if it has one, and the controller that will own
 * the template's scope: a name (`'ListCtrl'`, `'ListCtrl as vm'`), or — for a controller written as
 * a function (inline, or a variable naming one in this file) — the directive/component itself
 * (`declName`), whose scope members it already collects, or else an `inline` declaration made for it.
 */
function pushTemplateLinks(
  obj: acorn.ObjectExpression,
  via: TemplateLink['via'],
  owner: string,
  facts: JsFacts,
  defaultAlias: string | null,
  ctx: FileContext,
  declName: string | null = null,
): void {
  const urlNode = propValue(obj, 'templateUrl');
  if (!urlNode || ctx.seen.has(urlNode.start)) return;
  ctx.seen.add(urlNode.start);
  const value = templateUrlValue(urlNode, ctx);

  const ctrlNode = propValue(obj, 'controller');
  const ctrl = ctrlNode ? foldString(ctrlNode, ctx) : null;
  // `controller: 'ProfileCtrl as vm'` is the inline form of controllerAs.
  const inline = ctrl ? /^\s*(\S+)\s+as\s+([\w$]+)\s*$/.exec(ctrl) : null;
  let controller: string | null = inline ? inline[1]! : ctrl;
  if (!controller && ctrlNode) {
    const fn = controllerFunction(ctrlNode, ctx.ast);
    if (declName && (fn || ctrlNode.type !== 'Identifier')) controller = declName;
    else if (fn) controller = pushInlineController(fn, ctrlNode, `${owner}#L${lineOf(ctx.source, ctrlNode.start) + 1}`, facts);
    else if (ctrlNode.type === 'Identifier') controller = (ctrlNode as acorn.Identifier).name; // registered elsewhere
  }
  // A directive with no controller still owns its template's scope through `link`.
  if (!controller && !ctrlNode && declName) controller = declName;
  facts.templateLinks.push({
    via,
    owner,
    url: value.url,
    urlSpan: value.span,
    ...(value.suffixOnly ? { suffixOnly: true as const } : {}),
    controller,
    controllerAs: inline ? inline[2]! : (stringOf(propValue(obj, 'controllerAs')) ?? defaultAlias),
  });
}

/** A declaration for a controller that has no name — see `NgDeclaration.inline`. */
function pushInlineController(fn: ControllerFunction, ctrlNode: acorn.Node, label: string, facts: JsFacts): string {
  const name = `inline:${label}`;
  facts.declarations.push({
    kind: 'controller',
    name,
    nameSpan: { start: ctrlNode.start, end: ctrlNode.end },
    bodySpan: { start: fn.fn.start, end: fn.fn.end },
    moduleRef: null,
    confidence: 'medium',
    deps: fn.deps,
    inline: true,
  });
  return name;
}

/** Every other `templateUrl`: any object literal carrying one, and `$ionicModal.fromTemplateUrl('x.html')`. */
function extractOtherTemplateLinks(ast: acorn.Program, facts: JsFacts, ctx: FileContext): void {
  walkLib.ancestor(ast, {
    ObjectExpression(node, _state, ancestors) {
      if (!propValue(node, 'templateUrl')) return;
      const parent = (ancestors as acorn.Node[]).at(-2);
      pushTemplateLinks(node, 'other', ownerOf(node, parent, ctx.source), facts, null, ctx);
    },
    CallExpression(node) {
      const callee = node.callee;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
      if (callee.property.name !== 'fromTemplateUrl') return;
      const arg = node.arguments[0] as acorn.Node | undefined;
      if (!arg || ctx.seen.has(arg.start)) return;
      ctx.seen.add(arg.start);
      const value = templateUrlValue(arg, ctx);
      facts.templateLinks.push({
        via: 'other',
        owner: ctx.source.slice(callee.start, callee.end).replace(/\s+/g, ''),
        url: value.url,
        urlSpan: value.span,
        ...(value.suffixOnly ? { suffixOnly: true as const } : {}),
        controller: null,
        controllerAs: null,
      });
    },
  });
}

/** A readable name for an object literal: the call it's passed to, the variable or key holding it. */
function ownerOf(obj: acorn.Node, parent: acorn.Node | undefined, source: string): string {
  if (parent?.type === 'CallExpression') {
    const callee = (parent as acorn.CallExpression).callee;
    return source.slice(callee.start, callee.end).replace(/\s+/g, '').slice(-40);
  }
  if (parent?.type === 'VariableDeclarator' && (parent as acorn.VariableDeclarator).id.type === 'Identifier') {
    return ((parent as acorn.VariableDeclarator).id as acorn.Identifier).name;
  }
  if (parent?.type === 'Property') return propName(parent as acorn.Property) ?? '?';
  if (parent?.type === 'AssignmentExpression') {
    const left = (parent as acorn.AssignmentExpression).left;
    return source.slice(left.start, left.end).slice(-40);
  }
  return `object@L${lineOf(source, obj.start) + 1}`;
}


// ---------------------------------------------------------------- reading values statically

type FnNode = acorn.FunctionExpression | acorn.ArrowFunctionExpression;

/** What reading `templateUrl`s and controllers needs from the whole file. */
interface FileContext {
  ast: acorn.Program;
  source: string;
  /** `var BASE = 'app/views/'` — `null` when a name is given different values. */
  strings: Map<string, string | null>;
  /** `templateUrl` values already recorded, by start offset. */
  seen: Set<number>;
}

function fileContext(ast: acorn.Program, source: string): FileContext {
  const ctx: FileContext = { ast, source, strings: new Map(), seen: new Set() };
  // Twice: a constant built from another one declared below it.
  for (let pass = 0; pass < 2; pass++) {
    walkLib.simple(ast, {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || !node.init) return;
        const value = foldString(node.init, ctx);
        if (value === null) return;
        const known = ctx.strings.get(node.id.name);
        ctx.strings.set(node.id.name, known === undefined || known === value ? value : null);
      },
    });
  }
  return ctx;
}

/** The string an expression always evaluates to: literals, `+` of those, constants of this file. */
function foldString(node: acorn.Node, ctx: FileContext): string | null {
  if (node.type === 'Literal') {
    const v = (node as acorn.Literal).value;
    return typeof v === 'string' ? v : null;
  }
  if (node.type === 'TemplateLiteral') {
    const t = node as acorn.TemplateLiteral;
    let out = t.quasis[0]?.value.cooked ?? '';
    for (let i = 0; i < t.expressions.length; i++) {
      const part = foldString(t.expressions[i] as acorn.Node, ctx);
      if (part === null) return null;
      out += part + (t.quasis[i + 1]?.value.cooked ?? '');
    }
    return out;
  }
  if (node.type === 'BinaryExpression' && (node as acorn.BinaryExpression).operator === '+') {
    const b = node as acorn.BinaryExpression;
    const left = foldString(b.left as acorn.Node, ctx);
    const right = left === null ? null : foldString(b.right as acorn.Node, ctx);
    return left !== null && right !== null ? left + right : null;
  }
  if (node.type === 'Identifier') return ctx.strings.get((node as acorn.Identifier).name) ?? null;
  return null;
}

/**
 * A `templateUrl` value read statically: a string (folded, see `foldString`), a function returning
 * one string, or — when only the end is known (`base + '/list.html'`) — that end, `suffixOnly`.
 */
function templateUrlValue(node: acorn.Node, ctx: FileContext): { url: string | null; span: Span; suffixOnly?: boolean } {
  const span = { start: node.start, end: node.end };
  const whole = foldString(node, ctx);
  // Built from constants (`BASE + 'list.html'`): only the last literal is the link, so a click on
  // `BASE` still goes to its declaration.
  if (whole !== null) return { url: whole, span: lastLiteralSpan(node) ?? span };

  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    const fn = node as FnNode;
    const returns: acorn.Node[] = [];
    if (fn.body.type !== 'BlockStatement') returns.push(fn.body as acorn.Node);
    else {
      walkLib.ancestor(fn.body as acorn.Node, {
        ReturnStatement(ret, _s, ancestors) {
          const nested = (ancestors as acorn.Node[]).some((a) => a !== ret && /Function/.test(a.type));
          if (!nested && ret.argument) returns.push(ret.argument as acorn.Node);
        },
      });
    }
    const values = returns.map((r) => templateUrlValue(r, ctx));
    const urls = new Set(values.map((v) => v.url));
    if (values.length > 0 && urls.size === 1 && !urls.has(null)) return values[0]!;
    return { url: null, span };
  }

  // Only the end is static: good enough to find the file by the end of its path.
  const looksLikeFile = (t: string) => /[\w-]+\.[a-z]{2,5}$/i.test(t) || t.includes('/');
  if (node.type === 'BinaryExpression' && (node as acorn.BinaryExpression).operator === '+') {
    const right = (node as acorn.BinaryExpression).right as acorn.Node;
    const tail = foldString(right, ctx);
    if (tail !== null && looksLikeFile(tail) && tail.replace(/^\/+/, '').length > 0) {
      return { url: tail, span: { start: right.start, end: right.end }, suffixOnly: true };
    }
  }
  if (node.type === 'TemplateLiteral') {
    const t = node as acorn.TemplateLiteral;
    const last = t.quasis.at(-1);
    const tail = last?.value.cooked ?? '';
    if (last && looksLikeFile(tail) && tail.replace(/^\/+/, '').length > 0) {
      return { url: tail, span: { start: last.start, end: last.end }, suffixOnly: true };
    }
  }
  return { url: null, span };
}

/** The span of the rightmost string literal of a `+` chain, when it is one. */
function lastLiteralSpan(node: acorn.Node): Span | null {
  if (node.type !== 'BinaryExpression') return null;
  const right = (node as acorn.BinaryExpression).right as acorn.Node;
  return right.type === 'Literal' ? { start: right.start, end: right.end } : lastLiteralSpan(right);
}

/** A controller written as a function: inline, array-annotated, or a function this file declares by that name. */
interface ControllerFunction {
  fn: FnNode;
  deps: NgDeclaration['deps'];
}

function controllerFunction(node: acorn.Node | null, ast: acorn.Program): ControllerFunction | null {
  if (!node) return null;
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    return { fn: node as FnNode, deps: extractDeps(node) };
  }
  if (node.type === 'ArrayExpression') {
    const last = (node as acorn.ArrayExpression).elements.at(-1);
    if (last && (last.type === 'FunctionExpression' || last.type === 'ArrowFunctionExpression')) {
      return { fn: last as FnNode, deps: extractDeps(node) };
    }
    return null;
  }
  if (node.type === 'Identifier') {
    const name = (node as acorn.Identifier).name;
    const fn = localFunction(ast, name);
    if (!fn) return null;
    const injected = injectOf(ast, name);
    return { fn, deps: injected ?? extractDeps(fn) };
  }
  return null;
}

/** `function Name() {}`, `var Name = function () {}` or `var Name = () => …` in this file. */
function localFunction(ast: acorn.Program, name: string): FnNode | null {
  let found: FnNode | null = null;
  walkLib.simple(ast, {
    FunctionDeclaration(node) {
      if (!found && node.id?.name === name) found = node as unknown as FnNode;
    },
    VariableDeclarator(node) {
      if (found || node.id.type !== 'Identifier' || node.id.name !== name || !node.init) return;
      if (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression') found = node.init;
    },
  });
  return found;
}

/** `Name.$inject = ['$scope', …]` */
function injectOf(ast: acorn.Program, name: string): NgDeclaration['deps'] | null {
  let deps: NgDeclaration['deps'] | null = null;
  walkLib.simple(ast, {
    AssignmentExpression(node) {
      const left = node.left;
      if (left.type !== 'MemberExpression' || left.computed || left.property.type !== 'Identifier') return;
      if (left.property.name !== '$inject' || left.object.type !== 'Identifier' || left.object.name !== name) return;
      if (node.right.type === 'ArrayExpression') deps = extractDeps(node.right);
    },
  });
  return deps;
}

/**
 * Every function whose scope belongs to a declaration's template, each with the name its `$scope`
 * goes by there: the declaration's own function; for a directive/component also its controller (a
 * function, or a variable naming one) and its `link` / `compile`-returned link functions, whose
 * first parameter IS the template's scope.
 */
export function scopeFunctionsFor(ast: acorn.Program, decl: NgDeclaration): Array<{ fn: FnNode; scopeParam: string | null }> {
  const out: Array<{ fn: FnNode; scopeParam: string | null }> = [];
  const add = (fn: FnNode | null, scopeParam: string | null) => {
    if (fn && !out.some((o) => o.fn.start === fn.start)) out.push({ fn, scopeParam });
  };
  const main = findFunctionFor(ast, decl);
  if (main) add(main, scopeParamName(decl, main));
  if (decl.kind !== 'directive' && decl.kind !== 'component') return out;

  let obj: acorn.ObjectExpression | null = null;
  walkLib.simple(ast, {
    CallExpression(node) {
      if (node.start === decl.bodySpan.start && node.end === decl.bodySpan.end && node.arguments[1]) {
        obj = ddoObject(node.arguments[1] as acorn.Node, ast);
      }
    },
  });
  if (!obj) return out;
  const ctrl = controllerFunction(propValue(obj, 'controller'), ast);
  if (ctrl) add(ctrl.fn, scopeParamName({ ...decl, deps: ctrl.deps }, ctrl.fn));

  const firstParam = (fn: FnNode) => (fn.params[0]?.type === 'Identifier' ? fn.params[0].name : null);
  const addLink = (node: acorn.Node | null) => {
    if (!node) return;
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') add(node as FnNode, firstParam(node as FnNode));
    else if (node.type === 'ObjectExpression') {
      addLink(propValue(node as acorn.ObjectExpression, 'pre'));
      addLink(propValue(node as acorn.ObjectExpression, 'post'));
    }
  };
  addLink(propValue(obj, 'link'));
  const compile = propValue(obj, 'compile');
  if (compile && (compile.type === 'FunctionExpression' || compile.type === 'ArrowFunctionExpression')) {
    const c = compile as FnNode;
    if (c.body.type !== 'BlockStatement') addLink(c.body as acorn.Node);
    else for (const stmt of c.body.body) if (stmt.type === 'ReturnStatement') addLink(stmt.argument as acorn.Node | null);
  }
  return out;
}

function propValue(obj: acorn.ObjectExpression, key: string): acorn.Node | null {
  for (const prop of obj.properties) {
    if (prop.type === 'Property' && propName(prop) === key) return prop.value;
  }
  return null;
}

/**
 * Express serving templates: static mounts, the views directory, and routes rendering a view named
 * by the URL (`/partials/:name` -> `res.render('partials/' + name)`). See `ServerRoot`.
 */
function tryExtractServerRoots(node: acorn.CallExpression, facts: JsFacts): void {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier') return;
  const method = node.callee.property.name;
  const args = node.arguments as acorn.Node[];
  const push = (root: ServerRoot) => (facts.serverRoots ??= []).push(root);

  if (method === 'use') {
    const prefix = stringOf(args[0]) ?? '/';
    for (const arg of args) {
      if (arg.type !== 'CallExpression' || !isStaticMiddleware((arg as acorn.CallExpression).callee)) continue;
      const dir = serverDir((arg as acorn.CallExpression).arguments[0] as acorn.Node | undefined);
      if (dir) push({ kind: 'static', urlPrefix: prefix, ...dir });
    }
    return;
  }
  if (method === 'set' && stringOf(args[0]) === 'views') {
    const value = args[1];
    const dirs = value?.type === 'ArrayExpression' ? ((value as acorn.ArrayExpression).elements as acorn.Node[]) : [value];
    for (const d of dirs) {
      const dir = serverDir(d);
      if (dir) push({ kind: 'views', urlPrefix: '', ...dir });
    }
    return;
  }
  if (method === 'get' || method === 'all') {
    const route = stringOf(args[0]);
    const cut = route ? route.search(/[:*(]/) : -1;
    if (!route || cut <= 0) return;
    const handler = args.find((a) => a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression');
    if (!handler) return;
    walkLib.simple(handler, {
      CallExpression(call) {
        if (call.callee.type !== 'MemberExpression' || call.callee.computed) return;
        if (call.callee.property.type !== 'Identifier' || call.callee.property.name !== 'render') return;
        const viewPrefix = staticHead(call.arguments[0] as acorn.Node | undefined);
        if (viewPrefix === null) return;
        push({ kind: 'render-route', urlPrefix: route.slice(0, cut), dir: '', fromFile: false, viewPrefix });
      },
    });
  }
}

/** `express.static(…)`, `serveStatic(…)`, or any `x.static(…)`. */
function isStaticMiddleware(callee: acorn.Node): boolean {
  if (callee.type === 'Identifier') return /^serveStatic$|^serve_static$/.test((callee as acorn.Identifier).name);
  if (callee.type !== 'MemberExpression') return false;
  const m = callee as acorn.MemberExpression;
  return !m.computed && m.property.type === 'Identifier' && m.property.name === 'static';
}

/**
 * A directory expression: `'public'`, `path.join(__dirname, 'public')`, `path.resolve(__dirname, '..', 'web')`,
 * `__dirname + '/public'`, `` `${__dirname}/public` ``. Anything else: null.
 */
function serverDir(node: acorn.Node | undefined): { dir: string; fromFile: boolean } | null {
  if (!node) return null;
  const lit = stringOf(node);
  if (lit !== null) return { dir: lit, fromFile: false };
  const isDirname = (n: acorn.Node | undefined) => n?.type === 'Identifier' && (n as acorn.Identifier).name === '__dirname';
  if (node.type === 'CallExpression') {
    const call = node as acorn.CallExpression;
    const callee = call.callee;
    const name = callee.type === 'MemberExpression' && callee.property.type === 'Identifier' ? callee.property.name : callee.type === 'Identifier' ? callee.name : '';
    if (name !== 'join' && name !== 'resolve') return null;
    const args = call.arguments as acorn.Node[];
    const fromFile = isDirname(args[0]);
    const cwd = isProcessCwd(args[0]);
    const rest = fromFile || cwd ? args.slice(1) : args;
    const parts = rest.map((a) => stringOf(a));
    if (parts.some((p) => p === null)) return null;
    return { dir: posix.join('.', ...(parts as string[]).map((p) => p.split('\\').join('/'))), fromFile };
  }
  if (node.type === 'BinaryExpression' && (node as acorn.BinaryExpression).operator === '+') {
    const b = node as acorn.BinaryExpression;
    const tail = stringOf(b.right as acorn.Node);
    if (isDirname(b.left as acorn.Node) && tail !== null) return { dir: posix.join('.', tail), fromFile: true };
    return null;
  }
  if (node.type === 'TemplateLiteral') {
    const t = node as acorn.TemplateLiteral;
    if (t.expressions.length === 1 && isDirname(t.expressions[0] as acorn.Node) && t.quasis[0]?.value.cooked === '') {
      return { dir: posix.join('.', t.quasis[1]?.value.cooked ?? ''), fromFile: true };
    }
  }
  return null;
}

/** `process.cwd()` */
function isProcessCwd(node: acorn.Node | undefined): boolean {
  if (node?.type !== 'CallExpression') return false;
  const callee = (node as acorn.CallExpression).callee;
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'process' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'cwd'
  );
}

/** The static start of `'partials/' + name` or `` `partials/${name}` ``; null when there is none to rely on. */
function staticHead(node: acorn.Node | undefined): string | null {
  if (!node) return null;
  if (node.type === 'BinaryExpression' && (node as acorn.BinaryExpression).operator === '+') {
    const left = (node as acorn.BinaryExpression).left as acorn.Node;
    return stringOf(left) ?? staticHead(left);
  }
  if (node.type === 'TemplateLiteral') {
    const t = node as acorn.TemplateLiteral;
    return t.expressions.length > 0 ? (t.quasis[0]?.value.cooked ?? null) : null;
  }
  return null;
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
