'use strict';
// Throwaway: stands in for the real ("main") extension for ticket 01's
// companion-extension prototype. Runs in the workspace/remote extension host.
// Receives events from proto-ui-companion via two mechanisms and records
// arrival time for later analysis. Delete this whole folder after the
// measurement is done and written up.
const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const path = require('path');

let server = null;
let forwardedUriStr = null;

function getResultsDir() {
  const dir = path.join(__dirname, '..', 'results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function record(dir, mech, payload) {
  const tReceiveMs = Date.now();
  const file = path.join(dir, `run-${mech}.ndjson`);
  fs.appendFileSync(file, JSON.stringify({ ...payload, tReceiveMs }) + '\n');
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Proto Workspace Host');
  context.subscriptions.push(output);
  const dir = getResultsDir();
  output.appendLine(`[workspace-ext] ready. results dir: ${dir}`);
  output.appendLine(`[workspace-ext] vscode.env.remoteName = ${vscode.env.remoteName || '(none — running local)'}`);

  context.subscriptions.push(
    vscode.commands.registerCommand('protoWorkspace.ingest', (payload) => {
      record(dir, payload.mech || 'commands', payload);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('protoWorkspace.getForwardedUri', async () => {
      if (!server) {
        server = net.createServer((socket) => {
          let buf = '';
          socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              if (!line.trim()) continue;
              try {
                record(dir, 'port', JSON.parse(line));
              } catch (e) {
                output.appendLine(`[workspace-ext] bad line: ${e.message}`);
              }
            }
          });
          socket.on('error', () => {});
        });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const port = server.address().port;
        const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}`));
        forwardedUriStr = external.toString();
        output.appendLine(`[workspace-ext] TCP server on 127.0.0.1:${port}, forwarded as ${forwardedUriStr}`);
      }
      return forwardedUriStr;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('protoWorkspace.reset', () => {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      forwardedUriStr = null;
      if (server) {
        server.close();
        server = null;
      }
      output.appendLine('[workspace-ext] results cleared, port server reset');
    })
  );
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
