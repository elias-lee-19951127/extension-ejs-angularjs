/**
 * Pure functions behind the runtime-log feature — parsing CDP events, formatting console
 * arguments, matching/rewriting paths and URLs. No IO: opening sockets, making HTTP requests,
 * and shelling out to `docker` all stay in packages/server as adapters (ticket 02's prefactor,
 * .scratch/runtime-remote-env/issues/02-probe-an-toan-va-trang-thai-that.md) — this gives later
 * tickets (03-11) a place to put their own pure logic (mount matching, frame filtering, content
 * comparison, report building, ANSI stripping, …) alongside it.
 */
import mm from 'micromatch';
import { logpointIdFromUrl } from './logpoint';

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
export interface ObjectPreview {
  subtype?: string;
  overflow: boolean;
  properties: PropertyPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  subtype?: string;
  value?: string;
  valuePreview?: ObjectPreview;
}

/** A `RemoteObject` (CDP `Runtime` domain) — the fields formatting and Observed Type use. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  preview?: ObjectPreview;
  /** Handle for `Runtime.getProperties` — held by the runtime until its console is cleared. */
  objectId?: string;
}

/** A `CallFrame` (CDP `Runtime` domain) — only the fields the log-to-line mapping needs. */
export interface CallFrame {
  url: string;
  lineNumber: number;
  columnNumber: number;
  /**
   * The script this frame is in, as V8 numbers it — the join key to `Debugger.scriptParsed`
   * metadata (ticket 06's content verification). Optional because it is only usable when the
   * `Debugger` domain is enabled on that connection and the event actually carried it; a frame
   * without it simply can't be content-verified, and is drawn on the path match alone, exactly as
   * before ticket 06.
   */
  scriptId?: string;
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
  const f = v as { url?: unknown; lineNumber?: unknown; columnNumber?: unknown; scriptId?: unknown };
  if (typeof f.url !== 'string' || typeof f.lineNumber !== 'number' || typeof f.columnNumber !== 'number') return false;
  return f.scriptId === undefined || typeof f.scriptId === 'string';
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
  /**
   * Set when this call came from a logpoint's condition (.scratch/inline-logpoints/spec.md) rather
   * than from the user's own code. Its condition frame is already removed from `callFrames`, so the
   * first frame is the line the logpoint sits on.
   */
  logpointId?: number;
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
  let rawFrames = event.stackTrace?.callFrames ?? [];
  // A logpoint's console call runs inside its breakpoint condition, whose own frame (named by the
  // `sourceURL` the condition carries) sits on top of the line the logpoint is on. Drop it, and
  // join the arguments WITHOUT the space console-style joining adds: they are the pieces of one
  // message the user wrote, spacing included.
  const logpointId = rawFrames[0] ? logpointIdFromUrl(rawFrames[0].url) : null;
  if (logpointId !== null) rawFrames = rawFrames.slice(1);
  if (rawFrames.length === 0) return null;
  return {
    // Normalized to just what this feature uses — a raw CDP CallFrame also carries
    // functionName/… this pure layer (and everything downstream of it) doesn't need.
    callFrames: rawFrames.map((f) => ({
      url: f.url,
      lineNumber: f.lineNumber,
      columnNumber: f.columnNumber,
      ...(f.scriptId !== undefined ? { scriptId: f.scriptId } : {}),
    })),
    value: event.args.map(formatArg).join(logpointId !== null ? '' : ' '),
    severity: severityOf(event.type),
    ...(logpointId !== null ? { logpointId } : {}),
  };
}

/**
 * One raw WebSocket frame from the CDP endpoint, classified:
 * - `'log'` — a console call anchored to a line, ready to draw.
 * - `'unanchored'` — a real console call the endpoint sent, but with no usable stack frame to
 *   anchor it to a line. Must still be COUNTED as a dropped log (ticket 02, item 4) — never
 *   silently disappear the way it used to.
 * - `'script'` — a `Debugger.scriptParsed` event: metadata about a script the runtime compiled,
 *   for ticket 06's content verification. Not a log, so counted nowhere.
 * - `'reply'` — a JSON-RPC reply to a request this client sent (`Debugger.getScriptSource`), with
 *   its `id` so the caller can match it to the pending request.
 * - `'ignored'` — not a console call event at all (unparsable JSON, some other CDP event this
 *   feature doesn't use). Not a "log" in any sense, so not counted anywhere.
 *
 * Never throws: the endpoint is a network peer, not a trusted collaborator.
 */
