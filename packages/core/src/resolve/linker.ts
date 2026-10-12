import type { AttrCandidate, FileFacts, NgDeclaration } from '../types';
import { tryParseExpression } from '../ng/parser';
import { collectRoots } from '../ng/ast';
import { SCOPE_BUILTINS } from '../ng/normalize';
import type { RefInput } from './rows';

export interface DirectiveInfo {
  name: string;
  ddo: NgDeclaration['ddo'];
  kind: 'directive' | 'component';
}

/**
 * Layer 4 — Linker.
 *
 * Runs AFTER every file has facts. Its only job: resolve things Layer 2 can't know
 * because they require looking at another file.
 *
 * Why this is a separate layer (docs/kien-truc.md section 3): per-file facts must stay
 * pure so caching works correctly. In exchange, every cross-file conclusion has to live
 * here. That's why fixing one controller does NOT require re-parsing any template — only
 * re-running this linking step.
 */
export class Linker {
  private directives = new Map<string, DirectiveInfo>();

  /** Load the directive/component table from the facts of the .js files. */
  loadDirectives(all: Array<{ path: string; facts: FileFacts }>): void {
    this.directives.clear();
    for (const { facts } of all) {
      if (facts.kind !== 'js') continue;
      for (const d of facts.declarations) {
        if (d.kind !== 'directive' && d.kind !== 'component') continue;
        this.directives.set(d.name, { name: d.name, ddo: d.ddo, kind: d.kind });
      }
    }
  }

  get directiveCount(): number {
    return this.directives.size;
  }

  /**
   * Resolve a template's unknown attributes into real references.
   *
   * Three cases are accepted:
   *  1. The attribute name matches a directive's name  -> `kbm-file="onFilePicked($file)"`
   *  2. The element is a directive/component, and the attribute name matches a binding
   *     in its isolate scope -> `<cityos-dha data="CTX">`
   *  3. The element is a known directive/component -> record a reference to it directly
   *
   * Outside these three cases, we do NOT guess: a bare `foo-bar="baz"` is ambiguous, and a
   * false positive is worse than a missed one.
   */
  resolveCandidates(candidates: AttrCandidate[]): RefInput[] {
    const refs: RefInput[] = [];

    for (const cand of candidates) {
      const asDirective = this.directives.get(cand.attr);
      const onDirective = this.directives.get(cand.tag);
      const isBinding =
        onDirective?.ddo?.scopeBindings && cand.attr in onDirective.ddo.scopeBindings;

      if (asDirective) {
        refs.push({
          name: cand.attr,
          container: null,
          axis: 'ng-directive',
          span: cand.attrSpan,
        });
      }

      if (!asDirective && !isBinding) continue;

      // The attribute value is an Angular expression — parse it and record its roots.
      const program = tryParseExpression(cand.value, cand.valueSpan.start);
      if (!program) continue;

      for (const root of collectRoots(program)) {
        // `on-toggle="vm.toggle(task)"`: the member is `toggle` of the controller `vm` names.
        const aliased = cand.aliases?.[root.name];
        if (aliased) {
          if (root.path[0]) refs.push({ name: root.path[0], container: aliased, axis: 'ng-scope', span: root.span });
          continue;
        }
        if (cand.locals.includes(root.name)) continue;
        if (SCOPE_BUILTINS.includes(root.name)) continue;
        // `$file`, `$event` are variables injected by the directive itself, not scope.
        if (root.name.startsWith('$')) continue;
        refs.push({
          name: root.name,
          container: cand.container,
          axis: 'ng-scope',
          span: root.span,
        });
      }
    }

    return refs;
  }

  /** Reference to a directive via a custom element: `<cityos-dha>`. */
  resolveElement(tag: string): boolean {
    return this.directives.has(tag);
  }
}
