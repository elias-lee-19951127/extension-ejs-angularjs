import * as acorn from 'acorn';
import * as acornLoose from 'acorn-loose';
import type { Node, Program } from 'acorn';

/**
 * Parse JavaScript, uu tien parser nghiem ngat roi moi rot ve parser khoan dung.
 *
 * `ecmaVersion` de 2020 chu khong phai 5: codebase ES5 van hay lan vai file da
 * hien dai hoa, va parse duoc ca hai thi tot hon la vo mot nua.
 * Parser khoan dung (`acorn-loose`) can thiet cho file dang go do trong editor.
 */
export function parseJsTolerant(code: string): Program | null {
  // Codebase cu lan ca file ES module: `dha.const.js` dung `export const`.
  // Parse bang sourceType 'script' se hong ngay o tu khoa `export`, roi roi
  // xuong parser khoan dung va cho ra binding rat kem.
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
      /* thu tiep bang parser khoan dung */
    }
    try {
      return acornLoose.parse(code, { ecmaVersion: 2020, allowHashBang: true });
    } catch {
      return null;
    }
  }
}

/** Bien co san trong ngu canh EJS/browser, khong phai locals do server bom vao. */
export const EJS_GLOBALS = new Set([
  'locals', 'escapeFn', 'include', 'rethrow', '__out', '__append',
  'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'console', 'window', 'document', 'undefined', 'null',
  'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
]);

/** Lay ten chuoi tu mot node Literal, null neu khong phai chuoi. */
export function stringOf(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal') {
    const v = (node as acorn.Literal).value;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/** Ten property cua mot node Property (khong computed). */
export function propName(prop: acorn.Property): string | null {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}
