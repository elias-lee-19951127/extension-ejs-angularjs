/**
 * Pure functions behind ticket 04 (.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md):
 * turn `docker inspect` JSON into Runtime Target candidates, without any `docker`/network IO —
 * shelling out to the real CLI stays in packages/server/src/docker.ts (this file's counterpart).
 *
 * Fixtures below are modeled on the real machine described in the "facts established on the
 * user's machine" section of .scratch/runtime-remote-env/decisions.md:
 * `cityos-web` publishes app port 5000 and inspector 9229 straight through; `cityos-app` remaps
 * its inspector to host port 9228 (`9228->9229`, via NODE_OPTIONS instead of a Cmd flag); mounts
 * nest (`aocs-cityos-lusail` -> `.../aocs-cityos`, `aocs` -> `.../aocs-cityos/aocs`, the second
 * shadowing part of the first).
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  parseDockerInspect,
  resolveDockerCandidates,
  partitionDockerCandidates,
  findDockerCandidateByAppPort,
  formatDockerCandidateLabel,
} = require('../dist');

/** A minimal-but-realistic `docker inspect` entry — only the fields this feature reads. */
function containerFixture(overrides) {
  return {
    Id: 'id'.padEnd(64, '0'),
    Name: '/container',
    State: { Running: true },
    Config: { Cmd: [], Env: [] },
    NetworkSettings: { Ports: {} },
    Mounts: [],
    ...overrides,
  };
}

const CITYOS_WEB = containerFixture({
  Id: 'c1'.padEnd(64, '1'),
  Name: '/cityos-web',
  Config: {
    Cmd: ['node', '--inspect=0.0.0.0:9229', 'server.js'],
    Env: ['NODE_ENV=production', 'PATH=/usr/local/bin:/usr/bin:/bin'],
  },
  NetworkSettings: {
    Ports: {
      '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }],
      '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: '9229' }],
    },
  },
  Mounts: [
    {
      Type: 'bind',
      Source: '/home/user/projects/aocs-cityos-lusail',
      Destination: '/home/cityos/aocs-cityos',
      Mode: 'rw',
      RW: true,
      Propagation: 'rprivate',
    },
    {
      Type: 'bind',
      Source: '/home/user/projects/aocs',
      Destination: '/home/cityos/aocs-cityos/aocs',
      Mode: 'rw',
      RW: true,
      Propagation: 'rprivate',
    },
  ],
});

/** `cityos-app`: inspector remapped to an unusual host port (9228 -> 9229) via NODE_OPTIONS, not a Cmd flag. */
const CITYOS_APP = containerFixture({
  Id: 'a2'.padEnd(64, '2'),
  Name: '/cityos-app',
  Config: {
    Cmd: ['node', 'app.js'],
    Env: ['NODE_ENV=production', 'NODE_OPTIONS=--inspect=0.0.0.0:9229'],
  },
  NetworkSettings: {
    Ports: {
      '5001/tcp': [{ HostIp: '0.0.0.0', HostPort: '5001' }],
      '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: '9228' }],
    },
  },
  Mounts: [
    {
      Type: 'bind',
      Source: '/home/user/projects/aocs',
      Destination: '/home/cityos/aocs-cityos/aocs',
      Mode: 'rw',
      RW: true,
      Propagation: 'rprivate',
    },
  ],
});

/** A Node process with `--inspect` enabled but never published to the host at all. */
const CITYOS_WORKER = containerFixture({
  Id: 'w3'.padEnd(64, '3'),
  Name: '/cityos-worker',
  Config: { Cmd: ['node', '--inspect', 'worker.js'], Env: ['NODE_ENV=production'] },
  NetworkSettings: { Ports: {} },
});

/** Not a Node container at all — must never surface as a candidate. */
const CITYOS_DB = containerFixture({
  Id: 'd4'.padEnd(64, '4'),
  Name: '/cityos-db',
  Config: { Cmd: ['postgres'], Env: ['POSTGRES_PASSWORD=x'] },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } },
});

test('parseDockerInspect: reads id/name/ports/mounts/inspector port from a --inspect Cmd flag', () => {
  const [web] = parseDockerInspect([CITYOS_WEB]);
  assert.strictEqual(web.id, CITYOS_WEB.Id);
  assert.strictEqual(web.name, 'cityos-web'); // leading "/" stripped
  assert.strictEqual(web.running, true);
  assert.strictEqual(web.inspectorContainerPort, 9229);
  assert.deepStrictEqual(
    web.ports.slice().sort((a, b) => a.containerPort - b.containerPort),
    [
      { containerPort: 5000, hostPort: 5000, protocol: 'tcp' },
      { containerPort: 9229, hostPort: 9229, protocol: 'tcp' },
    ],
  );
  assert.deepStrictEqual(web.mounts, [
    { source: '/home/user/projects/aocs-cityos-lusail', destination: '/home/cityos/aocs-cityos' },
    { source: '/home/user/projects/aocs', destination: '/home/cityos/aocs-cityos/aocs' },
  ]);
});

test('parseDockerInspect: finds --inspect inside NODE_OPTIONS, not just the Cmd array', () => {
  const [app] = parseDockerInspect([CITYOS_APP]);
  assert.strictEqual(app.inspectorContainerPort, 9229);
});

