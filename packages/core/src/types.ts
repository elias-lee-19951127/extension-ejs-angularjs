/** Position as an offset in the original file. Always the offset of the ORIGINAL FILE, never a virtual doc. */
export interface Span {
  start: number;
  end: number;
}

export type Confidence = 'high' | 'medium' | 'low';

/** The tracking axes. See docs/kien-truc.md section 0. */
export type Axis =
  | 'ng-scope' // {{foo}} -> $scope.foo / this.foo
  | 'ng-di' // function(UserSvc) -> .service('UserSvc')
  | 'ng-directive' // <my-widget> -> .directive('myWidget')
  | 'ng-filter' // {{x | myFilter}} -> .filter('myFilter')
  | 'ng-event' // $emit('x') <-> $on('x')
  | 'ejs-locals' // <%= user %> -> res.render(_, {user})
  | 'ejs-include'; // include('partial')

export type NgDeclKind =
  | 'controller'
  | 'service'
  | 'factory'
  | 'provider'
  | 'directive'
  | 'filter'
  | 'component'
  | 'value'
  | 'constant'
  | 'module';

/**
 * Shape inferred from an object literal. Good enough for completion, not a type
 * system. See docs/kien-truc.md section 5.3.
 */
export interface ValueShape {
  kind: 'object' | 'array' | 'function' | 'primitive' | 'unknown';
  /** Only when kind === 'primitive', and only when the expression says which one. */
  primitive?: 'string' | 'number' | 'boolean' | 'null' | 'undefined';
  /** Span of the key that declares this value — enables go-to-def into `busy.search`. */
  span?: Span;
  /** Only present when kind === 'object'. */
  props?: Record<string, ValueShape>;
  /** Only present when kind === 'array': shape of the elements. */
  element?: ValueShape;
  /** Only present when kind === 'function'. */
  params?: string[];
}

/** An Angular declaration found in a .js file */
export interface NgDeclaration {
  kind: NgDeclKind;
  /** Name may contain dashes: 'cityos-demo-dha-management-view-controller'. */
  name: string;
  nameSpan: Span;
  bodySpan: Span;
  /** Module name used in the declaration ('cityosDemo'), or the variable name if unresolved. */
  moduleRef: string | null;
  confidence: Confidence;
  /** Names of the injected dependencies. */
  deps: Array<{ name: string; span: Span }>;
  /**
   * A controller with no name of its own — `controller: function ($scope) {…}` in a route, state or
   * modal — given one (`inline:$uibModal.open#L12`) so its scope members have an owner a template
   * can be bound to. Never listed as a symbol: nothing can refer to it by that name.
   */
  inline?: true;
  /** For directive/component: controllerAs, isolate scope, template. */
  ddo?: {
    controllerAs?: string;
    controllerName?: string;
    scopeBindings?: Record<string, string>;
    /** Where each key of `scopeBindings` is written, for go-to-definition (`bindings: { user: '<' }`). */
    scopeBindingSpans?: Record<string, Span>;
    templateUrl?: string;
    templateInline?: boolean;
    restrict?: string;
    transclude?: boolean;
  };
}

/**
 * One `templateUrl` and the controller that will own that template's scope at runtime —
 * directive/component DDO, `$routeProvider.when`, `$stateProvider.state` (and each of its
 * named views). Still a pure fact: the URL is NOT mapped to a file here, that needs config
 * and the set of indexed files (Layer 4).
 */
export interface TemplateLink {
  /** `'other'`: any other object literal carrying a `templateUrl` (`$uibModal.open`, `$mdDialog.show`, a route kept in a variable…) or `fromTemplateUrl('x.html')`. */
  via: 'directive' | 'component' | 'route' | 'state' | 'other';
  /** Directive/component name, route path or state name (plus `@view` for a named view). */
  owner: string;
  /** The literal URL, or `null` when `templateUrl` is an expression that can't be read statically. */
  url: string | null;
  /** Span of the `templateUrl` value — of its static tail only, when `suffixOnly`. */
  urlSpan: Span;
  /**
   * `url` is only the static END of an expression (`base + '/list.html'`): matched as the end of a
   * path, never as a whole one.
   */
  suffixOnly?: boolean;
  /** Controller NAME — `null` when absent or declared inline as a function. */
  controller: string | null;
  controllerAs: string | null;
}

/** A property assigned onto $scope or this within a controller's body. */
export interface ScopeMember {
  /** Property name: 'busy', 'selectSection'. */
  name: string;
  /** '$scope' or 'this' (controllerAs). */
  via: '$scope' | 'this';
  span: Span;
  /** Name of the Angular declaration that contains it. */
  owner: string;
  shape: ValueShape;
  /** true if this is the (declaring) assignment, false if it's just a read. */
  isWrite: boolean;
}

