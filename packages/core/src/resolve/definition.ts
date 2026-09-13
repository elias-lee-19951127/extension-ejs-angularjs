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
 * Go-to-definition at a position in an already-indexed .js or .ejs file.
 *
 * Resolution order in a template (docs/kien-truc.md section 5.2):
 *   1. a local variable of the template (ng-repeat / ng-init) -> jump within the same file
 *   2. a controllerAs alias -> the controller's declaration
 *   3. a property on $scope / this of the enclosing controller
 *   4. filter / directive / service
 *
 * Does NOT filter down to the "nearest copy" when a name is declared in multiple files
 * — that's `Workspace.definitionAt`'s job (it calls `preferNearest` after calling this).
 */
export function resolveDefinition(deps: FactSource, relPath: string, offset: number): DefinitionResult {
  const facts = deps.facts(relPath);
  if (!facts) return { targets: [], query: '', reason: 'File has not been indexed' };

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
  // ng-controller="Name" -> jump to the controller's declaration
  for (const c of facts.controllers) {
    if (inSpan(c.span, offset)) {
      return {
        query: c.name,
        targets: symbolTargets(deps.findSymbols(c.name, null), 'controller'),
      };
    }
  }

  // A filter name: `{{ x | money }}` -> .filter('money', ...)
  // Must be checked BEFORE resolving scope, because a filter name also sits inside the
  // expression's span but is not a property on scope.
  for (const expr of facts.expressions) {
    for (const f of expr.filters) {
      if (!inSpan(f.span, offset)) continue;
      if (BUILTIN_FILTERS.includes(f.name)) {
        return {
          targets: [],
          query: f.name,
          reason: `'${f.name}' is a built-in AngularJS filter`,
        };
      }
      const rows = deps.findSymbols(f.name, null).filter((r) => r.kind === 'filter');
      if (rows.length) return { query: f.name, targets: symbolTargets(rows, 'filter') };
      return { targets: [], query: f.name, reason: `Filter '${f.name}' not found` };
    }
  }

  const hit = expressionAt(facts, offset);
  if (!hit) return candidateDefinition(deps, relPath, offset, facts);

  const { expr, node } = hit;
  const { root, path } = unwind(node);
  if (!root) return { targets: [], query: '', reason: 'Could not determine the identifier' };

  // A variable injected by Angular ($event, $index…) — has no definition in user code,
  // and this is NOT an error.
  // Applies to the WHOLE property path too: `$event.keyCode` also has no definition in
  // user code, not just `$event` alone.
  if (NG_INJECTED_VARS.includes(root.name) || SCOPE_BUILTINS.includes(root.name)) {
    const full = path.length ? `${root.name}.${path.join('.')}` : root.name;
    return {
      targets: [],
      query: full,
      reason: `'${root.name}' is a built-in variable of AngularJS`,
      builtin: true,
    };
  }

  // Is the cursor on the root identifier itself, or on a property further along?
  const onRoot = inSpan(root.span, offset);
  const alias = aliasOf(expr.scopeChain);
  const container = controllerOf(expr.scopeChain);

  // 1. A local variable of the template (ng-repeat / ng-init)
  const local = findLocal(root.name, expr.scopeChain);
  if (local) {
    // 1a. Cursor on the variable itself -> jump to its declaration site in the template
    if (onRoot) {
      return {
        query: root.name,
        targets: [
          {
            path: relPath,
            span: local.span,
            kind: local.frame.kind === 'repeat' ? 'repeat-var' : 'init-var',
            detail: `Local variable of the template (${local.frame.kind})`,
            confidence: 'high',
          },
        ],
      };
    }

    // 1b. Cursor on A PROPERTY of the local variable: `section.id`.
    //     Walk from the collection expression (`sections`) down into the element
    //     shape, then look up the key. Without this branch, `{{ section.icon }}`
    //     wouldn't jump anywhere — yet that's one of the most common expression shapes
    //     in an Angular template.
    if (local.collection && container) {
      const depth = depthAt(node, offset, false);
      const rest = path.slice(0, Math.max(depth - 1, 1));
      const members = deps.findSymbols(local.collection.root, container);

      if (members.length) {
        // `sections` is an array -> walkShape automatically steps into the element shape.
        const full = [...local.collection.path, ...rest];
        const targets = members.map((m) => {
          const walked = walkShape(deps, m, full);
          // The name in `detail` must be the segment ACTUALLY reached: walking halfway
          // and then printing the whole path asked for would be a lie — the same
          // reason `confidence` is dropped to medium right below.
          const reached = rest.slice(0, Math.max(walked.depth - local.collection!.path.length, 0));
          return {
            path: m.path,
            span: walked.span ?? m.span,
            kind: walked.span ? 'shape-property' : 'scope-member',
            detail: walked.span
              ? `${[root.name, ...reached].join('.')} — element of ${local.collection!.root}`
              : `${local.collection!.root} (could not infer the element shape)`,
            // `medium` = could NOT walk the shape to the requested key, not "not sure
            // this is the right target." When the path is walked fully, the symbol's own
            // confidence is kept.
            confidence: walked.partial ? ('medium' as const) : m.confidence,
          };
        });
        return { query: `${root.name}.${rest.join('.')}`, targets };
      }
    }

    return {
      targets: [],
      query: root.name,
      reason: `'${root.name}' is a local variable of the template; could not infer a shape to resolve the property`,
    };
  }

  // 2. controllerAs alias
  if (onRoot && alias && root.name === alias) {
    if (!container) return { targets: [], query: alias, reason: 'Unknown controller' };
    return {
      query: container,
      targets: symbolTargets(deps.findSymbols(container, null), 'controller'),
    };
  }

  // 3. A property on the controller — may be a nested property (`busy.search`).
  if (!container) {
    return {
      targets: [],
      query: root.name,
      reason: 'No enclosing ng-controller found — the controller is unknown',
    };
  }

  // Full path counted from the scope root, and how many segments to walk to reach the cursor.
  const usesAlias = !!alias && root.name === alias;
  const fullPath = usesAlias ? path : [root.name, ...path];
  const rootMember = fullPath[0];
  if (!rootMember) {
    return { targets: [], query: root.name, reason: 'Could not determine the property' };
  }

  const depth = onRoot && !usesAlias ? 1 : depthAt(node, offset, usesAlias);
  const members = deps.findSymbols(rootMember, container);
  if (!members.length) {
    return {
      targets: [],
      query: rootMember,
      reason: `'${rootMember}' not found on the scope of '${container}'`,
    };
  }

  // Walk the shape to jump straight into a nested key when it's known.
  const targets = members.map((m) => {
    const walked = walkShape(deps, m, fullPath.slice(1, Math.max(depth, 1)));
    return {
      path: m.path,
      span: walked.span ?? m.span,
      kind: walked.span ? 'shape-property' : 'scope-member',
      detail: walked.span
        ? `${fullPath.slice(0, walked.depth + 1).join('.')} on the scope of ${container}`
        : walked.partial
          ? `${rootMember} on the scope of ${container} (could not infer the shape of '${fullPath[walked.depth] ?? ''}')`
          : `scope-member '${rootMember}' of ${container}`,
      confidence: walked.partial ? ('medium' as const) : m.confidence,
    };
  });

  return { query: fullPath.slice(0, Math.max(depth, 1)).join('.'), targets };
}

