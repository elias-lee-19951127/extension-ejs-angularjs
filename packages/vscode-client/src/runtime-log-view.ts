import * as vscode from 'vscode';
import {
  formatSkipReason,
  isRuntimeChecklistFix,
  type RuntimeChecklistFix,
  type RuntimeChecklistStep,
  type RuntimeStatusSummary,
} from './runtime-log-state';

/** What the webview asks the extension host to do — one message type per button/field. */
export interface RuntimeLogViewCallbacks {
  /** Ticket 09 — the big Connect button: run the whole chain, environment → Docker → target → mapping → connect. */
  connectAuto(): void;
  /**
   * The "Advanced" host:port field, unchanged from before ticket 09. `hostPort` may be `''`
   * (ticket 04: Docker discovery with no app port filter), a bare number (an app port), or
   * `host:port` (direct connect).
   */
  connect(hostPort: string): void;
  disconnect(): void;
  launchChromeDebug(port: number): void;
  openSettings(): void;
  /** Ticket 09 — a fix button on a checklist step. Already validated by `isRuntimeChecklistFix`. */
  applyFix(fix: RuntimeChecklistFix): void;
  /** Ticket 09 — put the markdown report on the clipboard. Nothing is sent anywhere. */
  copyReport(): void;
}

/**
 * Activity-bar panel for the runtime-log feature (ticket 09): one big Connect button, a
 * step-by-step checklist where each step says ✔/✖ and why, with a fix button right on the step
 * when there is one, a "Copy report" button, and the old host:port field under "Advanced". Not a
 * separate wizard — the checklist IS the Connect chain, shown as it runs.
 *
 * A thin renderer: the steps come from the server (`ejsng/runtimeChecklist`), and every action
 * runs in extension.ts.
 */
export class RuntimeLogViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly connectionCount: () => number,
    private readonly defaultChromePort: () => number,
    private readonly statusSummary: () => RuntimeStatusSummary,
    private readonly checklist: () => RuntimeChecklistStep[],
    private readonly callbacks: RuntimeLogViewCallbacks,
  ) {}

  /** Call whenever the connection count, status summary or checklist changes, so the panel stays current. */
  refresh(): void {
    this.postStatus();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { type: string; hostPort?: string; port?: number; fix?: unknown }) => {
      if (msg.type === 'connectAuto') this.callbacks.connectAuto();
      // Ticket 04: an empty `hostPort` is a valid Connect click too.
      else if (msg.type === 'connect') this.callbacks.connect(msg.hostPort ?? '');
      else if (msg.type === 'disconnect') this.callbacks.disconnect();
      else if (msg.type === 'launchChrome') this.callbacks.launchChromeDebug(msg.port ?? this.defaultChromePort());
      else if (msg.type === 'openSettings') this.callbacks.openSettings();
      else if (msg.type === 'applyFix' && isRuntimeChecklistFix(msg.fix)) this.callbacks.applyFix(msg.fix);
      else if (msg.type === 'copyReport') this.callbacks.copyReport();
    });
    this.postStatus();
  }

  private postStatus(): void {
    const summary = this.statusSummary();
    void this.view?.webview.postMessage({
      type: 'status',
      count: this.connectionCount(),
      chromePort: this.defaultChromePort(),
      steps: this.checklist(),
      // Ticket 03, item 6 — pre-formatted here, the webview just renders strings.
      recentLogs: summary.recentLogs
        .slice()
        .reverse() // most recent first
        .map((log) => ({
          chosenLabel: log.chosenPath ?? '(no frame drawn — panel only)',
          frames: log.frames.map((f) => ({ url: f.url, label: formatSkipReason(f) })),
        })),
    });
  }

  private html(): string {
    // No external resources (CSP default-src 'none' below) — everything inline, styled with
    // the editor's own CSS variables so it matches light/dark/high-contrast without extra work.
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
  h4 { margin: 14px 0 4px; font-size: 11px; text-transform: uppercase; opacity: 0.75; }
  .row { display: flex; gap: 4px; margin-bottom: 6px; }
  input { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #connectAutoBtn { flex: 1; padding: 6px 10px; font-size: 13px; font-weight: 600; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .step { display: flex; gap: 6px; padding: 5px 0; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  .step .mark { flex: 0 0 1.2em; text-align: center; font-weight: 700; }
  .step.ok .mark { color: var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen)); }
  .step.warn .mark { color: var(--vscode-editorWarning-foreground, var(--vscode-terminal-ansiYellow)); }
  .step.fail .mark { color: var(--vscode-errorForeground, var(--vscode-terminal-ansiRed)); }
  .step.pending .mark, .step.skipped .mark { opacity: 0.6; }
  .step .body { flex: 1; min-width: 0; }
  .step .title { font-weight: 600; }
  .step .detail { word-break: break-word; }
  .step.pending .detail, .step.skipped .detail { opacity: 0.75; }
  .step ul { margin: 3px 0 0; padding-left: 16px; opacity: 0.85; }
  .step li { word-break: break-all; }
  .step .fixes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .step .fixes button { white-space: normal; text-align: left; word-break: break-all; }
  .dropGroups { display: none; }
  .dropGroups.open { display: block; }
  details { margin-top: 12px; }
  summary { cursor: pointer; font-size: 11px; text-transform: uppercase; opacity: 0.75; margin-bottom: 6px; }
  .recentLog { margin-bottom: 8px; }
  .recentLog .chosen { font-weight: 600; word-break: break-all; }
  .recentLog .frame { padding-left: 10px; opacity: 0.8; word-break: break-all; }
  .recentLog .frame.drawn { opacity: 1; }
  .empty { opacity: 0.6; }
