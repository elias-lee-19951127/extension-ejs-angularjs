/** One `ejsng/runtimeLog` hit, already anchored to a line — see RuntimeLogState below. */
export interface RuntimeLogEntry {
  line: number;
  character: number;
  value: string;
  severity: 'log' | 'warning' | 'error';
  /** Which runtime connection produced the value (`cityos-app`, `node 127.0.0.1:9229`, `browser: …`). */
  source?: string;
  /** `Date.now()` when the value arrived. */
  at?: number;
}

/**
 * The first line of an inline log's hover: where the value came from and when, e.g.
 * `cityos-app · warning · 11:42:03`. The value itself follows it in full, since the inline text
 * is one line and a long object preview is easier to read there.
 */
export function formatRuntimeLogHoverTitle(entry: RuntimeLogEntry): string {
  const parts = [entry.source ?? 'unknown runtime', entry.severity];
  if (entry.at !== undefined) {
    const d = new Date(entry.at);
    parts.push([d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'));
  }
  return parts.join(' · ');
}

/**
 * One frame from a recent log's stack trace, as reported by `ejsng/runtimeStatus` — mirrors
 * `FrameDiagnosticEntry` in packages/core/src/runtime-log.ts (ticket 03,
 * .scratch/runtime-remote-env/issues/03-chon-frame.md). `skipReason: null` marks the frame that
 * was actually chosen and drawn.
 */
export interface RuntimeFrameDiagnosticEntry {
  url: string;
  lineNumber: number;
  columnNumber: number;
  skipReason:
    | 'skip-pattern'
    | 'obfuscated'
    | 'outside-workspace'
    | 'unreadable-file'
    | 'no-path-mapping'
    | 'stale-file'
    | 'shadowed-file'
    | 'content-mismatch'
    | 'ambiguous-url-match'
    | null;
  matchedPattern?: string;
  /** Only set for `'shadowed-file'` — the file the runtime IS running (ticket 06). */
  runtimePath?: string;
  /** Only set for `'ambiguous-url-match'` — the files that tied for the longest matching tail (ticket 07). */
  candidates?: string[];
  /** Set for `'unreadable-file'` and `'outside-workspace'` — the path on this machine the frame was looked for at. */
  hostPath?: string;
}

/** One recent log's full frame-selection story — mirrors `RuntimeLogFrameDiagnostic` in packages/core. */
export interface RuntimeLogFrameDiagnostic {
  frames: RuntimeFrameDiagnosticEntry[];
  chosenPath: string | null;
  /** `Date.now()` when the server processed this log — used to merge multiple connections' recentLogs by TRUE recency, not connection iteration order. */
  at: number;
  /** How many logs in a row told this exact story (the server keeps one entry for them). Absent means 1. */
  count?: number;
}

/** A file that looks like a logging wrapper — see `formatWrapperSuggestionText`. */
export interface WrapperSuggestion {
  path: string;
  share: number;
}

/** One connection's real status, as returned by the `ejsng/runtimeStatus` LSP request (ticket 02, item 4). */
export interface RuntimeStatusConnection {
  key: string;
  state: 'connecting' | 'connected' | 'failed';
  reason?: string;
  received: number;
  drawn: number;
  droppedByReason: Record<string, number>;
  /** Ticket 03, item 6 — the last few logs' frame-selection story, most recent last. */
  recentLogs: RuntimeLogFrameDiagnostic[];
  /** Ticket 03, item 7 — a file dominating recently chosen frames, or `null`. */
  wrapperSuggestion: WrapperSuggestion | null;
  /** Ticket 08, item 4 — directories outside the workspace that logs were drawn in. Suggestions only. */
  outsideWorkspaceDirs?: string[];
  /** Ticket 07, item 4 — URL prefix -> local directory, discovered by suffix matching. Session-only until the user saves one. */
  urlMappings?: RuntimePathMapping[];
}

/** A container/URL path prefix and the local directory it stands for — mirrors `PathMapping` in packages/core. */
export interface RuntimePathMapping {
  remote: string;
  local: string;
}

/** Totals across every live connection — what the status bar and panel actually show. */
export interface RuntimeStatusSummary {
  received: number;
  drawn: number;
  dropped: number;
  connecting: number;
  connected: number;
  failed: number;
  /** Every connection's recentLogs, merged and capped to the same size as one connection's own buffer. */
  recentLogs: RuntimeLogFrameDiagnostic[];
  /** The strongest suggestion across every connection (highest `share`), or `null`. */
  wrapperSuggestion: WrapperSuggestion | null;
  /** Ticket 08, item 4 — every connection's outside-the-workspace directories, de-duplicated. */
  outsideWorkspaceDirs: string[];
  /** Ticket 07, item 4 — every connection's discovered URL mappings, de-duplicated by remote+local. */
  urlMappings: RuntimePathMapping[];
}

/** Keep the panel's "recent logs" list to a reasonable size even with several live connections. */
const MAX_SUMMARY_RECENT_LOGS = 5;

/**
 * Aggregate every live connection's counts into one summary. No `vscode` import — pure, so the
 * status bar/panel formatting can be unit tested without an Extension Host, same as
 * `RuntimeLogState` below.
 */
export function summarizeRuntimeStatus(connections: RuntimeStatusConnection[]): RuntimeStatusSummary {
  const summary: RuntimeStatusSummary = {
    received: 0,
    drawn: 0,
    dropped: 0,
    connecting: 0,
    connected: 0,
    failed: 0,
    recentLogs: [],
    wrapperSuggestion: null,
    outsideWorkspaceDirs: [],
    urlMappings: [],
  };
  const outsideDirs = new Set<string>();
  const urlMappings = new Map<string, RuntimePathMapping>();
  for (const c of connections) {
    summary.received += c.received;
    summary.drawn += c.drawn;
    summary.dropped += Object.values(c.droppedByReason).reduce((a, b) => a + b, 0);
    summary[c.state]++;
    summary.recentLogs.push(...(c.recentLogs ?? []));
    if (c.wrapperSuggestion && (!summary.wrapperSuggestion || c.wrapperSuggestion.share > summary.wrapperSuggestion.share)) {
      summary.wrapperSuggestion = c.wrapperSuggestion;
    }
    for (const dir of c.outsideWorkspaceDirs ?? []) outsideDirs.add(dir);
    for (const m of c.urlMappings ?? []) urlMappings.set(`${m.remote}\u0000${m.local}`, m);
  }
  summary.outsideWorkspaceDirs = [...outsideDirs];
  summary.urlMappings = [...urlMappings.values()];
  // Sort by TRUE recency (`at`) before capping — with several live connections, concatenation
  // order is connection-iteration order, not chronological, so slicing from the end without
  // sorting first could drop a genuinely more-recent entry in favor of an older one from a
  // connection that merely happened to be iterated later.
  summary.recentLogs.sort((a, b) => a.at - b.at);
  if (summary.recentLogs.length > MAX_SUMMARY_RECENT_LOGS) {
    summary.recentLogs = summary.recentLogs.slice(-MAX_SUMMARY_RECENT_LOGS);
  }
  return summary;
}

/** A short, human-readable explanation of why a frame was (or wasn't) skipped — panel item 6. */
export function formatSkipReason(entry: RuntimeFrameDiagnosticEntry): string {
  switch (entry.skipReason) {
    case null:
      return 'chosen';
    case 'skip-pattern':
      return `skipped — matches ${entry.matchedPattern ?? 'a skip pattern'}`;
    case 'obfuscated':
      return 'skipped — looks minified/obfuscated';
    case 'outside-workspace':
      return entry.hostPath ? `skipped — outside the workspace (${entry.hostPath})` : 'skipped — outside the workspace';
    case 'unreadable-file':
      return entry.hostPath ? `skipped — file not readable at ${entry.hostPath}` : 'skipped — file not readable';
    case 'no-path-mapping':
      return 'skipped — no path mapping covers this path';
    case 'stale-file':
      return 'not drawn — the file changed since the runtime loaded it; restart the app';
    case 'shadowed-file':
      return `not drawn — the runtime is running ${entry.runtimePath ?? 'another copy of this file'}`;
    case 'content-mismatch':
      return 'not drawn — this file is not what the runtime is running; check the path mapping, or restart the app';
    case 'ambiguous-url-match':
      return `not drawn — this URL could be any of: ${(entry.candidates ?? []).join(', ')}`;
  }
}

/** The wrapper-suggestion banner's text (ticket 03, item 7). */
export function formatWrapperSuggestionText(suggestion: WrapperSuggestion): string {
  const percent = Math.round(suggestion.share * 100);
  return `"${suggestion.path}" accounts for ${percent}% of recent logs — looks like a wrapper.`;
}

/**
 * Escape micromatch/glob metacharacters in a literal path segment (ticket 03: `matchesSkipPattern`
 * in packages/core matches `ejsng.runtimeLog.skipFrames` patterns with micromatch) — used when
 * building the pattern for "Skip this file" (see extension.ts's `acceptWrapperSuggestion`).
 * Without this, a wrapper file whose path happens to contain glob-special characters
 * (`(shared)`, `[legacy]`, a leading `!`, …) would produce a pattern that micromatch parses as an
 * extglob/negation/char-class instead of matching the literal file it was meant for.
 */
export function escapeGlobPath(path: string): string {
  return path.replace(/[*?[\]{}()!+@|\\]/g, '\\$&');
}

/**
 * The status bar text (ticket 02, item 4: "received / drawn / dropped" instead of just a
 * connection count — the panel checklist that ALSO explains a `connecting`/`failed` connection
 * step-by-step is ticket 09's job; this is deliberately just a one-line summary).
 */
export function formatRuntimeStatusBarText(connectionCount: number, summary: RuntimeStatusSummary): string {
  if (connectionCount === 0) return 'EJS/NG Runtime: off';
  const note = summary.connecting > 0 ? ' (connecting…)' : summary.failed > 0 ? ' (failed)' : '';
  return `EJS/NG Runtime: received ${summary.received} / drawn ${summary.drawn} / dropped ${summary.dropped}${note}`;
}

/**
 * Per-file, per-line latest-value state (spec decision #6: no history, latest value per line
 * wins). No `vscode` import — pure state, so the extension's decoration-drawing code can stay a
 * thin layer on top of this.
 */
export class RuntimeLogState {
  private readonly byUri = new Map<string, Map<number, RuntimeLogEntry>>();

  /** Record a notification; returns every current entry for that file. */
  record(uri: string, entry: RuntimeLogEntry): RuntimeLogEntry[] {
    let lines = this.byUri.get(uri);
    if (!lines) {
      lines = new Map();
      this.byUri.set(uri, lines);
    }
    lines.set(entry.line, entry);
    return [...lines.values()];
  }

  /** All current entries for a file — e.g. to redraw decorations after reopening a document. */
  entriesFor(uri: string): RuntimeLogEntry[] {
    return [...(this.byUri.get(uri)?.values() ?? [])];
  }

  /** Drop all state for a file — e.g. its target process restarted. */
  clear(uri: string): void {
    this.byUri.delete(uri);
  }
}

// ---------------------------------------------------------------------------------------------
// Ticket 09 (.scratch/runtime-remote-env/issues/09-panel-danh-sach-kiem-tra.md): the checklist
// panel. The steps themselves are built by the server (packages/core/src/runtime-log-checklist.ts)
// and only mirrored here, so the client stays a thin renderer.
// ---------------------------------------------------------------------------------------------

/** A fix the panel can apply in place — mirrors `ChecklistFix` in packages/core. */
export type RuntimeChecklistFix =
  | { kind: 'save-mapping'; label: string; remote: string; local: string }
  | { kind: 'skip-frame'; label: string; path: string }
  | { kind: 'add-folder'; label: string; path: string }
  | { kind: 'copy-compose'; label: string; snippet: string }
  | { kind: 'open-mirrored-guide'; label: string; url: string }
  | { kind: 'open-settings'; label: string; query: string };

/** One checklist step, as returned by `ejsng/runtimeChecklist` — mirrors `ChecklistStep` in packages/core. */
export interface RuntimeChecklistStep {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'fail' | 'pending' | 'skipped';
  detail: string;
  notes: string[];
  fixes: RuntimeChecklistFix[];
  dropGroups?: Array<{ reason: string; label: string; count: number }>;
  counts?: { received: number; drawn: number; dropped: number };
}

const FIX_STRING_FIELDS: Record<RuntimeChecklistFix['kind'], string[]> = {
  'save-mapping': ['remote', 'local'],
  'skip-frame': ['path'],
  'add-folder': ['path'],
  'copy-compose': ['snippet'],
  'open-mirrored-guide': ['url'],
  'open-settings': ['query'],
};

/**
 * A fix posted back from the webview, checked before anything acts on it: a known kind with
 * every field that kind needs. The guide URL is additionally pinned to https, since it is opened
 * in the user's browser.
 */
export function isRuntimeChecklistFix(value: unknown): value is RuntimeChecklistFix {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(FIX_STRING_FIELDS, kind)) return false;
  const fields = FIX_STRING_FIELDS[kind as RuntimeChecklistFix['kind']];
  if (!fields.every((f) => typeof (value as Record<string, unknown>)[f] === 'string' && (value as Record<string, string>)[f] !== '')) return false;
  if (kind === 'open-mirrored-guide') return (value as { url: string }).url.startsWith('https://');
  return true;
}

/**
 * Where a mapping the user clicked Save on is written (spec decisions #12, user story #40): a
 * `local` inside the workspace folder becomes `${workspaceFolder}/…` in Workspace settings, so the
 * mapping can be committed and works for everyone who clones the repo; anything else stays an
 * absolute path in User settings, since it names a directory on this machine only.
 */
export function mappingForSettings(
  remote: string,
  local: string,
  workspaceFolder: string | undefined,
): { mapping: RuntimePathMapping; target: 'workspace' | 'user' } {
  const inside = workspaceFolder !== undefined && (local === workspaceFolder || local.startsWith(`${workspaceFolder}/`));
  if (!inside) return { mapping: { remote, local }, target: 'user' };
  return { mapping: { remote, local: `\${workspaceFolder}${local.slice(workspaceFolder.length)}` }, target: 'workspace' };
}

/**
 * Order the Docker containers offered in the Quick Pick so the one whose app port the user picked
 * last time comes first (user story #41: remembered per machine in `workspaceState`, never in the
 * repo). Order is otherwise preserved.
 */
export function orderByLastAppPort<T extends { appPorts?: number[] }>(
  candidates: T[],
  lastAppPort: number | undefined,
): Array<T & { lastUsed: boolean }> {
  const marked = candidates.map((c) => ({ ...c, lastUsed: lastAppPort !== undefined && (c.appPorts ?? []).includes(lastAppPort) }));
  return [...marked.filter((c) => c.lastUsed), ...marked.filter((c) => !c.lastUsed)];
}
