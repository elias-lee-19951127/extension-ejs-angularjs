/**
 * Pure half of inline logpoints (.scratch/inline-logpoints/spec.md): turn a VS Code logpoint's
 * `logMessage` into a `Debugger.setBreakpointByUrl` condition that logs and never pauses, recognise
 * the console call that condition produces, and work out which runtime URLs a local file may be
 * loaded under. No IO — the server owns the CDP socket.
 */
import type { PathMapping } from './runtime-log';

/** One piece of a logpoint message: literal text, or a `{expression}` to evaluate at the breakpoint. */
export type LogMessagePart = { kind: 'text'; text: string } | { kind: 'expr'; expr: string };

/**
 * Split a VS Code logpoint message (`user = {user.name}, n = {items.length}`) into text and
 * expression parts — the syntax VS Code and js-debug use. Braces inside an expression nest
 * (`{ {a: 1}.a }` is one expression), and braces inside a string literal don't count. An opening
 * brace that is never closed leaves the rest of the message as plain text rather than failing.
 */
export function parseLogMessage(message: string): LogMessagePart[] {
  const parts: LogMessagePart[] = [];
  let text = '';
  let i = 0;
  while (i < message.length) {
    const ch = message[i]!;
    if (ch !== '{') {
      text += ch;
      i++;
      continue;
    }
    const end = closingBrace(message, i);
    if (end === -1) {
      text += message.slice(i);
      break;
    }
    const expr = message.slice(i + 1, end).trim();
    if (expr) {
      if (text) parts.push({ kind: 'text', text });
      text = '';
      parts.push({ kind: 'expr', expr });
    }
    i = end + 1;
  }
  if (text) parts.push({ kind: 'text', text });
  return parts;
}

/** Index of the `}` matching the `{` at `open`, skipping string literals; -1 if there is none. */
function closingBrace(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Prefix of the `//# sourceURL=` every logpoint condition carries — how its console call is recognised. */
const LOGPOINT_URL_PREFIX = 'ejsng-logpoint-';

/**
 * The console the condition logs through. Node's `inspector.console` sends ONLY to attached
 * inspector clients, so a logpoint doesn't also print to the app's own stdout (measured on Node
 * 20.20: plain `console.log` there does). A browser, or Node older than 20.16 without
 * `process.getBuiltinModule`, falls back to the ordinary console.
 */
const LOGPOINT_CONSOLE = 'globalThis.process?.getBuiltinModule?.("node:inspector")?.console ?? console';

/**
 * Evaluate `expr` so that a throw becomes the text `<message>` instead of an exception that would
 * lose the whole log line. Newlines around the user's code keep a trailing `// comment` in it from
 * swallowing the rest of the generated source.
 */
function guarded(expr: string): string {
  return `(() => { try { return (\n${expr}\n); } catch (e) { return "<" + (e && e.message !== undefined ? e.message : String(e)) + ">"; } })()`;
}

export interface LogpointSpec {
  /** Unique among the logpoints currently set — ends up in the `sourceURL`. */
  id: number;
  logMessage: string;
  /** VS Code's optional breakpoint condition: log only when it is truthy. */
  condition?: string;
}

/**
 * The `condition` for `Debugger.setBreakpointByUrl` that makes a breakpoint behave as a logpoint:
 * it logs the message and evaluates to `false`, so V8 never pauses. (A condition that throws is
 * also treated as false by V8 — measured — so a broken user `condition` can't pause either.)
 */
export function buildLogpointCondition({ id, logMessage, condition }: LogpointSpec): string {
  const args = parseLogMessage(logMessage).map((p) => (p.kind === 'text' ? JSON.stringify(p.text) : guarded(p.expr)));
  const log = `((${LOGPOINT_CONSOLE}).log(${args.join(', ')}), false)`;
  const body = condition?.trim() ? `(\n${condition}\n) ? ${log} : false` : log;
  return `${body}\n//# sourceURL=${LOGPOINT_URL_PREFIX}${id}`;
}

/** The logpoint id a stack frame's `url` names, or `null` if the frame isn't a logpoint condition. */
export function logpointIdFromUrl(url: string): number | null {
  if (!url.startsWith(LOGPOINT_URL_PREFIX)) return null;
  const rest = url.slice(LOGPOINT_URL_PREFIX.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/**
 * Every Runtime Path a local file may be loaded under: the path itself (a local `node --inspect`
 * needs no mapping), plus the reverse of each Path Mapping whose host side covers it — the
 * container path for a Docker target, the URL for a browser directory learned by suffix matching.
 * De-duplicated, in mapping order.
 */
export function runtimePathCandidates(localPath: string, mappings: PathMapping[]): string[] {
  const seen = new Set<string>([localPath]);
  for (const { remote, local } of mappings) {
    if (localPath === local) seen.add(remote);
    else if (localPath.startsWith(`${local}/`)) seen.add(remote + localPath.slice(local.length));
  }
  return [...seen];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * The `urlRegex` matching `runtimePath` the ways a runtime reports it: Node reports a CommonJS or
 * ESM module as a `file://` URL (percent-encoded) and older Node as a bare path; a browser URL may
 * carry a cache-busting query string (`app.js?v=3`).
 */
export function logpointUrlRegex(runtimePath: string): string {
  if (/^https?:\/\//i.test(runtimePath)) return `^${escapeRegExp(runtimePath)}(?:[?#].*)?$`;
  const fileUrl = `file://${encodeURI(runtimePath).replace(/[?#]/g, encodeURIComponent)}`;
  return `^(?:${escapeRegExp(runtimePath)}|${escapeRegExp(fileUrl)})$`;
}
