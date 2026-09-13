import type { Span } from '../types';

export type EjsRegionKind =
  | 'html'
  | 'scriptlet' // <% ... %>
  | 'output-escaped' // <%= ... %>
  | 'output-raw' // <%- ... %>
  | 'comment'; // <%# ... %>

export interface EjsRegion {
  kind: EjsRegionKind;
  /** Span of the WHOLE tag, including the delimiter. */
  span: Span;
  /** Span of the content inside the delimiters. */
  innerSpan: Span;
  inner: string;
}

/**
 * Scan an EJS file into regions.
 *
 * Supports the full EJS delimiter set:
 *   <%  scriptlet        %>  normal close
 *   <%= output escaped   -%> close + swallow newline
 *   <%- output raw       _%> close + swallow whitespace
 *   <%# comment
 *   <%_ scriptlet + swallow leading whitespace
 *   <%% literal '<%'  (does not open a region)
 *
 * `delimiter` defaults to '%', producing '<%' / '%>'. Change it to '?' to get '<?' / '?>'.
 */
export function scanEjs(source: string, delimiter = '%'): EjsRegion[] {
  const open = '<' + delimiter;
  const close = delimiter + '>';
  const regions: EjsRegion[] = [];
  let pos = 0;
  let htmlStart = 0;

  const pushHtml = (end: number) => {
    if (end > htmlStart) {
      regions.push({
        kind: 'html',
        span: { start: htmlStart, end },
        innerSpan: { start: htmlStart, end },
        inner: source.slice(htmlStart, end),
      });
    }
  };

  while (pos < source.length) {
    const idx = source.indexOf(open, pos);
    if (idx === -1) break;

    // '<%%' is an escape for the literal '<%' character, does not open a region.
    if (source.startsWith(open + delimiter, idx)) {
      pos = idx + open.length + 1;
      continue;
    }

    const afterOpen = idx + open.length;
    const marker = source[afterOpen];
    let kind: EjsRegionKind = 'scriptlet';
    let innerStart = afterOpen;

    if (marker === '=') {
      kind = 'output-escaped';
      innerStart = afterOpen + 1;
    } else if (marker === '-') {
      kind = 'output-raw';
      innerStart = afterOpen + 1;
    } else if (marker === '#') {
      kind = 'comment';
      innerStart = afterOpen + 1;
    } else if (marker === '_') {
      kind = 'scriptlet';
      innerStart = afterOpen + 1;
    }

    // Find the nearest close. Must check both the '-%>' and '_%>' variants.
    const closeIdx = findClose(source, innerStart, close);
    if (closeIdx === -1) {
      // Unclosed tag: treat the rest as a region, report the error at a higher layer.
      pushHtml(idx);
      regions.push({
        kind,
        span: { start: idx, end: source.length },
        innerSpan: { start: innerStart, end: source.length },
        inner: source.slice(innerStart, source.length),
      });
      return regions;
    }

    // innerEnd subtracts the trim character ('-' or '_') if present.
    let innerEnd = closeIdx;
    const prev = source[closeIdx - 1];
    if (prev === '-' || prev === '_') innerEnd = closeIdx - 1;

    pushHtml(idx);
    regions.push({
      kind,
      span: { start: idx, end: closeIdx + close.length },
      innerSpan: { start: innerStart, end: innerEnd },
      inner: source.slice(innerStart, innerEnd),
    });

    pos = closeIdx + close.length;
    htmlStart = pos;
  }

  pushHtml(source.length);
  return regions;
}

/**
 * Find the closing delimiter, skipping occurrences inside JS strings.
 * Necessary because `<% if (x === "100%>") { %>` is valid EJS.
 */
function findClose(source: string, from: number, close: string): number {
  let i = from;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (source.startsWith(close, i)) return i;
    i++;
  }
  return -1;
}

/**
 * Create a "virtual HTML document": every EJS region is replaced with whitespace of the SAME LENGTH.
 *
 * This is the linchpin of the whole template-layer design (docs/kien-truc.md section 2.1):
 * since the length never changes, every offset in the virtual doc EXACTLY MATCHES the
 * original file's offset, so no source map is needed and off-by-one bugs are impossible.
 *
 * Newlines are KEPT so line numbers don't shift (important for error messages).
 */
export function toVirtualHtml(source: string, regions: EjsRegion[]): string {
  const out = source.split('');
  for (const r of regions) {
    if (r.kind === 'html') continue;
    for (let i = r.span.start; i < r.span.end && i < out.length; i++) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  }
  return out.join('');
}

/**
 * Create virtual JS for track A (server-side locals), with an offset source map.
 * The scriptlet/output regions are concatenated; `map` allows converting virtual -> original offsets.
 */
export interface VirtualJs {
  code: string;
  /** Sorted ascending by virtualStart. */
  map: Array<{ virtualStart: number; virtualEnd: number; sourceStart: number }>;
}

export function toVirtualJs(regions: EjsRegion[]): VirtualJs {
  const parts: string[] = [];
  const map: VirtualJs['map'] = [];
  let cursor = 0;

  for (const r of regions) {
    if (r.kind === 'html' || r.kind === 'comment') continue;
    // Output regions are expressions; wrap them in `__out(...)` to form a valid statement.
    const isOutput = r.kind === 'output-escaped' || r.kind === 'output-raw';
    const prefix = isOutput ? '__out(' : '';
    const suffix = isOutput ? ');\n' : '\n';

    parts.push(prefix);
    cursor += prefix.length;

    map.push({
      virtualStart: cursor,
      virtualEnd: cursor + r.inner.length,
      sourceStart: r.innerSpan.start,
    });
    parts.push(r.inner);
    cursor += r.inner.length;

    parts.push(suffix);
    cursor += suffix.length;
  }

  return { code: parts.join(''), map };
}

/** Convert an offset in the virtual JS back to an offset in the original file. -1 if it can't be mapped. */
export function mapVirtualJsOffset(vjs: VirtualJs, offset: number): number {
  for (const m of vjs.map) {
    if (offset >= m.virtualStart && offset <= m.virtualEnd) {
      return m.sourceStart + (offset - m.virtualStart);
    }
  }
  return -1;
}
