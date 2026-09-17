/**
 * Pure functions behind ticket 09 (.scratch/runtime-remote-env/issues/09-panel-danh-sach-kiem-tra.md):
 * turn everything the server knows about the Connect chain — environment, Docker discovery, live
 * connections, Path Mappings, dropped logs — into a step-by-step checklist, plus the markdown
 * report behind the panel's "Copy report" button.
 *
 * No IO and no VS Code: the server gathers the snapshot and answers `ejsng/runtimeChecklist` /
 * `ejsng/runtimeReport`, so a future IntelliJ client renders the very same steps without
 * re-deriving any of this (spec decision #15).
 */
import { resolvePathMappings, type PathMapping } from './runtime-log';

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

/** Where the workspace side of the extension runs — told apart by the client's `vscode.env.remoteName`. */
export type RuntimeEnvironmentKind = 'local' | 'wsl' | 'ssh' | 'container' | 'codespace' | 'other-remote';

/** WSL's `networkingMode`. `unknown` whenever the evidence is not conclusive — never a guess. */
export type WslNetworkingMode = 'nat' | 'mirrored' | 'unknown';

export type DockerCliStatus = { state: 'available'; version: string } | { state: 'missing' } | { state: 'error'; message: string };

export interface RuntimeEnvironment {
  kind: RuntimeEnvironmentKind;
  /** `vscode.env.remoteName` as the client reported it, `null` for a local window. */
  remoteName: string | null;
  /** `process.platform` of the machine running the server (the workspace side). */
  platform: string;
  /** `process.platform` of the machine running the client's UI, when the client reported it. */
  clientPlatform: string | null;
  /** Only set for `kind === 'wsl'`. */
  wslNetworking: WslNetworkingMode | null;
  docker: DockerCliStatus;
}

/**
 * Map VS Code's `remoteName` to an environment kind. The names are the ids of Microsoft's own
 * remote extensions; anything else (a third-party remote) is still a remote, just not one this
 * extension knows the networking of.
 */
export function environmentKindFromRemoteName(remoteName: string | null | undefined): RuntimeEnvironmentKind {
  if (!remoteName) return 'local';
  switch (remoteName) {
    case 'wsl':
      return 'wsl';
    case 'ssh-remote':
      return 'ssh';
    case 'dev-container':
    case 'attached-container':
      return 'container';
    case 'codespaces':
      return 'codespace';
    default:
      return 'other-remote';
  }
}

/** Evidence gathered inside WSL — any of it may be missing. */
export interface WslNetworkingEvidence {
  /** Contents of the Windows user's `%UserProfile%\.wslconfig`; `null` when it could not be read. */
  wslconfig?: string | null;
  /** Output of `ip -o addr` (or `ip addr`) inside the distro; `null` when it could not be run. */
  ipAddr?: string | null;
}

/**
 * Work out WSL's networking mode (spec, "Nhận diện môi trường": from WSL config / `ip`, `unknown`
 * when not sure).
 *
 * `.wslconfig` is authoritative when it could be read: an explicit `networkingMode` under
 * `[wsl2]` says it outright, and a readable file WITHOUT one means WSL's default, NAT. Only when
 * the file was unreadable does the interface list count: mirrored mode adds a `loopback0`
 * interface, and NAT puts `eth0` on the private 172.16.0.0/12 range of its virtual switch. The
 * config wins over the interfaces because it is what the NEXT `wsl --shutdown` will apply.
 */
export function wslNetworkingModeFrom(evidence: WslNetworkingEvidence): WslNetworkingMode {
  if (typeof evidence.wslconfig === 'string') {
    const configured = readWsl2Setting(evidence.wslconfig, 'networkingmode');
    if (configured === 'mirrored') return 'mirrored';
    if (configured === 'nat' || configured === null) return 'nat';
    return 'unknown';
  }
  const ipAddr = evidence.ipAddr;
  if (typeof ipAddr !== 'string') return 'unknown';
  if (/\bloopback0\b/.test(ipAddr)) return 'mirrored';
  if (/\beth0\b[^\n]*\binet 172\.(1[6-9]|2\d|3[01])\./.test(ipAddr)) return 'nat';
  return 'unknown';
}

