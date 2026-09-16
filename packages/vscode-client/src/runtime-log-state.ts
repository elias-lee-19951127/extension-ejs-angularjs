/** One `ejsng/runtimeLog` hit, already anchored to a line — see RuntimeLogState below. */
export interface RuntimeLogEntry {
  line: number;
  character: number;
  value: string;
  severity: 'log' | 'warning' | 'error';
}

/** One connection's real status, as returned by the `ejsng/runtimeStatus` LSP request (ticket 02, item 4). */
export interface RuntimeStatusConnection {
  key: string;
  state: 'connecting' | 'connected' | 'failed';
  reason?: string;
  received: number;
  drawn: number;
  droppedByReason: Record<string, number>;
}

/** Totals across every live connection — what the status bar and panel actually show. */
export interface RuntimeStatusSummary {
  received: number;
  drawn: number;
  dropped: number;
  connecting: number;
  connected: number;
  failed: number;
}

/**
 * Aggregate every live connection's counts into one summary. No `vscode` import — pure, so the
 * status bar/panel formatting can be unit tested without an Extension Host, same as
 * `RuntimeLogState` below.
 */
export function summarizeRuntimeStatus(connections: RuntimeStatusConnection[]): RuntimeStatusSummary {
  const summary: RuntimeStatusSummary = { received: 0, drawn: 0, dropped: 0, connecting: 0, connected: 0, failed: 0 };
  for (const c of connections) {
    summary.received += c.received;
    summary.drawn += c.drawn;
    summary.dropped += Object.values(c.droppedByReason).reduce((a, b) => a + b, 0);
    summary[c.state]++;
  }
  return summary;
}

/**
 * The status bar text (ticket 02, item 4: "received / drawn / dropped" instead of just a
 * connection count — the panel checklist that ALSO explains a `connecting`/`failed` connection
 * step-by-step is ticket 09's job; this is deliberately just a one-line summary).
 */
export function formatRuntimeStatusBarText(connectionCount: number, summary: RuntimeStatusSummary): string {
  if (connectionCount === 0) return 'EJS/NG Runtime: off';
  const note = summary.connecting > 0 ? ' (connecting…)' : summary.failed > 0 ? ' (failed)' : '';
  return `EJS/NG Runtime: received ${summary.received} / drawn ${summary.drawn} / dropped ${summary.dropped}${note}`;
}

/**
 * Per-file, per-line latest-value state (spec decision #6: no history, latest value per line
 * wins). No `vscode` import — pure state, so the extension's decoration-drawing code can stay a
 * thin layer on top of this.
 */
export class RuntimeLogState {
  private readonly byUri = new Map<string, Map<number, RuntimeLogEntry>>();

  /** Record a notification; returns every current entry for that file. */
  record(uri: string, entry: RuntimeLogEntry): RuntimeLogEntry[] {
    let lines = this.byUri.get(uri);
    if (!lines) {
      lines = new Map();
      this.byUri.set(uri, lines);
    }
    lines.set(entry.line, entry);
    return [...lines.values()];
  }

  /** All current entries for a file — e.g. to redraw decorations after reopening a document. */
  entriesFor(uri: string): RuntimeLogEntry[] {
    return [...(this.byUri.get(uri)?.values() ?? [])];
  }

  /** Drop all state for a file — e.g. its target process restarted. */
  clear(uri: string): void {
    this.byUri.delete(uri);
  }
}
