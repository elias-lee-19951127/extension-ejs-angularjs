/**
 * Pure functions behind the runtime-log feature — parsing CDP events, formatting console
 * arguments, matching/rewriting paths and URLs. No IO: opening sockets, making HTTP requests,
 * and shelling out to `docker` all stay in packages/server as adapters (ticket 02's prefactor,
 * .scratch/runtime-remote-env/issues/02-probe-an-toan-va-trang-thai-that.md) — this gives later
 * tickets (03-11) a place to put their own pure logic (mount matching, frame filtering, content
 * comparison, report building, ANSI stripping, …) alongside it.
 */
import mm from 'micromatch';

/**
 * Convert a 0-based {line, character} location — the shape both the V8 Inspector Protocol's
 * `Runtime.CallFrame` and LSP `Position` use — into a character offset within `source`. Mirrors
 * the (offset -> line/character) direction already done inline in packages/server/src/index.ts's
 * `toRange` — plain `\n` splitting, no CRLF handling, consistent with the rest of this codebase.
 */
export function offsetForLocation(source: string, line: number, character: number): number {
  const lines = source.split('\n');
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += (lines[i]?.length ?? 0) + 1; // +1 for the '\n' the split consumed
  }
  return offset + character;
}

/** CDP `Runtime.ObjectPreview` — a compact, best-effort rendering of an object/array arg. */
interface ObjectPreview {
  subtype?: string;
  overflow: boolean;
  properties: PropertyPreview[];
}

interface PropertyPreview {
  name: string;
  type: string;
  value?: string;
  valuePreview?: ObjectPreview;
}

/** A `RemoteObject` (CDP `Runtime` domain) — only the fields v1 formatting needs. */
interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: ObjectPreview;
}

/** A `CallFrame` (CDP `Runtime` domain) — only the fields the log-to-line mapping needs. */
export interface CallFrame {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** The `Runtime.consoleAPICalled` event params — only the fields v1 needs. */
interface ConsoleApiCalledEvent {
  type: string;
  args: RemoteObject[];
  stackTrace?: { callFrames: CallFrame[] };
}

function isObjectPreview(v: unknown): v is ObjectPreview {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as { overflow?: unknown; properties?: unknown };
  return typeof p.overflow === 'boolean' && Array.isArray(p.properties);
}

function isRemoteObject(v: unknown): v is RemoteObject {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { type?: unknown; preview?: unknown };
  if (typeof o.type !== 'string') return false;
  return o.preview === undefined || isObjectPreview(o.preview);
}

function isCallFrame(v: unknown): v is CallFrame {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as { url?: unknown; lineNumber?: unknown; columnNumber?: unknown };
  return typeof f.url === 'string' && typeof f.lineNumber === 'number' && typeof f.columnNumber === 'number';
}

/**
 * Is `v` a well-formed `Runtime.consoleAPICalled` event? The CDP endpoint is a network peer —
 * a malformed or unexpected-shape message must be rejected here, not throw downstream.
 */
function isConsoleApiCalledEvent(v: unknown): v is ConsoleApiCalledEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as { type?: unknown; args?: unknown; stackTrace?: unknown };
  if (typeof e.type !== 'string') return false;
  if (!Array.isArray(e.args) || !e.args.every(isRemoteObject)) return false;
  if (e.stackTrace === undefined) return true;
  if (typeof e.stackTrace !== 'object' || e.stackTrace === null) return false;
  const callFrames = (e.stackTrace as { callFrames?: unknown }).callFrames;
  return Array.isArray(callFrames) && callFrames.every(isCallFrame);
}

/**
 * A parsed console call — NOT yet anchored to a line (ticket 03,
 * .scratch/runtime-remote-env/issues/03-chon-frame.md). Earlier (ticket 01/02) this carried a
 * single already-chosen `{url, line, character}`, taken naively from `callFrames[0]`. Frame
 * selection now needs to skip library/logger frames (by pattern) and obfuscated/minified files
 * (by content — almost no newlines relative to size), which requires reading file content this
 * pure layer has no access to (no IO in packages/core). So this hands back every candidate call
 * frame, in original CDP order (top of stack first), and leaves picking one to
 * packages/server/src/index.ts's `onLog`, which has workspace/file access.
 */
