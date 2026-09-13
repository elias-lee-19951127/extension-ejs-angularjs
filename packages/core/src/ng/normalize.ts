import type { ExprKind } from '../types';

const PREFIX_RE = /^(x[-_:]|data[-_:])/i;

/**
 * Normalize an attribute name per AngularJS's own rules.
 *
 * Angular treats these forms as ONE directive:
 *   ng-repeat  ng:repeat  ng_repeat  data-ng-repeat  x-ng-repeat
 *
 * This is mandatory: the smart-city repo uses `data-ng-*` for 155/159 attributes.
 * Matching only 'ng-repeat' would miss 11 out of 12 ng-repeat usages.
 * See docs/kien-truc.md appendix A.2 section 3.
 */
export function normalizeDirectiveName(attrName: string): string {
  let name = attrName.replace(PREFIX_RE, '');
  // ':' '-' '_' are all separators -> camelCase
  name = name.replace(/[-_:]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
  return name;
}

/** The reverse: 'ngRepeat' -> 'ng-repeat', for display. */
export function denormalize(name: string): string {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/**
 * Syntax table for each of Angular 1's built-in directives.
 * Determines how the attribute value is parsed.
 */
export const BUILTIN_DIRECTIVES: Record<string, ExprKind> = {
  // plain expressions
  ngIf: 'expression',
  ngShow: 'expression',
  ngHide: 'expression',
  ngClass: 'expression',
  ngClassEven: 'expression',
  ngClassOdd: 'expression',
  ngStyle: 'expression',
  ngDisabled: 'expression',
  ngReadonly: 'expression',
  ngChecked: 'expression',
  ngSelected: 'expression',
  ngRequired: 'expression',
  ngOpen: 'expression',
  ngBind: 'expression',
  ngBindHtml: 'expression',
  ngValue: 'expression',
  ngSwitch: 'expression',
  ngSwitchWhen: 'none',
  ngPluralize: 'expression',
  ngCloak: 'none',
  ngApp: 'none',
  ngNonBindable: 'none',
  ngTransclude: 'none',
  ngSrc: 'none',
  ngHref: 'none',

  // statements (allow multiple short statements separated by ';')
  ngClick: 'statement',
  ngDblclick: 'statement',
  ngMousedown: 'statement',
  ngMouseup: 'statement',
  ngMouseover: 'statement',
  ngMouseenter: 'statement',
  ngMouseleave: 'statement',
  ngMousemove: 'statement',
  ngKeydown: 'statement',
  ngKeyup: 'statement',
  ngKeypress: 'statement',
  ngSubmit: 'statement',
  ngFocus: 'statement',
  ngBlur: 'statement',
  ngChange: 'statement',
  ngCopy: 'statement',
  ngCut: 'statement',
  ngPaste: 'statement',
  ngInit: 'statement',

  // must be an assignable LHS
  ngModel: 'assignable',

  // dedicated microsyntax
  ngRepeat: 'repeat-microsyntax',
  ngRepeatStart: 'repeat-microsyntax',
  ngOptions: 'options-microsyntax',

  // special: not parsed as an expression, it's a controller name
  ngController: 'none',
  ngInclude: 'expression',
  ngView: 'none',
  uiView: 'none',
};

/**
 * Return how to parse an attribute's value.
 * `custom` allows declaring the company's own directives via config.
 */
export function directiveExprKind(
  normalizedName: string,
  custom: Record<string, ExprKind> = {},
): ExprKind | undefined {
  if (normalizedName in custom) return custom[normalizedName];
  if (normalizedName in BUILTIN_DIRECTIVES) return BUILTIN_DIRECTIVES[normalizedName];
  // ng-attr-* / ng-prop-* carry interpolated expressions, treat like regular HTML
  if (/^ng(Attr|Prop|On)[A-Z]/.test(normalizedName)) return 'none';
  return undefined;
}

/** Variables Angular automatically adds to the ng-repeat scope. */
export const NG_REPEAT_LOCALS = ['$index', '$first', '$middle', '$last', '$even', '$odd', '$id'];

/**
 * Variables that ANGULAR ITSELF injects into the expression, not properties on the scope.
 *
 * `$event` is present in every statement-type directive (ng-click, ng-keydown…).
 * Missing it would cause 8/405 locations in the smart-city repo to be falsely
 * flagged as "not found on scope" — and with diagnostics enabled, every handler
 * with $event would get underlined as an error.
 */
export const NG_INJECTED_VARS = ['$event', ...NG_REPEAT_LOCALS];

/** Variables always present on an Angular scope. */
export const SCOPE_BUILTINS = [
  '$id', '$parent', '$root', '$$childHead', '$$childTail', '$$nextSibling', '$$prevSibling',
  '$apply', '$applyAsync', '$broadcast', '$destroy', '$digest', '$emit', '$eval', '$evalAsync',
  '$new', '$on', '$watch', '$watchCollection', '$watchGroup',
];

/** Angular's built-in filters — never report "not found" for these. */
export const BUILTIN_FILTERS = [
  'currency', 'date', 'filter', 'json', 'limitTo', 'lowercase',
  'number', 'orderBy', 'uppercase',
];
