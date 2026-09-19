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

/** The file name of a URI, for messages: `list.controller.js`. */
export function fileNameOf(uri: string): string {
  const path = uri.replace(/[?#].*$/, '');
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}
