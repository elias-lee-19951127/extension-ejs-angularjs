/**
 * "Log This at Runtime" in a real VS Code (.scratch/log-here/spec.md): the command behind the
 * editor's context menu and `Cmd+Alt+L` logs what the cursor is on — a local, an assignment
 * target, a selection — and refuses, with a reason, to log a call.
 */
const assert = require('node:assert');
const vscode = require('vscode');
const { test, onCleanup, workspaceUri, extensionApi, waitFor, stubWindow } = require('./helpers');

const SOURCE = [
  "angular.module('app', []).controller('HereCtrl', function ($scope, $http) {",
  "  $http.get('/rows').then(function (res) {",
  '    var local = res.data;',
  '    $scope.rows = local;',
  '  });',
  '  $scope.reload = function () { load(); };',
  '});',
  '',
].join('\n');

/** Put the cursor at the first `needle` (plus an offset into it), or select it. */
async function cursorOn(editor, needle, { offset = 0, select = false } = {}) {
  const idx = SOURCE.indexOf(needle) + offset;
  const pos = editor.document.positionAt(idx);
  const end = select ? editor.document.positionAt(idx + needle.length - offset) : pos;
  editor.selection = new vscode.Selection(pos, end);
}

const ours = (uri) => vscode.debug.breakpoints.filter((b) => b.location?.uri.toString() === uri && b.logMessage);

test('the command logs the local under the cursor, toggles it off, and refuses a call', async () => {
  await extensionApi();
  const uri = workspaceUri('here.controller.js');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(SOURCE));
  onCleanup(() => vscode.workspace.fs.delete(uri));
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  onCleanup(() => vscode.debug.removeBreakpoints(ours(uri.toString())));

  // A local the line is about to use: logged at the start of that line.
  await cursorOn(editor, 'local;');
  await vscode.commands.executeCommand('ejsng.logHere');
  const [bp] = await waitFor(() => (ours(uri.toString()).length ? ours(uri.toString()) : null), 'the logpoint');
  assert.strictEqual(bp.logMessage, 'local = {local}');
  assert.strictEqual(bp.location.range.start.line, 3);
  assert.strictEqual(editor.document.lineAt(3).text.slice(bp.location.range.start.character, bp.location.range.start.character + 6), '$scope');

  // Same place again: off.
  await vscode.commands.executeCommand('ejsng.logHere');
  await waitFor(() => ours(uri.toString()).length === 0, 'the logpoint to be removed');

  // An assignment target: after the statement, so the value is the one just assigned.
  await cursorOn(editor, '$scope.rows = local', { offset: 2 });
  await vscode.commands.executeCommand('ejsng.logHere');
  const [target] = await waitFor(() => (ours(uri.toString()).length ? ours(uri.toString()) : null), 'the second logpoint');
  assert.strictEqual(target.logMessage, 'rows = {$scope.rows}');
  assert.strictEqual(editor.document.lineAt(3).text.slice(target.location.range.start.character - 6, target.location.range.start.character), 'local;');
  vscode.debug.removeBreakpoints(ours(uri.toString()));

  // A selection wins over the cursor.
  await cursorOn(editor, 'res.data;', { select: true });
  editor.selection = new vscode.Selection(editor.selection.start, editor.document.positionAt(SOURCE.indexOf('res.data;') + 'res.data'.length));
  await vscode.commands.executeCommand('ejsng.logHere');
  const [selected] = await waitFor(() => (ours(uri.toString()).length ? ours(uri.toString()) : null), 'the logpoint for the selection');
  assert.strictEqual(selected.logMessage, 'data = {res.data}');
  vscode.debug.removeBreakpoints(ours(uri.toString()));

  // A call is refused, with a reason, and nothing is set.
  const messages = [];
  stubWindow('showInformationMessage', async (message) => {
    messages.push(message);
    return undefined;
  });
  await cursorOn(editor, 'load();');
  await vscode.commands.executeCommand('ejsng.logHere');
  await waitFor(() => messages.length > 0, 'the refusal to be explained');
  assert.match(messages[0], /function call/);
  assert.strictEqual(ours(uri.toString()).length, 0);
});

test('the keybinding is bound to the command, and only in JavaScript', async () => {
  const extension = vscode.extensions.getExtension('phule.ejs-angularjs-navigator');
  const [binding] = extension.packageJSON.contributes.keybindings.filter((k) => k.command === 'ejsng.logHere');
  assert.deepStrictEqual([binding.key, binding.mac], ['ctrl+alt+l', 'cmd+alt+l']);
  assert.match(binding.when, /editorLangId == javascript/);
  // Nothing else in this VS Code claims it: `cmd+alt+l` is free by default.
  const conflicts = (await vscode.commands.getCommands(true)).filter((c) => c === 'ejsng.logHere');
  assert.deepStrictEqual(conflicts, ['ejsng.logHere']);
});