/**
 * EVERY assignment onto a controller's scope — not just the first, which is all `scopeMembers`
 * keeps (that one is the "declaration site" go-to-definition and rename rely on). The input the
 * observed-type feature merges (.scratch/observed-types/spec.md, decision #9).
 */
export interface ScopeWrite {
  /** Name of the Angular declaration whose scope this writes. */
  owner: string;
  via: '$scope' | 'this';
  /** `['form']` for `$scope.form = …`, `['form', 'extra']` for a nested `$scope.form.extra = …`. */
  path: string[];
  /** Span of the LAST property name on the left: `extra` in `$scope.form.extra`. */
  span: Span;
  /**
   * Shape of each value the right side can produce, `null`/`undefined` left out: one entry for a
   * plain value, one per branch for `a ? b : c` and `a || b`. Empty when it only ever assigns null.
   */
  shapes: ValueShape[];
  /** Some branch assigns `null`, `undefined` or `void 0` explicitly. */
  nullable: boolean;
  /** Inside a function nested in the declaration's body (a `.then()` callback, a handler) — not run at construction. */
  inCallback: boolean;
  /** The right side, whitespace-collapsed and cut to 40 characters — so a hover can say where an unknown shape came from. */
  rhsText: string;
  /** The left side as written: `$scope.rows`, `vm.rows`, `this.form.owner` — valid code right where it was assigned. */
  lhsText: string;
  /**
   * Offset right after the statement this assignment is — past its `;` — when the assignment is a
   * whole expression statement (`$scope.rows = res.data;`, or the outer one of `a = b = x;`). A
   * logpoint at that column runs AFTER the assignment, one-line functions included (measured,
   * .scratch/log-variable/spec.md). Absent when the assignment sits inside another expression.
   */
  after?: number;
}

/** A property path on the scope of an Angular declaration: `rows` on `ListCtrl` is `{ owner: 'ListCtrl', path: ['rows'] }`. */
export interface ScopeTarget {
  owner: string;
  path: string[];
}

/**
 * A direct `console.<method>(…)` call inside an Angular declaration's body, with at least one
 * argument read off the scope (observed-types-r1 ticket 02) — so a logged value can be tied to the
 * scope variable it shows without parsing anything when the log arrives.
 */
export interface ConsoleCall {
  /**
   * Span of the method name, `log` in `console.log(…)`: where V8 reports the call frame of a
   * console call (measured — even as `console . log (` split over lines).
   */
  method: Span;
  /** One per argument, in order: the scope variable it reads, or `null` (`'text'`, `res.data`, `a[0]`). */
  args: Array<ScopeTarget | null>;
}

export type BindingKind = 'var' | 'let' | 'const' | 'function' | 'param' | 'catch' | 'class';

export interface JsBinding {
  name: string;
  span: Span;
  /** Scope in which this declaration is visible. */
  scope: Span;
  kind: BindingKind;
}

/** Facts extracted from a .js file. Must be a PURE function of the file's content. */
export interface JsFacts {
  kind: 'js';
  declarations: NgDeclaration[];
  scopeMembers: ScopeMember[];
  scopeWrites: ScopeWrite[];
  consoleCalls: ConsoleCall[];
  /** Which variable holds angular.module('x', []). */
  moduleAliases: Record<string, string>;
  events: Array<{ name: string; direction: 'emit' | 'broadcast' | 'on'; span: Span }>;
  /** Plain JavaScript variable/function declarations, with scope — for Ctrl+Click within .js. */
  bindings: JsBinding[];
  /** Axis A: res.render('view', {a, b}) */
  renderCalls: Array<{
    viewPath: string;
    localKeys: string[];
    span: Span;
    /** The view-name string itself: `'user/profile'`. */
    viewSpan: Span;
    /** Each passed key with the span of its property key — where an EJS local jumps to. */
    locals: Array<{ name: string; span: Span }>;
  }>;
  /** Every `templateUrl` this file points at, from any of the sources in docs/kien-truc.md section 5.1. */
  templateLinks: TemplateLink[];
  /** Where an Express app in this file serves templates from — so a `templateUrl` maps to disk with no config. */
  serverRoots?: ServerRoot[];
  parseErrors: Array<{ message: string; span: Span }>;
}

/**
 * A directory an Express app serves pages from, read off the server code:
 * - `'static'`: `app.use('/assets', express.static(path.join(__dirname, 'public')))`
 * - `'views'`: `app.set('views', path.join(__dirname, 'views'))`
 * - `'render-route'`: `app.get('/partials/:name', (req, res) => res.render('partials/' + req.params.name))`
 */
