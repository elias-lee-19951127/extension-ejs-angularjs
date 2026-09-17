#!/usr/bin/env node
import {
  createConnection,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type CompletionItem,
  CompletionItemKind,
  type Diagnostic,
  type FileSystemWatcher,
  type InitializeResult,
  type Location,
  LSPErrorCodes,
  type Range,
  ResponseError,
  type TextEdit,
  WatchKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
  isWithinRoot,
  mapContainerPath,
  offsetForLocation,
  Workspace,
  type Config,
  type Span,
  formatDockerCandidateLabel,
  partitionDockerCandidates,
  filterDockerCandidatesByAppPort,
  mappingsFromMounts,
  resolvePathMappings,
  classifyFrameCandidates,
  isLikelyMinified,
  stripAnsi,
  suggestWrapperFile,
  type CallFrame,
  type FrameDiagnosticEntry,
  type RuntimeLogFrameDiagnostic,
} from '@ejsng/core';
import {
  connectRuntimeLog,
  discoverTargets,
  findPidListeningOnPort,
  waitForTargets,
  type DiscoveredTarget,
  type DockerMount,
  type PathMapping,
} from './runtime-log';
import { listDockerRuntimeCandidates } from './docker';
import type WebSocket from 'ws';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspace: Workspace | null = null;
let diagnosticsEnabled = false;

/**
 * Real connection lifecycle (ticket 02, item 4): the panel used to report `connected` the
 * instant the socket was CREATED, not when it actually opened. `connecting` is the state from
 * creation until the WebSocket really opens; `connected` only after that; `failed` on any error
 * or an unexpected close, always with a human-readable `reason`.
 */
type RuntimeLogConnectionState = 'connecting' | 'connected' | 'failed';

/** Ticket 03 (.scratch/runtime-remote-env/issues/03-chon-frame.md) — bounded ring buffers so recent-log diagnostics and wrapper-file detection don't grow forever. */
const MAX_RECENT_FRAME_DIAGNOSTICS = 5;
const MAX_RECENT_CHOSEN_PATHS = 50;

/** Per-connection counters, exposed over LSP so a client can show "received / drawn / dropped" instead of just a count (ticket 02, item 4). */
interface RuntimeLogConnectionInfo {
  socket: WebSocket;
  state: RuntimeLogConnectionState;
  reason?: string;
  /** Every console call the CDP endpoint sent that could be classified as a console call at all. */
  received: number;
  /** Successfully turned into an `ejsng/runtimeLog` notification. */
  drawn: number;
  /** `received - drawn`, broken down by WHY each one was dropped — never silently vanish. */
  droppedByReason: Record<string, number>;
  /** Ticket 03, item 6 — the last few logs' frame-selection story (chosen + every skipped frame, with reasons), most recent last. */
  recentFrameDiagnostics: RuntimeLogFrameDiagnostic[];
  /** Ticket 03, item 7 — every recently CHOSEN frame's workspace-relative path, for wrapper-file detection (see `suggestWrapperFile`). */
  recentChosenPaths: string[];
  /**
   * Ticket 05 — path mappings inferred from the MOUNTS of the container this particular connection
   * talks to, longest container-side path first. Per-connection, not global: two live connections
   * can be two different containers with completely different mounts. Empty for a target that
   * isn't a Docker container (a browser, a local `node --inspect`). Applied AFTER the user's own
   * `ejsng.runtimeLog.pathMappings`, which always wins (checklist item 2).
   */
  inferredPathMappings: PathMapping[];
}

/** Every live runtime-log connection, keyed by `host:port:targetId` — see ejsng/connectRuntime. */
const runtimeLogConnections = new Map<string, RuntimeLogConnectionInfo>();
/** `ejsng.runtimeLog.pathMappings` — container path -> host path, for Docker targets (ticket 11), with `${workspaceFolder}` already expanded (ticket 05). */
let runtimeLogPathMappings: PathMapping[] = [];
/**
 * Ticket 05 — the mounts of every Docker container `ejsng/discoverRuntimeTargets` found, keyed by
 * the `host:port` its inspector is published on. Rebuilt from scratch on every discovery (never
 * persisted, never written to settings, checklist item 4), and read at connect time so all three
 * connect paths pick up the same inferred mappings: the immediate single-container connect, and
 * the two follow-ups a client makes after a Quick Pick (`ejsng/connectRuntime` after
 * `'choose-container'`, `ejsng/connectRuntimeTarget` after `'choose'`), neither of which carries
 * any container identity of its own.
 */
const dockerMountsByEndpoint = new Map<string, DockerMount[]>();
/** `ejsng.runtimeLog.skipFrames` — user-added patterns, ON TOP OF `DEFAULT_SKIP_FRAME_PATTERNS` (ticket 03). */
let runtimeLogSkipFramePatterns: string[] = [];
/**
 * Does the client support dynamic watcher registration
 * (workspace.didChangeWatchedFiles.dynamicRegistration)?
 * `relative`: does the client understand RelativePattern. null = not registered (LSP 3.17).
 */