/**
 * Go-to-definition inside an attribute not resolved at Layer 2
 * (`kbm-file="onFilePicked($file)"`, `<cityos-dha data="CTX">`).
 * Needs the Linker's directive table so can only be done here, not while extracting facts.
 */
function candidateDefinition(
  deps: FactSource,
  relPath: string,
  offset: number,
  facts: TemplateFacts,
): DefinitionResult {
  // Cursor sitting right on the DECLARATION SITE of a local variable — `section` in
  // `ng-repeat="section in sections"`. This is not an error: it IS the definition.
  // Return it directly instead of reporting "not inside an Angular expression".
  for (const expr of facts.expressions) {
    for (const frame of expr.scopeChain) {
      for (const local of frame.locals) {
        if (local.span.start === local.span.end) continue; // a built-in variable ($index…)
        if (!inSpan(local.span, offset)) continue;
        return {
          query: local.name,
          targets: [
            {
              path: relPath,
              span: local.span,
              kind: frame.kind === 'repeat' ? 'repeat-var' : 'init-var',
              detail: local.collection
                ? `Loop variable over '${local.collection.root}' (this is the declaration site)`
                : `Local variable of the template (this is the declaration site)`,
              confidence: 'high',
            },
          ],
        };
      }
    }
  }

  for (const cand of facts.attrCandidates) {
    // Cursor on the ATTRIBUTE NAME -> jump to the directive's declaration.
    if (inSpan(cand.attrSpan, offset)) {
      const rows = deps.findSymbols(cand.attr, null);
      if (rows.length) return { query: cand.attr, targets: symbolTargets(rows, 'directive') };
      return { targets: [], query: cand.attr, reason: `Directive '${cand.attr}' not found` };
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
        reason: `'${root.name}' is a local variable introduced by the directive`,
      };
    }
    if (!cand.container) {
      return { targets: [], query: root.name, reason: 'No enclosing controller found' };
    }
    const rows = deps.findSymbols(root.name, cand.container);
    if (rows.length) return { query: root.name, targets: symbolTargets(rows, 'scope-member') };
    return {
      targets: [],
      query: root.name,
      reason: `'${root.name}' not found on the scope of '${cand.container}'`,
    };
  }

  // Cursor on a custom element: `<cityos-dha>` -> the component's declaration
  for (const el of facts.customElements) {
    if (!inSpan(el.span, offset)) continue;
    const rows = deps.findSymbols(el.tag, null);
    if (rows.length) return { query: el.tag, targets: symbolTargets(rows, 'directive') };
  }

  return { targets: [], query: '', reason: 'This position is not inside an Angular expression' };
}

