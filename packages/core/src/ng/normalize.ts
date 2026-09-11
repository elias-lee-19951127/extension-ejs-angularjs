import type { ExprKind } from '../types';

const PREFIX_RE = /^(x[-_:]|data[-_:])/i;

/**
 * Chuan hoa ten thuoc tinh theo dung luat cua AngularJS.
 *
 * Angular coi 4 dang sau la MOT directive:
 *   ng-repeat  ng:repeat  ng_repeat  data-ng-repeat  x-ng-repeat
 *
 * Bat buoc phai co: repo smart-city dung `data-ng-*` cho 155/159 thuoc tinh.
 * Neu chi khop 'ng-repeat' thi miss 11/12 lan dung ng-repeat.
 * Xem docs/kien-truc.md phu luc A.2 muc 3.
 */
export function normalizeDirectiveName(attrName: string): string {
  let name = attrName.replace(PREFIX_RE, '');
  // ':' '-' '_' deu la dau phan cach -> camelCase
  name = name.replace(/[-_:]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
  return name;
}

/** Nguoc lai: 'ngRepeat' -> 'ng-repeat', de hien thi. */
export function denormalize(name: string): string {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/**
 * Bang cu phap cho tung directive dung san cua Angular 1.
 * Quyet dinh gia tri thuoc tinh duoc parse nhu the nao.
 */
export const BUILTIN_DIRECTIVES: Record<string, ExprKind> = {
  // bieu thuc thuan
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

  // cau lenh (cho phep nhieu cau ngan boi ';')
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

  // phai la LHS gan duoc
  ngModel: 'assignable',

  // microsyntax rieng
  ngRepeat: 'repeat-microsyntax',
  ngRepeatStart: 'repeat-microsyntax',
  ngOptions: 'options-microsyntax',

  // dac biet: khong parse nhu bieu thuc, la ten controller
  ngController: 'none',
  ngInclude: 'expression',
  ngView: 'none',
  uiView: 'none',
};

/**
 * Tra ve cach parse gia tri cua mot thuoc tinh.
 * `custom` cho phep khai bao directive tu viet cua cong ty qua config.
 */
export function directiveExprKind(
  normalizedName: string,
  custom: Record<string, ExprKind> = {},
): ExprKind | undefined {
  if (normalizedName in custom) return custom[normalizedName];
  if (normalizedName in BUILTIN_DIRECTIVES) return BUILTIN_DIRECTIVES[normalizedName];
  // ng-attr-* / ng-prop-* mang bieu thuc noi suy, xu ly nhu HTML thuong
  if (/^ng(Attr|Prop|On)[A-Z]/.test(normalizedName)) return 'none';
  return undefined;
}

/** Cac bien Angular tu dua vao scope cua ng-repeat. */
export const NG_REPEAT_LOCALS = ['$index', '$first', '$middle', '$last', '$even', '$odd', '$id'];

/**
 * Bien do CHINH ANGULAR bom vao bieu thuc, khong phai property tren scope.
 *
 * `$event` co trong moi directive dang cau lenh (ng-click, ng-keydown…).
 * Bo sot no thi 8/405 vi tri trong repo smart-city bi bao nham la "khong tim
 * thay tren scope" — va neu bat diagnostics thi moi handler co $event deu bi
 * gach chan do.
 */
export const NG_INJECTED_VARS = ['$event', ...NG_REPEAT_LOCALS];

/** Cac bien luon co tren mot scope Angular. */
export const SCOPE_BUILTINS = [
  '$id', '$parent', '$root', '$$childHead', '$$childTail', '$$nextSibling', '$$prevSibling',
  '$apply', '$applyAsync', '$broadcast', '$destroy', '$digest', '$emit', '$eval', '$evalAsync',
  '$new', '$on', '$watch', '$watchCollection', '$watchGroup',
];

/** Filter dung san cua Angular — khong bao loi "khong tim thay". */
export const BUILTIN_FILTERS = [
  'currency', 'date', 'filter', 'json', 'limitTo', 'lowercase',
  'number', 'orderBy', 'uppercase',
];
