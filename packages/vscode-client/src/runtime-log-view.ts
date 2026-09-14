import * as vscode from 'vscode';

/** What the webview asks the extension host to do — one message type per button/field. */
export interface RuntimeLogViewCallbacks {
  connect(hostPort: string): void;
  disconnect(): void;
  launchChromeDebug(port: number): void;
  openSettings(): void;
}

/**
 * Activity-bar panel for the runtime-log feature. A `WebviewView` (not a plain `TreeView`) so
 * the host:port and Chrome debug-port fields can live in the panel itself, instead of a
 * `showInputBox` popup for every connect — the panel is a thin UI, all connect/disconnect
 * logic still lives in extension.ts and runs through the same commands as before.
 */
export class RuntimeLogViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly connectionCount: () => number,
    private readonly defaultChromePort: () => number,
    private readonly callbacks: RuntimeLogViewCallbacks,
  ) {}

  /** Call whenever the connection count changes, so the status line stays current. */
  refresh(): void {
    this.postStatus();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { type: string; hostPort?: string; port?: number }) => {
      if (msg.type === 'connect' && msg.hostPort) this.callbacks.connect(msg.hostPort);
      else if (msg.type === 'disconnect') this.callbacks.disconnect();
      else if (msg.type === 'launchChrome') this.callbacks.launchChromeDebug(msg.port ?? this.defaultChromePort());
      else if (msg.type === 'openSettings') this.callbacks.openSettings();
    });
    this.postStatus();
  }

  private postStatus(): void {
    void this.view?.webview.postMessage({
      type: 'status',
      count: this.connectionCount(),
      chromePort: this.defaultChromePort(),
    });
  }

  private html(): string {
    // No external resources (CSP default-src 'none' below) — everything inline, styled with
    // the editor's own CSS variables so it matches light/dark/high-contrast without extra work.
    return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
  h4 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; opacity: 0.75; }
  h4:first-child { margin-top: 0; }
  #status { margin-bottom: 8px; font-weight: 600; }
  .row { display: flex; gap: 4px; margin-bottom: 6px; }
  input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
</style>
</head>
<body>
  <div id="status">Not connected</div>

  <h4>Connect to Runtime</h4>
  <div class="row">
    <input id="hostPort" type="text" placeholder="127.0.0.1:5000" />
    <button id="connectBtn">Connect</button>
  </div>
  <div class="row">
    <button id="disconnectBtn" class="secondary" style="flex:1">Disconnect…</button>
  </div>

  <h4>Chrome (CDP debug)</h4>
  <div class="row">
    <input id="chromePort" type="number" style="flex: 0 0 5em" />
    <button id="launchChromeBtn" style="flex:1">Launch Chrome debug</button>
  </div>

  <h4>Settings</h4>
  <div class="row"><a id="settingsLink">Runtime Log Settings…</a></div>

<script>
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const hostPortEl = document.getElementById('hostPort');
  const chromePortEl = document.getElementById('chromePort');

  document.getElementById('connectBtn').addEventListener('click', () => {
    if (hostPortEl.value.trim()) vscode.postMessage({ type: 'connect', hostPort: hostPortEl.value.trim() });
  });
  hostPortEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('connectBtn').click(); });
  document.getElementById('disconnectBtn').addEventListener('click', () => vscode.postMessage({ type: 'disconnect' }));
  document.getElementById('launchChromeBtn').addEventListener('click', () => {
    const port = Number(chromePortEl.value);
    const p = Number.isFinite(port) ? port : undefined;
    vscode.postMessage({ type: 'launchChrome', port: p });
    if (p) hostPortEl.value = '127.0.0.1:' + p; // pre-fill Connect once the tab has loaded
  });
  document.getElementById('settingsLink').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type !== 'status') return;
    statusEl.textContent = msg.count > 0 ? msg.count + ' connected' : 'Not connected';
    if (!chromePortEl.value) chromePortEl.value = String(msg.chromePort);
    if (!hostPortEl.value) hostPortEl.value = '127.0.0.1:' + msg.chromePort;
  });
</script>
</body>
</html>`;
  }
}