/**
 * Go-to-definition inside a .js file.
 *
 * Priority order:
 *   1. `$scope.foo` / `this.foo`  -> a property on the scope of the enclosing controller
 *   2. An injected name (DI)      -> the Angular declaration, then the function parameter
 *   3. An Angular declaration under the same name -> .service/.factory/.controller/...
 *   4. A plain JavaScript declaration -> var/let/const/function/parameter, by scope
 *   5. A global variable          -> reported as built-in, NOT an error
 *   6. A string in quotes         -> a controller/event/view name
 */
function jsDefinition(deps: FactSource, relPath: string, offset: number): DefinitionResult {
  const source = deps.source(relPath);
  if (!source) return { targets: [], query: '', reason: 'Could not read the file' };

  const word = wordAt(source, offset);
  if (!word) return { targets: [], query: '', reason: 'No identifier at this position' };

  const facts = deps.facts(relPath);
  const jsFacts = facts?.kind === 'js' ? facts : null;

  // 1. `$scope.foo` / `this.foo` — a property on scope.
  const owner = jsFacts && declarationAround(jsFacts, offset);
  if (owner && isMemberOfScopeObject(source, word.span.start)) {
    const rows = deps.findSymbols(word.text, owner);
    if (rows.length) return { query: word.text, targets: symbolTargets(rows, 'scope-member') };
  }

  // Only accept REAL Angular declarations. `findSymbols` also returns 'js-global' and
  // 'bridge' entries under the same name, and letting one slip through would put a
  // global `const aocs` from another file ahead of `.factory("aocs")` — the wrong
  // priority order.
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

  // 2. An injected name: the function parameter is the lexically correct answer, but
  //    what the user wants to see is WHERE THE SERVICE IS DEFINED. Put Angular first.
  const isInjected =
    binding?.kind === 'param' &&
    !!jsFacts?.declarations.some((d) => d.deps.some((dep) => dep.name === word.text));

  if (angular.length && (isInjected || !binding)) {
    return {
      query: word.text,
      targets: [...symbolTargets(angular, 'declaration'), ...bindingTarget],
    };
  }

  // 3./4. A plain JavaScript declaration.
  if (binding) {
    return {
      query: word.text,
      targets: [...bindingTarget, ...symbolTargets(angular, 'declaration')],
    };
  }

  // 5. A declaration at file scope in ANOTHER file (a global via <script> tags).
  const globals = deps.findSymbols(word.text, null).filter((r) => r.kind === 'js-global' && r.path !== relPath);
  if (globals.length) {
    return { query: word.text, targets: symbolTargets(globals, 'js-global') };
  }

  // 6. A built-in browser global, or an Angular module alias provided by the platform
  //    (`myApp`) — no declaration in the repo, and this is NOT an error.
  if (JS_GLOBALS.has(word.text) || deps.moduleAliases.includes(word.text)) {
    return {
      targets: [],
      query: word.text,
      reason: `'${word.text}' is a built-in global variable`,
      builtin: true,
    };
  }

  // 7. A string in quotes: a controller name / event name / view name.
  const quoted = quotedStringAt(source, offset);
  if (quoted) {
    const hits = deps.findSymbols(quoted.text, null);
    if (hits.length) return { query: quoted.text, targets: symbolTargets(hits, 'declaration') };
  }

  return { targets: [], query: word.text, reason: `No declaration found for '${word.text}'` };
}

/** The Angular declaration (controller/service/...) enclosing an offset. */
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
    detail: r.container ? `${r.kind} '${r.name}' of ${r.container}` : `${r.kind} '${r.name}'`,
    confidence: r.confidence,
  }));
}

/**
 * Which segment of the chain `a.b.c` is the cursor sitting on?
 * Returns 1 for 'a', 2 for 'b', 3 for 'c'. With controllerAs (`vm.a.b`) the first
 * segment is the alias, so it doesn't count.
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

/** Is this identifier a property of `$scope` / `this`? */
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
