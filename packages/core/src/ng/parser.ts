import type { Span } from '../types';
import { tokenize, LexError, type Token } from './lexer';
import type { Expr, Identifier, Program } from './ast';

export class ParseError extends Error {
  constructor(
    message: string,
    public span: Span,
  ) {
    super(message);
  }
}

/**
 * Parser for AngularJS expressions (recursive descent, following $parse's exact precedence).
 *
 * Grammar:
 *   program        := filterChain (';' filterChain)* ';'?
 *   filterChain    := assignment ('|' filter)*
 *   assignment     := ternary ('=' assignment)?
 *   ternary        := logicalOR ('?' assignment ':' assignment)?
 *   logicalOR      := logicalAND ('||' logicalAND)*
 *   logicalAND     := equality ('&&' equality)*
 *   equality       := relational (('=='|'!='|'==='|'!==') relational)*
 *   relational     := additive (('<'|'>'|'<='|'>=') additive)*
 *   additive       := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/'|'%') unary)*
 *   unary          := ('+'|'-'|'!') unary | primary
 *   primary        := ('(' filterChain ')' | array | object | literal | ident)
 *                     ('.' ident | '[' filterChain ']' | '(' args ')')*
 */
export function parseExpression(input: string, baseOffset = 0): Program {
  const p = new Parser(input, baseOffset);
  return p.parseProgram();
}

