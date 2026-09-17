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
import {
  escapeGlobPath,
  formatRuntimeStatusBarText,
  RuntimeLogState,
  summarizeRuntimeStatus,
  type RuntimeLogEntry,
  type RuntimeStatusConnection,
  type RuntimeStatusSummary,
} from './runtime-log-state';
import { RuntimeLogViewProvider } from './runtime-log-view';

let client: LanguageClient | undefined;
let runtimeLogStatusBar: vscode.StatusBarItem | undefined;
let runtimeLogDecorationType: vscode.TextEditorDecorationType | undefined;
const runtimeLogState = new RuntimeLogState();
/** Connections this window knows it opened, key -> a human label for the Disconnect picker. */
const runtimeLogConnections = new Map<string, string>();
let runtimeLogView: RuntimeLogViewProvider;
/** The last snapshot fetched via `ejsng/runtimeStatus` — see refreshRuntimeStatus. */
let runtimeStatusSummary: RuntimeStatusSummary = summarizeRuntimeStatus([]);

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
  runtimeLogStatusBar.text = formatRuntimeStatusBarText(runtimeLogConnections.size, runtimeStatusSummary);
  runtimeLogView.refresh();
}

/**
 * Ask the server for every connection's REAL state and received/drawn/dropped-by-reason counts
 * (ticket 02, item 4) and refresh the status bar/panel from it. `ejsng/connectRuntime` itself
 * keeps reporting 'connected' synchronously the instant discovery succeeds, for backward
 * compatibility (ticket 02, item 5) — this is the only place that sees the TRUE lifecycle.
 */
async function refreshRuntimeStatus(): Promise<void> {
  const result = await client?.sendRequest<{ connections: RuntimeStatusConnection[] }>('ejsng/runtimeStatus');
  runtimeStatusSummary = summarizeRuntimeStatus(result?.connections ?? []);
  updateRuntimeStatusBar();
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
      void refreshRuntimeStatus();
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
        void refreshRuntimeStatus();
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

/**
 * Ticket 03, item 7: the panel suggested `path` (workspace-relative) as a likely logging wrapper
 * — the user clicked "Skip this file", so add it to `ejsng.runtimeLog.skipFrames`. NEVER done
 * automatically — this is the only place that writes to this setting. Written as `**\/<path>` so
 * it matches regardless of the absolute prefix the runtime happens to report the file under
 * (container path, host path, …) — see `matchesSkipPattern` in packages/core.
 */
async function acceptWrapperSuggestion(path: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ejsng');
  const current = cfg.get<string[]>('runtimeLog.skipFrames') ?? [];
  const pattern = `**/${escapeGlobPath(path)}`;
  if (current.includes(pattern)) return;
  await cfg.update('runtimeLog.skipFrames', [...current, pattern], vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(
    `EJS/NG: added "${pattern}" to ejsng.runtimeLog.skipFrames. Reconnect (or reload) for it to take effect.`,
  );
}

/**
 * Ticket 08, item 4: the panel found logs being drawn in `path`, a directory outside the
 * workspace (with nested mounts, the repo the runtime is really running often isn't the one that
 * is open), and the user clicked "Add to workspace". This is the ONLY place a folder is added —
 * never automatically, since adding one restarts the extension host.
 */
function addFolderToWorkspace(path: string): void {
  const uri = vscode.Uri.file(path);
  if (vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === path)) return;
  const added = vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, null, { uri });
  if (!added) void vscode.window.showErrorMessage(`EJS/NG: could not add ${path} to the workspace.`);
}

