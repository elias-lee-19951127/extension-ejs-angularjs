import * as acorn from 'acorn';
import * as acornLoose from 'acorn-loose';
import type { Node, Program } from 'acorn';

/**
 * Parse JavaScript, preferring the strict parser first and only falling back to
 * the tolerant one.
 *
 * `ecmaVersion` is set to 2020 rather than 5: an ES5 codebase still often mixes in
 * a few modernized files, and being able to parse both is better than breaking on
 * one of them. The tolerant parser (`acorn-loose`) is needed for files still being
 * typed in the editor.
 */
export function parseJsTolerant(code: string): Program | null {
  // The legacy codebase mixes in ES module files: `dha.const.js` uses `export const`.
  // Parsing with sourceType 'script' would fail immediately on the `export` keyword,
  // falling through to the tolerant parser and yielding very poor bindings.
  const looksLikeModule = /^\s*(?:import|export)\s/m.test(code);

  try {
    return acorn.parse(code, {
      ecmaVersion: 2020,
      sourceType: looksLikeModule ? 'module' : 'script',
      allowReturnOutsideFunction: true,
      allowHashBang: true,
      locations: false,
    });
  } catch {
    try {
      return acorn.parse(code, {
        ecmaVersion: 2020,
        sourceType: looksLikeModule ? 'script' : 'module',
        allowReturnOutsideFunction: true,
        allowHashBang: true,
        locations: false,
      });
    } catch {
      /* fall through to the tolerant parser */
    }
    try {
      return acornLoose.parse(code, { ecmaVersion: 2020, allowHashBang: true });
    } catch {
      return null;
    }
  }
}

/** Variables available in the EJS/browser context, not locals injected by the server. */
export const EJS_GLOBALS = new Set([
  'locals', 'escapeFn', 'include', 'rethrow', '__out', '__append',
  'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'console', 'window', 'document', 'undefined', 'null',
  'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
]);

/** Get the string value from a Literal node, or null if it's not a string. */
export function stringOf(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal') {
    const v = (node as acorn.Literal).value;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/** The property name of a Property node (non-computed). */
export function propName(prop: acorn.Property): string | null {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}
