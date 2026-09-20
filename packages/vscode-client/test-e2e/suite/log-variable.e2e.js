/**
 * "Log at runtime" in a real VS Code (.scratch/log-variable/issues/03-hover-link-and-command.md):
 * the hover of a variable assigned from `res.data` carries a trusted link; running it sets ONE
 * logpoint right after the assignment — at a column, inside the one-line callback — and the
 * server sets it on the runtime with that column.
 */
const assert = require('node:assert');
const vscode = require('vscode');
const { test, onCleanup, workspaceUri, extensionApi, waitFor, startFakeRuntime, connectThroughCommand } = require('./helpers');

test('the hover offers "Log at runtime" for an untyped assignment; the command sets one column logpoint, and it reaches the runtime', async () => {
  const api = await extensionApi();
  const tpl = workspaceUri('list.html');
  const doc = await vscode.workspace.openTextDocument(tpl);
  const pos = doc.positionAt(doc.getText().indexOf('rows"'));

  const link = await waitFor(async () => {
    const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', tpl, pos)) ?? [];
    for (const hover of hovers) {
      for (const content of hover.contents) {
        const m = /command:ejsng\.logVariable\?([^)\s]+)/.exec(typeof content === 'string' ? content : content.value);
        if (m) return { args: JSON.parse(decodeURIComponent(m[1]))[0], content };
      }
    }
    return null;
  }, 'the "Log at runtime" link in the hover');
  const { args } = link;
  assert.strictEqual(args.logMessage, '$scope.rows = {$scope.rows}');
  // Untrusted markdown renders a `command:` link that does nothing when clicked. The list is
  // exactly the extension's own commands — never blanket trust.
  assert.ok(link.content.isTrusted.enabledCommands.includes('ejsng.logVariable'));
  assert.ok(link.content.isTrusted.enabledCommands.every((c) => c.startsWith('ejsng.')), JSON.stringify(link.content.isTrusted));

  const target = vscode.Uri.parse(args.uri).toString();
  const ours = () => vscode.debug.breakpoints.filter((b) => b.location && b.location.uri.toString() === target && b.logMessage === args.logMessage);
  onCleanup(() => vscode.debug.removeBreakpoints(ours()));

  await vscode.commands.executeCommand('ejsng.logVariable', args);
  const [bp] = await waitFor(() => (ours().length ? ours() : null), 'the logpoint to be added');
  const js = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
  const after = js.getText().indexOf('res.data;') + 'res.data;'.length;
  assert.deepStrictEqual([bp.location.range.start.line, bp.location.range.start.character], [js.positionAt(after).line, js.positionAt(after).character]);
  assert.strictEqual(bp.enabled, true);

  // A second click: still one.
  await vscode.commands.executeCommand('ejsng.logVariable', args);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(ours().length, 1);

  const runtime = await startFakeRuntime();
  await connectThroughCommand(api, runtime);
  const set = await waitFor(
    () =>
      runtime.commands.find(
        (c) => c.method === 'Debugger.setBreakpointByUrl' && c.params.urlRegex && new RegExp(c.params.urlRegex).test('file:///srv/app/list.controller.js'),
      ),
    'the logpoint to be set on the runtime',
  );
  assert.deepStrictEqual([set.params.lineNumber, set.params.columnNumber], [bp.location.range.start.line, bp.location.range.start.character]);
});
