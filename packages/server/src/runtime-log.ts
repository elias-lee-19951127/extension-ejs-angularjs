/**
 * IO adapters for the runtime-log feature: opening the CDP WebSocket, probing the HTTP discovery
 * endpoint, finding a local PID by port. Parsing/formatting/matching are pure functions that live
 * in packages/core (ticket 02's prefactor) — this module wires them up to real sockets/processes.
 */
import { execFile } from 'node:child_process';
import { get as httpGet } from 'node:http';
import {
  filterConnectableTargets,
  parseRuntimeLogMessage,
  rewriteWebSocketUrl,
  type DiscoveredTarget,
  type ParsedConsoleLog,
  type ScriptMetadata,
} from '@ejsng/core';
import WebSocket, { type RawData } from 'ws';

export type { DiscoveredTarget, DockerMount, ParsedConsoleLog, PathMapping, ScriptMetadata } from '@ejsng/core';

/**
 * Chrome and the Node inspector both refuse any `Host` request header that isn't an IP or
 * `localhost` — an anti DNS-rebinding check (ticket 02, item 2). Every probe (HTTP discovery
 * AND the CDP WebSocket handshake) must send exactly this, regardless of what hostname was
 * actually dialed to reach the endpoint (a WSL hostname, a container name, a LAN IP, …).
 */
const REQUIRED_HOST_HEADER = 'localhost';

/**
 * Callbacks for one CDP connection's lifecycle (ticket 02, item 4 — the caller must be able to
 * tell "attempting" from "actually working" and count every drop by reason):
 * - `onOpen`: the WebSocket handshake actually completed — the only real "connected" moment.
 * - `onLog`: a console call anchored to a line, ready to draw.
 * - `onUnanchored`: a console call arrived with no usable stack frame — dropped, but must be
 *   counted (`parseRuntimeLogMessage`'s `'unanchored'` outcome).
 * - `onScript`: `Debugger.scriptParsed` metadata for one script the runtime compiled (ticket 06).
 * - `onError`: the socket failed to open, or an already-open one errored.
 * - `onClose`: the socket closed for any reason (including after `onError`, which `ws` always
 *   follows with a close) — lets the caller flip a previously-`connected` state to `failed`.
 */
export interface RuntimeLogCallbacks {
  onOpen?: () => void;
  onLog: (log: ParsedConsoleLog) => void;
  onUnanchored?: () => void;
  onScript?: (script: ScriptMetadata) => void;
  onError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
}

/** One open CDP connection: the socket to close, plus the requests this feature makes of it. */
export interface RuntimeLogConnection {
  socket: WebSocket;
  /**
   * Send one CDP command and resolve its `result` — or `null` if the socket is not open, the
   * runtime answers with an error, or no reply arrives within `timeoutMs`. Like
   * `getScriptSource`, a request to a network peer must degrade, never hang or throw.
   */
  request(method: string, params?: object, timeoutMs?: number): Promise<unknown>;
  /**
   * `Debugger.getScriptSource` — the exact source the runtime compiled, for confirming a file on
   * disk really is what is running. Resolves `null` if the socket is not open, the runtime
   * answers with an error, or the reply doesn't arrive within `timeoutMs`: an unanswerable
   * verification must degrade to "unverified", never hang a log forever.
   */
  getScriptSource(scriptId: string, timeoutMs?: number): Promise<string | null>;
}

/** Ids 1 and 2 are the two `enable` calls sent on open; client requests are numbered from here. */
const FIRST_REQUEST_ID = 3;

/**
 * Open a CDP/Inspector Protocol client to `url` (per spec, a target the user started themselves
 * with `node --inspect`) and report every console call it can anchor to a line via `onLog`.
 *
 * Both `Runtime` and `Debugger` are enabled. `Debugger` is enabled to receive `scriptParsed`
 * events (ticket 06, item 2) and to set logpoints (.scratch/inline-logpoints/spec.md). The runtime
 * is still never paused: the only breakpoints ever set are logpoints, whose condition always
 * evaluates to `false` (`buildLogpointCondition`), so the target keeps running exactly as it would
 * without a debugger attached. Measured cost of the `scriptParsed` backlog: 246 ms at 10,000
 * modules, once per connect (see ticket 06).
 *
 * `onOpen` fires only after both `enable` calls are written, so a caller may send `Debugger.*`
 * commands from it: messages on one socket arrive in order.
 *
 * `onError` fires for a connection failure or drop (bad/unreachable `url`, network reset). A
 * `ws` socket THROWS on the process if an `error` event has no listener, so registering it isn't
 * optional polish — without it, one unreachable debug target would crash the whole LSP server.
 */
