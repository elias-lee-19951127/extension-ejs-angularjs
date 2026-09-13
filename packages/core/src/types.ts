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
  /** For directive/component: controllerAs, isolate scope, template. */
  ddo?: {
    controllerAs?: string;
    controllerName?: string;
    scopeBindings?: Record<string, string>;
    templateUrl?: string;
    templateInline?: boolean;
    restrict?: string;
    transclude?: boolean;
  };
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
  /** Which variable holds angular.module('x', []). */
  moduleAliases: Record<string, string>;
  events: Array<{ name: string; direction: 'emit' | 'broadcast' | 'on'; span: Span }>;
  /** Plain JavaScript variable/function declarations, with scope — for Ctrl+Click within .js. */
  bindings: JsBinding[];
  /** Axis A: res.render('view', {a, b}) */
  renderCalls: Array<{ viewPath: string; localKeys: string[]; span: Span }>;
  parseErrors: Array<{ message: string; span: Span }>;
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
