import type { JsFacts, Span, TemplateFacts } from '../types';
import type { SymbolRow } from '../index/store';
import type { DefinitionResult } from './workspace';
import { ANGULAR_DECL_KINDS, expressionAt, inSpan, wordAt } from './workspace';
import { type FactSource, walkShape } from './shape';
import { aliasOf, controllerOf, findLocal } from './rows';
import { JS_GLOBALS, resolveBinding } from '../extract/bindings';
import { nodeAt, unwind, type Expr } from '../ng/ast';
import { tryParseExpression } from '../ng/parser';
import { BUILTIN_FILTERS, NG_INJECTED_VARS, SCOPE_BUILTINS } from '../ng/normalize';

/**
 * Go-to-definition tai mot vi tri trong file .js hoac .ejs da duoc danh index.
 *
 * Thu tu resolve trong template (docs/kien-truc.md muc 5.2):
 *   1. bien cuc bo cua template (ng-repeat / ng-init) -> nhay trong cung file
 *   2. controllerAs alias -> khai bao controller
 *   3. property tren $scope / this cua controller dang bao quanh
 *   4. filter / directive / service
 *
 * Khong loc "ban gan nhat" khi trung ten o nhieu file — do la viec cua
 * `Workspace.definitionAt` (goi `preferNearest` sau khi goi ham nay).
 */
export function resolveDefinition(deps: FactSource, relPath: string, offset: number): DefinitionResult {
  const facts = deps.facts(relPath);
  if (!facts) return { targets: [], query: '', reason: 'File chua duoc danh index' };

  return facts.kind === 'template'
    ? templateDefinition(deps, relPath, offset, facts)
    : jsDefinition(deps, relPath, offset);
}

