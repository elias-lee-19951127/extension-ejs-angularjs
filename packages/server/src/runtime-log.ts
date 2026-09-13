import { TextDocument } from 'vscode-languageserver-textdocument';
import WebSocket, { type RawData } from 'ws';

/**
 * Convert a 0-based {line, character} location — the shape both the V8 Inspector Protocol's
 * `Runtime.CallFrame` and LSP `Position` use — into a character offset within `source`.
 */
export function offsetForLocation(source: string, line: number, character: number): number {
  const doc = TextDocument.create('runtime-log://dummy', 'plaintext', 0, source);
  return doc.offsetAt({ line, character });
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
 * Parse one raw WebSocket frame from the CDP endpoint. Never throws: a non-JSON frame, a
 * message with no `method`, or a `consoleAPICalled` with a malformed `params` are all just
 * "nothing usable here" — the endpoint is a network peer, not a trusted collaborator.
 */
export function parseRuntimeLogMessage(raw: string): ParsedConsoleLog | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const { method, params } = msg as { method?: unknown; params?: unknown };
  if (method !== 'Runtime.consoleAPICalled') return null;
  return parseConsoleApiCalled(params);
}

/**
 * Open a CDP/Inspector Protocol client to `url` (per spec, a target the user started themselves
 * with `node --inspect`) and report every console call it can anchor to a line via `onLog`.
 *
 * `onError` fires for a connection failure or drop (bad/unreachable `url`, network reset). A
 * `ws` socket THROWS on the process if an `error` event has no listener, so this parameter isn't
 * optional polish — without it, one unreachable debug target would crash the whole LSP server.
 */
export function connectRuntimeLog(
  url: string,
  onLog: (log: ParsedConsoleLog) => void,
  onError: (err: Error) => void = () => {},
): WebSocket {
  const socket = new WebSocket(url);
  socket.on('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
  });
  socket.on('error', onError);
  socket.on('message', (raw: RawData) => {
    const log = parseRuntimeLogMessage(raw.toString());
    if (log) onLog(log);
  });
  return socket;
}
