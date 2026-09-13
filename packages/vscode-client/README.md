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

- **EJS/NG: Reindex workspace**
- **EJS/NG: Index stats**

## Known limitations

This is an early release: dynamic `templateUrl` expressions, and JS built through a bundler step,
are reported as "unresolved" rather than followed.

## Release Notes

### 0.1.0

Initial release: go-to-definition, find references, rename, completion, and dead-code detection
between EJS templates and AngularJS 1.x controllers.
