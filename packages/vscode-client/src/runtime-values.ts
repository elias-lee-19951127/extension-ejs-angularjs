/**
 * What the Values panel shows, worked out from `RuntimeLogState` — the panel at the bottom that
 * reads like a debugger's Frames and Variables: every line that logged, then the value one of its
 * hits logged as a tree. No `vscode` import: rows in, rows out, tested without an Extension Host.
 */
/**
 * One node of the Values panel's tree — mirrors `ValueTreeNode` in packages/core/src/runtime-format.ts,
 * as the server sends it over `ejsng/inspectRuntimeLog`.
 */
export interface ValueTreeNode {
  name: string;
  kind: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'function' | 'unexpanded' | 'other' | 'object' | 'array' | 'more';
  type?: string;
  text: string;
  json?: unknown;
  children?: ValueTreeNode[];
}
import type { RuntimeLogEntry, RuntimeLogLine, RuntimeLogState } from './runtime-log-state';

/** One line that logged, as the panel's left-hand list shows it. */
export interface ValueSiteRow {
  /** `siteId` — stable while the line keeps its number. */
  id: string;
  /** Workspace-relative path. */
  file: string;
  /** 1-based, as an editor shows it. */
  line: number;
  severity: RuntimeLogEntry['severity'];
  count: number;
  /** `Date.now()` of the latest hit — what the list is sorted by, newest first. */
  at: number;
  /** The latest value on one line. */
  preview: string;
}

/** One hit of the selected line, for the strip above the tree. */
export interface ValueHitRow {
  time: string;
  source: string;
  severity: RuntimeLogEntry['severity'];
  preview: string;
}

/** What the tree pane shows for one hit. */
export interface ValueDetail {
  id: string;
  hit: number;
  hits: ValueHitRow[];
  /** Hits beyond the ones kept — they were counted but their values are gone. */
  dropped: number;
  roots: ValueTreeNode[];
  /** Why the tree is less than the whole value, when it is. */
  note?: string;
}

/** `12@file:///a/b.js` — the line first, since a URI can hold anything after it. */
export function siteId(uri: string, line: number): string {
  return `${line}@${uri}`;
}

export function parseSiteId(id: string): { uri: string; line: number } | null {
  const at = id.indexOf('@');
  if (at <= 0) return null;
  const line = Number(id.slice(0, at));
  return Number.isInteger(line) && line >= 0 ? { uri: id.slice(at + 1), line } : null;
}

/** `14:03:22`, local time. */
export function clockTime(ms: number | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function oneLine(value: string, max = 160): string {
  const flat = value.replace(/\s*\n\s*/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const latestText = (e: RuntimeLogEntry): string => e.inline ?? e.value;

/** Every logged line in every file, most recently hit first. */
export function valueSites(state: RuntimeLogState, relativePath: (uri: string) => string): ValueSiteRow[] {
  const rows: ValueSiteRow[] = [];
  for (const uri of state.files()) {
    for (const l of state.linesFor(uri)) {
      const latest = l.history[0];
      if (!latest) continue;
      rows.push({
        id: siteId(uri, l.line),
        file: relativePath(uri),
        line: l.line + 1,
        severity: latest.severity,
        count: l.count,
        at: latest.at ?? 0,
        preview: oneLine(latestText(latest)),
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at || a.file.localeCompare(b.file) || a.line - b.line);
}

/** The hits of one line, most recent first, and how many more were counted than kept. */
export function valueHits(line: RuntimeLogLine): { hits: ValueHitRow[]; dropped: number } {
  return {
    hits: line.history.map((e) => ({
      time: clockTime(e.at),
      source: e.source ?? 'unknown runtime',
      severity: e.severity,
      preview: oneLine(latestText(e), 80),
    })),
    dropped: Math.max(0, line.count - line.history.length),
  };
}

/**
 * A hit whose value the runtime no longer holds, or that arrived too soon after the one before it
 * to be kept: the text it was drawn with, as the tree's only node.
 */
export function textOnlyRoots(entry: RuntimeLogEntry): ValueTreeNode[] {
  return [{ name: 'value', kind: 'other', text: entry.expanded ?? entry.value }];
}
