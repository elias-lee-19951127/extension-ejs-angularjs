import type { FileFacts, Span, ValueShape } from '../types';
import type { SymbolRow } from '../index/store';

/**
 * What definition resolution and shape walking need to read from Workspace, nothing more.
 * Workspace implements this interface and passes `this` into the pure functions below.
 */
export interface FactSource {
  facts(relPath: string): FileFacts | null;
  source(relPath: string): string | null;
  findSymbols(name: string, container: string | null): SymbolRow[];
  moduleAliases: string[];
}

/**
 * Walk a property path over an inferred shape.
 *
 * Returns the span of the last key found. When the full path can't be walked (e.g.
 * `$scope.stats = res.data` — shape unknown), returns `partial: true` and the user still
 * jumps to the original declaration instead of getting a "not found" message. Jumping to
 * an approximate location is more useful than not jumping at all.
 */
export function walkShape(
  deps: FactSource,
  member: SymbolRow,
  rest: string[],
): { span?: Span; depth: number; partial: boolean } {
  if (!rest.length) return { depth: 0, partial: false };

  const start = shapeOf(deps, member);
  if (!start) return { depth: 0, partial: true };

  let shape = start;
  let lastSpan: Span | undefined;
  let depth = 0;
  for (const seg of rest) {
    if (shape.kind === 'array' && shape.element) shape = shape.element;
    const next = shape.kind === 'object' ? shape.props?.[seg] : undefined;
    if (!next) return { span: lastSpan, depth, partial: true };
    shape = next;
    lastSpan = next.span;
    depth++;
  }
  return { span: lastSpan, depth, partial: false };
}

/** The shape inferred for a scope-member, from the value at its first assignment. */
export function shapeOf(deps: FactSource, member: SymbolRow): ValueShape | null {
  const facts = deps.facts(member.path);
  if (!facts || facts.kind !== 'js') return null;
  const sm = facts.scopeMembers.find(
    (m) => m.span.start === member.span.start && m.name === member.name,
  );
  return sm?.shape ?? null;
}

/** Walk a property path over a shape; steps into the element shape on arrays, like walkShape. */
export function shapeAtPath(shape: ValueShape | undefined, path: string[]): ValueShape | undefined {
  for (const seg of path) {
    if (shape?.kind === 'array' && shape.element) shape = shape.element;
    shape = shape?.kind === 'object' ? shape.props?.[seg] : undefined;
    if (!shape) return undefined;
  }
  return shape;
}