let fileWatch: { relative: boolean } | null = null;

connection.onInitialize((params): InitializeResult => {
  const folder = params.workspaceFolders?.[0]?.uri;
  const root = folder ? URI.parse(folder).fsPath : (params.rootPath ?? process.cwd());

  const settings = (params.initializationOptions ?? {}) as Partial<Config> & {
    diagnostics?: { enabled?: boolean };
    runtimeLog?: { pathMappings?: PathMapping[]; skipFrames?: string[] };
  };
  diagnosticsEnabled = settings.diagnostics?.enabled ?? false;
  // `${workspaceFolder}` is expanded once, here, where the root is known — a mapping's `local` can
  // then be committed to a repo's settings instead of hardcoding one machine's absolute path
  // (ticket 05, item 3). An absolute `local` contains no variable and comes back unchanged.
  runtimeLogPathMappings = resolvePathMappings(settings.runtimeLog?.pathMappings ?? [], root);
  runtimeLogSkipFramePatterns = settings.runtimeLog?.skipFrames ?? [];
  // LSP 3.17: RenameOptions is only sent when the client declares prepareSupport.
  const prepareSupport = params.capabilities.textDocument?.rename?.prepareSupport === true;
  const watched = params.capabilities.workspace?.didChangeWatchedFiles;
  fileWatch =
    watched?.dynamicRegistration === true ? { relative: watched.relativePatternSupport === true } : null;

  workspace = new Workspace({ root, ...settings });

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['.', '{', ' '], resolveProvider: false },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: prepareSupport ? { prepareProvider: true } : true,
    },
  };
});

connection.onInitialized(() => {
  void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  if (!workspace) return;
  // Register BEFORE indexing: a file changed while indexing is still reported and handled right after.
  if (fileWatch) {
    void connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: fileWatchers(workspace, fileWatch.relative),
    });
  }
  // Background indexing: the server can already answer in degraded mode while it runs.
  connection.console.log('EJS/NG: starting to index...');
  const r = workspace.index();
  connection.console.log(
    `EJS/NG: done — ${r.indexed} new file(s), ${r.skipped} unchanged, ${r.linkedRefs} additional ref(s) linked, ${r.ms}ms`,
  );
});

// ------------------------------------------------------------------ helpers

function rel(uri: string): string | null {
  if (!workspace) return null;
  return workspace.toRelative(URI.parse(uri).fsPath);
}

/**
 * Watchers registered with the client.
 *
 * LSP4IJ (IntelliJ) only sends workspace/didChangeWatchedFiles for paths matching a watcher the
 * server registered — without registration, no events at all. VSCode also sends extra events per
 * the client's `synchronize.fileEvents`; duplicate events are ignored by refreshFiles.
 *
 * - Change: follows `ws.changeWatchPatterns()` — only files that are actually indexed matter.
 *   The server does not read `config.include` itself and try to guess the semantics of its '!…'
 *   patterns; Workspace hands that back already resolved.
 * - Create/Delete: EVERY path. A directory created/removed/renamed (e.g. `git checkout` adding or
 *   removing a whole directory) is reported by the client as a single event for the directory
 *   itself, whose name does not match a file-extension glob.
 */
function fileWatchers(ws: Workspace, relativePatterns: boolean): FileSystemWatcher[] {
  const baseUri = URI.file(ws.config.root).toString();
  const glob = (pattern: string) => (relativePatterns ? { baseUri, pattern } : pattern);
  return [
    ...ws.changeWatchPatterns().map((p) => ({ globPattern: glob(p), kind: WatchKind.Change })),
    { globPattern: glob('**/*'), kind: WatchKind.Create | WatchKind.Delete },
  ];
}

function offsetOf(doc: TextDocument, position: { line: number; character: number }): number {
  return doc.offsetAt(position);
}

/** Convert a span (offset) to an LSP Range, based on the target file's content. */
function toRange(source: string, span: Span): Range {
  const posOf = (off: number) => {
    const before = source.slice(0, off);
    const line = before.split('\n').length - 1;
    const character = off - (before.lastIndexOf('\n') + 1);
    return { line, character };
  };
  return { start: posOf(span.start), end: posOf(span.end) };
}

function toLocation(relPath: string, span: Span): Location | null {
  if (!workspace) return null;
  const source = workspace.source(relPath);
  if (source === null) return null;
  return {
    uri: URI.file(`${workspace.config.root}/${relPath}`).toString(),
    range: toRange(source, span),
  };
}

/**
 * Paths in the hover are written as openable links: `[path:line](file://…#L<line>)`.
 *
 * Hover is the ONLY place that points to matches in a farther directory (`otherFiles`) after
 * go-to-definition has filtered them out, so it must be reachable by click. VSCode opens the
 * exact line; LSP4IJ converts markdown to HTML, so it still needs verifying in a real IDE.
 */
