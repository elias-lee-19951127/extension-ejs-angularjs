# Example: Task Board

A small Express + EJS + AngularJS 1.x app to try **EJS + AngularJS Navigator** on. It is the app the
demo GIFs and the [demo video](../../docs/media/demo.mp4) were recorded on.

```
task-board/
├── server.js                  Express: renders views/index.ejs, serves public/, GET /api/tasks
├── views/index.ejs            the page — EJS locals + AngularJS expressions, two nested controllers
└── public/
    ├── js/app.js              module, factory, two controllers, a component, a filter
    └── views/task-card.html   the component's templateUrl
```

## Open it

1. Install the extension (from the Marketplace, a `.vsix`, or press `F5` in this repo to launch the
   Extension Development Host).
2. **File → Open Folder…** → this folder (`examples/task-board`). Indexing takes well under a second.

No `npm install` is needed for the navigation features — only for the runtime log below.

## Try it

### Template ↔ controller

In `views/index.ejs`:

- Every name backed by JavaScript is drawn in color and **bold**: `reload`, `busy`, `stats.total`
  (scope), `BoardCtrl`, `task-card`, `ago` (declarations). `task`, a variable the template declares
  itself in `ng-repeat`, stays plain.
- Hover `stats.total` → where it lives on the scope, and its observed type (`number`).
  `stats.updatedAt` carries a faint *may be empty* hint: it starts out as `null`.
- `F12` (or Cmd/Ctrl+Click) on `reload()` → `$scope.reload` in `public/js/app.js`.
- `tasks` inside `<section ng-controller="TaskListCtrl as vm">` still resolves to `BoardCtrl`: a
  nested controller sees its parents' scope.
- In `app.js`, `Shift+F12` on `$scope.reload` → every template that uses it.
- In `public/views/task-card.html`, `F12` on `$ctrl.task` → `task` in the component's `bindings`.
- `Shift+F12` on `$scope.tasks` in `BoardCtrl` finds `tasks` inside the nested `TaskListCtrl` too.

### Completion

On an empty line inside `<main ng-controller="BoardCtrl">`, type `{{ ` and:

- `Ctrl+Space` → the members of `BoardCtrl`'s scope;
- `stats.` → `total`, `updatedAt` — the keys actually assigned;
- `stats.updatedAt | ` → filters only: `ago` (yours) and the built-in ones;
- `<task-` on a tag → the `taskCard` component; inside the tag → its bindings `task`, `on-toggle`.

In `app.js`, inside `BoardCtrl`: `TaskService.` → `list`, `save`, `cache` — the members the factory
returns, listed ahead of TypeScript's guesses.

### Rename

In `app.js`, put the cursor on `busy` in `$scope.busy = false;` and press `F2`. All three
assignments in the controller and `ng-disabled="busy"` in the template are renamed together.

### `templateUrl`

In `app.js`, hover `'views/task-card.html'` in the `taskCard` component: it loads
`public/views/task-card.html`, found through `express.static('public')` in `server.js` — no setting
needed. The gutter shows an HTML icon there, and a controller icon on line 1 of the template.
`Ctrl+Cmd+↑` (macOS) / `Ctrl+Alt+Home` jumps between the two.

### Inline runtime log

```bash
npm install
npm run debug        # node --inspect server.js
```

Then **EJS/NG: Connect to Runtime** → `127.0.0.1:9229` (or the app port, `3000`), open `server.js`
and load <http://localhost:3000/api/tasks> a few times. The `console.log` on line 23 shows its value
right after the line, with a hit count (`×3`); `Cmd/Ctrl+K Cmd/Ctrl+I` at the end of the line shows
where it came from, when, and the full value.

### Dead code

With the CLI, from the repo root:

```bash
node packages/cli/dist/index.js unused examples/task-board
```

This app has none: every member is used somewhere — through a parent scope (`tasks`), a
controller-as alias in a component attribute (`vm.toggle`) or a `templateUrl` (`$ctrl.expanded`).
Delete `{{ $ctrl.priorityLabel() }}` from `task-card.html` and `priorityLabel` shows up.
