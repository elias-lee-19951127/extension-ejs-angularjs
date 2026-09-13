import type * as acorn from 'acorn';
import * as walkLib from 'acorn-walk';
import type { BindingKind, JsBinding, Span } from '../types';

export type { BindingKind, JsBinding };

/**
 * Extract plain JavaScript variable/function declarations, along with their scope.
 *
 * WHY THIS IS NEEDED: IntelliJ IDEA Community has no JavaScript plugin (only the
 * paid IDEs have one, before 2026.1 — see docs/kien-truc.md appendix B). On those
 * installs, this language server is the ONLY SOURCE answering for .js files: without
 * doing this ourselves, even Ctrl+Click on a `const` in the same file wouldn't work.
 *
 * Scoping rules follow JavaScript semantics exactly:
 *   - `var` and `function`  -> FUNCTION scope (or the whole file)
 *   - `let` / `const`       -> BLOCK scope
 *   - function parameters   -> scope of that function itself
 *   - catch parameters      -> scope of the catch block
 */
export function extractBindings(ast: acorn.Program): JsBinding[] {
  const out: JsBinding[] = [];

  const isFunction = (n: acorn.Node): boolean =>
    n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression';

  const isBlock = (n: acorn.Node): boolean =>
    n.type === 'BlockStatement' ||
    n.type === 'ForStatement' ||
    n.type === 'ForInStatement' ||
    n.type === 'ForOfStatement' ||
    n.type === 'SwitchStatement';

  /**
   * The enclosing scope, computed from `ancestors` (excluding the last element when
   * `skipSelf` is set). `blockScoped` decides whether to stop at a BlockStatement or
   * keep going up to the enclosing function.
   */
  const scopeOf = (ancestors: acorn.Node[], blockScoped: boolean, skipSelf: boolean): Span => {
    const end = skipSelf ? ancestors.length - 2 : ancestors.length - 1;
    for (let i = end; i >= 0; i--) {
      const n = ancestors[i];
      if (!n) continue;
      if (isFunction(n)) return { start: n.start, end: n.end };
      if (blockScoped && isBlock(n)) return { start: n.start, end: n.end };
      if (n.type === 'Program') return { start: n.start, end: n.end };
    }
    return { start: ast.start, end: ast.end };
  };

  /** A single pattern can yield multiple names: `{a, b: {c}}`, `[x, ...rest]`. */
  const eachName = (pattern: acorn.Pattern, visit: (id: acorn.Identifier) => void): void => {
    switch (pattern.type) {
      case 'Identifier':
        visit(pattern);
        break;
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') eachName(prop.argument, visit);
          else eachName(prop.value, visit);
        }
        break;
      case 'ArrayPattern':
        for (const el of pattern.elements) if (el) eachName(el, visit);
        break;
      case 'AssignmentPattern':
        eachName(pattern.left, visit);
        break;
      case 'RestElement':
        eachName(pattern.argument, visit);
        break;
      default:
        break;
    }
  };

  const addParams = (fn: acorn.Function): void => {
    const scope: Span = { start: fn.start, end: fn.end };
    for (const p of fn.params) {
      eachName(p, (id) => {
        out.push({ name: id.name, span: { start: id.start, end: id.end }, scope, kind: 'param' });
      });
    }
  };

  walkLib.ancestor(ast, {
    VariableDeclarator(node, _state, ancestors) {
      // ancestors: […, VariableDeclaration, VariableDeclarator]
      const parent = ancestors[ancestors.length - 2] as acorn.VariableDeclaration | undefined;
      const kind = (parent?.kind ?? 'var') as BindingKind;
      const scope = scopeOf(ancestors as acorn.Node[], kind !== 'var', true);
      eachName(node.id, (id) => {
        out.push({ name: id.name, span: { start: id.start, end: id.end }, scope, kind });
      });
    },

    FunctionDeclaration(node, _state, ancestors) {
      if (node.id) {
        // The function name belongs to the ENCLOSING scope, not the function body.
        out.push({
          name: node.id.name,
          span: { start: node.id.start, end: node.id.end },
          scope: scopeOf(ancestors as acorn.Node[], false, true),
          kind: 'function',
        });
      }
      addParams(node);
    },

    FunctionExpression(node) {
      // `var f = function inner() {}` — `inner` is only visible within itself.
      if (node.id) {
        out.push({
          name: node.id.name,
          span: { start: node.id.start, end: node.id.end },
          scope: { start: node.start, end: node.end },
          kind: 'function',
        });
      }
      addParams(node);
    },

    ArrowFunctionExpression(node) {
      addParams(node);
    },

    CatchClause(node) {
      if (!node.param) return;
      eachName(node.param, (id) => {
        out.push({
          name: id.name,
          span: { start: id.start, end: id.end },
          scope: { start: node.start, end: node.end },
          kind: 'catch',
        });
      });
    },

    ClassDeclaration(node, _state, ancestors) {
      if (!node.id) return;
      out.push({
        name: node.id.name,
        span: { start: node.id.start, end: node.id.end },
        scope: scopeOf(ancestors as acorn.Node[], true, true),
        kind: 'class',
      });
    },
  });

  return out;
}

