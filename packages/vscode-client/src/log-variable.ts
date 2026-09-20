/**
 * "Log at runtime" from the hover (.scratch/log-variable/spec.md): the pure half of the
 * `ejsng.logVariable` command — checking its arguments and deciding what to do about the
 * breakpoints already there. No `vscode` import, so it tests without an Extension Host.
 */
import type { BreakpointLike } from './logpoints';

/** What the hover link carries: where to put the logpoint, and what it logs. */
export interface LogVariableArgs {
  /** The JS file, as a URI string. */
  uri: string;
  /** 0-based, right after the assignment's statement (log-variable spec #3). */
  line: number;
  character: number;
  /** The assignment's left side as written: `$scope.rows`. */
  expression: string;
  /** `$scope.rows = {$scope.rows}`. */
  logMessage: string;
}

/**
 * The command's argument, checked — a command URI can be typed by hand, so nothing about it is
 * assumed. `null` when anything is missing or off.
 */
export function parseLogVariableArgs(value: unknown): LogVariableArgs | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const { uri, line, character, expression, logMessage } = v;
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  if (!Number.isInteger(line) || (line as number) < 0 || !Number.isInteger(character) || (character as number) < 0) return null;
  if (typeof expression !== 'string' || !expression.trim() || typeof logMessage !== 'string' || !logMessage.trim()) return null;
  return { uri, line: line as number, character: character as number, expression, logMessage };
}

export type LogVariablePlan =
  | { kind: 'add' }
  /** The same logpoint is there but turned off: turn it back on. */
  | { kind: 'enable'; index: number }
  /** Something is already at that spot — the same logpoint, on, or another breakpoint: leave it. */
  | { kind: 'exists'; index: number; sameMessage: boolean };

/** What to do given the breakpoints already set (log-variable spec #7): never a second one at the same spot. */
export function planLogVariable(args: LogVariableArgs, breakpoints: readonly BreakpointLike[]): LogVariablePlan {
  const index = breakpoints.findIndex(
    (bp) =>
      bp.location?.uri.toString() === args.uri &&
      bp.location.range.start.line === args.line &&
      (bp.location.range.start.character ?? 0) === args.character,
  );
  if (index === -1) return { kind: 'add' };
  const bp = breakpoints[index]!;
  const sameMessage = bp.logMessage === args.logMessage;
  if (sameMessage && !bp.enabled) return { kind: 'enable', index };
  return { kind: 'exists', index, sameMessage };
}

/** A place the server says a logpoint can be set, with its message already written (log-lens). */
export interface LogTarget {
  lensLine: number;
  line: number;
  character: number;
  expression: string;
  logMessage: string;
  /** The index knows what the assignment holds; `false` is where logging teaches the most. */
  inferred: boolean;
}

/** `ejsng.logLens`: which assignments get a lens (log-lens spec #2). */
export type LogLensMode = 'unknown' | 'all' | 'off';

/** One lens: where it goes, what it says, and the command's argument. */
export interface LogLens {
  line: number;
  title: string;
  args: LogVariableArgs & { toggle: true };
}

/**
 * The lenses for a file: none when off, only the assignments the index cannot type by default
 * (measured: a lens on every assignment lands on 15–18% of a controller's lines, against ~3% for
 * these). A line that already carries this logpoint says so and removes it instead.
 */
export function logLenses(
  targets: readonly LogTarget[],
  mode: LogLensMode,
  uri: string,
  breakpoints: readonly BreakpointLike[],
): LogLens[] {
  if (mode === 'off') return [];
  return targets
    .filter((t) => mode === 'all' || !t.inferred)
    .map((t) => {
      const args = { uri, line: t.line, character: t.character, expression: t.expression, logMessage: t.logMessage, toggle: true as const };
      const name = t.logMessage.slice(0, t.logMessage.indexOf(' ')) || t.expression;
      const set = planLogVariable(args, breakpoints);
      return {
        line: t.lensLine,
        title: set.kind === 'exists' && set.sameMessage ? `$(debug-breakpoint-log) Logging ${name} — click to remove` : `$(debug-breakpoint-log) Log ${name} at runtime`,
        args,
      };
    });
}

/** The file name of a URI, for messages: `list.controller.js`. */
export function fileNameOf(uri: string): string {
  const path = uri.replace(/[?#].*$/, '');
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}
