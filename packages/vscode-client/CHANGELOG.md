# Changelog

## 0.5.1

**An inline value now appears on the line the logpoint was set on.** A logpoint placed from the
CodeLens, the hover link or `Cmd+Alt+L` is set at the column right after the assignment's `;`, so
the value it logs is the one just assigned. V8 binds such a breakpoint to the first breakable
position at or after that column — which is the *next* statement — and the log was drawn from the
stack frame that came back, so the value appeared beside the line below the one clicked. Logs from
logpoints are now anchored where the logpoint was asked for. Ordinary `console.*` calls are
unchanged: they are still drawn at their own call site.

## 0.5.0

**Types seen at runtime.** Hovering a scope variable shows the type the running app actually produced,
merged with what the index inferred, with how often and when it was seen and from which connection.
A value no assignment could type now reads "Not inferred statically — shape from runtime" instead of
giving up. Only types are kept, never values, and they go when the connection does.

**Set a logpoint without typing.** Three ways, all writing the same logpoint:

- a **CodeLens** above an assignment (`ejsng.logLens`: `unknown` by default, `all`, or `off`),
- **right-click → EJS/NG: Log This at Runtime**, which logs the selection, the property chain under
  the cursor, or what the line assigns,
- **`Cmd+Alt+L`** / **`Ctrl+Alt+L`** for the same command.

The logpoint lands right after the assignment (so the value is the new one) or at the start of the
line (so it is the value the line is about to use) — including inside one-line callbacks, which a
gutter logpoint cannot reach. Clicking the same place again removes it. Logging a function call, or
`this` inside a callback, is refused with a reason rather than logging something misleading.

**Logged objects read as objects.** Inline logs no longer show `[Object, Object, …]`: the value is
dug from the running app, at most once per line per 300 ms. The hover lays it out, and **Show full
value** opens the whole thing as a read-only JSON tab with folding and search. Turn it off with
`ejsng.runtimeLog.expandValues`.

Measured against a real Chrome page logging 150 objects every 30 ms: the app runs exactly as fast as
with the feature off.

**Inline hints are unchanged by all of this** — `may be empty` still comes only from assignments in
the code, so it never appears or disappears depending on whether a runtime is connected.

## Earlier versions

See the git history; `docs/architecture.md` records the design and the measurements behind it.
