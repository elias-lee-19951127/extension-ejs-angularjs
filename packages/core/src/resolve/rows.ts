import type { Axis, Confidence, FileFacts, ScopeFrame, Span, TemplateFacts } from '../types';
import { BUILTIN_FILTERS, SCOPE_BUILTINS } from '../ng/normalize';

export interface SymbolInput {
  kind: string;
  name: string;
  container: string | null;
  confidence: Confidence;
  span: Span;
}
export interface RefInput {
  name: string;
  container: string | null;
  axis: Axis;
  span: Span;
}

/**
 * Turn the facts of ONE file into symbol/ref rows.
 *
 * Still a pure function of that file's facts: a template ref's `container` is only filled
 * in when the controller is declared RIGHT IN that file (ng-controller). When the
 * controller comes from a route/DDO in another file, it's left null, and the Linker joins
 * it at query time.
 */
export function factsToRows(facts: FileFacts): { symbols: SymbolInput[]; refs: RefInput[] } {
  return facts.kind === 'js' ? jsRows(facts) : templateRows(facts);
}

function jsRows(facts: Extract<FileFacts, { kind: 'js' }>) {
  const symbols: SymbolInput[] = [];
  const refs: RefInput[] = [];

  for (const d of facts.declarations) {
    if (d.inline) continue; // its scope members still count, below
    symbols.push({
      kind: d.kind,
      name: d.name,
      container: null,
      confidence: d.confidence,
      span: d.nameSpan,
    });
    // An injected dependency is a reference to another service/factory.
    for (const dep of d.deps) {
      if (dep.name.startsWith('$')) continue; // built-in Angular service
      refs.push({ name: dep.name, container: null, axis: 'ng-di', span: dep.span });
    }
    // A binding is a member of the controller that owns the template's scope: `$ctrl.user` in a
    // component's template, `user` in an isolate directive's.
    for (const [name, span] of Object.entries(d.ddo?.scopeBindingSpans ?? {})) {
      symbols.push({ kind: 'binding', name, container: d.ddo?.controllerName ?? d.name, confidence: 'high', span });
    }
    if (d.ddo?.controllerName) {
      refs.push({
        name: d.ddo.controllerName,
        container: null,
        axis: 'ng-scope',
        span: d.nameSpan,
      });
    }
  }

  for (const m of facts.scopeMembers) {
    symbols.push({
      kind: 'scope-member',
      name: m.name,
      container: m.owner,
      confidence: 'high',
      span: m.span,
    });
  }

  // A file-scope declaration is GLOBAL in the <script>-tag world: `DHA_STATUS` declared
  // in dha.const.js is used from dha.controller.js. This is the most common pattern in
  // Angular 1 codebases that don't use modules.
  for (const b of facts.bindings) {
    const isFileScope = b.scope.start === 0 || b.scope.end - b.scope.start > 100000;
    if (!isFileScope) continue;
    if (b.kind === 'param' || b.kind === 'catch') continue;
    symbols.push({
      kind: 'js-global',
      name: b.name,
      container: null,
      confidence: 'medium',
      span: b.span,
    });
  }

  for (const e of facts.events) {
    if (e.direction === 'on') {
      symbols.push({ kind: 'event', name: e.name, container: null, confidence: 'high', span: e.span });
    } else {
      refs.push({ name: e.name, container: null, axis: 'ng-event', span: e.span });
    }
  }

  for (const r of facts.renderCalls) {
    symbols.push({
      kind: 'view-locals',
      name: r.viewPath,
      container: null,
      confidence: 'high',
      span: r.span,
    });
    for (const key of r.localKeys) {
      symbols.push({
        kind: 'ejs-local',
        name: key,
        container: r.viewPath,
        confidence: 'high',
        span: r.span,
      });
    }
  }

  return { symbols, refs };
}

function templateRows(facts: TemplateFacts) {
  const symbols: SymbolInput[] = [];
  const refs: RefInput[] = [];

  for (const c of facts.controllers) {
    refs.push({ name: c.name, container: null, axis: 'ng-scope', span: c.span });
  }

  for (const expr of facts.expressions) {
    const ctx = controllerOf(expr.scopeChain);
    for (const root of expr.roots) {
      // A variable introduced by ng-repeat / ng-init is a LOCAL variable of the template,
      // not a property on the controller — it doesn't count as a cross-file ref.
      if (isLocal(root.name, expr.scopeChain)) continue;
      if (SCOPE_BUILTINS.includes(root.name)) continue;
      // For `vm.orders` (controllerAs), what needs resolving is 'orders', not 'vm'.
      const alias = aliasOf(expr.scopeChain);
      if (alias && root.name === alias && root.path.length > 0) {
        refs.push({ name: root.path[0]!, container: ctx, axis: 'ng-scope', span: root.span });
        continue;
      }
      refs.push({ name: root.name, container: ctx, axis: 'ng-scope', span: root.span });
    }
    for (const f of expr.filters) {
      if (BUILTIN_FILTERS.includes(f.name)) continue;
      refs.push({ name: f.name, container: null, axis: 'ng-filter', span: f.span });
    }
  }

  for (const el of facts.customElements) {
    refs.push({ name: el.tag, container: null, axis: 'ng-directive', span: el.span });
  }

  for (const l of facts.ejsLocals) {
    refs.push({ name: l.name, container: null, axis: 'ejs-locals', span: l.span });
  }
  for (const inc of facts.ejsIncludes) {
    refs.push({ name: inc.viewPath, container: null, axis: 'ejs-include', span: inc.span });
  }
  for (const b of facts.bridges) {
    symbols.push({
      kind: 'bridge',
      name: b.jsTarget,
      container: null,
      confidence: 'medium',
      span: b.span,
    });
  }

  return { symbols, refs };
}

export function controllerOf(chain: ScopeFrame[]): string | null {
  for (const f of chain) {
    if (f.kind === 'controller' && f.controllerName) return f.controllerName;
  }
  return null;
}

export function aliasOf(chain: ScopeFrame[]): string | undefined {
  for (const f of chain) {
    if (f.kind === 'controller' && f.alias) return f.alias;
  }
  return undefined;
}

export function isLocal(name: string, chain: ScopeFrame[]): boolean {
  for (const f of chain) {
    if (f.kind === 'controller') {
      // A controllerAs alias is not a local variable of the template
      if (f.alias === name) return false;
      continue;
    }
    if (f.locals.some((l) => l.name === name)) return true;
  }
  return false;
}

/** Find the scope frame that declares a local variable, with its declaration span and collection. */
export function findLocal(
  name: string,
  chain: ScopeFrame[],
): { frame: ScopeFrame; span: Span; collection?: { root: string; path: string[] } } | null {
  for (const f of chain) {
    if (f.kind === 'controller') continue;
    const hit = f.locals.find((l) => l.name === name);
    if (hit) return { frame: f, span: hit.span, collection: hit.collection };
  }
  return null;
}
