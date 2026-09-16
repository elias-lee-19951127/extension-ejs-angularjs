import * as vscode from 'vscode';
import { formatSkipReason, formatWrapperSuggestionText, type RuntimeStatusSummary } from './runtime-log-state';

/** What the webview asks the extension host to do — one message type per button/field. */
export interface RuntimeLogViewCallbacks {
  connect(hostPort: string): void;
  disconnect(): void;
  launchChromeDebug(port: number): void;
  openSettings(): void;
  /** Ticket 03, item 7 — user clicked "Skip this file" on a wrapper-file suggestion. */
  acceptWrapperSuggestion(path: string): void;
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
    /** Ticket 02, item 4 — the real received/drawn/dropped totals, not just a connection count. */
    private readonly statusSummary: () => RuntimeStatusSummary,
    private readonly callbacks: RuntimeLogViewCallbacks,
  ) {}

  /** Call whenever the connection count or status summary changes, so the panel stays current. */
  refresh(): void {
    this.postStatus();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { type: string; hostPort?: string; port?: number; path?: string }) => {
      if (msg.type === 'connect' && msg.hostPort) this.callbacks.connect(msg.hostPort);
      else if (msg.type === 'disconnect') this.callbacks.disconnect();
      else if (msg.type === 'launchChrome') this.callbacks.launchChromeDebug(msg.port ?? this.defaultChromePort());
      else if (msg.type === 'openSettings') this.callbacks.openSettings();
      else if (msg.type === 'acceptWrapperSuggestion' && msg.path) this.callbacks.acceptWrapperSuggestion(msg.path);
    });
    this.postStatus();
  }

  private postStatus(): void {
    const summary = this.statusSummary();
    void this.view?.webview.postMessage({
      type: 'status',
      count: this.connectionCount(),
      chromePort: this.defaultChromePort(),
      received: summary.received,
      drawn: summary.drawn,
      dropped: summary.dropped,
      connecting: summary.connecting,
      failed: summary.failed,
      // Ticket 03, items 6-7 — pre-formatted here (extension host, TS) rather than in the
      // webview's own JS, matching this feature's "pure formatter + thin wiring" split; the
      // webview just renders strings, same as it already does for the rest of the status line.
      recentLogs: summary.recentLogs
        .slice()
        .reverse() // most recent first
        .map((log) => ({
          chosenLabel: log.chosenPath ?? '(no frame drawn — panel only)',
          frames: log.frames.map((f) => ({ url: f.url, label: formatSkipReason(f) })),
        })),
      wrapperSuggestion: summary.wrapperSuggestion
        ? { path: summary.wrapperSuggestion.path, text: formatWrapperSuggestionText(summary.wrapperSuggestion) }
        : null,
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
  #wrapperSuggestion { display: none; margin-bottom: 10px; padding: 6px 8px; border-radius: 2px;
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border, transparent)); }
  #wrapperSuggestion p { margin: 0 0 6px; word-break: break-all; }
  .recentLog { margin-bottom: 8px; }
  .recentLog .chosen { font-weight: 600; }
  .recentLog .frame { padding-left: 10px; opacity: 0.8; word-break: break-all; }
  .recentLog .frame.drawn { opacity: 1; }
  #recentLogsEmpty { opacity: 0.6; }
</style>
</head>
<body>
  <div id="status">Not connected</div>

  <div id="wrapperSuggestion">
    <p id="wrapperSuggestionText"></p>
    <button id="wrapperSuggestionBtn">Skip this file</button>
  </div>

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

  <h4>Recent logs — frames tried</h4>
  <div id="recentLogs"><div id="recentLogsEmpty">No logs yet.</div></div>

  <h4>Settings</h4>
  <div class="row"><a id="settingsLink">Runtime Log Settings…</a></div>

<script>
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const hostPortEl = document.getElementById('hostPort');
  const chromePortEl = document.getElementById('chromePort');
  const recentLogsEl = document.getElementById('recentLogs');
  const wrapperEl = document.getElementById('wrapperSuggestion');
  const wrapperTextEl = document.getElementById('wrapperSuggestionText');
  let wrapperSuggestionPath = null;

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
  // Ticket 03, item 7 — never written to settings until the user explicitly clicks this.
  document.getElementById('wrapperSuggestionBtn').addEventListener('click', () => {
    if (wrapperSuggestionPath) vscode.postMessage({ type: 'acceptWrapperSuggestion', path: wrapperSuggestionPath });
  });

  function renderRecentLogs(logs) {
    recentLogsEl.textContent = '';
    if (!logs || logs.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'recentLogsEmpty';
      empty.textContent = 'No logs yet.';
      recentLogsEl.appendChild(empty);
      return;
    }
    for (const log of logs) {
      const entry = document.createElement('div');
      entry.className = 'recentLog';
      const chosen = document.createElement('div');
      chosen.className = 'chosen';
      chosen.textContent = log.chosenLabel;
      entry.appendChild(chosen);
      for (const frame of log.frames) {
        const line = document.createElement('div');
        line.className = 'frame' + (frame.label === 'chosen' ? ' drawn' : '');
        line.textContent = frame.url + ' — ' + frame.label;
        entry.appendChild(line);
      }
      recentLogsEl.appendChild(entry);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type !== 'status') return;
    if (msg.count > 0) {
      // Ticket 02: "received / drawn / dropped" tells a WAY more useful story than a bare
      // connection count — the classic symptom this replaces is "1 connected" with nothing
      // ever drawing and no way to tell why.
      var note = msg.connecting > 0 ? ' (connecting…)' : msg.failed > 0 ? ' (failed)' : '';
      statusEl.textContent = 'received ' + msg.received + ' / drawn ' + msg.drawn + ' / dropped ' + msg.dropped + note;
    } else {
      statusEl.textContent = 'Not connected';
    }
    if (!chromePortEl.value) chromePortEl.value = String(msg.chromePort);
    if (!hostPortEl.value) hostPortEl.value = '127.0.0.1:' + msg.chromePort;

    renderRecentLogs(msg.recentLogs);

    if (msg.wrapperSuggestion) {
      wrapperSuggestionPath = msg.wrapperSuggestion.path;
      wrapperTextEl.textContent = msg.wrapperSuggestion.text;
      wrapperEl.style.display = 'block';
    } else {
      wrapperSuggestionPath = null;
      wrapperEl.style.display = 'none';
    }
  });
</script>
</body>
</html>`;
  }
}
