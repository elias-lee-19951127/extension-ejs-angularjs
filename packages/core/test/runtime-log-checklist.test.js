/**
 * Seam 2 of ticket 09 (.scratch/runtime-remote-env/issues/09-panel-danh-sach-kiem-tra.md): the
 * pure checklist and report the panel shows. The server only gathers the snapshot; every decision
 * about what a step says, which fixes it offers, and what the report contains is made here.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  environmentKindFromRemoteName,
  wslNetworkingModeFrom,
  buildRuntimeChecklist,
  buildRuntimeReport,
  groupDropReasons,
  composeInspectorSnippet,
  redactHomeDirectory,
  resolveDockerCandidates,
  parseDockerInspect,
} = require('../dist');

const DOCKER_OK = { state: 'available', version: '27.1.1' };

function env(overrides = {}) {
  return { kind: 'local', remoteName: null, platform: 'linux', clientPlatform: null, wslNetworking: null, docker: DOCKER_OK, ...overrides };
}

function conn(overrides = {}) {
  return {
    key: '127.0.0.1:9229:t1',
    endpoint: '127.0.0.1:9229',
    targetType: 'node',
    title: 'www',
    containerName: 'cityos-web',
    state: 'connected',
    received: 0,
    drawn: 0,
    droppedByReason: {},
    usedMountMappings: [],
    urlMappings: [],
    outsideWorkspaceDirs: [],
    wrapperSuggestion: null,
    ...overrides,
  };
}

function input(overrides = {}) {
  return { environment: env(), containers: [], connections: [], userMappings: [], workspaceFolder: '/ws', browser: null, ...overrides };
}

function step(steps, id) {
  return steps.find((s) => s.id === id);
}

test('environmentKindFromRemoteName: VS Code remote names map to environment kinds', () => {
  assert.strictEqual(environmentKindFromRemoteName(undefined), 'local');
  assert.strictEqual(environmentKindFromRemoteName(null), 'local');
  assert.strictEqual(environmentKindFromRemoteName('wsl'), 'wsl');
  assert.strictEqual(environmentKindFromRemoteName('ssh-remote'), 'ssh');
  assert.strictEqual(environmentKindFromRemoteName('dev-container'), 'container');
  assert.strictEqual(environmentKindFromRemoteName('attached-container'), 'container');
  assert.strictEqual(environmentKindFromRemoteName('codespaces'), 'codespace');
  assert.strictEqual(environmentKindFromRemoteName('some-third-party'), 'other-remote');
});

test('wslNetworkingModeFrom: an explicit networkingMode under [wsl2] decides', () => {
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: '[wsl2]\nnetworkingMode=mirrored\n' }), 'mirrored');
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: '[wsl2]\r\nmemory=8GB\r\nNetworkingMode = NAT\r\n' }), 'nat');
});

test('wslNetworkingModeFrom: a readable .wslconfig without networkingMode is WSL default, NAT — even with interfaces that say otherwise', () => {
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: '[wsl2]\nmemory=8GB\n', ipAddr: '3: loopback0 inet 127.0.0.1' }), 'nat');
});

test('wslNetworkingModeFrom: networkingMode outside [wsl2], or commented out, does not count', () => {
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: '[experimental]\nnetworkingMode=mirrored\n' }), 'nat');
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: '[wsl2]\n# networkingMode=mirrored\n' }), 'nat');
});

test('wslNetworkingModeFrom: an unknown value is reported as unknown, not guessed', () => {
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: '[wsl2]\nnetworkingMode=virtioproxy\n' }), 'unknown');
});

test('wslNetworkingModeFrom: without .wslconfig, loopback0 means mirrored and eth0 on 172.16/12 means NAT', () => {
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: null, ipAddr: '1: lo inet 127.0.0.1/8\n3: loopback0 inet 10.255.255.254/32' }), 'mirrored');
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: null, ipAddr: '2: eth0    inet 172.23.140.5/20 brd 172.23.143.255' }), 'nat');
  assert.strictEqual(wslNetworkingModeFrom({ wslconfig: null, ipAddr: '2: eth0    inet 192.168.1.20/24' }), 'unknown');
  assert.strictEqual(wslNetworkingModeFrom({}), 'unknown');
});

test('buildRuntimeChecklist: before Connect ever ran, every step is pending — in chain order', () => {
  const steps = buildRuntimeChecklist(input({ environment: null, containers: null }));
  assert.deepStrictEqual(steps.map((s) => s.id), ['environment', 'docker', 'node', 'browser', 'path-mapping', 'logs']);
  assert.deepStrictEqual(steps.map((s) => s.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
});

test('buildRuntimeChecklist: WSL in NAT mode warns on environment, fails the browser, and offers the mirrored guide — never edits .wslconfig', () => {
  const steps = buildRuntimeChecklist(input({ environment: env({ kind: 'wsl', remoteName: 'wsl', wslNetworking: 'nat' }) }));
  const environment = step(steps, 'environment');
  assert.strictEqual(environment.status, 'warn');
  assert.match(environment.detail, /networking: nat/);
  assert.ok(environment.notes.some((n) => n.includes('networkingMode=mirrored')));
  assert.ok(environment.notes.some((n) => n.includes('wsl --shutdown')));
  assert.deepStrictEqual(environment.fixes.map((f) => f.kind), ['open-mirrored-guide']);
  const browser = step(steps, 'browser');
  assert.strictEqual(browser.status, 'fail');
  assert.deepStrictEqual(browser.fixes.map((f) => f.kind), ['open-mirrored-guide']);
});

test('buildRuntimeChecklist: WSL in mirrored mode is simply ok', () => {
  const steps = buildRuntimeChecklist(input({ environment: env({ kind: 'wsl', remoteName: 'wsl', wslNetworking: 'mirrored' }) }));
  assert.strictEqual(step(steps, 'environment').status, 'ok');
  assert.deepStrictEqual(step(steps, 'environment').fixes, []);
});

test('buildRuntimeChecklist: no Docker CLI is skipped, not a failure', () => {
  const steps = buildRuntimeChecklist(input({ environment: env({ docker: { state: 'missing' } }), containers: null }));
  assert.strictEqual(step(steps, 'docker').status, 'skipped');
});

test('buildRuntimeChecklist: a container with --inspect but no published inspector offers a compose snippet to copy', () => {
  const containers = resolveDockerCandidates(
    parseDockerInspect([
      {
        Id: 'w'.repeat(64),
        Name: '/cityos-worker',
        State: { Running: true },
        Config: { Cmd: ['node', '--inspect=0.0.0.0:9230', 'worker.js'], Env: [] },
        NetworkSettings: { Ports: { '9230/tcp': null } },
        Mounts: [],
      },
    ]),
  ).map((c) => ({ name: c.containerName, appPorts: c.appPorts, hostInspectorPort: c.hostInspectorPort, inspectorContainerPort: c.inspectorContainerPort }));
  const docker = step(buildRuntimeChecklist(input({ containers })), 'docker');
  assert.strictEqual(docker.status, 'warn');
  assert.strictEqual(docker.fixes.length, 1);
  assert.strictEqual(docker.fixes[0].kind, 'copy-compose');
  assert.match(docker.fixes[0].snippet, /cityos-worker:/);
  assert.match(docker.fixes[0].snippet, /--inspect=0\.0\.0\.0:9230/);
  assert.match(docker.fixes[0].snippet, /"9230:9230"/);
});

test('buildRuntimeChecklist: a connectable container is named with its app port', () => {
  const containers = [{ name: 'cityos-web', appPorts: [5000], hostInspectorPort: 9229, inspectorContainerPort: 9229 }];
  const docker = step(buildRuntimeChecklist(input({ containers })), 'docker');
  assert.strictEqual(docker.status, 'ok');
  assert.match(docker.detail, /cityos-web: 5000/);
});

test('buildRuntimeChecklist: Connect ran but nothing connected fails the Node step', () => {
  const steps = buildRuntimeChecklist(input());
  assert.strictEqual(step(steps, 'node').status, 'fail');
});

test('buildRuntimeChecklist: a failed connection shows its reason', () => {
  const node = step(buildRuntimeChecklist(input({ connections: [conn({ state: 'failed', reason: 'ECONNREFUSED' })] })), 'node');
  assert.strictEqual(node.status, 'fail');
  assert.match(node.detail, /ECONNREFUSED/);
});

test('buildRuntimeChecklist: a browser tab counts as the browser step, not the Node one', () => {
  const steps = buildRuntimeChecklist(input({ connections: [conn({ targetType: 'page', containerName: null, title: 'App', endpoint: '127.0.0.1:9222' })] }));
  assert.strictEqual(step(steps, 'browser').status, 'ok');
  assert.strictEqual(step(steps, 'node').status, 'skipped');
});

test('buildRuntimeChecklist: logs dropped for a missing mapping fail the Path Mapping step, with a way to declare one', () => {
  const steps = buildRuntimeChecklist(input({ connections: [conn({ received: 4, drawn: 1, droppedByReason: { 'no-path-mapping': 3 } })] }));
  const mapping = step(steps, 'path-mapping');
  assert.strictEqual(mapping.status, 'fail');
  assert.match(mapping.detail, /3 log\(s\) from paths no mapping covers/);
  assert.ok(mapping.fixes.some((f) => f.kind === 'open-settings'));
});

test('buildRuntimeChecklist: mount and URL mappings in use are offered for saving; ones already in settings are not', () => {
  const saved = { remote: '/home/cityos/aocs-cityos/aocs', local: '/home/me/projects/aocs' };
  const url = { remote: 'http://localhost:5000', local: '/ws/public' };
  const steps = buildRuntimeChecklist(
    input({
      userMappings: [saved],
      connections: [conn({ received: 1, drawn: 1, usedMountMappings: [saved], urlMappings: [url] })],
    }),
  );
  const mapping = step(steps, 'path-mapping');
  assert.strictEqual(mapping.status, 'ok');
  assert.deepStrictEqual(
    mapping.fixes.filter((f) => f.kind === 'save-mapping').map((f) => [f.remote, f.local]),
    [[url.remote, url.local]],
  );
});

test('buildRuntimeChecklist: a mapping saved as ${workspaceFolder}/… is recognized as saved, and listed once', () => {
  const steps = buildRuntimeChecklist(
    input({
      workspaceFolder: '/home/me/ws',
      userMappings: [{ remote: '/app', local: '${workspaceFolder}/aocs' }],
      connections: [conn({ received: 1, drawn: 1, usedMountMappings: [{ remote: '/app', local: '/home/me/ws/aocs' }] })],
    }),
  );
  const mapping = step(steps, 'path-mapping');
  assert.deepStrictEqual(mapping.fixes.filter((f) => f.kind === 'save-mapping'), []);
  assert.strictEqual(mapping.notes.filter((n) => n.startsWith('settings:')).length, 1);
});

test('buildRuntimeChecklist: a directory drawn outside the workspace offers "add to workspace"', () => {
  const steps = buildRuntimeChecklist(input({ connections: [conn({ received: 1, drawn: 1, outsideWorkspaceDirs: ['/home/me/projects/aocs/utility'] })] }));
  assert.deepStrictEqual(
    step(steps, 'path-mapping').fixes.filter((f) => f.kind === 'add-folder').map((f) => f.path),
    ['/home/me/projects/aocs/utility'],
  );
});

test('buildRuntimeChecklist: the logs step counts received/drawn/dropped and groups drops by reason, largest first', () => {
  const steps = buildRuntimeChecklist(
    input({
      connections: [
        conn({ received: 10, drawn: 4, droppedByReason: { 'stale-file': 1, 'all-frames-skipped': 3 } }),
        conn({ key: 'b', received: 2, drawn: 0, droppedByReason: { 'stale-file': 2 } }),
      ],
    }),
  );
  const logs = step(steps, 'logs');
  assert.strictEqual(logs.status, 'warn');
  assert.deepStrictEqual(logs.counts, { received: 12, drawn: 4, dropped: 6 });
  assert.deepStrictEqual(logs.dropGroups.map((g) => [g.reason, g.count]), [['all-frames-skipped', 3], ['stale-file', 3]]);
  assert.match(logs.dropGroups.find((g) => g.reason === 'stale-file').label, /restart/);
});

test('buildRuntimeChecklist: logs received but none drawn fails; a wrapper suggestion offers to skip its frames', () => {
  const steps = buildRuntimeChecklist(
    input({ connections: [conn({ received: 30, drawn: 0, droppedByReason: { 'all-frames-skipped': 30 }, wrapperSuggestion: { path: 'lib/log.js', share: 0.9 } })] }),
  );
  const logs = step(steps, 'logs');
  assert.strictEqual(logs.status, 'fail');
  assert.deepStrictEqual(logs.fixes, [{ kind: 'skip-frame', label: 'Skip frames in lib/log.js', path: 'lib/log.js' }]);
});

test('groupDropReasons: zero counts are left out and an unknown reason keeps its id as label', () => {
  assert.deepStrictEqual(groupDropReasons({ 'stale-file': 0, 'brand-new-reason': 2 }), [
    { reason: 'brand-new-reason', label: 'brand-new-reason', count: 2 },
  ]);
});

test('composeInspectorSnippet: binds the inspector to every interface and publishes the port', () => {
  assert.strictEqual(
    composeInspectorSnippet('cityos-app', 9229),
    [
      'services:',
      '  cityos-app:',
      '    # Listen on every interface inside the container, not only its own 127.0.0.1',
      '    command: node --inspect=0.0.0.0:9229 <your entry file>',
      '    ports:',
      '      - "9229:9229"',
    ].join('\n'),
  );
});

test('redactHomeDirectory: replaces only whole home-directory prefixes', () => {
  assert.strictEqual(redactHomeDirectory('/home/me/app.js and /home/me', '/home/me'), '~/app.js and ~');
  assert.strictEqual(redactHomeDirectory('/home/meg/app.js', '/home/me'), '/home/meg/app.js');
  assert.strictEqual(redactHomeDirectory('/home/cityos/aocs-cityos/x.js', '/home/me/'), '/home/cityos/aocs-cityos/x.js');
  assert.strictEqual(redactHomeDirectory('C:\\Users\\me\\app', 'C:\\Users\\me'), '~\\app');
});

test('buildRuntimeReport: covers OS, environment, Docker, endpoints, browser, every step, and drops — with home as ~', () => {
  const home = '/home/phulh11';
  const report = buildRuntimeReport(
    input({
      environment: env({ kind: 'wsl', remoteName: 'wsl', wslNetworking: 'mirrored' }),
      containers: [{ name: 'cityos-web', appPorts: [5000], hostInspectorPort: 9229, inspectorContainerPort: 9229 }],
      connections: [
        conn({
          received: 5,
          drawn: 2,
          droppedByReason: { 'shadowed-file': 3 },
          outsideWorkspaceDirs: [`${home}/projects/aocs/utility`],
        }),
      ],
      browser: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    }),
    { homeDirectory: home, os: 'linux 5.15-microsoft-standard-WSL2', version: '0.2.3' },
  );
  assert.match(report, /OS: linux 5\.15-microsoft-standard-WSL2/);
  assert.match(report, /Environment: Remote-WSL/);
  assert.match(report, /Docker: available \(27\.1\.1\)/);
  assert.match(report, /cityos-web: 5000/);
  assert.match(report, /Endpoints: node cityos-web \(127\.0\.0\.1:9229\) connected/);
  assert.match(report, /Browser: \/mnt\/c\/Program Files/);
  for (const title of ['Environment', 'Docker / container', 'Node connection', 'Browser connection', 'Path Mapping', 'Logs']) {
    assert.ok(report.includes(`**${title}**`), `missing step ${title}`);
  }
  assert.match(report, /\| Shadowed File .*\| 3 \|/);
  assert.ok(report.includes('~/projects/aocs/utility'));
  assert.ok(!report.includes(home));
});
