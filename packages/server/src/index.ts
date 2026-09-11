#!/usr/bin/env node
import {
  createConnection,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type CompletionItem,
  CompletionItemKind,
  type Diagnostic,
  type InitializeResult,
  type Location,
  type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { Workspace, type Config, type Span } from '@ejsng/core';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspace: Workspace | null = null;
let diagnosticsEnabled = false;

connection.onInitialize((params): InitializeResult => {
  const folder = params.workspaceFolders?.[0]?.uri;
  const root = folder ? URI.parse(folder).fsPath : (params.rootPath ?? process.cwd());

  const settings = (params.initializationOptions ?? {}) as Partial<Config> & {
    diagnostics?: { enabled?: boolean };
  };
  diagnosticsEnabled = settings.diagnostics?.enabled ?? false;

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
    },
  };
});

connection.onInitialized(() => {
  void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  if (!workspace) return;
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
      lines.push(`- ${t.detail} — \`${t.path}\`${conf}`);
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
