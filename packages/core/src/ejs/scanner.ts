import type { Span } from '../types';

export type EjsRegionKind =
  | 'html'
  | 'scriptlet' // <% ... %>
  | 'output-escaped' // <%= ... %>
  | 'output-raw' // <%- ... %>
  | 'comment'; // <%# ... %>

export interface EjsRegion {
  kind: EjsRegionKind;
  /** Span cua CA the, ke ca delimiter. */
  span: Span;
  /** Span cua phan noi dung ben trong delimiter. */
  innerSpan: Span;
  inner: string;
}

/**
 * Quet mot file EJS thanh cac region.
 *
 * Ho tro day du bo delimiter cua EJS:
 *   <%  scriptlet        %>  ket thuc thuong
 *   <%= output escaped   -%> ket thuc + nuot newline
 *   <%- output raw       _%> ket thuc + nuot whitespace
 *   <%# comment
 *   <%_ scriptlet + nuot whitespace dau
 *   <%% literal '<%'  (khong mo region)
 *
 * `delimiter` mac dinh '%' cho ra '<%' / '%>'. Doi thanh '?' cho ra '<?' / '?>'.
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

    // '<%%' la escape cho ky tu '<%' theo nghia den, khong mo region.
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

    // Tim close gan nhat. Phai kiem tra ca bien the '-%>' va '_%>'.
    const closeIdx = findClose(source, innerStart, close);
    if (closeIdx === -1) {
      // Tag khong dong: coi phan con lai la region, bao loi o tang tren.
      pushHtml(idx);
      regions.push({
        kind,
        span: { start: idx, end: source.length },
        innerSpan: { start: innerStart, end: source.length },
        inner: source.slice(innerStart, source.length),
      });
      return regions;
    }

    // innerEnd tru di ky tu trim ('-' hoac '_') neu co.
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
 * Tim delimiter dong, bo qua cac lan xuat hien ben trong chuoi JS.
 * Can thiet vi `<% if (x === "100%>") { %>` la hop le trong EJS.
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
 * Tao "virtual HTML document": moi region EJS bi thay bang khoang trang CUNG DO DAI.
 *
 * Day la mau chot cua toan bo thiet ke tang template (docs/kien-truc.md muc 2.1):
 * vi do dai khong doi, moi offset trong virtual doc TRUNG KHIT offset file goc,
 * nen khong can source map va khong the co bug off-by-one.
 *
 * Newline duoc GIU LAI de so dong khong lech (quan trong cho thong bao loi).
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
 * Tao virtual JS cho truc A (server-side locals), kem source map offset.
 * Cac region scriptlet/output duoc noi lai; `map` cho phep doi offset virtual -> goc.
 */
export interface VirtualJs {
  code: string;
  /** Sap xep tang dan theo virtualStart. */
  map: Array<{ virtualStart: number; virtualEnd: number; sourceStart: number }>;
}

export function toVirtualJs(regions: EjsRegion[]): VirtualJs {
  const parts: string[] = [];
  const map: VirtualJs['map'] = [];
  let cursor = 0;

  for (const r of regions) {
    if (r.kind === 'html' || r.kind === 'comment') continue;
    // Region output la bieu thuc; boc trong `(...)` de thanh cau lenh hop le.
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

/** Doi offset trong virtual JS ve offset file goc. -1 neu khong map duoc. */
export function mapVirtualJsOffset(vjs: VirtualJs, offset: number): number {
  for (const m of vjs.map) {
    if (offset >= m.virtualStart && offset <= m.virtualEnd) {
      return m.sourceStart + (offset - m.virtualStart);
    }
  }
  return -1;
}
