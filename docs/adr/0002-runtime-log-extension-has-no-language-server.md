# 0002 — The standalone Runtime Log extension runs without a language server

**Date:** 2026-09-20 · **Status:** accepted · **Supersedes for the new extension:** the transport half of
`0001`, not its decision

## Context

Runtime Log has grown into roughly 4,400 lines — about 29% of this repo's source — and is being
split out into its own extension and repository. Today it rides on the same LSP server as the
index: 13 of the 19 custom `ejsng/*` methods are runtime methods.

LSP earns its keep when one server serves several editors. Measured here, for the index, it plainly
does: `packages/intellij-client` is 208 lines of Kotlin and gets go-to-definition, hover, rename and
completion for it.

For Runtime Log it earns nothing today, and the reasons are structural rather than incidental:

- LSP standardises questions *about a language*. Nothing in Runtime Log is one: it connects to a
  running process over CDP, maps container paths to host paths, sets breakpoints and draws
  decorations. All of it has to travel as custom `ejsng/*` methods, which only a client we wrote
  ourselves can understand.
- Consequently the IntelliJ client handles **no** `ejsng/*` method at all. Runtime Log is a VS Code
  feature already; the server buys it no portability.
- `textDocument/inlineValue` (LSP 3.17) does not fit. It is pull-based and defined for a debugger
  paused at a breakpoint; Runtime Log's target runs continuously and pushes logs as they happen.
- The other usual reason for a separate process — keeping heavy work off the editor's thread — is
  mostly already served: a VS Code extension runs in the extension host, itself a separate Node
  process, so a CDP socket there does not block the UI.

## Decision

The standalone Runtime Log extension runs entirely in the VS Code extension host. No language
server, no JSON-RPC: the CDP client, Path Mapping, logpoint application, value digging and type
evidence become ordinary modules the extension imports and calls directly.

`0001` is unaffected in substance — the extension still sets logpoints itself on the Runtime
Target, and the runtime is still never paused. Only what *hosts* that code changes.

## Consequences

- The 13 custom `ejsng/*` runtime methods disappear, replaced by function calls. One serialisation
  boundary and one process fewer.
- `packages/core`'s runtime modules move unchanged: their only non-relative import is `micromatch`.
- Three things the server got from `Workspace` have to be sourced from VS Code instead:
  - `ws.source(relPath)` — file text, for offsets, the minification check and content verification.
    `vscode.workspace.textDocuments` gives the unsaved buffer directly, which is what the Stale File
    check wants anyway.
  - `ws.indexedPaths()` — the file list `matchUrlPathSuffix` matches a browser URL's tail against.
    Becomes `vscode.workspace.findFiles` plus a watcher to keep it current. This is the largest
    piece of real work, and it is a file list, not an index.
  - `ws.config.root` — the workspace folder.
- Two bridges into the index do **not** come along, and stay with the navigator extension, where
  they belong: `logTargetsIn` (the CodeLens, which reads `facts.scopeWrites`) and
  `workspace.consoleCallAt` (which ties a plain `console.log($scope.rows)` to the scope variable it
  shows). In the standalone extension, type evidence comes from logpoints only — unless it later
  parses for itself with acorn.
- Runtime Log can no longer reach IntelliJ through LSP4IJ. That door is shut today regardless: even
  with a server, opening it would mean writing the Kotlin that draws the decorations, because LSP
  does not standardise them.
- If the navigator extension is to keep the merged static + runtime hover of 0.5.0, the two
  extensions must talk through `extensions.getExtension(id).exports`, not through the protocol.