/** Parse the free-text `host:port` field (Command Palette input box or the panel's own field). */
function parseHostPort(input: string): { host: string; port: number } | null {
  const [host, portText] = input.split(':');
  const port = Number(portText);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

/** One connectable Docker container, as `ejsng/discoverRuntimeTargets` reports it for a Quick Pick. */
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
 * Checklist item 6: a Node container with `--inspect` enabled but no published inspector port is
 * surfaced by name — even when another container connected fine, so it isn't lost just because
 * something else happened to work (see the shape note on `unreachable` in
 * packages/server/src/index.ts's `ejsng/discoverRuntimeTargets` handler).
 */
function warnAboutUnreachableContainers(names: string[]): void {
  if (names.length === 0) return;
  void vscode.window.showWarningMessage(
    `EJS/NG: found Node container(s) with --inspect enabled but no published inspector port — ${names.join(', ')}. ` +
      "Publish it (e.g. \"--inspect=0.0.0.0:9229\" plus a compose port mapping) to connect.",
  );
}

/**
 * Ticket 04 (.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md): "Connect"
 * with nothing typed at all, or with an app port instead of a debug port — tries Docker container
 * discovery FIRST, via the new `ejsng/discoverRuntimeTargets` request, before the user ever has
 * to supply host:port by hand. Kept as its own self-contained function rather than folded into
 * `connectToRuntime` above, so this ticket's addition can't change that function's existing
 * behavior for the plain host:port case at all.
 *
 * Falls through to `fallback` whenever Docker isn't available or found nothing usable for
 * `appPort` — `'no-docker-target'` is never shown as an error (per spec, no Docker is an
 * expected, common case for a local/non-Docker user); `'unreachable-containers'` (checklist item
 * 6: a Node container exists but never published its inspector) is surfaced as a warning first,
 * then still falls through, so the user isn't left with no way to connect at all.
 */
async function discoverDockerRuntime(appPort: number | undefined, fallback: () => void | Promise<void>): Promise<void> {
  try {
    const result = await client?.sendRequest<DiscoverRuntimeTargetsResult>('ejsng/discoverRuntimeTargets', { appPort });
    if (!result || result.status === 'no-docker-target') {
      await fallback();
      return;
    }
    if (result.status === 'connected') {
      warnAboutUnreachableContainers(result.unreachable);
      runtimeLogConnections.set(result.key, `${result.host}:${result.port}`);
      updateRuntimeStatusBar();
      void refreshRuntimeStatus();
      return;
    }
    if (result.status === 'choose') {
      warnAboutUnreachableContainers(result.unreachable);
      // The rare case: exactly one Docker container matched, but IT exposes multiple CDP
      // targets — reuses the existing ejsng/connectRuntimeTarget request unchanged, same as the
      // plain host:port flow's own 'choose' handling in connectToRuntime.
      const picked = await vscode.window.showQuickPick(
        result.targets.map((t) => ({ label: t.title || t.url, description: t.url, target: t })),
        { title: 'EJS/NG: multiple targets found — choose one', placeHolder: 'Pick a target' },
      );
      if (!picked) return;
      const chosen = await client?.sendRequest<ConnectRuntimeResult>('ejsng/connectRuntimeTarget', {
        host: result.host,
        port: result.port,
        targetId: picked.target.id,
      });
      if (chosen?.status === 'connected') {
        runtimeLogConnections.set(chosen.key, `${result.host}:${chosen.port} — ${picked.label}`);
        updateRuntimeStatusBar();
        void refreshRuntimeStatus();
      } else {
        void vscode.window.showErrorMessage(`EJS/NG: ${chosen?.status === 'error' ? chosen.message : 'failed to connect.'}`);
      }
      return;
    }
    if (result.status === 'choose-container') {
      warnAboutUnreachableContainers(result.unreachable);
      // Checklist item 5: multiple Docker containers found — Quick Pick "<container name>: <app
      // port>" (e.g. "cityos-web: 5000"), per the spec's exact phrasing (user story #4).
      const picked = await vscode.window.showQuickPick(
        result.candidates.map((c) => ({ label: c.label, description: `${c.host}:${c.port}`, candidate: c })),
        { title: 'EJS/NG: multiple Docker containers found — choose one', placeHolder: 'Pick a container' },
      );
      if (!picked) return;
      // The chosen candidate's host:port is directly usable with the existing, unchanged
      // ejsng/connectRuntime — no extra request needed for this step.
      await connectToRuntime(picked.candidate.host, picked.candidate.port);
      return;
    }
    if (result.status === 'unreachable-containers') {
      warnAboutUnreachableContainers(result.containers);
      await fallback();
      return;
    }
    void vscode.window.showErrorMessage(`EJS/NG: ${result.message}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`EJS/NG: Docker discovery failed — ${String(err)}`);
    await fallback();
  }
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
  void refreshRuntimeStatus();
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
      runtimeLog: { pathMappings: cfg.get('runtimeLog.pathMappings'), skipFrames: cfg.get('runtimeLog.skipFrames') },
    },
  };

  client = new LanguageClient('ejsng', 'EJS + AngularJS Navigator', serverOptions, clientOptions);

  runtimeLogView = new RuntimeLogViewProvider(() => runtimeLogConnections.size, defaultChromeDebugPort, () => runtimeStatusSummary, {
    // Ticket 04: blank field = "Connect with nothing typed" (Docker discovery only); a bare
    // number with no colon = an app port (Docker discovery first, then the pre-Docker app-port
    // flow via connectToRuntime if Docker doesn't find it); host:port = unchanged, direct connect.
    connect: (hostPort) => {
      const trimmed = hostPort.trim();
      if (!trimmed) {
        void discoverDockerRuntime(undefined, () => {
          void vscode.window.showErrorMessage('EJS/NG: no Docker container found — type a host:port or an app port to connect.');
        });
        return;
      }
      const parsed = parseHostPort(trimmed);
      if (parsed) {
        void connectToRuntime(parsed.host, parsed.port);
        return;
      }
      const appPort = Number(trimmed);
      if (Number.isFinite(appPort)) {
        void discoverDockerRuntime(appPort, () => connectToRuntime('127.0.0.1', appPort));
        return;
      }
      void vscode.window.showErrorMessage(`EJS/NG: "${hostPort}" isn't host:port or a port number — try something like 127.0.0.1:5000 or just 5000.`);
    },
    disconnect: () => void disconnectRuntime(),
    launchChromeDebug: (port) => launchChromeDebug(context, port),
    openSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', 'ejsng.runtimeLog'),
    acceptWrapperSuggestion: (path) => void acceptWrapperSuggestion(path),
    addFolderToWorkspace: (path) => addFolderToWorkspace(path),
  });

  runtimeLogDecorationType = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 1.5em', fontWeight: 'bold' },
  });
  runtimeLogStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  runtimeLogStatusBar.text = 'EJS/NG Runtime: off';
  runtimeLogStatusBar.show();

  // Keeps received/drawn/dropped fresh while logs are actively flowing, independent of the
  // per-transition push below — a no-op (no request sent) whenever there's nothing connected.
  const runtimeStatusPollInterval = setInterval(() => {
    if (runtimeLogConnections.size > 0) void refreshRuntimeStatus();
  }, 2000);

  context.subscriptions.push(
    runtimeLogDecorationType,
    runtimeLogStatusBar,
    new vscode.Disposable(() => clearInterval(runtimeStatusPollInterval)),
    vscode.window.registerWebviewViewProvider('ejsngRuntimeView', runtimeLogView),
    vscode.commands.registerCommand('ejsng.reindex', async () => {
      const r = await client?.sendRequest('ejsng/reindex');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
    vscode.commands.registerCommand('ejsng.showStats', async () => {
      const r = await client?.sendRequest('ejsng/stats');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
    // Ticket 04, user story #1: hitting Connect no longer requires typing host:port up front —
    // Docker discovery runs FIRST, with no app port filter, and the input box (this command's
    // entire old behavior, unchanged) is only a fallback for when Docker isn't available/found
    // nothing to offer.
    vscode.commands.registerCommand('ejsng.connectRuntime', () =>
      discoverDockerRuntime(undefined, async () => {
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
    ),
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

  // The REAL connecting -> connected/failed transition (ticket 02, item 4) — pushed so the
  // status bar/panel don't have to wait for the next poll tick to stop lying about a connection
  // that's still `connecting` or has already `failed`.
  client.onNotification('ejsng/runtimeStatusChanged', () => void refreshRuntimeStatus());
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
