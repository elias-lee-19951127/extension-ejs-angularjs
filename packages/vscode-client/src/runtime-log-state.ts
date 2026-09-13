/** One `ejsng/runtimeLog` hit, already anchored to a line — see RuntimeLogState below. */
export interface RuntimeLogEntry {
  line: number;
  character: number;
  value: string;
  severity: 'log' | 'warning' | 'error';
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