export interface ParsedConsoleLog {
  callFrames: CallFrame[];
  value: string;
  severity: 'log' | 'warning' | 'error';
}

/** Collapse CDP's many console types (log/debug/info/dir/trace/…) to what the UI colors by. */
function severityOf(type: string): 'log' | 'warning' | 'error' {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warning';
  return 'log';
}

/** Render an object/array preview as compact inline text: `{a: 1, b: 2}` / `[1, 2, …]`. */
function formatPreview(preview: ObjectPreview): string {
  const parts = preview.properties.map((p) => {
    const v = p.value !== undefined ? p.value : p.valuePreview ? formatPreview(p.valuePreview) : p.type;
    return preview.subtype === 'array' ? String(v) : `${p.name}: ${v}`;
  });
  if (preview.overflow) parts.push('…');
  const body = parts.join(', ');
  return preview.subtype === 'array' ? `[${body}]` : `{${body}}`;
}

function formatArg(arg: RemoteObject): string {
  if (arg.value !== undefined) return String(arg.value);
  if (arg.preview) return formatPreview(arg.preview);
  return arg.description ?? arg.type;
}

/**
 * Parse a `Runtime.consoleAPICalled` event into `{callFrames, value, severity}`. Returns `null`
 * both when it carries no usable call frame at all — the feature only tracks logs it can anchor
 * to SOME line (spec: v1 shows the latest value PER LINE, see .scratch/inline-runtime-log/spec.md)
 * — and when `event` isn't a well-formed event at all (an untrusted CDP peer sent something
 * unexpected). Does NOT pick a frame itself (ticket 03: that naive `callFrames[0]` behavior is
 * what this ticket replaces) — see `ParsedConsoleLog`.
 */
export function parseConsoleApiCalled(event: unknown): ParsedConsoleLog | null {
  if (!isConsoleApiCalledEvent(event)) return null;
  const rawFrames = event.stackTrace?.callFrames ?? [];
  if (rawFrames.length === 0) return null;
  return {
    // Normalized to just what this feature uses — a raw CDP CallFrame also carries
    // functionName/scriptId/… this pure layer (and everything downstream of it) doesn't need.
    callFrames: rawFrames.map((f) => ({ url: f.url, lineNumber: f.lineNumber, columnNumber: f.columnNumber })),
    value: event.args.map(formatArg).join(' '),
    severity: severityOf(event.type),
  };
}

/**
 * One raw WebSocket frame from the CDP endpoint, classified:
 * - `'log'` — a console call anchored to a line, ready to draw.
 * - `'unanchored'` — a real console call the endpoint sent, but with no usable stack frame to
 *   anchor it to a line. Must still be COUNTED as a dropped log (ticket 02, item 4) — never
 *   silently disappear the way it used to.
 * - `'ignored'` — not a console call event at all (a JSON-RPC reply, unparsable JSON, some other
 *   CDP event this feature doesn't use). Not a "log" in any sense, so not counted anywhere.
 *
 * Never throws: the endpoint is a network peer, not a trusted collaborator.
 */
export type RuntimeLogMessageOutcome = { kind: 'log'; log: ParsedConsoleLog } | { kind: 'unanchored' } | { kind: 'ignored' };

export function parseRuntimeLogMessage(raw: string): RuntimeLogMessageOutcome {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: 'ignored' };
  }
  if (typeof msg !== 'object' || msg === null) return { kind: 'ignored' };
  const { method, params } = msg as { method?: unknown; params?: unknown };
  if (method !== 'Runtime.consoleAPICalled') return { kind: 'ignored' };
  const log = parseConsoleApiCalled(params);
  return log ? { kind: 'log', log } : { kind: 'unanchored' };
}

/**
 * One entry from a CDP discovery endpoint's `GET /json/list` — both `node --inspect` and Chrome
 * `--remote-debugging-port` expose this, listing every attachable target.
 */
export interface DiscoveredTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Keep only targets worth offering a connection to. Chrome's list also includes
 * `service_worker`/`background_page`/`shared_worker`/`browser`/… entries that never run user
 * console.log calls the same way a page does. Node's own target reports `type: "node"`, not
 * `"page"` — both need to pass.
 */