export function connectRuntimeLog(url: string, callbacks: RuntimeLogCallbacks): RuntimeLogConnection {
  const { onOpen, onLog, onUnanchored, onScript, onError, onClose } = callbacks;
  const socket = new WebSocket(url, { headers: { Host: REQUIRED_HOST_HEADER } });
  const pending = new Map<number, (result: unknown) => void>();
  let nextRequestId = FIRST_REQUEST_ID;

  socket.on('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    socket.send(JSON.stringify({ id: 2, method: 'Debugger.enable' }));
    onOpen?.();
  });
  socket.on('error', (err) => onError?.(err));
  socket.on('close', (code: number, reason: Buffer) => {
    // Resolve everything still waiting, so a caller awaiting verification on a connection that
    // just dropped continues (as "unverified") instead of holding its promise forever.
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    onClose?.(code, reason.toString());
  });
  socket.on('message', (raw: RawData) => {
    const outcome = parseRuntimeLogMessage(raw.toString());
    if (outcome.kind === 'log') onLog(outcome.log);
    else if (outcome.kind === 'unanchored') onUnanchored?.();
    else if (outcome.kind === 'script') onScript?.(outcome.script);
    else if (outcome.kind === 'reply') {
      pending.get(outcome.id)?.(outcome.result);
      pending.delete(outcome.id);
    }
  });

  const request = (method: string, params?: object, timeoutMs = 2000): Promise<unknown> => {
    if (socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = nextRequestId++;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result ?? null);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  return {
    socket,
    request,
    async getScriptSource(scriptId, timeoutMs = 2000) {
      const result = await request('Debugger.getScriptSource', { scriptId }, timeoutMs);
      const source = (result as { scriptSource?: unknown } | null)?.scriptSource;
      return typeof source === 'string' ? source : null;
    },
  };
}

/**
 * `GET http://host:port/json/list` — the discovery endpoint both `node --inspect` and Chrome
 * `--remote-debugging-port` expose, listing every attachable target. Rejects (never throws
 * uncaught) on a connection failure or a non-JSON-array response — the host:port is user input
 * pointing at an external process, not a trusted collaborator.
 *
 * Every returned target's `webSocketDebuggerUrl` is rewritten to `host:port` — the address that
 * JUST successfully answered this request — discarding whatever host/port the runtime itself
 * advertised (ticket 02, item 2: that value can be wrong, e.g. `0.0.0.0`, or unreachable from
 * here, e.g. a container-internal interface).
 */
export function discoverTargets(host: string, port: number): Promise<DiscoveredTarget[]> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      { host, port, path: '/json/list', timeout: 3000, headers: { Host: REQUIRED_HOST_HEADER } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!Array.isArray(body)) throw new Error('expected a JSON array');
            const targets = filterConnectableTargets(body as DiscoveredTarget[]).map((t) => ({
              ...t,
              webSocketDebuggerUrl: rewriteWebSocketUrl(t.webSocketDebuggerUrl, host, port),
            }));
            resolve(targets);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out reaching ${host}:${port}`)));
    req.on('error', reject);
  });
}

/**
 * Find the PID of the process listening on `port` on this machine, via `lsof` — POSIX only
 * (`null` on Windows, where there's no `lsof` and no `SIGUSR1` to act on it anyway). Ticket 10:
 * lets a user type their app's ordinary port instead of first learning what an inspector port is.
 */
export function findPidListeningOnPort(port: number): Promise<number | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    // `-sTCP:LISTEN`: only sockets actually LISTENing — plain `-ti :<port>` can also surface an
    // unrelated process with a stale/closing connection that merely mentions the same port
    // number (observed in practice: a already-exited process's TIME_WAIT-ish entry).
    execFile('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const pid = Number(stdout.trim().split('\n')[0]);
      resolve(Number.isFinite(pid) ? pid : null);
    });
  });
}

/**
 * Retry `discoverTargets` until it succeeds or `timeoutMs` elapses — for the moment right after
 * `SIGUSR1` asks a process to enable its inspector, which isn't instant.
 */
export async function waitForTargets(
  host: string,
  port: number,
  timeoutMs = 3000,
  intervalMs = 150,
): Promise<DiscoveredTarget[]> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await discoverTargets(host, port);
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`timed out reaching ${host}:${port}`);
}
