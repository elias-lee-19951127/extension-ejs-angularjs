/**
 * LSP-layer test over stdio: starts a REAL server, speaks JSON-RPC like an IDE would,
 * checks capabilities, Range, WorkspaceEdit and the ResponseErrors returned, and
 * synchronizes files changed outside the editor (workspace/didChangeWatchedFiles).
 *
 * The logic already has tests in packages/core. Here we only catch bugs in the
 * conversion layer (offset -> Range, grouping edits by URI, error reporting) — things
 * the core tests can't see.
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

/** The real path behind a URI — compares URIs by path so character-encoding differences don't trip us up. */
const pathOf = (uri) => decodeURIComponent(new URL(uri).pathname);

/** LSP position (0-based line/character) of `needle`, shifted by `offset` characters. */
function positionOf(text, needle, offset = 0) {
  const idx = text.indexOf(needle);
  assert.notStrictEqual(idx, -1, `${JSON.stringify(needle)} not found`);
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

/** Default client capabilities — like VSCode: declares prepareRename support. */
const CLIENT_CAPS = { textDocument: { rename: { prepareSupport: true } } };

async function startServer(t, capabilities = CLIENT_CAPS, initializationOptions = undefined) {
  // A temp copy: the server writes its .ejsng-cache/ into the workspace root.
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
    // Go through the LSP shutdown sequence (shutdown -> exit) so in-flight messages get
    // written out. Killing the process immediately writes the client/registerCapability
    // response into an already-closed stream (ERR_STREAM_DESTROYED) if the test ends early.
    const exited =
      child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    const fallback = setTimeout(() => child.kill(), 3000);
    try {
      await Promise.race([conn.sendRequest('shutdown'), exited]);
      conn.sendNotification('exit');
    } catch {
      /* the server has already shut down */
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
    initializationOptions,
  });
  conn.sendNotification('initialized', {});
  // The server handles these sequentially: initialized (registers the watcher, indexes
  // synchronously) -> this request. Wait for it so the initial indexing finishes BEFORE
  // the test edits a file on disk — otherwise the index might pick up the new content right away.
  await conn.sendRequest('ejsng/stats');

  // `text`: the buffer's content — defaults to disk; pass it in when the buffer has unsaved changes.
  const open = (rel, languageId, text = readFileSync(join(root, rel), 'utf8')) => {
    const uri = pathToFileURL(join(root, rel)).href;
    conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    return { uri, text };
  };
  return { conn, root, init, open, shown, registrations };
}

