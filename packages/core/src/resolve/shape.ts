import type { FileFacts, Span, ValueShape } from '../types';
import type { SymbolRow } from '../index/store';

/**
 * Nhung gi definition resolution va shape walking can doc tu Workspace, khong hon.
 * Workspace implement interface nay va tu truyen `this` vao cac ham thuan o day.
 */
export interface FactSource {
  facts(relPath: string): FileFacts | null;
  source(relPath: string): string | null;
  findSymbols(name: string, container: string | null): SymbolRow[];
  moduleAliases: string[];
}

/**
 * Di theo duong dan property tren shape da suy luan.
 *
 * Tra ve span cua khoa sau cung tim duoc. Khi khong di het duong dan (vi du
 * `$scope.stats = res.data` — shape unknown), tra ve `partial: true` va nguoi dung
 * van duoc nhay toi khai bao goc thay vi nhan mot thong bao "khong tim thay".
 * Nhay gan dung van huu ich hon la khong nhay.
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

/** Shape suy duoc cho mot scope-member, tu gia tri o lan gan dau tien. */
export function shapeOf(deps: FactSource, member: SymbolRow): ValueShape | null {
  const facts = deps.facts(member.path);
  if (!facts || facts.kind !== 'js') return null;
  const sm = facts.scopeMembers.find(
    (m) => m.span.start === member.span.start && m.name === member.name,
  );
  return sm?.shape ?? null;
}

/** Di theo duong dan property tren shape; gap mang thi di vao shape phan tu, nhu walkShape. */
export function shapeAtPath(shape: ValueShape | undefined, path: string[]): ValueShape | undefined {
  for (const seg of path) {
    if (shape?.kind === 'array' && shape.element) shape = shape.element;
    shape = shape?.kind === 'object' ? shape.props?.[seg] : undefined;
    if (!shape) return undefined;
  }
  return shape;
}
