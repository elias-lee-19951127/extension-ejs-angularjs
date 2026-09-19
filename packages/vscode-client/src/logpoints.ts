/**
 * Which VS Code breakpoints become inline logpoints (.scratch/inline-logpoints/spec.md, decision
 * #2). No `vscode` import — the shapes below are structural — so it tests without an Extension Host.
 */

/** The parts of a `vscode.Breakpoint` (a `SourceBreakpoint` when it has `location`) read here. */
export interface BreakpointLike {
  enabled: boolean;
  condition?: string;
  logMessage?: string;
  location?: { uri: { scheme: string; toString(): string }; range: { start: { line: number } } };
}

/** One entry of the `ejsng/setLogpoints` notification. */
export interface LogpointParams {
  uri: string;
  line: number;
  logMessage: string;
  condition?: string;
}

/**
 * The logpoints to send the server: enabled source breakpoints on a `file:` document that carry a
 * log message. Plain breakpoints are left out on purpose — the server never pauses the runtime —
 * and `hitCondition` is not supported yet. `enabled: false` (setting `ejsng.runtimeLog.logpoints`)
 * sends an empty list, which clears every logpoint the server set.
 */
export function logpointsFrom(breakpoints: readonly BreakpointLike[], enabled: boolean): LogpointParams[] {
  if (!enabled) return [];
  const result: LogpointParams[] = [];
  for (const bp of breakpoints) {
    if (!bp.enabled || !bp.location || bp.location.uri.scheme !== 'file' || !bp.logMessage?.trim()) continue;
    result.push({
      uri: bp.location.uri.toString(),
      line: bp.location.range.start.line,
      logMessage: bp.logMessage,
      ...(bp.condition?.trim() ? { condition: bp.condition } : {}),
    });
  }
  return result;
}