/** Parse without throwing — returns null on failure. Used while the user is typing. */
export function tryParseExpression(input: string, baseOffset = 0): Program | null {
  try {
    return parseExpression(input, baseOffset);
  } catch {
    return null;
  }
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private oneTime = false;

  constructor(
    private input: string,
    private baseOffset: number,
  ) {
    try {
      this.tokens = tokenize(input, baseOffset);
    } catch (e) {
      if (e instanceof LexError) throw new ParseError(e.message, e.span);
      throw e;
    }
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private at(text: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.text === text;
  }
  private eat(text: string): boolean {
    if (this.at(text)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expect(text: string): Token {
    if (!this.at(text)) {
      throw new ParseError(`Expected '${text}' but found '${this.peek().text || 'end of input'}'`, this.peek().span);
    }
    return this.next();
  }
  private span(from: Span, to: Span): Span {
    return { start: from.start, end: to.end };
  }

  parseProgram(): Program {
    const start = this.peek().span;
    // One-time binding prefix '::'
    if (this.eat('::')) this.oneTime = true;

    const body: Expr[] = [];
    if (this.peek().type !== 'eof') {
      body.push(this.filterChain());
      while (this.eat(';')) {
        if (this.peek().type === 'eof') break;
        body.push(this.filterChain());
      }
    }
    if (this.peek().type !== 'eof') {
      throw new ParseError(`Unexpected trailing character '${this.peek().text}'`, this.peek().span);
    }
    const end = this.tokens[this.tokens.length - 1]!.span;
    return { type: 'Program', body, oneTime: this.oneTime, span: this.span(start, end) };
  }

  /** `expr | name : arg : arg | name2` */
  private filterChain(): Expr {
    let left = this.assignment();
    while (this.at('|')) {
      this.next();
      const nameTok = this.next();
      if (nameTok.type !== 'ident') {
        throw new ParseError('Filter name must be an identifier', nameTok.span);
      }
      const name: Identifier = { type: 'Identifier', name: nameTok.text, span: nameTok.span };
      const args: Expr[] = [];
      while (this.eat(':')) args.push(this.assignment());
      const lastSpan = args.length ? args[args.length - 1]!.span : name.span;
      left = {
        type: 'FilterExpression',
        input: left,
        name,
        args,
        span: this.span(left.span, lastSpan),
      };
    }
    return left;
  }

  private assignment(): Expr {
    const left = this.ternary();
    if (this.at('=')) {
      this.next();
      const right = this.assignment();
      return { type: 'AssignmentExpression', left, right, span: this.span(left.span, right.span) };
    }
    return left;
  }

  private ternary(): Expr {
    const test = this.binary(0);
    if (this.eat('?')) {
      const consequent = this.assignment();
      this.expect(':');
      const alternate = this.assignment();
      return {
        type: 'ConditionalExpression',
        test,
        consequent,
        alternate,
        span: this.span(test.span, alternate.span),
      };
    }
    return test;
  }

  private static readonly PRECEDENCE: Array<{ ops: string[]; logical: boolean }> = [
    { ops: ['||'], logical: true },
    { ops: ['&&'], logical: true },
    { ops: ['==', '!=', '===', '!=='], logical: false },
    { ops: ['<', '>', '<=', '>='], logical: false },
    { ops: ['+', '-'], logical: false },
    { ops: ['*', '/', '%'], logical: false },
  ];

  private binary(level: number): Expr {
    const table = Parser.PRECEDENCE;
    if (level >= table.length) return this.unary();
    let left = this.binary(level + 1);
    const { ops, logical } = table[level]!;
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct' || !ops.includes(t.text)) break;
      this.next();
      const right = this.binary(level + 1);
      left = {
        type: logical ? 'LogicalExpression' : 'BinaryExpression',
        operator: t.text,
        left,
        right,
        span: this.span(left.span, right.span),
      };
    }
    return left;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && (t.text === '+' || t.text === '-' || t.text === '!')) {
      this.next();
      const argument = this.unary();
      return {
        type: 'UnaryExpression',
        operator: t.text,
        argument,
        span: this.span(t.span, argument.span),
      };
    }
    return this.postfix(this.primary());
  }

  private primary(): Expr {
    const t = this.peek();

    if (this.at('(')) {
      const open = this.next();
      const inner = this.filterChain();
      const close = this.expect(')');
      return { ...inner, span: this.span(open.span, close.span) };
    }
    if (this.at('[')) return this.arrayLiteral();
    if (this.at('{')) return this.objectLiteral();

    if (t.type === 'number' || t.type === 'string') {
      this.next();
      return { type: 'Literal', value: t.value!, span: t.span };
    }
    if (t.type === 'ident') {
      this.next();
      if (t.text === 'true') return { type: 'Literal', value: true, span: t.span };
      if (t.text === 'false') return { type: 'Literal', value: false, span: t.span };
      if (t.text === 'null') return { type: 'Literal', value: null, span: t.span };
      if (t.text === 'undefined') return { type: 'Literal', value: undefined, span: t.span };
      if (t.text === 'this') return { type: 'ThisExpression', span: t.span };
      return { type: 'Identifier', name: t.text, span: t.span };
    }
    throw new ParseError(`Unexpected '${t.text || 'end of expression'}'`, t.span);
  }

  private postfix(base: Expr): Expr {
    let node = base;
    for (;;) {
      if (this.at('.')) {
        this.next();
        const nameTok = this.next();
        if (nameTok.type !== 'ident') {
          throw new ParseError("Expected a property name after '.'", nameTok.span);
        }
        const property: Identifier = {
          type: 'Identifier',
          name: nameTok.text,
          span: nameTok.span,
        };
        node = {
          type: 'MemberExpression',
          object: node,
          property,
          computed: false,
          span: this.span(node.span, nameTok.span),
        };
        continue;
      }
      if (this.at('[')) {
        this.next();
        const property = this.filterChain();
        const close = this.expect(']');
        node = {
          type: 'MemberExpression',
          object: node,
          property,
          computed: true,
          span: this.span(node.span, close.span),
        };
        continue;
      }
      if (this.at('(')) {
        this.next();
        const args: Expr[] = [];
        if (!this.at(')')) {
          args.push(this.filterChain());
          while (this.eat(',')) args.push(this.filterChain());
        }
        const close = this.expect(')');
        node = {
          type: 'CallExpression',
          callee: node,
          args,
          span: this.span(node.span, close.span),
        };
        continue;
      }
      break;
    }
    return node;
  }

  private arrayLiteral(): Expr {
    const open = this.expect('[');
    const elements: Expr[] = [];
    if (!this.at(']')) {
      elements.push(this.filterChain());
      while (this.eat(',')) {
        if (this.at(']')) break;
        elements.push(this.filterChain());
      }
    }
    const close = this.expect(']');
    return { type: 'ArrayExpression', elements, span: this.span(open.span, close.span) };
  }

  private objectLiteral(): Expr {
    const open = this.expect('{');
    const properties: Array<{ key: Expr; value: Expr; computed: boolean }> = [];
    if (!this.at('}')) {
      do {
        if (this.at('}')) break;
        let key: Expr;
        let computed = false;
        if (this.at('[')) {
          this.next();
          key = this.filterChain();
          this.expect(']');
          computed = true;
        } else {
          const t = this.next();
          if (t.type === 'ident') key = { type: 'Identifier', name: t.text, span: t.span };
          else if (t.type === 'string' || t.type === 'number')
            key = { type: 'Literal', value: t.value!, span: t.span };
          else throw new ParseError('Invalid object key', t.span);
        }
        this.expect(':');
        const value = this.filterChain();
        properties.push({ key, value, computed });
      } while (this.eat(','));
    }
    const close = this.expect('}');
    return { type: 'ObjectExpression', properties, span: this.span(open.span, close.span) };
  }
}
