/**
 * Completion in a real VS Code (.scratch/template-completion): the suggestions the editor's own
 * completion list shows in a template — the controller's scope, filters after `|` — and after
 * `$scope.` in the controller, where the TypeScript service alone sees only `any`.
 */
const assert = require('node:assert');
const { rmSync, writeFileSync } = require('node:fs');
const vscode = require('vscode');
const { test, onCleanup, workspacePath, workspaceUri, extensionApi, waitFor } = require('./helpers');

/** The labels VS Code's completion list offers at `§` in a new workspace file holding `text`. */
async function labelsAt(file, text, language) {
  const at = text.indexOf('§');
  writeFileSync(workspacePath(file), text.replace('§', ''));
  onCleanup(() => rmSync(workspacePath(file), { force: true }));
  const doc = await vscode.workspace.openTextDocument(workspaceUri(file));
  if (language) await vscode.languages.setTextDocumentLanguage(doc, language);
  await vscode.window.showTextDocument(doc);
  onCleanup(() => vscode.commands.executeCommand('workbench.action.closeActiveEditor'));
  const position = doc.positionAt(at);
  let items = [];
  await waitFor(async () => {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, position);
    items = list.items;
    return items.some((i) => (i.detail ?? '').length > 0 && /\$scope|filter|member|key/.test(i.detail));
  }, `ejsng suggestions in ${file}`);
  return items;
}

test('completion: a template offers the scope and, after `|`, filters', async () => {
  await extensionApi();
  const scope = await labelsAt('completion-scope.html', '<ul ng-controller="ListCtrl"><li>{{ § }}</li></ul>');
  const rows = scope.find((i) => i.label === 'rows');
  assert.ok(rows, 'rows is offered');
  assert.match(rows.detail, /on the \$scope of ListCtrl/);

  const filters = await labelsAt('completion-filter.html', '<ul ng-controller="ListCtrl"><li>{{ rows | § }}</li></ul>');
  assert.ok(filters.some((i) => i.label === 'orderBy' && /filter/.test(i.detail)), 'a built-in filter is offered');
  assert.ok(!filters.some((i) => i.label === 'rows' && /\$scope/.test(i.detail ?? '')), 'no scope variable after |');
});

test('completion: `$scope.` in a controller lists what the controller assigns', async () => {
  await extensionApi();
  const js = [
    "angular.module('app').controller('DraftCtrl', function ($scope) {",
    '  $scope.draft = { title: "" };',
    '  $scope.save = function () {};',
    '  $scope.§',
    '});',
    '',
  ].join('\n');
  const items = await labelsAt('completion-draft.js', js);
  const ours = items.filter((i) => /DraftCtrl/.test(i.detail ?? ''));
  assert.deepStrictEqual(ours.map((i) => i.label).sort(), ['draft', 'save']);
});