export function filterConnectableTargets(targets: DiscoveredTarget[]): DiscoveredTarget[] {
  return targets.filter((t) => t.type === 'page' || t.type === 'node');
}

/**
 * Rewrite a discovered target's `webSocketDebuggerUrl` to the host:port ACTUALLY used to reach
 * discovery, discarding the host/port the runtime itself advertised (ticket 02, item 2). The
 * advertised value can be wrong or unreachable — `0.0.0.0`, a container-internal interface, a
 * different hostname the runtime happens to know about — while the host:port that just
 * successfully answered `/json/list` is, by construction, reachable. Path and query string are
 * preserved unchanged (they carry the target id).
 *
 * A malformed `webSocketDebuggerUrl` (not a valid absolute URL) is returned unchanged rather than
 * throwing — the caller's own connection attempt will simply fail the same way it would have
 * before this rewrite existed.
 */
export function rewriteWebSocketUrl(webSocketDebuggerUrl: string, host: string, port: number): string {
  try {
    const u = new URL(webSocketDebuggerUrl);
    u.hostname = host;
    u.port = String(port);
    return u.toString();
  } catch {
    return webSocketDebuggerUrl;
  }
}

/** A user-configured container-path -> host-path pair (ticket 11, `ejsng.runtimeLog.pathMappings`). */
export interface PathMapping {
  remote: string;
  local: string;
}

/**
 * The result of running a path through `mapContainerPath`. `matched` is what lets a caller tell
 * "this path passed through untouched because it needs no mapping" from "no configured mapping
 * covers this path" — the second is a drop worth counting and naming (ticket 05, checklist item
 * 5: never silently), the first is the ordinary non-Docker case.
 */
export interface MappedPath {
  path: string;
  matched: boolean;
}

/**
 * Rewrite a container-internal path (what a Dockerized target's CDP events report, e.g.
 * `/app/index.js`) to the matching path on the host, via mappings — checked in order, first match
 * wins. A path with no matching mapping passes through unchanged, reported as `matched: false`.
 * `remote` only matches whole path segments: `/app2/x.js` does NOT match a `/app` mapping.
 *
 * Callers pass user-configured mappings (`ejsng.runtimeLog.pathMappings`) FIRST and mount-inferred
 * ones (ticket 05, `mappingsFromMounts`) after, so a user's own declaration always wins.
 */
export function mapContainerPath(fsPath: string, mappings: PathMapping[]): MappedPath {
  for (const { remote, local } of mappings) {
    if (fsPath === remote) return { path: local, matched: true };
    if (fsPath.startsWith(`${remote}/`)) return { path: local + fsPath.slice(remote.length), matched: true };
  }
  return { path: fsPath, matched: false };
}

/**
 * Expand `${workspaceFolder}` in every mapping's `local` side (ticket 05, checklist item 3) — so a
 * mapping can be committed to a repo's `.vscode/settings.json` and work on every machine that
 * clones it, instead of hardcoding one developer's absolute path. A `local` that carries no
 * variable is returned byte-for-byte unchanged, which is what keeps every pre-ticket-05 absolute
 * path working exactly as before.
 */
export function resolvePathMappings(mappings: PathMapping[], workspaceFolder: string): PathMapping[] {
  return mappings.map(({ remote, local }) => ({ remote, local: local.split('${workspaceFolder}').join(workspaceFolder) }));
}

// ============================================================================================
// Ticket 03 — frame selection (.scratch/runtime-remote-env/issues/03-chon-frame.md): skip
// library/logger frames by pattern, skip obfuscated/minified files by content, strip ANSI color
// codes from log values, and suggest a "wrapper" file worth skipping. Kept as a clearly separate
// addition (see the ticket's coordination note on ticket 04 touching this same file concurrently
// in a sibling worktree) — nothing above this line is touched.
// ============================================================================================

/**
 * Frames whose file/URL is treated as "library code" and never chosen as the anchor for a
 * runtime log, no matter how it's configured — Node's own internals, anything under
 * `node_modules`, and a handful of common standalone logging libraries' own source, so a
 * logger's OWN `console.log` call site (e.g. log4js's appender) never wins over the user's call
 * site that invoked the logger. `ejsng.runtimeLog.skipFrames` ADDS to this list; it never
 * replaces it (see `classifyFrameCandidates`).
 */
