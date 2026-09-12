/**
 * Kiem thu tang LSP qua stdio: khoi dong server THAT, noi chuyen JSON-RPC nhu IDE,
 * kiem capability, Range, WorkspaceEdit va ResponseError tra ve, va dong bo file doi
 * ngoai editor (workspace/didChangeWatchedFiles).
 *
 * Logic da co test o packages/core. O day chi bat loi tang chuyen doi (offset ->
 * Range, gom edit theo URI, bao loi) — thu ma test core khong nhin thay.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const rpc = require('vscode-jsonrpc/node');

const SERVER = join(__dirname, '..', 'dist', 'index.js');
const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');

/** Duong dan that sau URI — so URI theo duong dan de khong vuong cach ma hoa ky tu. */
const pathOf = (uri) => decodeURIComponent(new URL(uri).pathname);

/** Vi tri LSP (dong/cot 0-based) cua `needle`, dich them `offset` ky tu. */
function positionOf(text, needle, offset = 0) {
  const idx = text.indexOf(needle);
  assert.notStrictEqual(idx, -1, `khong tim thay ${JSON.stringify(needle)}`);
  const before = text.slice(0, idx + offset);
  return { line: before.split('\n').length - 1, character: before.length - (before.lastIndexOf('\n') + 1) };
}

