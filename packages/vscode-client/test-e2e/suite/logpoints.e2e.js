/**
 * Inline logpoints in a real VS Code (.scratch/inline-logpoints/issues/03-vscode-client.md): a
 * logpoint added through VS Code's own breakpoint API reaches the fake runtime as a breakpoint
 * the server sets — by the container path, through the fixture's `/srv/app` mapping — and its
 * output is drawn inline. The real-V8 behaviour is covered in packages/server/test/runtime-log-logpoints.test.js.
 */
const assert = require('node:assert');
const vscode = require('vscode');
const { test, onCleanup, workspaceUri, extensionApi, waitFor, startFakeRuntime, connectThroughCommand } = require('./helpers');

const setCommands = (runtime) => runtime.commands.filter((c) => c.method === 'Debugger.setBreakpointByUrl');
const removeCommands = (runtime) => runtime.commands.filter((c) => c.method === 'Debugger.removeBreakpoint');

async function withSetting(key, value) {
  const cfg = vscode.workspace.getConfiguration('ejsng');
  const before = cfg.inspect(key).workspaceValue;
  await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
  onCleanup(() => vscode.workspace.getConfiguration('ejsng').update(key, before, vscode.ConfigurationTarget.Workspace));
}

test('a logpoint (never a plain breakpoint) is set on the runtime by its container path, and its output drawn inline', async () => {
  const api = await extensionApi();
  // A file of its own: decorations outlive a connection, and other suites assert app.js's exactly.
  const appUri = workspaceUri('logpoint.js');
  await vscode.window.showTextDocument(appUri);
  const logpoint = new vscode.SourceBreakpoint(new vscode.Location(appUri, new vscode.Position(1, 0)), true, undefined, undefined, 'said {msg}');
  const plain = new vscode.SourceBreakpoint(new vscode.Location(appUri, new vscode.Position(2, 0)));
  vscode.debug.addBreakpoints([logpoint, plain]);
  onCleanup(() => vscode.debug.removeBreakpoints([logpoint, plain]));

  const runtime = await startFakeRuntime();
  await connectThroughCommand(api, runtime);

  const set = await waitFor(
    () => setCommands(runtime).find((c) => c.params.urlRegex && new RegExp(c.params.urlRegex).test('file:///srv/app/logpoint.js')),
    'the logpoint to be set on its container path',
  );
  assert.strictEqual(set.params.lineNumber, 1);
  assert.ok(setCommands(runtime).every((c) => c.params.lineNumber === 1), 'a plain breakpoint is never set: the runtime never pauses');

  const id = Number(/ejsng-logpoint-(\d+)$/.exec(set.params.condition)[1]);
  runtime.sendLog(['said ', 'hi'], { url: '/srv/app/logpoint.js', line: 1, logpointId: id });
  const drawn = await waitFor(() => api.decorations(appUri.toString()).find((d) => d.line === 1 && d.text.includes('said')), 'the logpoint output drawn');
  assert.strictEqual(drawn.text, '  » said hi');

  vscode.debug.removeBreakpoints([logpoint]);
  await waitFor(() => removeCommands(runtime).length === setCommands(runtime).length, 'every breakpoint set to be removed');
});

test('ejsng.runtimeLog.logpoints = false takes every logpoint back off the runtime, and true puts them back', async () => {
  const api = await extensionApi();
  const logpoint = new vscode.SourceBreakpoint(new vscode.Location(workspaceUri('logpoint.js'), new vscode.Position(2, 0)), true, undefined, undefined, 'n = {n}');
  vscode.debug.addBreakpoints([logpoint]);
  onCleanup(() => vscode.debug.removeBreakpoints([logpoint]));

  const runtime = await startFakeRuntime();
  await connectThroughCommand(api, runtime);
  await waitFor(() => setCommands(runtime).length > 0, 'the logpoint to be set');

  await withSetting('runtimeLog.logpoints', false);
  await waitFor(() => removeCommands(runtime).length === setCommands(runtime).length, 'the logpoint to be removed');

  const setsBefore = setCommands(runtime).length;
  await vscode.workspace.getConfiguration('ejsng').update('runtimeLog.logpoints', true, vscode.ConfigurationTarget.Workspace);
  await waitFor(() => setCommands(runtime).length > setsBefore, 'the logpoint to be set again');
});
