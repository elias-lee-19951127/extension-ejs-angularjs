/**
 * Shared test infrastructure for ticket 04 (.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md)
 * and reused by ticket 05 (path mapping from mounts, blocked on this one): a fake `docker` CLI,
 * written to a temp directory that can be prepended to a spawned server's `PATH`, so LSP-level
 * tests exercise the real `execFile('docker', …)` adapter (packages/server/src/docker.ts)
 * end-to-end without a real Docker daemon.
 *
 * POSIX-only (shebang + exec bit) — same constraint as this suite's existing `lsof`/`SIGUSR1`
 * fake-process tests (see runtime-log-auto-enable.test.js), not something this ticket needs to
 * solve for Windows.
 *
 * Usage:
 *   const { dir, cleanup } = writeFakeDockerCli([container1, container2, ...]);
 *   // spawn the server with `env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }`
 *   t.after(cleanup);
 *
 * Each container is a full `docker inspect`-shaped object (Id, Name, State, Config,
 * NetworkSettings, Mounts) — see the fixtures below for what a real container looks like.
 */
const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/**
 * `docker ps -q` prints one truncated (12-char) id per line; `docker inspect <ids...>` prints a
 * JSON array of the matching full entries — both mirror real `docker` CLI behavior closely
 * enough for this adapter (which only ever calls these two subcommands, see
 * packages/server/src/docker.ts). `vanishedIds` are extra ids `ps -q` reports that `inspect`
 * then can't find — real `docker inspect` still prints the JSON for every container it DID find
 * before exiting non-zero for the rest, a race that's real on a host with short-lived containers
 * (a container that stops between this adapter's `ps` and `inspect` calls) — this lets a test
 * prove the adapter salvages that partial output instead of discarding it.
 */
function fakeDockerScript(containers, vanishedIds) {
  const fixtureJson = JSON.stringify(containers);
  const vanishedJson = JSON.stringify(vanishedIds);
  return `#!/usr/bin/env node
'use strict';
const containers = ${fixtureJson};
const vanishedIds = ${vanishedJson};
const [, , cmd, ...rest] = process.argv;
if (cmd === 'ps' && rest.includes('-q')) {
  const ids = containers.map((c) => c.Id.slice(0, 12)).concat(vanishedIds);
  process.stdout.write(ids.join('\\n') + '\\n');
  process.exit(0);
}
if (cmd === 'version') {
  process.stdout.write('27.1.1-fake\\n');
  process.exit(0);
}
if (cmd === 'inspect') {
  const ids = rest.filter((a) => !a.startsWith('-'));
  const matched = containers.filter((c) => ids.some((id) => c.Id === id || c.Id.startsWith(id)));
  process.stdout.write(JSON.stringify(matched));
  const missing = ids.some((id) => vanishedIds.includes(id));
  if (missing) {
    process.stderr.write('Error: No such object: ' + vanishedIds.join(', ') + '\\n');
    process.exit(1);
  }
  process.exit(0);
}
process.stderr.write('fake docker: unsupported command: ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`;
}

/** Write a fake `docker` executable to a fresh temp dir; returns `{dir, cleanup}`. `vanishedIds`: see `fakeDockerScript`. */
function writeFakeDockerCli(containers, { vanishedIds = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ejsng-fake-docker-'));
  const scriptPath = join(dir, 'docker');
  writeFileSync(scriptPath, fakeDockerScript(containers, vanishedIds));
  chmodSync(scriptPath, 0o755);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

/**
 * Fixtures modeled on the real machine described in `.scratch/runtime-remote-env/decisions.md`:
 * `cityos-web` publishes app port 5000 and inspector 9229 straight through (via a Cmd flag);
 * `cityos-app` remaps its inspector to host port 9228 (`9228->9229`, via NODE_OPTIONS rather than
 * a Cmd flag); their mounts nest — `aocs-cityos-lusail` -> `.../aocs-cityos`, then `aocs` ->
 * `.../aocs-cityos/aocs`, the second shadowing part of the first (ticket 05's concern, not this
 * one's, but the shape must be right for it to consume).
 */
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

/** A Node process with `--inspect` enabled but never published to the host at all (checklist item 6). */
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

module.exports = { writeFakeDockerCli, containerFixture, CITYOS_WEB, CITYOS_APP, CITYOS_WORKER, CITYOS_DB };