export const DEFAULT_SKIP_FRAME_PATTERNS: string[] = [
  'node:internal/**',
  '**/node_modules/**',
  '**/log4js/**',
  '**/winston/**',
  '**/bunyan/**',
  '**/pino/**',
];

/**
 * Does `pathOrUrl` match any of `patterns`? Returns the first matching pattern (useful for
 * diagnostics — "skipped because it matched `**\/log4js/**`"), or `null` if none match. Patterns
 * are plain glob syntax (`micromatch`, the same engine `fast-glob` already uses elsewhere in this
 * codebase for `ejsng.include`/`ejsng.exclude`) — matched directly against the frame's raw
 * `url` as CDP reports it (a plain filesystem path for Node's own frames, a `file://` URL for
 * some browser/embedder frames — `**` correctly crosses the extra `file://` segment either way).
 */
export function matchesSkipPattern(pathOrUrl: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (mm.isMatch(pathOrUrl, pattern)) return pattern;
  }
  return null;
}

/** One call frame, classified against the skip-pattern list — see `classifyFrameCandidates`. */
export interface FrameCandidate {
  frame: CallFrame;
  /** The pattern that excluded this frame, or `null` if it survives pattern filtering. */
  skippedByPattern: string | null;
}

/**
 * Classify every frame of a stack trace against the skip-pattern list (`DEFAULT_SKIP_FRAME_PATTERNS`
 * plus the user's own `ejsng.runtimeLog.skipFrames`), in original order. This is the PURE half of
 * frame selection (ticket 03): it only filters by pattern. A frame that survives here can still
 * turn out to be unusable — obfuscated/minified content, unreadable, or outside the workspace —
 * which needs file content this pure layer has no access to (packages/core has no IO); see
 * packages/server/src/index.ts's `onLog`, which walks the surviving candidates in order, reading
 * each one to apply `isLikelyMinified` and the pre-existing workspace-containment/readability
 * checks, stopping at the first candidate that clears everything.
 */
export function classifyFrameCandidates(callFrames: CallFrame[], userSkipPatterns: string[]): FrameCandidate[] {
  const patterns = [...DEFAULT_SKIP_FRAME_PATTERNS, ...userSkipPatterns];
  return callFrames.map((frame) => ({ frame, skippedByPattern: matchesSkipPattern(frame.url, patterns) }));
}

/** Below this size, a file is too short for line-density to mean anything — never flag it. */
const MIN_LENGTH_TO_CHECK_MINIFIED = 300;
/** Minified/obfuscated code is usually crammed onto one (or very few) very long lines. */
const MAX_AVG_LINE_LENGTH = 200;

/**
 * Heuristic for "this file is minified/obfuscated, with no source map to see through it" (ticket
 * 03: user stories #16, #3 of the ticket's checklist) — almost no newline characters relative to
 * the file's size. Measured as average characters PER LINE (`length / (newlineCount + 1)`)
 * rather than a raw newline count, so it scales correctly with file size: a genuinely short file
 * with zero newlines (a one-line test fixture, a trivial config file) is NOT flagged just for
 * being short — `MIN_LENGTH_TO_CHECK_MINIFIED` exempts it outright — while a multi-megabyte
 * bundle squeezed onto one line very much is.
 */
export function isLikelyMinified(source: string): boolean {
  if (source.length < MIN_LENGTH_TO_CHECK_MINIFIED) return false;
  const newlineCount = (source.match(/\n/g) ?? []).length;
  const avgLineLength = source.length / (newlineCount + 1);
  return avgLineLength > MAX_AVG_LINE_LENGTH;
}

/**
 * Strips ANSI/SGR color escape codes (`\x1B[32m`, …) from a log VALUE before it's drawn (ticket
 * 03, checklist item 5) — the log4js layout the spec's motivating environment uses colors its
 * output, and those raw escape codes would otherwise show up as literal garbage characters in
 * the decoration. Only the value text is touched; severity-based coloring in the UI is a
 * completely separate mechanism (decoration color keyed off `severity`) and is untouched by this.
 * Covers standard CSI sequences (`ESC [ <params> <final-letter>`), which is what SGR color codes
 * (and the large majority of real-world terminal color output) use.
 */