test('parseDockerInspect: finds --inspect on Config.Entrypoint too, not just Config.Cmd — Docker runs entrypoint + cmd as one command line', () => {
  const entrypointOnly = containerFixture({
    Id: 'e5'.padEnd(64, '5'),
    Name: '/cityos-entry',
    Config: { Entrypoint: ['node', '--inspect=0.0.0.0:9229'], Cmd: ['server.js'], Env: [] },
    NetworkSettings: { Ports: { '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: '9229' }] } },
  });
  const [entry] = parseDockerInspect([entrypointOnly]);
  assert.strictEqual(entry.inspectorContainerPort, 9229);
});

test('parseDockerInspect: bare --inspect with no host:port defaults to Node\'s inspector port 9229', () => {
  const [worker] = parseDockerInspect([CITYOS_WORKER]);
  assert.strictEqual(worker.inspectorContainerPort, 9229);
  assert.deepStrictEqual(worker.ports, []);
});

test('parseDockerInspect: a container with no --inspect anywhere has a null inspector port', () => {
  const [db] = parseDockerInspect([CITYOS_DB]);
  assert.strictEqual(db.inspectorContainerPort, null);
});

test('parseDockerInspect: skips malformed entries instead of throwing — docker is a local peer, not fully trusted input', () => {
  assert.deepStrictEqual(parseDockerInspect([null, 42, {}, { Id: 'x' }]), []);
  assert.deepStrictEqual(parseDockerInspect('not an array'), []);
  assert.deepStrictEqual(parseDockerInspect(undefined), []);
});

test('resolveDockerCandidates: infers the HOST inspector port by matching the CONTAINER side of a published pair', () => {
  const candidates = resolveDockerCandidates(parseDockerInspect([CITYOS_WEB, CITYOS_APP]));
  const web = candidates.find((c) => c.containerName === 'cityos-web');
  const app = candidates.find((c) => c.containerName === 'cityos-app');
  assert.strictEqual(web.hostInspectorPort, 9229); // straight through
  assert.strictEqual(app.hostInspectorPort, 9228); // remapped: 9228(host) -> 9229(container) — the whole point of matching by container side
});

test('resolveDockerCandidates: app port is every published port OTHER than the inspector, not the inspector itself', () => {
  const [web] = resolveDockerCandidates(parseDockerInspect([CITYOS_WEB]));
  assert.deepStrictEqual(web.appPorts, [5000]);
});

test('resolveDockerCandidates: a Node container with no published inspector port still appears, with hostInspectorPort null', () => {
  const [worker] = resolveDockerCandidates(parseDockerInspect([CITYOS_WORKER]));
  assert.strictEqual(worker.containerName, 'cityos-worker');
  assert.strictEqual(worker.hostInspectorPort, null);
});

test('resolveDockerCandidates: a non-Node container (no --inspect at all) is not a candidate', () => {
  const candidates = resolveDockerCandidates(parseDockerInspect([CITYOS_DB]));
  assert.deepStrictEqual(candidates, []);
});

test('resolveDockerCandidates: a stopped container is not a candidate even if it once had --inspect', () => {
  const stopped = containerFixture({
    Id: 's5'.padEnd(64, '5'),
    Name: '/stopped-app',
    State: { Running: false },
    Config: { Cmd: ['node', '--inspect=0.0.0.0:9229'], Env: [] },
    NetworkSettings: { Ports: { '9229/tcp': [{ HostIp: '0.0.0.0', HostPort: '9229' }] } },
  });
  assert.deepStrictEqual(resolveDockerCandidates(parseDockerInspect([stopped])), []);
});

test('partitionDockerCandidates: splits connectable (host port known) from unreachable (no published inspector)', () => {
  const candidates = resolveDockerCandidates(parseDockerInspect([CITYOS_WEB, CITYOS_WORKER]));
  const { connectable, unreachable } = partitionDockerCandidates(candidates);
  assert.deepStrictEqual(connectable.map((c) => c.containerName), ['cityos-web']);
  assert.deepStrictEqual(unreachable.map((c) => c.containerName), ['cityos-worker']);
});

test('findDockerCandidateByAppPort: typing the app port (5000) finds the container that PUBLISHES it', () => {
  const candidates = resolveDockerCandidates(parseDockerInspect([CITYOS_WEB, CITYOS_APP]));
  const found = findDockerCandidateByAppPort(candidates, 5001);
  assert.strictEqual(found.containerName, 'cityos-app');
});

test('findDockerCandidateByAppPort: no container publishes that port -> null, not a throw', () => {
  const candidates = resolveDockerCandidates(parseDockerInspect([CITYOS_WEB]));
  assert.strictEqual(findDockerCandidateByAppPort(candidates, 4999), null);
});

test('formatDockerCandidateLabel: "<container name>: <app port>" — matches the Quick Pick phrasing from the spec', () => {
  const [web] = resolveDockerCandidates(parseDockerInspect([CITYOS_WEB]));
  assert.strictEqual(formatDockerCandidateLabel(web), 'cityos-web: 5000');
});

test('formatDockerCandidateLabel: a container with no published app port says so instead of showing an empty port', () => {
  const [worker] = resolveDockerCandidates(parseDockerInspect([CITYOS_WORKER]));
  assert.strictEqual(formatDockerCandidateLabel(worker), 'cityos-worker: (no published app port)');
});
