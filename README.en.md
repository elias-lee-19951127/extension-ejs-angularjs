# EJS + AngularJS Navigator

Tracks variables and functions between **EJS** templates and **AngularJS 1.x** (ES5) controllers —
go-to-definition from `{{ expression }}` to `$scope`, find-usages back from controller to
template, and dead-code detection.

One language server (Node/TypeScript), two thin clients: **VSCode** and **IntelliJ**.

> Full design and measurements from a real codebase: [docs/architecture.md](docs/architecture.md)
> (English) / [docs/kien-truc.md](docs/kien-truc.md) (Vietnamese, canonical)

## What already works

| | Example |
|---|---|
| Template → JS | `data-ng-click="selectSection(section)"` → `$scope.selectSection` |
| Property of an `ng-repeat` variable | `section.icon` → the `icon:` key in the object literal of `$scope.sections` |
| Nested property | `busy.stats` → jumps straight into the `stats:` key in the object literal |
| Local variable | `section` in `ng-repeat="section in sections"` → declaration at that spot |
| `ng-controller` → declaration | even with hyphenated names: `cityos-demo-dha-management-view-controller` |
| JS → Template | `$scope.busy` → every usage in every template |
| Custom directive | `pick-file="onPick($file)"` → `.directive('pickFile', …)` |
| Isolate binding | `<my-widget data="form">` → `bindings: { data: '<' }` |
| Filter | `{{ x | money }}` → `.filter('money', …)` |
| DI | `function ($scope, Api)` → `.factory('Api', …)` (Angular declaration first, parameter second) |
| Plain JS variable | `const`/`let`/`var`/`function`/parameter, following correct scope and shadowing |
| Cross-file global | `DHA_STATUS` declared in `dha.const.js` → used in `dha.controller.js` |
| Global variable | `window`, `JSON`, `$event` → reported as "built-in", not an error |
| EJS axis | `<%= denyMessage %>` → locals from `res.render` |
| Dead code | controller / directive / filter / property that nobody uses |
| Rename | `$scope.busy` → renames every read/write in sync across JS and every template; refuses with a reason on conflict |
| Shape-based completion | `busy.` → `search`, `ingest`…; `section.` → the keys of an element in `sections` |
| Files changed outside the editor | `git pull` / checkout / another tool → index auto-updates (VSCode and IntelliJ), no need to re-index manually |

## Getting started

```bash
npm install && npm run build
```

CLI (runs right away, no IDE needed):

```bash
node packages/cli/dist/index.js index --root /path/to/your/repo
```

```bash
node packages/cli/dist/index.js def /path/to/view.ejs 41 38 --root /path/to/your/repo
```

```bash
node packages/cli/dist/index.js refs /path/to/controller.js 53 11 --root /path/to/your/repo
```

```bash
node packages/cli/dist/index.js unused --root /path/to/your/repo
```

Coverage sweep — try to resolve **every** identifier in **every** template, and report what's
still missing:

```bash
node packages/cli/dist/index.js sweep --root /path/to/your/repo
```

Locate by string instead of counting columns (use this to inspect one specific expression):

```bash
node packages/cli/dist/probe.js <file> "section.enabled" --offset 8 --root /path/to/your/repo
```

Preview a rename — list every location that would be edited, **without writing any file**:

```bash
node packages/cli/dist/probe.js <file> "\$scope.busy = " --offset 7 --rename isBusy --root /path/to/your/repo
```

`ejsng scan <file>` prints every fact extracted from one file — the main debugging tool.

## Trying it in VSCode

Open this folder in VSCode, press F5 to launch the Extension Development Host, then open your
AngularJS repo in the new window.

## Trying it in IntelliJ

`packages/intellij-client` is a Gradle plugin that uses **LSP4IJ** (open-source, Red Hat) instead
of JetBrains' built-in LSP API — that API only runs on paid IDE tiers. Licensing details:
[docs/architecture.md, Appendix B](docs/architecture.md).

Any JDK ≥ 17 is needed to run Gradle; JDK 21, used for compilation, is fetched automatically by
foojay.

```bash
cd packages/intellij-client && ./gradlew verifyPluginProjectConfiguration verifyPluginStructure
```

```bash
cd packages/intellij-client && ./gradlew buildPlugin verifyPlugin
```

```bash
cd packages/intellij-client && ./gradlew runIde
```

Installable artifact: `packages/intellij-client/build/distributions/ejsng-intellij-0.1.0.zip`
(Settings → Plugins → ⚙ → Install Plugin from Disk).

**Node:** the plugin locates Node itself via `NodeLocator` — supporting nvm, fnm, volta, asdf,
nodenv, and system paths. This is necessary because an IDE launched from the Dock does not
inherit the shell's PATH. Force a specific path with the `EJSNG_NODE` environment variable.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `ejsng.moduleAliases` | `["myApp","app","appModule"]` | Variables holding the Angular module but declared in another file |
| `ejsng.ejsDelimiter` | `"%"` | Change to `"?"` for `<? ?>` |
| `ejsng.customDirectives` | `{}` | `{"myOn": "statement"}` — the company's own custom directives |
| `ejsng.diagnostics.enabled` | `false` | **Off by default** to avoid thousands of false warnings on legacy code |
| `ejsng.include` / `exclude` | | Glob patterns for file scanning |

## Architecture

```
packages/core/            All the logic — no LSP dependency, testable standalone
  src/ejs/scanner.ts        Scans EJS regions, builds the virtual HTML/JS
  src/ng/lexer,parser,ast   Angular expression parser (NOT JavaScript)
  src/ng/microsyntax.ts     ng-repeat / ng-options
  src/ng/normalize.ts       data-ng-* → ngX, directive syntax table
  src/extract/js.ts         Layer 2: facts from .js (pure per-file)
  src/extract/template.ts   Layer 2: facts from .ejs (pure per-file)
  src/index/store.ts        Layer 3: NDJSON + in-memory lookup tables (Appendix D)
  src/resolve/linker.ts     Layer 4: cross-file linking
  src/resolve/workspace.ts  Queries: definition / references / completion / rename
  src/resolve/rename.ts     Rename: scans $scope, scoping when controllers share a name
packages/server/          LSP server
  test/lsp.test.js          Tests over stdio: the real server, JSON-RPC like an IDE
packages/cli/             CLI — debugging and benchmarking without an IDE
packages/vscode-client/   VSCode extension
packages/intellij-client/ IntelliJ plugin (Kotlin + LSP4IJ)
fixtures/mini/            A scaled-down repo for tests
```

**The most important constraint of this codebase:** a Layer 2 fact must be a **pure function of
the content of a single file** — it must not read another file, and must not query the index.
That's the condition that makes caching correct. Any conclusion that needs cross-file information
must live in Layer 4 (`linker.ts`). Whenever extractor logic changes, you **must bump
`PARSER_VERSION`** in `src/index/schema.ts` — otherwise the old index gets reused and produces
wrong results.

## Tests

```bash
npm test
```

Runs the core tests and the LSP tests over stdio (spinning up a real server). Tests against the
`smart-city` repo skip themselves automatically if that repo isn't present on the machine.
`spans.test.js` enforces the invariant "every span points exactly at the text it represents" — see
[Appendix I](docs/architecture.md).