function templateDefinition(
  deps: FactSource,
  relPath: string,
  offset: number,
  facts: TemplateFacts,
): DefinitionResult {
  // ng-controller="Ten" -> nhay toi khai bao controller
  for (const c of facts.controllers) {
    if (inSpan(c.span, offset)) {
      return {
        query: c.name,
        targets: symbolTargets(deps.findSymbols(c.name, null), 'controller'),
      };
    }
  }

  // Ten filter: `{{ x | money }}` -> .filter('money', ...)
  // Phai xet TRUOC khi phan giai scope, vi ten filter cung nam trong span cua
  // bieu thuc nhung khong phai property tren scope.
  for (const expr of facts.expressions) {
    for (const f of expr.filters) {
      if (!inSpan(f.span, offset)) continue;
      if (BUILTIN_FILTERS.includes(f.name)) {
        return {
          targets: [],
          query: f.name,
          reason: `'${f.name}' la filter dung san cua AngularJS`,
        };
      }
      const rows = deps.findSymbols(f.name, null).filter((r) => r.kind === 'filter');
      if (rows.length) return { query: f.name, targets: symbolTargets(rows, 'filter') };
      return { targets: [], query: f.name, reason: `Khong tim thay filter '${f.name}'` };
    }
  }

  const hit = expressionAt(facts, offset);
  if (!hit) return candidateDefinition(deps, relPath, offset, facts);

  const { expr, node } = hit;
  const { root, path } = unwind(node);
  if (!root) return { targets: [], query: '', reason: 'Khong xac dinh duoc dinh danh' };

  // Bien do Angular bom vao ($event, $index…) — khong co dinh nghia trong code
  // nguoi dung, va khong phai loi.
  // Ap dung cho CA duong dan property: `$event.keyCode` cung khong co dinh
  // nghia trong code nguoi dung, khong chi rieng `$event`.
  if (NG_INJECTED_VARS.includes(root.name) || SCOPE_BUILTINS.includes(root.name)) {
    const full = path.length ? `${root.name}.${path.join('.')}` : root.name;
    return {
      targets: [],
      query: full,
      reason: `'${root.name}' la bien dung san cua AngularJS`,
      builtin: true,
    };
  }

  // Vi tri con tro nam tren chinh dinh danh goc hay tren mot property phia sau?
  const onRoot = inSpan(root.span, offset);
  const alias = aliasOf(expr.scopeChain);
  const container = controllerOf(expr.scopeChain);

  // 1. Bien cuc bo cua template (ng-repeat / ng-init)
  const local = findLocal(root.name, expr.scopeChain);
  if (local) {
    // 1a. Con tro tren chinh bien -> nhay toi cho khai bao trong template
    if (onRoot) {
      return {
        query: root.name,
        targets: [
          {
            path: relPath,
            span: local.span,
            kind: local.frame.kind === 'repeat' ? 'repeat-var' : 'init-var',
            detail: `Bien cuc bo cua template (${local.frame.kind})`,
            confidence: 'high',
          },
        ],
      };
    }

    // 1b. Con tro tren MOT PROPERTY cua bien cuc bo: `section.id`.
    //     Di tu bieu thuc collection (`sections`) xuong shape phan tu roi
    //     tra khoa. Thieu nhanh nay thi `{{ section.icon }}` khong nhay duoc —
    //     ma do lai la dang bieu thuc pho bien nhat trong template Angular.
    if (local.collection && container) {
      const depth = depthAt(node, offset, false);
      const rest = path.slice(0, Math.max(depth - 1, 1));
      const members = deps.findSymbols(local.collection.root, container);

      if (members.length) {
        // `sections` la mang -> walkShape tu dong di vao shape phan tu.
        const full = [...local.collection.path, ...rest];
        const targets = members.map((m) => {
          const walked = walkShape(deps, m, full);
          // Ten trong `detail` phai la doan THUC SU toi duoc: di nua chung roi tac ma van in ca
          // duong dan da hoi la noi doi — cung ly do `confidence` bi ha xuong medium ngay duoi.
          const reached = rest.slice(0, Math.max(walked.depth - local.collection!.path.length, 0));
          return {
            path: m.path,
            span: walked.span ?? m.span,
            kind: walked.span ? 'shape-property' : 'scope-member',
            detail: walked.span
              ? `${[root.name, ...reached].join('.')} — phan tu cua ${local.collection!.root}`
              : `${local.collection!.root} (khong suy duoc shape phan tu)`,
            // `medium` = KHONG lan duoc theo shape toi khoa dang hoi, chu khong phai
            // "khong chac day la dung cho". Duong dan di het thi giu do tin cay cua symbol.
            confidence: walked.partial ? ('medium' as const) : m.confidence,
          };
        });
        return { query: `${root.name}.${rest.join('.')}`, targets };
      }
    }

    return {
      targets: [],
      query: root.name,
      reason: `'${root.name}' la bien cuc bo cua template; khong suy duoc shape de tra property`,
    };
  }

  // 2. controllerAs alias
  if (onRoot && alias && root.name === alias) {
    if (!container) return { targets: [], query: alias, reason: 'Khong ro controller' };
    return {
      query: container,
      targets: symbolTargets(deps.findSymbols(container, null), 'controller'),
    };
  }

  // 3. Property tren controller — co the la property long nhau (`busy.search`).
  if (!container) {
    return {
      targets: [],
      query: root.name,
      reason: 'Khong tim thay ng-controller bao quanh — chua biet controller nao',
    };
  }

  // Duong dan day du tinh tu goc scope, va so doan can di de toi vi tri con tro.
  const usesAlias = !!alias && root.name === alias;
  const fullPath = usesAlias ? path : [root.name, ...path];
  const rootMember = fullPath[0];
  if (!rootMember) {
    return { targets: [], query: root.name, reason: 'Khong xac dinh duoc property' };
  }

  const depth = onRoot && !usesAlias ? 1 : depthAt(node, offset, usesAlias);
  const members = deps.findSymbols(rootMember, container);
  if (!members.length) {
    return {
      targets: [],
      query: rootMember,
      reason: `Khong tim thay '${rootMember}' tren scope cua '${container}'`,
    };
  }

  // Di theo shape de nhay thang vao khoa long nhau khi biet duoc.
  const targets = members.map((m) => {
    const walked = walkShape(deps, m, fullPath.slice(1, Math.max(depth, 1)));
    return {
      path: m.path,
      span: walked.span ?? m.span,
      kind: walked.span ? 'shape-property' : 'scope-member',
      detail: walked.span
        ? `${fullPath.slice(0, walked.depth + 1).join('.')} tren scope cua ${container}`
        : walked.partial
          ? `${rootMember} tren scope cua ${container} (khong suy duoc shape cua '${fullPath[walked.depth] ?? ''}')`
          : `scope-member '${rootMember}' cua ${container}`,
      confidence: walked.partial ? ('medium' as const) : m.confidence,
    };
  });

  return { query: fullPath.slice(0, Math.max(depth, 1)).join('.'), targets };
}

/**
 * Go-to-definition trong mot thuoc tinh chua duoc phan giai o Layer 2
 * (`kbm-file="onFilePicked($file)"`, `<cityos-dha data="CTX">`).
 * Can bang directive cua Linker nen chi lam duoc o day, khong lam duoc luc trich fact.
 */