function fileLink(relPath: string, span?: Span): string {
  if (!workspace) return `\`${relPath}\``;
  const uri = URI.file(`${workspace.config.root}/${relPath}`).toString();
  const source = span ? workspace.source(relPath) : null;
  if (!span || source === null) return `[${relPath}](${uri})`;
  const line = toRange(source, span).start.line + 1;
  return `[${relPath}:${line}](${uri}#L${line})`;
}

// ------------------------------------------------------------- sync buffers

documents.onDidChangeContent((change) => {
  const r = rel(change.document.uri);
  if (!workspace || !r) return;
  workspace.setOverlay(r, change.document.getText());
  if (diagnosticsEnabled) void publishDiagnostics(change.document);
});

documents.onDidSave((e) => {
  const r = rel(e.document.uri);
  if (!workspace || !r) return;
  workspace.flushOverlay(r);
  // Editing one controller doesn't require reparsing any template — just relink (Layer 4).
  workspace.link();
});

documents.onDidClose((e) => {
  const r = rel(e.document.uri);
  if (workspace && r) workspace.clearOverlay(r);
  void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

/**
 * File changed outside the editor: git pull, checkout, another tool. Only the "on disk" layer of
 * the index is refreshed here — open buffers are left untouched (see Workspace.refreshFiles).
 */
connection.onDidChangeWatchedFiles(({ changes }) => {
  if (!workspace) return;
  const paths = changes.map((c) => rel(c.uri)).filter((p): p is string => p !== null);
  const r = workspace.refreshFiles(paths);
  if (r.indexed || r.removed) {
    connection.console.log(
      `EJS/NG: file(s) changed outside the editor — ${r.indexed} file(s) reread, ${r.removed} file(s) removed` +
        `${r.rescanned ? ' (new file(s) found: rescanning)' : ''}, ${r.ms}ms`,
    );
  }
});

// ---------------------------------------------------------------- features

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  const r = rel(params.textDocument.uri);
  if (!workspace || !doc || !r) return null;

  const result = workspace.definitionAt(r, offsetOf(doc, params.position));
  const locations = result.targets
    .map((t) => toLocation(t.path, t.span))
    .filter((l): l is Location => l !== null);
  return locations.length ? locations : null;
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  const r = rel(params.textDocument.uri);
  if (!workspace || !doc || !r) return null;

  const result = workspace.referencesAt(r, offsetOf(doc, params.position));
  return result.locations
    .map((l) => toLocation(l.path, l.span))
    .filter((l): l is Location => l !== null);
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  const r = rel(params.textDocument.uri);
  if (!workspace || !doc || !r) return null;

  const offset = offsetOf(doc, params.position);
  const def = workspace.definitionAt(r, offset);
  const lines: string[] = [];

  if (def.targets.length) {
    lines.push(`**${def.query}**`);
    for (const t of def.targets) {
      const conf = t.confidence === 'high' ? '' : ` _(confidence: ${t.confidence})_`;
      lines.push(`- ${t.detail} — ${fileLink(t.path, t.span)}${conf}`);
    }
    // Matches in a farther directory were already excluded from the jump result — they must
    // still be reachable here.
    if (def.otherFiles?.length) {
      const links = def.otherFiles.map((p) => fileLink(p)).join(', ');
      lines.push(`- _${def.otherFiles.length} more match(es) in a farther directory:_ ${links}`);
    }
  } else if (def.reason) {
    lines.push(`_${def.reason}_`);
  }

  const chain = workspace.scopeChainAt(r, offset);
  if (chain?.length) {
    const desc = chain
      .filter((f) => f.kind !== 'root')
      .map((f) => {
        const locals = f.locals.filter((l) => !l.name.startsWith('$')).map((l) => l.name);
        if (f.kind === 'controller') return `controller \`${f.controllerName}\``;
        return `${f.kind} {${locals.join(', ')}}`;
      });
    if (desc.length) lines.push('', `Scope chain: ${desc.join(' ← ')}`);
  }

  return lines.length ? { contents: { kind: 'markdown' as const, value: lines.join('\n') } } : null;
});

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  const r = rel(params.textDocument.uri);
  if (!workspace || !doc || !r) return [];

  return workspace.completionAt(r, offsetOf(doc, params.position)).map((c) => ({
    label: c.name,
    kind: c.kind === 'variable' ? CompletionItemKind.Variable : CompletionItemKind.Property,
    detail: c.detail,
  }));
});

/**
 * A refused rename returns a ResponseError with a reason, NOT null: with null, the IDE only shows
 * a generic "cannot rename" message and the user has no idea why (local variable, name collision,
 * shadowing…).
 */
connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  const r = rel(params.textDocument.uri);
  if (!workspace || !doc || !r) return null;

  const result = workspace.prepareRenameAt(r, offsetOf(doc, params.position));
  if ('reason' in result) return new ResponseError(LSPErrorCodes.RequestFailed, result.reason);
  return { range: toRange(doc.getText(), result.span), placeholder: result.placeholder };
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  const r = rel(params.textDocument.uri);
  if (!workspace || !doc || !r) return null;

  const result = workspace.renameAt(r, offsetOf(doc, params.position), params.newName);
  if (result.reason) return new ResponseError(LSPErrorCodes.RequestFailed, result.reason);

  const changes: Record<string, TextEdit[]> = {};
  for (const e of result.edits) {
    const loc = toLocation(e.path, e.span);
    // Missing a file makes the whole rename incomplete — refuse the whole batch rather than
    // return partial edits.
    if (!loc) return new ResponseError(LSPErrorCodes.RequestFailed, `Could not read ${e.path}`);
    (changes[loc.uri] ??= []).push({ range: loc.range, newText: e.newText });
  }
  if (result.note) void connection.window.showInformationMessage(`EJS/NG: ${result.note}`);
  return { changes };
});

connection.onDocumentSymbol((params) => {
  const r = rel(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!workspace || !r || !doc) return [];

  const facts = workspace.facts(r);
  if (!facts) return [];
  const source = doc.getText();

  if (facts.kind === 'js') {
    return facts.declarations.map((d) => ({
      name: `${d.kind} ${d.name}`,
      kind: 12 as const,
      range: toRange(source, d.bodySpan),
      selectionRange: toRange(source, d.nameSpan),
    }));
  }
  return facts.controllers.map((c) => ({
    name: `ng-controller ${c.name}`,
    kind: 5 as const,
    range: toRange(source, c.elementSpan),
    selectionRange: toRange(source, c.span),
  }));
});

/**
 * Diagnostics.
 *
 * OFF BY DEFAULT (docs/kien-truc.md section 10): on an older codebase, every expression that
 * fails to resolve becomes a warning, and a few thousand meaningless warnings will get the user
 * to disable the extension on day one. Only enable when the user opts in explicitly.
 */
async function publishDiagnostics(doc: TextDocument): Promise<void> {
  const r = rel(doc.uri);
  if (!workspace || !r) return;

  const facts = workspace.facts(r);
  const diagnostics: Diagnostic[] = [];
  const source = doc.getText();

  if (facts?.kind === 'template') {
    for (const err of facts.parseErrors) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: toRange(source, err.span),
        message: err.message,
        source: 'ejsng',
      });
    }
    for (const expr of facts.expressions) {
      for (const root of expr.roots) {
        const def = workspace.definitionAt(r, root.span.start);
        // `builtin` = an Angular variable injected automatically: no definition but not an error.
        if (def.targets.length || def.builtin || !def.reason) continue;
        diagnostics.push({
          severity: DiagnosticSeverity.Information,
          range: toRange(source, root.span),
          message: def.reason,
          source: 'ejsng',
        });
      }
    }
  }

  await connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

connection.onRequest('ejsng/reindex', () => {
  if (!workspace) return null;
  return workspace.index();
});

connection.onRequest('ejsng/stats', () => workspace?.stats() ?? null);

function runtimeLogConnectionKey(host: string, port: number, targetId: string): string {
  return `${host}:${port}:${targetId}`;
}

/** Mount-inferred mappings for whatever container publishes its inspector at `host:port`, or `[]` for a non-Docker target (ticket 05). */
function inferredMappingsFor(host: string, port: number): PathMapping[] {
  return mappingsFromMounts(dockerMountsByEndpoint.get(`${host}:${port}`) ?? []);
}

/** Count one dropped log under `reason` — see RuntimeLogConnectionInfo.droppedByReason. */
function recordDrop(info: RuntimeLogConnectionInfo, reason: string): void {
  info.droppedByReason[reason] = (info.droppedByReason[reason] ?? 0) + 1;
}

/** Push `item` onto a bounded ring buffer, dropping the oldest entry once `max` is exceeded. */
function pushBounded<T>(buffer: T[], item: T, max: number): void {
  buffer.push(item);
  if (buffer.length > max) buffer.shift();
}

/**
 * Ticket 03 (.scratch/runtime-remote-env/issues/03-chon-frame.md) — frame selection.
 *
 * `parseConsoleApiCalled` (packages/core) no longer picks a frame itself: it hands back every
 * candidate call frame, because deciding between them needs file content (obfuscation check) and
 * workspace/path-mapping knowledge that pure layer has no IO to reach. This walks them here:
 *
 *  1. Classify every frame against the skip-pattern list (`classifyFrameCandidates`, pure) —
 *     `node:internal/**`, `node_modules`, common vendored-logger directories, plus the user's own
 *     `ejsng.runtimeLog.skipFrames`. Frames that match are never considered further.
 *  2. Walk the surviving candidates IN ORDER. For each: map the container path (ticket 11, plus
 *     ticket 05's mappings inferred from the connected container's mounts — a path that matches
 *     none of them at all is skipped as `no-path-mapping`),
 *     resolve it to a workspace-relative path, and read its content — exactly the same
 *     containment/readability checks `onLog` already did for `callFrames[0]` pre-ticket-03. A
 *     candidate that fails containment, is unreadable, OR whose content trips `isLikelyMinified`
 *     (almost no newlines relative to file size — an obfuscated/minified bundle with no source
 *     map) is skipped forward to the NEXT candidate (spec story #16: fall back to the nearest
 *     frame that's actually usable, not just the nearest readable one — none of these three
 *     reasons should stop the walk early when a later frame might still work). The first candidate
 *     that clears all three wins.
 *  3. If nothing is left standing, the log draws nowhere — panel-only, counted under a specific
 *     reason, never silently dropped: the reason of the LAST candidate actually attempted
 *     (`outside-workspace` / `unreadable-file`), or `all-frames-skipped` (ticket 03, checklist
 *     item 4) when the candidate list was empty to begin with (every frame was pattern-skipped)
 *     or the last attempted candidate's own failure was `obfuscated` — obfuscation-driven
 *     exhaustion is grouped under the same bucket as pattern-driven exhaustion, since both are
 *     "frame selection gave up", not a workspace/path-mapping problem to fix.
 *
 * Every frame tried (pattern-skipped, obfuscated, or chosen) is recorded into `tried`, for the
 * panel's "stack tried / frames skipped, with reason" view (ticket 03, item 6).
 */
