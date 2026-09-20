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
  formatRuntimeLogHistory,
  formatRuntimeLogHoverTitle,
  formatRuntimeLogInline,
  formatRuntimeStatusBarText,
  mappingForSettings,
  orderByLastAppPort,
  RuntimeLogState,
  summarizeRuntimeStatus,
  type RuntimeChecklistFix,
  type RuntimeChecklistStep,
  type RuntimeLogEntry,
  type RuntimeLogLine,
  type RuntimeStatusConnection,
  type RuntimeStatusSummary,
} from './runtime-log-state';
import { logpointsFrom } from './logpoints';
import { fileNameOf, parseLogVariableArgs, planLogVariable } from './log-variable';
import { RuntimeLogViewProvider } from './runtime-log-view';
import {
  appUrlForPort,
  browserLaunchArgs,
  chooseAppPort,
  launchRouteFor,
  parseAppAddress,
  type AppPortSource,
} from './browser-locator';
import { browserProfileDir, locateBrowser, spawnBrowser } from './browser-launch';

let client: LanguageClient | undefined;
let runtimeLogStatusBar: vscode.StatusBarItem | undefined;
let runtimeLogDecorationType: vscode.TextEditorDecorationType | undefined;
const runtimeLogState = new RuntimeLogState();
/** Connections this window knows it opened, key -> a human label for the Disconnect picker. */
const runtimeLogConnections = new Map<string, string>();
let runtimeLogView: RuntimeLogViewProvider;
/** The last snapshot fetched via `ejsng/runtimeStatus` — see refreshRuntimeStatus. */
let runtimeStatusSummary: RuntimeStatusSummary = summarizeRuntimeStatus([]);
/** The last checklist fetched via `ejsng/runtimeChecklist` (ticket 09). */
let runtimeChecklistSteps: RuntimeChecklistStep[] = [];
let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Ticket 09, decision #12: choices that belong to THIS machine live in `workspaceState`, never in
 * settings a team commits — the app port picked from the container list, the browser Launch
 * used, and the last target that connected.
 */
const STATE_LAST_APP_PORT = 'ejsng.runtimeLog.lastAppPort';
const STATE_BROWSER = 'ejsng.runtimeLog.browser';
const STATE_LAST_TARGET = 'ejsng.runtimeLog.lastTarget';

function rememberLastTarget(host: string, port: number): void {
  void extensionContext?.workspaceState.update(STATE_LAST_TARGET, { host, port });
}

function defaultChromeDebugPort(): number {
  return vscode.workspace.getConfiguration('ejsng').get<number>('runtimeLog.chromeDebugPort') ?? 9222;
}

/** Duplicated from packages/core on purpose: the client bundle does not pull in core. */
const WSL_MIRRORED_GUIDE_URL = 'https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking';
/** Where the browser's debug port is reached from here — its own loopback, or Windows' through WSL mirrored networking. */
const BROWSER_DEBUG_HOST = '127.0.0.1';
const BROWSER_POLL_MS = 1000;
/** Nothing answering on the debug port by then means it won't: a browser starts in a few seconds. */
const BROWSER_UNREACHABLE_GIVE_UP_MS = 20_000;
/** Long enough to sign in (Keycloak) before the app's own tab exists. */
const BROWSER_APP_TAB_TIMEOUT_MS = 180_000;

type FindBrowserTargetResult =
  | { status: 'found'; targetId: string; url: string }
  | { status: 'waiting'; urls: string[] }
  | { status: 'unreachable'; message: string };

/** A tab URL safe to show in a notification: a login redirect's query string can carry tokens. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Ticket 10, checklist item 4: the URL Launch opens — inferred from the app ports Docker
 * containers publish, asked once when there are several (or none), and remembered for this
 * workspace in `workspaceState`.
 */
