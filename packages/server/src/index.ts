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
import { isWithinRoot, Workspace, type Config, type Span } from '@ejsng/core';
import { connectRuntimeLog, offsetForLocation } from './runtime-log';
import type WebSocket from 'ws';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspace: Workspace | null = null;
let diagnosticsEnabled = false;
let runtimeLogSocket: WebSocket | null = null;
/** Bumped on every `ejsng/connectRuntime` call, so a superseded connection's callbacks no-op. */
let runtimeLogEpoch = 0;
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
  };
  diagnosticsEnabled = settings.diagnostics?.enabled ?? false;
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

/**
 * Connect to a CDP/Inspector Protocol endpoint (per spec: the user already started their app
 * with `node --inspect`, see .scratch/inline-runtime-log/spec.md) and push every console call it
 * reports, mapped to its line, as an `ejsng/runtimeLog` notification.
 */
connection.onRequest('ejsng/connectRuntime', (params: { url: string }) => {
  // `terminate()`, not `close()`: we're superseding this connection, not shutting it down
  // gracefully, so don't wait on a close handshake before starting the replacement.
  runtimeLogSocket?.terminate();
  const epoch = ++runtimeLogEpoch;
  runtimeLogSocket = connectRuntimeLog(
    params.url,
    (log) => {
      // A message already in flight on a socket `ejsng/connectRuntime` has since superseded —
      // ignore it, so a reconnect can't mix logs from the old and new target.
      if (epoch !== runtimeLogEpoch) return;
      if (!workspace) return;
      const fsPath = log.url.startsWith('file://') ? URI.parse(log.url).fsPath : log.url;
      const relPath = workspace.toRelative(fsPath);
      if (!isWithinRoot(relPath)) return; // outside the workspace — not ours to read
      const source = workspace.source(relPath);
      if (source == null) return;
      const offset = offsetForLocation(source, log.line, log.character);
      void connection.sendNotification('ejsng/runtimeLog', {
        uri: URI.file(`${workspace.config.root}/${relPath}`).toString(),
        range: toRange(source, { start: offset, end: offset }),
        value: log.value,
      });
    },
    (err) => {
      if (epoch !== runtimeLogEpoch) return;
      connection.console.error(`ejsng/connectRuntime: ${err.message}`);
    },
  );
  return { connected: true };
});

documents.listen(connection);
connection.listen();
