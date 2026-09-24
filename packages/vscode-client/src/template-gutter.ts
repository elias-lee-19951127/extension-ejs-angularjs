import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/**
 * IntelliJ-style gutter icons linking a `.js` file and the templates its `templateUrl`s load: an
 * HTML icon beside each `templateUrl` that maps to a file, a controller icon on the first line of a
 * template loaded by one. VS Code runs nothing when a gutter icon is clicked, so the same links are
 * one keystroke away through `ejsng.goToRelated` (IntelliJ's Go to Related Symbol).
 */

/** One link as the server's `ejsng/templateLinks` reports it. */
export interface TemplateLinkInfo {
  range: vscode.Range;
  target: { uri: string; range: vscode.Range };
  targetPath: string;
  kind: 'template' | 'templateUrl';
  via: string;
  owner: string;
  url: string;
  controller: string | null;
}

export const GO_TO_RELATED_COMMAND = 'ejsng.goToRelated';

const SUPPORTED = new Set(['javascript', 'html', 'ejs']);

export function registerTemplateGutter(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined): void {
  const templateIcon = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath('media/gutter-template.svg'),
    gutterIconSize: '80%',
  });
  const controllerIcon = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath('media/gutter-controller.svg'),
    gutterIconSize: '80%',
  });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const linksFor = async (doc: vscode.TextDocument): Promise<TemplateLinkInfo[]> => {
    const client = getClient();
    if (!client || !SUPPORTED.has(doc.languageId) || doc.uri.scheme !== 'file') return [];
    try {
      const r = await client.sendRequest<{ links: TemplateLinkInfo[] }>('ejsng/templateLinks', { uri: doc.uri.toString() });
      return r?.links ?? [];
    } catch {
      return [];
    }
  };

  const refresh = async (editor: vscode.TextEditor): Promise<void> => {
    const links = await linksFor(editor.document);
    const js: vscode.DecorationOptions[] = [];
    const back: vscode.DecorationOptions[] = [];
    for (const l of links) {
      if (l.kind === 'template') {
        js.push({ range: lineOf(editor.document, l.range.start.line) });
      }
    }
    const uses = links.filter((l) => l.kind === 'templateUrl');
    if (uses.length) back.push({ range: lineOf(editor.document, 0), hoverMessage: usedByHover(uses) });
    editor.setDecorations(templateIcon, js);
    editor.setDecorations(controllerIcon, back);
  };

  const schedule = (doc: vscode.TextDocument, delay = 400): void => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        for (const e of vscode.window.visibleTextEditors) if (e.document === doc) void refresh(e);
      }, delay),
    );
  };
  const refreshVisible = (): void => {
    for (const e of vscode.window.visibleTextEditors) void refresh(e);
  };

  // The first index is still being built right after start: look again once it has had time.
  const warmup = [1500, 5000, 15000].map((ms) => setTimeout(refreshVisible, ms));

  context.subscriptions.push(
    templateIcon,
    controllerIcon,
    new vscode.Disposable(() => {
      warmup.forEach(clearTimeout);
      timers.forEach(clearTimeout);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => void refresh(e))),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    // Saving one file can link or unlink another (a new templateUrl, a renamed template).
    vscode.workspace.onDidSaveTextDocument(() => setTimeout(refreshVisible, 600)),
    vscode.commands.registerCommand(GO_TO_RELATED_COMMAND, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const links = await linksFor(editor.document);
      if (!links.length) {
        void vscode.window.setStatusBarMessage('EJS/NG: no template or templateUrl linked to this file', 3000);
        return;
      }
      // On a templateUrl line, that link alone — as clicking its gutter icon would.
      const line = editor.selection.active.line;
      const here = links.filter((l) => l.kind === 'template' && l.range.start.line === line);
      const choices = here.length ? here : links;
      const pick =
        choices.length === 1
          ? choices[0]
          : (
              await vscode.window.showQuickPick(
                choices.map((l) => ({ label: `$(${l.kind === 'template' ? 'file-code' : 'symbol-class'}) ${label(l)}`, description: l.targetPath, link: l })),
                { placeHolder: 'Go to related template / controller', matchOnDescription: true },
              )
            )?.link;
      if (!pick) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(pick.target.uri));
      const r = pick.target.range;
      const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
      await vscode.window.showTextDocument(doc, { selection: range });
    }),
  );
  refreshVisible();
}

function lineOf(doc: vscode.TextDocument, line: number): vscode.Range {
  const l = Math.min(line, Math.max(0, doc.lineCount - 1));
  return new vscode.Range(l, 0, l, 0);
}

function label(l: TemplateLinkInfo): string {
  if (l.kind === 'template') return `${l.url}${l.controller ? ` — ${l.controller}` : ''}`;
  return `${l.controller ?? l.owner} — templateUrl of ${l.via} '${l.owner}'`;
}

function usedByHover(uses: TemplateLinkInfo[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Loaded by** — ${uses.length === 1 ? 'one templateUrl' : `${uses.length} templateUrls`}\n\n`);
  for (const u of uses) {
    const line = u.target.range.start.line + 1;
    const link = vscode.Uri.parse(u.target.uri).with({ fragment: `L${line}` }).toString();
    const ctrl = u.controller ? `\`${u.controller}\` · ` : '';
    md.appendMarkdown(`- $(symbol-class) ${ctrl}${u.via} \`${u.owner}\` — [${u.targetPath}:${line}](${link})\n`);
  }
  md.supportThemeIcons = true;
  return md;
}