// `\x1B`, not a raw ESC byte, so the escape character stays VISIBLE in this source file, in
// diffs, and in code review -- an invisible control byte here would be a silent, undetectable
// place for a future edit/copy-paste to corrupt.
const ANSI_CSI_PATTERN = /\x1B\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI_PATTERN, '');
}

/** One frame from a log's stack trace, as reported to the panel — see `RuntimeLogFrameDiagnostic`. */
export interface FrameDiagnosticEntry {
  url: string;
  lineNumber: number;
  columnNumber: number;
  /**
   * `null` means this is the frame that was actually chosen and drawn. `'no-path-mapping'` is
   * ticket 05's addition: the runtime reported a path no mapping covers (neither the user's own
   * nor any inferred from the connected container's mounts), so it could not even be turned into
   * a path on this machine to look for.
   */
  skipReason: 'skip-pattern' | 'obfuscated' | 'outside-workspace' | 'unreadable-file' | 'no-path-mapping' | null;
  /** Only set when `skipReason` is `'skip-pattern'`. */
  matchedPattern?: string;
}

/**
 * One recent log's full frame-selection story (ticket 03, checklist item 6: the panel shows the
 * chosen stack plus every skipped frame, with its reason, for the last few logs). Built in
 * packages/server/src/index.ts's `onLog` (it needs the per-frame skip reasons that only become
 * known after reading file content) and kept, per connection, as a small bounded ring buffer for
 * `ejsng/runtimeStatus` to report.
 */
export interface RuntimeLogFrameDiagnostic {
  frames: FrameDiagnosticEntry[];
  /** Workspace-relative path of the frame that was actually drawn, or `null` if none was. */
  chosenPath: string | null;
  /**
   * `Date.now()` when this log was processed — lets a consumer merge several connections'
   * `recentFrameDiagnostics` ring buffers and sort by TRUE recency instead of by connection
   * iteration order (packages/vscode-client/src/runtime-log-state.ts's `summarizeRuntimeStatus`
   * does exactly this when several runtime connections are live at once).
   */
  at: number;
}

/** Default options for `suggestWrapperFile` — see there. */
const DEFAULT_WRAPPER_SUGGESTION_OPTIONS = { minSamples: 20, shareThreshold: 0.6 };

/**
 * Ticket 03, checklist item 7: one file's frame winning an unusually large share of recently
 * CHOSEN frames is a signal of a project-local logging wrapper (e.g. a `log.js` every call
 * funnels through, not caught by `DEFAULT_SKIP_FRAME_PATTERNS` because it's the user's own code)
 * — the panel SUGGESTS adding it to `ejsng.runtimeLog.skipFrames`, but never adds it
 * automatically (only the user clicking "skip this file" writes the setting — see
 * packages/vscode-client/src/runtime-log-view.ts). `recentChosenPaths` is a bounded, most-recent-
 * first-or-last-agnostic ring buffer of every log's chosen frame's workspace-relative path.
 * `minSamples` guards against 2-3 early logs from a legitimately single-file test script
 * immediately triggering a suggestion; `shareThreshold` is the fraction of recent logs one file
 * must account for.
 */
export function suggestWrapperFile(
  recentChosenPaths: string[],
  options: { minSamples?: number; shareThreshold?: number } = {},
): { path: string; share: number } | null {
  const { minSamples, shareThreshold } = { ...DEFAULT_WRAPPER_SUGGESTION_OPTIONS, ...options };
  if (recentChosenPaths.length < minSamples) return null;

  const counts = new Map<string, number>();
  for (const p of recentChosenPaths) counts.set(p, (counts.get(p) ?? 0) + 1);

  let top: { path: string; count: number } | null = null;
  for (const [path, count] of counts) {
    if (!top || count > top.count) top = { path, count };
  }
  if (!top) return null;

  const share = top.count / recentChosenPaths.length;
  return share >= shareThreshold ? { path: top.path, share } : null;
}