function candidateDefinition(
  deps: FactSource,
  relPath: string,
  offset: number,
  facts: TemplateFacts,
): DefinitionResult {
  // Con tro dat ngay tren CHO KHAI BAO mot bien cuc bo — `section` trong
  // `ng-repeat="section in sections"`. Day khong phai loi: no la dinh nghia.
  // Tra ve chinh no thay vi bao "khong nam trong bieu thuc Angular".
  for (const expr of facts.expressions) {
    for (const frame of expr.scopeChain) {
      for (const local of frame.locals) {
        if (local.span.start === local.span.end) continue; // bien dung san ($index…)
        if (!inSpan(local.span, offset)) continue;
        return {
          query: local.name,
          targets: [
            {
              path: relPath,
              span: local.span,
              kind: frame.kind === 'repeat' ? 'repeat-var' : 'init-var',
              detail: local.collection
                ? `Bien vong lap tren '${local.collection.root}' (day la cho khai bao)`
                : `Bien cuc bo cua template (day la cho khai bao)`,
              confidence: 'high',
            },
          ],
        };
      }
    }
  }

  for (const cand of facts.attrCandidates) {
    // Con tro tren TEN thuoc tinh -> nhay toi khai bao directive.
    if (inSpan(cand.attrSpan, offset)) {
      const rows = deps.findSymbols(cand.attr, null);
      if (rows.length) return { query: cand.attr, targets: symbolTargets(rows, 'directive') };
      return { targets: [], query: cand.attr, reason: `Khong tim thay directive '${cand.attr}'` };
    }

    if (!inSpan(cand.valueSpan, offset)) continue;

    const program = tryParseExpression(cand.value, cand.valueSpan.start);
    if (!program) break;
    const node = nodeAt(program, offset);
    if (!node) break;
    const { root } = unwind(node);
    if (!root) break;
    if (cand.locals.includes(root.name) || root.name.startsWith('$')) {
      return {
        targets: [],
        query: root.name,
        reason: `'${root.name}' la bien cuc bo do directive dua vao`,
      };
    }
    if (!cand.container) {
      return { targets: [], query: root.name, reason: 'Khong ro controller bao quanh' };
    }
    const rows = deps.findSymbols(root.name, cand.container);
    if (rows.length) return { query: root.name, targets: symbolTargets(rows, 'scope-member') };
    return {
      targets: [],
      query: root.name,
      reason: `Khong tim thay '${root.name}' tren scope cua '${cand.container}'`,
    };
  }

  // Con tro tren the custom: `<cityos-dha>` -> khai bao component
  for (const el of facts.customElements) {
    if (!inSpan(el.span, offset)) continue;
    const rows = deps.findSymbols(el.tag, null);
    if (rows.length) return { query: el.tag, targets: symbolTargets(rows, 'directive') };
  }

  return { targets: [], query: '', reason: 'Vi tri khong nam trong bieu thuc Angular' };
}

/**
 * Go-to-definition ben trong file .js.
 *
 * Thu tu uu tien:
 *   1. `$scope.foo` / `this.foo`  -> property tren scope cua controller bao quanh
 *   2. Ten duoc inject (DI)       -> khai bao Angular, roi moi toi tham so ham
 *   3. Khai bao Angular cung ten  -> .service/.factory/.controller/...
 *   4. Khai bao JavaScript thuan  -> var/let/const/function/tham so, theo pham vi
 *   5. Bien toan cuc              -> bao la dung san, KHONG phai loi
 *   6. Chuoi trong dau nhay       -> ten controller / event / view
 */
