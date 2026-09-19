import type { AttrCandidate, Config, FileFacts, Span, TemplateFacts } from '../types';
import type { SymbolRow } from '../index/store';
import type { RefInput } from './rows';
import { aliasOf, controllerOf, findLocal, isLocal } from './rows';
import type { PrepareRenameResult, RenameEdit, RenameResult } from './workspace';
import { ANGULAR_DECL_KINDS, JS_EXT, TEMPLATE_EXT, expressionAt, inSpan } from './workspace';
import { lineOf, newNameProblem, renameScope, scopeAccessesByDecl, unparsedOccurrences } from './rename';
import { extractTemplate } from '../extract/template';
import { unwind } from '../ng/ast';
import { NG_INJECTED_VARS, SCOPE_BUILTINS } from '../ng/normalize';

/**
 * What rename orchestration needs to read from / call on Workspace, nothing more.
 *
 * Wider than `FactSource` (packages/core/src/resolve/shape.ts) because rename also needs
 * directive resolution (`resolveScopeRefs`, wrapping `Linker.resolveCandidates`) and needs
 * to know which templates are open in the editor but NOT YET indexed (`openTemplatePaths`)
 * — two things Workspace keeps private (`linker`, `overlays`) and can't be read directly
 * from outside.
 */
export interface RenameSource {
  facts(relPath: string): FileFacts | null;
  source(relPath: string): string | null;
  config: Config;
  findSymbols(name: string, container: string | null): SymbolRow[];
  templatePaths(): string[];
  /** Templates open in the editor (overlay) but not yet in the on-disk index. */
  openTemplatePaths(): string[];
  /** Resolve a directive for a Layer-2-unresolved attribute value (e.g. `kbm-file="onPick($file)"`). */
  resolveScopeRefs(candidates: AttrCandidate[]): RefInput[];
  /** The controller a `templateUrl` elsewhere binds to this template, if any. */
  linkedController(relPath: string): string | null;
  /** `facts` with that binding joined into its scope chains — for facts extracted fresh, not via `facts()`. */
  bindTemplate(relPath: string, facts: TemplateFacts): TemplateFacts;
}

interface RenameEdits {
  edits: RenameEdit[];
  /** Reason the whole rename must be refused, with its location. */
  conflicts: string[];
  /** Doesn't block the rename, but the user should know (a gap to check by hand). */
  warnings: string[];
}

/** Rename a property on $scope, synchronized across both JS and templates. */
export function renameAt(deps: RenameSource, relPath: string, offset: number, newName: string): RenameResult {
  const target = renameTargetAt(deps, relPath, offset);
  if ('reason' in target) return { query: '', edits: [], untouched: [], reason: target.reason };

  const { name, controller } = target;
  const refuse = (reason: string): RenameResult => ({ query: name, edits: [], untouched: [], reason });

  const problem = newNameProblem(name, newName);
  if (problem) return refuse(problem);

  const declFiles = declarationFiles(deps, controller);
  if (JS_EXT.test(relPath) && !declFiles.includes(relPath)) declFiles.push(relPath);
  const scope = renameScope(relPath, declFiles, templatesUsing(deps, controller), controller);

  const js = jsRenameEdits(deps, scope.js, controller, name, newName);
  // Check against the EXACT files being changed: another copy assigning the property
  // doesn't save this one if here it's only ever read (inherited from a parent scope).
  if (!js.assigned) {
    return refuse(
      `Could not find an assignment to '${name}' on the scope of '${controller}' in ${scope.js.join(', ')} — it may be inherited from a parent scope`,
    );
  }
  const tpl = templateRenameEdits(deps, scope.templates, controller, name, newName);
  const conflict = [...js.conflicts, ...tpl.conflicts][0];
  if (conflict) return refuse(conflict);

  const notes = [scope.note, ...tpl.warnings].filter((n): n is string => !!n);
  return {
    query: name,
    edits: [...js.edits, ...tpl.edits],
    untouched: scope.untouched,
    note: notes.length ? notes.join('\n') : undefined,
  };
}

/**
 * The pre-check step of rename (LSP textDocument/prepareRename): is the cursor on
 * something renameable, and what's its current name so the IDE can pre-fill the input.
 */
export function prepareRenameAt(deps: RenameSource, relPath: string, offset: number): PrepareRenameResult {
  const target = renameTargetAt(deps, relPath, offset);
  if ('reason' in target) return { reason: target.reason };
  return { span: target.span, placeholder: target.name };
}

