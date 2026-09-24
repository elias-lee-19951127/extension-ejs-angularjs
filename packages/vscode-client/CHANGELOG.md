# Changelog

## 0.7.0

**Far fewer `templateUrl`s left unlinked.** In an EJS + AngularJS app the URL a script asks for is
rarely the path of the file behind it. Now:

- **The server code is read.** `app.use('/assets', express.static(path.join(__dirname, 'public')))`,
  `app.set('views', …)` and routes like `app.get('/partials/:name', … res.render('partials/' + …))`
  map a URL to its directory with no `templateRoots`.
- **`.html` served from `.ejs`**, and URLs with no extension (`/partials/list`), find their template —
  also under the views directory. The exact file name is always tried first; a swapped extension
  only links when one file fits.
- **More ways of writing a template are understood:** a component or directive whose controller is
  an inline function or a variable naming one (`controller: CardController`), `scope.x` set in a
  directive's `link`, `var ddo = {…}; return ddo;`, a factory passed by name, `$uibModal.open` /
  `$mdDialog.show` / any object literal with a `templateUrl` (and its inline controller),
  `$ionicModal.fromTemplateUrl('x.html')`, a `templateUrl` function returning one string, a URL
  built from constants of the file (`BASE + 'list.html'`), and — when the start is computed at
  runtime (`CONFIG.base + '/widgets/x.html'`) — the end of the path.

**Hover a `templateUrl`** to see the template it loads and *how* it was found — or, when none was,
everything that was tried and **Link to a template…**: pick the file (best guesses first) and the
link is saved in the new `ejsng.templateUrlMap` setting (`.vscode/settings.json`, so it can be
committed for the whole team). It applies at once, no reload; **Change…** and **Remove this link**
sit in the same hover. `ejsng sweep` reads the same setting, and takes `--template-map url=file`.
An unlinked `templateUrl` is marked with faint dots (a Hint, not counted in Problems).

**Fixed: an inline value stayed after its `console.log` was deleted.** Deleting the call left the
value on its line, and deleting the whole line slid the value onto the line below. A value now goes
as soon as its line no longer reads as the code that logged it (reformatting doesn't count).

## 0.6.1

No change to the extension itself: the end-to-end test for "Open as JSON" in the hover matches the
link again now that it carries a tooltip. The whole end-to-end suite passes (14/14).

## 0.6.0

**A `templateUrl` written the way Angular reads it now links to its template.** Angular fetches a
`templateUrl` relative to the page, not to the script, so `templateUrl: 'views/list.html'` in
`public/js/app.js` is `public/views/list.html` — and without a `templateRoots` entry it linked to
nothing: no Ctrl+click, and the template's expressions never reached the controller. After
`templateRoots` and the workspace root, the URL is now tried under each directory above the script
(nearest first), then as the end of a path (`/`-bounded, the file nearest the script; a tie links
none). `./`, `../` and `http://host` prefixes are understood. Only the file the URL names is tried
there — `profile.html` → `profile.ejs` still needs `templateRoots`.

**Gutter icons between a `templateUrl` and its template**, as IntelliJ marks related code: an HTML
icon beside each `templateUrl` that resolves, a controller icon on the first line of a template
loaded by one — hover it to see which directive/route/state loads it and with which controller.
**EJS/NG: Go to Related Template / Controller** (`Ctrl+Cmd+↑` on macOS, `Ctrl+Alt+Home` elsewhere —
IntelliJ's own keys, also in the editor's context menu) jumps across.

**Looks like IntelliJ.** Inline runtime values are drawn as IntelliJ's debugger draws them: muted
italic, a little after the code, no `»`; warnings and errors keep their own color. Three colors are
contributed (`ejsng.inlineValue.foreground`, `…warningForeground`, `…errorForeground`), so a theme
or `workbench.colorCustomizations` can change them. The Runtime Values panel follows the Variables
view: round kind icons, `name = {Type} value` in Darcula or IntelliJ Light token colors, 24px rows,
IntelliJ's selection colors, and an icon-only toolbar. High-contrast themes keep VS Code's own colors.

## 0.5.1

**An inline value now appears on the line the logpoint was set on.** A logpoint placed from the
CodeLens, the hover link or `Cmd+Alt+L` is set at the column right after the assignment's `;`, so
the value it logs is the one just assigned. V8 binds such a breakpoint to the first breakable
position at or after that column — which is the *next* statement — and the log was drawn from the
stack frame that came back, so the value appeared beside the line below the one clicked. Logs from
logpoints are now anchored where the logpoint was asked for. Ordinary `console.*` calls are
unchanged: they are still drawn at their own call site.

**A Runtime Values tab in the bottom panel**, read like a debugger: every line that logged, newest
first, and the selected hit's value as a tree — `name = {Type} preview`, colored by kind with the
theme's own debug colors, expandable with the mouse or the arrow keys, each branch copyable as JSON.
Earlier hits of the line are one click away, and the branches you opened stay open between them.

**The hover's links work, and are easy to find.** "Show full value" did nothing when clicked: a
decoration's hover runs no command link unless it is marked trusted, and it wasn't. The hover now
opens with `Inspect` · `Open as JSON` · `Copy`, with icons, right under its title.

**Logged values are colored in the hover.** A code block that opens with `{` is a block of
statements to the JavaScript grammar, and its keys labels, which no theme colors. A logpoint's
`version = ` now stays on the line of the value it names, and an object logged on its own is
wrapped in parentheses. Earlier hits read as code, not plain text.

**Observed type reads as a laid-out TypeScript declaration** — `type latestVersion = { … }`, four
levels deep and up to 30 keys, one key per line once it no longer fits on one — instead of a single
line cut at two levels.

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