function jsDefinition(deps: FactSource, relPath: string, offset: number): DefinitionResult {
  const source = deps.source(relPath);
  if (!source) return { targets: [], query: '', reason: 'Khong doc duoc file' };

  const word = wordAt(source, offset);
  if (!word) return { targets: [], query: '', reason: 'Khong co dinh danh tai vi tri nay' };

  const facts = deps.facts(relPath);
  const jsFacts = facts?.kind === 'js' ? facts : null;

  // 1. `$scope.foo` / `this.foo` — property tren scope.
  const owner = jsFacts && declarationAround(jsFacts, offset);
  if (owner && isMemberOfScopeObject(source, word.span.start)) {
    const rows = deps.findSymbols(word.text, owner);
    if (rows.length) return { query: word.text, targets: symbolTargets(rows, 'scope-member') };
  }

  // Chi lay khai bao Angular THAT SU. `findSymbols` con tra ve ca 'js-global'
  // va 'bridge' cung ten, va neu de lot thi mot `const aocs` toan cuc o file
  // khac se chen len truoc `.factory("aocs")` — sai thu tu uu tien.
  const angular = deps.findSymbols(word.text, null).filter((r) => ANGULAR_DECL_KINDS.has(r.kind));
  const binding = jsFacts ? resolveBinding(jsFacts.bindings, word.text, offset) : null;

  const bindingTarget = binding
    ? [
        {
          path: relPath,
          span: binding.span,
          kind: binding.kind,
          detail: `${binding.kind} '${binding.name}'`,
          confidence: 'high' as const,
        },
      ]
    : [];

  // 2. Ten duoc inject: tham so ham la cau tra loi dung ve tu vung, nhung
  //    cai nguoi dung muon xem la NOI DINH NGHIA service. Dat Angular len truoc.
  const isInjected =
    binding?.kind === 'param' &&
    !!jsFacts?.declarations.some((d) => d.deps.some((dep) => dep.name === word.text));

  if (angular.length && (isInjected || !binding)) {
    return {
      query: word.text,
      targets: [...symbolTargets(angular, 'declaration'), ...bindingTarget],
    };
  }

  // 3./4. Khai bao JavaScript thuan.
  if (binding) {
    return {
      query: word.text,
      targets: [...bindingTarget, ...symbolTargets(angular, 'declaration')],
    };
  }

  // 5. Khai bao o pham vi file KHAC (global kieu <script> tag).
  const globals = deps.findSymbols(word.text, null).filter((r) => r.kind === 'js-global' && r.path !== relPath);
  if (globals.length) {
    return { query: word.text, targets: symbolTargets(globals, 'js-global') };
  }

  // 6. Bien toan cuc cua trinh duyet, hoac module Angular do nen tang cap
  //    (`myApp`) — khong co khai bao trong repo, va khong phai loi.
  if (JS_GLOBALS.has(word.text) || deps.moduleAliases.includes(word.text)) {
    return {
      targets: [],
      query: word.text,
      reason: `'${word.text}' la bien toan cuc dung san`,
      builtin: true,
    };
  }

  // 7. Chuoi trong dau nhay: ten controller / ten event / ten view.
  const quoted = quotedStringAt(source, offset);
  if (quoted) {
    const hits = deps.findSymbols(quoted.text, null);
    if (hits.length) return { query: quoted.text, targets: symbolTargets(hits, 'declaration') };
  }

  return { targets: [], query: word.text, reason: `Khong tim thay khai bao cho '${word.text}'` };
}

/** Khai bao Angular (controller/service/...) bao quanh mot offset. */
function declarationAround(facts: JsFacts, offset: number): string | null {
  let best: { name: string; size: number } | null = null;
  for (const d of facts.declarations) {
    if (offset < d.bodySpan.start || offset > d.bodySpan.end) continue;
    const size = d.bodySpan.end - d.bodySpan.start;
    if (!best || size < best.size) best = { name: d.name, size };
  }
  return best?.name ?? null;
}

function symbolTargets(rows: SymbolRow[], fallbackKind: string): DefinitionResult['targets'] {
  return rows.map((r) => ({
    path: r.path,
    span: r.span,
    kind: r.kind || fallbackKind,
    detail: r.container ? `${r.kind} '${r.name}' cua ${r.container}` : `${r.kind} '${r.name}'`,
    confidence: r.confidence,
  }));
}

/**
 * Con tro dang dat tren doan thu may cua chuoi `a.b.c`?
 * Tra ve 1 cho 'a', 2 cho 'b', 3 cho 'c'. Voi controllerAs (`vm.a.b`) doan
 * dau tien la alias nen khong tinh.
 */
function depthAt(node: Expr, offset: number, usesAlias: boolean): number {
  const segs: Array<{ span: Span }> = [];
  let cur: Expr = node;
  for (;;) {
    if (cur.type === 'MemberExpression') {
      if (!cur.computed && cur.property.type === 'Identifier') segs.unshift(cur.property);
      cur = cur.object;
      continue;
    }
    if (cur.type === 'CallExpression') {
      cur = cur.callee;
      continue;
    }
    break;
  }
  if (cur.type === 'Identifier') segs.unshift(cur);

  const idx = segs.findIndex((sg) => inSpan(sg.span, offset));
  const oneBased = idx === -1 ? segs.length : idx + 1;
  return usesAlias ? Math.max(oneBased - 1, 1) : oneBased;
}

/** Dinh danh nay co phai property cua `$scope` / `this` khong? */
function isMemberOfScopeObject(source: string, start: number): boolean {
  const before = source.slice(Math.max(0, start - 40), start);
  return /(?:\$scope|this|[A-Za-z_$][\w$]*)\s*\.\s*$/.test(before);
}

function quotedStringAt(source: string, offset: number): { text: string; span: Span } | null {
  for (const quote of ['"', "'"]) {
    const start = source.lastIndexOf(quote, offset);
    if (start === -1) continue;
    const end = source.indexOf(quote, offset === start ? offset + 1 : offset);
    if (end === -1) continue;
    const line = source.lastIndexOf('\n', offset);
    if (start < line) continue;
    return { text: source.slice(start + 1, end), span: { start: start + 1, end } };
  }
  return null;
}
