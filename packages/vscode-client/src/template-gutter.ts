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
/** From a `templateUrl`'s hover: pick the template it loads; saved in `ejsng.templateUrlMap`. */
export const LINK_TEMPLATE_URL_COMMAND = 'ejsng.linkTemplateUrl';
export const UNLINK_TEMPLATE_URL_COMMAND = 'ejsng.unlinkTemplateUrl';

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
    vscode.commands.registerCommand(LINK_TEMPLATE_URL_COMMAND, async (args?: { url?: string; uri?: string }) => {
      const url = args?.url;
      if (typeof url !== 'string') return;
      const picked = await pickTemplate(url);
      if (!picked) return;
      await saveTemplateUrlMap((map) => ({ ...map, [url]: picked }));
      void vscode.window.setStatusBarMessage(`EJS/NG: '${url}' → ${picked} (saved in ejsng.templateUrlMap)`, 4000);
      setTimeout(refreshVisible, 300);
    }),
    vscode.commands.registerCommand(UNLINK_TEMPLATE_URL_COMMAND, async (args?: { url?: string }) => {
      const url = args?.url;
      if (typeof url !== 'string') return;
      await saveTemplateUrlMap((map) => {
        const next = { ...map };
        delete next[url];
        return next;
      });
      setTimeout(refreshVisible, 300);
    }),
    // Edited by hand, or by the commands above: the server relinks without a reload.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('ejsng.templateUrlMap')) return;
      const map = vscode.workspace.getConfiguration('ejsng').get<Record<string, string>>('templateUrlMap') ?? {};
      void getClient()?.sendNotification('ejsng/setTemplateUrlMap', { map });
      setTimeout(refreshVisible, 300);
    }),
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

/**
 * The templates of the workspace, best guesses first: same file name (any template extension), then
 * a name containing the URL's, then the rest — the one the URL means is nearly always on top.
 */
async function pickTemplate(url: string): Promise<string | undefined> {
  const files = await vscode.workspace.findFiles('**/*.{html,ejs,htm}', '**/{node_modules,bower_components,dist,.git}/**', 5000);
  const base = url.split(/[?#]/)[0]!.split('/').pop() ?? '';
  const stem = base.replace(/\.(html|ejs|htm)$/i, '').toLowerCase();
  const rank = (rel: string) => {
    const name = rel.split('/').pop()!.replace(/\.(html|ejs|htm)$/i, '').toLowerCase();
    if (stem && name === stem) return rel.toLowerCase().endsWith(url.replace(/^[./]+/, '').toLowerCase()) ? 0 : 1;
    if (stem && (name.includes(stem) || stem.includes(name))) return 2;
    return 3;
  };
  const items = files
    .map((f) => vscode.workspace.asRelativePath(f, false))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((rel) => ({ label: `$(file-code) ${rel.split('/').pop()}`, description: rel, rel }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Template loaded by templateUrl '${url}'`,
    matchOnDescription: true,
  });
  return picked?.rel;
}

/** Write `ejsng.templateUrlMap` where it lives for this workspace (committable in .vscode/settings.json). */
async function saveTemplateUrlMap(update: (map: Record<string, string>) => Record<string, string>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ejsng');
  const current = cfg.inspect<Record<string, string>>('templateUrlMap')?.workspaceValue ?? {};
  await cfg.update('templateUrlMap', update(current), vscode.ConfigurationTarget.Workspace);
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
