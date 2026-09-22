import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ValueDetail, ValueSiteRow } from './runtime-values';

/** What the panel asks the extension host to do. */
export interface RuntimeValuesViewCallbacks {
  /**
   * A line (and one of its hits) was selected: answer with `showDetail`. `follow`: asked again only
   * because the list refreshed — nothing needs sending unless that hit changed.
   */
  select(id: string, hit: number, follow: boolean): void;
  /** Open the line in its editor. */
  reveal(id: string): void;
  /** Put text on the clipboard — the webview's own clipboard access is not dependable. */
  copy(text: string): void;
  /** "Open as JSON": the whole value in a read-only JSON tab. */
  openJson(id: string, hit: number): void;
  /** Forget every logged value, in the panel and beside the code. */
  clear(): void;
  connect(): void;
}

/**
 * The "Runtime Values" panel at the bottom: on the left every line that logged, newest first, as a
 * debugger lists frames; on the right the selected hit's value as a tree — `name = {Type} preview`,
 * colored by kind with the theme's own debug token colors, the way a debugger's Variables view
 * reads. A thin renderer: the rows and trees are built in the extension host.
 */
export class RuntimeValuesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'ejsngRuntimeValues';
  private view: vscode.WebviewView | undefined;
  /** Waiting for the webview to load: the last sites, and a selection asked for before it could take one. */
  private sites: ValueSiteRow[] = [];
  private pendingSelect: string | undefined;
  /** The last messages posted — read by UI tests, as `RuntimeLogViewProvider.lastPostedStatus` is. */
  lastPosted: { sites?: ValueSiteRow[]; detail?: ValueDetail } = {};

  constructor(private readonly callbacks: RuntimeValuesViewCallbacks) {}

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { type?: unknown; id?: unknown; hit?: unknown; text?: unknown; follow?: unknown }) => {
      const id = typeof msg.id === 'string' ? msg.id : '';
      const hit = typeof msg.hit === 'number' && Number.isInteger(msg.hit) && msg.hit >= 0 ? msg.hit : 0;
      switch (msg.type) {
        case 'ready':
          this.post({ type: 'sites', sites: this.sites });
          if (this.pendingSelect) this.post({ type: 'select', id: this.pendingSelect });
          this.pendingSelect = undefined;
          return;
        case 'select':
          if (id) this.callbacks.select(id, hit, msg.follow === true);
          return;
        case 'reveal':
          if (id) this.callbacks.reveal(id);
          return;
        case 'copy':
          if (typeof msg.text === 'string') this.callbacks.copy(msg.text);
          return;
        case 'openJson':
          if (id) this.callbacks.openJson(id, hit);
          return;
        case 'clear':
          this.callbacks.clear();
          return;
        case 'connect':
          this.callbacks.connect();
          return;
      }
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  showSites(sites: ValueSiteRow[]): void {
    this.sites = sites;
    this.lastPosted.sites = sites;
    this.post({ type: 'sites', sites });
  }

  showDetail(detail: ValueDetail): void {
    this.lastPosted.detail = detail;
    this.post({ type: 'detail', detail });
  }

  /** Select a line in the list — from the hover's "Inspect" — once the webview can take it. */
  select(id: string): void {
    if (this.view) this.post({ type: 'select', id });
    else this.pendingSelect = id;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(): string {
    const nonce = randomBytes(16).toString('base64');
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    /* The debugger's own token colors, so values read as they do in VS Code's Variables view. */
    --c-name: var(--vscode-debugTokenExpression-name, #c586c0);
    --c-string: var(--vscode-debugTokenExpression-string, #ce9178);
    --c-number: var(--vscode-debugTokenExpression-number, #b5cea8);
    --c-boolean: var(--vscode-debugTokenExpression-boolean, #4e94ce);
    --c-type: var(--vscode-debugTokenExpression-type, var(--vscode-descriptionForeground));
    --c-value: var(--vscode-debugTokenExpression-value, var(--vscode-foreground));
    --c-function: var(--vscode-symbolIcon-functionForeground, #b180d7);
    --c-object: var(--vscode-symbolIcon-objectForeground, #ee9d28);
    --c-array: var(--vscode-symbolIcon-arrayForeground, #75beff);
    --c-log: var(--vscode-terminal-ansiGreen, #89d185);
    --c-warning: var(--vscode-editorWarning-foreground, #cca700);
    --c-error: var(--vscode-errorForeground, #f48771);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    --row-h: 22px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); }
  .mono { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px); }
  #app { display: flex; flex-direction: column; height: 100%; }

  /* Toolbar */
  .toolbar { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  .toolbar input[type=search] { flex: 0 1 220px; min-width: 80px; height: 22px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 0 6px; font: inherit; }
  .toolbar input[type=search]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .toolbar .spacer { flex: 1; }
  .tb { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; border: none; border-radius: 3px; background: transparent;
    color: var(--vscode-foreground); font: inherit; cursor: pointer; white-space: nowrap; }
  .tb:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31)); }
  .tb:disabled { opacity: .45; cursor: default; background: transparent; }
  .tb svg { width: 14px; height: 14px; fill: currentColor; flex: 0 0 auto; }
  label.tb input { margin: 0; }

  /* Two panes */
  .split { flex: 1 1 auto; display: flex; min-height: 0; }
  .sites { flex: 0 0 var(--sites-w, 34%); min-width: 160px; max-width: 70%; overflow: auto; border-right: 1px solid var(--border); }
  .grip { flex: 0 0 4px; cursor: col-resize; margin-left: -2px; margin-right: -2px; z-index: 1; }
  .grip:hover, .grip.dragging { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
  .detail { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  @media (max-width: 560px) {
    .split { flex-direction: column; }
    .sites { flex-basis: 40%; max-width: none; border-right: none; border-bottom: 1px solid var(--border); }
    .grip { display: none; }
  }
  .pane-title { position: sticky; top: 0; z-index: 1; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); padding: 4px 8px; background: var(--vscode-sideBar-background, var(--vscode-panel-background)); }

  /* Frames-like list of log sites */
  .site { display: grid; grid-template-columns: 10px auto minmax(0, 1fr) auto; align-items: center; column-gap: 6px; height: var(--row-h);
    padding: 0 8px; cursor: pointer; white-space: nowrap; }
  .site:hover { background: var(--vscode-list-hoverBackground); }
  .site.sel { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
  .sites:focus-within .site.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-log); }
  .dot.warning { background: var(--c-warning); } .dot.error { background: var(--c-error); }
  .site .loc { font-weight: 500; }
  .site .rest { overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
  .site .rest .pv { color: var(--vscode-foreground); opacity: .8; }
  .site .meta { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 9px; text-align: center; font-size: 10px; line-height: 16px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 6px; }

  /* Hits strip */
  .hits { display: flex; gap: 4px; padding: 4px 8px; overflow-x: auto; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  ::-webkit-scrollbar { width: 10px; height: 6px; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4)); }
  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,.7)); }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
  .hit { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 11px; cursor: pointer;
    border: 1px solid var(--border); background: transparent; color: inherit; font: inherit; font-size: 12px; font-variant-numeric: tabular-nums; }
  .hit:hover { background: var(--vscode-list-hoverBackground); }
  .hit.sel { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .hit .dot { width: 6px; height: 6px; }
  .hits .more { color: var(--muted); align-self: center; font-size: 12px; white-space: nowrap; }
  .note { padding: 4px 8px; font-size: 12px; color: var(--c-warning); border-bottom: 1px solid var(--border); }

  /* Variables-like tree */
  .tree { flex: 1 1 auto; overflow: auto; padding: 2px 0 8px; outline: none; }
  .row { display: flex; align-items: center; height: var(--row-h); padding-right: 8px; white-space: nowrap; cursor: default; position: relative; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.sel { background: var(--vscode-list-inactiveSelectionBackground); }
  .tree:focus .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-list-focusOutline, transparent); outline-offset: -1px; }
  .tw { flex: 0 0 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
  .tw svg { width: 10px; height: 10px; fill: currentColor; transition: transform .08s; }
  .row.open > .tw svg { transform: rotate(90deg); }
  .ic { flex: 0 0 auto; width: 16px; height: 16px; margin-right: 5px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center;
    font: 700 9px/1 var(--vscode-editor-font-family); color: var(--k); background: color-mix(in srgb, var(--k) 18%, transparent); }
  .k-object { --k: var(--c-object); } .k-array { --k: var(--c-array); } .k-string { --k: var(--c-string); } .k-number { --k: var(--c-number); }
  .k-boolean, .k-null, .k-undefined { --k: var(--c-boolean); } .k-function { --k: var(--c-function); } .k-other, .k-unexpanded, .k-more { --k: var(--muted); }
  .nm { color: var(--c-name); }
  .eq { color: var(--muted); padding: 0 4px; }
  .ty { color: var(--c-type); margin-right: 6px; }
  .v { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .v.string { color: var(--c-string); } .v.number { color: var(--c-number); } .v.boolean, .v.null, .v.undefined { color: var(--c-boolean); }
  .v.function { color: var(--c-function); font-style: italic; } .v.unexpanded, .v.more { color: var(--muted); font-style: italic; }
  .v.object, .v.array { color: var(--muted); }
  .row.text { height: auto; align-items: flex-start; padding-top: 3px; padding-bottom: 3px; }
  .row.text .v { white-space: pre-wrap; overflow: visible; }
  .row .act { position: absolute; right: 4px; display: none; gap: 2px; background: inherit; }
  .row:hover .act, .row.sel .act { display: inline-flex; }
  .row .act button { border: none; background: transparent; color: var(--vscode-foreground); width: 20px; height: 20px; border-radius: 3px; cursor: pointer; padding: 2px; }
  .row .act button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31)); }
  .row .act svg { width: 14px; height: 14px; fill: currentColor; }

  .empty { padding: 16px; color: var(--muted); line-height: 1.6; }
  .empty button { margin-top: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
    padding: 4px 12px; border-radius: 2px; cursor: pointer; font: inherit; }
  .empty button:hover { background: var(--vscode-button-hoverBackground); }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div id="app">
  <div class="toolbar">
    <input id="filter" type="search" placeholder="Filter lines" aria-label="Filter logged lines">
    <label class="tb" title="Show each new hit of the selected line as it arrives"><input id="follow" type="checkbox" checked>Follow latest</label>
    <span class="spacer"></span>
    <button class="tb" id="expandAll" title="Expand all"><svg viewBox="0 0 16 16"><path d="M9 9H4v1h5V9z"/><path d="M7 12V7H6v5h1z"/><path fill-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg></button>
    <button class="tb" id="collapseAll" title="Collapse all"><svg viewBox="0 0 16 16"><path d="M9 9H4v1h5V9z"/><path fill-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg></button>
    <button class="tb" id="copyAll" title="Copy the whole value as JSON"><svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path fill-rule="evenodd" d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>Copy</button>
    <button class="tb" id="openJson" title="Open the whole value in a JSON editor tab"><svg viewBox="0 0 16 16"><path d="M6 2.984V2h-.09c-.313 0-.616.062-.909.185a2.33 2.33 0 0 0-.775.53 2.23 2.23 0 0 0-.493.753v.001a3.542 3.542 0 0 0-.198.83v.002a6.08 6.08 0 0 0-.024.863c.012.29.018.58.018.869 0 .203-.04.393-.117.572v.001a1.504 1.504 0 0 1-.765.787 1.376 1.376 0 0 1-.558.115H2v.984h.09c.195 0 .38.04.556.121l.001.001c.178.078.329.184.455.318l.002.002c.13.13.233.285.307.465l.001.002c.078.18.117.368.117.566 0 .29-.006.58-.018.869-.012.296-.004.585.024.87v.001c.033.283.099.558.197.824v.001c.106.273.271.524.494.753.223.23.482.407.775.53.293.123.596.185.91.185H6v-.984h-.09c-.2 0-.387-.038-.563-.115a1.613 1.613 0 0 1-.457-.32 1.659 1.659 0 0 1-.309-.467c-.074-.18-.11-.37-.11-.573 0-.228.003-.453.011-.672.008-.228.008-.45 0-.665a4.639 4.639 0 0 0-.055-.64 2.682 2.682 0 0 0-.168-.609A2.284 2.284 0 0 0 3.522 8a2.284 2.284 0 0 0 .738-.585c.123-.199.227-.399.308-.604l.001-.002c.074-.2.13-.4.168-.609.039-.216.055-.43.055-.64 0-.215.003-.436.012-.664.008-.22.008-.445 0-.672 0-.205.036-.394.11-.572l.001-.002c.078-.176.18-.33.308-.466l.001-.001c.13-.13.285-.234.457-.311l.001-.001c.178-.08.365-.119.564-.119H6zm4 10.032V14h.09c.313 0 .616-.062.909-.185.293-.123.552-.3.775-.53.223-.23.388-.48.493-.753v-.001c.1-.27.166-.547.198-.83v-.002c.028-.285.036-.573.024-.863-.012-.29-.018-.58-.018-.869 0-.203.04-.393.117-.572v-.001a1.504 1.504 0 0 1 .765-.787c.176-.077.362-.115.558-.115H14v-.984h-.09c-.195 0-.38-.04-.556-.121l-.001-.001a1.462 1.462 0 0 1-.455-.318l-.002-.002a1.469 1.469 0 0 1-.307-.465l-.001-.002a1.402 1.402 0 0 1-.117-.566c0-.29.006-.58.018-.869a6.19 6.19 0 0 0-.024-.87v-.001a3.537 3.537 0 0 0-.197-.824v-.001a2.23 2.23 0 0 0-.494-.753 2.331 2.331 0 0 0-.775-.53 2.325 2.325 0 0 0-.91-.185H10v.984h.09c.2 0 .387.038.562.115.17.08.322.186.458.32.13.137.232.293.309.467.074.18.11.37.11.573 0 .228-.003.453-.011.672-.008.228-.008.45 0 .665.012.216.03.43.055.64.039.21.095.41.168.609.08.206.186.405.308.604.123.2.37.396.738.585a2.284 2.284 0 0 0-.738.585c-.123.199-.227.399-.308.604l-.001.002c-.074.2-.13.4-.168.609-.039.216-.055.43-.055.64 0 .215-.003.436-.012.664-.008.22-.008.445 0 .672 0 .205-.036.394-.11.572l-.001.002a1.474 1.474 0 0 1-.308.466l-.001.001c-.13.13-.285.234-.457.311l-.001.001a1.34 1.34 0 0 1-.564.119H10z"/></svg>Open JSON</button>
    <button class="tb" id="clear" title="Clear every logged value, here and beside the code"><svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/></svg>Clear</button>
  </div>
  <div class="split" id="split">
    <div class="sites" id="sites" tabindex="-1">
      <div class="pane-title">Logged lines</div>
      <div id="siteList" role="listbox" aria-label="Logged lines"></div>
    </div>
    <div class="grip" id="grip" title="Drag to resize"></div>
    <div class="detail">
      <div class="hits hidden" id="hits"></div>
      <div class="note hidden" id="note"></div>
      <div class="tree mono" id="tree" tabindex="0" role="tree" aria-label="Logged value"></div>
    </div>
  </div>
  <div class="empty hidden" id="empty">
    No logged values yet.<br>
    Connect to a running Node process or browser tab, then let a <code>console.log</code> or a logpoint run —
    each line that logs shows up here, with its value as a tree.<br>
    <button id="connect">Connect to Runtime</button>
  </div>
</div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const ICON = {
    object: '{}', array: '[]', string: 'ab', number: '#', boolean: 'b', null: '∅', undefined: '∅', function: 'ƒ', other: '·', unexpanded: '…', more: '…',
  };
  const CHEVRON = '<svg viewBox="0 0 16 16"><path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3z"/></svg>';
  const COPY = '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path fill-rule="evenodd" d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>';

  let sites = [];
  let selectedId = saved.selectedId || null;
  let hit = 0;
  let detail = null;
  /**
   * Expanded branches, per line and kept across its hits — comparing two hits keeps the same
   * branches open, while another line's \`0/5\` is a different value and opens nothing here.
   */
  const open = new Set(saved.open || []);
  const key = (path) => selectedId + '|' + path;
  let rows = [];
  let cursor = 0;

  function persist() {
    vscode.setState({ selectedId, open: [...open].slice(-500), sitesW: document.documentElement.style.getPropertyValue('--sites-w') });
  }
  if (saved.sitesW) document.documentElement.style.setProperty('--sites-w', saved.sitesW);

  // ---- Log sites ----
  function renderSites() {
    const q = $('filter').value.trim().toLowerCase();
    const list = $('siteList');
    list.textContent = '';
    const shown = sites.filter((s) => !q || (s.file + ':' + s.line + ' ' + s.preview).toLowerCase().includes(q));
    $('empty').classList.toggle('hidden', sites.length > 0);
    $('split').classList.toggle('hidden', sites.length === 0);
    for (const s of shown) {
      const row = el('div', 'site' + (s.id === selectedId ? ' sel' : ''));
      row.setAttribute('role', 'option');
      row.title = s.file + ':' + s.line + '\\n' + s.preview;
      row.append(el('span', 'dot ' + s.severity));
      // As a debugger lists frames: the file and line first, where it is and what it logged after.
      const slash = s.file.lastIndexOf('/');
      const rest = el('span', 'rest');
      rest.append(el('span', 'pv mono', s.preview));
      if (slash >= 0) rest.append(document.createTextNode('  ·  ' + s.file.slice(0, slash)));
      row.append(el('span', 'loc', s.file.slice(slash + 1) + ':' + s.line), rest);
      const meta = el('span', 'meta');
      if (s.count > 1) meta.append(el('span', 'badge', '×' + s.count));
      meta.append(document.createTextNode(clock(s.at)));
      row.append(meta);
      row.addEventListener('click', () => choose(s.id, 0, true));
      row.addEventListener('dblclick', () => vscode.postMessage({ type: 'reveal', id: s.id }));
      list.append(row);
    }
  }
  function clock(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  }
  function choose(id, h, reveal) {
    selectedId = id;
    hit = h;
    persist();
    renderSites();
    vscode.postMessage({ type: 'select', id, hit: h });
    if (reveal) vscode.postMessage({ type: 'reveal', id });
  }

  // ---- Hits and tree ----
  function renderDetail() {
    const hits = $('hits');
    hits.textContent = '';
    const has = detail && detail.id === selectedId;
    hits.classList.toggle('hidden', !has || detail.hits.length < 1);
    for (const b of ['copyAll', 'openJson', 'expandAll', 'collapseAll']) $(b).disabled = !has;
    if (has) {
      detail.hits.forEach((h, i) => {
        const b = el('button', 'hit' + (i === detail.hit ? ' sel' : ''));
        b.title = h.source + ' · ' + h.severity + ' · ' + h.time + '\\n' + h.preview;
        b.append(el('span', 'dot ' + h.severity), document.createTextNode(i === 0 ? h.time + ' · latest' : h.time));
        b.addEventListener('click', () => { hit = i; vscode.postMessage({ type: 'select', id: selectedId, hit: i }); });
        hits.append(b);
      });
      if (detail.dropped > 0) hits.append(el('span', 'more', '+' + detail.dropped + ' earlier not kept'));
    }
    const note = $('note');
    note.textContent = has && detail.note ? detail.note : '';
    note.classList.toggle('hidden', !(has && detail.note));
    renderTree();
  }

  function renderTree() {
    const tree = $('tree');
    tree.textContent = '';
    rows = [];
    if (!detail || detail.id !== selectedId) {
      tree.append(el('div', 'empty', selectedId ? 'Loading…' : 'Select a logged line to see its value.'));
      return;
    }
    const walk = (node, path, depth) => {
      rows.push({ node, path, depth });
      if (node.children && open.has(key(path))) node.children.forEach((c, i) => walk(c, path + '/' + i, depth + 1));
    };
    detail.roots.forEach((r, i) => walk(r, String(i), 0));
    cursor = Math.min(cursor, Math.max(0, rows.length - 1));
    rows.forEach((r, i) => tree.append(renderRow(r, i)));
  }

  function renderRow(r, i) {
    const n = r.node;
    const expandable = !!(n.children && n.children.length);
    const row = el('div', 'row' + (expandable && open.has(key(r.path)) ? ' open' : '') + (i === cursor ? ' sel' : '') + (n.kind === 'other' && n.text.includes('\\n') ? ' text' : ''));
    row.setAttribute('role', 'treeitem');
    if (expandable) row.setAttribute('aria-expanded', String(open.has(key(r.path))));
    row.style.paddingLeft = (4 + r.depth * 16) + 'px';
    const tw = el('span', 'tw');
    if (expandable) tw.innerHTML = CHEVRON;
    row.append(tw);
    if (n.kind === 'more') {
      row.append(el('span', 'v more', n.text));
    } else {
      row.append(el('span', 'ic k-' + n.kind, ICON[n.kind] || '·'), el('span', 'nm', n.name), el('span', 'eq', '='));
      if (n.type) row.append(el('span', 'ty', '{' + n.type + '}'));
      row.append(el('span', 'v ' + n.kind, display(n)));
      const act = el('span', 'act');
      const copy = el('button');
      copy.title = 'Copy value';
      copy.innerHTML = COPY;
      copy.addEventListener('click', (e) => { e.stopPropagation(); copyNode(n); });
      act.append(copy);
      row.append(act);
    }
    row.addEventListener('click', () => { cursor = i; if (expandable) toggle(r.path); else renderTree(); $('tree').focus(); });
    return row;
  }

  /** Strings as a debugger shows them: double-quoted, escaped. */
  function display(n) {
    if (n.kind === 'string' && typeof n.json === 'string') return JSON.stringify(n.json);
    return n.text;
  }
  function toggle(path) {
    if (open.has(key(path))) open.delete(key(path)); else open.add(key(path));
    persist();
    renderTree();
  }
  function toJson(n) {
    if (n.kind === 'object') {
      const o = {};
      for (const c of n.children || []) if (c.kind !== 'more') o[c.name] = toJson(c);
      return o;
    }
    if (n.kind === 'array') return (n.children || []).filter((c) => c.kind !== 'more').map(toJson);
    return 'json' in n ? n.json : n.text;
  }
  function copyNode(n) {
    const v = toJson(n);
    vscode.postMessage({ type: 'copy', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });
  }
  function setAll(expand) {
    if (!detail) return;
    const visit = (node, path, depth) => {
      if (!node.children || !node.children.length) return;
      if (expand && depth < 6) open.add(key(path)); else if (!expand) open.delete(key(path));
      node.children.forEach((c, i) => visit(c, path + '/' + i, depth + 1));
    };
    detail.roots.forEach((r, i) => visit(r, String(i), 0));
    persist();
    renderTree();
  }

  // ---- Keyboard, as in a tree view ----
  $('tree').addEventListener('keydown', (e) => {
    if (!rows.length) return;
    const r = rows[cursor];
    const expandable = r && r.node.children && r.node.children.length;
    if (e.key === 'ArrowDown') cursor = Math.min(rows.length - 1, cursor + 1);
    else if (e.key === 'ArrowUp') cursor = Math.max(0, cursor - 1);
    else if (e.key === 'ArrowRight') { if (expandable && !open.has(key(r.path))) { toggle(r.path); e.preventDefault(); return; } if (expandable) cursor++; }
    else if (e.key === 'ArrowLeft') {
      if (expandable && open.has(key(r.path))) { toggle(r.path); e.preventDefault(); return; }
      const parent = r.path.slice(0, r.path.lastIndexOf('/'));
      const p = rows.findIndex((x) => x.path === parent);
      if (p >= 0) cursor = p;
    }
    else if (e.key === 'Enter' || e.key === ' ') { if (expandable) toggle(r.path); e.preventDefault(); return; }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'c') { copyNode(r.node); e.preventDefault(); return; }
    else if (e.key === 'Home') cursor = 0;
    else if (e.key === 'End') cursor = rows.length - 1;
    else return;
    e.preventDefault();
    renderTree();
    const sel = $('tree').querySelector('.row.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  });

  // ---- Toolbar ----
  $('filter').addEventListener('input', renderSites);
  $('expandAll').addEventListener('click', () => setAll(true));
  $('collapseAll').addEventListener('click', () => setAll(false));
  $('copyAll').addEventListener('click', () => {
    if (!detail) return;
    const values = detail.roots.map(toJson);
    const v = values.length === 1 ? values[0] : values;
    vscode.postMessage({ type: 'copy', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });
  });
  $('openJson').addEventListener('click', () => selectedId && vscode.postMessage({ type: 'openJson', id: selectedId, hit }));
  $('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  $('connect').addEventListener('click', () => vscode.postMessage({ type: 'connect' }));

  // ---- Resizable split ----
  const grip = $('grip');
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    const move = (ev) => {
      const box = $('split').getBoundingClientRect();
      const pct = Math.min(70, Math.max(15, ((ev.clientX - box.left) / box.width) * 100));
      document.documentElement.style.setProperty('--sites-w', pct.toFixed(1) + '%');
    };
    const up = () => { grip.classList.remove('dragging'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); persist(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  // ---- From the extension ----
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'sites') {
      sites = m.sites;
      if (selectedId && !sites.some((s) => s.id === selectedId)) { selectedId = null; detail = null; }
      const wasEmpty = !selectedId;
      if (!selectedId && sites.length) selectedId = sites[0].id;
      renderSites();
      if (selectedId && (wasEmpty || !detail)) vscode.postMessage({ type: 'select', id: selectedId, hit: 0 });
      else if (selectedId && $('follow').checked && hit === 0) vscode.postMessage({ type: 'select', id: selectedId, hit: 0, follow: true });
      if (!selectedId) renderDetail();
    } else if (m.type === 'detail') {
      if (m.detail.id !== selectedId) return;
      const first = !detail || detail.id !== m.detail.id;
      detail = m.detail;
      hit = detail.hit;
      // The first time a value is shown, open its roots — a debugger shows a variable's fields at once.
      if (first) detail.roots.forEach((r, i) => { if (r.children && r.children.length && ![...open].some((p) => p === key(i) || p.startsWith(key(i) + '/'))) open.add(key(i)); });
      renderDetail();
    } else if (m.type === 'select') {
      choose(m.id, 0, false);
    }
  });

  renderSites();
  renderDetail();
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}
