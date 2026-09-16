'use strict';
// Throwaway: stands in for ticket 12's real UI-side companion extension.
// extensionKind: ["ui"] forces this to run on the same host as the VS Code
// UI (and, on Remote-WSL, the same host as Chrome). Attaches to a page's CDP
// endpoint, captures our synthetic log events, and forwards each one to
// proto-workspace-host via whichever mechanism the user picked. Delete this
// whole folder after the measurement is done and written up.
const vscode = require('vscode');
const http = require('http');
const net = require('net');
const { URL } = require('url');
const { connectCdp } = require('./ws-client');

function findPageWsUrl(cdpPort, urlMatch) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: cdpPort, path: '/json/list' }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const list = JSON.parse(data);
            const page = list.find((p) => p.type === 'page' && p.url.includes(urlMatch));
            if (!page) {
              reject(new Error(`no CDP page target matching "${urlMatch}" — open gen-log-page.html in Chrome first`));
              return;
            }
            resolve(page.webSocketDebuggerUrl);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function makeForwarder(mech, output) {
  if (mech === 'commands') {
    return {
      send(payload) {
        vscode.commands.executeCommand('protoWorkspace.ingest', payload);
      },
      close() {},
    };
  }
  if (mech === 'port') {
    const forwardedUriStr = await vscode.commands.executeCommand('protoWorkspace.getForwardedUri');
    const forwardedUri = vscode.Uri.parse(forwardedUriStr);
    const [host, portStr] = forwardedUri.authority.split(':');
    output.appendLine(`[ui-ext] connecting to forwarded ${host}:${portStr} (raw uri: ${forwardedUriStr})`);
    const socket = net.connect({ host, port: Number(portStr) });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return {
      send(payload) {
        socket.write(JSON.stringify(payload) + '\n');
      },
      close() {
        socket.end();
      },
    };
  }
  throw new Error(`unknown mechanism: ${mech}`);
}

async function runMechanism(mech, cdpPort, output) {
  const forwarder = await makeForwarder(mech, output);
  const wsUrl = await findPageWsUrl(cdpPort, 'gen-log-page.html');
  let received = 0;

  const cdp = await connectCdp(wsUrl, (msg) => {
    if (msg.method !== 'Runtime.consoleAPICalled') return;
    const args = msg.params.args || [];
    if (args[0] && args[0].value === 'PROTO_LOG') {
      const seq = args[1] && args[1].value;
      const tSendMs = args[2] && args[2].value;
      const tCaptureMs = Date.now();
      received++;
      forwarder.send({ seq, tSendMs, tCaptureMs, mech });
      if (received % 500 === 0) output.appendLine(`[ui-ext] captured ${received} so far`);
    } else if (args[0] && args[0].value === 'PROTO_LOG_DONE') {
      output.appendLine(`[ui-ext] page reports generator done; captured ${received} events total`);
    }
  });
  cdp.send('Runtime.enable');
  output.appendLine(`[ui-ext] attached via "${mech}" mechanism, Runtime.enable sent — click Start on the page now`);
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Proto UI Companion');
  context.subscriptions.push(output);
  output.appendLine(`[ui-ext] vscode.env.remoteName = ${vscode.env.remoteName || '(none)'} — this value should be UNSET here even in a remote window, since extensionKind ui pins this host to the UI side`);

  async function runFlow(mech) {
    const portStr = await vscode.window.showInputBox({
      prompt: "Chrome --remote-debugging-port (Chrome must already be running with this flag, on this same UI-side machine)",
      value: '9222',
    });
    if (!portStr) return;
    try {
      await runMechanism(mech, Number(portStr), output);
      vscode.window.showInformationMessage(`proto-ui-companion: attached via "${mech}". Open Output > Proto UI Companion, then click Start on gen-log-page.html.`);
    } catch (e) {
      vscode.window.showErrorMessage(`proto-ui-companion: ${e.message}`);
      output.appendLine(`[ui-ext] ERROR: ${e.stack || e.message}`);
    }
  }

  context.subscriptions.push(vscode.commands.registerCommand('protoUi.runCommandsMechanism', () => runFlow('commands')));
  context.subscriptions.push(vscode.commands.registerCommand('protoUi.runPortMechanism', () => runFlow('port')));
}

function deactivate() {}

module.exports = { activate, deactivate };