function applyTextEdits(text, edits) {
  const lines = text.split('\n');
  const offsetOf = ({ line, character }) => {
    let off = 0;
    for (let i = 0; i < line; i++) off += lines[i].length + 1;
    return off + character;
  };
  return edits
    .map((e) => ({ start: offsetOf(e.range.start), end: offsetOf(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start)
    .reduce((acc, e) => acc.slice(0, e.start) + e.text + acc.slice(e.end), text);
}

/** Capability client mac dinh — nhu VSCode: co khai bao prepareRename. */
const CLIENT_CAPS = { textDocument: { rename: { prepareSupport: true } } };

async function startServer(t, capabilities = CLIENT_CAPS) {
  // Ban sao tam: server ghi cache .ejsng-cache/ vao goc workspace.
  const root = mkdtempSync(join(tmpdir(), 'ejsng-lsp-'));
  cpSync(FIXTURE, root, { recursive: true });

  const child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(child.stdout),
    new rpc.StreamMessageWriter(child.stdin),
  );
  const shown = [];
  const registrations = [];
  conn.onNotification('window/showMessage', (p) => shown.push(p));
  conn.onNotification(() => {}); // log, diagnostics…
  conn.onRequest('client/registerCapability', (p) => {
    registrations.push(...p.registrations);
    return null;
  });
  conn.onRequest(() => null);
  conn.listen();
  t.after(async () => {
    // Tat dung trinh tu LSP (shutdown -> exit) de goi tin dang bay duoc ghi xong. Giet
    // tien trinh ngay thi phan hoi cho client/registerCapability bi ghi vao stream da
    // dong (ERR_STREAM_DESTROYED) khi test ket thuc som.
    const exited =
      child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    const fallback = setTimeout(() => child.kill(), 3000);
    try {
      await Promise.race([conn.sendRequest('shutdown'), exited]);
      conn.sendNotification('exit');
    } catch {
      /* server da tat */
    }
    await exited;
    clearTimeout(fallback);
    conn.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const rootUri = pathToFileURL(root).href;
  const init = await conn.sendRequest('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'mini' }],
    capabilities,
  });
  conn.sendNotification('initialized', {});
  // Server xu ly tuan tu: initialized (dang ky watcher, index dong bo) -> request nay. Cho no de
  // index ban dau xong TRUOC khi test sua file tren dia — neu khong, index co the doc luon ban moi.
  await conn.sendRequest('ejsng/stats');

  // `text`: noi dung buffer — mac dinh bang dia; truyen vao khi buffer co thay doi chua luu.
  const open = (rel, languageId, text = readFileSync(join(root, rel), 'utf8')) => {
    const uri = pathToFileURL(join(root, rel)).href;
    conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    return { uri, text };
  };
  return { conn, root, init, open, shown, registrations };
}

test('LSP: prepareRename + rename tra ve WorkspaceEdit dung cho ca JS lan template', async (t) => {
  const { conn, init, open, root } = await startServer(t);
  assert.deepStrictEqual(init.capabilities.renameProvider, { prepareProvider: true });
  const tpl = open('views/page.ejs', 'html');

  const prep = await conn.sendRequest('textDocument/prepareRename', {
    textDocument: { uri: tpl.uri },
    position: positionOf(tpl.text, 'total | money', 2),
  });
  assert.strictEqual(prep.placeholder, 'total');
  assert.deepStrictEqual(prep.range, {
    start: positionOf(tpl.text, 'total | money'),
    end: positionOf(tpl.text, 'total | money', 5),
  });

  const edit = await conn.sendRequest('textDocument/rename', {
    textDocument: { uri: tpl.uri },
    position: positionOf(tpl.text, 'total | money'),
    newName: 'grandTotal',
  });
  const byPath = Object.fromEntries(Object.entries(edit.changes).map(([uri, e]) => [pathOf(uri), e]));
  const jsPath = join(root, 'js', 'app.js');
  const tplPath = join(root, 'views', 'page.ejs');
  assert.deepStrictEqual(Object.keys(byPath).sort(), [jsPath, tplPath].sort());
  assert.ok(applyTextEdits(tpl.text, byPath[tplPath]).includes('{{ grandTotal | money }}'));
  assert.ok(applyTextEdits(readFileSync(jsPath, 'utf8'), byPath[jsPath]).includes('s.grandTotal = 0;'));
});

test('LSP: rename bi tu choi thi tra ResponseError kem ly do de IDE hien ra', async (t) => {
  const { conn, open } = await startServer(t);
  const tpl = open('views/page.ejs', 'html');
  await assert.rejects(
    conn.sendRequest('textDocument/prepareRename', {
      textDocument: { uri: tpl.uri },
      position: positionOf(tpl.text, 'row.label'),
    }),
    (err) => /bien cuc bo/.test(err.message),
  );
  await assert.rejects(
    conn.sendRequest('textDocument/rename', {
      textDocument: { uri: tpl.uri },
      position: positionOf(tpl.text, 'total | money'),
      newName: 'busy',
    }),
    (err) => /da co/.test(err.message),
  );
});

test('LSP: completion sau `busy.` tra ve khoa theo shape, kieu Property', async (t) => {
  const { conn, open } = await startServer(t);
  const tpl = open('views/page.ejs', 'html');
  const cut = tpl.text.indexOf('<span>') + '<span>'.length;
  const text = tpl.text.slice(0, cut) + '{{ busy. }}' + tpl.text.slice(cut);
  conn.sendNotification('textDocument/didChange', {
    textDocument: { uri: tpl.uri, version: 2 },
    contentChanges: [{ text }],
  });

  const res = await conn.sendRequest('textDocument/completion', {
    textDocument: { uri: tpl.uri },
    position: positionOf(text, '{{ busy. }}', '{{ busy.'.length),
    context: { triggerKind: 2, triggerCharacter: '.' },
  });
  const items = Array.isArray(res) ? res : res.items;
  assert.deepStrictEqual(items.map((i) => i.label).sort(), ['loading', 'saving']);
  assert.ok(items.every((i) => i.kind === 10), 'CompletionItemKind.Property');
});

test('LSP: client khong khai bao prepareSupport thi chi quang ba renameProvider: true', async (t) => {
  // LSP 3.17: RenameOptions chi duoc gui khi client khai bao textDocument.rename.prepareSupport.
  const { init } = await startServer(t, {});
  assert.strictEqual(init.capabilities.renameProvider, true);
});

// ------------------------------------------------ workspace/didChangeWatchedFiles

/** FileChangeType cua LSP. */
const CREATED = 1;
const CHANGED = 2;
const DELETED = 3;

/** Gui workspace/didChangeWatchedFiles nhu client; moi su kien la [duong dan tuong doi, loai]. */
function notifyWatched(conn, root, ...events) {
  conn.sendNotification('workspace/didChangeWatchedFiles', {
    changes: events.map(([rel, type]) => ({ uri: pathToFileURL(join(root, rel)).href, type })),
  });
}

function definition(conn, doc, needle, offset = 0) {
  return conn.sendRequest('textDocument/definition', {
    textDocument: { uri: doc.uri },
    position: positionOf(doc.text, needle, offset),
  });
}

function insertAfter(text, anchor, extra) {
  const idx = text.indexOf(anchor);
  assert.notStrictEqual(idx, -1, `khong tim thay ${JSON.stringify(anchor)}`);
  return text.slice(0, idx + anchor.length) + extra + text.slice(idx + anchor.length);
}

/** Mo template voi buffer co them `{{ moi }}` — tren dia van la ban cu. */
function openWithMoi(root, open) {
  const disk = readFileSync(join(root, 'views', 'page.ejs'), 'utf8');
  return open('views/page.ejs', 'html', insertAfter(disk, '<span>{{ total | money }}</span>', '<b>{{ moi }}</b>'));
}

/** Them `s.moi = 1;` vao controller TREN DIA (nhu git pull), tra ve noi dung moi. */
function writeMoi(appJs) {
  const js = insertAfter(readFileSync(appJs, 'utf8'), 's.total = 0;\n', '  s.moi = 1;\n');
  writeFileSync(appJs, js);
  return js;
}

test('LSP: .js doi tren dia + didChangeWatchedFiles -> definition tu template toi property moi', async (t) => {
  const { conn, root, open } = await startServer(t);
  const tpl = openWithMoi(root, open);
  const appJs = join(root, 'js', 'app.js');
  const js = writeMoi(appJs);

  // Chua bao thi index van giu fact cu — dung trieu chung truoc khi sua.
  assert.strictEqual(await definition(conn, tpl, '{{ moi }}', 3), null);

  notifyWatched(conn, root, ['js/app.js', CHANGED]);
  const locs = await definition(conn, tpl, '{{ moi }}', 3);
  assert.deepStrictEqual(
    (locs ?? []).map((l) => [pathOf(l.uri), l.range]),
    [[appJs, { start: positionOf(js, 's.moi', 2), end: positionOf(js, 's.moi', 5) }]],
  );
});

test('LSP: file bi xoa tren dia -> go khoi index', async (t) => {
  const { conn, root, open } = await startServer(t);
  const tpl = open('views/page.ejs', 'html');
  const hover = () =>
    conn.sendRequest('textDocument/hover', {
      textDocument: { uri: tpl.uri },
      position: positionOf(tpl.text, 'total | money'),
    });
  assert.match((await hover()).contents.value, /js\/app\.js/);
  const before = await conn.sendRequest('ejsng/stats');

  rmSync(join(root, 'js', 'app.js'));
  notifyWatched(conn, root, ['js/app.js', DELETED]);

  // Hover doc thang symbol trong index (khong loc file mat nhu definition) — con fact cu la lo ngay.
  assert.match((await hover()).contents.value, /Khong tim thay 'total'/);
  const after = await conn.sendRequest('ejsng/stats');
  assert.deepStrictEqual([after.files, after.controllers], [before.files - 1, 0]);
});

test('LSP: ca thu muc duoc tao/xoa (LSP4IJ chi bao o cap thu muc) — index theo kip, exclude van ap', async (t) => {
  const { conn, root, open } = await startServer(t);
  const tpl = openWithMoi(root, open);
  const before = await conn.sendRequest('ejsng/stats');

  // Thu muc moi khai bao them `moi` cho CUNG controller; ban trong dist/ bi exclude.
  const src = "myApp.controller('demo-view-controller', ['$scope', function (s) {\n  s.moi = 1;\n}]);\n";
  for (const dir of ['more', 'dist']) {
    mkdirSync(join(root, dir, 'sub'), { recursive: true });
    writeFileSync(join(root, dir, 'sub', 'more.js'), src);
  }
  notifyWatched(conn, root, ['more', CREATED], ['dist', CREATED]);

  const locs = await definition(conn, tpl, '{{ moi }}', 3);
  assert.deepStrictEqual((locs ?? []).map((l) => pathOf(l.uri)), [join(root, 'more', 'sub', 'more.js')]);
  assert.strictEqual((await conn.sendRequest('ejsng/stats')).files, before.files + 1);

  rmSync(join(root, 'more'), { recursive: true });
  notifyWatched(conn, root, ['more', DELETED]);
  assert.strictEqual((await conn.sendRequest('ejsng/stats')).files, before.files);
});

test('LSP: file dang mo doi tren dia — buffer van thang cho chinh file do', async (t) => {
  const { conn, root, open } = await startServer(t);
  const tpl = openWithMoi(root, open);
  // Tren dia template doi khac han: them 3 dong dau file -> moi offset lech so voi buffer.
  const tplPath = join(root, 'views', 'page.ejs');
  writeFileSync(tplPath, '<%# 1 %>\n<%# 2 %>\n<%# 3 %>\n' + readFileSync(tplPath, 'utf8'));
  const appJs = join(root, 'js', 'app.js');
  const js = writeMoi(appJs);
  notifyWatched(conn, root, ['views/page.ejs', CHANGED], ['js/app.js', CHANGED]);

  // Fact tren dia ma de len buffer thi offset cua `moi` trong buffer roi vao `total`.
  const locs = await definition(conn, tpl, '{{ moi }}', 3);
  assert.deepStrictEqual(
    (locs ?? []).map((l) => [pathOf(l.uri), l.range.start]),
    [[appJs, positionOf(js, 's.moi', 2)]],
  );
});

test('LSP: chi dang ky watcher dong khi client khai bao dynamicRegistration', async (t) => {
  const watchersOf = async (capabilities) => {
    const s = await startServer(t, capabilities);
    const regs = s.registrations.filter((r) => r.method === 'workspace/didChangeWatchedFiles');
    return { root: s.root, watchers: regs.map((r) => r.registerOptions.watchers) };
  };

  // Nhu LSP4IJ 0.21: dynamicRegistration, KHONG co relativePatternSupport -> glob dang chuoi.
  const ij = await watchersOf({ workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } });
  assert.deepStrictEqual(ij.watchers, [
    [
      { globPattern: '**/*.js', kind: 2 },
      { globPattern: '**/*.ejs', kind: 2 },
      { globPattern: '**/*.html', kind: 2 },
      { globPattern: '**/*', kind: 5 }, // Create | Delete — ke ca thu muc
    ],
  ]);

  // Nhu VSCode: co relativePatternSupport -> RelativePattern neo vao goc workspace.
  const vs = await watchersOf({
    workspace: { didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
  });
  const last = vs.watchers[0].at(-1);
  assert.deepStrictEqual([pathOf(last.globPattern.baseUri), last.globPattern.pattern, last.kind], [vs.root, '**/*', 5]);

  // Khong khai bao -> khong dang ky.
  assert.deepStrictEqual((await watchersOf(CLIENT_CAPS)).watchers, []);
});

test('LSP: hover viet duong dan thanh link, va chi ra ban o thu muc xa hon', async (t) => {
  const { conn, root, open } = await startServer(t);
  // Ban thu hai cua cung controller, dat canh template cua no -> ban nay moi la "gan nhat".
  mkdirSync(join(root, 'far'), { recursive: true });
  writeFileSync(join(root, 'far', 'index.js'), readFileSync(join(root, 'js', 'app.js'), 'utf8'));
  writeFileSync(join(root, 'far', 'content.ejs'), readFileSync(join(root, 'views', 'page.ejs'), 'utf8'));
  notifyWatched(conn, root, ['far', CREATED]);

  const tpl = open('far/content.ejs', 'html');
  const hover = await conn.sendRequest('textDocument/hover', {
    textDocument: { uri: tpl.uri },
    position: positionOf(tpl.text, 'total | money'),
  });
  const value = hover.contents.value;

  // Dich (ban gan nhat) la link co so dong.
  assert.match(value, /\[far\/index\.js:\d+\]\(file:\/\/\S*far\/index\.js#L\d+\)/, value);
  // Ban bi loai khoi go-to-definition van toi duoc tu day.
  assert.match(value, /con 1 ban o thu muc xa hon/, value);
  assert.match(value, /\[js\/app\.js\]\(file:\/\/\S*js\/app\.js\)/, value);
});
