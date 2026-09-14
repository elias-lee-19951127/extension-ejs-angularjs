import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { RuntimeLogState, type RuntimeLogEntry } from './runtime-log-state';
import { RuntimeLogViewProvider } from './runtime-log-view';

let client: LanguageClient | undefined;
let runtimeLogStatusBar: vscode.StatusBarItem | undefined;
let runtimeLogDecorationType: vscode.TextEditorDecorationType | undefined;
const runtimeLogState = new RuntimeLogState();
/** Connections this window knows it opened, key -> a human label for the Disconnect picker. */
const runtimeLogConnections = new Map<string, string>();
let runtimeLogView: RuntimeLogViewProvider;

/** No bundled default per OS — Chrome's install location varies too much (edition, Homebrew cask, Flatpak, …). */
function defaultChromeExecutablePath(): string {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return 'google-chrome';
}

function defaultChromeDebugPort(): number {
  return vscode.workspace.getConfiguration('ejsng').get<number>('runtimeLog.chromeDebugPort') ?? 9222;
}

/**
 * Launch Chrome with `--remote-debugging-port` in a throw-away profile (never the user's real
 * one — a debug port on a real profile is a local attacker's way into every logged-in session).
 * Doesn't connect anything itself: the user still hits Connect once the target page has loaded,
 * same as pointing it at a Node `--inspect` process.
 */
function launchChromeDebug(context: vscode.ExtensionContext, port: number): void {
  const configured = vscode.workspace.getConfiguration('ejsng').get<string>('runtimeLog.chromeExecutablePath');
  const execPath = configured?.trim() ? configured.trim() : defaultChromeExecutablePath();
  const userDataDir = path.join(context.globalStorageUri.fsPath, 'chrome-debug-profile');
  try {
    mkdirSync(userDataDir, { recursive: true });
    const child = spawn(
      execPath,
      [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    void vscode.window.showInformationMessage(
      `EJS/NG: opened Chrome with --remote-debugging-port=${port}. Once your page has loaded, Connect to 127.0.0.1:${port}.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `EJS/NG: couldn't launch Chrome at "${execPath}" — ${String(err)}. Set ejsng.runtimeLog.chromeExecutablePath.`,
    );
  }
}

type ConnectRuntimeResult =
  | { status: 'connected'; key: string; port: number }
  | { status: 'choose'; port: number; targets: Array<{ id: string; title: string; url: string; type: string }> }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

function updateRuntimeStatusBar(): void {
  if (!runtimeLogStatusBar) return;
  runtimeLogStatusBar.text =
    runtimeLogConnections.size > 0 ? `EJS/NG Runtime: ${runtimeLogConnections.size} connected` : 'EJS/NG Runtime: off';
  runtimeLogView.refresh();
}

/**
 * Connect to `host:port` and handle every outcome the server can report (connected directly /
 * multiple targets to choose from / nothing found / error) — shared by the Command Palette
 * command and the activity-bar panel's own input field, so there's exactly one place that
 * understands `ConnectRuntimeResult`.
 */
async function connectToRuntime(host: string, port: number): Promise<void> {
  try {
    const result = await client?.sendRequest<ConnectRuntimeResult>('ejsng/connectRuntime', { host, port });
    if (!result) return;
    if (result.status === 'connected') {
      runtimeLogConnections.set(result.key, `${host}:${result.port}`);
      updateRuntimeStatusBar();
    } else if (result.status === 'choose') {
      const picked = await vscode.window.showQuickPick(
        result.targets.map((t) => ({ label: t.title || t.url, description: t.url, target: t })),
        { title: 'EJS/NG: multiple targets found — choose one', placeHolder: 'Pick a target' },
      );
      if (!picked) return;
      const chosen = await client?.sendRequest<ConnectRuntimeResult>('ejsng/connectRuntimeTarget', {
        host,
        port: result.port,
        targetId: picked.target.id,
      });
      if (chosen?.status === 'connected') {
        runtimeLogConnections.set(chosen.key, `${host}:${chosen.port} — ${picked.label}`);
        updateRuntimeStatusBar();
      } else {
        void vscode.window.showErrorMessage(`EJS/NG: ${chosen?.status === 'error' ? chosen.message : 'failed to connect.'}`);
      }
    } else if (result.status === 'not-found') {
      void vscode.window.showWarningMessage(`EJS/NG: no connectable target found at ${host}:${port}.`);
    } else {
      void vscode.window.showErrorMessage(`EJS/NG: ${result.message}`);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`EJS/NG: failed to connect to runtime — ${String(err)}`);
  }
}

/** Parse the free-text `host:port` field (Command Palette input box or the panel's own field). */
function parseHostPort(input: string): { host: string; port: number } | null {
  const [host, portText] = input.split(':');
  const port = Number(portText);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

async function disconnectRuntime(): Promise<void> {
  if (runtimeLogConnections.size === 0) {
    void vscode.window.showInformationMessage('EJS/NG: no active runtime connections.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    [...runtimeLogConnections.entries()].map(([key, label]) => ({ label, description: key, key })),
    { title: 'EJS/NG: disconnect which runtime connection?', placeHolder: 'Pick a connection to disconnect' },
  );
  if (!picked) return;
  await client?.sendRequest('ejsng/disconnectRuntime', { key: picked.key });
  runtimeLogConnections.delete(picked.key);
  updateRuntimeStatusBar();
}

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
      runtimeLog: { pathMappings: cfg.get('runtimeLog.pathMappings') },
    },
  };

  client = new LanguageClient('ejsng', 'EJS + AngularJS Navigator', serverOptions, clientOptions);

  runtimeLogView = new RuntimeLogViewProvider(() => runtimeLogConnections.size, defaultChromeDebugPort, {
    connect: (hostPort) => {
      const parsed = parseHostPort(hostPort);
      if (!parsed) {
        void vscode.window.showErrorMessage(`EJS/NG: "${hostPort}" isn't host:port — try something like 127.0.0.1:5000.`);
        return;
      }
      void connectToRuntime(parsed.host, parsed.port);
    },
    disconnect: () => void disconnectRuntime(),
    launchChromeDebug: (port) => launchChromeDebug(context, port),
    openSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', 'ejsng.runtimeLog'),
  });

  runtimeLogDecorationType = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 1.5em', fontWeight: 'bold' },
  });
  runtimeLogStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  runtimeLogStatusBar.text = 'EJS/NG Runtime: off';
  runtimeLogStatusBar.show();

  context.subscriptions.push(
    runtimeLogDecorationType,
    runtimeLogStatusBar,
    vscode.window.registerWebviewViewProvider('ejsngRuntimeView', runtimeLogView),
    vscode.commands.registerCommand('ejsng.reindex', async () => {
      const r = await client?.sendRequest('ejsng/reindex');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
    vscode.commands.registerCommand('ejsng.showStats', async () => {
      const r = await client?.sendRequest('ejsng/stats');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
    vscode.commands.registerCommand('ejsng.connectRuntime', async () => {
      const input = await vscode.window.showInputBox({
        title: 'EJS/NG: Connect to Runtime',
        prompt: "Your app's port (we'll enable its inspector automatically), or a debug port directly",
        placeHolder: '127.0.0.1:5000',
      });
      if (!input) return;
      const parsed = parseHostPort(input);
      if (!parsed) {
        void vscode.window.showErrorMessage(`EJS/NG: "${input}" isn't host:port — try something like 127.0.0.1:5000.`);
        return;
      }
      await connectToRuntime(parsed.host, parsed.port);
    }),
    vscode.commands.registerCommand('ejsng.disconnectRuntime', disconnectRuntime),
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
