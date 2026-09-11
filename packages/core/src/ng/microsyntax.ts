import type { Span } from '../types';
import { parseExpression, type ParseError } from './parser';
import type { Program } from './ast';

export interface RepeatSyntax {
  /** Bien phan tu: 'item' trong `item in items`. */
  itemVar: { name: string; span: Span } | null;
  /** Voi dang `(key, value) in obj`: bien key. */
  keyVar: { name: string; span: Span } | null;
  /** Bieu thuc collection, da parse. */
  collection: Program | null;
  collectionSpan: Span;
  /** `... as filtered` — bien phu chua ket qua sau filter. */
  aliasVar: { name: string; span: Span } | null;
  /** `track by expr` */
  trackBy: Program | null;
  trackBySpan: Span | null;
  error?: string;
}

/**
 * Parse microsyntax cua ng-repeat.
 *
 *   item in items
 *   (key, value) in obj
 *   item in items | filter:q as results track by item.id
 *
 * Bam theo regex cua chinh Angular (src/ng/directive/ngRepeat.js) de cung hanh vi,
 * ke ca cac truong hop la nhu khoang trang thua hay xuong dong giua cac phan.
 */
export function parseRepeat(value: string, baseOffset: number): RepeatSyntax {
  const empty: RepeatSyntax = {
    itemVar: null,
    keyVar: null,
    collection: null,
    collectionSpan: { start: baseOffset, end: baseOffset + value.length },
    aliasVar: null,
    trackBy: null,
    trackBySpan: null,
  };

  const m = value.match(
    /^\s*([\s\S]+?)\s+in\s+([\s\S]+?)(?:\s+as\s+([\s\S]+?))?(?:\s+track\s+by\s+([\s\S]+?))?\s*$/,
  );
  if (!m) return { ...empty, error: "Cu phap ng-repeat khong hop le, can dang 'item in collection'" };

  const [, lhs, rhs, aliasRaw, trackRaw] = m;
  const lhsOffset = baseOffset + value.indexOf(lhs!);
  const rhsOffset = baseOffset + value.indexOf(rhs!, value.indexOf(lhs!) + lhs!.length);

  const result: RepeatSyntax = {
    ...empty,
    collectionSpan: { start: rhsOffset, end: rhsOffset + rhs!.length },
  };

  // ve trai: 'item' hoac '(key, value)'
  const lm = lhs!.match(/^(?:\s*([$\w]+)|\(\s*([$\w]+)\s*,\s*([$\w]+)\s*\))$/);
  if (!lm) {
    result.error = `Ve trai '${lhs}' khong hop le, can 'item' hoac '(key, value)'`;
  } else if (lm[1]) {
    const off = lhsOffset + lhs!.indexOf(lm[1]);
    result.itemVar = { name: lm[1], span: { start: off, end: off + lm[1].length } };
  } else {
    const koff = lhsOffset + lhs!.indexOf(lm[2]!);
    const voff = lhsOffset + lhs!.indexOf(lm[3]!, lhs!.indexOf(lm[2]!) + lm[2]!.length);
    result.keyVar = { name: lm[2]!, span: { start: koff, end: koff + lm[2]!.length } };
    result.itemVar = { name: lm[3]!, span: { start: voff, end: voff + lm[3]!.length } };
  }

  try {
    result.collection = parseExpression(rhs!, rhsOffset);
  } catch (e) {
    result.error = (e as ParseError).message;
  }

  if (aliasRaw) {
    const off = baseOffset + value.lastIndexOf(aliasRaw);
    result.aliasVar = { name: aliasRaw.trim(), span: { start: off, end: off + aliasRaw.length } };
  }
  if (trackRaw) {
    const off = baseOffset + value.lastIndexOf(trackRaw);
    result.trackBySpan = { start: off, end: off + trackRaw.length };
    try {
      result.trackBy = parseExpression(trackRaw, off);
    } catch {
      /* track by hong khong lam hong ca directive */
    }
  }

  return result;
}

export interface OptionsSyntax {
  /** Bien phan tu trong `x in xs`. */
  itemVar: { name: string; span: Span } | null;
  keyVar: { name: string; span: Span } | null;
  collection: Program | null;
  collectionSpan: Span | null;
  /** Cac bieu thuc phu: select / label / group by / track by / disable when. */
  extras: Array<{ program: Program; span: Span }>;
  error?: string;
}

/**
 * Parse ng-options (rut gon).
 *
 *   label for item in items
 *   item.name for item in items track by item.id
 *   item as item.label group by item.g for item in items
 *
 * Chi can dung cho muc dich cua extension: biet bien nao duoc dua vao scope
 * va bieu thuc nao can resolve. Khong can tai lap toan bo ngu nghia.
 */
export function parseOptions(value: string, baseOffset: number): OptionsSyntax {
  const result: OptionsSyntax = {
    itemVar: null,
    keyVar: null,
    collection: null,
    collectionSpan: null,
    extras: [],
  };

  const forIdx = value.search(/\sfor\s/);
  if (forIdx === -1) {
    result.error = "Cu phap ng-options khong hop le, thieu tu khoa 'for'";
    return result;
  }

  const head = value.slice(0, forIdx);
  const tail = value.slice(forIdx + 5);
  const tailOffset = baseOffset + forIdx + 5;

  // Phan sau 'for' co cung cau truc voi ng-repeat.
  const repeat = parseRepeat(tail, tailOffset);
  result.itemVar = repeat.itemVar;
  result.keyVar = repeat.keyVar;
  result.collection = repeat.collection;
  result.collectionSpan = repeat.collectionSpan;
  if (repeat.error) result.error = repeat.error;

  // Phan truoc 'for': tach theo 'group by' / 'disable when' / ' as '.
  for (const part of splitKeywords(head)) {
    const off = baseOffset + head.indexOf(part.text);
    try {
      result.extras.push({
        program: parseExpression(part.text, off),
        span: { start: off, end: off + part.text.length },
      });
    } catch {
      /* bo qua phan hong */
    }
  }

  return result;
}

function splitKeywords(head: string): Array<{ text: string }> {
  return head
    .split(/\s+(?:as|group\s+by|disable\s+when)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}
