# Architecture: an extension for tracking variables/functions in an EJS + AngularJS 1.x codebase

## 0. What the real problem is

"Track variables from HTML to JavaScript, like React" — in an EJS + Angular 1 stack this is
actually **two completely different axes**, running at two different times. They must be kept
separate from the start; conflating them produces the wrong data model.

### Axis A — server-side (EJS)
```
Express: res.render('user/profile', { user, orders })
  └─> views/user/profile.ejs:  <%= user.name %>
        └─> <%- include('partials/order-row', { row: o }) %>
              └─> partials/order-row.ejs:  <%= row.total %>
```
The variable `user` is a template **local**, existing only during server-side render. Its
declaration source is the `res.render()` call / `app.locals` / `res.locals` / middleware.

### Axis B — client-side (Angular 1)
```
angular.module('app').controller('ProfileCtrl', function($scope, UserSvc) {
  this.orders = [];          // controllerAs
  $scope.total = 0;          // scope property
})
  └─> <div ng-controller="ProfileCtrl as vm">
        {{ vm.orders.length }}          <-- resolves to `this.orders`
        <li ng-repeat="o in vm.orders"> <-- `o` is a new scope variable, typed as an element of vm.orders
          {{ o.total | currency }}      <-- `currency` resolves to .filter('currency', ...)
```

### The intersection (the buggiest spot, and the extension's selling point)
```html
<!-- EJS injects server data into Angular -->
<script>window.BOOT = <%- JSON.stringify(bootstrapData) %>;</script>
<div ng-init="ctx = <%- JSON.stringify(ctx) %>">
```
No existing tool connects these two ends. This is where the extension delivers the clearest value
over WebStorm/VSCode's built-in tooling.

**Model conclusion:** a single `.ejs` file contains **three nested languages** (server-side
EJS-JS, HTML, client-side Angular expressions) and references **two separate symbol graphs**. The
index must reflect exactly that.

---

## 1. Overall architecture: 1 language server, 2 thin clients

```
┌──────────────────┐   ┌──────────────────┐
│ VSCode extension │   │ IntelliJ plugin  │
│ (TS, ~300 LOC)   │   │ (Kotlin, ~200)   │
│ vscode-languagecl│   │ LSP4IJ           │
└────────┬─────────┘   └────────┬─────────┘
         └──── stdio / JSON-RPC ─┘
                    │
        ┌───────────▼─────────────────────────────┐
        │  ejs-ng-language-server  (Node 20, TS)  │
        │  ┌────────────────────────────────────┐ │
        │  │ Layer 1  Scanner/Parser            │ │
        │  │ Layer 2  Fact extractor (per-file) │ │  <- pure, cacheable
        │  │ Layer 3  Index store (SQLite)      │ │
        │  │ Layer 4  Linker + Resolver         │ │  <- in-memory, built from L3
        │  │ Layer 5  LSP feature handlers      │ │
        │  └────────────────────────────────────┘ │
        └─────────────────────────────────────────┘
```

**Why an LSP instead of writing 2 native plugins:** the Angular scope-resolution logic is the
hard part, taking up ~85% of the effort. Writing it twice (TS for VSCode, Kotlin/PSI for
IntelliJ) would be self-defeating. An LSP lets us write it once, with both clients reduced to mere
adapters.

**The price paid:** IntelliJ via LSP doesn't integrate with native PSI — so IntelliJ-style rename
refactoring, structure view, and custom inspections will be more limited. Acceptable for v1.

