/**
 * Pure functions behind ticket 04 (.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md):
 * turn `docker inspect` JSON into Runtime Target candidates. No IO — shelling out to the real
 * `docker` CLI stays in packages/server/src/docker.ts, which calls only `parseDockerInspect`
 * and `resolveDockerCandidates` from here. Kept in its own file (alongside runtime-log.ts's
 * existing pure functions, not merged into it) so this ticket's additions and ticket 03's stay
 * in non-overlapping files — see the coordination note in this ticket.
 *
 * Ticket 05 (path mapping inferred from those same mounts) adds `mappingsFromMounts` at the
 * bottom — it belongs here, next to the `DockerMount` shape it reads.
 */
import type { PathMapping } from './runtime-log';

/** One published port pair from `docker inspect`'s `NetworkSettings.Ports`. */
export interface DockerPortBinding {
  containerPort: number;
  hostPort: number;
  protocol: string;
}

/** One `Source`/`Destination` pair from `docker inspect`'s `Mounts` — ticket 05 consumes this shape. */
export interface DockerMount {
  source: string;
  destination: string;
}

/**
 * One container as reported by `docker inspect`, before any inspector/app-port inference —
 * `resolveDockerCandidates` below turns a list of these into `DockerRuntimeCandidate`s.
 */
export interface DockerContainerInfo {
  id: string;
  /** Container name with the leading "/" `docker inspect` always puts on `Name` stripped. */
  name: string;
  running: boolean;
  ports: DockerPortBinding[];
  mounts: DockerMount[];
  /**
   * The inspector port the container's own Node process listens on INSIDE the container, parsed
   * from `--inspect[-brk][=host:port]` in its command or its `NODE_OPTIONS` env var. `null` if
   * the container isn't running Node with an inspector enabled at all — not a Runtime Target
   * candidate regardless of what else it publishes.
   */
  inspectorContainerPort: number | null;
  /**
   * The container's own IP address on each Docker network it is attached to. Where Docker runs
   * on the same Linux host as this extension (Docker Engine inside WSL, or plain Linux) these are
   * routable from the host, so an inspector the compose file never published is still reachable
   * at `<ip>:<inspectorContainerPort>`. Under Docker Desktop they usually aren't — the caller
   * probes rather than assumes.
   */
  ipAddresses: string[];
}

/** A container that IS a Runtime Target candidate (ticket 04) — has `--inspect` enabled somehow. */
export interface DockerRuntimeCandidate {
  containerId: string;
  containerName: string;
  mounts: DockerMount[];
  /**
   * Host-side inspector port, found by matching `inspectorContainerPort` against the CONTAINER
   * side of a published port pair — catches a remapped case like `9228->9229` (host 9228,
   * container-internal 9229), where the host port is NOT the port Node itself advertises. `null`
   * when the container's inspector port isn't published to the host at all (checklist item 6):
   * still a candidate worth reporting by name, just not one this extension can connect to.
   */
  hostInspectorPort: number | null;
  /** The port Node's inspector listens on INSIDE the container — what a compose fix has to publish when `hostInspectorPort` is `null` (ticket 09). */
  inspectorContainerPort: number;
  /** Every published host port OTHER than the inspector's — what a user recognizes as "the app port" (`cityos-web: 5000`), sorted ascending and de-duplicated. */
  appPorts: number[];
  /** See `DockerContainerInfo.ipAddresses` — where to try an inspector that `hostInspectorPort` says isn't published. */
  containerIps: string[];
}

/** Node's own default inspector port when `--inspect`/`--inspect-brk` is given with no explicit port. */
const DEFAULT_NODE_INSPECTOR_PORT = 9229;

/** Matches `--inspect`, `--inspect-brk`, `--inspect=9229`, `--inspect-brk=0.0.0.0:9229`, … */
const INSPECT_FLAG = /--inspect(?:-brk)?(?:=(?:[^:\s]+:)?(\d+))?/;

function findInspectorPortIn(text: string): number | null {
  const m = INSPECT_FLAG.exec(text);
  if (!m) return null;
  return m[1] ? Number(m[1]) : DEFAULT_NODE_INSPECTOR_PORT;
}

/**
 * Parse `--inspect[-brk][=host:port]` out of a container's running command OR its `NODE_OPTIONS`
 * env var — both are valid ways Node exposes an inspector (checklist item 2). `cmd` is checked
 * first (pass BOTH `Config.Entrypoint` and `Config.Cmd`, concatenated — Docker runs
 * `entrypoint + cmd` as one command line, and a Dockerfile commonly puts `--inspect` on either
 * half, e.g. `ENTRYPOINT ["node", "--inspect=0.0.0.0:9229"]` with a separate `CMD`);
 * `NODE_OPTIONS` is only consulted when `cmd` itself doesn't carry the flag.
 */
