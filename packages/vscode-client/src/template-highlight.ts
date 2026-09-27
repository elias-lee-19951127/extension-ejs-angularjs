import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/**
 * In a template, the names JavaScript answers for — scope variables and their properties,
 * controllers, directives, components, filters — colored and bold, so what is connected to a `.js`
 * file stands apart from plain markup at a glance. The server works out which they are
 * (`ejsng/linkedSymbols`); this only draws them.
 */

/** One name as the server's `ejsng/linkedSymbols` reports it. */
interface LinkedSymbol {
  range: vscode.Range;
  kind: 'scope' | 'declaration';
}

const SUPPORTED = new Set(['html', 'ejs']);
const SETTING = 'ejsng.templateHighlight.enabled';

/** What was last drawn per file, by kind — VS Code can't read decorations back; for tests only. */
const rendered = new Map<string, Array<{ kind: LinkedSymbol['kind']; text: string }>>();

export function renderedTemplateHighlights(uri: string): Array<{ kind: LinkedSymbol['kind']; text: string }> {
  return rendered.get(uri) ?? [];
}

export function registerTemplateHighlight(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined): void {
  const scope = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('ejsng.linkedScope.foreground'),
    fontWeight: 'bold',
  });
  const declaration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('ejsng.linkedDeclaration.foreground'),
    fontWeight: 'bold',
  });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const enabled = (): boolean => vscode.workspace.getConfiguration().get<boolean>(SETTING, true);

  const refresh = async (editor: vscode.TextEditor): Promise<void> => {
    const doc = editor.document;
    if (!SUPPORTED.has(doc.languageId) || doc.uri.scheme !== 'file') return;
    let symbols: LinkedSymbol[] = [];
    const client = getClient();
    if (enabled() && client) {
      const version = doc.version;
      try {
        const r = await client.sendRequest<{ symbols: LinkedSymbol[] }>('ejsng/linkedSymbols', { uri: doc.uri.toString() });
        symbols = r?.symbols ?? [];
      } catch {
        return;
      }
      // Typed on since it was asked: these ranges are stale, and a newer refresh is on its way.
      if (doc.version !== version) return;
    }
    const range = (s: LinkedSymbol) => new vscode.Range(s.range.start.line, s.range.start.character, s.range.end.line, s.range.end.character);
    editor.setDecorations(scope, symbols.filter((s) => s.kind === 'scope').map(range));
    editor.setDecorations(declaration, symbols.filter((s) => s.kind === 'declaration').map(range));
    rendered.set(doc.uri.toString(), symbols.map((s) => ({ kind: s.kind, text: doc.getText(range(s)) })));
  };

  const refreshVisible = (): void => {
    for (const e of vscode.window.visibleTextEditors) void refresh(e);
  };
  const schedule = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        for (const e of vscode.window.visibleTextEditors) if (e.document === doc) void refresh(e);
      }, 400),
    );
  };

  // The first index is still being built right after start: look again once it has had time.
  const warmup = [1500, 5000, 15000].map((ms) => setTimeout(refreshVisible, ms));

  context.subscriptions.push(
    scope,
    declaration,
    new vscode.Disposable(() => {
      warmup.forEach(clearTimeout);
      timers.forEach(clearTimeout);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => void refresh(e))),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (SUPPORTED.has(e.document.languageId)) schedule(e.document);
    }),
    // A saved script can add or remove what a template's names resolve to.
    vscode.workspace.onDidSaveTextDocument(() => setTimeout(refreshVisible, 600)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SETTING)) refreshVisible();
    }),
  );
  refreshVisible();
}
