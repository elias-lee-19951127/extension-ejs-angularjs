# CONTEXT

Domain-term glossary for the `extension-ejs-angularjs` repo (language server for EJS +
AngularJS 1.x). See `docs/agents/domain.md` for how agent skills read this file.

## Definition Resolution

The pure go-to-definition logic: find the definition of an identifier at a position in an already
indexed `.js` or `.ejs` file — this does NOT include the "nearest match" filtering step used when
a name is declared in more than one file (see `preferNearest` on `Workspace`, which still lives in
`packages/core/src/resolve/workspace.ts`).

- File: `packages/core/src/resolve/definition.ts`
- Entry point: `resolveDefinition(deps: FactSource, relPath, offset): DefinitionResult`
- Split out of `Workspace` (see architecture appendix: `docs/kien-truc.md`, Appendix M) because
  this is a deep module — remove it from `Workspace` and its complexity disappears entirely,
  rather than moving somewhere else.

## Shape Walking

The logic for walking a property path over a `ValueShape` inferred from Layer 2 (e.g.
`$scope.sections = [...]` and then asking about `section.icon` in a template) — shared by both
**Definition Resolution** and completion (`Workspace.memberCompletions`).

- File: `packages/core/src/resolve/shape.ts`
- Main functions: `walkShape`, `shapeOf`, `shapeAtPath`
- Kept separate from Definition Resolution even though the two modules are closely related,
  because this is a SHARED dependency between definition and completion — folding it into either
  one would create an unnecessary cross-dependency.

## FactSource

A narrow interface that **Definition Resolution** and **Shape Walking** use to read data from
`Workspace`, instead of holding the whole class. Defined in `packages/core/src/resolve/shape.ts`:
`facts()`, `source()`, `findSymbols()`, `moduleAliases`. `Workspace implements FactSource` and
passes `this` in when calling the two modules above.

## Rename Orchestration

Synchronizes renaming a `$scope` property across both the `.js` file and every template that uses
it — checks for conflicts, finds controller duplicates with the same name, and warns about spots
where the template can't understand it's an Angular expression. This does NOT include the pure
functions (`nearestFiles`, `renameScope`, `scopeAccessesByDecl`…) — those still live in
`packages/core/src/resolve/rename.ts`.

- File: `packages/core/src/resolve/rename-orchestrator.ts`
- Entry point: `renameAt(deps: RenameSource, relPath, offset, newName): RenameResult`,
  `prepareRenameAt(deps: RenameSource, relPath, offset): PrepareRenameResult`
- Split out of `Workspace` (see `docs/kien-truc.md`, Appendix M) — unlike Definition Resolution,
  the deletion test showed this module **genuinely needs** `Workspace`'s own state (the Linker,
  the list of files open in the editor), so the seam is a WIDER interface than `FactSource`
  (`RenameSource`), not a fully independent set of functions.

## RenameSource

The interface in `packages/core/src/resolve/rename-orchestrator.ts` that Rename Orchestration uses
to read `Workspace`: everything in `FactSource` plus `templatePaths()`, `openTemplatePaths()`
(replacing a direct read of `overlays` — `Workspace`'s own private Map), and `resolveScopeRefs()`
(wraps `Linker`, fully hiding the Linker's existence from the orchestrator).