### IntelliJ: which bridge to choose
| Option | Runs on | Verdict |
|---|---|---|
| **LSP4IJ** (Red Hat, open-source) | Community + Ultimate + WebStorm | **Chosen.** Supports definition/references/hover/completion/rename/diagnostics. Not locked to an IDE license tier. |
| `com.intellij.platform.lsp` (JetBrains' built-in LSP API, from 2023.2) | **paid IDEs only** | Rejected — a team using Community wouldn't be able to install it. |
| Native Kotlin plugin + `FileBasedIndex` + PSI | any IDE | Best UX quality but ~3x the effort. Saved for v2 if LSP4IJ isn't enough. |

Packaging: either bundle a Node runtime, or require Node >= 18 on the dev machine (the team
already has Node).

---

## 2. Layer 1 — Parser

### 2.1 EJS scanner (hand-written, ~250 LOC)
EJS is not valid HTML, and no HTML parser can swallow it directly. The approach:

1. Linear scan for delimiters: `<%` `<%=` `<%-` `<%#` `<%_` … `%>` `-%>` `_%>`, handling `<%%`
   (literal escape). The delimiter must be **read from config** (`ejs.delimiter`, since many teams
   switch to `<? ?>`).
2. Result: a list of regions `{kind: 'html'|'script'|'output'|'comment', range}`.
3. Build a **virtual HTML document**: replace each EJS region with exactly as many whitespace
   characters → offsets stay 1:1, no source map needed for the HTML layer. This trick matters a
   lot and saves a lot of off-by-one bugs.
4. Build a **virtual JS document** for Axis A: concatenate the script/output regions, this time
   *with* a source map (offsets are no longer 1:1). Wrap it in
   `function(locals){ with(locals){ ... } }` to faithfully simulate EJS scoping.

Trap: EJS allows cutting HTML mid-way through —
`<% if (x) { %><div><% } %>` → the virtual HTML ends up with an unclosed `<div>`. The HTML parser
**must be error-tolerant**, and when building the DOM tree it has to accept a torn tree.

### 2.2 HTML parser
Uses **`angular-html-parser`** (a fork of the parser the Angular team maintains, also used by
Prettier): error-tolerant, and retains full position info for both attribute names and values —
something `parse5` doesn't give as conveniently. Positions *inside* attribute values are needed
because `ng-click="vm.save(item)"` must map each identifier individually.

### 2.3 Angular expression parser
**Don't use acorn for Angular expressions.** The Angular expression language is its own
language, distinct from JS:
- has the filter pipe `a | date:'short'`
- has one-time binding `::expr`
- no `new`, no `function`, no `;`, no access to `window`
- `ng-repeat` has its own microsyntax: `item in items | filter:q as results track by item.id`

The cheapest and most correct approach: **port the Lexer + AST builder straight from
`angular.js/src/ng/parse.js`** (MIT), dropping the compile-to-function part, keeping only the AST,
adding `start`/`end` fields to every node. About 600 LOC copied over. Writing a Pratt parser from
scratch is also possible, but would take weeks chasing edge cases.

Each directive needs its own **parse strategy**, declared via a table:
```ts
const DIRECTIVE_SYNTAX: Record<string, ExprKind> = {
  'ng-repeat':   'repeat-microsyntax',
  'ng-options':  'options-microsyntax',
  'ng-if':       'expression',
  'ng-click':    'statement',      // allows multiple statements separated by ';'
  'ng-model':    'assignable',     // must be an assignable LHS
  'ng-class':    'expression',
  // ...
};
```
This table must be **extensible via config** to declare the company's own custom directives.

### 2.4 JavaScript ES5
`acorn` with `ecmaVersion: 5` (raised to 2018 if some files mix in ES6), falling back to
`acorn-loose` while a file is mid-edit. Needs `locations: true` + `ranges: true`.

---

## 3. Layer 2 — Fact extractor (the part that decides cache quality)

**Unbreakable rule: the facts for a file must be a pure function of that file's content.** No
looking at other files. Violating this produces a broken cache, and a wrong-cache bug is
extremely hard to track down. Anything requiring cross-file information is pushed entirely down
to Layer 4.

Facts extracted from a `.js` file:
```ts
type JsFacts = {
  ngDeclarations: Array<{           // .controller/.service/.factory/.directive/.filter/.component/.value/.constant/.provider
    kind, name, nameRange, bodyRange,
    deps: string[],                  // DI: array-annotation, $inject, and implicit forms
    depsRanges: Range[],
  }>;
  // for controller/directive-controller:
  scopeWrites: Array<{ path: 'this.foo' | '$scope.foo', name, range, valueKind }>;
  scopeReads:  Array<{ path, name, range }>;
  routeBindings: Array<{            // $routeProvider / $stateProvider / component router
    templateUrl?: string, template?: string,
    controller?: string, controllerAs?: string, ranges
  }>;
  ddo: Array<{                      // directive definition object
    selector, restrict, templateUrl?, scope?: Record<attr, '='|'@'|'&'|'<'>,
    bindToController?, controllerAs?, transclude?
  }>;
  // Axis A:
  renderCalls: Array<{ viewPath: string, localsKeys: string[], ranges }>;  // res.render(...)
};
```

Facts extracted from a `.ejs` file:
```ts
type EjsFacts = {
  localsUsed:  Array<{ name, path: string[], range }>;   // Axis A
  includes:    Array<{ viewPath, passedKeys, range }>;   // Axis A
  ngContexts:  Array<{                                    // Axis B
    elementRange,
    ngController?: { name, alias, range },
    ngRepeat?:     { itemVar, indexVars, listExpr, range },
    ngInit?:       { assignedVars },
    directiveTags: string[],       // to join with the DDO
  }>;
  ngExpressions: Array<{ ast, range, contextChain: ElementPath }>;
  bridges: Array<{ jsVarName, ejsExpr, range }>;          // A×B intersection
};
```

Technical points worth noting:
- **DI resolution** must catch all 3 forms: `function(a, b)`, `['a','b', function(a,b){}]`,
  `Foo.$inject = ['a','b']`. Form 1 breaks under minification but is still common in older code.
- **`.controller('X', fn)` where `fn` is declared elsewhere** — record the name and let Layer 4
  join it up.
- `$scope.$watch('someExpr', ...)` and `$emit/$on/$broadcast('event')` should also be indexed:
  this is a "string-typed variable/function" that no IDE currently tracks, and it's very valuable
  when refactoring.

---

## 4. Layer 3 — Indexing strategy

This is your main question. Comparing the options:

> ⚠️ **This section was WRONG and has since been corrected. See Appendix D.** The SQLite
> recommendation below missed the single most decisive constraint: native modules don't work
> inside an IDE extension.

| Option | Cold start | Warm start | RAM | Reverse queries | Notes |
|---|---|---|---|---|---|
| Plain in-memory Map | slow every open | = cold | high | build yourself | Only fits repos < 500 files |
| **NDJSON + in-memory index** | fast | **fast** | moderate | build yourself | **This is the correct choice — Appendix D** |
| ~~SQLite (better-sqlite3)~~ | slow once | fast | low | SQL indexes handle it | ❌ **Native module — breaks in the IDE** |
| LMDB / RocksDB | similar | fast | low | build yourself | ❌ Also a native module, same problem |
| sql.js (SQLite WASM) | slower | slower | high | SQL handles it | Pure JS but loads the whole DB into RAM; overkill at this scale |
| Tantivy/Lucene | — | — | — | — | Overkill — this is a symbol index, not full-text search |

### Proposed schema
```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE, mtime INT, size INT,
  hash TEXT,              -- xxhash64 of the content
  facts BLOB,             -- compressed JSON, Layer 2 output
  parser_version INT      -- bumped when extractor logic changes => auto-invalidates everything
);
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY, file_id INT, kind TEXT, name TEXT,
  container TEXT,         -- 'ProfileCtrl' for a scope property
  line INT, col INT, end_line INT, end_col INT
);
CREATE INDEX idx_sym_name ON symbols(name);
CREATE INDEX idx_sym_container_name ON symbols(container, name);

CREATE TABLE refs (
  id INTEGER PRIMARY KEY, file_id INT, symbol_name TEXT, container TEXT,
  axis TEXT,              -- 'ejs-locals' | 'ng-scope' | 'ng-di' | 'event' | 'bridge'
  line INT, col INT, end_line INT, end_col INT,
  resolved_symbol_id INT  -- NULL = not resolved (used to report a diagnostic)
);
CREATE INDEX idx_ref_name ON refs(symbol_name, container);

CREATE VIRTUAL TABLE symbols_fts USING fts5(name, content=symbols);
```

### Indexing pipeline
1. **Discovery**: `fast-glob` scans according to `include`/`exclude` from config, skipping
   `node_modules`, `bower_components`, `dist`, `*.min.js`.
2. **Parallel cold index**: `worker_threads`, pool = `os.cpus().length - 1`. Each worker receives
   a batch of paths and returns `JsFacts`/`EjsFacts`. Written to SQLite in transaction batches of
   500 files (writing one file at a time would be ~50x slower).
3. **Warm start**: read `files(path, mtime, hash)`, `stat` every file, only re-parse files that
   diverge. Target for a 5,000-file repo: < 1s.
4. **Incremental while typing**: debounce 150ms → re-parse **only the currently open file** from
   the in-memory buffer content (no disk read) → update the in-memory fact overlay, not yet
   written to SQLite. Written on save. Target: < 20ms/file.
5. **Cross-file invalidation**: keep an in-memory `dependency graph` (Layer 4). Editing
   `ProfileCtrl.js` does **not** require re-parsing `profile.ejs` — only rebuilding the bindings
   of the templates that point to it. This is exactly why Layer 2 and Layer 4 must be separate.
6. **File watcher**: `chokidar` for changes made outside the IDE (git checkout, pull). When more
   than 20% of files change at once (a sign of a branch switch) → trigger a full background
   re-index instead of a per-file one.

### Performance targets (repo ~5,000 files, ~1.5M LOC)
| Operation | Target |
|---|---|
| Cold index (8 cores) | < 30s, with a progress bar; the IDE is usable immediately in degraded mode |
| Warm start | < 1s |
| Re-index 1 file while typing | < 20ms |
| Go-to-definition | < 30ms |
| Find-all-references across the repo | < 200ms |
| Resident RAM | < 300MB |

---

## 5. Layer 4 — Linker & Resolver (the hardest part)

### 5.1 Linking template ↔ controller
Link sources, in decreasing order of reliability:
1. `ng-controller="Foo as vm"` directly in the markup — the most certain.
2. A directive's DDO: `templateUrl` + `controller` + `controllerAs` + `scope`/`bindToController`.
3. `$routeProvider.when(..., {templateUrl, controller, controllerAs})`.
4. `$stateProvider.state(..., {views: {...}})` (ui-router — watch out for named views).
5. `.component('foo', {templateUrl, controller, bindings})`.
6. **Fallback heuristic**: matching filenames (`profile.ejs` ↔ `profile.controller.js`) or the
   same directory. Only used when 1–5 all fail, and must be flagged `confidence: 'low'` so the UI
   can render it differently.

**An EJS-specific issue:** `templateUrl: '/views/profile.html'` is a runtime URL, not a disk path,
and the real file may be a `.ejs`. Needs a config map:
```jsonc
{
  "templateRoots": [
    { "urlPrefix": "/views/",     "fsPath": "src/views",     "extensions": [".ejs", ".html"] },
    { "urlPrefix": "/templates/", "fsPath": "public/tpl" }
  ],
  "expressViewsDir": "src/views"   // for Axis A: res.render('user/profile')
}
```
If `templateUrl` is a dynamic expression (`templateUrl: base + '/x.html'`) → skip it, and record
it in an "unresolved links" report so the user knows to declare it manually.

**Implemented** (`.scratch/template-roots-config/issues/01-resolve-template-url.md`), sources 2–5,
in `packages/core/src/resolve/template-links.ts`:
- The extractor records `JsFacts.templateLinks` (still a pure fact, not yet mapped to a file). Layer 4
  maps the URL through `templateRoots` (longest prefix first; the name as-is, then each of
  `extensions` swapped in or appended), and finally tries the URL as a path from the workspace root.
- The controller is joined **at query time**: `Workspace.facts()` inserts a controller frame just
  inside the root frame of every scope chain — an `ng-controller` inside the template is nearer, so
  it still wins. Because it goes through `facts()`, go-to-definition, completion, hover and rename
  all see the same link.
- A template given **several different controllers** is bound to none and reported as
  `ambiguous-controller` (guessing would resolve half its expressions wrongly). A URL matching no
  file → `no-file`; an expression → `dynamic`. Report: `Workspace.templateLinkIssues()` and the end
  of `ejsng sweep`'s output.
- `expressViewsDir` (default `views`, like Express) for `res.render('user/profile')`: Ctrl+click on
  the view name opens the view; Ctrl+click on `<%= user %>` jumps to the `user` key of every
  `res.render()` rendering that view.
- Not done: the fallback heuristic (source 6), and `$uibModal.open`/`$mdDialog.show({templateUrl})`.

### 5.2 Scope chain resolver
For every element in the virtual DOM, build a **scope chain** going from the node up to the root:
```
<body ng-controller="AppCtrl as app">        scope0: {app: AppCtrl}
  <div ng-controller="ProfileCtrl as vm">    scope1: parent=scope0, {vm: ProfileCtrl}
    <li ng-repeat="o in vm.orders">          scope2: parent=scope1, {o, $index, $first,
                                                      $last, $middle, $even, $odd, $id}
      {{ o.total }}                          resolve `o` -> scope2 -> the element type of vm.orders
```
Rules:
- A directive with `scope: {...}` → **isolate scope**, cutting the chain (except `$parent`). Keys
  in the scope object become variables, and are mapped back to attributes on the calling tag.
- `bindToController: true` → binding attaches to `this` rather than `$scope`.
- `transclude` → transcluded content uses the scope of the **call site**, not the directive's own
  scope. This is the case that resolves incorrectly most often.
- `ng-init`, `ng-repeat ... as x`, `ng-if` (creates a child scope!), `ng-switch`, `ng-include`
  (creates a child scope), forms/`ng-form` (puts the form's name onto scope, `myForm.$valid`...).
- Built-in variable list: `$event` inside `ng-click`, `$index`... inside `ng-repeat`.

Resolution results come in 3 levels: `resolved` / `ambiguous` (several matching controllers) /
`unresolved`. The UI must distinguish these — reporting "unresolved" as if it were an error in
legacy code would generate thousands of false positives and get the extension disabled
immediately.

### 5.3 Type inference (just enough)
No need for a full type system. Just one thing is needed: the **shape** of an object so that
completion on `vm.user.` can suggest `name`, `email`. Cheap approach:
- Follow `this.user = {...}` literals → take the keys.
- `this.users = []` + `this.users.push({...})` → infer the element shape.
- `UserSvc.get().then(function(r){ this.user = r.data })` → give up, return `any`.

If you want more than this level → see section 6.

#### 5.3.1 Observed Type — hover, and an inline "may be empty" (2026-09-19)

The shape above serves **completion and go-to-definition**, so it takes only the **first
assignment** (`scopeMembers` — the "declaration"). To let a developer **see the data shape** while
writing a template without opening the controller, v1 adds a separate fact and a merging layer. Full
spec: `.scratch/observed-types/spec.md`.

**Merge every assignment, not just the first.** Measured on `smart-city` (32 data members, 581 uses
in templates): the first assignment gives a useful type for **78.8%** of uses; merging every
assignment raises that to **96.0%**. The main reason: 5 members are assigned `null` first and the
real value later. The extractor now records **every** `$scope.x = …` / `this.x = …` assignment
(including through `var vm = this`) in a new fact, `JsFacts.scopeWrites`, each carrying: the shape of
every branch (`a ? b : c`, `a || b`), a `nullable` flag (some branch is an explicit
`null`/`undefined`/`void 0`), an `inCallback` flag, and the shortened right-hand side to explain a
shape that can't be inferred. Primitives are now typed (`string`/`number`/`boolean`). `scopeMembers`
**stays** first-assignment-only — putting every assignment there would give go-to-definition several
targets and change how rename behaves.

Merge rules (`packages/core/src/resolve/observed-type.ts`): the same kind merges into one, a key
missing from some assignments becoming optional `id?`; genuinely different kinds stay a union
`A | B`; an `unknown` next to something known is dropped and marked `partial`. TypeScript syntax,
`T[]`. Hover cuts off at 2 nesting levels and 8 keys per level, noting the rest as `…+N`. Only the
**copy of the controller nearest the file** is merged when a controller is declared in several files
(as `preferNearest` does, Appendix K) — `lastSearchMs` measured 8 assignments because it was declared
twice.

**Nested assignments.** `$scope.state.loading = true` adds the key `loading` (optional) to the shape
of `state`. Without it, hovering `{{ state.loading }}` would wrongly say "`state` has no `loading`" —
being wrong is worse than staying silent.

**Why not inline on every expression.** A type annotation after every expression doubles the length
of a template line, and users would turn it off immediately (the same reason
`ejsng.diagnostics.enabled` is off by default). Inline hints have to be rare to be trusted: only
**`may be empty`**, faintly styled, after a variable with **at least one explicit** `null`/`undefined`
assignment. It is not called an error: Angular expressions don't throw on null (`{{ a.b }}` renders
empty). A member **only assigned in a callback** gets no inline hint — counting that case would flag
nearly all async-loaded data; the hover says it instead. JS files and EJS locals: no inline hints. On
`smart-city`: 9 templates → 127 hints, each matching a real `= null`; 62ms for all 9 files.

**A data model ready for runtime sources.** A variable's type = a set of **Type Evidence**
`{ source: 'static' | 'runtime', shape, site | connection, count, lastSeen }`. v1 has only `static`
(each `ScopeWrite` is one piece) — runtime can plug in later without changing the display. Runtime
evidence is **held in RAM, per connection, never written to the cache**: old values go stale fast and
may contain personal data.

**Roadmap for runtime sources.**

| Version | Source | Notes |
|---|---|---|
| 2 | **R1** — values from `console.log`/logpoints the Runtime Log pipeline already receives (`type/subtype/preview` of a CDP `RemoteObject`) | **Done** (2026-09-20, see below). Not free as assumed: the preview is too shallow, so `Runtime.getProperties` is needed on top. |
| 2 | **R4** — an always-`false` conditional breakpoint at each `res.render(...)`, recording the shape of the locals through `Runtime.addBinding` | Targets exactly the EJS 500 error (`<%= user.name %>` with `user` undefined) — which static analysis barely knows about, since the type comes from `req`/the DB. |
| 3 | **R3** — on hover, `Runtime.evaluate` `angular.element(el).scope()…` on a connected tab, with `throwOnSideEffect: true` | The real current value. Hard part: finding the DOM element for the template. Doesn't work if the app is built with `debugInfoEnabled(false)`. |

**R2 dropped** (an automatic probe after every assignment): the probe runs every time that line
runs — hot loops included — and leaves hundreds of hidden breakpoints that are hard to debug. R1 + R3
cover the need without either cost.

#### 5.3.2 R1 — types from logged values (2026-09-20)

Spec: `.scratch/observed-types-r1/spec.md`. When Runtime Log draws a log whose argument is a scope
variable — a `{vm.rows}` part of a logpoint, or an argument of a **direct** `console.<method>(…)` — the
value's type becomes **Type Evidence** with `source: 'runtime'` and is merged into the hover.

**Measured first (Node 20.20 and Chrome 153 gave identical results):**

| | |
|---|---|
| Object preview in `consoleAPICalled` | at most **5 keys** (`overflow: true`) |
| Array preview | at most **100 elements** |
| Nested object / array element in a preview | **no keys at all** — just `{type: "object", value: "Object"}` |
| Getter | `type: "accessor"`, **never run** (in the preview and in `getProperties`) |
| `Runtime.getProperties({ownProperties, generatePreview})` | 0.2–0.4 ms for a small object; 2–4 ms for a 150-element array, each element with a 5-key preview |

So for the main case, `console.log($scope.rows)` — an array of objects — the preview says nothing about
the elements' keys. The server therefore **digs** with `getProperties`: level by level (calls within a
level in parallel, shallow levels first), down to the hover's limits (2 levels, 8 keys), sampling 3
array elements (first/middle/last), **≤ 12 requests per log**. The same place logging a value of the
same preview type within 30 s is only counted, not dug again. Digging runs **after** the log is drawn and
off the drawing queue, so it never slows logs down.

**Open objects.** What isn't dug keeps its preview and is marked `open`: when merged, the keys it has
are added, but the keys it lacks do **not** turn optional (otherwise every key past the 5th in a preview
would become `id?` — systematically wrong). The hover ends an open object with `…`.

**Tying a log to a variable.** Done at index time, not when a log arrives: the fact
`JsFacts.consoleCalls` records every direct `console.*` call in an Angular declaration with the scope
variable each argument reads (same rules as `scopeWrites`: `$scope`, `this`, `var vm = this`). It is
looked up by the position of the **method name** — V8 was measured to put a console call's frame exactly
there (even for `console . log (` split over lines). Logpoints: expressions are resolved once, at
`ejsng/setLogpoints`. Logging through a wrapper, logging a local, `a[0]` → not tied (a wrong match is
worse than none).

