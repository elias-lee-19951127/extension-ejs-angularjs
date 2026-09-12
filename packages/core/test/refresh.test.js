/**
 * Workspace.refreshFiles — cap nhat index khi file doi ngoai editor (workspace/didChangeWatchedFiles).
 *
 * Duong di qua LSP da co test o packages/server/test/lsp.test.js. O day kiem nhung quyet dinh
 * khong nhin thay duoc tu LSP: so theo hash chu khong theo mtime, file moi bi exclude khong keo
 * theo mot lan quet lai toan workspace, va loi he thong tap tin (EACCES) khong duoc hieu nham
 * thanh "file da bi xoa".
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

test('refreshFiles: so noi dung, khong so mtime — mtime giu nguyen van thay thay doi', (t) => {
  const { root, ws } = tempWorkspace(t);
  const appJs = join(root, 'js', 'app.js');
  // Giay nguyen de dat lai CHINH XAC mtime cu, nhu rsync -t / tar / cp -p.
  const mtime = 1_700_000_000;
  utimesSync(appJs, mtime, mtime);
  ws.index();
  assert.ok(!members(ws).includes('moi'));

  writeFileSync(appJs, readFileSync(appJs, 'utf8').replace('  s.total = 0;\n', () => '  s.total = 0;\n  s.moi = 1;\n'));
  utimesSync(appJs, mtime, mtime);

  const r = ws.refreshFiles(['js/app.js']);
  assert.deepStrictEqual([r.indexed, r.removed, r.rescanned], [1, 0, false]);
  assert.ok(members(ws).includes('moi'));
  // Bao lai (su kien lap): noi dung khong doi -> khong lam gi.
  assert.strictEqual(ws.refreshFiles(['js/app.js']).indexed, 0);
});

test('refreshFiles: file moi bi exclude khong keo theo quet lai; trong include thi vao index', (t) => {
  const { root, ws } = tempWorkspace(t);
  ws.index();
  const n = ws.stats().files;
  const src = "myApp.controller('x-ctrl', function ($scope) { $scope.a = 1; });\n";
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'extra.js'), src);
  writeFileSync(join(root, 'js', 'extra.js'), src);

  const skipped = ws.refreshFiles(['dist/extra.js', 'dist', '../ngoai-workspace.js', 'khong-co.js']);
  assert.deepStrictEqual([skipped.indexed, skipped.removed, skipped.rescanned], [0, 0, false]);
  assert.strictEqual(ws.stats().files, n);

  const added = ws.refreshFiles(['js/extra.js']);
  assert.deepStrictEqual([added.indexed, added.rescanned], [1, true]);
  assert.strictEqual(ws.stats().files, n + 1);
});

// chmod 000 khong chan duoc root, nen bo qua khi chay bang root.
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const SKIP_ROOT = ROOT_USER && 'chay bang root: chmod 000 khong chan duoc';

test('refreshFiles: loi doc (EACCES) KHONG duoc hieu la file da xoa', { skip: SKIP_ROOT }, (t) => {
  const { root, ws } = tempWorkspace(t);
  ws.index();
  const n = ws.stats().files;

  // Bo quyen thu muc cha -> statSync file ben trong nem EACCES, du file van con nguyen.
  const dir = join(root, 'js');
  chmodSync(dir, 0o000);
  let r;
  try {
    r = ws.refreshFiles(['js/app.js']);
  } finally {
    chmodSync(dir, 0o755);
  }

  assert.deepStrictEqual([r.indexed, r.removed], [0, 0], 'khong biet thi khong duoc go khoi index');
  assert.strictEqual(ws.stats().files, n);
  assert.ok(members(ws).length, 'symbol cua file do phai con nguyen');
});

test('refreshFiles: mot duong dan khong doc duoc khong lam mat ca lo', { skip: SKIP_ROOT }, (t) => {
  const { root, ws } = tempWorkspace(t);
  ws.index();
  const appJs = join(root, 'js', 'app.js');
  writeFileSync(
    appJs,
    readFileSync(appJs, 'utf8').replace('  s.total = 0;\n', () => '  s.total = 0;\n  s.moi = 1;\n'),
  );

  // Thu muc moi, khong doc duoc: fast-glob se nem EACCES khi do "co ung vien nao khong".
  const cam = join(root, 'cam');
  mkdirSync(cam);
  writeFileSync(join(cam, 'x.js'), "myApp.controller('y-ctrl', function ($scope) { $scope.b = 1; });\n");
  chmodSync(cam, 0o000);

  let r;
  try {
    r = ws.refreshFiles(['js/app.js', 'cam']);
  } finally {
    chmodSync(cam, 0o755);
  }

  assert.strictEqual(r.indexed, 1, 'thay doi hop le trong cung lo phai duoc ap');
  assert.ok(members(ws).includes('moi'));
});

test('refreshFiles: bao ve thu muc DANG TON TAI thi khong go file nao', (t) => {
  const { ws } = tempWorkspace(t);
  ws.index();
  const n = ws.stats().files;
  const r = ws.refreshFiles(['js']);
  assert.deepStrictEqual([r.removed, r.rescanned], [0, true], 'thu muc con day thi file cua no con');
  assert.strictEqual(ws.stats().files, n);
});