async function chooseAppUrl(context: vscode.ExtensionContext): Promise<string | null> {
  let containers: AppPortSource[] = [];
  try {
    containers = (await client?.sendRequest<{ containers: AppPortSource[] }>('ejsng/listDockerContainers'))?.containers ?? [];
  } catch {
    // No Docker, or the server couldn't ask it — the user is asked below instead.
  }
  const remembered = context.workspaceState.get<number>(STATE_LAST_APP_PORT);
  const choice = chooseAppPort(containers, remembered);
  if (choice.kind === 'use') {
    await context.workspaceState.update(STATE_LAST_APP_PORT, choice.port);
    return appUrlForPort(choice.port);
  }
  if (choice.kind === 'ask') {
    const picked = await vscode.window.showQuickPick(
      choice.options.map((o) => ({ label: o.label, description: appUrlForPort(o.port), port: o.port })),
      { title: 'EJS/NG: which app should the browser open?', placeHolder: 'Remembered for this workspace' },
    );
    if (!picked) return null;
    await context.workspaceState.update(STATE_LAST_APP_PORT, picked.port);
    return appUrlForPort(picked.port);
  }
  const input = await vscode.window.showInputBox({
    title: 'EJS/NG: Launch browser',
    prompt: "Your app's port or URL (no Docker container to infer it from)",
    placeHolder: '5000 or http://localhost:5000/',
    value: remembered !== undefined ? String(remembered) : '',
    validateInput: (v) => (parseAppAddress(v) ? null : 'Enter a port like 5000, or a URL like http://localhost:5000/'),
  });
  const parsed = input ? parseAppAddress(input) : null;
  if (!parsed) return null;
  if (parsed.port !== null) await context.workspaceState.update(STATE_LAST_APP_PORT, parsed.port);
  return parsed.url;
}

function warnWslMirrored(message: string): void {
  void vscode.window.showWarningMessage(message, 'Open mirrored networking guide').then((choice) => {
    if (choice) void vscode.env.openExternal(vscode.Uri.parse(WSL_MIRRORED_GUIDE_URL));
  });
}

/**
 * Ticket 10 (.scratch/runtime-remote-env/issues/10-launch-trinh-duyet-phia-ui.md): open the app in
 * a browser on the USER's side with a debug port, then connect to the app's tab by itself.
 *
 * - Locally the browser is spawned directly; under Remote-WSL the Windows executable is started
 *   through interop, with a Windows `--user-data-dir` (a `/home/...` path means nothing to
 *   `chrome.exe`). SSH and containers have no way to reach the user's machine from here yet.
 * - The profile is dedicated and persistent: logins survive between launches, and the user's real
 *   profile is never used — Chrome 136+ ignores the debug port there, and it would expose every
 *   signed-in session.
 * - Under WSL NAT the browser still opens, but the extension says straight away that it cannot
 *   reach the debug port from WSL, and how to switch to mirrored.
 */