function selectRuntimeLogFrame(
  ws: Workspace,
  callFrames: CallFrame[],
  skipPatterns: string[],
  pathMappings: PathMapping[],
): { chosen: { frame: CallFrame; relPath: string; source: string } | null; dropReason: string; tried: FrameDiagnosticEntry[] } {
  const classified = classifyFrameCandidates(callFrames, skipPatterns);
  const tried: FrameDiagnosticEntry[] = [];
  let lastAttemptReason: 'outside-workspace' | 'unreadable-file' | 'obfuscated' | 'no-path-mapping' | null = null;

  for (const { frame, skippedByPattern } of classified) {
    if (skippedByPattern !== null) {
      tried.push({ url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, skipReason: 'skip-pattern', matchedPattern: skippedByPattern });
      continue;
    }

    const rawPath = frame.url.startsWith('file://') ? URI.parse(frame.url).fsPath : frame.url;
    const { path: fsPath, matched } = mapContainerPath(rawPath, pathMappings);
    // Mappings exist but none covers this path: the runtime is reporting paths from somewhere
    // this server has no translation for (ticket 05, item 5). Named apart from
    // `outside-workspace` because the fix is a different one — add a mapping / mount the
    // directory — and because with mappings in play it is the far more likely of the two.
    if (!matched && pathMappings.length > 0) {
      tried.push({ url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, skipReason: 'no-path-mapping' });
      lastAttemptReason = 'no-path-mapping';
      continue;
    }
    const relPath = ws.toRelative(fsPath);

    if (!isWithinRoot(relPath)) {
      tried.push({ url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, skipReason: 'outside-workspace' });
      lastAttemptReason = 'outside-workspace';
      continue;
    }
    const source = ws.source(relPath);
    if (source == null) {
      tried.push({ url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, skipReason: 'unreadable-file' });
      lastAttemptReason = 'unreadable-file';
      continue;
    }
    if (isLikelyMinified(source)) {
      tried.push({ url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, skipReason: 'obfuscated' });
      lastAttemptReason = 'obfuscated';
      continue;
    }

    tried.push({ url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, skipReason: null });
    return { chosen: { frame, relPath, source }, dropReason: '', tried };
  }

  const dropReason =
    lastAttemptReason === 'outside-workspace' || lastAttemptReason === 'unreadable-file' || lastAttemptReason === 'no-path-mapping'
      ? lastAttemptReason
      : 'all-frames-skipped';
  return { chosen: null, dropReason, tried };
}

/**
 * Move `info` to a new state and, if it actually changed, push `ejsng/runtimeStatusChanged` —
 * lets a client learn the REAL connecting -> connected/failed transition promptly instead of
 * polling `ejsng/runtimeStatus` on a timer just to catch it (ticket 02, item 4).
 */
function setConnectionState(key: string, info: RuntimeLogConnectionInfo, state: RuntimeLogConnectionState, reason?: string): void {
  if (info.state === state && info.reason === reason) return;
  info.state = state;
  info.reason = reason;
  void connection.sendNotification('ejsng/runtimeStatusChanged', { key, state, reason });
}

/**
 * Open (or replace) the CDP connection for `key`, forwarding every console call it can anchor
 * to a line as an `ejsng/runtimeLog` notification — shared by every target this server connects
 * to, server-side (Node) or browser-side (a Chrome tab), regardless of how many are live at once.
 */
