/**
 * Pure decisions behind ticket 10 (.scratch/runtime-remote-env/issues/10-launch-trinh-duyet-phia-ui.md):
 * where a browser on the USER's side may be installed, in what order to look, how to start it,
 * and which app URL to open. No `vscode` import and no IO — the probing and spawning live in
 * browser-launch.ts, so this file can be unit tested without an Extension Host.
 */

export type BrowserKind = 'chrome' | 'edge' | 'brave';

/** Chrome first, then Edge, then Brave (decision #10). */
export const BROWSER_ORDER: readonly BrowserKind[] = ['chrome', 'edge', 'brave'];

export const BROWSER_NAMES: Record<BrowserKind, string> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' };

/**
 * How Launch reaches the user's browser from where this extension runs:
 * - `local` — same machine, spawn directly.
 * - `wsl-interop` — Remote-WSL: the user's browser is on Windows; start the Windows executable
 *   through WSL interop.
 * - `unsupported` — SSH, containers, Codespaces: the browser is on another machine with no way
 *   to start it from here (the UI-side companion of ticket 12).
 */
export type LaunchRoute = 'local' | 'wsl-interop' | 'unsupported';

export function launchRouteFor(remoteName: string | undefined): LaunchRoute {
  if (remoteName === undefined) return 'local';
  if (remoteName === 'wsl') return 'wsl-interop';
  return 'unsupported';
}

// ---------------------------------------------------------------------------------------------
// Windows (native, or through WSL interop)
// ---------------------------------------------------------------------------------------------

