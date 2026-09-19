/**
 * Path Mappings as a Remote-WSL user actually writes them (reported 2026-09-19): `local` pasted as a
 * Windows `\\wsl.localhost\…` path, and a broad mount listed before the nested one it contains.
 * Both sent every log under the nested mount to a path that doesn't exist, reported only as
 * "file not readable". Also: `node:*` built-ins skipped, and one noisy stack no longer flooding the
 * panel's recent logs. End-to-end: packages/server/test/runtime-log-wsl-mappings.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  wslUncToLinuxPath,
  prepareDeclaredMappings,
  mapContainerPath,
  matchesSkipPattern,
  DEFAULT_SKIP_FRAME_PATTERNS,
  recordFrameDiagnostic,
  buildRuntimeChecklist,
} = require('../dist');

test('wslUncToLinuxPath: both UNC spellings, either slash, map to the Linux path; anything else is null', () => {
  assert.strictEqual(wslUncToLinuxPath('\\\\wsl.localhost\\AlmaLinux-9\\home\\phulh11\\projects\\aocs'), '/home/phulh11/projects/aocs');
  assert.strictEqual(wslUncToLinuxPath('\\\\wsl$\\Ubuntu\\srv\\app\\'), '/srv/app');
  assert.strictEqual(wslUncToLinuxPath('//wsl.localhost/Ubuntu/home/me'), '/home/me');
  assert.strictEqual(wslUncToLinuxPath('\\\\WSL.LOCALHOST\\Ubuntu'), '/');
  assert.strictEqual(wslUncToLinuxPath('C:\\Users\\me'), null);
  assert.strictEqual(wslUncToLinuxPath('/home/me'), null);
  assert.strictEqual(wslUncToLinuxPath('\\\\server\\share\\x'), null);
});

const REPORTED = [
  { remote: '/home/cityos/aocs-cityos', local: '\\\\wsl.localhost\\AlmaLinux-9\\home\\phulh11\\projects\\aocs-cityos-lusail' },
  { remote: '/home/cityos/aocs-cityos/aocs', local: '\\\\wsl.localhost\\AlmaLinux-9\\home\\phulh11\\projects\\aocs' },
];

test('prepareDeclaredMappings: the reported settings now send a nested-mount path to the nested mount, as a Linux path', () => {
  const mappings = prepareDeclaredMappings(REPORTED, '/ws', 'linux');
  assert.deepStrictEqual(mappings, [
    { remote: '/home/cityos/aocs-cityos/aocs', local: '/home/phulh11/projects/aocs' },
    { remote: '/home/cityos/aocs-cityos', local: '/home/phulh11/projects/aocs-cityos-lusail' },
  ]);
  assert.strictEqual(
    mapContainerPath('/home/cityos/aocs-cityos/aocs/aocs-messaging/aocs-messaging-do.js', mappings).path,
    '/home/phulh11/projects/aocs/aocs-messaging/aocs-messaging-do.js',
  );
  assert.strictEqual(mapContainerPath('/home/cityos/aocs-cityos/bin/www', mappings).path, '/home/phulh11/projects/aocs-cityos-lusail/bin/www');
});

test('prepareDeclaredMappings: on a Windows server the UNC path is left alone; equal-length remotes keep their order; ${workspaceFolder} expands', () => {
  assert.strictEqual(prepareDeclaredMappings(REPORTED, '/ws', 'win32')[0].local, REPORTED[1].local);
  assert.deepStrictEqual(
    prepareDeclaredMappings(
      [
        { remote: '/a', local: '${workspaceFolder}/one' },
        { remote: '/b', local: '/two' },
      ],
      '/ws',
      'linux',
    ),
    [
      { remote: '/a', local: '/ws/one' },
      { remote: '/b', local: '/two' },
    ],
  );
});

test('DEFAULT_SKIP_FRAME_PATTERNS: node:events and other built-ins are skipped, a user path containing "node:" is not', () => {
  assert.strictEqual(matchesSkipPattern('node:events', DEFAULT_SKIP_FRAME_PATTERNS), 'node:*');
  assert.strictEqual(matchesSkipPattern('node:timers', DEFAULT_SKIP_FRAME_PATTERNS), 'node:*');
  assert.strictEqual(matchesSkipPattern('/srv/app/node:weird.js', DEFAULT_SKIP_FRAME_PATTERNS), null);
});

function story(at, url, chosenPath = null) {
  return { at, chosenPath, frames: [{ url, lineNumber: 3, columnNumber: 1, skipReason: chosenPath ? null : 'unreadable-file' }] };
}

test('recordFrameDiagnostic: a repeated stack keeps one slot (moved to the end, counted), so a different log is not pushed out', () => {
  const buffer = [];
  recordFrameDiagnostic(buffer, story(1, '/srv/service.js', 'service.js'), 3);
  for (let at = 2; at <= 50; at++) recordFrameDiagnostic(buffer, story(at, '/srv/messaging.js'), 3);
  assert.strictEqual(buffer.length, 2);
  assert.strictEqual(buffer[0].chosenPath, 'service.js');
  assert.strictEqual(buffer[0].count, undefined);
  assert.strictEqual(buffer[1].count, 49);
  assert.strictEqual(buffer[1].at, 50);
});

test('recordFrameDiagnostic: still bounded, oldest distinct story dropped first', () => {
  const buffer = [];
  for (let i = 0; i < 5; i++) recordFrameDiagnostic(buffer, story(i, `/srv/f${i}.js`), 3);
  assert.deepStrictEqual(buffer.map((d) => d.frames[0].url), ['/srv/f2.js', '/srv/f3.js', '/srv/f4.js']);
});

function checklistInput(overrides) {
  return {
    environment: { kind: 'wsl', remoteName: 'wsl', platform: 'linux', clientPlatform: 'win32', wslNetworking: 'nat', docker: { state: 'available', version: '27' } },
    containers: [],
    connections: [
      {
        key: 'k',
        endpoint: '127.0.0.1:9229',
        targetType: 'node',
        title: 'www',
        containerName: 'cityos-web',
        state: 'connected',
        received: 5,
        drawn: 0,
        droppedByReason: { 'unreadable-file': 5 },
        usedMountMappings: [],
        urlMappings: [],
        outsideWorkspaceDirs: [],
        wrapperSuggestion: null,
      },
    ],
    userMappings: REPORTED,
    workspaceFolder: '/home/phulh11/projects/aocs-cityos-lusail',
    browser: null,
    serverPlatform: 'linux',
    ...overrides,
  };
}

test('checklist: the reported settings are called out — Windows path with its Linux spelling, the reordering, and the unreadable logs', () => {
  const mapping = buildRuntimeChecklist(checklistInput()).find((s) => s.id === 'path-mapping');
  assert.strictEqual(mapping.status, 'warn');
  assert.ok(mapping.notes.some((n) => n.includes('a Windows path, read as /home/phulh11/projects/aocs ')), mapping.notes.join('\n'));
  assert.ok(mapping.notes.some((n) => n.includes('applied most specific first')));
  assert.match(mapping.detail, /5 log\(s\) whose mapped file doesn't exist/);
  assert.match(mapping.detail, /Windows \(\\\\wsl\.localhost\) path/);
});

test('checklist: on a Windows server a UNC mapping is fine and not flagged', () => {
  const mapping = buildRuntimeChecklist(checklistInput({ serverPlatform: 'win32', connections: [] })).find((s) => s.id === 'path-mapping');
  assert.ok(!mapping.notes.some((n) => n.includes('Windows path')));
});

// ---- Unpublished inspector reached at the container's own IP ----

const { parseDockerInspect, resolveDockerCandidates } = require('../dist');

test('parseDockerInspect: container IPs come from every attached network (and the legacy field), de-duplicated', () => {
  const [info] = parseDockerInspect([
    {
      Id: 'x',
      Name: '/cityos-app',
      State: { Running: true },
      Config: { Cmd: ['node', '--inspect=0.0.0.0:9229', 'bin/www'], Env: [] },
      NetworkSettings: { IPAddress: '172.18.0.5', Ports: {}, Networks: { a: { IPAddress: '172.18.0.5' }, b: { IPAddress: '10.0.1.7' }, c: { IPAddress: '' } } },
      Mounts: [],
    },
  ]);
  assert.deepStrictEqual(info.ipAddresses, ['172.18.0.5', '10.0.1.7']);
  const [candidate] = resolveDockerCandidates([info]);
  assert.strictEqual(candidate.hostInspectorPort, null);
  assert.deepStrictEqual(candidate.containerIps, ['172.18.0.5', '10.0.1.7']);
});

test('checklist: a container reached at its IP counts as found, with a note saying how; one that is not is still flagged', () => {
  const docker = (containers) =>
    buildRuntimeChecklist(checklistInput({ containers, connections: [] })).find((s) => s.id === 'docker');
  const viaIp = { name: 'cityos-app', appPorts: [3000], hostInspectorPort: null, inspectorContainerPort: 9229, containerIpEndpoint: '172.18.0.5:9229' };
  const ok = docker([viaIp]);
  assert.strictEqual(ok.status, 'ok');
  assert.ok(ok.notes.some((n) => n.includes('reached at its container IP 172.18.0.5:9229')));
  const dead = docker([{ ...viaIp, containerIpEndpoint: null }]);
  assert.strictEqual(dead.status, 'warn');
  assert.ok(dead.fixes.some((f) => f.kind === 'copy-compose'));
});
