import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { RuntimeLogState, type RuntimeLogEntry } from './runtime-log-state';

let client: LanguageClient | undefined;
let runtimeLogStatusBar: vscode.StatusBarItem | undefined;
let runtimeLogDecorationType: vscode.TextEditorDecorationType | undefined;
const runtimeLogState = new RuntimeLogState();

/** The shape of an `ejsng/runtimeLog` notification's params — mirrors packages/server/src/index.ts. */
interface RuntimeLogNotification {
  uri: string;
  range: { start: { line: number; character: number } };
  value: string;
  severity: 'log' | 'warning' | 'error';
}

/** ANSI theme colors so the decoration matches the severity at a glance, in any color theme. */
const SEVERITY_COLOR: Record<RuntimeLogEntry['severity'], string> = {
  log: 'terminal.ansiGreen',
  warning: 'terminal.ansiYellow',
  error: 'terminal.ansiRed',
};

function redrawRuntimeLogDecorations(uri: string, entries: RuntimeLogEntry[]): void {
  if (!runtimeLogDecorationType) return;
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
  if (!editor) return;
  const options: vscode.DecorationOptions[] = entries.map((e) => {
    // Anchor at the END of the line, not the exact call-site column — the column can land
    // mid-expression (e.g. inside `console.log(...)`), which reads as broken, not inline.
    const lineEnd = editor.document.lineAt(e.line).range.end;
    return {
      range: new vscode.Range(lineEnd, lineEnd),
      renderOptions: {
        after: { contentText: `  » ${e.value}`, color: new vscode.ThemeColor(SEVERITY_COLOR[e.severity]) },
      },
    };
  });
  editor.setDecorations(runtimeLogDecorationType, options);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The server is already bundled into the extension (see build.js). Do not
  // point outside the extension directory: such a path is not part of the .vsix package.
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const cfg = vscode.workspace.getConfiguration('ejsng');
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'html' },
      { scheme: 'file', language: 'ejs' },
      { scheme: 'file', pattern: '**/*.ejs' },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{js,ejs,html}'),
    },
    initializationOptions: {
      include: cfg.get('include'),
      exclude: cfg.get('exclude'),
      moduleAliases: cfg.get('moduleAliases'),
      ejsDelimiter: cfg.get('ejsDelimiter'),
      customDirectives: cfg.get('customDirectives'),
      diagnostics: { enabled: cfg.get('diagnostics.enabled') },
    },
  };

  client = new LanguageClient('ejsng', 'EJS + AngularJS Navigator', serverOptions, clientOptions);

  runtimeLogDecorationType = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 1.5em', fontWeight: 'bold' },
  });
  runtimeLogStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  runtimeLogStatusBar.text = 'EJS/NG Runtime: off';
  runtimeLogStatusBar.show();

  context.subscriptions.push(
    runtimeLogDecorationType,
    runtimeLogStatusBar,
    vscode.commands.registerCommand('ejsng.reindex', async () => {
      const r = await client?.sendRequest('ejsng/reindex');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
    vscode.commands.registerCommand('ejsng.showStats', async () => {
      const r = await client?.sendRequest('ejsng/stats');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
    vscode.commands.registerCommand('ejsng.connectRuntime', async () => {
      const url = vscode.workspace.getConfiguration('ejsng').get<string>('runtimeLog.inspectorUrl', '');
      if (!url) {
        void vscode.window.showWarningMessage('EJS/NG: set "ejsng.runtimeLog.inspectorUrl" first.');
        return;
      }
      runtimeLogStatusBar!.text = 'EJS/NG Runtime: connecting…';
      try {
        const r = await client?.sendRequest<{ connected: boolean }>('ejsng/connectRuntime', { url });
        runtimeLogStatusBar!.text = r?.connected ? 'EJS/NG Runtime: connected' : 'EJS/NG Runtime: error';
      } catch (err) {
        runtimeLogStatusBar!.text = 'EJS/NG Runtime: error';
        void vscode.window.showErrorMessage(`EJS/NG: failed to connect to runtime — ${String(err)}`);
      }
    }),
    // A split/reopened editor for a file with existing hits starts undecorated otherwise.
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        const uri = editor.document.uri.toString();
        const entries = runtimeLogState.entriesFor(uri);
        if (entries.length) redrawRuntimeLogDecorations(uri, entries);
      }
    }),
  );

  await client.start();

  client.onNotification('ejsng/runtimeLog', (params: RuntimeLogNotification) => {
    const entries = runtimeLogState.record(params.uri, {
      line: params.range.start.line,
      character: params.range.start.character,
      value: params.value,
      severity: params.severity,
    });
    redrawRuntimeLogDecorations(params.uri, entries);
  });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
