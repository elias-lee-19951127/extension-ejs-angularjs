/**
 * Ticket 11 (.scratch/runtime-remote-env/issues/11-test-tu-dong-client.md): the runtime log as the
 * user sees it, in a real VS Code — the real extension, its real bundled language server, and a
 * fake CDP runtime. Replaces the hand checks of .scratch/inline-runtime-log/issues/09-verify-02a-published-unverified.md.
 *
 * The workspace fixture (test-e2e/fixture) declares `ejsng.runtimeLog.pathMappings`
 * `/srv/app -> ${workspaceFolder}` in its own .vscode/settings.json, so every log below comes from
 * a container-style path and goes through a mapping read from real VS Code settings.
 */
const assert = require('node:assert');
const { writeFileSync } = require('node:fs');
const vscode = require('vscode');
const {
  test,
  workspacePath,
  workspaceUri,
  extensionApi,
  waitFor,
  startFakeRuntime,
  connectThroughCommand,
  disconnect,
  refreshed,
  onCleanup,
} = require('./helpers');

const OFF = 'EJS/NG Runtime: off';

async function openPanel(api) {
  await vscode.commands.executeCommand('workbench.view.extension.ejsngPanel');
  await waitFor(() => api.panelState(), 'the runtime log panel to render');
}

function stepById(steps, id) {
  const step = steps.find((s) => s.id === id);
  assert.ok(step, `no checklist step "${id}"`);
  return step;
}

test('opening the workspace connects nothing: status bar is off, checklist all pending', async () => {
  const api = await extensionApi();
  assert.deepStrictEqual(api.connectionKeys(), []);
  assert.strictEqual(api.statusBarText(), OFF);
  await openPanel(api);
  await waitFor(() => refreshed(api, () => api.checklist().length === 6), 'the checklist');
  assert.deepStrictEqual(
    api.checklist().map((s) => s.status),
    ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
  );
  assert.strictEqual(api.panelState().count, 0);
});

test('connect -> the log is drawn at the end of the right line of the real file, and counted', async () => {
  const api = await extensionApi();
  const appUri = workspaceUri('app.js');
  await vscode.window.showTextDocument(appUri);
  const runtime = await startFakeRuntime();
  await connectThroughCommand(api, runtime);

  runtime.sendLog('hello', { url: '/srv/app/app.js', line: 1 });

  const drawn = await waitFor(() => api.decorations(appUri.toString()).length > 0 && api.decorations(appUri.toString()), 'a decoration in app.js');
  assert.deepStrictEqual(drawn, [{ line: 1, text: 'hello' }]);
  const [hover] = api.hovers(appUri.toString());
  assert.strictEqual(hover.line, 1);
  assert.match(hover.title, new RegExp(`^node 127\\.0\\.0\\.1:${runtime.port} · log · \\d\\d:\\d\\d:\\d\\d$`));
  await waitFor(
    () => refreshed(api, () => api.statusBarText() === 'EJS/NG Runtime: received 1 / drawn 1 / dropped 0'),
    'the status bar to count the drawn log',
  );
});

test('a later log on the same line replaces the value; a file opened afterwards is decorated on open', async () => {
  const api = await extensionApi();
  const runtime = await startFakeRuntime();
  await connectThroughCommand(api, runtime);

  // worker.js is not open yet: the log is kept, and drawn when the editor appears.
  runtime.sendLog('first', { url: '/srv/app/worker.js', line: 1 });
  runtime.sendLog('second', { url: '/srv/app/worker.js', line: 1 });
  await waitFor(() => refreshed(api, () => api.statusBarText().includes('drawn 2')), 'both logs to be drawn');

  const workerUri = workspaceUri('worker.js');
  await vscode.window.showTextDocument(workerUri, { preview: false });
  const drawn = await waitFor(
    () => api.decorations(workerUri.toString()).length > 0 && api.decorations(workerUri.toString()),
    'worker.js to be decorated once opened',
  );
  assert.deepStrictEqual(drawn, [{ line: 1, text: 'second (×2)' }]);
  // Ticket 05: the earlier value is kept for the hover, with its own source.
  const [hover] = api.hovers(workerUri.toString());
  assert.strictEqual(hover.history.length, 1);
  assert.match(hover.history[0], /^node 127\.0\.0\.1:\d+ · log · \d\d:\d\d:\d\d — first$/);
});

test('two connections at once: status bar and panel count both; Disconnect closes only the one picked', async () => {
  const api = await extensionApi();
  await openPanel(api);
  const a = await startFakeRuntime({ id: 'a', title: 'runtime A' });
  const b = await startFakeRuntime({ id: 'b', title: 'runtime B' });
  const keyA = await connectThroughCommand(api, a);
  const keyB = await connectThroughCommand(api, b);
  assert.notStrictEqual(keyA, keyB);

  a.sendLog('from A', { url: '/srv/app/app.js', line: 0 });
  b.sendLog('from B', { url: '/srv/app/worker.js', line: 0 });
  await waitFor(
    () => refreshed(api, () => api.statusBarText() === 'EJS/NG Runtime: received 2 / drawn 2 / dropped 0'),
    'the status bar to count both connections',
  );
  const panel = api.panelState();
  assert.strictEqual(panel.count, 2);
  assert.deepStrictEqual(stepById(panel.steps, 'logs').counts, { received: 2, drawn: 2, dropped: 0 });
  assert.strictEqual(stepById(panel.steps, 'node').status, 'ok');

  await disconnect(api, keyA);

  assert.deepStrictEqual(api.connectionKeys(), [keyB]);
  await waitFor(() => a.isClosed(), 'runtime A to see its socket closed');
  assert.strictEqual(b.isClosed(), false);
  await waitFor(
    () => refreshed(api, () => api.statusBarText() === 'EJS/NG Runtime: received 1 / drawn 1 / dropped 0'),
    'the status bar to drop the disconnected runtime',
  );
  assert.strictEqual(api.panelState().count, 1);
});