/**
 * The declaration that applies to `name` at `offset`: pick the NARROWEST enclosing
 * scope. This is exactly JavaScript's shadowing rule.
 */
export function resolveBinding(
  bindings: JsBinding[],
  name: string,
  offset: number,
): JsBinding | null {
  let best: JsBinding | null = null;
  for (const b of bindings) {
    if (b.name !== name) continue;
    if (offset < b.scope.start || offset > b.scope.end) continue;
    if (!best || b.scope.end - b.scope.start < best.scope.end - best.scope.start) best = b;
  }
  return best;
}

/**
 * Global variables from the browser / Node — not declared anywhere in user code.
 * Reporting "not found" for `window` would be wrong and noisy.
 */
export const JS_GLOBALS = new Set([
  // browser
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'localStorage',
  'sessionStorage', 'fetch', 'XMLHttpRequest', 'FormData', 'Blob', 'File', 'FileReader',
  'URL', 'URLSearchParams', 'WebSocket', 'Worker', 'alert', 'confirm', 'prompt',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'atob', 'btoa', 'CustomEvent', 'Event', 'Element', 'Node',
  'AudioContext', 'Audio', 'Image', 'MutationObserver', 'IntersectionObserver',
  'AbortController', 'AbortSignal', 'AudioWorkletNode', 'AudioWorkletProcessor',
  'MediaRecorder', 'Notification', 'performance', 'crypto', 'TextEncoder',
  'TextDecoder', 'event', 'self', 'top', 'parent', 'frames', 'structuredClone',
  'queueMicrotask', 'ResizeObserver', 'DOMParser', 'Headers', 'Request', 'Response',
  // language
  'console', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'BigInt', 'Infinity', 'NaN', 'undefined',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Intl',
  'SpeechSynthesisUtterance', 'speechSynthesis', 'SpeechRecognition',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'globalThis', 'arguments',
  // ecosystem
  'angular', 'jQuery', '$', 'moment', 'lodash', '_',
  // Node
  'require', 'module', 'exports', 'process', 'Buffer', '__dirname', '__filename',
]);

/**
 * Positions of identifiers at REFERENCE POSITIONS in a .js file.
 *
 * Used by `ejsng sweep` to measure coverage. Must walk the AST rather than scan
 * with regex: a regex scan would count keywords (`const`, `return`) and object
 * literal keys (`{ word: 'x' }`) as identifiers, making the denominator completely
 * wrong — the first measurement using regex gave "49.4%" while the real number was
 * entirely different.
 *
 * Excluded:
 *   - non-computed object literal keys:  `{ word: 1 }`
 *   - non-computed property names:       `a.b`  (unless the object is $scope/this)
 *   - label names / JSX attribute names
 */
export function collectReferenceOffsets(ast: acorn.Program): number[] {
  const skip = new Set<acorn.Node>();

  walkLib.simple(ast, {
    MemberExpression(node) {
      if (node.computed) return;
      // Keep `$scope.foo` / `this.foo`: they're properties on the scope, with a definition.
      const obj = node.object;
      const isScopeObject =
        obj.type === 'ThisExpression' || (obj.type === 'Identifier' && obj.name === '$scope');
      if (!isScopeObject) skip.add(node.property);
    },
    Property(node) {
      if (!node.computed) skip.add(node.key);
    },
    LabeledStatement(node) {
      skip.add(node.label);
    },
    BreakStatement(node) {
      if (node.label) skip.add(node.label);
    },
    ContinueStatement(node) {
      if (node.label) skip.add(node.label);
    },
  });

  const out: number[] = [];
  walkLib.simple(ast, {
    Identifier(node) {
      if (skip.has(node)) return;
      out.push(node.start);
    },
  });
  return out;
}