function startRuntimeLogConnection(key: string, webSocketDebuggerUrl: string, inferredPathMappings: PathMapping[]): void {
  // `terminate()`, not `close()`: a reconnect to the SAME key supersedes it, doesn't shut it
  // down gracefully — don't wait on a close handshake before starting the replacement.
  runtimeLogConnections.get(key)?.socket.terminate();

  const info: RuntimeLogConnectionInfo = {
    socket: undefined as unknown as WebSocket, // set right below, before any callback can fire
    state: 'connecting',
    received: 0,
    drawn: 0,
    droppedByReason: {},
    recentFrameDiagnostics: [],
    recentChosenPaths: [],
    inferredPathMappings,
  };
  // Every callback guards on `runtimeLogConnections.get(key) !== info`: a message/event already
  // in flight on a connection this key has since replaced or disconnected must be ignored, so a
  // reconnect (or disconnect) can't mix in state from a connection no longer current.
  const socket = connectRuntimeLog(webSocketDebuggerUrl, {
    onOpen: () => {
      if (runtimeLogConnections.get(key) !== info) return;
      setConnectionState(key, info, 'connected');
    },
    onLog: (log) => {
      if (runtimeLogConnections.get(key) !== info) return;
      info.received++;
      // Defensive: `workspace` is set once in onInitialize and never reset, so this shouldn't be
      // reachable in practice — but if it ever were (e.g. a client connecting before/without a
      // completed initialize), the log must still be COUNTED, not silently missing from both
      // `drawn` and every entry of `droppedByReason`.
      if (!workspace) return recordDrop(info, 'server-not-ready');

      // User-declared mappings first: `mapContainerPath` is first-match-wins, so listing them
      // ahead of the container's own mounts is what makes a user's declaration beat an inferred
      // one for the same path (ticket 05, item 2).
      const { chosen, dropReason, tried } = selectRuntimeLogFrame(workspace, log.callFrames, runtimeLogSkipFramePatterns, [
        ...runtimeLogPathMappings,
        ...info.inferredPathMappings,
      ]);
      pushBounded(info.recentFrameDiagnostics, { at: Date.now(), frames: tried, chosenPath: chosen?.relPath ?? null }, MAX_RECENT_FRAME_DIAGNOSTICS);

      if (!chosen) return recordDrop(info, dropReason);

      const { frame, relPath, source } = chosen;
      const offset = offsetForLocation(source, frame.lineNumber, frame.columnNumber);
      info.drawn++;
      pushBounded(info.recentChosenPaths, relPath, MAX_RECENT_CHOSEN_PATHS);
      void connection.sendNotification('ejsng/runtimeLog', {
        uri: URI.file(`${workspace.config.root}/${relPath}`).toString(),
        range: toRange(source, { start: offset, end: offset }),
        value: stripAnsi(log.value),
        severity: log.severity,
      });
    },
    onUnanchored: () => {
      if (runtimeLogConnections.get(key) !== info) return;
      info.received++;
      recordDrop(info, 'no-stack-trace');
    },
    onError: (err) => {
      if (runtimeLogConnections.get(key) !== info) return;
      setConnectionState(key, info, 'failed', err.message);
      connection.console.error(`ejsng/connectRuntime (${key}): ${err.message}`);
    },
    onClose: (code, reason) => {
      if (runtimeLogConnections.get(key) !== info) return;
      if (info.state === 'failed') return; // already have a more specific reason from onError
      setConnectionState(key, info, 'failed', reason || `connection closed (code ${code})`);
    },
  });
  info.socket = socket;
  runtimeLogConnections.set(key, info);
}

function discoverTargetsOrError(host: string, port: number): Promise<DiscoveredTarget[] | { status: 'error'; message: string }> {
  return discoverTargets(host, port).catch((err: unknown) => ({
    status: 'error' as const,
    message: err instanceof Error ? err.message : String(err),
  }));
}

const DEFAULT_INSPECTOR_PORT = 9229;

interface DiscoverOutcome {
  targets: DiscoveredTarget[];
  /** The port targets were actually found on — may differ from the requested port (ticket 10). */
  port: number;
}

/**
 * Discover targets at `host:port` — and if nothing there speaks the debug protocol at all,
 * ticket 10: treat it as an ordinary app port, find the local process listening on it, and ask
 * Node to enable its own inspector via `SIGUSR1` (no restart) before trying again on Node's
 * default inspector port (9229 — the only port reachable this way, since a custom
 * `--inspect-port` can't be discovered from the outside). The caller needs the EFFECTIVE port
 * back, not just the targets, since it may not be the one it asked about.
 */
