import type { Span } from '../types';

export type TokenType = 'ident' | 'number' | 'string' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  text: string;
  /** For string/number: the decoded value. */
  value?: string | number;
  span: Span;
}

const PUNCT3 = ['===', '!=='];
const PUNCT2 = ['==', '!=', '<=', '>=', '&&', '||', '::'];
const PUNCT1 = '+-*/%!<>=?:.,;()[]{}|'.split('');

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v';

export class LexError extends Error {
  constructor(
    message: string,
    public span: Span,
  ) {
    super(message);
  }
}

/**
 * Lexer for AngularJS expressions.
 *
 * Angular expressions are NOT JavaScript (docs/kien-truc.md section 2.3):
 *  - they have a filter operator '|' with special syntax 'expr | name : arg'
 *  - they have a one-time binding prefix '::'
 *  - they have no 'new', 'function', regex literal, or template literal
 *
 * `baseOffset` is added to every span to return offsets in the ORIGINAL FILE.
 */
export function tokenize(input: string, baseOffset = 0): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const span = (start: number, end: number): Span => ({
    start: start + baseOffset,
    end: end + baseOffset,
  });

  while (i < input.length) {
    const c = input[i]!;

    if (isSpace(c)) {
      i++;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(input[i + 1] ?? ''))) {
      const start = i;
      while (i < input.length && isDigit(input[i]!)) i++;
      if (input[i] === '.') {
        i++;
        while (i < input.length && isDigit(input[i]!)) i++;
      }
      if (input[i] === 'e' || input[i] === 'E') {
        const save = i;
        i++;
        if (input[i] === '+' || input[i] === '-') i++;
        if (isDigit(input[i] ?? '')) {
          while (i < input.length && isDigit(input[i]!)) i++;
        } else {
          i = save;
        }
      }
      const text = input.slice(start, i);
      tokens.push({ type: 'number', text, value: Number(text), span: span(start, i) });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < input.length && isIdentPart(input[i]!)) i++;
      tokens.push({ type: 'ident', text: input.slice(start, i), span: span(start, i) });
      continue;
    }

    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let value = '';
      let closed = false;
      while (i < input.length) {
        const ch = input[i]!;
        if (ch === '\\') {
          const next = input[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '');
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          closed = true;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) throw new LexError('Unterminated string', span(start, i));
      tokens.push({ type: 'string', text: input.slice(start, i), value, span: span(start, i) });
      continue;
    }

    const three = input.substr(i, 3);
    if (PUNCT3.includes(three)) {
      tokens.push({ type: 'punct', text: three, span: span(i, i + 3) });
      i += 3;
      continue;
    }
    const two = input.substr(i, 2);
    if (PUNCT2.includes(two)) {
      tokens.push({ type: 'punct', text: two, span: span(i, i + 2) });
      i += 2;
      continue;
    }
    if (PUNCT1.includes(c)) {
      tokens.push({ type: 'punct', text: c, span: span(i, i + 1) });
      i++;
      continue;
    }

    throw new LexError(`Invalid character: ${JSON.stringify(c)}`, span(i, i + 1));
  }

  tokens.push({ type: 'eof', text: '', span: span(input.length, input.length) });
  return tokens;
}