**What is kept, and for how long.** Only the **type**, never the value. A dictionary object (> 50 keys,
or keys that aren't identifiers — e.g. e-mails) becomes `Record<string, T>`, since its keys are data.
`$$hashKey` is dropped. The store lives on the connection itself: reconnecting, disconnecting or the
runtime dying drops it. At most 20 types per variable, 2000 in all. Runtime evidence carries an
`ObservedType` directly instead of widening `ValueShape` — `ValueShape` is the cached index format and
completion's input, and can't express the mixed-element unions real values often have.

**Inline hints don't move.** A runtime seeing `null` makes the hover say "Seen `null`/`undefined` at
runtime", but `nullable` (and the `may be empty` hint) is still computed from static assignments only: a
log runs at an arbitrary moment, not at render time, and a hint must not appear and disappear depending on
whether a runtime is connected.

**In practice on `smart-city` (measured 2026-09-20):** 288 `console.*` calls, 8 inside controllers,
**none of which logs a scope variable** — all log strings or locals (`error`, `event`). So on real code
R1 does nothing through existing logs; it pays off when the developer **deliberately sets a logpoint**
`{vm.rows}`. A next step worth weighing: a "log this variable" command from the hover that sets that
logpoint for them.

---

## 6. The big fork: hand-written resolver vs. virtual-TS (Volar-style)

### Direction 1 — Hand-written resolver (section 5)
Full control, no dependency on tsserver, fast, low RAM. But: weak type inference, rename must be
built by hand, completion only works well for properties declared explicitly.

### Direction 2 — Generate virtual TypeScript + source maps, hand off to tsserver
This is how Vue (Volar) and the Angular Language Service work. Given this template:
```html
<li ng-repeat="o in vm.orders">{{ o.total | currency }}</li>
```
generate a virtual file `profile.ejs.__ng.ts`:
```ts
import { ProfileCtrl } from './profile.controller';
function __tpl(vm: ProfileCtrl) {
  for (const o of vm.orders) {
    __filter_currency(o.total);
  }
}
```
with a source map linking every token back to a range in the `.ejs`. Then **call tsserver
directly** for definition / completion / rename / hover / diagnostics, and map the results back.

| | Hand-written resolver | Virtual TS |
|---|---|---|
| Resolver-layer effort | high | low (tsserver handles it) |
| Codegen + sourcemap effort | none | **high, and where bugs are born** |
| Type inference | weak | strong (`allowJs` + JSDoc, can even be inferred through the service) |
| Safe rename | build it yourself, easy to miss cases | almost free |
| Performance on an ES5 1.5M-LOC repo | good | **risky** — tsserver eats RAM and is slow on untyped JS |
| Dependency | none | tsserver (a semi-official API, changes across TS versions) |

**Recommendation: go with Direction 1 first, and design Layer 4 behind a `Resolver` interface**
so Direction 2 can be plugged in later for features that need deep inference (completion,
rename), while keeping Direction 1 for definition/references (fast, always works). This hybrid
architecture is the best balance: 80% of the value comes from go-to-definition and
find-references, the two things Direction 1 does well and cheaply.

**Tree-sitter is not recommended** here: its advantage is incremental parsing for huge files, but
Angular 1 files are usually small, and acorn is already fast enough and gives a much more
workable AST.

---

## 7. Feature list, ranked by value/effort ratio

| # | Feature | Axis | Value | Effort |
|---|---|---|---|---|
| 1 | Go-to-definition: `{{vm.foo}}` → `this.foo` in the controller | B | ★★★★★ | medium |
| 2 | Find-all-references: `this.foo` → every usage in templates | B | ★★★★★ | medium |
| 3 | Go-to-definition: `<%= user.name %>` → `res.render(..., {user})` | A | ★★★★☆ | low |
| 4 | Hover: show signature/declaration + source path | A+B | ★★★☆☆ | low |
| 5 | Completion in template (`vm.` → list of properties) | B | ★★★★☆ | high |
| 6 | Diagnostic: using a variable that doesn't exist on scope | B | ★★★★☆ | medium |
| 7 | Diagnostic: dead code — unused controller/filter/service | A+B | ★★★★☆ | low |
| 8 | Go-to-definition for DI (`function(UserSvc)` → `.service('UserSvc')`) | B | ★★★★☆ | low |
| 9 | Rename synced across JS ↔ template | B | ★★★☆☆ | high |
| 10 | Track `$emit`/`$on`/`$broadcast` by event name | B | ★★★☆☆ | low |
| 11 | Track EJS `include()` chains | A | ★★★☆☆ | low |
| 12 | CodeLens "3 usages in templates" on a controller property | B | ★★☆☆☆ | low |

#8, #7, #10, #11 are the **cheap-but-very-useful** items — worth slotting in early, no need to
wait.

---

## 8. Roadmap

**Spike, 1 week — answer the make-or-break question:** write a Node script that reads the
company's real repo and counts: the ratio of templates linkable to a controller by each method in
5.1; the number of dynamic `templateUrl`s; the number of custom directives; the number of EJS
files that cut HTML mid-way. **Don't design further before you have these numbers** — if only 40%
of templates can be linked, heavy investment is needed in a manual mapping mechanism via config.

- **M1 (2–3 weeks)** — Monorepo, EJS scanner, HTML parser, acorn extractor, SQLite index, a
  working LSP server. Features #1 + #2 + #8. VSCode client.
- **M2 (2 weeks)** — Full scope chain resolver (ng-repeat, isolate scope, transclude). Features
  #4, #6, #10, #12. IntelliJ client via LSP4IJ.
- **M3 (2 weeks)** — Axis A: `res.render` + include chain (#3, #11), the A×B bridge. Feature #7.
- **M4 (3 weeks)** — Completion (#5) and rename (#9), consider plugging in virtual-TS at this
  step. **Rename and shape-based completion were built without needing virtual-TS — see
  Appendix I.**

## 9. Repo structure

```
packages/
  core/            # parser, extractor, index, resolver — no LSP dependency, independently testable
  server/          # LSP wrapper around core
  vscode-client/   # VSCode extension
  intellij-client/ # Gradle + Kotlin plugin, LSP4IJ
  cli/             # index/query from the terminal — extremely important for debugging and benchmarking
fixtures/          # a scaled-down Angular 1 + EJS repo, used for snapshot tests
```
`packages/cli` is not a side extra: it lets you run `ejsng refs vm.orders` in the terminal,
compare output before/after, and benchmark without opening an IDE. Having it changes the
development pace entirely.

## 10. Identified risks

| Risk | Mitigation |
|---|---|
| Low template↔controller link rate → extension is useless | 1-week spike to measure this upfront; provide a manual config mapping mechanism |
| Dynamic `templateUrl`, string concatenation | Accept giving up on it, produce an "unresolved" report for the user to declare manually |
| Diagnostic false positives flooding legacy code | Diagnostics OFF by default; enabled gradually per-directory; always carries a `confidence` level |
| Company's custom directives not understood | Extensible directive table via config from day one, never hardcoded |
| EJS delimiter changed | Read from config, never hardcode `<% %>` |
| IntelliJ via LSP missing native features | Assess acceptability with the team at M2; native plugin as a v2 fallback |

---

# APPENDIX A — Real measurements from the `smart-city` repo (2026-09-10)

Measured on `/Volumes/mac-dev/project/smart-city` (143 `.js` files, 3 `.ejs` files). This repo is
a small demo/patch, but **its coding style is representative**, and it overturns several
assumptions made above.

## A.1 Count results

| Signal | files | occurrences | Meaning |
|---|---|---|---|
| `$scope` | 6 | **365** | Everything uses the `$scope` style, not `controllerAs` |
| `controllerAs` | 0 | **0** | **`controllerAs` is not used** |
| `templateUrl` | 0 | **0** | **No separate template files** |
| `$routeProvider` / `$stateProvider` | 0 | **0** | **No client-side routing** |
| `ng-controller` (all variants) | 3 | 3 | **The only link source, and the most reliable one** |
| `data-ng-*` | — | ~155 | **Almost 100% use the `data-` prefix** |
| bare `ng-*` | — | 4 | a minority |
| `{{ }}` | 27 | 170 | |
| unique `$scope.<name>` | — | 76 | Small symbol table, easy to handle |
| `.filter(` | 26 | 54 | **0/54 are Angular filters** — all are `Array.prototype.filter` |

## A.2 Five mandatory design adjustments

**1. Template↔controller link rate ≈ 100%, not a risk.**
The biggest risk called out in section 10 **does not exist in this repo**. There's no dynamic
`templateUrl`, no routing — every template declares its controller directly in the markup via
`data-ng-controller`. This is the most reliable source (section 5.1 #1). ⇒ **Drop all
`$routeProvider`/`$stateProvider`/`templateUrl` resolution from M1.** Saves about a week.

**2. The resolution target is `$scope.X`, NOT `this.X`.**
In templates, a bare name like `{{ stats.total }}` / `data-ng-click="selectSection(section)"`
must resolve to `$scope.stats` / `$scope.selectSection` in the controller. `controllerAs` must
still be supported (new code may use it) but comes second in priority.

**3. Directive name normalization is MANDATORY.** The repo uses `data-ng-*` almost exclusively:
```
data-ng-click 39 · data-ng-if 31 · data-ng-model 23 · data-ng-disabled 19
data-ng-class 14 · data-ng-repeat 11 · data-ng-controller 2 · data-ng-init 1
data-ng-attr-accept 1
```
Matching only `ng-repeat` would **miss 11/12 of the `ng-repeat`s**. Angular's exact normalization
algorithm must be implemented: strip the `x-` / `data-` prefix, then convert `:` `-` `_` to
camelCase. Watch out for `data-ng-attr-accept` → `ngAttrAccept`, a directive family of its own.

**4. Object-literal shape inference is good enough — virtual-TS isn't needed yet.**
The real-world assignment pattern is very "well-behaved":
```js
$scope.busy       = { search:false, ingest:false, maintain:false, stats:false, ... };
$scope.uploadForm = { fileName:'', contentBase64:'', byteSize:0, title:'', docType:'custom' };
$scope.documents  = [];
```
Just reading the object literal is enough to make completion for `busy.` / `uploadForm.` work
well.
⇒ **Reinforces the decision to go with Direction 1 (hand-written resolver), and defers virtual-TS
indefinitely.**

**5. Regex is unusable — must go through the AST.** 54/54 occurrences of `.filter(` in the repo
are `Array.prototype.filter`, **not a single Angular filter**. A regex-based extractor would
produce 100% false positives here. Mandatory: go through the AST and verify the module chain
(`angular.module(...)` or the variable holding the module) before treating `.filter(`/`.service(`
as a declaration.

## A.3 Two predictions confirmed correct

**EJS cuts HTML mid-way — real, and at an extreme level:** an entire file wrapped inside an `if`
```html
<% if (checkViewACL("cityos-demo-dha-management-view-controller")) { %>
  <div data-ng-controller="..."> ... </div>
<% } else { %> ... <% } %>
```
The HTML parser must be error-tolerant, and the "replace each EJS region with equal-length
whitespace" trick is a sufficient condition for the DOM tree not to break. Both `if`/`else`
branches must end up in the same tree.

**Axis A is real:** `checkViewACL(...)` is a server-side helper injected into EJS locals — exactly
the kind of symbol Axis A needs to track.

## A.4 New findings, not present in the original design

**a) Controller names are hyphenated strings, not identifiers:**
`'cityos-demo-dha-management-view-controller'`. Symbol names must be treated as free-form
strings, not validated against JS identifier rules.

**b) Modules referenced via a variable, sometimes declared in another file:**
```js
const appModule = angular.module("cityosDemo", []);   // web/js/app.js — in-file
appModule.controller("MainController", [...]);
myApp.controller('cityos-demo-...', [...]);           // product/... — `myApp` is NOT declared in this file
```
`myApp` is a global provided by the platform. ⇒ The extractor needs to: (1) trace a variable
holding `angular.module()` within the same file; (2) when the variable is unknown, still
**accept** `<ident>.controller('name', ...)` as a declaration with `confidence: 'medium'`;
(3) allow config `moduleAliases: ["myApp"]` to raise it to `high`. This must be implemented — skip
it and the repo's main controller is lost entirely.

**c) Directory convention:** `product/view/content.ejs` ↔
`product/view/public/javascripts/index.js`. A good fallback heuristic when `ng-controller` is
absent.

## A.5 M1 priorities after re-measuring

| Removed from M1 | Added to M1 |
|---|---|
| Resolving `$routeProvider` / `$stateProvider` | Normalizing `data-ng-*` / `x-ng-*` / `ng:` / `ng_` |
| Resolving `templateUrl` → disk path | Verifying the module chain before accepting a declaration |
| Prioritizing `controllerAs` | Prioritizing `$scope.X`; shape from object literals |

---

# APPENDIX B — The IntelliJ licensing story (verified 2026-09-10)

## B.1 Does writing the plugin cost money?

**No.** The IntelliJ Platform SDK, the `intellij-platform-gradle-plugin`, and publishing on the
JetBrains Marketplace are all free (the SDK is Apache 2.0). There's no API fee for plugin authors.

The money is elsewhere: **the IDE the end user runs.** Choosing the wrong API means the plugin
only installs on paid IDE tiers — not you paying, but the whole team.

## B.2 Three layers, only one carries a license issue

| Component | Free? | Notes |
|---|---|---|
| IntelliJ Platform SDK, Gradle plugin, Marketplace | ✅ | Apache 2.0 |
| **`com.intellij.platform.lsp`** (JetBrains' built-in LSP API) | ❌ | **Commercial IDEs only** |
| **LSP4IJ** (Red Hat) | ✅ | EPL, tier-independent |
| Node runtime running the language server | ✅ | |

JetBrains' documentation is explicit about their LSP API: LSP integration is built as an
extension for commercial IDEs, so a plugin using it **does not work on the open-source edition of
IntelliJ IDEA or on Android Studio**.

⇒ The decision to choose **LSP4IJ** in section 1 stands, and there's now an even stronger reason
for it: JetBrains' licensing surface is shifting (see B.3), while LSP4IJ is immune to that.

## B.3 The context has shifted since 2026-03, and what hasn't changed

IntelliJ IDEA 2026.1 made **core JS/TS/HTML/CSS free**: full syntax highlighting, code
completion, import management, basic refactoring, Prettier/ESLint integration, and basic React
support.

But the part that **remains Ultimate-only** is exactly the part that matters for this project:

> a dedicated debugger, test runner, **support for every frontend framework including Angular,
> Vue**, advanced refactoring

Meaning: **JetBrains will not give your team Angular support on the free tier.** And even paying
for Ultimate, it still doesn't understand `.ejs` templates — where all of the `smart-city` repo's
markup lives.

⇒ This makes the plugin **more valuable, not less**: it's the only path to Angular navigation on
the free tier, and it's the only path — even on Ultimate — to understanding `data-ng-*` inside a
`.ejs` file that's cut apart by `<% if %>`.

## B.4 An open question, and how it's avoided

The documentation says the LSP API isn't available on "IntelliJ IDEA open source builds".
JetBrains has since merged IntelliJ IDEA into a single distribution with a free tier, so **it's
unclear whether the free tier of the merged distribution counts as an "open source build"** (for
PyCharm, they opened this up for the non-Pro edition starting in 2025.1). This point hasn't been
verified.

No need to answer that question: using LSP4IJ makes it moot.

## B.5 A bug fixed by revisiting this section

`plugin.xml` originally declared:

```xml
<languageMapping language="JavaScript" serverId="ejsng"/>
```

The language ID `JavaScript` **only exists when the JavaScript plugin is present**. On an IDE
lacking it (IDEA Community before 2026.1, Android Studio), this mapping silently does nothing —
the plugin installs and starts, but doesn't respond in `.js` files, looking exactly like it's
broken with no error message at all.

Changed to match by filename instead, which works on every edition:

```xml
<fileNamePatternMapping patterns="*.js" serverId="ejsng" languageId="javascript"/>
```

This is exactly why `packages/cli` exists: it verifies the entire core layer without depending on
any IDE license tier.

---

# APPENDIX C — Building the IntelliJ plugin: what was measured doing it for real (2026-09-10)

Actually installed a JDK and built it for real. Every version initially guessed turned out wrong;
recorded here so it doesn't have to be re-discovered.

## C.1 The correct versions

| Component | Initial guess | **Actual** | Why |
|---|---|---|---|
| `intellij-platform-gradle-plugin` | 2.1.0 | **2.18.1** | 2.1.0 is 17 versions old |
| Gradle | 8.14 | **9.7.1** | Plugin 2.18.1 **requires Gradle ≥ 9.0.0** — the opposite of the initial guess of "downgrade Gradle to be safe" |
| Kotlin JVM plugin | 1.9.25 | **2.4.20** | Kotlin < 2.2 doesn't run on Gradle 9 |
| JDK for the toolchain | 17 | **21** | IntelliJ Platform 2024.2 requires Java 21, not 17 |
| LSP4IJ | 0.7.0 | **0.21.0** | 0.7.0 doesn't exist in a usable form; the current version is 0.21.0, `since-build 242` |
| `instrumentationTools()` | present | **removed** | Dropped from plugin 2.x |
| foojay resolver | 0.9.0 | **1.0.0** | 0.9.0 breaks on Gradle 9 with an `IBM_SEMERU` error |

The JDK used to **run** Gradle and the JDK used to **compile** are two different things: Gradle
runs on 17, `jvmToolchain(21)` handles compilation, and foojay fetches JDK 21 automatically. So a
teammate only needs any one JDK.

## C.2 Three verifier errors caught

`verifyPluginProjectConfiguration` + `verifyPluginStructure` run in 12 seconds and caught:

1. `sourceCompatibility` set to 17 while platform 2024.2 needs 21
2. Plugin ID contained the word `intellij` — rejected by the JetBrains Marketplace. Changed to
   `com.ejsng.ejs-angularjs-navigator`
3. `.intellijPlatform/` wasn't yet in `.gitignore`

**Always run these two tasks before spending effort on a build.** They don't need the IDE
downloaded.

## C.3 Verification results

```
Plugin com.ejsng.ejs-angularjs-navigator:0.1.0 against IC-242.20224.300: Compatible
Dynamic Plugin Eligibility: Plugin can probably be enabled or disabled without IDE restart
```

And in a real IDE sandbox:

```
Loaded custom plugins: LSP4IJ (0.21.0), EJS + AngularJS Navigator (0.1.0)
```

## C.4 A serious bug found at runtime: Node not found

The initial `findNode()` only scanned `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`. On this
very machine, `node` lives at `~/.nvm/versions/node/v20.20.0/bin/node` — **matching none of
those**.

This isn't a rare case: **JavaScript teams almost universally use nvm/fnm/volta/asdf**, and an
IDE launched from the Dock/Finder **does not inherit the login shell's PATH**, so even if
`which node` succeeds in a terminal, the IDE still can't see it. The plugin installs fine, loads
fine, then silently does nothing.

Split this out into `NodeLocator.kt`, scanning in this order: `EJSNG_NODE` → volta/asdf shim →
nvm/fnm/nodenv (picking the highest version, compared numerically rather than as strings) →
system paths → asking the login shell via `$SHELL -l -c "command -v node"`.

## C.5 Noise that isn't a plugin bug

The IDE logs a few `SEVERE` lines like `IllegalArgumentException: "26.0.2.1"` while scanning JDKs
on the machine: IDEA 2024.2 (released in 2024) can't parse the version string of Java 26 pulled
in by Homebrew as a Gradle dependency. Unrelated to the plugin.

## C.6 Commands that worked

```bash
cd packages/intellij-client
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew verifyPluginProjectConfiguration verifyPluginStructure   # 12s, no IDE download needed
./gradlew buildPlugin                                               # ~3 minutes the first time
./gradlew verifyPlugin                                              # IntelliJ Plugin Verifier
./gradlew runIde                                                    # opens an IDE sandbox
```

The IDE sandbox log is at
`.intellijPlatform/sandbox/ejsng-intellij/IC-2024.2/log/idea.log` (**not**
`build/idea-sandbox/` as the older 1.x plugin docs say).

---

# APPENDIX D — The biggest architectural mistake: choosing SQLite

## D.1 What happened

Section 4 recommended `better-sqlite3` and it was installed exactly as suggested. It ran
perfectly: the CLI indexed 147 files in 174ms, every test passed, the LSP server ran cleanly over
stdio.

Then, when LSP4IJ started that very same server **inside IntelliJ**:

```
CannotStartServerException: Error while starting language server 'ejsng'
Caused by: Request initialize failed with message:
  The module '.../better-sqlite3/build/Release/better_sqlite3.node'
  was compiled against a different Node.js version using NODE_MODULE_VERSION 115.
  This version of Node.js requires NODE_MODULE_VERSION 137.
```

`npm install` ran under Node v20.20.0 (ABI 115). `NodeLocator` picked the highest version found
via nvm — v24.13.1 (ABI 137). The test machine has **5 versions of Node** installed side by side.

## D.2 Why this is an architectural mistake, not a config mistake

A native module must match the loading Node runtime's ABI **exactly**. The extension **doesn't
control that runtime**:

- **IntelliJ** runs on whatever Node it finds on the machine. JS developers typically have
  multiple versions via nvm/fnm, and the version they're using today isn't necessarily the one
  active when the extension was installed.
- **VSCode** runs the extension inside Electron, with a completely different ABI from plain Node.
  Using a native module there requires `electron-rebuild` for every VSCode version.
- A user upgrading Node by a minor version → the extension dies, with not a single error line in
  the UI.

This is exactly why most VSCode extensions avoid native modules. This was known going in, yet
SQLite was still chosen, because query performance was the only thing considered at design time —
not the distribution path.

## D.3 The fix: NDJSON + in-memory index

`better-sqlite3` dropped entirely. The new store:

- **On disk:** stores only per-file FACTS, as NDJSON, one line per file.
- **No symbols/refs stored:** they're a pure function of the facts (`factsToRows`), so rebuilding
  them on load is cheaper than reading from disk.
- **In memory:** reverse lookup tables by name / by container+name / by kind / by file.
- Write to a temp file then `rename`, so an incomplete file is never left behind.

## D.4 What was lost, what was gained

| | SQLite | NDJSON |
|---|---|---|
| Cold index, 147 files | 174ms | **209ms** |
| Warm start | 14ms | **14ms** |
| On-disk cache | ~250KB | **184KB** |
| Runs on Node v20 | ✅ | ✅ |
| Runs on Node v24 | ❌ breaks | ✅ |
| Cache written by v20, read by v24 | ❌ | ✅ |
| Native modules | 1 | **0** |
| Runtime dependencies | 6 | **5** |

35ms slower over the entire cold-index run. In exchange, the extension actually works.

Extrapolating scale: 147 files → 184KB. A 5,000-file repo → ~6MB of NDJSON, parsed in about 60ms.
Still plenty of headroom. **SQLite was premature optimization for a scale that doesn't exist.**

## D.5 Lesson learned for the rest of the project

For an IDE extension, **the distribution path is a design constraint, not an afterthought.**
Before choosing any dependency, ask: *what runtime will load this on the user's machine, and do I
control that runtime?* If not — don't use a native module.

This also settles the choice in section 6: the **virtual-TS** direction needs `typescript` as a
dependency, but that's a pure-JS package, so it's still safe. Conversely, any intent to use
tree-sitter (a native binding) in the parser layer is now flatly ruled out, for exactly the same
reason.

---

# APPENDIX E — Final confirmation: the plugin runs for real in IntelliJ (2026-09-10 23:43)

After removing `better-sqlite3` (Appendix D), the language server started successfully inside
IntelliJ IDEA Community 2024.2:

```
EJSNG: startup activity chay cho project 'smart-city'
EJSNG: da yeu cau start 'ejsng'

pid 80501: /Users/…/.nvm/versions/node/v24.13.1/bin/node …/packages/server/dist/index.js --stdio
```

No more `CannotStartServerException`, no more `NODE_MODULE_VERSION` error.

The valuable part: the server is running on **Node v24.13.1** — exactly the ABI 137 build that
had broken `better-sqlite3` earlier. The fix was confirmed in the very environment that had
caused the failure, not by dodging to a different Node version.

## E.1 Two adjustments made while running it for real

**`EjsNgStartupActivity`** — LSP4IJ starts the server lazily by default: only when a matching
file is opened. For a server that needs to index the whole workspace before it can answer
anything, that means the first Ctrl+Click has to wait through an entire indexing pass. Added a
`postStartupActivity` calling
`LanguageServerManager.start(id, StartOptions().setForceStart(true).setWillEnable(true))` so
indexing happens while the IDE is still busy with its own indexing.

**The "Trust Project" dialog** — the IDE sandbox stops at this dialog before opening the project,
so the startup activity doesn't run and the log sits idle. Not a plugin bug, but good to know when
running `runIde` on a new project.

## E.2 Verification status per layer

| Layer | Verification level |
|---|---|
| Core (parser, extractor, index, resolver) | 13/13 tests, run against a real repo |
| CLI | indexed 147 files: 209ms cold, 15ms warm |
| LSP server (stdio) | definition + hover correct, runs on both Node v20 and v24 |
| IntelliJ plugin — build | `BUILD SUCCESSFUL` |
| IntelliJ plugin — Plugin Verifier | `Compatible` with IC-242.20224.300 |
| IntelliJ plugin — loads into the IDE | `Loaded custom plugins: … (0.1.0)` |
| IntelliJ plugin — server runs inside the IDE | ✅ pid 80501, no errors |
| **VSCode client** | ❌ **not yet tried** — only a clean TypeScript build so far |

---

# APPENDIX F — Full functional testing, and a bug the user found (2026-09-11)

## F.1 Bug: properties of an ng-repeat variable don't navigate

User report: in `product/view/content.ejs`, `section.id` and `section.enabled` don't jump to
their definitions in IntelliJ. Reproduced exactly:

```
'section'                → ✓ product/view/content.ejs:26 [repeat-var]
'id' in section.id       → ✗ Cannot find 'section' on the scope of '…-view-controller'
```

**Root cause.** In `templateDefinition`, the branch handling local variables only ran when the
cursor sat on the root identifier itself (`onRoot`). When the cursor was on a property after it,
the code fell into the "property on the controller" branch and tried to look up `section` as a
`$scope.section` — which doesn't exist, because `section` is a loop variable.

**Severity: high.** `{{ item.field }}` is the most common expression form in AngularJS templates.
`content.ejs` alone has `section.id`, `section.icon`, `section.label`, `section.enabled`,
`row.docType`, `row.count`… This effectively broke half the extension's value.

**Fix.** The `ng-repeat` element variable now carries a reference to the collection expression:

```ts
locals: Array<{
  name: string;
  span: Span;
  collection?: { root: string; path: string[] };   // ← added
}>
```

When the cursor is on a property of a local variable, the resolver now walks: `section` →
collection `sections` → `$scope.sections` → array shape → element shape → look up the key. The
result jumps correctly into each key in the object literal:

```
'id'      → index.js:33:7   { id: 'knowledge-base', label: …
'label'   → index.js:33:29
'icon'    → index.js:33:54
'enabled' → index.js:33:76
```

An empty array (`$scope.emptyRows = []`) can't have its element shape inferred — this returns a
clear message instead of silently failing, and has a dedicated test.

## F.2 A second gap, found while writing the test matrix

Go-to-definition on a **filter name** (`{{ total | money }}`) had never worked: the filter name
sits inside the expression's span, so the resolver treated it as a property on scope. Added a
dedicated branch that runs before scope resolution, distinguishing Angular's built-in filters
(`currency`, `date`, `orderBy`…) from custom ones.

This gap existed from the start and no test caught it — because the old test suite only checked
the paths already thought of while writing the code.

## F.3 Testing lesson: locate by string, not by column number

While working on this, wrong conclusions about the product were reached **four times** just from
miscounting columns during manual testing: pointing at `id="kbm-file-input"` instead of the
`kbm-file` attribute, pointing into the middle of `data-ng-class=` instead of the expression, and
two off-by-one-column errors with `stats` / `searchForm`.

Added `packages/cli/src/probe.ts`: locates by **string** with `--nth` and `--offset`, and prints
the exact character being pointed at so reading the result doesn't require guessing.

```bash
ejsng-probe views/page.ejs "section.enabled" --offset 8 --root <repo>
```

The `features.test.js` test suite uses this same locating method.

## F.4 Test matrix

`packages/core/test/features.test.js` — 41/41 pass (including `core.test.js`).

| Feature | Fixture | Real repo |
|---|---|---|
| `ng-controller` → controller declaration | ✓ | ✓ (`data-ng-controller`) |
| `ng-click` → function on `$scope` | ✓ | ✓ |
| `ng-repeat` variable | ✓ | ✓ |
| **Property of an `ng-repeat` variable** | ✓ | ✓ (`section.id/.icon/.label/.enabled`) |
| Empty array → graceful fallback | ✓ | — |
| Nested property on `$scope` | ✓ | ✓ (`busy.stats`, `searchForm.query`) |
| `ng-model` → property of a form | ✓ | ✓ |
| **Custom filter** | ✓ | — (the repo has no Angular filters at all) |
| Custom tag → component | ✓ | — |
| Isolate binding on a custom tag | ✓ | — |
| Attribute directive with an inner expression | ✓ | ✓ (`kbm-file`) |
| DI in JS → factory declaration | ✓ | — |
| Find-references JS → template | ✓ | ✓ (33 locations) |
| Scope chain for hover | ✓ | — |
| Completion | ✓ | — |
| EJS locals (Axis A) | ✓ | — |
| Dead code, no false positives | ✓ | ✓ |
| Doesn't mistake `.filter(Boolean)` | — | ✓ |
| A template cut by `<% if %>` still parses cleanly | ✓ | ✓ |

## F.5 VSCode: packaging and verification

`extension.ts` originally pointed to `../server/dist/index.js` via `asAbsolutePath`. This worked
inside the monorepo, but **that path is outside the extension's own folder**, so when packaged as
a `.vsix` it wouldn't be included — an extension installed from the Marketplace wouldn't find the
server.

Added `build.js` using esbuild, bundling the server + `@ejsng/core` + all dependencies into
`dist/server.js` (1.2MB) inside the extension. Bundling was possible only because `better-sqlite3`
had already been dropped (Appendix D) — native modules can't be bundled, and Electron's ABI
differs from plain Node's.

Verified in the Extension Development Host against the real repo:

```
didOpen  → uri: …/product/view/content.ejs, languageId: "ejs"
documentSymbol → server responds in 98ms:
   "ng-controller cityos-demo-dha-management-view-controller" (line 16)
window/logMessage → "EJS/NG: done — 147 files, 24ms"
```

The server runs under VSCode's own Electron runtime (`Code Helper (Plugin)`) — exactly the second
ABI case that would have broken `better-sqlite3`.

---

# APPENDIX G — A second bug found by the user: `sections` doesn't navigate

## G.1 Symptom

`section.id` was already fixed (Appendix F), but the **right-hand side** of `ng-repeat` still
didn't work:

```
data-ng-repeat="section in sections"
                           ^^^^^^^^  → "Position is not inside an Angular expression"
```

Odd, since every other variable in the same file navigated fine.

## G.2 Root cause: a string stored that can't be re-parsed

`TemplateExpression` stores `text` + `span`, and the resolver **re-parses** `text` to find the
node under the cursor. For `ng-repeat`, `text` was stored as the **entire microsyntax string**:

```
text = "section in sections"
```

`in` is not an Angular expression operator, so `tryParseExpression` returns `null`,
`expressionAt` skips it, and the user gets "not inside an Angular expression" — right where
Ctrl+Click is most commonly used.

This is the consequence of an implicit invariant that had never been stated: **the `text` of a
`TemplateExpression` must be re-parseable on its own**. `ng-repeat` violated this without anyone
noticing, because the other branches (`interpolation`, `ngClick`, `ngClass`…) all correctly stored
the actual expression.

## G.3 Fix

`parseRepeat` / `parseOptions` now return a span for each component, and the extractor only
stores the **sub-expression** with its own span, not the whole microsyntax:

```ts
if (rep.collection) {
  pushExpression(rep.collection, sliceOf(value, base, rep.collectionSpan),
                 rep.collectionSpan.start, …);
}
```

The left-hand side (`section`) is the **declaration site**, so it now returns itself instead of
reporting an error.

## G.4 A full sweep instead of spot checks

Two bugs in a row slipped through because testing was done by picking a few positions — and every
one happened to hit paths already thought of while writing the code. Added a new command:

```bash
ejsng sweep --root <repo>
```

It tries to resolve **every root identifier and every property segment** in every expression of
every template, then reports coverage. Result on `smart-city`:

```
Total positions tried : 405
Resolved               : 397
Built-in variables     : 8   ($event, $index… — no definition, not an error)
Remaining gaps         : 0
Coverage               : 100.0%
```

This very command went on to catch the third bug below.

## G.5 A third bug, found by the sweep: `$event`

8/405 positions reported "not found on scope" for `$event` — a variable Angular injects
automatically into every statement-type directive (`ng-click`, `ng-keydown`…). Not a scope
property, and **not a bug**.

If diagnostics were enabled, every handler using `$event` would be flagged red — exactly the kind
of false positive that gets an extension disabled on day one.

Added `NG_INJECTED_VARS` and a `builtin` flag on `DefinitionResult`; diagnostics now skip these
cases. The flag also applies along property paths: `$event.keyCode` is also built-in, not just
`$event` alone — a spot missed on the first pass, also caught by the sweep.

---

# APPENDIX H — Plain JavaScript navigation (2026-09-11)

## H.1 User report: no declaration found for any variable in `index.js`, not even `window`

Correct. `jsDefinition` originally did only two things: look up Angular declaration names, and
look up quoted strings. **There was no resolution of plain JavaScript variables at all** —
`const SERVICE_ID` declared right on line 16 wasn't found by Ctrl+Click on line 88.

## H.2 Why this can't just be "let the IDE handle it"

In VSCode, the built-in TypeScript language server would normally handle plain JS. But
**IntelliJ IDEA Community has no JavaScript plugin** (Appendix B) — on that edition, this
language server is the **only** source of answers for `.js` files. If it doesn't do this itself,
nothing does.

## H.3 What was added

**`extract/bindings.ts`** — extracts declarations along with their scope, following correct
JavaScript semantics:

| Kind | Scope |
|---|---|
| `var`, `function` | the enclosing function (or the whole file) |
| `let`, `const`, `class` | the enclosing block |
| function parameters | that function itself |
| `catch` parameter | the catch block |

Resolution picks the **narrowest enclosing scope** for the position — following JavaScript's
correct shadowing rules. Supports destructuring too (`{a, b: {c}}`, `[x, ...rest]`, default
values).

**Priority order in `jsDefinition`:**

1. `$scope.foo` / `this.foo` → a property on the enclosing controller's scope
2. An injected (DI) name → **the Angular declaration first**, then the function parameter
3. An Angular declaration with the same name
4. A plain JavaScript declaration, by scope
5. A cross-file global (like a `<script>`-tag style global)
6. A built-in global variable → flagged `builtin`, **not an error**
7. A quoted string → a controller name / event name / view name

Point 2 is a deliberate choice: lexically, `aocs` in `function($scope, aocs)` is a function
parameter — but what the user actually wants to see is `.factory('aocs')`. Both are returned,
Angular first.

**Cross-file globals.** In an Angular 1 codebase loaded via `<script>` tags, a file-scope
declaration really is a global: `DHA_STATUS` is declared in `dha.const.js` and used in
`dha.controller.js`. File-scope declarations are now emitted as `js-global` symbols, visible from
other files.

**ES module parsing.** `dha.const.js` uses `export const`. `parseJsTolerant` used to always parse
with `sourceType: 'script'`, so it broke immediately on `export`, falling back to the
loose/tolerant parser and producing very poor bindings. It now auto-detects module syntax.

## H.4 Measured with the sweep, not guessed

`ejsng sweep` now also scans `.js` files, using the AST to grab **the identifier at the reference
position**.

The first pass measured with regex and got "49.4%" — that number was **completely wrong**,
because the regex counted keywords (`const`, `return`) and object-literal keys (`{ word: 1 }`)
into the denominator. This is exactly the kind of error that leads to wrong conclusions about the
product; switched to going through the AST instead.

| | Before | After |
|---|---|---|
| Whole repo | 97.3% | **99.2%** |
| `product/view/public/javascripts/index.js` | 5 gaps / 511 | 5 gaps / 511 |
| Templates | 100% | 100% |

## H.5 136 remaining gaps — and why NOT to chase 100%

The largest group is `isNull` (41 occurrences). Searched the whole repo: **no declaration
anywhere.** This is either a global provided by the platform at runtime, or an actual bug in the
codebase — not a tool error.

This is exactly what the diagnostics feature exists to catch. Forcing every identifier to
"resolve" would destroy that value. The rest are variables in files outside the indexed scope
(`web/js/old/utilities` has no `.js` extension) and a few third-party library globals.

---

# APPENDIX I — Rename, shape-based completion, and two gaps exposed while building them (2026-09-11)

## I.1 Rename: changing `$scope.foo` consistently across every template

Seam chosen for testing by the user: the **Workspace API** (`prepareRenameAt`, `renameAt`) **and
the LSP over stdio** (`packages/server/test/lsp.test.js` spins up a real server and speaks
JSON-RPC like an IDE would).

| Where it's changed | How it's found |
|---|---|
| JS — every occurrence of `s.foo`, **both reads and writes** | AST scan at rename time. `scopeMembers` only keeps the first assignment: `index.js` has 169 occurrences of `$scope.x` but only 66 assignments |
| Template — the root of the expression | Re-extract facts from the current content, filtered by the enclosing controller |
| Template — attribute values resolved by the Linker | Goes through `linker.resolveCandidates` itself (`pick-file="onPick($file)"`, `data="form"`) |

Principle: **any conflict at all means the whole rename is refused** — a half-done rename is
worse than no rename. Refusal always comes with a reason, and the server returns a
`ResponseError` rather than `null`, so the IDE can display the reason:

- the new name isn't a valid identifier, is a keyword, starts with `$`, or matches the old name
- the new name is already used on scope (JS already accesses `s.<new name>`, or a template already
  uses it)
- the new name is **shadowed** by an `ng-repeat` variable at some usage site (`busy` → `row` in
  `<li ng-repeat="row in rows">`)
- the property is only **read**, never assigned, in the controller — it might be inherited from a
  parent scope
- a template's local variable, a built-in component (`$on`, `$event`), `controllerAs`, or a
  nested property
- the span doesn't point exactly at the old name (i.e. a Layer 2 bug) — refuses rather than
  corrupting the file

**Edits are computed against the current content, not the fact index.** The index can be older
than the file, and a rename that's off by even one character corrupts the user's code.

### Controllers declared with the same name in multiple files

`smart-city` has `cityos-demo-dha-management-view-controller` in both `product/…/index.js` and
`new-version/fe-be/index.js`, each paired with its own template. Go-to-definition returning both
is harmless; rename writes to files. **The user chose: group by nearest directory.**

`renameScope()` pairs each template with the `.js` file sharing the deepest common directory, then
renames only the **group** containing the starting point. When a template's directory distance is
tied between the two, both copies get pulled into the same group — renaming one would break the
template for the other — this spreads until it stabilizes; if everything gets pulled in, everything
gets renamed, and it's reported.

Measured on `smart-city`, cross-checked against an independent grep count:

| Starting from | Changed | Left unchanged |
|---|---|---|
| `product/…/index.js` | 44 JS + 25 template = 69 | `new-version/fe-be/index.js` |
| `new-version/fe-be/index.js` | 28 JS + 8 template = 36, **plus a warning for 8 spots** (section I.3) | `product/…/index.js` |

Round-trip test: apply the 69 edits to the overlay and re-link the index — every expression root
in the template still resolves.

## I.2 A bug exposed while building rename: every span inside an attribute value was off by one character

Rename needs **absolutely exact** spans, and that's when the bug surfaced. `angular-html-parser`'s
`valueSpan` starts **at the quote character** (`x="v"` → points at `"`); without quotes it starts
at the value itself. The code was taking `valueSpan.start.offset` directly as the base offset.

| | Expressions off by one |
|---|---|
| `smart-city` | 146/211 — every expression inside an attribute; `{{ }}` in a text node was fine |
| fixture | 4/7 |

Why navigation didn't catch this across eight previous appendices:

- `inSpan` checks **both endpoints inclusively**, so placing the cursor on any character of the
  name still "hit" the shifted span.
- `sweep` probes at exactly `root.span.start` — shifted in the same direction as the span, so it
  still resolved.

Affected: the `ng-controller` name, attribute values handed to the Linker, `{{ }}` inside an
attribute, and the find-references locations shown to the user (highlighting shifted onto the
quote character).

Fix: `valueStartOf()` now only adds `+1` when the first character is a quote. **`PARSER_VERSION`
10 → 11.** Added a fifth invariant, with its own test (`spans.test.js`: 405 violations before the
fix → 0):

> **Every span in a template fact must point exactly at the text it represents**:
> `source.slice(span) === text`.

`sweep` after the fix stayed the same (99.2%, 136 gaps, as in Appendix H) — the fix didn't
regress anything.

## I.3 A blind spot in `sweep`: it only counts what the extractor actually found

"100% for templates" in Appendix G means 100% **of the expressions that were successfully
extracted**. Expressions the extractor missed entirely never enter the denominator.

Rename exposed this: `new-version/fe-be/content.ejs` has 16 occurrences of `busy`, but only 8 were
extracted. Counted by line: **21/88** lines containing `data-ng-*` or `{{` produced no expression
at all.

Cause: the file is indented using **U+2003 (EM SPACE)**. A header comment in the
`product/view/content.ejs` version mentions this, along with the claim "HTML treats it as
whitespace so it still works." That claim is **wrong** — verified from both sides:

- **Browser:** Chrome's `DOMParser` returns an attribute literally named `"  data-ng-disabled"` —
  the U+2003 ends up **inside the name**. Per the HTML tokenizer spec, only tab/LF/FF/space count
  as whitespace inside a tag, so AngularJS can't normalize that name into `ngDisabled`.
- **AngularJS 1.8.3:** `Lexer.isWhitespace` only accepts space, `\r`, `\t`, `\n`, `\v`, ` `.
  A `{{` expression containing U+2003 throws a lexer error at runtime.

In other words, those 21 lines in the new-version copy **never ran as a directive at all**. The
extractor is behaving exactly like the runtime — this isn't an extension bug, and shouldn't be
"fixed" to extract them.

Rename doesn't guess, it **reports**: `unparsedOccurrences()` scans regions that look
Angular-like (an attribute value containing `ng-`, or inside `{{ }}`), lists any spot still
containing the old name that wasn't renamed, and suggests U+2003 as the cause if that character is
present on the line.

**Lesson:** coverage measured against a tool's own output has a denominator the tool itself
controls. To find out what's actually missing, you need an **independent** source — here, grep.

## I.4 Shape-based completion

Typing `{{ busy.` produces an expression that **fails to parse**, and the extractor drops it
entirely: the scope chain is lost, with no way to know what the user is typing after. The
approach: insert a fake identifier (`__ejsngCursor__`) at the exact cursor position and re-extract
just that file. The expression becomes valid, and the surrounding `ng-repeat` context is
preserved:

- if the tail of the property chain contains the fake identifier → the user is typing after a
  dot → walk the shape
- if the root is an `ng-repeat` variable → go into the **element** of the collection
  (`section.` → the keys of an element in `sections`)
- otherwise → suggest root identifiers following the scope chain at that position

On `smart-city`: `busy.` → exactly the 9 keys of the object literal at `index.js` line 53;
`section.` → `id`, `label`, `icon`, `enabled`. `shapeOf()` was extracted so navigation and
completion look up shapes in exactly the same way.

## I.5 A self-inflicted mistake: `String.prototype.replace` and `$'`

A code-fixing script used `s.replace(from, to)` where `to` contained a value
`startsWith('$')`. In a replacement string, `$'` is a special pattern meaning "insert the rest of
the original string" — `workspace.ts` ended up with the entire trailing portion duplicated
(11,655 characters inserted). That code hadn't been committed yet, so git couldn't help; it had
to be reconstructed by computing lengths (the corrupted file = the part before + the start of the
replacement string + the tail + the end of the replacement string + the tail again) and
cross-checking each segment before writing.

From then on, every replacement command uses the function form: `s.replace(from, () => to)`.

## I.6 Known limitations

- **`controllerAs`:** rename refuses it (the real repo has 0 usages); the `this.foo` side in JS
  isn't scanned yet.
- **Keys inside `angular.extend($scope, {…})`** and aliases reassigned after declaration
  (`vm = $scope`): not renamed. Aliases declared directly (`var vm = $scope`) and
  `$scope['busy']` are handled (I.7).
- **Renaming a nested key** (`busy.search`): not implemented — would require renaming both the
  key in the object literal and every path leading to it, and is easy to confuse with another
  object that happens to share the same key name.
- **Strings inside `$watch('busy.search', …)`:** not renamed. `smart-city` only uses the function
  form.
- **Completion inside `.js` files** (`$scope.busy.`): not implemented.
- **Completion still merges every copy** of a same-named controller. Go-to-definition already
  uses the nearest-group approach like rename does — see Appendix K.
- **VSCode with `.js` files:** the built-in TypeScript server also offers rename, and VSCode may
  query that provider first. Not yet checked inside a real IDE — the stdio test only confirms the
  server itself returns the correct result.
- ~~**Server ignores `workspace/didChangeWatchedFiles`**~~ — **fixed, see Appendix J.** Files
  changed outside the editor (git pull, checkout) now enter the index as soon as the client
  reports it, on both VSCode and IntelliJ.

## I.7 Pre-commit review: four bugs, fixed with regression tests

Ran `/code-review` (built-in) over the whole session's changes, as the handoff recommends. All
four were real bugs in this session's own code; each has a reproducing test, red before the fix.

| Bug | Consequence | Fix |
|---|---|---|
| Rename on the JS side only recognized `s.foo` | `var vm = $scope; vm.busy` and `$scope['busy']` were missed with no warning — JS kept writing the old name while the template had already switched to the new one | Now also recognizes aliases declared directly from `$scope` and bracket-string access |
| The "remaining gaps" warning only excluded the spots that were renamed | Falsely flagged `busy` from a different controller, `ng-repeat` variables, and keys inside `ng-class` as "couldn't be understood" — nudging the user to hand-edit spots that must not be touched | Now excludes every region the extractor actually parsed: expressions, local-variable declaration sites, and attribute values the Linker understands |
| The "must have an assignment" check ran against every copy | The nearest copy only reads `foo` (inherited), while another copy assigns it — the nearest copy's template still got renamed | Now checks only against the files that will actually be edited |
| Always sent `renameProvider: { prepareProvider: true }` | Violates LSP 3.17 for a client that didn't declare `prepareSupport` | Only sent when the client declares it; otherwise sends `true` |

---

# APPENDIX J — Files changed outside the editor: `workspace/didChangeWatchedFiles` (2026-09-11)

## J.1 Symptom

The server had no handler for `workspace/didChangeWatchedFiles`. Files changed outside the editor
(git pull, checkout, another tool) only entered the index when a re-index command was run
manually — go-to-definition, references, and completion used stale facts. Rename was unaffected
since it always re-extracts from the current content (I.1).

Reproducing test: add `s.moi = 1;` to a controller **on disk**, have the client report the
change, and confirm definition from `{{ moi }}` in the template still returns `null`.

## J.2 LSP4IJ doesn't send this on its own — the server must register dynamically

LSP4IJ's `LSPSupport.md` only marks ✅ for `workspace/didChangeWatchedFiles`, without explaining
the mechanism. Reading the `0.21.0` tag's source:

| Location | Finding |
|---|---|
| `ClientCapabilitiesFactory.java:77` | Declares `didChangeWatchedFiles: { dynamicRegistration: true }` — **does not** declare `relativePatternSupport` |
| `LanguageServerWrapper.registerCapability` | Handles `client/registerCapability` for `workspace/didChangeWatchedFiles`, loading `watchers` into `FileSystemWatcherManager` |
| `AbstractLSPFileListener.isMatchFilePatterns` | `if (uri == null \|\| !hasFilePatterns()) return false;` — **no registration means no events sent at all** |
| `AbstractLSPFileListener.after()` → `LSPFileListener.onFileCreateAfter` / `onFileDeleteAfter` | Each VFS create/delete event is matched against **its own URI only**, without descending into it |

⇒ On IntelliJ, the server **must** register via `client/registerCapability`, and only when the
client declares `workspace.didChangeWatchedFiles.dynamicRegistration` (LSP 3.17). VSCode already
sends this thanks to `synchronize.fileEvents` in `extension.ts`; `vscode-languageclient` 9 also
declares `dynamicRegistration` + `relativePatternSupport`, so it also picks up the server's own
watcher.

The last row of the table is the trap: when the VFS reports a create/delete **at the directory
level** (a git checkout adding or removing an entire directory, `rm -rf`), the URI is the
directory's own — it doesn't match `**/*.js`, so no event fires at all. Because of this, the
server registers two kinds of watchers:

| Watcher | `kind` | Why |
|---|---|---|
| Each glob in `include` | Change | Only indexed files need this |
| `**/*` | Create \| Delete | Catches directory-level events |

Glob form: a `RelativePattern` anchored to the workspace root when the client declares
`relativePatternSupport` (VSCode); a plain string otherwise (LSP4IJ — `PathPatternMatcher` anchors
relative globs to the project directory itself).

## J.3 Design: `Workspace.refreshFiles(paths)`

- **The index is the "disk" layer; overlays are untouched.** An open buffer remains the source of
  truth for that file (`facts()`/`source()` read the overlay first). But the index **still**
  updates from disk even for open files. The option "ignore open files" was considered and
  rejected: VSCode silently reloads an unmodified buffer when a git pull changes the file — new
  overlay, stale index, and another template wouldn't see that controller's new property until the
  user saves it (and a clean buffer gives nobody a reason to save).
- **Don't trust the event type** (Created/Changed/Deleted) — `stat` gives the real state. Events
  can be coalesced, duplicated, or arrive out of order; VSCode even sends duplicates from both its
  static and dynamic watchers.
- **Compare hashes, not mtimes** — unlike `index()`. A file reported as changed has to be read
  anyway, and mtime can stay identical (`rsync -t`, `tar`, `cp -p`; HFS+'s 1-second resolution).
  This is also why events aren't routed straight into `index()`: it skips files whose mtime
  matches.
- **New files → `index()`**, since only `index()`'s glob correctly applies `include`/`exclude`.
  Before that, `exclude` is filtered using **fast-glob itself** against just that one path — a
  file: a static path; a directory: only walking the `dir/**` subtree — so events under
  `node_modules`, `dist`… don't trigger a re-scan. No custom glob logic, no new dependency.
  (fast-glob's static directory check returns `[]` for names containing `(` or `[`, as if
  excluded — walking `dir/**` handles this correctly.)
- **Deletion:** a path already in the index → removed; a path not a file in the index → treated
  as a directory, removing every file with prefix `dir/`.
- Finally, `link()` is called once, and only if something actually changed.

The extractor didn't change ⇒ **`PARSER_VERSION` stays at 11**; Layer 2 facts remain a pure
function of a single file's content.

## J.4 Measured on `smart-city`

Store `:memory:`. Measurements involving file edits ran on a **copy** in a temp directory (no
`node_modules`, no `.git`) — the real repo is read-only.

| Operation | Median |
|---|---|
| Warm `index()`, real repo (147 files) | 7.1ms |
| Warm `index()`, copy | 3.3ms |
| `refreshFiles`: 1 file changed (`index.js`, 511 identifiers) | 4.8ms |
| `refreshFiles`: reported changed but content identical | 0.09ms |
| `refreshFiles`: 1 new file (→ `index()`) | 4.0ms |
| `refreshFiles`: file + new directory inside `node_modules` | 0.24ms, no re-scan |

At 147 files the two approaches are roughly equal. They diverge in how they scale: `index()`
scales with the **total number of files** (glob + `stat` per file), while `refreshFiles` scales
with the **number of changed files**. And `index()` compares mtime, so it's wrong in the case
where mtime is unchanged.

`sweep`: 99.2%, 136 gaps — unchanged. Every line of `sweep`'s output matches the previous version
exactly (compared on the copy).

## J.5 Tests

Stdio (`packages/server/test/lsp.test.js`) and core (`packages/core/test/refresh.test.js`). All
seven tests were red when run against the build **before** the fix, and green after.

| Test | Checks |
|---|---|
| `.js` changed on disk + reported → definition reaches `moi` | The base requirement; with a control: still `null` before the report |
| A file gets deleted | Hover no longer points at the deleted file; `stats.files` drops by 1 |
| A whole directory created/deleted in one event | LSP4IJ-style; a new directory under `dist/` is excluded |
| An open file changes on disk | The buffer wins: an offset in the buffer still points correctly at `moi`, not falling into `total` |
| Watcher registration | LSP4IJ-style → string glob; VSCode-style → `RelativePattern`; not declared → no registration |
| (core) mtime unchanged | The hash still catches the change |
| (core) a new file is excluded | No full re-scan triggered |

**A test race, fixed:** the server indexes synchronously right when it receives `initialized`,
while the test edited the file right after sending `initialized` — which could run **before** the
index, causing the index to read the already-updated content directly. This exact bug made the
"buffer wins" test pass falsely on the unfixed build, the first time it ran. `startServer` now
waits for one request after `initialized`: since the server processes things sequentially, a
response confirms the initial index has already finished.

## J.6 Known limitations

- **VSCode receives duplicate events** from both the static watcher (`synchronize.fileEvents`) and
  the server's dynamic one. `refreshFiles` is idempotent so this is harmless — in real usage, each
  file change produces just one `1 file doc lai` log line (J.7), and duplicates within the same
  batch get merged. The static watcher could still be dropped.
- **The `**/*` (Create \| Delete) watcher also reports unrelated files** (`.git/index.lock`…):
  each such event costs one `stat` before being discarded.
- **A file matching the extension but not `include`** (e.g. `.eslintrc.js` — `dot: false`)
  triggers a full `index()` every time it changes. There's no "out of scope" cache keyed by path:
  files created/deleted interleaved during a scan would make such a cache wrong, and being wrong
  means the file gets skipped until restart.
- **`index()` runs synchronously:** a checkout that changes thousands of files will block the
  server while scanning, just like at startup.
- ~~The LSP server never calls `workspace.close()`, so the NDJSON cache is only ever written by the
  CLI.~~ **Fixed 2026-09-19:** the server writes the cache on LSP `shutdown`, so the next IDE start
  is warm (a killed server still starts cold); `.ejsng-cache/` holds its own `.gitignore` (`*`) so
  it never shows up in the user's `git status`. Still open: `didChangeConfiguration` is still registered dynamically without checking the
  client's capability, the same class of bug as `prepareSupport` in I.7.

## J.7 Running for real in both IDEs (2026-09-12)

Same measurement method in both: open `smart-city`, edit `dha.controller.js` (60KB, **not** open
in the editor) from outside, and watch the server process.

### IntelliJ — `runIde` sandbox, LSP4IJ 0.21.0

| Point | Server process CPU time |
|---|---|
| idle 12 seconds, untouched | 0:01.12 |
| idle another 12 seconds | 0:01.12 |
| 12 seconds after the on-disk file change | **0:01.19** |
| idle another 12 seconds | 0:01.19 |
| after restoring 2 files and **deleting** 1 | **0:01.28** |

Idle for 24 straight seconds, spends 70ms right after the file change, then goes idle again —
nothing else wakes it up. The chain VFS → LSP4IJ → `didChangeWatchedFiles` → `refreshFiles` runs
for real, exactly as read from the source. The deletion path also arrives correctly.

Couldn't cross-check the **file count** directly in IntelliJ: `window/logMessage` only goes into
LSP4IJ's own console (`ServerMessageHandler.logMessage` → `LSPConsoleToolWindowPanel`), not into
`idea.log`, so a script can't read it — had to open the **Language Servers** tool window and look
manually.

### VSCode — Extension Development Host, 1.136.2

VSCode writes its Output channel content to disk, so the server's log lines can be read directly
from
`~/Library/Application Support/Code/logs/<session>/window<N>/exthost/output_logging_*/`:

```
EJS/NG: bat dau danh index...
EJS/NG: xong — 0 file moi, 147 khong doi, 4 ref noi them, 158ms
EJS/NG: file doi ngoai editor — 1 file doc lai, 0 file go, 31ms
EJS/NG: file doi ngoai editor — 1 file doc lai, 0 file go, 22ms
```

The last two lines are the two edits made outside the editor (change, then revert): each reload
reads **exactly one** file, 31ms and 22ms — matching what was actually done. CPU shape was the
same as on IntelliJ: 0:00.22 flat for the whole 24-second idle period, +70ms after the change,
+40ms after reverting it.

The second line is notable for a different reason: this is a **warm** start — 147 files
unchanged, 158ms — thanks to the NDJSON cache the CLI's `ejsng sweep` had written earlier. At the
time the server itself didn't write the cache (J.6), so inside the IDE it could only warm-start if
someone had run the CLI first — since fixed, the server now writes it on `shutdown`.

And one more thing Appendix D's fix pays off again: the server runs under VSCode's own
**Electron** (`Code Helper (Plugin)`) and under **Node v24.13.1** in IntelliJ — two completely
different ABIs, using the exact same bundle, with no separate build needed for either.

---

# APPENDIX K — Go-to-definition: one target instead of a picker list, and `confidence` meaning what it says (2026-09-12)

## K.1 The user's question

"I see `confidence` and multiple options in the plugin; with multiple options, does navigation
even work? Why does the extension jump straight there — or is VSCode just better at tracking
this?"

It's not that VSCode is better: **both IDEs share the same server**, the same `definitionAt`. The
difference is in two places. First, client UI — with one target both jump straight there; with
multiple targets IntelliJ pops up a picker while VSCode opens a peek view. Second, in `.js` files
VSCode also has its built-in TypeScript server answering in parallel and merging results from
every provider; IntelliJ Community has no JavaScript plugin, so this server is the sole source of
answers for both `.js` and `.ejs`.

## K.2 Measured before the fix (templates in `smart-city`)

| | |
|---|---|
| Positions resolved | 244 |
| Returning **2 targets** | 168 (68.9%) |
| `confidence` counted per target: `medium` / `high` | 358 / 54 |

All 168 spots share one cause: the controller
`cityos-demo-dha-management-view-controller` is declared in both `product/…/index.js` and
`new-version/fe-be/index.js` (I.1 already ran into this while doing rename). No spot mixed
different `kind`s.

## K.3 Preferring the nearest-directory copy

`preferNearest()` reuses rename's `nearestFiles()`, so **definition and rename now group things
the same way** — the user doesn't have to remember two different rules.

Two guardrails, each with its own test:

- **Only merge when every target shares the same `kind`.** `jsDefinition` deliberately returns
  both an Angular declaration and a function parameter of the same name (H.3); these are
  different kinds, and dropping either would be wrong.
- **A tie keeps both.** If a template is equidistant from both copies, there's no way to decide,
  and when you can't decide, you shouldn't guess.

A discarded target doesn't vanish: `DefinitionResult.otherFiles` carries them through to hover and
the CLI.

**Result: 244/244 positions now resolve to exactly one target** — no more picker popups in either
IDE.

## K.4 `confidence` was lying

```ts
confidence: walked.span ? m.confidence : ('medium' as const),
```

This line downgraded confidence to `medium` any time the resolution **didn't walk into a shape**
— including `{{ total }}`, which has no property path to walk in the first place. The real symbol
is `high` (`rows.ts`). As a result 358/412 targets showed "confidence: medium" in hover — exactly
what the user saw in IntelliJ, and it misrepresented the product: readers assumed the tool wasn't
sure, when it actually was very sure.

Fixed to `walked.partial ? 'medium' : m.confidence`. Now `medium` means exactly one thing: **the
key being asked about couldn't be reached, so it jumped to the closest approximation instead** —
for example `$scope.stats = fetchStats()` followed by a question about `stats.total`. After the
fix, 244/244 targets are `high`.

## K.5 Verification (a) and (d)

- `npm test`: 92/92.
- Two new behavior tests were **red** on the pre-fix build (including a test against the real
  repo). The other two are guardrails (keep both on a tie; don't merge different-kind DI results)
  so they're **green on both versions** — exactly their job: making sure this fix didn't break
  something that was already correct.
- `sweep`: 99.2%, 136 gaps, output identical line-for-line to before the fix. Filtering out
  targets doesn't change whether a position resolves at all.

## K.6 Completion now also takes only the nearest copy

`membersOf(controller, from)` and `memberCompletions()` share `nearestRows()` with definition.

Measured on `smart-city`, with the same controller declared in two branches:

| Template | Before | After |
|---|---|---|
| `new-version/fe-be/content.ejs` | 43 names | **31 names** |
| `product/view/content.ejs` | 43 names | 43 names — this copy is the superset |

12 names disappeared from the `new-version` branch — `uploadForm`, `documents`, `docStorage`,
`onFilePicked`, `loadDocuments`, `uploadDocument`… — properties that exist **only in the `product`
copy**. Previously these were still suggested while typing in the `new-version` template: picking
one meant writing an expression that would never have a value, with nothing to warn about it. This
is a worse kind of error than "missing a suggestion," because it looks confirmed.

## K.7 Hover: paths turned into clickable links — confirmed working in IntelliJ

After definition started filtering targets down, hover became the **only** place that still
points at the far-directory copy — so it needed to be clickable. Real hover output on
`smart-city`, obtained by speaking JSON-RPC directly to the server:

```
**sections**
- scope-member 'sections' of cityos-demo-dha-management-view-controller — [product/view/public/javascripts/index.js:32](file:///…/index.js#L32)
- _1 more copy in a further directory:_ [new-version/fe-be/index.js](file:///…/new-version/fe-be/index.js)
```

Three pieces in LSP4IJ 0.21.0's source match this link format:

| Location | Content |
|---|---|
| `LSPDocumentationLinkHandler` | Catches `url.startsWith("file://")` and calls `LSPIJUtils.openInEditor` — opens in the **IDE's own editor**, not thrown out to a browser |
| `openInEditor` javadoc | Supported syntax: `file:///…/foo.txt#L1:5` |
| `LSPIJUtils.toPosition` | `int line = toInt(0, positions) - 1; // Line numbers should be 1-based` |

The last row was the most worrying, and turned out fine: LSP4IJ counts lines **starting from 1**.
On the VSCode side, `extractSelection` in `workbench.desktop.main.js` reads the fragment using
`/^L?(\d+)(?:,(\d+))?(-L?(\d+)(?:,(\d+))?)?/` — the same convention. One link string works
correctly on both IDEs, with no line-number offset.

**Run for real (2026-09-12):** `./gradlew buildPlugin` (9 seconds, mostly cache-hit) then
`runIde`, with `EJSNG_SERVER_PATH` pointed at the worktree's server build. Sandbox log:

```
Loaded custom plugins: LSP4IJ (0.21.0), EJS + AngularJS Navigator (0.1.0)
EJSNG: startup activity chay cho project 'smart-city'
pid 44893  …/node/v24.13.1/bin/node  …/packages/server/dist/index.js --stdio
```

Clicked it by hand in the IDE: **the link opens the right file, at the right line** — even for the
link to the far-directory copy, the one go-to-definition had already filtered out of its jump
list. The loop closes: filtering trims the list down, but the path to the other copy isn't lost.

The server is still running under Node v24.13.1 — the exact ABI 137 build that once broke
`better-sqlite3` in Appendix D.

## K.8 Verification, and what's still open

- `npm test`: 95/95. Three new tests (two for completion, one for hover over stdio) were all
  **red** on the pre-fix build; the other 13 tests stayed green on both versions.
- `sweep` unchanged — completion and hover aren't part of the coverage measurement.
- **IntelliJ: clicked by hand in the real IDE** — the link opens the right file, right line (K.7).
  **VSCode: clicked by hand in the Extension Development Host (2026-09-12)** — hovering
  `sections` at line 13 of `new-version/fe-be/content.ejs`, clicking the link
  `product/view/public/javascripts/index.js:32` jumps to the correct file and line. Both IDEs
  confirmed by hand — Appendix K has nothing left open.

---

# APPENDIX L — A pre-handoff review: four bugs, fixed with tests (2026-09-12)

Ran `/code-review` (built-in) over the whole session's diff, as I.7 did before its own commit.
Four findings, all real bugs in this session's own code; each has a test that was red before the
fix.

| Bug | Consequence | Fix |
|---|---|---|
| A `catch` around `statSync` treated **every** errno as "file deleted" | On a repo living on an external volume (`/Volumes/…`): a single `EACCES` or `EIO` would silently drop an existing file from the index — unnoticed until the next re-index | Only `ENOENT`/`ENOTDIR` mean "deleted"; any other errno means *unknown*, and the path is skipped |
| `fast-glob` defaults to **throwing** on error (`suppressErrors: false`) | One unreadable directory would make `refreshFiles` throw **before** `upsertBatch` ran → the entire batch of valid changes in that notification was lost | `suppressErrors: true` in both `hasCandidates` **and** `index()` — the same gap existed in both |
| `detail` printed the full **requested** path even when the shape was only partially resolved | Hover said `row.a.b — element of rows` while actually landing on `a`: the reader assumed key `b` genuinely existed | `detail` now names only the segment actually **reached**, matching the confidence level that was just downgraded to `medium` |
| Scanning the entire index's prefixes for **every** stray deleted path | The `**/*` watcher also reports non-indexed files; `rm -rf` sends thousands of events → O(number of paths × number of indexed files), stalling the server right after a checkout | Deleted directories are batched, and `stamps` is scanned **once** for the whole batch |

The first two bugs share one root cause: **treating filesystem errors as if they only ever have
one cause, "the file vanished."** In a feature whose entire input is disk events, that's the wrong
assumption to make. Both were verified with `chmod 000` in a temp directory — `statSync` and
`fg.sync`, for both the static-file and `dir/**` forms, both throw `EACCES`, confirmed by hand
before writing the test.

Fixing the fourth bug brought along an improvement not part of the original review: an event
reporting a directory that **still exists** (recreated by the client, or renamed into place) used
to drop every file under it and let `index()` add them all back from scratch. Now, if the
directory still exists, it's simply re-scanned without dropping anything — no more re-parsing the
entire subtree, and no more incorrect `removed` counts in the log.

And one accusation that was **overturned during the fix**: the review claimed both places that set
`confidence` printed a misleading label. On closer reading, the branch for a property on
`$scope` was already using `fullPath.slice(0, walked.depth + 1)` — correctly naming the segment
actually reached. Only the `ng-repeat`-variable branch printed the full requested path, so only
that one needed fixing. Reviewing carefully means also re-reviewing the review itself.

---

# APPENDIX M — Splitting definition resolution out of Workspace (2026-09-13)

## M.1 Why

`/mattpocock-skills:improve-codebase-architecture` scanned the architecture and found
`workspace.ts` had grown to 1465 lines — 3x the size of the second-largest files
(`template.ts`/`js.ts`, ~490 lines each). The Explore subagent applied a **deletion test** to each
block in the file: deleting `walkShape`/`shapeOf`/`candidateDefinition` (at that point lines
670-883) from `workspace.ts` made the complexity **disappear entirely** — it didn't move
elsewhere, because that block only reads through `this.facts()`/`this.store`, never touching
overlays/watchers. By contrast, deleting rename orchestration (962-1204) left the complexity
**stuck in place**, not naturally flowing into `rename.ts` — a signal that it needs `Workspace`'s
own state, and isn't ready to be split out yet (saved for a later round).

## M.2 Design (settled via `/grilling`)

- **`packages/core/src/resolve/definition.ts`** (449 lines) — `resolveDefinition(deps, relPath,
  offset)`: dispatches to `templateDefinition`/`jsDefinition`, along with `candidateDefinition`,
  `declarationAround`, `symbolTargets`. Does NOT include `preferNearest`/`nearestRows` (the
  "nearest copy" filtering) — that remains `Workspace.definitionAt`'s job, called after the raw
  result comes back.
- **`packages/core/src/resolve/shape.ts`** (65 lines) — `walkShape`, `shapeOf`, `shapeAtPath`.
  Kept separate from definition because **completion shares it too**
  (`Workspace.memberCompletions` calls `shapeOf`) — folding it into definition would make
  completion depend on it backwards.
- **`FactSource`** (defined in `shape.ts`) — a narrow interface: `facts()`, `source()`,
  `findSymbols()`, `moduleAliases`. `Workspace implements FactSource`, passing `this` into the two
  modules above instead of them holding the whole class.
- `inSpan`, `wordAt`, `ANGULAR_DECL_KINDS`, `expressionAt` **stay** in `workspace.ts` (exported)
  since they're shared with `referencesAt`/rename/`completionAt` — `definition.ts` imports them
  back. This is a circular import (CommonJS-style) but safe: both sides only call each other
  inside function bodies, never at module top level, so initialization order never collides.
  `depthAt`, `isMemberOfScopeObject`, `quotedStringAt` are used only by
  `jsDefinition`/`templateDefinition` — moved over outright, no back-import needed.

Documented the two terms **Definition Resolution** and **Shape Walking** in `CONTEXT.md` (newly
created — the repo had no glossary before this).

## M.3 Result (candidate A)

`workspace.ts`: 1465 → 1003 lines. No behavior change — every existing test calls through the
public `definitionAt`/`membersOf`, never touching private methods directly, so no test needed
changes:

```
npm test                                                              # 99/99, unchanged
node packages/cli/dist/index.js sweep --root .../smart-city           # 99.2%, 136 gaps, unchanged
```

Extra cleanup found during review: the old `symbolTargets` in `workspace.ts` was leftover dead
code (forgotten when it was split out to `definition.ts` — nobody calls it anymore; `tsc` didn't
flag it because it's a private method sharing a name with an exported function in a different
file, not a same-scope identifier collision).

## M.4 Candidate C — a dedicated interface for "prefer the nearest copy"

`nearestRows`/`preferNearest` turned out to **already be pure** (never touching `this` despite
being declared as private methods) — they could simply move to `rename.ts`, next to
`nearestFiles` which they already share, with no need for any `FactSource`/`RenameSource`
interface at all. Kept generic type parameters
(`<T extends { path: string }>`, `<R extends { targets: …; otherFiles?: string[] }>`) to avoid
pulling type dependencies like `SymbolRow`/`DefinitionResult` backwards into `rename.ts`.

Added 2 pure tests in `nearest.test.js` calling `nearestRows`/`preferNearest` directly with
fake arrays/objects — no `mkdtempSync`, no `Workspace.index()`. This is the "locality" benefit
candidate C promised: a pure rule can now be tested without paying any I/O cost.

```
npm test    # 101/101 (99 previous + 2 new tests)
```

## M.5 Candidate D — core provides its own watch pattern

`server/index.ts` used to read `ws.config.include` itself and filter out `!` patterns to work out
which globs to watch — a leak of core domain knowledge into the LSP protocol-translation layer.
Added `Workspace.changeWatchPatterns(): string[]` (one line, no new module needed); the server now
just calls this function. Any future change to include/exclude semantics only needs editing in
one place.

## M.6 Candidate B — a real seam for rename orchestration

Unlike candidate A, the deletion test showed this part **genuinely needs** `Workspace`'s own state
(the `Linker`, the list of files currently open in the editor) — it cannot be turned into fully
independent functions. Solution: an interface **wider** than `FactSource`, called `RenameSource`
(`packages/core/src/resolve/rename-orchestrator.ts`):

```ts
interface RenameSource {
  facts(relPath): FileFacts | null;
  source(relPath): string | null;
  config: Config;
  findSymbols(name, container): SymbolRow[];
  templatePaths(): string[];
  openTemplatePaths(): string[];        // replaces a direct read of Workspace's own `overlays` Map
  resolveScopeRefs(candidates): RefInput[]; // wraps the Linker, fully hiding it from the orchestrator
}
```

Two new methods on `Workspace` (`openTemplatePaths`, `resolveScopeRefs`) are just one-line
wrappers around existing state — the state itself (`overlays`, `linker`) stays `private`, and the
orchestrator never touches it directly.

`renameAt`/`prepareRenameAt`/`renameTargetAt`/`templateRenameTarget`/`scopeTarget`/
`declarationFiles`/`jsRenameEdits`/`templatesUsing`/`templateRenameEdits` — the whole ~240-line
cluster — moved wholesale into `rename-orchestrator.ts`. `Workspace.renameAt`/`prepareRenameAt`
shrank down to 2 lines each, calling the exported functions directly, and
`Workspace implements FactSource, RenameSource`.

Extra cleanup: the `RenameEdits` interface (a private, unexported declaration in `workspace.ts`)
became dead code once orchestration moved out — deleted; the real one now lives in
`rename-orchestrator.ts`.

## M.7 Overall result (A+C+D+B)

`workspace.ts`: 1465 → 738 lines (what remains: index/watcher/overlay, `referencesAt`,
`completionAt`/`rootCompletions`/`memberCompletions`, and the thin public methods delegating to
the 3 new modules).

```
npx tsc --build --force                                               # clean, no errors
npm test                                                              # 101/101
node packages/cli/dist/index.js sweep --root .../smart-city           # 99.2%, 136 gaps, unchanged
```

No existing test needed changes across all 4 candidates — everything goes through the public API
(`definitionAt`/`renameAt`/`prepareRenameAt`/`membersOf`/`completionAt`), matching exactly the
invariant set at the start of this `/grilling` round.

Technical note that repeated across both splits (definition, rename): a few functions/constants
are shared between the new module and what remains in `workspace.ts`
(`inSpan`, `wordAt`, `ANGULAR_DECL_KINDS`, `expressionAt`, `TEMPLATE_EXT`, `JS_EXT`) — exported
from `workspace.ts` and imported back. A CommonJS-style circular import, but safe because both
sides only call each other inside function bodies, never at module top level; verified with a
real build plus real tests (including the stdio LSP tests) to confirm nothing breaks at runtime,
not just at compile time.