const WINDOWS_EXE: Record<BrowserKind, string> = { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe' };

/**
 * The `App Paths` registry keys an installer registers the executable under — per user first,
 * then machine-wide. Asked before any fixed install path (checklist item 1): it is where the
 * browser really is, whatever drive or folder the user installed it to.
 */
export function windowsRegistryKeys(kind: BrowserKind): string[] {
  const appPath = `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${WINDOWS_EXE[kind]}`;
  return [`HKCU\\${appPath}`, `HKLM\\${appPath}`];
}

/**
 * The default value out of `reg.exe query "<key>" /ve`. The value's NAME is localized
 * (`(Default)`, `(既定)`, …), so the line is found by its type column instead.
 */
export function parseRegQueryDefaultValue(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /\sREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

/** Windows known folders the fixed install paths hang off. Any may be missing. */
export interface WindowsFolders {
  programFiles?: string;
  programFilesX86?: string;
  localAppData?: string;
}

/** Where each browser's installer puts it when the registry doesn't say — per-machine installs first, then per-user. */
export function windowsFixedPaths(kind: BrowserKind, folders: WindowsFolders): string[] {
  const rel: Record<BrowserKind, string> = {
    chrome: 'Google\\Chrome\\Application\\chrome.exe',
    edge: 'Microsoft\\Edge\\Application\\msedge.exe',
    brave: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  };
  const roots = [folders.programFiles ?? 'C:\\Program Files', folders.programFilesX86 ?? 'C:\\Program Files (x86)', folders.localAppData];
  return [...new Set(roots.filter((r): r is string => !!r).map((root) => `${root.replace(/\\+$/, '')}\\${rel[kind]}`))];
}

/**
 * Parse `echo %ProgramFiles%;%ProgramFiles(x86)%;%LOCALAPPDATA%` from `cmd.exe`. A variable cmd
 * could not expand comes back verbatim (`%LOCALAPPDATA%`) and is treated as missing.
 */
export function parseWindowsFolders(output: string): WindowsFolders {
  const [programFiles, programFilesX86, localAppData] = output.trim().split(';').map((v) => v.trim());
  const usable = (v: string | undefined): string | undefined => (v && !v.includes('%') ? v : undefined);
  return { programFiles: usable(programFiles), programFilesX86: usable(programFilesX86), localAppData: usable(localAppData) };
}

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * `C:\Program Files\x` → `/mnt/c/Program Files/x`, for checking a Windows path exists from inside
 * WSL. Only the default automount root — the adapter prefers `wslpath`, which honors a custom
 * one, and falls back to this.
 */
export function windowsPathToWsl(path: string, mountRoot = '/mnt/'): string | null {
  if (!isWindowsPath(path)) return null;
  const root = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`;
  return `${root}${path[0]!.toLowerCase()}${path.slice(2).replace(/\\/g, '/')}`;
}

/**
 * The persistent debug profile on the Windows side (decision #10): kept across launches so a
 * login (Keycloak) survives, and never the user's real profile — Chrome 136+ ignores
 * `--remote-debugging-port` there anyway, and a debug port on a real profile would open every
 * signed-in session to any local process.
 */
export function windowsProfileDir(localAppData: string): string {
  return `${localAppData.replace(/\\+$/, '')}\\ejsng\\browser-profile`;
}

// ---------------------------------------------------------------------------------------------
// macOS / Linux
// ---------------------------------------------------------------------------------------------

export function macAppPaths(kind: BrowserKind, home: string): string[] {
  const app: Record<BrowserKind, string> = {
    chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
    edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    brave: 'Brave Browser.app/Contents/MacOS/Brave Browser',
  };
  return [`/Applications/${app[kind]}`, `${home.replace(/\/+$/, '')}/Applications/${app[kind]}`];
}

/** Command names looked up on `PATH`. Chromium counts as Chrome: same flags, same protocol. */
export function linuxCommands(kind: BrowserKind): string[] {
  const commands: Record<BrowserKind, string[]> = {
    chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    edge: ['microsoft-edge', 'microsoft-edge-stable'],
    brave: ['brave-browser', 'brave'],
  };
  return commands[kind];
}

// ---------------------------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------------------------

/**
 * Command-line flags for a debug launch that opens the app. If a browser is already running on
 * this profile, the same command just opens `url` in it — that instance already has the port.
 */
export function browserLaunchArgs(options: { debugPort: number; userDataDir: string; url: string }): string[] {
  return [
    `--remote-debugging-port=${options.debugPort}`,
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    options.url,
  ];
}

export function appUrlForPort(port: number): string {
  return `http://localhost:${port}/`;
}

/** One container's app ports, as `ejsng/listDockerContainers` reports them. */
export interface AppPortSource {
  name: string;
  appPorts: number[];
}

export type AppPortChoice =
  | { kind: 'use'; port: number }
  | { kind: 'ask'; options: Array<{ port: number; label: string }> }
  | { kind: 'none' };

/**
 * Which app port Launch opens (checklist item 4): the one remembered for this workspace when a
 * container still publishes it; otherwise the only one there is; otherwise ask — once, since the
 * answer is then remembered. No containers at all means the user has to say.
 */
export function chooseAppPort(containers: AppPortSource[], remembered: number | undefined): AppPortChoice {
  const options: Array<{ port: number; label: string }> = [];
  for (const c of containers) {
    for (const port of c.appPorts) {
      if (!options.some((o) => o.port === port)) options.push({ port, label: `${c.name}: ${port}` });
    }
  }
  if (remembered !== undefined && options.some((o) => o.port === remembered)) return { kind: 'use', port: remembered };
  if (options.length === 1) return { kind: 'use', port: options[0]!.port };
  if (options.length === 0) return { kind: 'none' };
  return { kind: 'ask', options };
}

/** What the user typed when there was no container to infer from: an app port, or a full http(s) URL. */
export function parseAppAddress(input: string): { url: string; port: number | null } | null {
  const text = input.trim();
  if (/^\d{1,5}$/.test(text)) {
    const port = Number(text);
    return port > 0 && port < 65536 ? { url: appUrlForPort(port), port } : null;
  }
  try {
    const u = new URL(text);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { url: u.toString(), port: u.port ? Number(u.port) : null };
  } catch {
    return null;
  }
}