test('LSP: prepareRename + rename return a WorkspaceEdit correct for both JS and the template', async (t) => {
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

test('LSP: a refused rename returns a ResponseError with a reason for the IDE to show', async (t) => {
  const { conn, open } = await startServer(t);
  const tpl = open('views/page.ejs', 'html');
  await assert.rejects(
    conn.sendRequest('textDocument/prepareRename', {
      textDocument: { uri: tpl.uri },
      position: positionOf(tpl.text, 'row.label'),
    }),
    (err) => /local variable/.test(err.message),
  );
  await assert.rejects(
    conn.sendRequest('textDocument/rename', {
      textDocument: { uri: tpl.uri },
      position: positionOf(tpl.text, 'total | money'),
      newName: 'busy',
    }),
    (err) => /already exists/.test(err.message),
  );
});

test('LSP: completion after `busy.` returns shape-based keys, kind Property', async (t) => {
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

test('LSP: a client that doesn\'t declare prepareSupport only gets renameProvider: true', async (t) => {
  // LSP 3.17: RenameOptions is only sent when the client declares textDocument.rename.prepareSupport.
  const { init } = await startServer(t, {});
  assert.strictEqual(init.capabilities.renameProvider, true);
});

// ------------------------------------------------ workspace/didChangeWatchedFiles

/** LSP's FileChangeType. */
const CREATED = 1;
const CHANGED = 2;
const DELETED = 3;

/** Send workspace/didChangeWatchedFiles as a client would; each event is [relative path, type]. */
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
  assert.notStrictEqual(idx, -1, `${JSON.stringify(anchor)} not found`);
  return text.slice(0, idx + anchor.length) + extra + text.slice(idx + anchor.length);
}

/** Opens the template with a buffer that has an extra `{{ added }}` — on disk it's still the old copy. */
function openWithAdded(root, open) {
  const disk = readFileSync(join(root, 'views', 'page.ejs'), 'utf8');
  return open('views/page.ejs', 'html', insertAfter(disk, '<span>{{ total | money }}</span>', '<b>{{ added }}</b>'));
}

/** Adds `s.added = 1;` to the controller ON DISK (as a git pull would), returns the new content. */
function writeAdded(appJs) {
  const js = insertAfter(readFileSync(appJs, 'utf8'), 's.total = 0;\n', '  s.added = 1;\n');
  writeFileSync(appJs, js);
  return js;
}

test('LSP: .js changed on disk + didChangeWatchedFiles -> definition from the template reaches the new property', async (t) => {
  const { conn, root, open } = await startServer(t);
  const tpl = openWithAdded(root, open);
  const appJs = join(root, 'js', 'app.js');
  const js = writeAdded(appJs);

  // Before it's reported, the index still holds the old facts — the symptom before the fix.
  assert.strictEqual(await definition(conn, tpl, '{{ added }}', 3), null);

  notifyWatched(conn, root, ['js/app.js', CHANGED]);
  const locs = await definition(conn, tpl, '{{ added }}', 3);
  assert.deepStrictEqual(
    (locs ?? []).map((l) => [pathOf(l.uri), l.range]),
    [[appJs, { start: positionOf(js, 's.added', 2), end: positionOf(js, 's.added', 7) }]],
  );
});

test('LSP: a file deleted on disk -> removed from the index', async (t) => {
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

  // Hover reads the symbol straight from the index (unlike definition, it doesn't filter
  // out a missing file) — so a stale fact shows up immediately.
  assert.match((await hover()).contents.value, /'total' not found on the scope of/);
  const after = await conn.sendRequest('ejsng/stats');
  assert.deepStrictEqual([after.files, after.controllers], [before.files - 1, 0]);
});

test('LSP: a whole directory created/deleted (LSP4IJ only reports at the directory level) — index keeps up, exclude still applies', async (t) => {
  const { conn, root, open } = await startServer(t);
  const tpl = openWithAdded(root, open);
  const before = await conn.sendRequest('ejsng/stats');

  // The new directory declares an extra `added` for the SAME controller; the copy under dist/ is excluded.
  const src = "myApp.controller('demo-view-controller', ['$scope', function (s) {\n  s.added = 1;\n}]);\n";
  for (const dir of ['more', 'dist']) {
    mkdirSync(join(root, dir, 'sub'), { recursive: true });
    writeFileSync(join(root, dir, 'sub', 'more.js'), src);
  }
  notifyWatched(conn, root, ['more', CREATED], ['dist', CREATED]);

  const locs = await definition(conn, tpl, '{{ added }}', 3);
  assert.deepStrictEqual((locs ?? []).map((l) => pathOf(l.uri)), [join(root, 'more', 'sub', 'more.js')]);
  assert.strictEqual((await conn.sendRequest('ejsng/stats')).files, before.files + 1);

  rmSync(join(root, 'more'), { recursive: true });
  notifyWatched(conn, root, ['more', DELETED]);
  assert.strictEqual((await conn.sendRequest('ejsng/stats')).files, before.files);
});

test('LSP: an open file changes on disk — the buffer still wins for that file', async (t) => {
  const { conn, root, open } = await startServer(t);
  const tpl = openWithAdded(root, open);
  // On disk the template changes completely differently: 3 lines added at the top of the
  // file -> every offset is now shifted relative to the buffer.
  const tplPath = join(root, 'views', 'page.ejs');
  writeFileSync(tplPath, '<%# 1 %>\n<%# 2 %>\n<%# 3 %>\n' + readFileSync(tplPath, 'utf8'));
  const appJs = join(root, 'js', 'app.js');
  const js = writeAdded(appJs);
  notifyWatched(conn, root, ['views/page.ejs', CHANGED], ['js/app.js', CHANGED]);

  // If the on-disk facts were laid over the buffer, the offset of `added` in the buffer
  // would land on `total` instead.
  const locs = await definition(conn, tpl, '{{ added }}', 3);
  assert.deepStrictEqual(
    (locs ?? []).map((l) => [pathOf(l.uri), l.range.start]),
    [[appJs, positionOf(js, 's.added', 2)]],
  );
});

test('LSP: only registers a dynamic watcher when the client declares dynamicRegistration', async (t) => {
  const watchersOf = async (capabilities) => {
    const s = await startServer(t, capabilities);
    const regs = s.registrations.filter((r) => r.method === 'workspace/didChangeWatchedFiles');
    return { root: s.root, watchers: regs.map((r) => r.registerOptions.watchers) };
  };

  // Like LSP4IJ 0.21: dynamicRegistration, WITHOUT relativePatternSupport -> globs as plain strings.
  const ij = await watchersOf({ workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } });
  assert.deepStrictEqual(ij.watchers, [
    [
      { globPattern: '**/*.js', kind: 2 },
      { globPattern: '**/*.ejs', kind: 2 },
      { globPattern: '**/*.html', kind: 2 },
      { globPattern: '**/*', kind: 5 }, // Create | Delete — directories included
    ],
  ]);

  // Like VSCode: has relativePatternSupport -> a RelativePattern anchored at the workspace root.
  const vs = await watchersOf({
    workspace: { didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
  });
  const last = vs.watchers[0].at(-1);
  assert.deepStrictEqual([pathOf(last.globPattern.baseUri), last.globPattern.pattern, last.kind], [vs.root, '**/*', 5]);

  // Not declared -> nothing is registered.
  assert.deepStrictEqual((await watchersOf(CLIENT_CAPS)).watchers, []);
});

test('LSP: hover renders paths as links, and points to a copy in a farther directory', async (t) => {
  const { conn, root, open } = await startServer(t);
  // A second copy of the same controller, sitting next to its own template -> this copy is now the "nearest" one.
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

  // The target (the nearest copy) is a link with a line number.
  assert.match(value, /\[far\/index\.js:\d+\]\(file:\/\/\S*far\/index\.js#L\d+\)/, value);
  // The copy filtered out of go-to-definition can still be reached from here.
  assert.match(value, /1 more match\(es\) in a farther directory/, value);
  assert.match(value, /\[js\/app\.js\]\(file:\/\/\S*js\/app\.js\)/, value);
});

// observed-types ticket 03: the Observed Type section appended to the hover.
test('LSP: hover on a template variable adds its observed type, what could not be inferred, and where it is assigned', async (t) => {
  const { conn, open } = await startServer(t);
  const tpl = open('views/page.ejs', 'html');
  const hover = await conn.sendRequest('textDocument/hover', {
    textDocument: { uri: tpl.uri },
    position: positionOf(tpl.text, 'row in rows', 7),
  });
  const value = hover.contents.value;

  // The existing hover is still there, above the new section.
  assert.match(value, /^\*\*rows\*\*/, value);
  assert.match(value, /Scope chain: /, value);
  assert.match(value, /\n---\n\n\*\*Observed type\*\* of `rows`\n```ts\n\{ id: number, label: string, tags: string\[\] \}\[\]\n```/, value);
  // `s.rows = Api.list()` can't be inferred: named with its source, never a bare "unknown".
  assert.match(value, /could not be inferred and are left out:_ `Api\.list\(\)` \(\[js\/app\.js:8\]\(file:\/\/\S*#L8\)\)/, value);
  assert.match(value, /Assigned at: \[js\/app\.js:2\]\(\S*#L2\), \[js\/app\.js:8\]\(\S*#L8\)/, value);
  assert.doesNotMatch(value, /Can be empty|Only assigned in a callback/, value);
});

test('LSP: hover on a variable only assigned from a response: the reason with its source, empty-at-first-render; the same type on the JS side', async (t) => {
  const { conn, root, open } = await startServer(t);
  mkdirSync(join(root, 'stats'), { recursive: true });
  writeFileSync(
    join(root, 'stats', 'ctrl.js'),
    "myApp.controller('StatsCtrl', function ($scope, $http) {\n" +
      "  $scope.user = null;\n" +
      "  $http.get('/stats').then(function (res) { $scope.stats = res.data; $scope.user = { name: 'a' }; });\n" +
      '});\n',
  );
  writeFileSync(join(root, 'stats', 'page.html'), '<p ng-controller="StatsCtrl">{{ stats }} {{ user.name }}</p>\n');
  notifyWatched(conn, root, ['stats', CREATED]);

  const tpl = open('stats/page.html', 'html');
  const hoverAt = (doc, needle, offset = 0) =>
    conn
      .sendRequest('textDocument/hover', { textDocument: { uri: doc.uri }, position: positionOf(doc.text, needle, offset) })
      .then((h) => h.contents.value);

  const stats = await hoverAt(tpl, 'stats }}');
  assert.match(stats, /\*\*Observed type\*\* of `stats`\n- _Could not be inferred — assigned from_ `res\.data` \(\[stats\/ctrl\.js:3\]\(\S*#L3\)\)/, stats);
  assert.match(stats, /_Only assigned in a callback_ \(\[stats\/ctrl\.js:3\]\(\S*#L3\)\) — no value at the first render\./, stats);
  assert.doesNotMatch(stats, /```ts/, stats);

  const user = await hoverAt(tpl, 'user.name');
  assert.match(user, /```ts\n\{ name: string \} \| null\n```/, user);
  assert.match(user, /_Can be empty when rendered_/, user);
  assert.doesNotMatch(user, /Only assigned in a callback/, user); // `$scope.user = null` runs at construction

  // JS side: hovering the assigned property shows the same merged type.
  const js = open('stats/ctrl.js', 'javascript');
  const fromJs = await hoverAt(js, 'user = {', 1);
  assert.match(fromJs, /\*\*Observed type\*\* of `user`\n```ts\n\{ name: string \} \| null\n```/, fromJs);
});

// observed-types ticket 04: the "may be empty" inlay hint.
const NULLABLE_CTRL =
  "myApp.controller('UserCtrl', function ($scope, $http) {\n" +
  '  $scope.user = null;\n' +
  "  $http.get('/me').then(function (res) { $scope.user = { name: res.data.name }; $scope.stats = { total: 1 }; });\n" +
  '});\n';
const NULLABLE_TPL = '<div ng-controller="UserCtrl">\n  <b>{{ user.name }}</b>\n  <i>{{ stats.total }}</i>\n</div>\n';

async function nullableHintsFor(t, initializationOptions) {
  const s = await startServer(t, CLIENT_CAPS, initializationOptions);
  mkdirSync(join(s.root, 'user'), { recursive: true });
  writeFileSync(join(s.root, 'user', 'ctrl.js'), NULLABLE_CTRL);
  writeFileSync(join(s.root, 'user', 'page.html'), NULLABLE_TPL);
  notifyWatched(s.conn, s.root, ['user', CREATED]);
  const tpl = s.open('user/page.html', 'html');
  const hints = await s.conn.sendRequest('textDocument/inlayHint', {
    textDocument: { uri: tpl.uri },
    range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
  });
  return { ...s, tpl, hints };
}

test('LSP: inlay hint "may be empty" after a variable assigned null — none for one only assigned in a callback', async (t) => {
  const { init, tpl, hints } = await nullableHintsFor(t);
  assert.strictEqual(init.capabilities.inlayHintProvider, true);
  // `user` is set to null at construction: hinted. `stats` is only set in the .then(): not hinted.
  assert.deepStrictEqual(
    hints.map((h) => [h.position, h.label, h.paddingLeft]),
    [[positionOf(tpl.text, 'user.name', 'user'.length), 'may be empty', true]],
  );
  assert.match(hints[0].tooltip.value, /`user` is assigned `null`\/`undefined` somewhere/);
});

test('LSP: ejsng.typeHints.nullable = false -> no inlay hint; a range without the variable -> none either', async (t) => {
  assert.deepStrictEqual((await nullableHintsFor(t, { typeHints: { nullable: false } })).hints, []);

  const { conn, tpl } = await nullableHintsFor(t);
  const onlyStats = await conn.sendRequest('textDocument/inlayHint', {
    textDocument: { uri: tpl.uri },
    range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } },
  });
  assert.deepStrictEqual(onlyStats, []);
});

test('LSP: a "Log at runtime" link beside an assignment the index could not type — only for a client that runs the command', async (t) => {
  const ctrl =
    "myApp.controller('LogCtrl', function ($scope, $http) {\n" +
    "  $http.get('/stats').then(function (res) { $scope.stats = res.data; });\n" +
    "  $scope.pick = function (res) { return $scope.picked = res.data; };\n" +
    "  $scope.user = { name: 'a' };\n" +
    '});\n';
  const page = '<p ng-controller="LogCtrl">{{ stats }} {{ picked }} {{ user.name }}</p>\n';
  const setup = async (initializationOptions) => {
    const { conn, root, open } = await startServer(t, CLIENT_CAPS, initializationOptions);
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(join(root, 'logs', 'ctrl.js'), ctrl);
    writeFileSync(join(root, 'logs', 'page.html'), page);
    notifyWatched(conn, root, ['logs', CREATED]);
    const tpl = open('logs/page.html', 'html');
    const hoverAt = (needle) =>
      conn.sendRequest('textDocument/hover', { textDocument: { uri: tpl.uri }, position: positionOf(tpl.text, needle) }).then((h) => h.contents.value);
    return { root, hoverAt };
  };

  const vscodeLike = await setup({ commands: ['ejsng.logVariable'] });
  const stats = await vscodeLike.hoverAt('stats }}');
  const m = /`res\.data` \(\[logs\/ctrl\.js:2\]\(\S+?\)\) · \[Log at runtime\]\(command:ejsng\.logVariable\?(\S+?)\)/.exec(stats);
  assert.ok(m, stats);
  const [args] = JSON.parse(decodeURIComponent(m[1]));
  // Right after `$scope.stats = res.data;` — inside the one-line callback, on line 2 (0-based 1).
  const after = ctrl.indexOf('res.data;') + 'res.data;'.length;
  assert.deepStrictEqual(args, {
    uri: pathToFileURL(join(vscodeLike.root, 'logs', 'ctrl.js')).href,
    line: 1,
    character: after - ctrl.indexOf('\n') - 1,
    expression: '$scope.stats',
    logMessage: 'stats = {$scope.stats}',
  });
  // Not a statement of its own (`return … = …`): nowhere "right after" it to log — named, no link.
  const picked = await vscodeLike.hoverAt('picked }}');
  assert.match(picked, /`res\.data`/, picked);
  assert.doesNotMatch(picked, /Log at runtime/, picked);
  // A type the index knows: nothing to log.
  assert.doesNotMatch(await vscodeLike.hoverAt('user.name'), /Log at runtime/);

  // A client that doesn't declare the command (IntelliJ) gets the same hover, minus the link.
  const other = await setup(undefined);
  const plain = await other.hoverAt('stats }}');
  assert.match(plain, /_Could not be inferred — assigned from_ `res\.data`/, plain);
  assert.doesNotMatch(plain, /Log at runtime|command:/, plain);
});

test('LSP: ejsng/logTargets lists where a logpoint can be set with its message already written', async (t) => {
  const { conn, root, open } = await startServer(t);
  mkdirSync(join(root, 'lens'), { recursive: true });
  const ctrl =
    "myApp.controller('LensCtrl', function ($scope, $http) {\n" +
    '  $scope.rows = [];\n' +
    "  $http.get('/rows').then(function (res) { $scope.rows = res.data; });\n" +
    '});\n';
  writeFileSync(join(root, 'lens', 'ctrl.js'), ctrl);
  notifyWatched(conn, root, ['lens', CREATED]);
  const doc = open('lens/ctrl.js', 'javascript');

  const { targets } = await conn.sendRequest('ejsng/logTargets', { uri: doc.uri });
  assert.deepStrictEqual(
    targets.map((t) => [t.lensLine, t.line, t.expression, t.logMessage, t.inferred]),
    [
      [1, 1, '$scope.rows', 'rows = {$scope.rows}', true],
      [2, 2, '$scope.rows', 'rows = {$scope.rows}', false],
    ],
  );
  // The position is inside the one-line callback, right after `res.data;`.
  assert.strictEqual(ctrl.split('\n')[2].slice(targets[1].character - 9, targets[1].character), 'res.data;');

  const { targets: none } = await conn.sendRequest('ejsng/logTargets', { uri: 'file:///nowhere/x.js' });
  assert.deepStrictEqual(none, []);
});

test('LSP: ejsng/logHere answers what the cursor asks to log, or why it cannot', async (t) => {
  const { conn, root, open } = await startServer(t);
  mkdirSync(join(root, 'here'), { recursive: true });
  const ctrl =
    "myApp.controller('HereCtrl', function ($scope, $http) {\n" +
    "  $http.get('/rows').then(function (res) {\n" +
    '    var local = res.data;\n' +
    '    $scope.rows = local;\n' +
    '  });\n' +
    '  $scope.reload = function () { load(); };\n' +
    '});\n';
  writeFileSync(join(root, 'here', 'ctrl.js'), ctrl);
  notifyWatched(conn, root, ['here', CREATED]);
  const doc = open('here/ctrl.js', 'javascript');
  const ask = (needle, offset = 0, selection) => {
    const idx = ctrl.indexOf(needle) + offset;
    const before = ctrl.slice(0, idx);
    return conn.sendRequest('ejsng/logHere', {
      uri: doc.uri,
      line: before.split('\n').length - 1,
      character: idx - before.lastIndexOf('\n') - 1,
      selection,
    });
  };

  // A local read by the line: logged at the start of that line, before it runs.
  const local = await ask('local;', 0);
  assert.deepStrictEqual(
    [local.target.line, local.target.expression, local.target.logMessage],
    [3, 'local', 'local = {local}'],
  );
  assert.strictEqual(ctrl.split('\n')[3].slice(local.target.character, local.target.character + 6), '$scope');

  // The assignment target: logged right after the statement, so the value is the new one.
  const rows = await ask('$scope.rows = local', 2);
  assert.strictEqual(ctrl.split('\n')[rows.target.line].slice(rows.target.character - 6, rows.target.character), 'local;');
  assert.strictEqual(rows.target.logMessage, 'rows = {$scope.rows}');
  assert.match(rows.target.uri, /here\/ctrl\.js$/);

  // A selection wins over the cursor.
  const selected = await ask('res.data;', 0, 'res.data');
  assert.strictEqual(selected.target.logMessage, 'data = {res.data}');

  assert.deepStrictEqual(await ask('load();', 0), { reason: 'call' });
  assert.deepStrictEqual(await conn.sendRequest('ejsng/logHere', { uri: 'file:///x/page.html', line: 0, character: 0 }), { reason: 'not-js' });
});
