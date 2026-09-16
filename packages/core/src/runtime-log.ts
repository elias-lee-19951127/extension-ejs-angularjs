/**
 * Pure functions behind the runtime-log feature — parsing CDP events, formatting console
 * arguments, matching/rewriting paths and URLs. No IO: opening sockets, making HTTP requests,
 * and shelling out to `docker` all stay in packages/server as adapters (ticket 02's prefactor,
 * .scratch/runtime-remote-env/issues/02-probe-an-toan-va-trang-thai-that.md) — this gives later
 * tickets (03-11) a place to put their own pure logic (mount matching, frame filtering, content
 * comparison, report building, ANSI stripping, …) alongside it.
 */

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
interface CallFrame {
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

/** A parsed console call, ready to be turned into a `$/ejsng/runtimeLog` notification. */
export interface ParsedConsoleLog {
  url: string;
  line: number;
  character: number;
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
 * Parse a `Runtime.consoleAPICalled` event into `{url, line, character, value, severity}`.
 * Returns `null` both when it carries no stack trace — the feature only tracks logs it can
 * anchor to a line (spec: v1 shows the latest value PER LINE, see
 * .scratch/inline-runtime-log/spec.md) — and when `event` isn't a well-formed event at all (an
 * untrusted CDP peer sent something unexpected).
 */
export function parseConsoleApiCalled(event: unknown): ParsedConsoleLog | null {
  if (!isConsoleApiCalledEvent(event)) return null;
  const frame = event.stackTrace?.callFrames[0];
  if (!frame) return null;
  return {
    url: frame.url,
    line: frame.lineNumber,
    character: frame.columnNumber,
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
 * Rewrite a container-internal path (what a Dockerized target's CDP events report, e.g.
 * `/app/index.js`) to the matching path on the host, via user-configured mappings — checked in
 * order, first match wins. A path with no configured mapping passes through unchanged (the
 * existing, non-Docker behavior). `remote` only matches whole path segments: `/app2/x.js` does
 * NOT match a `/app` mapping.
 */
export function mapContainerPath(fsPath: string, mappings: PathMapping[]): string {
  for (const { remote, local } of mappings) {
    if (fsPath === remote) return local;
    if (fsPath.startsWith(`${remote}/`)) return local + fsPath.slice(remote.length);
  }
  return fsPath;
}