export interface ServerRoot {
  kind: 'static' | 'views' | 'render-route';
  /** URL prefix served (`'/'` for an unprefixed static mount); `''` for `'views'`. */
  urlPrefix: string;
  /** The directory as written — relative to this file's directory when `fromFile`, else to the process cwd. */
  dir: string;
  fromFile: boolean;
  /** `'render-route'`: what the route puts before the URL's rest to name the view (`'partials/'`). */
  viewPrefix?: string;
}

/** An Angular expression in a template, with its scope context at that position. */
export interface TemplateExpression {
  /** The expression's original text. */
  text: string;
  /** Span of the expression in the ORIGINAL FILE. */
  span: Span;
  /** Normalized directive name ('ngClick'), or 'interpolation'. */
  source: string;
  /** The root identifiers in the expression, with absolute spans. */
  roots: Array<{ name: string; span: Span; path: string[]; isCall: boolean }>;
  /** Filters used in the expression. */
  filters: Array<{ name: string; span: Span }>;
  /** The scope chain at this position, from innermost to outermost. */
  scopeChain: ScopeFrame[];
}

/** A single scope frame. */
export interface ScopeFrame {
  kind: 'controller' | 'repeat' | 'init' | 'isolate' | 'root';
  /** For 'controller': the controller name. */
  controllerName?: string;
  /** controllerAs alias, if any. */
  alias?: string;
  /** Variables this frame introduces ($index, item, ...). */
  locals: Array<{
    name: string;
    span: Span;
    fromExpr?: string;
    /**
     * For an ng-repeat item variable: reference to the collection expression.
     * This is what lets `section.id` in `ng-repeat="section in sections"` resolve
     * — walking from `$scope.sections` down to the element shape and then
     * resolving the `id` key.
     */
    collection?: { root: string; path: string[] };
  }>;
  elementSpan: Span;
}

/** Facts extracted from a .ejs / .html file. */
export interface TemplateFacts {
  kind: 'template';
  expressions: TemplateExpression[];
  /** Axis A: local variables used in EJS regions. */
  ejsLocals: Array<{ name: string; path: string[]; span: Span }>;
  ejsIncludes: Array<{ viewPath: string; passedKeys: string[]; span: Span }>;
  /** Controllers declared in the markup. */
  controllers: Array<{ name: string; alias?: string; span: Span; elementSpan: Span }>;
  /** Custom elements (containing '-') that may be a directive. */
  customElements: Array<{ tag: string; span: Span }>;
  /** Intersection of axis A and axis B: <script>var x = <%- ... %></script> */
  bridges: Array<{ jsTarget: string; ejsExpr: string; span: Span }>;
  /**
   * An attribute whose nature is UNKNOWN: it could be a custom directive, it could
   * be an isolate-scope binding, or it could just be a regular HTML attribute.
   *
   * Cannot be resolved at Layer 2 since that requires knowing the DDO, which lives
   * in another file (docs/kien-truc.md section 3: facts must be pure). The Linker
   * resolves it at Layer 4.
   */
  attrCandidates: AttrCandidate[];
  parseErrors: Array<{ message: string; span: Span }>;
}

export interface AttrCandidate {
  /** Normalized tag name: 'cityosDha'. */
  tag: string;
  /** Normalized attribute name: 'kbmFile', 'data'. */
  attr: string;
  value: string;
  valueSpan: Span;
  attrSpan: Span;
  /** The enclosing controller, if declared in this same file. */
  container: string | null;
  /** controllerAs aliases in scope here -> their controller, nearest first wins (`vm` -> 'ListCtrl'). */
  aliases?: Record<string, string>;
  /** Local variables of the template at this position — to avoid mistaking one for a ref. */
  locals: string[];
}

export type FileFacts = JsFacts | TemplateFacts;

export interface Config {
  root: string;
  include: string[];
  exclude: string[];
  moduleAliases: string[];
  ejsDelimiter: string;
  customDirectives: Record<string, ExprKind>;
  templateRoots: Array<{ urlPrefix: string; fsPath: string; extensions?: string[] }>;
  /**
   * Links set by hand: a `templateUrl` exactly as written -> the workspace-relative template it
   * loads. Checked before anything else — for the URLs no rule can find.
   */
  templateUrlMap?: Record<string, string>;
  expressViewsDir?: string;
}

export type ExprKind =
  | 'expression'
  | 'statement'
  | 'assignable'
  | 'repeat-microsyntax'
  | 'options-microsyntax'
  | 'none';

export const DEFAULT_CONFIG: Omit<Config, 'root'> = {
  include: ['**/*.js', '**/*.ejs', '**/*.html'],
  exclude: ['**/node_modules/**', '**/bower_components/**', '**/dist/**', '**/*.min.js'],
  moduleAliases: ['myApp', 'app', 'appModule'],
  ejsDelimiter: '%',
  customDirectives: {},
  templateRoots: [],
};
