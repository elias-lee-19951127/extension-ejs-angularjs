/**
 * Workspace.refreshFiles — updates the index when a file changes outside the editor (workspace/didChangeWatchedFiles).
 *
 * The LSP path already has tests in packages/server/test/lsp.test.js. Here we check
 * decisions invisible from the LSP layer: comparing by hash rather than mtime, a new
 * excluded file not triggering a full workspace rescan, and a filesystem error (EACCES)
 * not being mistaken for "the file was deleted".
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const C = require('../dist');

const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');

function tempWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-refresh-'));
  cpSync(FIXTURE, root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, ws: new C.Workspace({ root }, ':memory:') };
}

const members = (ws) => ws.membersOf('demo-view-controller').map((m) => m.name);

test('refreshFiles: compares by content, not mtime — mtime stays the same but content changes', (t) => {
  const { root, ws } = tempWorkspace(t);
  const appJs = join(root, 'js', 'app.js');
  // Restore the EXACT old mtime afterward, as rsync -t / tar / cp -p would.
  const mtime = 1_700_000_000;
  utimesSync(appJs, mtime, mtime);
  ws.index();
  assert.ok(!members(ws).includes('added'));

  writeFileSync(appJs, readFileSync(appJs, 'utf8').replace('  s.total = 0;\n', () => '  s.total = 0;\n  s.added = 1;\n'));
  utimesSync(appJs, mtime, mtime);

  const r = ws.refreshFiles(['js/app.js']);
  assert.deepStrictEqual([r.indexed, r.removed, r.rescanned], [1, 0, false]);
  assert.ok(members(ws).includes('added'));
  // Reported again (a duplicate event): content unchanged -> does nothing.
  assert.strictEqual(ws.refreshFiles(['js/app.js']).indexed, 0);
});

test('refreshFiles: a new excluded file does not trigger a rescan; one inside include gets indexed', (t) => {
  const { root, ws } = tempWorkspace(t);
  ws.index();
  const n = ws.stats().files;
  const src = "myApp.controller('x-ctrl', function ($scope) { $scope.a = 1; });\n";
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'extra.js'), src);
  writeFileSync(join(root, 'js', 'extra.js'), src);

  const skipped = ws.refreshFiles(['dist/extra.js', 'dist', '../outside-workspace.js', 'does-not-exist.js']);
  assert.deepStrictEqual([skipped.indexed, skipped.removed, skipped.rescanned], [0, 0, false]);
  assert.strictEqual(ws.stats().files, n);

  const added = ws.refreshFiles(['js/extra.js']);
  assert.deepStrictEqual([added.indexed, added.rescanned], [1, true]);
  assert.strictEqual(ws.stats().files, n + 1);
});

// chmod 000 doesn't block root, so skip when running as root.
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const SKIP_ROOT = ROOT_USER && 'running as root: chmod 000 does not block access';

test('refreshFiles: a read error (EACCES) must NOT be treated as the file having been deleted', { skip: SKIP_ROOT }, (t) => {
  const { root, ws } = tempWorkspace(t);
  ws.index();
  const n = ws.stats().files;

  // Strip permission from the parent directory -> statSync on the file inside throws
  // EACCES, even though the file itself is untouched.
  const dir = join(root, 'js');
  chmodSync(dir, 0o000);
  let r;
  try {
    r = ws.refreshFiles(['js/app.js']);
  } finally {
    chmodSync(dir, 0o755);
  }

  assert.deepStrictEqual([r.indexed, r.removed], [0, 0], 'when in doubt, never remove from the index');
  assert.strictEqual(ws.stats().files, n);
  assert.ok(members(ws).length, 'the file\'s symbols must remain intact');
});

test('refreshFiles: one unreadable path does not lose the whole batch', { skip: SKIP_ROOT }, (t) => {
  const { root, ws } = tempWorkspace(t);
  ws.index();
  const appJs = join(root, 'js', 'app.js');
  writeFileSync(
    appJs,
    readFileSync(appJs, 'utf8').replace('  s.total = 0;\n', () => '  s.total = 0;\n  s.added = 1;\n'),
  );

  // A new, unreadable directory: fast-glob will throw EACCES when checking "does it have any candidates".
  const locked = join(root, 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'x.js'), "myApp.controller('y-ctrl', function ($scope) { $scope.b = 1; });\n");
  chmodSync(locked, 0o000);

  let r;
  try {
    r = ws.refreshFiles(['js/app.js', 'locked']);
  } finally {
    chmodSync(locked, 0o755);
  }

  assert.strictEqual(r.indexed, 1, 'a valid change in the same batch must still be applied');
  assert.ok(members(ws).includes('added'));
});

test('refreshFiles: reporting a directory that STILL EXISTS removes nothing', (t) => {
  const { ws } = tempWorkspace(t);
  ws.index();
  const n = ws.stats().files;
  const r = ws.refreshFiles(['js']);
  assert.deepStrictEqual([r.removed, r.rescanned], [0, true], 'the directory still exists, so its files still exist too');
  assert.strictEqual(ws.stats().files, n);
});
