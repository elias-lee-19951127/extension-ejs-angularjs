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
import { Workspace, type Config, type Span } from '@ejsng/core';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspace: Workspace | null = null;
let diagnosticsEnabled = false;
/**
 * Client cho dang ky watcher dong (workspace.didChangeWatchedFiles.dynamicRegistration)?
 * `relative`: client hieu RelativePattern. null = khong dang ky (LSP 3.17).
 */
let fileWatch: { relative: boolean } | null = null;

connection.onInitialize((params): InitializeResult => {
  const folder = params.workspaceFolders?.[0]?.uri;
  const root = folder ? URI.parse(folder).fsPath : (params.rootPath ?? process.cwd());

  const settings = (params.initializationOptions ?? {}) as Partial<Config> & {
    diagnostics?: { enabled?: boolean };
  };
  diagnosticsEnabled = settings.diagnostics?.enabled ?? false;
  // LSP 3.17: RenameOptions chi duoc gui khi client khai bao prepareSupport.
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
  // Dang ky TRUOC khi index: file doi trong luc dang index van duoc bao, xu ly ngay sau.
  if (fileWatch) {
    void connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: fileWatchers(workspace, fileWatch.relative),
    });
  }
  // Index nen: server tra loi duoc ngay o che do suy giam trong luc dang chay.
  connection.console.log('EJS/NG: bat dau danh index...');
  const r = workspace.index();
  connection.console.log(
    `EJS/NG: xong — ${r.indexed} file moi, ${r.skipped} khong doi, ${r.linkedRefs} ref noi them, ${r.ms}ms`,
  );
});

// ------------------------------------------------------------------ helpers

function rel(uri: string): string | null {
  if (!workspace) return null;
  return workspace.toRelative(URI.parse(uri).fsPath);
}

/**
 * Watcher dang ky voi client.
 *
 * LSP4IJ (IntelliJ) chi gui workspace/didChangeWatchedFiles cho duong dan khop watcher do server
 * dang ky — khong dang ky thi khong co su kien nao. VSCode van gui them theo
 * `synchronize.fileEvents` cua client; su kien lap thi refreshFiles bo qua.
 *
 * - Change: theo `ws.changeWatchPatterns()` — chi file duoc index moi can. Server khong tu doc
 *   `config.include` roi doan ngu nghia '!…' cua no; Workspace tra sang di.
 * - Create/Delete: MOI duong dan. Ca thu muc duoc tao/xoa/doi ten (git checkout them hay bot ca
 *   thu muc) thi client chi bao MOT su kien cho chinh thu muc, ma ten thu muc khong khop glob
 *   theo duoi file.
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

/** Doi span (offset) sang Range cua LSP, dua tren noi dung file dich. */
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
 * Duong dan trong hover viet thanh link mo duoc: `[path:dong](file://…#L<dong>)`.
 *
 * Hover la cho DUY NHAT con chi ra ban o thu muc xa hon (`otherFiles`) sau khi go-to-definition da
 * loc bot, nen no phai bam toi duoc. VSCode mo dung dong; LSP4IJ dung markdown sang HTML nen con
 * phai kiem trong IDE that.
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
  // Sua mot controller khong can parse lai template nao — chi noi lai (Layer 4).
  workspace.link();
});

documents.onDidClose((e) => {
  const r = rel(e.document.uri);
  if (workspace && r) workspace.clearOverlay(r);
  void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

/**
 * File doi ngoai editor: git pull, checkout, tool khac. Chi cap nhat lop "dia" cua index — buffer
 * dang mo khong bi dung toi (xem Workspace.refreshFiles).
 */
connection.onDidChangeWatchedFiles(({ changes }) => {
  if (!workspace) return;
  const paths = changes.map((c) => rel(c.uri)).filter((p): p is string => p !== null);
  const r = workspace.refreshFiles(paths);
  if (r.indexed || r.removed) {
    connection.console.log(
      `EJS/NG: file doi ngoai editor — ${r.indexed} file doc lai, ${r.removed} file go` +
        `${r.rescanned ? ' (co file moi: quet lai)' : ''}, ${r.ms}ms`,
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
      const conf = t.confidence === 'high' ? '' : ` _(do tin cay: ${t.confidence})_`;
      lines.push(`- ${t.detail} — ${fileLink(t.path, t.span)}${conf}`);
    }
    // Ban o thu muc xa hon da bi loai khoi ket qua nhay — o day van phai toi duoc.
    if (def.otherFiles?.length) {
      const links = def.otherFiles.map((p) => fileLink(p)).join(', ');
      lines.push(`- _con ${def.otherFiles.length} ban o thu muc xa hon:_ ${links}`);
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
    if (desc.length) lines.push('', `Chuoi scope: ${desc.join(' ← ')}`);
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
 * Rename bi tu choi thi tra ResponseError kem ly do, KHONG tra null: voi null, IDE chi
 * bao chung chung "khong doi ten duoc" va nguoi dung khong biet vi sao (bien cuc bo,
 * trung ten, bi che bong…).
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
    // Thieu mot file la doi ten do dang — tu choi ca lan thay vi tra edit thieu.
    if (!loc) return new ResponseError(LSPErrorCodes.RequestFailed, `Khong doc duoc ${e.path}`);
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
 * Chan doan.
 *
 * MAC DINH TAT (docs/kien-truc.md muc 10): tren codebase cu, moi bieu thuc khong
 * resolve duoc se thanh mot canh bao, va vai nghin canh bao vo nghia se khien
 * nguoi dung tat extension trong ngay dau. Chi bat khi nguoi dung chu dong chon.
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
        // `builtin` = bien Angular tu bom vao: khong co dinh nghia nhung khong phai loi.
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

documents.listen(connection);
connection.listen();
