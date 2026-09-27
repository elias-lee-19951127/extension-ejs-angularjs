/**
 * Template highlight in a real VS Code: in a template, the names JavaScript answers for are drawn
 * in their own color and bold — the controller, and the scope variable it sets — while a name only
 * the template declares (an `ng-repeat` variable) is left as it was.
 */
const assert = require('node:assert');
const vscode = require('vscode');
const { test, workspaceUri, extensionApi, waitFor } = require('./helpers');

test('a template colors what its controller backs, and nothing it declares itself', async () => {
  const api = await extensionApi();
  const uri = workspaceUri('list.html');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const drawn = () => api.templateHighlights(uri.toString());
  await waitFor(() => drawn().length >= 2, 'the linked names of list.html');
  assert.deepStrictEqual(drawn(), [
    { kind: 'declaration', text: 'ListCtrl' },
    { kind: 'scope', text: 'rows' },
  ]);
});
