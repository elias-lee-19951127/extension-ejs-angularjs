/** Vi tri dang offset trong file goc. Luon la offset cua FILE GOC, khong phai virtual doc. */
export interface Span {
  start: number;
  end: number;
}

export type Confidence = 'high' | 'medium' | 'low';

/** Cac truc tracking. Xem docs/kien-truc.md muc 0. */
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
 * Shape suy luan duoc tu object literal. Du cho completion, khong phai type system.
 * Xem docs/kien-truc.md muc 5.3.
 */
export interface ValueShape {
  kind: 'object' | 'array' | 'function' | 'primitive' | 'unknown';
  /** Span cua khoa khai bao ra gia tri nay — cho phep go-to-def vao `busy.search`. */
  span?: Span;
  /** Chi co khi kind === 'object'. */
  props?: Record<string, ValueShape>;
  /** Chi co khi kind === 'array': shape cua phan tu. */
  element?: ValueShape;
  /** Chi co khi kind === 'function'. */
  params?: string[];
}

/** Mot khai bao Angular tim thay trong file .js */
export interface NgDeclaration {
  kind: NgDeclKind;
  /** Ten co the chua dau gach ngang: 'cityos-demo-dha-management-view-controller'. */
  name: string;
  nameSpan: Span;
  bodySpan: Span;
  /** Ten module dung de khai bao ('cityosDemo'), hoac ten bien neu chua resolve duoc. */
  moduleRef: string | null;
  confidence: Confidence;
  /** Ten cac dependency inject vao. */
  deps: Array<{ name: string; span: Span }>;
  /** Voi directive/component: controllerAs, isolate scope, template. */
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

/** Mot property duoc gan len $scope hoac this trong than controller. */
export interface ScopeMember {
  /** Ten property: 'busy', 'selectSection'. */
  name: string;
  /** '$scope' hoac 'this' (controllerAs). */
  via: '$scope' | 'this';
  span: Span;
  /** Ten khai bao Angular chua no. */
  owner: string;
  shape: ValueShape;
  /** true neu day la lan gan (khai bao), false neu chi doc. */
  isWrite: boolean;
}

export type BindingKind = 'var' | 'let' | 'const' | 'function' | 'param' | 'catch' | 'class';

export interface JsBinding {
  name: string;
  span: Span;
  /** Pham vi ma khai bao nay nhin thay duoc. */
  scope: Span;
  kind: BindingKind;
}

/** Fact trich tu mot file .js. Phai la ham THUAN cua noi dung file. */
export interface JsFacts {
  kind: 'js';
  declarations: NgDeclaration[];
  scopeMembers: ScopeMember[];
  /** angular.module('x', []) gan vao bien nao. */
  moduleAliases: Record<string, string>;
  events: Array<{ name: string; direction: 'emit' | 'broadcast' | 'on'; span: Span }>;
  /** Khai bao bien/ham JavaScript thuan, kem pham vi — cho Ctrl+Click trong .js. */
  bindings: JsBinding[];
  /** Truc A: res.render('view', {a, b}) */
  renderCalls: Array<{ viewPath: string; localKeys: string[]; span: Span }>;
  parseErrors: Array<{ message: string; span: Span }>;
}

/** Mot bieu thuc Angular trong template, kem context scope tai cho. */
export interface TemplateExpression {
  /** Text goc cua bieu thuc. */
  text: string;
  /** Span cua bieu thuc trong FILE GOC. */
  span: Span;
  /** Ten directive da chuan hoa ('ngClick'), hoac 'interpolation'. */
  source: string;
  /** Cac identifier goc (root) trong bieu thuc, kem span tuyet doi. */
  roots: Array<{ name: string; span: Span; path: string[]; isCall: boolean }>;
  /** Filter dung trong bieu thuc. */
  filters: Array<{ name: string; span: Span }>;
  /** Chuoi scope tai vi tri nay, tu trong ra ngoai. */
  scopeChain: ScopeFrame[];
}

/** Mot tang scope. */
export interface ScopeFrame {
  kind: 'controller' | 'repeat' | 'init' | 'isolate' | 'root';
  /** Voi 'controller': ten controller. */
  controllerName?: string;
  /** controllerAs alias neu co. */
  alias?: string;
  /** Bien do tang nay dua vao ($index, item, ...). */
  locals: Array<{
    name: string;
    span: Span;
    fromExpr?: string;
    /**
     * Voi bien phan tu cua ng-repeat: tham chieu toi bieu thuc collection.
     * Nho no ma `section.id` trong `ng-repeat="section in sections"` resolve
     * duoc — di tu `$scope.sections` xuong shape phan tu roi tra khoa `id`.
     */
    collection?: { root: string; path: string[] };
  }>;
  elementSpan: Span;
}

/** Fact trich tu mot file .ejs / .html. */
export interface TemplateFacts {
  kind: 'template';
  expressions: TemplateExpression[];
  /** Truc A: bien locals dung trong region EJS. */
  ejsLocals: Array<{ name: string; path: string[]; span: Span }>;
  ejsIncludes: Array<{ viewPath: string; passedKeys: string[]; span: Span }>;
  /** Cac controller khai bao trong markup. */
  controllers: Array<{ name: string; alias?: string; span: Span; elementSpan: Span }>;
  /** The custom (co dau '-') co the la directive. */
  customElements: Array<{ tag: string; span: Span }>;
  /** Giao diem A x B: <script>var x = <%- ... %></script> */
  bridges: Array<{ jsTarget: string; ejsExpr: string; span: Span }>;
  /**
   * Thuoc tinh CHUA BIET la gi: co the la directive tu viet, co the la binding
   * cua isolate scope, co the chi la thuoc tinh HTML thuong.
   *
   * Khong the ket luan ngay o Layer 2 vi can biet DDO nam o file khac
   * (docs/kien-truc.md muc 3: fact phai thuan). Linker se phan giai o Layer 4.
   */
  attrCandidates: AttrCandidate[];
  parseErrors: Array<{ message: string; span: Span }>;
}

export interface AttrCandidate {
  /** Ten the da chuan hoa: 'cityosDha'. */
  tag: string;
  /** Ten thuoc tinh da chuan hoa: 'kbmFile', 'data'. */
  attr: string;
  value: string;
  valueSpan: Span;
  attrSpan: Span;
  /** Controller bao quanh, neu khai bao ngay trong file nay. */
  container: string | null;
  /** Bien cuc bo cua template tai vi tri do — de khong bao nham la ref. */
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