test('the checklist names what broke: a missing mapping, a Stale File, every frame skipped', async () => {
  const api = await extensionApi();
  await openPanel(api);
  const stalePath = workspacePath('stale.js');
  const loaded = "console.log('before the edit');\n";
  writeFileSync(stalePath, loaded);
  const staleUri = workspaceUri('stale.js');
  const editor = await vscode.window.showTextDocument(staleUri, { preview: false });
  const runtime = await startFakeRuntime({ scripts: [{ scriptId: '7', url: '/srv/app/stale.js', source: loaded }] });
  await connectThroughCommand(api, runtime);

  // Edited and saved in the editor after the runtime loaded it — and the app not restarted.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// edited\n'));
  assert.ok(await editor.document.save(), 'saved the edit');

  runtime.sendLog('stale', { url: '/srv/app/stale.js', scriptId: '7', line: 0 });
  runtime.sendLog('unmapped', { url: '/opt/elsewhere/job.js', line: 0 });
  runtime.sendLog('internal', { url: 'node:internal/timers', line: 0 });

  const steps = await waitFor(
    () =>
      refreshed(api, () => {
        const { counts } = stepById(api.checklist(), 'logs');
        return counts.received === 3 && counts.drawn + counts.dropped === 3 && api.checklist();
      }),
    'all three logs to be handled',
  );
  const logs = stepById(steps, 'logs');
  assert.deepStrictEqual(logs.counts, { received: 3, drawn: 0, dropped: 3 });
  assert.strictEqual(logs.status, 'fail');
  assert.deepStrictEqual(logs.dropGroups.map((g) => g.reason).sort(), ['all-frames-skipped', 'no-path-mapping', 'stale-file']);
  assert.match(logs.dropGroups.find((g) => g.reason === 'stale-file').label, /restart/);

  const mapping = stepById(steps, 'path-mapping');
  assert.strictEqual(mapping.status, 'fail');
  assert.ok(mapping.fixes.some((f) => f.kind === 'open-settings'), 'offers to declare a mapping');

  assert.deepStrictEqual(api.decorations(staleUri.toString()), [], 'a Stale File is never drawn');
  await waitFor(() => stepById(api.panelState().steps, 'logs').counts.dropped === 3, 'the panel to show the same checklist');
});

test('a line hit several times shows its count; reconnecting to the same runtime (an app restart) resets it', async () => {
  const api = await extensionApi();
  const historyUri = workspaceUri('history.js');
  await vscode.window.showTextDocument(historyUri, { preview: false });
  const runtime = await startFakeRuntime({ id: 'restarting', title: 'restarting app' });
  const key = await connectThroughCommand(api, runtime);

  for (const i of [0, 1, 2]) runtime.sendLog(String(i), { url: '/srv/app/history.js', line: 1 });
  const drawn = await waitFor(
    () => api.decorations(historyUri.toString()).find((d) => d.text === '2 (×3)'),
    'the loop line drawn with its count',
  );
  assert.strictEqual(drawn.line, 1);
  assert.strictEqual(api.hovers(historyUri.toString())[0].history.length, 2);

  await disconnect(api, key);
  await connectThroughCommand(api, runtime);
  await waitFor(() => api.decorations(historyUri.toString()).length === 0, 'the previous run’s values to be cleared');

  runtime.sendLog('fresh', { url: '/srv/app/history.js', line: 1 });
  const fresh = await waitFor(() => api.decorations(historyUri.toString())[0], 'the new run’s value');
  assert.strictEqual(fresh.text, 'fresh');
});

test('deleting a console.log, or its whole line, takes its inline value away', async () => {
  const api = await extensionApi();
  const uri = workspaceUri('delete-log.js');
  const editor = await vscode.window.showTextDocument(uri);
  onCleanup(() => vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'));
  const runtime = await startFakeRuntime();
  await connectThroughCommand(api, runtime);
  runtime.sendLog('42', { url: '/srv/app/delete-log.js', line: 1 });
  runtime.sendLog('kept', { url: '/srv/app/delete-log.js', line: 3 });
  await waitFor(() => api.decorations(uri.toString()).length === 2, 'both values drawn');

  // Select `console.log(total);` and delete it — the line itself stays.
  await editor.edit((edit) => edit.delete(editor.document.lineAt(1).range));
  await waitFor(
    () => JSON.stringify(api.decorations(uri.toString())) === JSON.stringify([{ line: 3, text: 'kept' }]),
    `only 'kept' left, got ${JSON.stringify(api.decorations(uri.toString()))}`,
  );

  // Log line 1 again, then delete that whole line: nothing slides onto `var after = 1;`.
  await editor.edit((edit) => edit.insert(new vscode.Position(1, 0), 'console.log(total);'));
  runtime.sendLog('42 again', { url: '/srv/app/delete-log.js', line: 1 });
  await waitFor(() => api.decorations(uri.toString()).some((d) => d.text === '42 again'), 'the new value drawn');
  await editor.edit((edit) => edit.delete(new vscode.Range(1, 0, 2, 0)));
  await waitFor(
    () => JSON.stringify(api.decorations(uri.toString())) === JSON.stringify([{ line: 2, text: 'kept' }]),
    `the deleted line's value gone, 'kept' moved up, got ${JSON.stringify(api.decorations(uri.toString()))}`,
  );
});
