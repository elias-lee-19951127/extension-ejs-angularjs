/**
 * IO adapter for ticket 09 (.scratch/runtime-remote-env/issues/09-panel-danh-sach-kiem-tra.md):
 * probe the workspace side for the checklist's "Environment" and "Docker" steps. Every decision
 * about what the probes mean is a pure function in packages/core/src/runtime-log-checklist.ts —
 * this module only runs the commands and reads the files.
 *
 * Runs only when the user presses Connect (never on activation: user story #38), and every probe
 * is local — no network is touched here.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  environmentKindFromRemoteName,
  wslNetworkingModeFrom,
  type DockerCliStatus,
  type RuntimeEnvironment,
  type WslNetworkingMode,
} from '@ejsng/core';

/** What the client knows and the server must not guess (spec decision #15): sent via `initializationOptions`. */
export interface ClientEnvironmentInfo {
  remoteName: string | null;
  clientPlatform: string | null;
}

interface Run {
  stdout: string;
  stderr: string;
  error: (Error & { code?: string | number | null }) | null;
}

const PROBE_TIMEOUT_MS = 5000;

function run(cmd: string, args: string[], cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
    });
  });
}

/** `docker version` answers both questions at once: is the CLI there, and can it reach a daemon. */
export async function dockerCliStatus(): Promise<DockerCliStatus> {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (r.error?.code === 'ENOENT') return { state: 'missing' };
  if (r.error) {
    const firstLine = (r.stderr || r.error.message).split('\n').find((l) => l.trim()) ?? r.error.message;
    return { state: 'error', message: firstLine.trim() };
  }
  return { state: 'available', version: r.stdout.trim() || 'unknown version' };
}

/**
 * Read the evidence for WSL's networking mode. `.wslconfig` lives in the WINDOWS user's profile,
 * reached through interop (`cmd.exe`) and `wslpath`. A profile that resolves but holds no
 * `.wslconfig` is WSL's default configuration, so it is passed on as an empty file; a profile
 * that cannot be resolved at all leaves only `ip addr` to go on.
 */
async function wslNetworkingMode(): Promise<WslNetworkingMode> {
  let wslconfig: string | null = null;
  // cwd on a Windows drive: cmd.exe refuses a UNC working directory (the distro's own filesystem).
  const profile = await run('cmd.exe', ['/d', '/c', 'echo %USERPROFILE%'], '/mnt/c');
  const windowsPath = profile.error ? '' : profile.stdout.trim();
  if (windowsPath && !windowsPath.includes('%')) {
    const converted = await run('wslpath', ['-u', windowsPath]);
    const profileDir = converted.error ? '' : converted.stdout.trim();
    if (profileDir) {
      try {
        wslconfig = readFileSync(`${profileDir}/.wslconfig`, 'utf8');
      } catch (err) {
        wslconfig = (err as { code?: string }).code === 'ENOENT' ? '' : null;
      }
    }
  }
  const ip = await run('ip', ['-o', 'addr']);
  return wslNetworkingModeFrom({ wslconfig, ipAddr: ip.error ? null : ip.stdout });
}

export async function detectRuntimeEnvironment(client: ClientEnvironmentInfo): Promise<RuntimeEnvironment> {
  const kind = environmentKindFromRemoteName(client.remoteName);
  const [docker, wslNetworking] = await Promise.all([dockerCliStatus(), kind === 'wsl' ? wslNetworkingMode() : Promise.resolve(null)]);
  return {
    kind,
    remoteName: client.remoteName,
    platform: process.platform,
    clientPlatform: client.clientPlatform,
    wslNetworking,
    docker,
  };
}