export type RuntimeLogMessageOutcome =
  | { kind: 'log'; log: ParsedConsoleLog }
  | { kind: 'unanchored' }
  | { kind: 'script'; script: ScriptMetadata }
  | { kind: 'reply'; id: number; result: unknown }
  | { kind: 'ignored' };

export function parseRuntimeLogMessage(raw: string): RuntimeLogMessageOutcome {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: 'ignored' };
  }
  if (typeof msg !== 'object' || msg === null) return { kind: 'ignored' };
  const { id, method, params, result } = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown };
  if (method === 'Runtime.consoleAPICalled') {
    const log = parseConsoleApiCalled(params);
    return log ? { kind: 'log', log } : { kind: 'unanchored' };
  }
  if (method === 'Debugger.scriptParsed' && isScriptParsedParams(params)) {
    const { scriptId, url, endLine, endColumn, length } = params;
    return { kind: 'script', script: { scriptId, url, endLine, endColumn, length } };
  }
  if (method === undefined && typeof id === 'number') return { kind: 'reply', id, result };
  return { kind: 'ignored' };
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

/** Who a Runtime Target is, as far as naming the source of a log goes. */
export interface RuntimeSourceInfo {
  containerName: string | null;
  /** CDP target type: `node`, or `page` for a browser tab. */
  targetType: string;
  title: string;
  /** `host:port` the debug endpoint was reached at. */
  endpoint: string;
}

/**
 * The short name an inline log's hover gives its source — which of several live connections
 * produced the value. The container name when there is one (two containers running the same
 * code is exactly when this matters), else the kind of target and where it was reached.
 */
