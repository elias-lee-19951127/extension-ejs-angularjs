/**
 * IO adapter for ticket 04 (.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md):
 * shell out to the `docker` CLI to list Runtime Target candidates. Parsing/matching are pure
 * functions in packages/core/src/runtime-log-docker.ts — this module only wires them up to a real
 * child process, mirroring runtime-log.ts's split between adapters (here) and pure logic (core).
 */
import { execFile } from 'node:child_process';
import { parseDockerInspect, resolveDockerCandidates, type DockerRuntimeCandidate } from '@ejsng/core';

interface ExecCapture {
  stdout: string;
  /** Never thrown — a non-zero exit is reported here so the caller can still use partial `stdout` (see `docker inspect` below), instead of losing it the moment `execFile` reports ANY failure. */
  error: Error | null;
}

function execFileCapture(cmd: string, args: string[]): Promise<ExecCapture> {
  return new Promise((resolve) => {
    // 10MB: `docker inspect` on a host with many containers, each carrying a full Config/Mounts
    // dump, can output more than Node's default 1MB maxBuffer.
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve({ stdout: stdout ?? '', error: err });
    });
  });
}

/**
 * List every running container's Runtime Target candidate info: `docker ps -q` to enumerate,
 * then a single `docker inspect` across all of them for ports/command/env/mounts.
 *
 * Resolves to `[]` whenever `docker` isn't usable at all — not on PATH (`ENOENT`), daemon not
 * running, permission denied, unparsable output — so the caller can fall through to the
 * pre-Docker flow silently. Per the spec, no Docker on the machine is an expected, common case
 * (a local/non-Docker user), never an error to surface.
 */
export async function listDockerRuntimeCandidates(): Promise<DockerRuntimeCandidate[]> {
  const ps = await execFileCapture('docker', ['ps', '-q']);
  if (ps.error) return []; // `docker` itself unusable — nothing to salvage from a failed `ps`
  const containerIds = ps.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (containerIds.length === 0) return [];

  const inspect = await execFileCapture('docker', ['inspect', ...containerIds]);
  // `docker inspect` still prints a JSON array of every container it DID find even when it exits
  // non-zero for one it couldn't (a container that stopped/was removed in the gap between `ps`
  // and this call — a real race, not hypothetical, on a host with short-lived containers). Parse
  // whatever stdout came back regardless of `inspect.error`; only an empty/unparsable body means
  // truly nothing usable.
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return [];
  }

  return resolveDockerCandidates(parseDockerInspect(parsed));
}
