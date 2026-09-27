/**
 * expand-log-values in a real VS Code (.scratch/expand-log-values/issues/03-expand-on-click.md):
 * a logged array of objects reads as objects inline, its hover carries the laid-out value and a
 * "Show full value" link, and following that link opens a read-only JSON tab that folds.
 */
const assert = require('node:assert');
const vscode = require('vscode');
const { test, onCleanup, workspaceUri, extensionApi, waitFor, startFakeRuntime, connectThroughCommand } = require('./helpers');

const ROWS = Array.from({ length: 8 }, (_, i) => ({ id: i, title: `Sensor ${i}`, owner: { id: 7, name: 'ops' } }));

test('a logged array reads as objects inline, and "Show full value" opens it as JSON', async () => {
  const api = await extensionApi();
  // A file of its own: decorations outlive a connection, and other suites assert app.js's exactly.
  const appUri = workspaceUri('values.js');
  await vscode.window.showTextDocument(appUri);

  const runtime = await startFakeRuntime();
  await connectThroughCommand(api, runtime);
  runtime.sendObjectLog('rows', ROWS, { url: '/srv/app/values.js', line: 0 });

  const drawn = await waitFor(
    () => api.decorations(appUri.toString()).find((d) => d.line === 0 && d.text.includes('id: 0')),
    'the expanded value drawn inline',
  );
  assert.doesNotMatch(drawn.text, /\bObject\b/, drawn.text);
  assert.match(drawn.text, /rows \[\{id: 0, title: 'Sensor 0', owner: \{id: 7, name: 'ops'\}\}/, drawn.text);

  // The hover (a decoration's hoverMessage, not a hover provider) shows it laid out, with the link.
  const md = api.hovers(appUri.toString()).find((h) => h.line === 0).markdown;
  assert.match(md, /owner: \{id: 7, name: 'ops'\}/, md);
  // The link carries a tooltip after its target: `(command:…?args "Open the whole value…")`.
  const link = /command:ejsng\.showLogValue\?(\S+?)[\s)]/.exec(md);
  assert.ok(link, md);

  await vscode.commands.executeCommand('ejsng.showLogValue', JSON.parse(decodeURIComponent(link[1]))[0]);
  const editor = await waitFor(
    () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'ejsng-log'),
    'the JSON tab to open',
  );
  onCleanup(() => vscode.commands.executeCommand('workbench.action.closeActiveEditor'));
  const parsed = JSON.parse(editor.document.getText());
  assert.strictEqual(parsed[0], 'rows');
  assert.deepStrictEqual(parsed[1][7], { id: 7, title: 'Sensor 7', owner: { id: 7, name: 'ops' } }, 'dug deeper than the inline rendering');
  assert.strictEqual(editor.document.languageId, 'json');
  const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', editor.document.uri);
  assert.ok(folds.length > 1, 'the tab folds, which is what the link is for');
});