export function extractInspectorContainerPort(cmd: string[], env: string[]): number | null {
  const fromCmd = findInspectorPortIn(cmd.join(' '));
  if (fromCmd != null) return fromCmd;
  const nodeOptions = env.find((e) => e.startsWith('NODE_OPTIONS='));
  if (!nodeOptions) return null;
  return findInspectorPortIn(nodeOptions.slice('NODE_OPTIONS='.length));
}

/** `docker inspect`'s `NetworkSettings.Ports`: `{"9229/tcp": [{"HostIp": "0.0.0.0", "HostPort": "9228"}], "5000/tcp": null}` — `null` means not published. */
function parsePortBindings(ports: unknown): DockerPortBinding[] {
  if (typeof ports !== 'object' || ports === null) return [];
  const result: DockerPortBinding[] = [];
  for (const [key, bindings] of Object.entries(ports as Record<string, unknown>)) {
    if (!Array.isArray(bindings)) continue; // not published to the host at all
    const [portText, protocol = 'tcp'] = key.split('/');
    const containerPort = Number(portText);
    if (!Number.isFinite(containerPort)) continue;
    for (const binding of bindings) {
      if (typeof binding !== 'object' || binding === null) continue;
      const hostPort = Number((binding as { HostPort?: unknown }).HostPort);
      if (!Number.isFinite(hostPort)) continue;
      result.push({ containerPort, hostPort, protocol });
    }
  }
  return result;
}

/** `docker inspect`'s `NetworkSettings`: one `IPAddress` per attached network (plus the legacy top-level one), de-duplicated, empty ones dropped. */
function parseIpAddresses(settings: { IPAddress?: unknown; Networks?: unknown } | undefined): string[] {
  const ips = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) ips.add(v.trim());
  };
  if (typeof settings?.Networks === 'object' && settings.Networks !== null) {
    for (const network of Object.values(settings.Networks)) add((network as { IPAddress?: unknown } | null)?.IPAddress);
  }
  add(settings?.IPAddress);
  return [...ips];
}

/** `docker inspect`'s `Mounts`: an array of objects, only `Source`/`Destination` matter here. */
function parseMounts(mounts: unknown): DockerMount[] {
  if (!Array.isArray(mounts)) return [];
  const result: DockerMount[] = [];
  for (const m of mounts) {
    if (typeof m !== 'object' || m === null) continue;
    const source = (m as { Source?: unknown }).Source;
    const destination = (m as { Destination?: unknown }).Destination;
    if (typeof source === 'string' && typeof destination === 'string') result.push({ source, destination });
  }
  return result;
}

/**
 * Turn parsed `docker inspect` JSON (an array of container objects) into `DockerContainerInfo[]`.
 * `entries` is `unknown` because it's `JSON.parse`'d output from a local CLI — trusted more than
 * a network peer, but still validated defensively: a malformed entry is skipped, not thrown on,
 * matching the rest of this codebase's "never throw on untrusted-shaped input" convention (see
 * `isConsoleApiCalledEvent` in runtime-log.ts).
 */
export function parseDockerInspect(entries: unknown): DockerContainerInfo[] {
  if (!Array.isArray(entries)) return [];
  const result: DockerContainerInfo[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as {
      Id?: unknown;
      Name?: unknown;
      State?: { Running?: unknown };
      Config?: { Cmd?: unknown; Entrypoint?: unknown; Env?: unknown };
      NetworkSettings?: { Ports?: unknown; IPAddress?: unknown; Networks?: unknown };
      Mounts?: unknown;
    };
    if (typeof e.Id !== 'string' || typeof e.Name !== 'string') continue;
    const name = e.Name.startsWith('/') ? e.Name.slice(1) : e.Name;
    const running = e.State?.Running === true;
    const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    // Docker actually runs `entrypoint + cmd` as one command line — check both, entrypoint first.
    const cmd = [...stringsOf(e.Config?.Entrypoint), ...stringsOf(e.Config?.Cmd)];
    const env = stringsOf(e.Config?.Env);
    result.push({
      id: e.Id,
      name,
      running,
      ports: parsePortBindings(e.NetworkSettings?.Ports),
      mounts: parseMounts(e.Mounts),
      inspectorContainerPort: extractInspectorContainerPort(cmd, env),
      ipAddresses: parseIpAddresses(e.NetworkSettings),
    });
  }
  return result;
}