/** Value of `key` (lower-cased) in the `[wsl2]` section of an INI file, lower-cased, or `null`. */
function readWsl2Setting(ini: string, key: string): string | null {
  let inWsl2 = false;
  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inWsl2 = section[1]!.trim().toLowerCase() === 'wsl2';
      continue;
    }
    if (!inWsl2) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim().toLowerCase() === key) return line.slice(eq + 1).trim().toLowerCase();
  }
  return null;
}

/** Microsoft's own page on mirrored networking — what the "open guide" fix opens. */
export const WSL_MIRRORED_GUIDE_URL = 'https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking';

/** The manual steps to switch WSL to mirrored. The extension never edits `.wslconfig` itself (decision #2). */
export const WSL_MIRRORED_STEPS: readonly string[] = [
  'On Windows, open %UserProfile%\\.wslconfig (create it if missing).',
  'Under [wsl2], add: networkingMode=mirrored',
  'Run "wsl --shutdown" in PowerShell, then reopen the VS Code window.',
];

// ---------------------------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------------------------

/** One container the last Docker discovery saw — only what the checklist and report need. */
export interface ChecklistContainer {
  name: string;
  appPorts: number[];
  /** `null`: `--inspect` is on, but its port isn't published to the host. */
  hostInspectorPort: number | null;
  inspectorContainerPort: number;
}

export interface ChecklistConnection {
  key: string;
  /** `host:port` the debug endpoint was reached at. */
  endpoint: string;
  /** CDP target type: `node` for a Node process, `page` (and the like) for a browser. */
  targetType: string;
  title: string;
  /** The container this endpoint was found through, if any. */
  containerName: string | null;
  state: 'connecting' | 'connected' | 'failed';
  reason?: string;
  received: number;
  drawn: number;
  droppedByReason: Record<string, number>;
  /** Mappings read from the container's mounts that at least one drawn log went through. */
  usedMountMappings: PathMapping[];
  /** Mappings found by matching a browser URL's tail (ticket 07). */
  urlMappings: PathMapping[];
  outsideWorkspaceDirs: string[];
  wrapperSuggestion: { path: string; share: number } | null;
}

export interface RuntimeChecklistInput {
  /** `null` until Connect has run once in this session — the panel then shows every step as pending. */
  environment: RuntimeEnvironment | null;
  /** `null` until Docker discovery has run. */
  containers: ChecklistContainer[] | null;
  connections: ChecklistConnection[];
  /** `ejsng.runtimeLog.pathMappings`, as declared — `${workspaceFolder}` not yet expanded. */
  userMappings: PathMapping[];
  /** What `${workspaceFolder}` expands to, to tell a discovered mapping that is already saved. */
  workspaceFolder: string | null;
  /** The browser executable Launch last used, remembered by the client. */
  browser: string | null;
}

export type ChecklistStatus = 'ok' | 'warn' | 'fail' | 'pending' | 'skipped';

/** A fix the panel can apply in place. Every one of them needs an explicit click. */
export type ChecklistFix =
  | { kind: 'save-mapping'; label: string; remote: string; local: string }
  | { kind: 'skip-frame'; label: string; path: string }
  | { kind: 'add-folder'; label: string; path: string }
  | { kind: 'copy-compose'; label: string; snippet: string }
  | { kind: 'open-mirrored-guide'; label: string; url: string }
  | { kind: 'open-settings'; label: string; query: string };

export type ChecklistStepId = 'environment' | 'docker' | 'node' | 'browser' | 'path-mapping' | 'logs';

export interface DropReasonGroup {
  reason: string;
  label: string;
  count: number;
}

export interface ChecklistStep {
  id: ChecklistStepId;
  title: string;
  status: ChecklistStatus;
  detail: string;
  /** Extra lines under the detail — manual steps, mapping lists. */
  notes: string[];
  fixes: ChecklistFix[];
  /** Only on the `logs` step: dropped logs grouped by reason, largest first. */
  dropGroups?: DropReasonGroup[];
  /** Only on the `logs` step. */
  counts?: { received: number; drawn: number; dropped: number };
}

