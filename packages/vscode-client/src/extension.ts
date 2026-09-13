import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // The server is already bundled into the extension (see build.js). Do not
  // point outside the extension directory: such a path is not part of the .vsix package.
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const cfg = vscode.workspace.getConfiguration('ejsng');
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'html' },
      { scheme: 'file', language: 'ejs' },
      { scheme: 'file', pattern: '**/*.ejs' },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{js,ejs,html}'),
    },
    initializationOptions: {
      include: cfg.get('include'),
      exclude: cfg.get('exclude'),
      moduleAliases: cfg.get('moduleAliases'),
      ejsDelimiter: cfg.get('ejsDelimiter'),
      customDirectives: cfg.get('customDirectives'),
      diagnostics: { enabled: cfg.get('diagnostics.enabled') },
    },
  };

  client = new LanguageClient('ejsng', 'EJS + AngularJS Navigator', serverOptions, clientOptions);

  context.subscriptions.push(
    vscode.commands.registerCommand('ejsng.reindex', async () => {
      const r = await client?.sendRequest('ejsng/reindex');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
    vscode.commands.registerCommand('ejsng.showStats', async () => {
      const r = await client?.sendRequest('ejsng/stats');
      void vscode.window.showInformationMessage(`EJS/NG: ${JSON.stringify(r)}`);
    }),
  );

  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
