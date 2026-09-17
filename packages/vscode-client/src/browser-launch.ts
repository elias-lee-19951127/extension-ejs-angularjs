/**
 * IO adapter for ticket 10 (.scratch/runtime-remote-env/issues/10-launch-trinh-duyet-phia-ui.md):
 * find a browser on the user's side and start it. What to look for, in what order, and with
 * which flags is decided in browser-locator.ts; this file only asks the registry, checks paths,
 * and spawns.
 *
 * Not covered by automated tests (checklist item 7): it needs a real Windows + WSL machine. The
 * manual checklist lives in the ticket.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import {
  BROWSER_NAMES,
  BROWSER_ORDER,
  isWindowsPath,
  linuxCommands,
  macAppPaths,
  parseRegQueryDefaultValue,
  parseWindowsFolders,
  windowsFixedPaths,
  windowsPathToWsl,
  windowsProfileDir,
  windowsRegistryKeys,
  type WindowsFolders,
} from './browser-locator';

export interface LocatedBrowser {
  /** `Chrome`, `Edge`, `Brave`, or `configured` for `ejsng.runtimeLog.chromeExecutablePath`. */
  name: string;
  /** What to spawn from here — under WSL, the `/mnt/c/...` form of a Windows executable. */
  spawnPath: string;
  /** What to show the user — under WSL, the Windows path. */
  displayPath: string;
}

export type LocateResult = { browser: LocatedBrowser } | { browser: null; tried: string[]; configuredMissing: boolean };

const PROBE_TIMEOUT_MS = 5000;

function run(cmd: string, args: string[]): Promise<{ stdout: string; failed: boolean }> {
  return new Promise((resolve) => {
    // cwd on a Windows drive under WSL: cmd.exe refuses to start in a UNC working directory.
    const cwd = cmd.startsWith('/mnt/') ? dirname(cmd) : undefined;
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, cwd }, (err, stdout) => {
      resolve({ stdout: String(stdout ?? ''), failed: err !== null });
    });
  });
}

/** Under WSL, interop tools are normally on PATH; fall back to their fixed location when Windows paths aren't appended. */
function windowsTool(name: 'reg.exe' | 'cmd.exe', wsl: boolean): string[] {
  return wsl ? [name, `/mnt/c/Windows/System32/${name}`] : [name];
}

async function runWindowsTool(name: 'reg.exe' | 'cmd.exe', args: string[], wsl: boolean): Promise<string | null> {
  for (const tool of windowsTool(name, wsl)) {
    const r = await run(tool, args);
    if (!r.failed) return r.stdout;
  }
  return null;
}

export async function windowsFolders(wsl: boolean): Promise<WindowsFolders> {
  if (!wsl) {
    return { programFiles: process.env.ProgramFiles, programFilesX86: process.env['ProgramFiles(x86)'], localAppData: process.env.LOCALAPPDATA };
  }
  const out = await runWindowsTool('cmd.exe', ['/d', '/c', 'echo %ProgramFiles%;%ProgramFiles(x86)%;%LOCALAPPDATA%'], true);
  return out === null ? {} : parseWindowsFolders(out);
}

/** A Windows path as this process sees it: unchanged natively, `/mnt/<drive>/...` under WSL. */
async function hereFromWindows(path: string, wsl: boolean): Promise<string | null> {
  if (!wsl) return path;
  const r = await run('wslpath', ['-u', path]);
  const converted = r.failed ? '' : r.stdout.trim();
  return converted || windowsPathToWsl(path);
}

async function whichCommand(command: string): Promise<string | null> {
  const r = await run('which', [command]);
  const found = r.failed ? '' : r.stdout.trim().split('\n')[0]?.trim() ?? '';
  return found || null;
}

/**
 * Find the browser to launch (checklist item 1): a non-empty `configuredPath` wins outright — and
 * if it doesn't exist that is reported, not quietly replaced by another browser. Otherwise Chrome,
 * then Edge, then Brave; on Windows each is looked up in the registry before its fixed install
 * paths.
 */
export async function locateBrowser(configuredPath: string, wsl: boolean): Promise<LocateResult> {
  const configured = configuredPath.trim();
  if (configured) {
    const here = wsl && isWindowsPath(configured) ? await hereFromWindows(configured, true) : configured;
    if (here && existsSync(here)) return { browser: { name: 'configured', spawnPath: here, displayPath: configured } };
    return { browser: null, tried: [configured], configuredMissing: true };
  }

  const tried: string[] = [];
  if (wsl || process.platform === 'win32') {
    const folders = await windowsFolders(wsl);
    for (const kind of BROWSER_ORDER) {
      const fromRegistry: string[] = [];
      for (const key of windowsRegistryKeys(kind)) {
        const out = await runWindowsTool('reg.exe', ['query', key, '/ve'], wsl);
        const value = out === null ? null : parseRegQueryDefaultValue(out);
        if (value) fromRegistry.push(value);
      }
      for (const windowsPath of [...fromRegistry, ...windowsFixedPaths(kind, folders)]) {
        tried.push(windowsPath);
        const here = await hereFromWindows(windowsPath, wsl);
        if (here && existsSync(here)) return { browser: { name: BROWSER_NAMES[kind], spawnPath: here, displayPath: windowsPath } };
      }
    }
    return { browser: null, tried: [...new Set(tried)], configuredMissing: false };
  }

  if (process.platform === 'darwin') {
    for (const kind of BROWSER_ORDER) {
      for (const path of macAppPaths(kind, homedir())) {
        tried.push(path);
        if (existsSync(path)) return { browser: { name: BROWSER_NAMES[kind], spawnPath: path, displayPath: path } };
      }
    }
    return { browser: null, tried, configuredMissing: false };
  }

  for (const kind of BROWSER_ORDER) {
    for (const command of linuxCommands(kind)) {
      tried.push(command);
      const path = await whichCommand(command);
      if (path) return { browser: { name: BROWSER_NAMES[kind], spawnPath: path, displayPath: path } };
    }
  }
  return { browser: null, tried, configuredMissing: false };
}

/**
 * The persistent debug profile directory, as the BROWSER sees it (checklist items 2-3): under
 * WSL a Windows path in `%LOCALAPPDATA%`, since a `/home/...` path means nothing to `chrome.exe`;
 * locally, the extension's own global storage. `null` when WSL can't tell where
 * `%LOCALAPPDATA%` is.
 */
export async function browserProfileDir(wsl: boolean, localProfileDir: string): Promise<string | null> {
  if (!wsl) return localProfileDir;
  const { localAppData } = await windowsFolders(true);
  return localAppData ? windowsProfileDir(localAppData) : null;
}

/** Start the browser detached; resolves once the process really started, rejects if it couldn't. */
export function spawnBrowser(browser: LocatedBrowser, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(browser.spawnPath, args, {
      detached: true,
      stdio: 'ignore',
      // A Windows executable under WSL should not inherit a UNC working directory.
      cwd: browser.spawnPath.startsWith('/mnt/') ? dirname(browser.spawnPath) : undefined,
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}
