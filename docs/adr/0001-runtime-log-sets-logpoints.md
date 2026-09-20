# 0001 — Runtime Log sets logpoints on the runtime itself

**Date:** 2026-09-19 · **Status:** accepted · **Spec:** `.scratch/inline-logpoints/spec.md`

## Context

Until now the Runtime Log connection enabled the `Debugger` domain only to receive
`scriptParsed` events, and promised that no breakpoint is ever set. Users wanted VS Code
logpoints shown inline too.

VS Code's own debugger (`vscode-js-debug`) already runs logpoints. But it only does so inside a VS
Code debug session, and the main use case of Runtime Log is an app started outside VS Code (in
Docker or a terminal). The inline-runtime-log spec rejected depending on a debug session for that
reason (decision #3).

## Decision

The LSP server sets each logpoint itself, on every Runtime Log connection, with
`Debugger.setBreakpointByUrl`. The breakpoint's condition logs the message and evaluates to
`false`, so V8 never pauses. The invariant becomes: **the runtime is never paused**. Before, it
was: no breakpoint is ever set.

We measured this on a real `node --inspect` (Node 20.20) before deciding:

- A condition that returns `false` never pauses. A condition that throws doesn't pause either.
- A `urlRegex` breakpoint binds to a module that is loaded later.
- The log's stack trace shows the condition as its top frame, named by a `//# sourceURL` we add,
  with the logpoint's line directly below it. **Corrected 2026-09-20:** the frame below is the line
  V8 *bound* the breakpoint to, which for a logpoint placed at a column after a statement's `;` is
  the next statement — not the line the logpoint was set on. Drawing now anchors on the requested
  position instead (`logpointAnchorOffset`); see docs/kien-truc.md 5.3.3.
- `node:inspector`'s `console` reaches every attached client without printing to the app's stdout.
- Two CDP clients on one Node target both receive the log.

## Consequences

- Logpoint output reuses the whole `console.*` pipeline: frame selection, Path Mapping, content
  verification (a Stale File is still refused), and drawing.
- The server must map a local file to Runtime Paths in reverse, not only forward, to know where to
  set a breakpoint before the script loads.
- If the user also debugs the same target with js-debug, both debuggers set the logpoint and each
  one appears twice in the Debug Console. The setting `ejsng.runtimeLog.logpoints` turns ours off.
- On Node older than 20.16 (no `process.getBuiltinModule`), logpoint output also reaches the app's
  stdout.