async function launchBrowser(context: vscode.ExtensionContext, debugPort: number): Promise<void> {
  const route = launchRouteFor(vscode.env.remoteName);
  if (route === 'unsupported') {
    void vscode.window.showWarningMessage(
      `EJS/NG: Launch can't start a browser on your machine from a ${vscode.env.remoteName} window yet. ` +
        `Start Chrome yourself with --remote-debugging-port=${debugPort} and its own --user-data-dir, then connect under Advanced. Node logs work as usual.`,
    );
    return;
  }
  const wsl = route === 'wsl-interop';

  const appUrl = await chooseAppUrl(context);
  if (!appUrl) return;

  const configured = vscode.workspace.getConfiguration('ejsng').get<string>('runtimeLog.chromeExecutablePath') ?? '';
  const located = await locateBrowser(configured, wsl);
  if (!located.browser) {
    const message = located.configuredMissing
      ? `EJS/NG: ejsng.runtimeLog.chromeExecutablePath points at "${located.tried[0]}", which doesn't exist.`
      : `EJS/NG: no Chrome, Edge or Brave found${wsl ? ' on Windows' : ''}. Set ejsng.runtimeLog.chromeExecutablePath.`;
    void vscode.window.showErrorMessage(message, 'Open Settings').then((choice) => {
      if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'ejsng.runtimeLog.chromeExecutablePath');
    });
    return;
  }
  const { browser } = located;

  const localProfile = path.join(context.globalStorageUri.fsPath, 'chrome-debug-profile');
  if (!wsl) mkdirSync(localProfile, { recursive: true });
  const profile = await browserProfileDir(wsl, localProfile);
  if (!profile) {
    void vscode.window.showErrorMessage('EJS/NG: could not find %LOCALAPPDATA% on Windows for the browser profile.');
    return;
  }

  try {
    await spawnBrowser(browser, browserLaunchArgs({ debugPort, userDataDir: profile, url: appUrl }));
  } catch (err) {
    void vscode.window.showErrorMessage(`EJS/NG: couldn't start ${browser.displayPath} — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // Per machine, never in settings (decision #12) — shown in the checklist and the report.
  await context.workspaceState.update(STATE_BROWSER, browser.displayPath);

  if (wsl) {
    let networking: string | null = null;
    try {
      networking = (await client?.sendRequest<{ wslNetworking: string | null }>('ejsng/detectRuntimeEnvironment'))?.wslNetworking ?? null;
    } catch {
      // Unknown: fall through and find out by probing.
    }
    void refreshRuntimeStatus();
    if (networking === 'nat') {
      warnWslMirrored(
        `EJS/NG: opened ${appUrl} in ${browser.displayPath}, but WSL uses NAT networking, so the extension can't reach the browser's debug port. ` +
          'Switch WSL to networkingMode=mirrored for browser logs.',
      );
      return;
    }
  }
  await connectWhenAppTabLoads(debugPort, appUrl, wsl);
}

/**
 * Ticket 10, checklist item 5: poll the browser's debug endpoint until the app's own tab exists,
 * then connect to it — no second Connect click. Polled from here, one probe per request, so the
 * wait is cancellable and a slow login holds nothing open on the server.
 */
async function connectWhenAppTabLoads(debugPort: number, appUrl: string, wsl: boolean): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `EJS/NG: waiting for ${appUrl} to load`, cancellable: true },
    async (progress, token) => {
      const startedAt = Date.now();
      let reachable = false;
      while (!token.isCancellationRequested) {
        const result = await client
          ?.sendRequest<FindBrowserTargetResult>('ejsng/findBrowserTarget', { host: BROWSER_DEBUG_HOST, port: debugPort, appUrl })
          .catch(() => null);
        if (result?.status === 'found') {
          const chosen = await client?.sendRequest<ConnectRuntimeResult>('ejsng/connectRuntimeTarget', {
            host: BROWSER_DEBUG_HOST,
            port: debugPort,
            targetId: result.targetId,
          });
          if (chosen?.status === 'connected') {
            runtimeLogConnections.set(chosen.key, `${BROWSER_DEBUG_HOST}:${debugPort} — ${displayUrl(result.url)}`);
            updateRuntimeStatusBar();
            void refreshRuntimeStatus();
          } else {
            void vscode.window.showErrorMessage(`EJS/NG: ${chosen?.status === 'error' ? chosen.message : 'failed to connect to the browser tab.'}`);
          }
          return;
        }
        if (result?.status === 'waiting') {
          reachable = true;
          progress.report({ message: result.urls.length > 0 ? `tab is on ${displayUrl(result.urls[0]!)}` : 'no tab yet' });
        }
        const elapsed = Date.now() - startedAt;
        if (!reachable && elapsed > BROWSER_UNREACHABLE_GIVE_UP_MS) {
          const where = `${BROWSER_DEBUG_HOST}:${debugPort}`;
          if (wsl) {
            warnWslMirrored(`EJS/NG: can't reach the browser's debug port ${where} from WSL. If WSL uses NAT networking, switch to mirrored.`);
          } else {
            void vscode.window.showWarningMessage(
              `EJS/NG: the browser never opened its debug port ${where}. If that profile was already open without it, close the window and Launch again.`,
            );
          }
          return;
        }
        if (elapsed > BROWSER_APP_TAB_TIMEOUT_MS) {
          void vscode.window.showWarningMessage(`EJS/NG: no tab showed ${appUrl} in time. Open it in the launched browser, then Launch again.`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, BROWSER_POLL_MS));
      }
    },
  );
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
  const [result, checklist] = await Promise.all([
    client?.sendRequest<{ connections: RuntimeStatusConnection[] }>('ejsng/runtimeStatus'),
    client?.sendRequest<{ steps: RuntimeChecklistStep[] }>('ejsng/runtimeChecklist', {
      browser: extensionContext?.workspaceState.get<string>(STATE_BROWSER) ?? null,
    }),
  ]);
  runtimeStatusSummary = summarizeRuntimeStatus(result?.connections ?? []);
  runtimeChecklistSteps = checklist?.steps ?? runtimeChecklistSteps;
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
      rememberLastTarget(host, result.port);
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
        rememberLastTarget(host, result.port);
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
async function skipFramesIn(path: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ejsng');
  const current = cfg.get<string[]>('runtimeLog.skipFrames') ?? [];
  const pattern = `**/${escapeGlobPath(path)}`;
  if (current.includes(pattern)) return;
  await cfg.update('runtimeLog.skipFrames', [...current, pattern], vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(
    `EJS/NG: added "${pattern}" to ejsng.runtimeLog.skipFrames. Reload the window for it to take effect.`,
  );
}

/**
 * The panel worked out that `remote` is `local` on this machine — from a container mount (ticket
 * 05) or by matching the tail of a browser URL (ticket 07) — and the user clicked Save. Until
 * this click the mapping lives only for the duration of the connection (decision #12: an inferred
 * mapping is never saved on its own). Where it is written: see `mappingForSettings`.
 */
async function saveMapping(remote: string, local: string): Promise<void> {
  const { mapping, target } = mappingForSettings(remote, local, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  const cfg = vscode.workspace.getConfiguration('ejsng');
  const current = cfg.get<Array<{ remote: string; local: string }>>('runtimeLog.pathMappings') ?? [];
  if (current.some((m) => m.remote === mapping.remote && m.local === mapping.local)) return;
  await cfg.update(
    'runtimeLog.pathMappings',
    [...current, mapping],
    target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
  );
  void vscode.window.showInformationMessage(
    `EJS/NG: saved "${mapping.remote}" -> "${mapping.local}" to ejsng.runtimeLog.pathMappings. Reload the window for it to take effect.`,
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
  /** Absent from a server older than ticket 09. */
  appPorts?: number[];
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
      rememberLastTarget(result.host, result.port);
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
        rememberLastTarget(result.host, result.port);
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
      // Ticket 09: the container whose app port was picked last time on this machine comes first.
      const lastAppPort = extensionContext?.workspaceState.get<number>(STATE_LAST_APP_PORT);
      const picked = await vscode.window.showQuickPick(
        orderByLastAppPort(result.candidates, lastAppPort).map((c) => ({
          label: c.label,
          description: `${c.host}:${c.port}${c.lastUsed ? ' — last used' : ''}`,
          candidate: c,
        })),
        { title: 'EJS/NG: multiple Docker containers found — choose one', placeHolder: 'Pick a container' },
      );
      if (!picked) return;
      const appPort = picked.candidate.appPorts?.[0];
      if (appPort !== undefined) void extensionContext?.workspaceState.update(STATE_LAST_APP_PORT, appPort);
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

/**
 * Ticket 09: the big Connect button runs the whole chain — environment → Docker → target →
 * mapping → connect — refreshing the checklist after each link so the panel shows where it
 * stopped. Mapping needs no call of its own: the server infers it from the connected
 * container's mounts. Only ever runs on a click (user story #38: opening a workspace never
 * connects anything).
 */
async function runConnectChain(): Promise<void> {
  try {
    await client?.sendRequest('ejsng/detectRuntimeEnvironment');
  } catch (err) {
    void vscode.window.showErrorMessage(`EJS/NG: could not detect the environment — ${String(err)}`);
  }
  await refreshRuntimeStatus();
  await discoverDockerRuntime(undefined, async () => {
    // No Docker target: the pre-Docker flow, starting from whatever connected last time here.
    const last = extensionContext?.workspaceState.get<{ host: string; port: number }>(STATE_LAST_TARGET);
    if (last) {
      await connectToRuntime(last.host, last.port);
      return;
    }
    void vscode.window.showWarningMessage(
      'EJS/NG: no Docker container with an inspector found — see the checklist, or enter host:port under Advanced.',
    );
  });
  await refreshRuntimeStatus();
}

/** Ticket 09: a fix button on a checklist step. Each one acts only because the user clicked it. */
async function applyChecklistFix(fix: RuntimeChecklistFix): Promise<void> {
  switch (fix.kind) {
    case 'save-mapping':
      return saveMapping(fix.remote, fix.local);
    case 'skip-frame':
      return skipFramesIn(fix.path);
    case 'add-folder':
      return addFolderToWorkspace(fix.path);
    case 'copy-compose':
      // Decision #3: shown and copied, never applied — the extension does not edit compose files.
      await vscode.env.clipboard.writeText(fix.snippet);
      void vscode.window.showInformationMessage('EJS/NG: compose snippet copied. Merge it into your compose file, then recreate the container.');
      return;
    case 'open-mirrored-guide':
      // Decision #2: the extension never edits .wslconfig itself.
      await vscode.env.openExternal(vscode.Uri.parse(fix.url));
      return;
    case 'open-settings':
      await vscode.commands.executeCommand('workbench.action.openSettings', fix.query);
      return;
  }
}

/**
 * Ticket 09: "Copy report" — markdown built by the server, home directory already replaced by
 * `~`. It goes to the clipboard and nowhere else (user story #37).
 */
async function copyRuntimeReport(): Promise<void> {
  try {
    const result = await client?.sendRequest<{ markdown: string }>('ejsng/runtimeReport', {
      browser: extensionContext?.workspaceState.get<string>(STATE_BROWSER) ?? null,
      version: extensionContext?.extension.packageJSON?.version as string | undefined,
    });
    if (!result) return;
    await vscode.env.clipboard.writeText(result.markdown);
    void vscode.window.showInformationMessage('EJS/NG: report copied to the clipboard. Nothing was sent anywhere.');
  } catch (err) {
    void vscode.window.showErrorMessage(`EJS/NG: could not build the report — ${String(err)}`);
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
  source?: string;
  endpoint?: string;
}

/** ANSI theme colors so the decoration matches the severity at a glance, in any color theme. */
const SEVERITY_COLOR: Record<RuntimeLogEntry['severity'], string> = {
  log: 'terminal.ansiGreen',
  warning: 'terminal.ansiYellow',
  error: 'terminal.ansiRed',
};

/** The hover for one line: where the latest value came from, the value in full, then the earlier ones. */
function runtimeLogHover(line: RuntimeLogLine): vscode.MarkdownString {
  const latest = line.history[0]!;
  const md = new vscode.MarkdownString().appendText(formatRuntimeLogHoverTitle(latest)).appendCodeblock(latest.value, 'text');
  const earlier = formatRuntimeLogHistory(line);
  if (earlier.length > 0) {
    md.appendMarkdown(`\n\n**${line.count} hits** — earlier, most recent first:\n\n`);
    for (const item of earlier) md.appendMarkdown('- ').appendText(item).appendMarkdown('\n');
  }
  return md;
}

function redrawRuntimeLogDecorations(uri: string): void {
  if (!runtimeLogDecorationType) return;
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
  if (!editor) return;
  const lines = runtimeLogState.linesFor(uri).filter((l) => l.line < editor.document.lineCount);
  const options: vscode.DecorationOptions[] = lines.map((l) => {
    const e = l.history[0]!;
    // Anchor at the END of the line, not the exact call-site column — the column can land
    // mid-expression (e.g. inside `console.log(...)`), which reads as broken, not inline.
    // The range spans the whole line so hovering anywhere on it shows where the value came from;
    // the `after` text still renders at the range's end, i.e. the end of the line.
    const line = editor.document.lineAt(e.line);
    return {
      range: new vscode.Range(line.range.start, line.range.end),
      hoverMessage: runtimeLogHover(l),
      renderOptions: {
        after: { contentText: formatRuntimeLogInline(l), color: new vscode.ThemeColor(SEVERITY_COLOR[e.severity]) },
      },
    };
  });
  editor.setDecorations(runtimeLogDecorationType, options);
  renderedDecorations.set(
    uri,
    options.map((o) => ({ line: o.range.start.line, text: o.renderOptions?.after?.contentText ?? '' })),
  );
  renderedHovers.set(
    uri,
    lines.map((l) => ({ line: l.line, title: formatRuntimeLogHoverTitle(l.history[0]!), history: formatRuntimeLogHistory(l) })),
  );
}

/** The hover last drawn per line, per file — like `renderedDecorations`, for tests only. */
const renderedHovers = new Map<string, Array<{ line: number; title: string; history: string[] }>>();

/**
 * What was last handed to `setDecorations`, per file — VS Code offers no API to read decorations
 * back, so this is the only way an automated test can see them (ticket 11).
 */
const renderedDecorations = new Map<string, Array<{ line: number; text: string }>>();

/**
 * Ticket 11 (.scratch/runtime-remote-env/issues/11-test-tu-dong-client.md): read-only views of
 * UI state that VS Code's API cannot report — decorations, the status bar text, what the panel
 * was last sent. Returned from `activate` only when `EJSNG_EXTENSION_TEST=1`, which the
 * `@vscode/test-electron` runner sets; the published extension exports nothing.
 */
export interface EjsngTestApi {
  decorations(uri: string): Array<{ line: number; text: string }>;
  /** The first line of each drawn log's hover — its source, severity and time. */
  hovers(uri: string): Array<{ line: number; title: string; history: string[] }>;
  statusBarText(): string;
  /** The last `status` message posted to the panel's webview, or `undefined` if it never resolved. */
  panelState(): unknown;
  checklist(): RuntimeChecklistStep[];
  /** Connection keys this window holds, as the Disconnect picker lists them. */
  connectionKeys(): string[];
  /** Fetch status and checklist now instead of waiting for the next poll. */
  refreshRuntimeStatus(): Promise<void>;
}

const testApi: EjsngTestApi = {
  decorations: (uri) => renderedDecorations.get(uri) ?? [],
  hovers: (uri) => renderedHovers.get(uri) ?? [],
  statusBarText: () => runtimeLogStatusBar?.text ?? '',
  panelState: () => runtimeLogView.lastPostedStatus,
  checklist: () => runtimeChecklistSteps,
  connectionKeys: () => [...runtimeLogConnections.keys()],
  refreshRuntimeStatus: () => refreshRuntimeStatus(),
};

export async function activate(context: vscode.ExtensionContext): Promise<EjsngTestApi | undefined> {
  extensionContext = context;
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
    // The hover's "Log at runtime" link (.scratch/log-variable/spec.md #9): trusted for exactly
    // this one command, nothing else a hover's markdown could name.
    markdown: { isTrusted: { enabledCommands: [LOG_VARIABLE_COMMAND] } },
    initializationOptions: {
      // Tells the server it may put that link in hovers — a client that can't run it gets none.
      commands: [LOG_VARIABLE_COMMAND],
      include: cfg.get('include'),
      exclude: cfg.get('exclude'),
      moduleAliases: cfg.get('moduleAliases'),
      ejsDelimiter: cfg.get('ejsDelimiter'),
      customDirectives: cfg.get('customDirectives'),
      templateRoots: cfg.get('templateRoots'),
      expressViewsDir: cfg.get('expressViewsDir'),
      diagnostics: { enabled: cfg.get('diagnostics.enabled') },
      typeHints: { nullable: cfg.get('typeHints.nullable') },
      runtimeLog: {
        expandValues: cfg.get('runtimeLog.expandValues'),
        pathMappings: cfg.get('runtimeLog.pathMappings'),
        skipFrames: cfg.get('runtimeLog.skipFrames'),
        // Ticket 09, decision #15: only the client knows where it runs; the server never guesses.
        // The UI's own OS is only certain locally, and for WSL, which exists only on Windows.
        environment: {
          remoteName: vscode.env.remoteName ?? null,
          clientPlatform: vscode.env.remoteName === undefined ? process.platform : vscode.env.remoteName === 'wsl' ? 'win32' : null,
        },
      },
    },
  };

  client = new LanguageClient('ejsng', 'EJS + AngularJS Navigator', serverOptions, clientOptions);

  runtimeLogView = new RuntimeLogViewProvider(
    () => runtimeLogConnections.size,
    defaultChromeDebugPort,
    () => runtimeStatusSummary,
    () => runtimeChecklistSteps,
    {
      connectAuto: () => void runConnectChain(),
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
      launchBrowser: (port) => void launchBrowser(context, port),
      openSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', 'ejsng.runtimeLog'),
      applyFix: (fix) => void applyChecklistFix(fix),
      copyReport: () => void copyRuntimeReport(),
    },
  );

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
    vscode.commands.registerCommand(LOG_VARIABLE_COMMAND, logVariable),
    vscode.commands.registerCommand('ejsng.launchBrowser', () => launchBrowser(context, defaultChromeDebugPort())),
    // A split/reopened editor for a file with existing hits starts undecorated otherwise.
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        const uri = editor.document.uri.toString();
        if (runtimeLogState.linesFor(uri).length) redrawRuntimeLogDecorations(uri);
      }
    }),
    // Ticket 05: keep each line's history on its code while the file is edited. Changes are
    // applied bottom-up so each range still refers to the text as it was before the edit.
    vscode.workspace.onDidChangeTextDocument((e) => {
      const uri = e.document.uri.toString();
      if (runtimeLogState.linesFor(uri).length === 0) return;
      let changed = false;
      const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
      for (const c of changes) {
        changed = runtimeLogState.applyEdit(uri, c.range.start.line, c.range.end.line, c.text.split('\n').length) || changed;
      }
      if (changed) redrawRuntimeLogDecorations(uri);
    }),
  );

  await client.start();
  // Shows the checklist's "not checked yet" state. A plain request to the server — nothing is
  // probed and nothing connects until the user presses Connect (user story #38).
  void refreshRuntimeStatus();

  client.onNotification('ejsng/runtimeLog', (params: RuntimeLogNotification) => {
    runtimeLogState.record(params.uri, {
      line: params.range.start.line,
      character: params.range.start.character,
      value: params.value,
      severity: params.severity,
      source: params.source,
      at: Date.now(),
      ...(params.endpoint ? { endpoint: params.endpoint } : {}),
    });
    redrawRuntimeLogDecorations(params.uri);
  });

  // The REAL connecting -> connected/failed transition (ticket 02, item 4) — pushed so the
  // status bar/panel don't have to wait for the next poll tick to stop lying about a connection
  // that's still `connecting` or has already `failed`.
  client.onNotification('ejsng/runtimeStatusChanged', (params: { state?: string; endpoint?: string }) => {
    // Ticket 05: an endpoint that (re)connects is a new run of the app — what it logged before no
    // longer describes it. Reset on connect rather than on the drop, so the last values before a
    // crash stay readable until the app is back.
    if (params.state === 'connected' && params.endpoint) {
      for (const uri of runtimeLogState.resetEndpoint(params.endpoint)) redrawRuntimeLogDecorations(uri);
    }
    void refreshRuntimeStatus();
  });

  // Inline logpoints (.scratch/inline-logpoints/spec.md): the server sets VS Code's logpoints on the
  // runtime itself, so they work without a VS Code debug session. Always the whole list — the
  // server replaces what it had rather than applying a diff.
  const sendLogpoints = (): void => {
    const enabled = vscode.workspace.getConfiguration('ejsng').get<boolean>('runtimeLog.logpoints', true);
    void client?.sendNotification('ejsng/setLogpoints', { logpoints: logpointsFrom(vscode.debug.breakpoints, enabled) });
  };
  sendLogpoints();
  context.subscriptions.push(
    vscode.debug.onDidChangeBreakpoints(sendLogpoints),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ejsng.runtimeLog.logpoints')) sendLogpoints();
    }),
  );

  return process.env.EJSNG_EXTENSION_TEST === '1' ? testApi : undefined;
}

const LOG_VARIABLE_COMMAND = 'ejsng.logVariable';

/**
 * `ejsng.logVariable` — the hover's "Log at runtime" link (.scratch/log-variable/spec.md): an
 * ordinary VS Code logpoint right after an assignment the index couldn't type. The usual logpoint
 * sync then sends it to the server; the value it logs becomes the hover's type (R1).
 */
function logVariable(raw: unknown): void {
  const args = parseLogVariableArgs(raw);
  if (!args) return;
  const location = new vscode.Location(vscode.Uri.parse(args.uri), new vscode.Position(args.line, args.character));
  const where = `${fileNameOf(args.uri)}:${args.line + 1}`;
  const plan = planLogVariable(args, vscode.debug.breakpoints as readonly vscode.SourceBreakpoint[]);
  if (plan.kind === 'exists') {
    void vscode.window.showInformationMessage(
      plan.sameMessage
        ? `EJS/NG: \`${args.expression}\` is already logged after ${where}.`
        : `EJS/NG: there is already a breakpoint after ${where} — left as it is.`,
    );
    return;
  }
  if (plan.kind === 'enable') vscode.debug.removeBreakpoints([vscode.debug.breakpoints[plan.index]!]);
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, undefined, undefined, args.logMessage)]);

  // Not awaited: the command is done once the logpoint is set, not when the message is dismissed.
  if (!vscode.workspace.getConfiguration('ejsng').get<boolean>('runtimeLog.logpoints', true)) {
    const open = 'Open Setting';
    void vscode.window
      .showWarningMessage(`EJS/NG: logpoint added after ${where}, but logpoints are turned off (ejsng.runtimeLog.logpoints), so it won't run.`, open)
      .then((choice) => (choice === open ? vscode.commands.executeCommand('workbench.action.openSettings', 'ejsng.runtimeLog.logpoints') : undefined));
    return;
  }
  const connect = 'Connect Runtime';
  const show = 'Show';
  void vscode.window
    .showInformationMessage(
      `EJS/NG: logging \`${args.expression}\` after ${where} — hover again once that line runs.`,
      ...(runtimeLogConnections.size === 0 ? [connect] : []),
      show,
    )
    .then((choice) => {
      if (choice === connect) return vscode.commands.executeCommand('ejsng.connectRuntime');
      if (choice === show) return vscode.window.showTextDocument(location.uri, { selection: location.range, preview: true });
      return undefined;
    });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