</style>
</head>
<body>
  <div class="row">
    <button id="connectAutoBtn">Connect</button>
    <button id="disconnectBtn" class="secondary" hidden>Disconnect…</button>
  </div>

  <div id="checklist"></div>
  <div class="row" style="margin-top:8px">
    <button id="copyReportBtn" class="secondary" style="flex:1" title="Markdown on the clipboard, home directory shown as ~. Nothing is sent anywhere.">Copy report</button>
  </div>

  <details id="advanced">
    <summary>Advanced</summary>
    <div class="row">
      <input id="hostPort" type="text" placeholder="host:port, app port, or blank = Docker" />
      <button id="connectBtn">Connect</button>
    </div>
    <div class="row">
      <input id="chromePort" type="number" style="flex: 0 0 5em" />
      <button id="launchChromeBtn" style="flex:1">Launch Chrome debug</button>
    </div>
    <div class="row"><a id="settingsLink">Runtime Log Settings…</a></div>
  </details>

  <h4>Recent logs — frames tried</h4>
  <div id="recentLogs"><div class="empty">No logs yet.</div></div>

<script>
  const vscode = acquireVsCodeApi();
  const MARKS = { ok: '✔', warn: '⚠', fail: '✖', pending: '…', skipped: '–' };
  const checklistEl = document.getElementById('checklist');
  const hostPortEl = document.getElementById('hostPort');
  const chromePortEl = document.getElementById('chromePort');
  const recentLogsEl = document.getElementById('recentLogs');
  const disconnectBtn = document.getElementById('disconnectBtn');
  // Survives a re-render: whether the user expanded "dropped" to see reasons by group.
  let dropGroupsOpen = false;

  document.getElementById('connectAutoBtn').addEventListener('click', () => vscode.postMessage({ type: 'connectAuto' }));
  document.getElementById('connectBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'connect', hostPort: hostPortEl.value.trim() });
  });
  hostPortEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('connectBtn').click(); });
  disconnectBtn.addEventListener('click', () => vscode.postMessage({ type: 'disconnect' }));
  document.getElementById('copyReportBtn').addEventListener('click', () => vscode.postMessage({ type: 'copyReport' }));
  document.getElementById('launchChromeBtn').addEventListener('click', () => {
    const port = Number(chromePortEl.value);
    const p = Number.isFinite(port) && port > 0 ? port : undefined;
    vscode.postMessage({ type: 'launchChrome', port: p });
    if (p) hostPortEl.value = '127.0.0.1:' + p; // pre-fill Connect once the tab has loaded
  });
  document.getElementById('settingsLink').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderLogsDetail(step, body) {
    const counts = step.counts;
    if (!counts || step.status === 'pending' && counts.received === 0) {
      body.appendChild(el('div', 'detail', step.detail));
      return;
    }
    const detail = el('div', 'detail', 'received ' + counts.received + ' / drawn ' + counts.drawn + ' / ');
    const groups = step.dropGroups || [];
    if (groups.length > 0) {
      const link = el('a', '', 'dropped ' + counts.dropped);
      link.title = 'Show why, by reason';
      const list = el('ul', 'dropGroups' + (dropGroupsOpen ? ' open' : ''));
      for (const g of groups) list.appendChild(el('li', '', g.count + ' — ' + g.label));
      link.addEventListener('click', () => {
        dropGroupsOpen = !dropGroupsOpen;
        list.classList.toggle('open', dropGroupsOpen);
      });
      detail.appendChild(link);
      body.appendChild(detail);
      body.appendChild(list);
    } else {
      detail.appendChild(document.createTextNode('dropped 0'));
      body.appendChild(detail);
    }
  }

  function renderChecklist(steps) {
    checklistEl.textContent = '';
    for (const step of steps || []) {
      const row = el('div', 'step ' + step.status);
      row.appendChild(el('div', 'mark', MARKS[step.status] || '?'));
      const body = el('div', 'body');
      body.appendChild(el('div', 'title', step.title));
      if (step.id === 'logs') renderLogsDetail(step, body);
      else body.appendChild(el('div', 'detail', step.detail));
      if (step.notes && step.notes.length > 0) {
        const notes = el('ul');
        for (const note of step.notes) notes.appendChild(el('li', '', note));
        body.appendChild(notes);
      }
      if (step.fixes && step.fixes.length > 0) {
        const fixes = el('div', 'fixes');
        for (const fix of step.fixes) {
          const btn = el('button', 'secondary', fix.label);
          btn.addEventListener('click', () => vscode.postMessage({ type: 'applyFix', fix }));
          fixes.appendChild(btn);
        }
        body.appendChild(fixes);
      }
      row.appendChild(body);
      checklistEl.appendChild(row);
    }
  }

  function renderRecentLogs(logs) {
    recentLogsEl.textContent = '';
    if (!logs || logs.length === 0) {
      recentLogsEl.appendChild(el('div', 'empty', 'No logs yet.'));
      return;
    }
    for (const log of logs) {
      const entry = el('div', 'recentLog');
      entry.appendChild(el('div', 'chosen', log.chosenLabel));
      for (const frame of log.frames) {
        entry.appendChild(el('div', 'frame' + (frame.label === 'chosen' ? ' drawn' : ''), frame.url + ' — ' + frame.label));
      }
      recentLogsEl.appendChild(entry);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type !== 'status') return;
    disconnectBtn.hidden = !(msg.count > 0);
    if (!chromePortEl.value) chromePortEl.value = String(msg.chromePort);
    renderChecklist(msg.steps);
    renderRecentLogs(msg.recentLogs);
  });
</script>
</body>
</html>`;
  }
}