async function discoverTargetsWithAutoEnable(
  host: string,
  port: number,
): Promise<DiscoverOutcome | { status: 'error'; message: string }> {
  try {
    return { targets: await discoverTargets(host, port), port };
  } catch {
    // Fall through to the auto-enable attempt below.
  }
  const pid = await findPidListeningOnPort(port);
  if (pid == null) {
    return {
      status: 'error' as const,
      message: `no debug endpoint at ${host}:${port}, and no local process listening on that port to enable one for`,
    };
  }
  try {
    process.kill(pid, 'SIGUSR1');
  } catch (err) {
    return { status: 'error' as const, message: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { targets: await waitForTargets(host, DEFAULT_INSPECTOR_PORT), port: DEFAULT_INSPECTOR_PORT };
  } catch (err) {
    return { status: 'error' as const, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Discover targets at `host:port` (per spec: the user already started their app with
 * `node --inspect`, or Chrome with `--remote-debugging-port` — see
 * .scratch/inline-runtime-log/spec.md and issues/02a-multi-connection-server.md) and either
 * connect immediately (exactly one connectable target), ask the client to pick one
 * (`ejsng/connectRuntimeTarget`, several), or report none found. If `host:port` isn't a debug
 * endpoint at all, ticket 10's auto-enable kicks in first (see discoverTargetsWithAutoEnable) —
 * a `'choose'` response's `port` may then differ from what the client asked about, and must be
 * echoed back verbatim in the `ejsng/connectRuntimeTarget` follow-up.
 */
connection.onRequest('ejsng/connectRuntime', async (params: { host: string; port: number }) => {
  const outcome = await discoverTargetsWithAutoEnable(params.host, params.port);
  if (!('targets' in outcome)) return outcome;
  const { targets, port } = outcome;
  if (targets.length === 0) return { status: 'not-found' as const };
  if (targets.length > 1) {
    return {
      status: 'choose' as const,
      port,
      targets: targets.map((t) => ({ id: t.id, title: t.title, url: t.url, type: t.type })),
    };
  }
  const [target] = targets;
  if (!target) return { status: 'not-found' as const };
  const key = runtimeLogConnectionKey(params.host, port, target.id);
  startRuntimeLogConnection(key, target.webSocketDebuggerUrl, inferredMappingsFor(params.host, port));
  return { status: 'connected' as const, key, port };
});

/**
 * Connect to one specific target — the follow-up after a `'choose'` response. `port` must be
 * the one THAT response returned (see ejsng/connectRuntime), not necessarily what was originally
 * typed — ticket 10's auto-enable can redirect discovery to a different port.
 */
connection.onRequest('ejsng/connectRuntimeTarget', async (params: { host: string; port: number; targetId: string }) => {
  const targets = await discoverTargetsOrError(params.host, params.port);
  if (!Array.isArray(targets)) return targets;
  const target = targets.find((t) => t.id === params.targetId);
  if (!target) return { status: 'error' as const, message: `target ${params.targetId} not found` };
  const key = runtimeLogConnectionKey(params.host, params.port, target.id);
  startRuntimeLogConnection(key, target.webSocketDebuggerUrl, inferredMappingsFor(params.host, params.port));
  return { status: 'connected' as const, key };
});

/** Close and forget one runtime-log connection. Disconnecting an unknown key is a no-op. */
connection.onRequest('ejsng/disconnectRuntime', (params: { key: string }) => {
  const info = runtimeLogConnections.get(params.key);
  if (!info) return { disconnected: false };
  // Delete BEFORE terminate(): the socket's own 'close' handler guards on this map entry, so an
  // intentional disconnect must not be mistaken for the connection failing on its own.
  runtimeLogConnections.delete(params.key);
  info.socket.terminate();
  return { disconnected: true };
});

/**
 * New in ticket 02 (item 4) — additive, does not change any existing request/notification shape
 * (ejsng/connectRuntime, connectRuntimeTarget, disconnectRuntime, runtimeLog all keep their
 * current contract, so the future IntelliJ client isn't broken). Lets a client build a real
 * "received / drawn / dropped" display instead of just a connection count, and see the true
 * connecting/connected/failed state per connection instead of trusting connectRuntime's
 * synchronous (and, for back-compat, still optimistic) 'connected' response.
 *
 * `recentLogs`/`wrapperSuggestion` are ticket 03's additions (also purely additive fields on the
 * SAME per-connection object) — the panel's "stack tried / frames skipped" view (item 6) and the
 * "this file looks like a wrapper — skip it?" suggestion (item 7).
 */
connection.onRequest('ejsng/runtimeStatus', () => ({
  connections: [...runtimeLogConnections.entries()].map(([key, info]) => ({
    key,
    state: info.state,
    reason: info.reason,
    received: info.received,
    drawn: info.drawn,
    droppedByReason: info.droppedByReason,
    recentLogs: info.recentFrameDiagnostics,
    wrapperSuggestion: suggestWrapperFile(info.recentChosenPaths),
  })),
}));

// ---------------------------------------------------------------------------------------------
// Ticket 04 (.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md): find a
// Runtime Target through Docker, so the user can hit Connect with nothing typed at all, or with
// their app's ordinary port instead of a debug port. New request only — does NOT touch
// ejsng/connectRuntime, connectRuntimeTarget, disconnectRuntime, or runtimeLog's existing shape
// (same additive convention ticket 02 used for ejsng/runtimeStatus/runtimeStatusChanged, see its
// Comments). Intentionally kept self-contained rather than sharing helpers with the handlers
// above, so it doesn't risk altering their behavior or shape.

/** Docker always publishes a container's ports on the Docker host's own loopback interface. */
const DOCKER_DISCOVERY_HOST = '127.0.0.1';

/** One connectable Docker container, shaped for a client-side Quick Pick (checklist item 5). */
interface DockerCandidateSummary {
  host: string;
  port: number;
  label: string;
}

type DiscoverRuntimeTargetsResult =
  | { status: 'connected'; key: string; host: string; port: number; unreachable: string[] }
  | {
      status: 'choose';
      host: string;
      port: number;
      targets: Array<{ id: string; title: string; url: string; type: string }>;
      unreachable: string[];
    }
  | { status: 'choose-container'; candidates: DockerCandidateSummary[]; unreachable: string[] }
  | { status: 'no-docker-target' }
  | { status: 'unreachable-containers'; containers: string[] }
  | { status: 'error'; message: string };

/**
 * Discover Runtime Targets through Docker. `params.appPort`, when given, narrows to the
 * container that PUBLISHES that port as an app port (checklist item 4) — e.g. typing `5000`
 * finds `cityos-web`. Omitted entirely (the "Connect with nothing typed" flow, checklist item 1)
 * considers every candidate found on the machine.
 *
 * `'no-docker-target'` covers BOTH "no `docker` on PATH" and "Docker is fine but nothing here
 * matched" — either way the client should fall straight through to its existing pre-Docker flow
 * (an `ejsng/connectRuntime` call, same as before this ticket) without surfacing an error; per
 * the spec, no Docker is an expected, common case, not a failure.
 *
 * Checklist item 6 (a container IS running Node with `--inspect` enabled, but never published
 * that port to the host — report it by name, never touch the running container to try to fix
 * that itself; out of scope per the spec: no `docker exec`, no modifying compose) is carried as
 * `unreachable` container names on EVERY status, not only when nothing else is connectable — a
 * user with `cityos-web` (connectable) AND `cityos-worker` (not) should still be told about
 * `cityos-worker` once `cityos-web` connects, not just when it's the only container found at all.
 * `'unreachable-containers'` on its own is the case where NOTHING is connectable, `unreachable`
 * is the whole story, and there's no `'connected'`/`'choose*'` result to attach it to instead.
 */
connection.onRequest(
  'ejsng/discoverRuntimeTargets',
  async (params: { appPort?: number }): Promise<DiscoverRuntimeTargetsResult> => {
    const containers = await listDockerRuntimeCandidates();
    const filtered = params.appPort != null ? filterDockerCandidatesByAppPort(containers, params.appPort) : containers;
    const { connectable, unreachable } = partitionDockerCandidates(filtered);
    const unreachableNames = unreachable.map((c) => c.containerName);

    // Ticket 05: remember each connectable container's mounts against the endpoint it's reachable
    // at, for whichever connect path runs next. Cleared first so a container that was rebuilt
    // with different mounts — or removed entirely — can never leave a stale entry behind: these
    // mappings are recomputed on every Connect and never written to settings (checklist item 4).
    dockerMountsByEndpoint.clear();
    for (const c of connectable) {
      dockerMountsByEndpoint.set(`${DOCKER_DISCOVERY_HOST}:${c.hostInspectorPort as number}`, c.mounts);
    }

    if (connectable.length === 0) {
      if (unreachableNames.length > 0) {
        return { status: 'unreachable-containers', containers: unreachableNames };
      }
      return { status: 'no-docker-target' };
    }

    if (connectable.length > 1) {
      return {
        status: 'choose-container',
        candidates: connectable.map((c) => ({
          host: DOCKER_DISCOVERY_HOST,
          port: c.hostInspectorPort as number, // non-null: filtered into `connectable` on exactly that
          label: formatDockerCandidateLabel(c),
        })),
        unreachable: unreachableNames,
      };
    }

    // Exactly one connectable container (checklist item 5: exactly one candidate connects
    // immediately) — its inspector target still needs the ordinary CDP discovery dance (almost
    // always exactly one target for a Node process, but handled generally in case it ever isn't).
    const [only] = connectable;
    if (!only) return { status: 'no-docker-target' }; // unreachable in practice: connectable.length === 1 here
    const port = only.hostInspectorPort as number;
    let targets: DiscoveredTarget[];
    try {
      targets = await discoverTargets(DOCKER_DISCOVERY_HOST, port);
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    if (targets.length === 0) {
      return {
        status: 'error',
        message: `container "${only.containerName}" publishes an inspector port at ${DOCKER_DISCOVERY_HOST}:${port}, but nothing answered the debug protocol there`,
      };
    }
    if (targets.length > 1) {
      return {
        status: 'choose',
        host: DOCKER_DISCOVERY_HOST,
        port,
        targets: targets.map((t) => ({ id: t.id, title: t.title, url: t.url, type: t.type })),
        unreachable: unreachableNames,
      };
    }
    const [target] = targets;
    if (!target) {
      return {
        status: 'error',
        message: `container "${only.containerName}" publishes an inspector port at ${DOCKER_DISCOVERY_HOST}:${port}, but nothing answered the debug protocol there`,
      };
    }
    const key = runtimeLogConnectionKey(DOCKER_DISCOVERY_HOST, port, target.id);
    startRuntimeLogConnection(key, target.webSocketDebuggerUrl, mappingsFromMounts(only.mounts));
    return { status: 'connected', key, host: DOCKER_DISCOVERY_HOST, port, unreachable: unreachableNames };
  },
);

documents.listen(connection);
connection.listen();
