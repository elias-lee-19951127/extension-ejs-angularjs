/**
 * Workspace.toRelative — symlink resolution (ticket 02, item 2; originally
 * .scratch/inline-runtime-log/issues/12-symlinked-root-path-mismatch.md).
 *
 * `toRelative` used to compare paths with plain `path.resolve`, which does NOT resolve
 * symlinks. When the workspace root (or an ancestor directory) sits behind a symlink — macOS's
 * own `os.tmpdir()` (`/var/folders/...` -> `/private/var/folders/...`), some `nvm`/`asdf`
 * setups, a directory mounted through a symlink — and the runtime (V8/CDP) reports the
 * REALPATH, every comparison missed and the file looked like it was outside the workspace.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const C = require('../dist');

const SKIP_WIN32 = process.platform === 'win32' && 'symlinks need elevated privileges on Windows';

test(
  'Workspace.toRelative: root reached through a symlink still maps a real (REALPATH-reported) file to a normal relative path',
  { skip: SKIP_WIN32 },
  (t) => {
    const base = mkdtempSync(join(tmpdir(), 'ejsng-symlink-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const real = join(base, 'real-root');
    mkdirSync(join(real, 'js'), { recursive: true });
    writeFileSync(join(real, 'js', 'app.js'), 'console.log(1);\n');

    const link = join(base, 'link-root');
    symlinkSync(real, link);

    // The workspace was opened via the SYMLINK path — what VS Code reports as the folder root...
    const ws = new C.Workspace({ root: link }, ':memory:');
    // ...but the runtime (V8/CDP) reports the REALPATH — exactly the macOS tmpdir() case.
    const reportedPath = realpathSync(join(real, 'js', 'app.js'));

    const rel = ws.toRelative(reportedPath);
    assert.strictEqual(rel, join('js', 'app.js'));
    assert.strictEqual(C.isWithinRoot(rel), true);
  },
);

test('Workspace.toRelative: no symlinks involved — behaves exactly as before (plain relative path)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ejsng-nosymlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'js'));
  writeFileSync(join(root, 'js', 'app.js'), 'console.log(1);\n');

  const ws = new C.Workspace({ root }, ':memory:');
  assert.strictEqual(ws.toRelative(join(root, 'js', 'app.js')), join('js', 'app.js'));
});

test('Workspace.toRelative: a path that does not exist (e.g. a virtual eval path CDP can report) never throws', (t) => {
  // realpathSync the root itself first: on macOS, tmpdir() is ITSELF behind a symlink, and this
  // test wants to isolate "does `toRelative` throw or misbehave for a path that doesn't exist",
  // not re-test the (already covered) root-behind-a-symlink case.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ejsng-virtual-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = new C.Workspace({ root }, ':memory:');

  assert.doesNotThrow(() => ws.toRelative('<anonymous>'));
  assert.doesNotThrow(() => ws.toRelative(join(root, 'does-not-exist.js')));
  // Falls back to the existing (pre-fix) guard behavior — still resolvable as a plain path,
  // just not symlink-aware, which is fine since it isn't a real file anyway.
  assert.strictEqual(ws.toRelative(join(root, 'does-not-exist.js')), join('does-not-exist.js'));
});

test(
  'Workspace.toRelative: a file just DELETED under a root that sits behind a symlink still resolves to a normal relative path (not falsely "outside")',
  { skip: SKIP_WIN32 },
  (t) => {
    const base = mkdtempSync(join(tmpdir(), 'ejsng-symlink-deleted-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const real = join(base, 'real-root');
    mkdirSync(join(real, 'js'), { recursive: true });
    const filePath = join(real, 'js', 'app.js');
    writeFileSync(filePath, 'console.log(1);\n');

    const link = join(base, 'link-root');
    symlinkSync(real, link);

    const ws = new C.Workspace({ root: link }, ':memory:');
    // Delete the file AFTER the Workspace was constructed (resolvedRoot is cached at
    // construction) — refreshFiles calls toRelative for a delete event too, and by definition
    // the file no longer exists, so it can't be realpath'd. Comparing that unresolvable path
    // against a resolved root (instead of falling back to the unresolved root) used to make
    // every such delete look like it was outside the workspace, silently breaking cleanup.
    const path = join(link, 'js', 'app.js');
    rmSync(filePath);

    const rel = ws.toRelative(path);
    assert.strictEqual(rel, join('js', 'app.js'));
    assert.strictEqual(C.isWithinRoot(rel), true);
  },
);

test(
  'Workspace.toRelative: a symlinked file OUTSIDE the workspace root still resolves outside — the fix does not widen containment',
  { skip: SKIP_WIN32 },
  (t) => {
    const base = mkdtempSync(join(tmpdir(), 'ejsng-symlink-outside-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, 'root');
    mkdirSync(root);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'secret.js'), 'console.log(1);\n');

    const ws = new C.Workspace({ root }, ':memory:');
    const rel = ws.toRelative(realpathSync(join(elsewhere, 'secret.js')));
    assert.strictEqual(C.isWithinRoot(rel), false);
  },
);