export function runtimeSourceLabel({ containerName, targetType, title, endpoint }: RuntimeSourceInfo): string {
  if (containerName) return containerName;
  if (targetType === 'page') return `browser: ${title || endpoint}`;
  return `node ${endpoint}`;
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

/**
 * The Linux path a Windows UNC path into a WSL distro names — `\\wsl.localhost\AlmaLinux-9\home\me`
 * (or the older `\\wsl$\…`, or either with forward slashes) is `/home/me` inside that distro. `null`
 * for anything else. Under Remote-WSL the language server runs INSIDE the distro, where the UNC form
 * is not a readable path at all — yet it is exactly what Windows Explorer shows, so it is what a user
 * copying a path from Windows pastes into `ejsng.runtimeLog.pathMappings`.
 */
export function wslUncToLinuxPath(path: string): string | null {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/][^\\/]+([\\/].*)?$/i.exec(path);
  if (!m) return null;
  const rest = (m[1] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return rest || '/';
}

/**
 * `ejsng.runtimeLog.pathMappings` ready to apply: `${workspaceFolder}` expanded, a WSL UNC `local`
 * turned into its Linux path when the server runs on Linux (on Windows the UNC path is the right
 * one), and ordered most specific `remote` first. `mapContainerPath` is first-match-wins, so with
 * nested mounts a broad mapping declared first (`/srv` before `/srv/lib`) would otherwise swallow
 * every path of the specific one — sending each log to the copy the mount shadows. The sort is
 * stable, so mappings of equal length keep the user's order.
 */
export function prepareDeclaredMappings(mappings: PathMapping[], workspaceFolder: string, serverPlatform: string): PathMapping[] {
  return resolvePathMappings(mappings, workspaceFolder)
    .map(({ remote, local }) => ({ remote, local: (serverPlatform !== 'win32' && wslUncToLinuxPath(local)) || local }))
    .sort((a, b) => b.remote.length - a.remote.length);
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
  // Node's public built-in modules (`node:events`, `node:timers`, …) — the runtime's own code, and
  // never a file on this machine to read.
  'node:*',
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
   * a path on this machine to look for. The last three are ticket 06's: the path resolved fine,
   * but the file there is not what the runtime is actually running.
   */
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
  /** Only set when `skipReason` is `'skip-pattern'`. */
  matchedPattern?: string;
  /** Only set when `skipReason` is `'shadowed-file'` — the file the runtime IS running, proven by content. */
  runtimePath?: string;
  /** Only set when `skipReason` is `'ambiguous-url-match'` (ticket 07) — the files that tied for the longest matching tail. */
  candidates?: string[];
  /**
   * The path on this machine the frame was looked for at — set for `'unreadable-file'` and
   * `'outside-workspace'`, where it is the whole diagnosis: a wrong Path Mapping shows up here as a
   * path that plainly doesn't exist.
   */
  hostPath?: string;
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
  /** How many logs in a row told this exact story — see `recordFrameDiagnostic`. Absent means 1. */
  count?: number;
}

/** What makes two logs' frame-selection stories the same: every frame, where it is, and what happened to it. */
function diagnosticSignature(d: RuntimeLogFrameDiagnostic): string {
  const frames = d.frames.map((f) => `${f.url}:${f.lineNumber}:${f.columnNumber}:${f.skipReason}`).join('\n');
  return `${d.chosenPath}\n${frames}`;
}

/**
 * Add one log's story to a bounded buffer of recent ones, most recent last. A story identical to
 * one already kept replaces it — moved to the end, `count` carried up — instead of taking a new
 * slot: a framework that logs on every websocket message would otherwise fill the whole buffer
 * with one stack and push out the one log the user is actually looking for.
 */
export function recordFrameDiagnostic(buffer: RuntimeLogFrameDiagnostic[], entry: RuntimeLogFrameDiagnostic, max: number): void {
  const signature = diagnosticSignature(entry);
  const i = buffer.findIndex((d) => diagnosticSignature(d) === signature);
  let count = 1;
  if (i !== -1) {
    count = (buffer[i]!.count ?? 1) + 1;
    buffer.splice(i, 1);
  }
  buffer.push(count > 1 ? { ...entry, count } : entry);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
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

// ============================================================================================
// Ticket 06 — content verification (.scratch/runtime-remote-env/issues/06-kiem-tra-noi-dung.md).
// A path match does not mean a content match: the runtime may be running a file the user edited
// since (Stale File), a different copy shadowed by another mount (Shadowed File), or whatever a
// wrong hand-written mapping points at. All three draw the log on the WRONG LINE while looking
// right, which is worse than not drawing at all — so drawing becomes conditional on the content
// lining up. See the experiment section of that ticket for why these three fields are enough.
// ============================================================================================

/**
 * What `Debugger.scriptParsed` reports about one script V8 has compiled. Metadata only, never the
 * source: a target with thousands of modules sends one of these per script (measured: ~10k events
 * / 5.9 MB at 10k modules, see the ticket), and holding their sources would make this server's
 * memory scale with the size of the user's code for no benefit.
 */
export interface ScriptMetadata {
  scriptId: string;
  url: string;
  /** 0-based index of the script's last line. */
  endLine: number;
  /** Character offset of the script's end WITHIN that last line. */
  endColumn: number;
  /** Total length of the script source, in the same units `String.prototype.length` counts. */
  length: number;
}

function isScriptParsedParams(v: unknown): v is ScriptMetadata {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as { scriptId?: unknown; url?: unknown; endLine?: unknown; endColumn?: unknown; length?: unknown };
  return (
    typeof s.scriptId === 'string' &&
    typeof s.url === 'string' &&
    typeof s.endLine === 'number' &&
    typeof s.endColumn === 'number' &&
    typeof s.length === 'number'
  );
}

/**
 * Does `source` — a file read from disk — match the script the runtime actually compiled?
 *
 * Measured against a real `node --inspect` (see the ticket): V8 reports all three fields exactly
 * as the file on disk has them, with NO CommonJS wrapper folded in, and that holds for CRLF, a
 * BOM, a shebang, a missing trailing newline, and ESM alike. So this needs no round-trip at all —
 * the metadata arrived with the event, and the file is one the caller has already read.
 *
 * Length alone would be too weak (two files of equal size), and end position alone too weak again
 * (same shape, different text); together they are strong enough to catch every realistic edit.
 * The residual case — an edit that changes bytes but neither length nor line structure, e.g.
 * renaming a variable to another name of the same length — is caught by the caller's exact
 * `Debugger.getScriptSource` confirmation, which this cheap check gates.
 */
export function sourceMatchesScript(source: string, script: ScriptMetadata): boolean {
  if (source.length !== script.length) return false;
  const lines = source.split('\n');
  return lines.length - 1 === script.endLine && (lines[lines.length - 1]?.length ?? 0) === script.endColumn;
}

/**
 * Every host path a container path could resolve to — one per mapping that covers it, in mapping
 * order, de-duplicated. `mapContainerPath` returns only the FIRST, which is the one to draw on;
 * this returns the rest as well, which is what makes a Shadowed File provable rather than
 * guessed: with nested mounts the same container path is covered by several mounts, and the copy
 * whose content matches what the runtime compiled is, by construction, the one actually running.
 */
export function candidateHostPaths(fsPath: string, mappings: PathMapping[]): string[] {
  const seen = new Set<string>();
  for (const { remote, local } of mappings) {
    if (fsPath === remote) seen.add(local);
    else if (fsPath.startsWith(`${remote}/`)) seen.add(local + fsPath.slice(remote.length));
  }
  return [...seen];
}

// ============================================================================================
// Ticket 08 — logs from files outside the workspace
// (.scratch/runtime-remote-env/issues/08-log-ngoai-workspace.md). With nested mounts the file the
// runtime is really running can live in a repo the user hasn't opened; those logs used to vanish
// silently. They are drawn now, but only within a safety boundary: a Runtime Path arrives from a
// network peer and must never be able to steer a read anywhere it likes.
// ============================================================================================

/**
 * Is `hostPath` inside the host side of one of `mappings`? This is the whole read boundary
 * (checklist item 1): the user either declared that directory in `ejsng.runtimeLog.pathMappings`
 * or mounted it into the container they are connected to, so it is a place they have already
 * pointed this extension at. Anything else is refused and counted, no matter what path the
 * runtime reports.
 *
 * Whole-segment matching, exactly like `mapContainerPath`: `/host/projects-old/x.js` is NOT under
 * a `/host/projects` mapping.
 */
export function isUnderMappingLocal(hostPath: string, mappings: PathMapping[]): boolean {
  return mappings.some(({ local }) => hostPath === local || hostPath.startsWith(`${local}/`));
}

// ============================================================================================
// Ticket 07 — suffix-matching a browser URL to a workspace file
// (.scratch/runtime-remote-env/issues/07-khop-duoi-url-trinh-duyet.md). A log from Chrome carries
// a URL (`http://localhost:5000/javascripts/index.js`), not a filesystem path, and no mount can
// say which file it is. Matching the tail of the URL against indexed files is the last resort,
// AFTER every Path Mapping has had its say — and it is confined to URLs on purpose: for a Node
// file path with nested mounts, this kind of match is wrong in a way that looks convincing.
// ============================================================================================

/** Is `runtimePath` an `http(s)://` URL — the only shape suffix matching is ever allowed on? */
export function isHttpUrl(runtimePath: string): boolean {
  return /^https?:\/\//i.test(runtimePath);
}

/**
 * Drop a URL's query string and fragment, so `…/app.js?v=3` maps like `…/app.js`. Applied only to
 * http(s) URLs: `?` and `#` are legal characters in a filesystem path, and stripping them there
 * would corrupt a perfectly good Node path.
 */
export function normalizeRuntimePath(runtimePath: string): string {
  if (!isHttpUrl(runtimePath)) return runtimePath;
  return runtimePath.replace(/[?#].*$/, '');
}

/** The result of matching a URL's tail against the indexed files — see `matchUrlPathSuffix`. */
export interface UrlSuffixMatch {
  /** `'unique'` carries exactly one candidate; `'ambiguous'` carries every file that tied. */
  kind: 'unique' | 'ambiguous' | 'none';
  candidates: string[];
  /** How many trailing path segments matched. 0 when nothing matched at all. */
  segments: number;
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function trailingSegmentsInCommon(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/**
 * Find the indexed file whose path shares the LONGEST trailing run of segments with `urlPath`
 * (checklist item 2). Longest rather than merely "same filename", because a project with several
 * `index.js` files only becomes decidable once more of the path agrees.
 *
 * A tie is reported as `'ambiguous'` rather than resolved by any tiebreak: the whole point of this
 * ticket is to avoid a confident wrong answer, so several equally good candidates means the log is
 * not drawn and the panel says which files it was torn between (checklist item 3).
 */
export function matchUrlPathSuffix(urlPath: string, indexedRelPaths: string[]): UrlSuffixMatch {
  const urlSegments = segmentsOf(urlPath);
  let best = 0;
  let candidates: string[] = [];
  for (const relPath of indexedRelPaths) {
    const shared = trailingSegmentsInCommon(urlSegments, segmentsOf(relPath));
    if (shared === 0 || shared < best) continue;
    if (shared > best) {
      best = shared;
      candidates = [relPath];
    } else {
      candidates.push(relPath);
    }
  }
  if (best === 0) return { kind: 'none', candidates: [], segments: 0 };
  return { kind: candidates.length === 1 ? 'unique' : 'ambiguous', candidates, segments: best };
}

/**
 * Turn one resolved URL -> file match into a DIRECTORY-level Path Mapping, by stripping the
 * matched tail from both sides: `http://localhost:5000/javascripts/index.js` matched against
 * `public/javascripts/index.js` (2 segments) yields
 * `{remote: 'http://localhost:5000', local: '<root>/public'}`.
 *
 * Producing a mapping rather than a single file's location is what makes one index scan serve
 * every other script from the same directory — `mapContainerPath` handles them with no further
 * matching — and it is also the thing the panel can offer to save (checklist item 4).
 *
 * Returns `null` if the match doesn't actually line up (more matched segments than either side
 * has), which the callers can't produce but which keeps this total rather than throwing.
 */
export function urlSuffixMapping(url: string, relPath: string, segments: number, workspaceRoot: string): PathMapping | null {
  const withoutQuery = normalizeRuntimePath(url);
  const schemeEnd = withoutQuery.indexOf('://');
  if (schemeEnd === -1) return null;
  const pathStart = withoutQuery.indexOf('/', schemeEnd + 3);
  const origin = pathStart === -1 ? withoutQuery : withoutQuery.slice(0, pathStart);
  const urlSegments = pathStart === -1 ? [] : segmentsOf(withoutQuery.slice(pathStart));
  const relSegments = segmentsOf(relPath);
  if (segments > urlSegments.length || segments > relSegments.length) return null;

  const remoteRest = urlSegments.slice(0, urlSegments.length - segments);
  const localRest = relSegments.slice(0, relSegments.length - segments);
  return {
    remote: remoteRest.length > 0 ? `${origin}/${remoteRest.join('/')}` : origin,
    local: localRest.length > 0 ? `${workspaceRoot}/${localRest.join('/')}` : workspaceRoot,
  };
}

// ============================================================================================
// Ticket 10 (.scratch/runtime-remote-env/issues/10-launch-trinh-duyet-phia-ui.md): after Launch
// opens the app in a browser, connect to the app's own tab on its own — not to whichever tab
// happens to be listed first (a login redirect, a new-tab page, another app).
// ============================================================================================

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // `localhost` and `127.0.0.1` are the same app as far as the user is concerned.
    const host = u.hostname === '127.0.0.1' || u.hostname === '[::1]' ? 'localhost' : u.hostname;
    return `${u.protocol}//${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

/**
 * The page target showing the app at `appUrl` — same origin (scheme, host, port), any path.
 * `null` while no such tab exists yet, e.g. the tab is still on a Keycloak login page of a
 * different origin: the caller keeps waiting rather than attaching to the login page. The first
 * listed match wins — Chrome lists the most recently active tab first.
 */
export function findAppTarget(targets: DiscoveredTarget[], appUrl: string): DiscoveredTarget | null {
  const want = originOf(appUrl);
  if (!want) return null;
  const matches = targets.filter((t) => t.type === 'page' && originOf(t.url) === want);
  return matches[0] ?? null;
}
