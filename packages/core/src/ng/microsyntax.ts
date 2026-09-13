import type { Span } from '../types';
import { parseExpression, type ParseError } from './parser';
import type { Program } from './ast';

export interface RepeatSyntax {
  /** Item variable: 'item' in `item in items`. */
  itemVar: { name: string; span: Span } | null;
  /** For the `(key, value) in obj` form: the key variable. */
  keyVar: { name: string; span: Span } | null;
  /** The collection expression, already parsed. */
  collection: Program | null;
  collectionSpan: Span;
  /** `... as filtered` — auxiliary variable holding the result after filtering. */
  aliasVar: { name: string; span: Span } | null;
  /** `track by expr` */
  trackBy: Program | null;
  trackBySpan: Span | null;
  error?: string;
}

/**
 * Parse the ng-repeat microsyntax.
 *
 *   item in items
 *   (key, value) in obj
 *   item in items | filter:q as results track by item.id
 *
 * Follows Angular's own regex (src/ng/directive/ngRepeat.js) to match its behavior,
 * including edge cases like extra whitespace or newlines between parts.
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
  if (!m) return { ...empty, error: "Invalid ng-repeat syntax, expected the form 'item in collection'" };

  const [, lhs, rhs, aliasRaw, trackRaw] = m;
  const lhsOffset = baseOffset + value.indexOf(lhs!);
  const rhsOffset = baseOffset + value.indexOf(rhs!, value.indexOf(lhs!) + lhs!.length);

  const result: RepeatSyntax = {
    ...empty,
    collectionSpan: { start: rhsOffset, end: rhsOffset + rhs!.length },
  };

  // left-hand side: 'item' or '(key, value)'
  const lm = lhs!.match(/^(?:\s*([$\w]+)|\(\s*([$\w]+)\s*,\s*([$\w]+)\s*\))$/);
  if (!lm) {
    result.error = `Left-hand side '${lhs}' is invalid, expected 'item' or '(key, value)'`;
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
      /* a broken track-by should not break the whole directive */
    }
  }

  return result;
}

export interface OptionsSyntax {
  /** Item variable in `x in xs`. */
  itemVar: { name: string; span: Span } | null;
  keyVar: { name: string; span: Span } | null;
  collection: Program | null;
  collectionSpan: Span | null;
  /** Auxiliary expressions: select / label / group by / track by / disable when. */
  extras: Array<{ program: Program; span: Span }>;
  error?: string;
}

/**
 * Parse ng-options (simplified).
 *
 *   label for item in items
 *   item.name for item in items track by item.id
 *   item as item.label group by item.g for item in items
 *
 * Only needs to serve the extension's purpose: know which variables are added
 * to the scope and which expressions need resolving. No need to reimplement the full semantics.
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
    result.error = "Invalid ng-options syntax, missing the 'for' keyword";
    return result;
  }

  const head = value.slice(0, forIdx);
  const tail = value.slice(forIdx + 5);
  const tailOffset = baseOffset + forIdx + 5;

  // The part after 'for' has the same structure as ng-repeat.
  const repeat = parseRepeat(tail, tailOffset);
  result.itemVar = repeat.itemVar;
  result.keyVar = repeat.keyVar;
  result.collection = repeat.collection;
  result.collectionSpan = repeat.collectionSpan;
  if (repeat.error) result.error = repeat.error;

  // The part before 'for': split on 'group by' / 'disable when' / ' as '.
  for (const part of splitKeywords(head)) {
    const off = baseOffset + head.indexOf(part.text);
    try {
      result.extras.push({
        program: parseExpression(part.text, off),
        span: { start: off, end: off + part.text.length },
      });
    } catch {
      /* skip the broken part */
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