/** The property on $scope under the cursor, with the controller it belongs to. */
function renameTargetAt(
  deps: RenameSource,
  relPath: string,
  offset: number,
): { name: string; controller: string; span: Span } | { reason: string } {
  const source = deps.source(relPath);
  if (source === null) return { reason: 'Could not read the file' };

  if (JS_EXT.test(relPath)) {
    for (const { decl, accesses, assigned } of scopeAccessesByDecl(source, deps.config)) {
      const hit = accesses.find((a) => inSpan(a.span, offset));
      if (!hit) continue;
      if (hit.name.startsWith('$')) {
        return { reason: `'${hit.name}' is a built-in member of $scope` };
      }
      // Read but never assigned anywhere: might be a property of a PARENT scope.
      // Renaming here without renaming where it's actually assigned would break the code
      // — refuse.
      if (!assigned.has(hit.name) && !deps.findSymbols(hit.name, decl.name).length) {
        return {
          reason: `Could not find an assignment to '${hit.name}' on the scope of '${decl.name}' — it may be inherited from a parent scope`,
        };
      }
      return { name: hit.name, controller: decl.name, span: hit.span };
    }
  } else if (TEMPLATE_EXT.test(relPath)) {
    return templateRenameTarget(deps, extractTemplate(source, deps.config), offset);
  }
  return { reason: 'Only a property on $scope can be renamed (e.g. $scope.busy)' };
}

/**
 * In a template, only the ROOT identifier pointing at the $scope of the enclosing
 * controller can be renamed. A local variable (ng-repeat), a built-in variable ($event),
 * controllerAs, and a nested property (`busy.search`) are all refused with a reason,
 * never guessed.
 */
function templateRenameTarget(
  deps: RenameSource,
  facts: TemplateFacts,
  offset: number,
): { name: string; controller: string; span: Span } | { reason: string } {
  const hit = expressionAt(facts, offset);
  if (hit) {
    const { root } = unwind(hit.node);
    if (!root) return { reason: 'Could not determine the identifier' };
    if (!inSpan(root.span, offset)) {
      return { reason: 'Renaming a nested property is not supported yet — place the cursor on the root name' };
    }
    const chain = hit.expr.scopeChain;
    if (findLocal(root.name, chain)) {
      return { reason: `'${root.name}' is a local variable of the template, not a property on $scope` };
    }
    if (NG_INJECTED_VARS.includes(root.name) || SCOPE_BUILTINS.includes(root.name)) {
      return { reason: `'${root.name}' is a built-in variable of AngularJS` };
    }
    if (aliasOf(chain) === root.name) return { reason: 'Renaming through controllerAs is not supported yet' };
    return scopeTarget(deps, root.name, controllerOf(chain), root.span);
  }

  // An attribute value resolved by the Linker: `pick-file="onPick($file)"`.
  for (const cand of facts.attrCandidates) {
    if (!inSpan(cand.valueSpan, offset)) continue;
    const ref = deps.resolveScopeRefs([cand]).find((r) => r.axis === 'ng-scope' && inSpan(r.span, offset));
    if (ref) return scopeTarget(deps, ref.name, ref.container, ref.span);
  }
  return { reason: 'This position is not on any property of $scope' };
}

function scopeTarget(
  deps: RenameSource,
  name: string,
  controller: string | null,
  span: Span,
): { name: string; controller: string; span: Span } | { reason: string } {
  if (!controller) return { reason: 'No enclosing ng-controller found' };
  if (!deps.findSymbols(name, controller).length) {
    return { reason: `'${name}' not found on the scope of '${controller}'` };
  }
  return { name, controller, span };
}

/** The .js file(s) that declare a controller — can be several if declared under the same name more than once. */
function declarationFiles(deps: RenameSource, controller: string): string[] {
  const rows = deps.findSymbols(controller, null).filter((r) => ANGULAR_DECL_KINDS.has(r.kind));
  return [...new Set(rows.map((r) => r.path))];
}

function jsRenameEdits(
  deps: RenameSource,
  files: string[],
  controller: string,
  oldName: string,
  newName: string,
): RenameEdits & { assigned: boolean } {
  const out = { edits: [] as RenameEdit[], conflicts: [] as string[], warnings: [] as string[], assigned: false };
  for (const path of files) {
    const source = deps.source(path);
    if (source === null) continue;
    for (const { decl, accesses, assigned } of scopeAccessesByDecl(source, deps.config)) {
      if (decl.name !== controller) continue;
      if (assigned.has(oldName)) out.assigned = true;
      for (const a of accesses) {
        if (a.name === newName) {
          out.conflicts.push(
            `'${newName}' already exists on the scope of '${controller}' (${path}:${lineOf(source, a.span.start)})`,
          );
        }
        if (a.name === oldName) out.edits.push({ path, span: a.span, newText: newName });
      }
    }
  }
  return out;
}