const DROP_REASON_LABELS: Record<string, string> = {
  'no-stack-trace': 'no stack trace to anchor the log to',
  'all-frames-skipped': 'every frame was a library, logger, or minified file',
  'outside-workspace': 'file is outside the workspace and every Path Mapping',
  'unreadable-file': 'file could not be read',
  'no-path-mapping': 'no Path Mapping covers the Runtime Path',
  'stale-file': 'Stale File — changed since the runtime loaded it (restart the app)',
  'shadowed-file': 'Shadowed File — the runtime is running another copy',
  'content-mismatch': 'file content differs from what the runtime runs',
  'ambiguous-url-match': 'browser URL matches more than one file',
  'server-not-ready': 'language server was not ready yet',
};

/** Dropped-log counts grouped by reason, with a readable label, largest group first. */
export function groupDropReasons(droppedByReason: Record<string, number>): DropReasonGroup[] {
  return Object.entries(droppedByReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, label: DROP_REASON_LABELS[reason] ?? reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * The compose change that makes a container's inspector reachable (decision #3: shown to copy,
 * never applied — the extension does not touch compose files or running containers). Binding to
 * `0.0.0.0` matters as much as publishing: an inspector on the container's own `127.0.0.1` stays
 * unreachable however the port is published.
 */
export function composeInspectorSnippet(containerName: string, inspectorPort: number): string {
  return [
    'services:',
    `  ${containerName}:`,
    '    # Listen on every interface inside the container, not only its own 127.0.0.1',
    `    command: node --inspect=0.0.0.0:${inspectorPort} <your entry file>`,
    '    ports:',
    `      - "${inspectorPort}:${inspectorPort}"`,
  ].join('\n');
}

const BROWSER_TARGET_TYPES = new Set(['page', 'iframe', 'worker', 'service_worker', 'shared_worker', 'webview', 'browser']);

/** A CDP target is the browser side unless it says it is Node. */
export function isBrowserTarget(targetType: string): boolean {
  return BROWSER_TARGET_TYPES.has(targetType);
}

function describeEnvironment(env: RuntimeEnvironment): string {
  const names: Record<RuntimeEnvironmentKind, string> = {
    local: 'Local',
    wsl: 'Remote-WSL',
    ssh: 'Remote-SSH',
    container: 'Dev Container',
    codespace: 'Codespace',
    'other-remote': `Remote (${env.remoteName ?? 'unknown'})`,
  };
  let text = `${names[env.kind]} — workspace on ${env.platform}`;
  if (env.clientPlatform && env.clientPlatform !== env.platform) text += `, UI on ${env.clientPlatform}`;
  if (env.kind === 'wsl') text += `, networking: ${env.wslNetworking ?? 'unknown'}`;
  return text;
}

function describeContainer(c: ChecklistContainer): string {
  const app = c.appPorts.length > 0 ? c.appPorts.join(', ') : 'no published app port';
  return `${c.name}: ${app}`;
}

function describeConnection(c: ChecklistConnection): string {
  const who = c.containerName ?? (c.title || c.endpoint);
  const state = c.state === 'failed' ? `failed — ${c.reason ?? 'unknown reason'}` : c.state;
  return `${who} (${c.endpoint}) ${state}`;
}

function mappingKey(m: PathMapping): string {
  return `${m.remote} ${m.local}`;
}

function uniqueMappings(mappings: PathMapping[]): PathMapping[] {
  return [...new Map(mappings.map((m) => [mappingKey(m), m])).values()];
}

function environmentStep(input: RuntimeChecklistInput): ChecklistStep {
  const step: ChecklistStep = { id: 'environment', title: 'Environment', status: 'pending', detail: 'Not checked yet — press Connect.', notes: [], fixes: [] };
  const env = input.environment;
  if (!env) return step;
  step.status = 'ok';
  step.detail = describeEnvironment(env);
  if (env.kind === 'wsl' && env.wslNetworking === 'nat') {
    step.status = 'warn';
    step.notes.push(
      'Node logs work. Browser logs need networkingMode=mirrored: Chrome on Windows only listens on its own 127.0.0.1, which WSL in NAT mode cannot reach.',
      ...WSL_MIRRORED_STEPS,
    );
    step.fixes.push({ kind: 'open-mirrored-guide', label: 'Open mirrored networking guide', url: WSL_MIRRORED_GUIDE_URL });
  } else if (env.kind === 'wsl' && env.wslNetworking === 'unknown') {
    step.notes.push('Could not tell whether WSL uses NAT or mirrored networking. If the browser will not connect, switch to mirrored.');
    step.fixes.push({ kind: 'open-mirrored-guide', label: 'Open mirrored networking guide', url: WSL_MIRRORED_GUIDE_URL });
  }
  return step;
}

function dockerStep(input: RuntimeChecklistInput): ChecklistStep {
  const step: ChecklistStep = { id: 'docker', title: 'Docker / container', status: 'pending', detail: 'Not checked yet.', notes: [], fixes: [] };
  const env = input.environment;
  if (!env) return step;
  if (env.docker.state === 'missing') {
    step.status = 'skipped';
    step.detail = 'Docker CLI not found — connecting by host:port instead.';
    return step;
  }
  if (env.docker.state === 'error') {
    step.status = 'warn';
    step.detail = `Docker CLI is installed but not usable: ${env.docker.message}`;
    return step;
  }
  if (!input.containers) {
    step.detail = `Docker ${env.docker.version} — containers not listed yet.`;
    return step;
  }
  const connectable = input.containers.filter((c) => c.hostInspectorPort !== null);
  const unreachable = input.containers.filter((c) => c.hostInspectorPort === null);
  if (connectable.length === 0 && unreachable.length === 0) {
    step.status = 'skipped';
    step.detail = `Docker ${env.docker.version} — no running Node container with --inspect.`;
    return step;
  }
  step.status = unreachable.length > 0 ? 'warn' : 'ok';
  step.detail =
    connectable.length > 0
      ? `Found ${connectable.map(describeContainer).join('; ')}`
      : 'No container publishes its inspector port.';
  for (const c of unreachable) {
    step.notes.push(`${c.name} runs Node with --inspect, but port ${c.inspectorContainerPort} is not published to the host.`);
    step.fixes.push({
      kind: 'copy-compose',
      label: `Copy compose snippet for ${c.name}`,
      snippet: composeInspectorSnippet(c.name, c.inspectorContainerPort),
    });
  }
  return step;
}

function connectionStep(
  input: RuntimeChecklistInput,
  id: 'node' | 'browser',
  connections: ChecklistConnection[],
): ChecklistStep {
  const title = id === 'node' ? 'Node connection' : 'Browser connection';
  const step: ChecklistStep = { id, title, status: 'pending', detail: 'Not connected yet.', notes: [], fixes: [] };
  if (id === 'browser' && input.browser) step.notes.push(`Browser: ${input.browser}`);

  if (connections.length > 0) {
    step.detail = connections.map(describeConnection).join('; ');
    if (connections.some((c) => c.state === 'connected')) step.status = 'ok';
    else if (connections.some((c) => c.state === 'connecting')) step.status = 'pending';
    else step.status = 'fail';
    return step;
  }

  const env = input.environment;
  if (!env) return step;
  if (id === 'node') {
    const anyBrowser = input.connections.some((c) => isBrowserTarget(c.targetType));
    step.status = anyBrowser ? 'skipped' : 'fail';
    step.detail = anyBrowser
      ? 'No Node runtime connected — only a browser.'
      : 'No Node runtime connected. Start the app with --inspect, or enter host:port under Advanced.';
    return step;
  }
  if (env.kind === 'wsl' && env.wslNetworking === 'nat') {
    step.status = 'fail';
    step.detail = 'Unreachable from WSL in NAT mode — switch WSL to networkingMode=mirrored for browser logs.';
    step.fixes.push({ kind: 'open-mirrored-guide', label: 'Open mirrored networking guide', url: WSL_MIRRORED_GUIDE_URL });
  } else if (env.kind === 'ssh' || env.kind === 'container' || env.kind === 'codespace') {
    step.status = 'skipped';
    step.detail = 'Browser logs are not supported from this remote yet — Node logs still work.';
  } else {
    step.status = 'skipped';
    step.detail = 'No browser connected. Use "Launch Chrome debug" under Advanced for browser logs.';
  }
  return step;
}

function pathMappingStep(input: RuntimeChecklistInput): ChecklistStep {
  const step: ChecklistStep = { id: 'path-mapping', title: 'Path Mapping', status: 'pending', detail: 'Not connected yet.', notes: [], fixes: [] };
  const conns = input.connections;
  for (const m of input.userMappings) step.notes.push(`settings: ${m.remote} → ${m.local}`);
  if (conns.length === 0) return step;

  const expanded = input.workspaceFolder ? resolvePathMappings(input.userMappings, input.workspaceFolder) : input.userMappings;
  const saved = new Set([...input.userMappings, ...expanded].map(mappingKey));
  const mount = uniqueMappings(conns.flatMap((c) => c.usedMountMappings));
  const url = uniqueMappings(conns.flatMap((c) => c.urlMappings));
  for (const m of mount) step.notes.push(`container mount: ${m.remote} → ${m.local}`);
  for (const m of url) step.notes.push(`browser URL: ${m.remote} → ${m.local}`);
  for (const m of [...mount, ...url]) {
    if (saved.has(mappingKey(m))) continue;
    step.fixes.push({ kind: 'save-mapping', label: `Save ${m.remote} → ${m.local}`, remote: m.remote, local: m.local });
  }
  const dirs = [...new Set(conns.flatMap((c) => c.outsideWorkspaceDirs))];
  for (const dir of dirs) {
    step.notes.push(`drawing logs outside the workspace, in ${dir}`);
    step.fixes.push({ kind: 'add-folder', label: `Add ${dir} to workspace`, path: dir });
  }

  const dropped = (reason: string): number => conns.reduce((sum, c) => sum + (c.droppedByReason[reason] ?? 0), 0);
  const unmapped = dropped('no-path-mapping');
  const mismatched = dropped('content-mismatch');
  const ambiguous = dropped('ambiguous-url-match');
  const problems: string[] = [];
  if (unmapped > 0) problems.push(`${unmapped} log(s) from paths no mapping covers`);
  if (mismatched > 0) problems.push(`${mismatched} log(s) whose file differs from what the runtime runs — check the mapping`);
  if (ambiguous > 0) problems.push(`${ambiguous} browser log(s) whose URL matches more than one file`);

  const mappingCount = input.userMappings.length + mount.length + url.length;
  if (unmapped > 0) {
    step.status = 'fail';
    step.fixes.push({ kind: 'open-settings', label: 'Declare a Path Mapping', query: 'ejsng.runtimeLog.pathMappings' });
  } else if (problems.length > 0) {
    step.status = 'warn';
  } else {
    step.status = 'ok';
  }
  step.detail =
    problems.length > 0
      ? problems.join('; ')
      : mappingCount > 0
        ? `${mappingCount} mapping(s) in use`
        : 'No mapping needed so far — Runtime Paths are paths on this machine.';
  return step;
}

function logsStep(input: RuntimeChecklistInput): ChecklistStep {
  const step: ChecklistStep = { id: 'logs', title: 'Logs', status: 'pending', detail: 'Not connected yet.', notes: [], fixes: [] };
  const conns = input.connections;
  const received = conns.reduce((sum, c) => sum + c.received, 0);
  const drawn = conns.reduce((sum, c) => sum + c.drawn, 0);
  const merged: Record<string, number> = {};
  for (const c of conns) {
    for (const [reason, count] of Object.entries(c.droppedByReason)) merged[reason] = (merged[reason] ?? 0) + count;
  }
  const dropGroups = groupDropReasons(merged);
  const dropped = dropGroups.reduce((sum, g) => sum + g.count, 0);
  step.counts = { received, drawn, dropped };
  step.dropGroups = dropGroups;
  if (conns.length === 0) return step;

  step.detail = `received ${received} / drawn ${drawn} / dropped ${dropped}`;
  if (received === 0) {
    step.status = 'pending';
    step.notes.push('Waiting for logs — make the app log something.');
  } else if (drawn === 0) {
    step.status = 'fail';
  } else {
    step.status = dropped > 0 ? 'warn' : 'ok';
  }

  const wrapper = conns
    .map((c) => c.wrapperSuggestion)
    .filter((s): s is { path: string; share: number } => s !== null)
    .sort((a, b) => b.share - a.share)[0];
  if (wrapper) {
    step.notes.push(`"${wrapper.path}" accounts for ${Math.round(wrapper.share * 100)}% of recent logs — looks like a logging wrapper.`);
    step.fixes.push({ kind: 'skip-frame', label: `Skip frames in ${wrapper.path}`, path: wrapper.path });
  }
  return step;
}

/** Build the panel's checklist, one step per link of the Connect chain, in chain order. */
export function buildRuntimeChecklist(input: RuntimeChecklistInput): ChecklistStep[] {
  const nodeConnections = input.connections.filter((c) => !isBrowserTarget(c.targetType));
  const browserConnections = input.connections.filter((c) => isBrowserTarget(c.targetType));
  return [
    environmentStep(input),
    dockerStep(input),
    connectionStep(input, 'node', nodeConnections),
    connectionStep(input, 'browser', browserConnections),
    pathMappingStep(input),
    logsStep(input),
  ];
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const STATUS_MARK: Record<ChecklistStatus, string> = { ok: '✔', warn: '⚠', fail: '✖', pending: '…', skipped: '–' };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the user's home directory with `~` wherever it starts a path (user story #37). Only
 * whole path prefixes: `/home/me` becomes `~` in `/home/me/app`, but `/home/meg` is left alone.
 * Container paths such as `/home/cityos/...` are not the user's home and stay as they are.
 */
export function redactHomeDirectory(text: string, homeDirectory: string): string {
  const home = homeDirectory.replace(/[\\/]+$/, '');
  if (!home) return text;
  return text.replace(new RegExp(`${escapeRegExp(home)}(?=[\\\\/]|$|[\\s\`'")\\]])`, 'g'), '~');
}

export interface RuntimeReportContext {
  homeDirectory: string;
  /** Human-readable OS of the workspace side, e.g. `linux 5.15.167.4-microsoft-standard-WSL2`. */
  os: string;
  /** Extension/server version, when known. */
  version?: string;
}

/**
 * The markdown behind "Copy report" (user stories #36-37): OS, remote type, Docker, endpoints,
 * browser, every checklist step with its reason, and dropped logs by reason. Log VALUES are never
 * included — only paths and counts — and the home directory is replaced by `~`. Building it sends
 * nothing anywhere; the client only puts it on the clipboard.
 */
export function buildRuntimeReport(input: RuntimeChecklistInput, context: RuntimeReportContext): string {
  const steps = buildRuntimeChecklist(input);
  const env = input.environment;
  const lines: string[] = ['## EJS/NG runtime log report', ''];
  if (context.version) lines.push(`- Version: ${context.version}`);
  lines.push(`- OS: ${context.os}`);
  lines.push(`- Environment: ${env ? describeEnvironment(env) : 'not detected (Connect not run)'}`);
  const docker = env?.docker;
  lines.push(
    `- Docker: ${
      !docker ? 'not checked' : docker.state === 'available' ? `available (${docker.version})` : docker.state === 'missing' ? 'not installed' : `error — ${docker.message}`
    }`,
  );
  if (input.containers) {
    const containers = input.containers.map(
      (c) => `${describeContainer(c)} (inspector ${c.hostInspectorPort === null ? `${c.inspectorContainerPort}, not published` : c.hostInspectorPort})`,
    );
    lines.push(`- Containers: ${containers.length > 0 ? containers.join('; ') : 'none with --inspect'}`);
  }
  lines.push(
    `- Endpoints: ${
      input.connections.length > 0 ? input.connections.map((c) => `${c.targetType} ${describeConnection(c)}`).join('; ') : 'none'
    }`,
  );
  lines.push(`- Browser: ${input.browser ?? 'not launched from the panel'}`);
  lines.push('', '### Checklist', '');
  for (const step of steps) {
    lines.push(`- ${STATUS_MARK[step.status]} **${step.title}** — ${step.detail}`);
    for (const note of step.notes) lines.push(`  - ${note}`);
  }
  const groups = steps.find((s) => s.id === 'logs')?.dropGroups ?? [];
  lines.push('', '### Dropped logs by reason', '');
  if (groups.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Reason | Count |', '| --- | ---: |');
    for (const g of groups) lines.push(`| ${g.label} (\`${g.reason}\`) | ${g.count} |`);
  }
  lines.push('');
  return redactHomeDirectory(lines.join('\n'), context.homeDirectory);
}
