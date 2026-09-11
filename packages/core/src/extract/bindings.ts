import type * as acorn from 'acorn';
import * as walkLib from 'acorn-walk';
import type { BindingKind, JsBinding, Span } from '../types';

export type { BindingKind, JsBinding };

/**
 * Trich cac khai bao bien/ham cua JavaScript thuan, kem pham vi.
 *
 * VI SAO CAN: IntelliJ IDEA Community khong co plugin JavaScript (chi IDE tra
 * phi moi co, truoc 2026.1 — xem docs/kien-truc.md phu luc B). Tren nhung ban
 * do, language server nay la NGUON DUY NHAT tra loi cho file .js: khong tu lam
 * thi Ctrl+Click vao mot `const` trong cung file cung khong chay.
 *
 * Quy tac pham vi bam theo dung ngu nghia JavaScript:
 *   - `var` va `function`  -> pham vi HAM (hoac toan file)
 *   - `let` / `const`      -> pham vi KHOI
 *   - tham so ham          -> pham vi chinh ham do
 *   - tham so catch        -> pham vi khoi catch
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
   * Pham vi bao quanh, tinh tu `ancestors` (khong ke phan tu cuoi neu `skipSelf`).
   * `blockScoped` quyet dinh co dung lai o BlockStatement hay di tiep len ham.
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

  /** Mot pattern co the sinh ra nhieu ten: `{a, b: {c}}`, `[x, ...rest]`. */
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
        // Ten ham thuoc pham vi BAO QUANH, khong phai than ham.
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
      // `var f = function inner() {}` — `inner` chi nhin thay duoc trong chinh no.
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
 * Khai bao ap dung cho `name` tai `offset`: chon pham vi HEP NHAT bao quanh.
 * Do la dung quy tac che bong (shadowing) cua JavaScript.
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
 * Bien toan cuc cua trinh duyet / Node — khong co khai bao trong code nguoi dung.
 * Bao "khong tim thay" cho `window` la sai va gay nhieu.
 */
export const JS_GLOBALS = new Set([
  // trinh duyet
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
  // ngon ngu
  'console', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'BigInt', 'Infinity', 'NaN', 'undefined',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Intl',
  'SpeechSynthesisUtterance', 'speechSynthesis', 'SpeechRecognition',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'globalThis', 'arguments',
  // he sinh thai
  'angular', 'jQuery', '$', 'moment', 'lodash', '_',
  // Node
  'require', 'module', 'exports', 'process', 'Buffer', '__dirname', '__filename',
]);

/**
 * Vi tri cua cac dinh danh o VI TRI THAM CHIEU trong mot file .js.
 *
 * Dung cho `ejsng sweep` de do do phu. Phai di qua AST chu khong quet regex:
 * quet regex se dem ca tu khoa (`const`, `return`) va khoa cua object literal
 * (`{ word: 'x' }`) thanh dinh danh, lam mau so sai hoan toan — lan dau do bang
 * regex cho ra "49.4%" trong khi con so that hoan toan khac.
 *
 * Loai tru:
 *   - khoa object literal khong computed:  `{ word: 1 }`
 *   - ten property khong computed:         `a.b`  (tru khi doi tuong la $scope/this)
 *   - nhan cua label / thuoc tinh JSX
 */
export function collectReferenceOffsets(ast: acorn.Program): number[] {
  const skip = new Set<acorn.Node>();

  walkLib.simple(ast, {
    MemberExpression(node) {
      if (node.computed) return;
      // Giu lai `$scope.foo` / `this.foo`: do la property tren scope, co dinh nghia.
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
