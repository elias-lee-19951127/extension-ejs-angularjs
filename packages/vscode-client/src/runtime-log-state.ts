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
  /** `host:port` of the connection it came from — what a reconnect resets. */
  endpoint?: string;
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

/** How many past values each line keeps for its hover (.scratch/inline-runtime-log/issues/05-log-history.md). */
export const RUNTIME_LOG_HISTORY_PER_LINE = 10;

/** One line's runtime log: the latest value, the last few before it, and how many hits in total. */
export interface RuntimeLogLine {
  line: number;
  /** Most recent first; `history[0]` is the value drawn inline. At most `RUNTIME_LOG_HISTORY_PER_LINE`. */
  history: RuntimeLogEntry[];
  /** Every hit since the last reset — can exceed `history.length`, which is capped. */
  count: number;
}

interface LineState {
  history: RuntimeLogEntry[];
  /** Hits per endpoint, so resetting one endpoint subtracts exactly its own hits from the total. */
  countByEndpoint: Map<string, number>;
}

const total = (l: LineState): number => [...l.countByEndpoint.values()].reduce((a, b) => a + b, 0);

/**
 * Per-file, per-line runtime log state: the latest value per line (spec decision #6), plus — ticket
 * 05 — a short history and a hit count, for a line that runs many times in a loop. Memory is
 * bounded per line (`RUNTIME_LOG_HISTORY_PER_LINE`), whatever the log rate.
 *
 * Kept here in the client, next to the decorations it feeds, rather than in the server as the
 * ticket first suggested: the server has never held drawn state, and the latest-value state this
 * extends was already client-side. No `vscode` import — pure state, tested without an Extension Host.
 */
export class RuntimeLogState {
  private readonly byUri = new Map<string, Map<number, LineState>>();

  /** Record a notification; returns every current (latest) entry for that file. */
  record(uri: string, entry: RuntimeLogEntry): RuntimeLogEntry[] {
    let lines = this.byUri.get(uri);
    if (!lines) {
      lines = new Map();
      this.byUri.set(uri, lines);
    }
    let state = lines.get(entry.line);
    if (!state) {
      state = { history: [], countByEndpoint: new Map() };
      lines.set(entry.line, state);
    }
    state.history.unshift(entry);
    if (state.history.length > RUNTIME_LOG_HISTORY_PER_LINE) state.history.length = RUNTIME_LOG_HISTORY_PER_LINE;
    const endpoint = entry.endpoint ?? '';
    state.countByEndpoint.set(endpoint, (state.countByEndpoint.get(endpoint) ?? 0) + 1);
    return this.entriesFor(uri);
  }

  /** All current (latest) entries for a file — e.g. to redraw decorations after reopening a document. */
  entriesFor(uri: string): RuntimeLogEntry[] {
    return this.linesFor(uri).map((l) => l.history[0]!);
  }

  /** Every line of a file with its history and hit count — what decorations and hovers are drawn from. */
  linesFor(uri: string): RuntimeLogLine[] {
    return [...(this.byUri.get(uri)?.entries() ?? [])].map(([line, l]) => ({ line, history: [...l.history], count: total(l) }));
  }

  /** Drop all state for a file. */
  clear(uri: string): void {
    this.byUri.delete(uri);
  }

  /**
   * Forget everything one endpoint reported — it just (re)connected, so what it logged before
   * came from a run that is over (the app restarted, or was redeployed). Other runtimes' values
   * on the same lines stay. Returns the files that changed, to redraw.
   */
  resetEndpoint(endpoint: string): string[] {
    const changed: string[] = [];
    for (const [uri, lines] of this.byUri) {
      let touched = false;
      for (const [line, state] of lines) {
        if (!state.countByEndpoint.has(endpoint)) continue;
        touched = true;
        state.countByEndpoint.delete(endpoint);
        state.history = state.history.filter((e) => (e.endpoint ?? '') !== endpoint);
        if (state.history.length === 0) lines.delete(line);
      }
      if (touched) changed.push(uri);
      if (lines.size === 0) this.byUri.delete(uri);
    }
    return changed;
  }

  /**
   * Keep lines attached to their code across an edit: lines `startLine..endLine` (0-based, as they
   * were) were replaced by text spanning `newLineCount` lines. Lines above are untouched, lines
   * below move by the difference, and lines strictly inside a multi-line replacement are dropped —
   * their code is gone. The edited start line keeps its values. Returns whether anything changed.
   */
  applyEdit(uri: string, startLine: number, endLine: number, newLineCount: number): boolean {
    const lines = this.byUri.get(uri);
    if (!lines) return false;
    const delta = newLineCount - 1 - (endLine - startLine);
    if (delta === 0 && endLine === startLine) return false;
    const moved = new Map<number, LineState>();
    let changed = false;
    for (const [line, state] of lines) {
      if (line <= startLine) moved.set(line, state);
      else if (line <= endLine) changed = true; // replaced
      else {
        moved.set(line + delta, { ...state, history: state.history.map((e) => ({ ...e, line: line + delta })) });
        if (delta !== 0) changed = true;
      }
    }
    this.byUri.set(uri, moved);
    return changed;
  }
}

/** The inline text for a line: its latest value, and how many hits when there were several. */
export function formatRuntimeLogInline(line: RuntimeLogLine): string {
  const value = line.history[0]?.value ?? '';
  return line.count > 1 ? `  » ${value} (×${line.count})` : `  » ${value}`;
}

/** A value shortened to one line for the history list in a hover. */
function oneLine(value: string, max = 120): string {
  const flat = value.replace(/\s*\n\s*/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The earlier values listed under the latest one in a hover, most recent first — each with its
 * own source and time, since two containers can take turns on the same line. The last entry says
 * how many hits are no longer kept, if any.
 */
export function formatRuntimeLogHistory(line: RuntimeLogLine): string[] {
  const earlier = line.history.slice(1).map((e) => `${formatRuntimeLogHoverTitle(e)} — ${oneLine(e.value)}`);
  const dropped = line.count - line.history.length;
  if (dropped > 0) earlier.push(`…and ${dropped} earlier not kept`);
  return earlier;
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