/**
 * Templates declaring ng-controller X, or bound to X by a `templateUrl` — only there can a ref
 * to X's $scope exist.
 */
function templatesUsing(deps: RenameSource, controller: string): string[] {
  const paths = new Set([...deps.templatePaths(), ...deps.openTemplatePaths()]);
  return [...paths].filter((p) => {
    if (deps.linkedController(p) === controller) return true;
    const facts = deps.facts(p);
    return facts?.kind === 'template' && facts.controllers.some((c) => c.name === controller);
  });
}

function templateRenameEdits(
  deps: RenameSource,
  paths: string[],
  controller: string,
  oldName: string,
  newName: string,
): RenameEdits {
  const out: RenameEdits = { edits: [], conflicts: [], warnings: [] };
  for (const path of paths) {
    const source = deps.source(path);
    if (source === null) continue;
    const fresh = deps.bindTemplate(path, extractTemplate(source, deps.config));
    const linked = deps.linkedController(path);
    const where = (span: Span) => `${path}:${lineOf(source, span.start)}`;

    // Every place referencing this controller's $scope: a root inside an expression, and
    // a root inside an attribute value resolved by the Linker. `shadowed`: the NEW name
    // would be shadowed by a local variable at that site.
    const sites: Array<{ name: string; span: Span; shadowed: boolean }> = [];
    for (const expr of fresh.expressions) {
      if (controllerOf(expr.scopeChain) !== controller) continue;
      for (const root of expr.roots) {
        if (isLocal(root.name, expr.scopeChain)) continue;
        sites.push({ name: root.name, span: root.span, shadowed: !!findLocal(newName, expr.scopeChain) });
      }
    }
    for (const cand of fresh.attrCandidates) {
      // No ng-controller around it in this file: the template's own scope is the linked controller's.
      if ((cand.container ?? linked) !== controller) continue;
      for (const r of deps.resolveScopeRefs([cand])) {
        if (r.axis !== 'ng-scope') continue;
        sites.push({ name: r.name, span: r.span, shadowed: cand.locals.includes(newName) });
      }
    }

    for (const site of sites) {
      if (site.name === newName) {
        out.conflicts.push(
          `'${newName}' already exists on the scope of '${controller}' — already in use at ${where(site.span)}`,
        );
      }
      if (site.name !== oldName) continue;
      if (site.shadowed) {
        out.conflicts.push(`'${newName}' would be shadowed by a local variable of the template at ${where(site.span)}`);
      }
      // Invariant: the span must point exactly at the old name. A mismatch is a Layer-2
      // bug — refuse rather than making a broken edit.
      if (source.slice(site.span.start, site.span.end) !== oldName) {
        out.conflicts.push(`Span mismatch at ${where(site.span)} — refusing to edit, please report this`);
        continue;
      }
      out.edits.push({ path, span: site.span, newText: newName });
    }

    // The regions the extractor understood. A place inside them that was intentionally
    // not renamed (a different controller, a local variable, an object key) is not
    // reported — only places OUTSIDE these regions are.
    const parsed: Span[] = [
      ...fresh.expressions.map((e) => e.span),
      ...fresh.expressions.flatMap((e) => e.scopeChain.flatMap((f) => f.locals.map((l) => l.span))),
      ...fresh.attrCandidates.filter((c) => deps.resolveScopeRefs([c]).length).map((c) => c.valueSpan),
    ];
    const leftovers = unparsedOccurrences(source, oldName, parsed);
    if (leftovers.length) {
      const lines = [...new Set(leftovers.map((o) => lineOf(source, o)))];
      const emSpace = lines.some((l) => source.split('\n')[l - 1]?.includes(' '));
      out.warnings.push(
        `${leftovers.length} occurrence(s) of '${oldName}' were not recognized as an Angular expression and were NOT renamed: ` +
          lines.map((l) => `${path}:${l}`).join(', ') +
          (emSpace ? ' — the line contains a U+2003 character, which browsers do not treat as whitespace inside a tag' : ' — please check by hand'),
      );
    }
  }
  return out;
}