/**
 * Keep only containers that could be a Runtime Target (running, with an inspector enabled
 * somehow) and, for each, infer the host-side inspector port by matching `inspectorContainerPort`
 * against the CONTAINER side of a published pair — this is what catches a remap like
 * `9228->9229` (checklist item 3): the host port is found by looking up which pair's
 * `containerPort` equals the inspector's OWN port, not by assuming host == container.
 */
export function resolveDockerCandidates(containers: DockerContainerInfo[]): DockerRuntimeCandidate[] {
  const candidates: DockerRuntimeCandidate[] = [];
  for (const c of containers) {
    if (!c.running || c.inspectorContainerPort == null) continue;
    const hostInspectorPort = c.ports.find((p) => p.containerPort === c.inspectorContainerPort)?.hostPort ?? null;
    const appPorts = [...new Set(c.ports.filter((p) => p.containerPort !== c.inspectorContainerPort).map((p) => p.hostPort))].sort(
      (a, b) => a - b,
    );
    candidates.push({
      containerId: c.id,
      containerName: c.name,
      mounts: c.mounts,
      hostInspectorPort,
      inspectorContainerPort: c.inspectorContainerPort,
      appPorts,
      containerIps: c.ipAddresses,
    });
  }
  return candidates;
}

/** `connectable`: candidates this extension can actually reach. `unreachable`: real Node/`--inspect` containers whose inspector isn't published — report by name (checklist item 6), never touch the container itself. */
export interface PartitionedDockerCandidates {
  connectable: DockerRuntimeCandidate[];
  unreachable: DockerRuntimeCandidate[];
}

export function partitionDockerCandidates(candidates: DockerRuntimeCandidate[]): PartitionedDockerCandidates {
  return {
    connectable: candidates.filter((c) => c.hostInspectorPort != null),
    unreachable: candidates.filter((c) => c.hostInspectorPort == null),
  };
}

/** Typing the app port (checklist item 4) — every candidate that PUBLISHES it as a host port (normally at most one, but never assume that). */
export function filterDockerCandidatesByAppPort(candidates: DockerRuntimeCandidate[], appPort: number): DockerRuntimeCandidate[] {
  return candidates.filter((c) => c.appPorts.includes(appPort));
}

/** Same as `filterDockerCandidatesByAppPort`, but just the first match — convenient when the caller only wants one candidate to act on. */
export function findDockerCandidateByAppPort(candidates: DockerRuntimeCandidate[], appPort: number): DockerRuntimeCandidate | null {
  return filterDockerCandidatesByAppPort(candidates, appPort)[0] ?? null;
}

/**
 * Ticket 05 (.scratch/runtime-remote-env/issues/05-path-mapping-tu-mount.md): turn the mounts of
 * the container being connected to into container-path -> host-path mappings. A mount already
 * states exactly which host directory a container path IS — no guessing from directory names,
 * which is what goes wrong with nested mounts.
 *
 * Sorted by container-side path length, LONGEST FIRST (checklist item 1), because
 * `mapContainerPath` is first-match-wins and mounts genuinely nest. On the spec's motivating
 * machine, `/home/cityos/aocs-cityos` is one repo and `/home/cityos/aocs-cityos/aocs` — a
 * directory INSIDE it — is a different one: a log from `/home/cityos/aocs-cityos/aocs/x.js` must
 * resolve through the inner mount to the repo actually running, not through the outer one to the
 * shadowed directory of the repo it merely sits inside.
 *
 * These are never written to settings — the caller recomputes them on every Connect (checklist
 * item 4), so a container rebuilt with different mounts is picked up without the user editing
 * anything, and a stale mapping can never outlive the container it was read from.
 */
export function mappingsFromMounts(mounts: DockerMount[]): PathMapping[] {
  return mounts
    .map((m) => ({ remote: m.destination, local: m.source }))
    .sort((a, b) => b.remote.length - a.remote.length);
}

/** `<container name>: <app port>` — the exact Quick Pick phrasing from the spec (user story #4, e.g. `cityos-web: 5000`). */
export function formatDockerCandidateLabel(candidate: DockerRuntimeCandidate): string {
  return candidate.appPorts.length > 0
    ? `${candidate.containerName}: ${candidate.appPorts.join(', ')}`
    : `${candidate.containerName}: (no published app port)`;
}
