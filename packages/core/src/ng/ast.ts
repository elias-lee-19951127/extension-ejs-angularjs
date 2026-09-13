import type { Span } from '../types';

export interface NodeBase {
  span: Span;
}
export interface Identifier extends NodeBase {
  type: 'Identifier';
  name: string;
}
export interface Literal extends NodeBase {
  type: 'Literal';
  value: string | number | boolean | null | undefined;
}
export interface ThisExpr extends NodeBase {
  type: 'ThisExpression';
}
export interface Member extends NodeBase {
  type: 'MemberExpression';
  object: Expr;
  property: Expr;
  computed: boolean;
}
export interface Call extends NodeBase {
  type: 'CallExpression';
  callee: Expr;
  args: Expr[];
}
export interface Assign extends NodeBase {
  type: 'AssignmentExpression';
  left: Expr;
  right: Expr;
}
export interface Conditional extends NodeBase {
  type: 'ConditionalExpression';
  test: Expr;
  consequent: Expr;
  alternate: Expr;
}
export interface Binary extends NodeBase {
  type: 'BinaryExpression' | 'LogicalExpression';
  operator: string;
  left: Expr;
  right: Expr;
}
export interface Unary extends NodeBase {
  type: 'UnaryExpression';
  operator: string;
  argument: Expr;
}
export interface ArrayExpr extends NodeBase {
  type: 'ArrayExpression';
  elements: Expr[];
}
export interface ObjectExpr extends NodeBase {
  type: 'ObjectExpression';
  properties: Array<{ key: Expr; value: Expr; computed: boolean }>;
}
/** Angular-specific: `expr | filterName : arg1 : arg2` */
export interface FilterExpr extends NodeBase {
  type: 'FilterExpression';
  input: Expr;
  name: Identifier;
  args: Expr[];
}

export type Expr =
  | Identifier
  | Literal
  | ThisExpr
  | Member
  | Call
  | Assign
  | Conditional
  | Binary
  | Unary
  | ArrayExpr
  | ObjectExpr
  | FilterExpr;

export interface Program extends NodeBase {
  type: 'Program';
  body: Expr[];
  /** true if the expression starts with '::' (one-time binding). */
  oneTime: boolean;
}

/** Visit every child node. */
export function walk(node: Expr | Program, visit: (n: Expr | Program) => void): void {
  visit(node);
  const w = (n: Expr | undefined) => n && walk(n, visit);
  switch (node.type) {
    case 'Program':
      node.body.forEach((n) => w(n));
      break;
    case 'MemberExpression':
      w(node.object);
      if (node.computed) w(node.property);
      break;
    case 'CallExpression':
      w(node.callee);
      node.args.forEach(w);
      break;
    case 'AssignmentExpression':
      w(node.left);
      w(node.right);
      break;
    case 'ConditionalExpression':
      w(node.test);
      w(node.consequent);
      w(node.alternate);
      break;
    case 'BinaryExpression':
    case 'LogicalExpression':
      w(node.left);
      w(node.right);
      break;
    case 'UnaryExpression':
      w(node.argument);
      break;
    case 'ArrayExpression':
      node.elements.forEach(w);
      break;
    case 'ObjectExpression':
      node.properties.forEach((p) => {
        if (p.computed) w(p.key);
        w(p.value);
      });
      break;
    case 'FilterExpression':
      w(node.input);
      node.args.forEach(w);
      break;
    default:
      break;
  }
}

export interface RootRef {
  /** Root identifier name: for `a.b.c` this is 'a'. */
  name: string;
  /** Span of ONLY the root identifier — used for go-to-definition. */
  span: Span;
  /** Property path after the root: for `a.b.c` this is ['b','c']. */
  path: string[];
  /** true if the root identifier is called as a function: `doThing()`. */
  isCall: boolean;
  /** true if this is the left-hand side of an assignment (ng-model). */
  isWrite: boolean;
}

/**
 * Extract the ROOT identifiers of an expression.
 *
 * Only roots are collected, not properties: in `vm.orders.length`, only 'vm' needs
 * to be resolved against the scope; 'orders' and 'length' are further steps on the shape.
 * Skips identifiers in a non-computed property position (`a.b` -> does not collect 'b').
 */
export function collectRoots(program: Program): RootRef[] {
  const out: RootRef[] = [];
  const seen = new Set<Expr>();

  const markPropertyIdents = (n: Expr | Program): void => {
    if (n.type === 'MemberExpression' && !n.computed) seen.add(n.property);
    if (n.type === 'FilterExpression') seen.add(n.name);
    if (n.type === 'ObjectExpression') {
      n.properties.forEach((p) => {
        if (!p.computed) seen.add(p.key);
      });
    }
  };
  walk(program, markPropertyIdents);

  const assignTargets = new Set<Expr>();
  walk(program, (n) => {
    if (n.type === 'AssignmentExpression') assignTargets.add(n.left);
  });

  walk(program, (n) => {
    if (n.type !== 'Identifier' || seen.has(n)) return;
    out.push({ name: n.name, span: n.span, path: [], isCall: false, isWrite: false });
  });

  // Fill in path + isCall with a separate pass over member chains.
  const byStart = new Map<number, RootRef>();
  out.forEach((r) => byStart.set(r.span.start, r));

  walk(program, (n) => {
    if (n.type === 'MemberExpression' || n.type === 'CallExpression') {
      const { root, path, isCall } = unwind(n);
      if (!root) return;
      const ref = byStart.get(root.span.start);
      if (ref && path.length > ref.path.length) {
        ref.path = path;
      }
      if (ref && isCall && path.length === 0) ref.isCall = true;
    }
    if (n.type === 'AssignmentExpression') {
      const { root } = unwind(n.left);
      if (root) {
        const ref = byStart.get(root.span.start);
        if (ref) ref.isWrite = true;
      }
    }
  });

  return out;
}

/** Split `a.b.c()` into root='a', path=['b','c'], isCall=true. */
export function unwind(expr: Expr): { root: Identifier | null; path: string[]; isCall: boolean } {
  const path: string[] = [];
  let isCall = false;
  let cur: Expr = expr;
  for (;;) {
    if (cur.type === 'CallExpression') {
      isCall = true;
      cur = cur.callee;
      continue;
    }
    if (cur.type === 'MemberExpression') {
      if (!cur.computed && cur.property.type === 'Identifier') {
        path.unshift(cur.property.name);
      } else {
        path.unshift('[]');
      }
      cur = cur.object;
      continue;
    }
    break;
  }
  return { root: cur.type === 'Identifier' ? cur : null, path, isCall };
}

/** Smallest node covering the offset. */
export function nodeAt(program: Program, offset: number): Expr | null {
  let best: Expr | null = null;
  walk(program, (n) => {
    if (n.type === 'Program') return;
    if (n.span.start <= offset && offset <= n.span.end) {
      if (!best || n.span.end - n.span.start < best.span.end - best.span.start) best = n;
    }
  });
  return best;
}

/** Extract the filters used in an expression: `x | currency | myFilter:a`. */
export function collectFilters(program: Program): Array<{ name: string; span: Span }> {
  const out: Array<{ name: string; span: Span }> = [];
  walk(program, (n) => {
    if (n.type === 'FilterExpression') out.push({ name: n.name.name, span: n.name.span });
  });
  return out;
}
