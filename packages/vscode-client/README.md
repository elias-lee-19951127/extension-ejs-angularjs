# EJS + AngularJS Navigator

Tracks variables and functions between **EJS** templates and **AngularJS 1.x** (ES5) controllers —
go-to-definition from `{{ expression }}` straight to `$scope`, find-usages back from a controller
to every template that reads it, rename across both, and dead-code detection.

## Features

| | Example |
|---|---|
| Template → JS | `data-ng-click="selectSection(section)"` → `$scope.selectSection` |
| Property of an `ng-repeat` variable | `section.icon` → the `icon:` key in the object literal of `$scope.sections` |
| `ng-controller` → declaration | works with hyphenated names too |
| JS → Template | `$scope.busy` → every usage in every template |
| Custom directive / isolate binding | `pick-file="onPick($file)"` → `.directive('pickFile', …)` |
| Filter | `{{ x \| money }}` → `.filter('money', …)` |
| Rename | `$scope.busy` → renames every read/write across JS and templates; refuses with a reason on conflict |
| Shape-based completion | `busy.` → the keys actually assigned on that object |
| Dead code | controller / directive / filter / property nobody uses |
| Live sync | files changed outside the editor (`git pull`, checkout, another tool) re-index automatically |
| Inline runtime log | `console.log`/`warn`/`error` from a running Node process, shown inline next to the line that logged it — color-coded by severity |

## Requirements

No separate install step — the language server ships bundled inside the extension.

## Extension Settings

| Setting | Default | Notes |
|---|---|---|
| `ejsng.include` / `ejsng.exclude` | common EJS/JS/HTML globs | Which files to index |
| `ejsng.moduleAliases` | `["myApp", "app", "appModule"]` | Variables holding the Angular module when declared in another file |
| `ejsng.ejsDelimiter` | `"%"` | Set to `"?"` for `<? ?>` delimiters |
| `ejsng.customDirectives` | `{}` | e.g. `{"myOn": "statement"}` for your own custom directives |
| `ejsng.diagnostics.enabled` | `false` | Off by default to avoid false warnings on legacy code |

## Commands

- **EJS/NG: Reindex Workspace**
- **EJS/NG: Show Index Stats**
- **EJS/NG: Connect to Runtime** — prompts for `host:port` of a running Node process started with
  `node --inspect` (or, once available, a browser's `--remote-debugging-port`) and shows its
  `console.log` output inline. Multiple connections can be open at once.
- **EJS/NG: Disconnect Runtime** — pick one of the currently open runtime connections to close.

## Known limitations

This is an early release: dynamic `templateUrl` expressions, and JS built through a bundler step,
are reported as "unresolved" rather than followed. The inline runtime log feature currently only
supports Node processes (`node --inspect`); browser-side (AngularJS) log capture is planned.

## Release Notes

### 0.2.1

`EJS/NG: Connect to Runtime` now takes `host:port` directly and can open multiple simultaneous
connections (e.g. several Node processes at once); `EJS/NG: Disconnect Runtime` closes one.

### 0.2.0

Inline runtime log: `EJS/NG: Connect to Runtime` shows `console.log`/`warn`/`error` output from a
running Node process inline in the editor.

### 0.1.0

Initial release: go-to-definition, find references, rename, completion, and dead-code detection
between EJS templates and AngularJS 1.x controllers.
