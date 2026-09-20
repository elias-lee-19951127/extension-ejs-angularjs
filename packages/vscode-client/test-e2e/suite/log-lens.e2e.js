/**
 * The "Log at runtime" CodeLens in a real VS Code (.scratch/log-lens/spec.md): one click on the
 * line that assigns a scope variable sets the logpoint for it — no box, no typing — and clicking
 * the same lens again takes it off.
 */
const assert = require('node:assert');
const vscode = require('vscode');
const { test, onCleanup, workspaceUri, extensionApi, waitFor } = require('./helpers');

const lensesFor = (uri) => vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);

async function withLogLens(value) {
  const cfg = vscode.workspace.getConfiguration('ejsng');
  const before = cfg.inspect('logLens').workspaceValue;
  await cfg.update('logLens', value, vscode.ConfigurationTarget.Workspace);
  onCleanup(() => vscode.workspace.getConfiguration('ejsng').update('logLens', before, vscode.ConfigurationTarget.Workspace));
}

test('a lens sits on the assignment the index cannot type; clicking it sets the logpoint, clicking again removes it', async () => {
  await extensionApi();
  const uri = workspaceUri('list.controller.js');
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);

  // Default `unknown`: only `$scope.rows = res.data;`, not `$scope.rows = []` above it.
  const lenses = await waitFor(async () => {
    const found = await lensesFor(uri);
    return found && found.length ? found : null;
  }, 'the log lens');
  assert.strictEqual(lenses.length, 1, JSON.stringify(lenses.map((l) => l.command.title)));
  const [lens] = lenses;
  assert.match(lens.command.title, /Log rows at runtime$/);
  // The lens sits on the line of the assignment — here a one-line callback, which is exactly the
  // case a gutter logpoint cannot handle.
  assert.match(doc.lineAt(lens.range.start.line).text, /\$scope\.rows = res\.data;/);

  const args = lens.command.arguments[0];
  const ours = () => vscode.debug.breakpoints.filter((b) => b.location?.uri.toString() === args.uri && b.logMessage === args.logMessage);
  onCleanup(() => vscode.debug.removeBreakpoints(ours()));

  await vscode.commands.executeCommand(lens.command.command, args);
  const [bp] = await waitFor(() => (ours().length ? ours() : null), 'the logpoint the lens sets');
  // Right after the statement, so it logs the value that was just assigned.
  assert.deepStrictEqual([bp.location.range.start.line, bp.location.range.start.character], [args.line, args.character]);
  assert.strictEqual(bp.logMessage, 'rows = {$scope.rows}');

  // The lens now offers to take it off, and does.
  const logging = await waitFor(async () => {
    const found = await lensesFor(uri);
    return found?.[0]?.command.title.includes('click to remove') ? found[0] : null;
  }, 'the lens to say it is logging');
  await vscode.commands.executeCommand(logging.command.command, logging.command.arguments[0]);
  await waitFor(() => ours().length === 0, 'the logpoint to be removed');
});

test('ejsng.logLens: "all" lenses every assignment, "off" none', async () => {
  const uri = workspaceUri('list.controller.js');
  await vscode.workspace.openTextDocument(uri);

  await withLogLens('all');
  const all = await waitFor(async () => {
    const found = await lensesFor(uri);
    return found && found.length > 1 ? found : null;
  }, 'a lens on every assignment');
  assert.deepStrictEqual(
    all.map((l) => [l.range.start.line, l.command.title.replace(/^\$\(.*?\) /, '')]),
    [
      [1, 'Log rows at runtime'], // `$scope.rows = []` — typed, so only "all" shows it
      [2, 'Log rows at runtime'],
    ],
  );

  await withLogLens('off');
  await waitFor(async () => (await lensesFor(uri)).length === 0, 'no lenses at all');
});
