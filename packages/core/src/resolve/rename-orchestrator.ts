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
 * Nhung gi rename orchestration can doc/goi tren Workspace, khong hon.
 *
 * Rong hon `FactSource` (packages/core/src/resolve/shape.ts) vi rename dung ca directive
 * resolution (`resolveScopeRefs`, boc `Linker.resolveCandidates`) va can biet template nao
 * dang mo trong editor nhung CHUA duoc index (`openTemplatePaths`) — hai thu Workspace giu
 * kin (`linker`, `overlays`), khong the doc thang tu ben ngoai.
 */
export interface RenameSource {
  facts(relPath: string): FileFacts | null;
  source(relPath: string): string | null;
  config: Config;
  findSymbols(name: string, container: string | null): SymbolRow[];
  templatePaths(): string[];
  /** Template dang mo trong editor (overlay) nhung chua co trong index tren dia. */
  openTemplatePaths(): string[];
  /** Phan giai directive cho gia tri thuoc tinh Layer 2 chua ro (vd `kbm-file="onPick($file)"`). */
  resolveScopeRefs(candidates: AttrCandidate[]): RefInput[];
}

interface RenameEdits {
  edits: RenameEdit[];
  /** Ly do phai tu choi ca lan doi ten, kem vi tri. */
  conflicts: string[];
  /** Khong chan doi ten, nhung nguoi dung can biet (cho con sot phai kiem tay). */
  warnings: string[];
}

/** Doi ten mot property tren $scope, dong bo qua ca JS lan template. */
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
  // Kiem tren DUNG cac file se sua: ban sao khac gan property khong cuu duoc ban nay
  // neu o day no chi duoc doc (ke thua tu scope cha).
  if (!js.assigned) {
    return refuse(
      `Khong tim thay lan gan '${name}' tren scope cua '${controller}' trong ${scope.js.join(', ')} — co the ke thua tu scope cha`,
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
 * Buoc hoi truoc cua rename (LSP textDocument/prepareRename): con tro co nam tren
 * thu doi ten duoc khong, va ten hien tai de IDE dien san vao o nhap.
 */
export function prepareRenameAt(deps: RenameSource, relPath: string, offset: number): PrepareRenameResult {
  const target = renameTargetAt(deps, relPath, offset);
  if ('reason' in target) return { reason: target.reason };
  return { span: target.span, placeholder: target.name };
}

/** Property tren $scope nam duoi con tro, kem controller chua no. */
function renameTargetAt(
  deps: RenameSource,
  relPath: string,
  offset: number,
): { name: string; controller: string; span: Span } | { reason: string } {
  const source = deps.source(relPath);
  if (source === null) return { reason: 'Khong doc duoc file' };

  if (JS_EXT.test(relPath)) {
    for (const { decl, accesses, assigned } of scopeAccessesByDecl(source, deps.config)) {
      const hit = accesses.find((a) => inSpan(a.span, offset));
      if (!hit) continue;
      if (hit.name.startsWith('$')) {
        return { reason: `'${hit.name}' la thanh phan dung san cua $scope` };
      }
      // Chi doc ma khong gan o dau: co the la property cua scope CHA. Doi ten o day
      // ma khong doi o noi gan that thi code hong — tu choi.
      if (!assigned.has(hit.name) && !deps.findSymbols(hit.name, decl.name).length) {
        return {
          reason: `Khong tim thay lan gan '${hit.name}' tren scope cua '${decl.name}' — co the ke thua tu scope cha`,
        };
      }
      return { name: hit.name, controller: decl.name, span: hit.span };
    }
  } else if (TEMPLATE_EXT.test(relPath)) {
    return templateRenameTarget(deps, extractTemplate(source, deps.config), offset);
  }
  return { reason: 'Chi doi ten duoc property tren $scope (vi du $scope.busy)' };
}

/**
 * Trong template chi doi ten duoc DINH DANH GOC tro toi $scope cua controller bao
 * quanh. Bien cuc bo (ng-repeat), bien dung san ($event), controllerAs va property
 * long nhau (`busy.search`) deu bi tu choi kem ly do, khong doan.
 */
function templateRenameTarget(
  deps: RenameSource,
  facts: TemplateFacts,
  offset: number,
): { name: string; controller: string; span: Span } | { reason: string } {
  const hit = expressionAt(facts, offset);
  if (hit) {
    const { root } = unwind(hit.node);
    if (!root) return { reason: 'Khong xac dinh duoc dinh danh' };
    if (!inSpan(root.span, offset)) {
      return { reason: 'Chua ho tro doi ten property long nhau — dat con tro vao ten goc' };
    }
    const chain = hit.expr.scopeChain;
    if (findLocal(root.name, chain)) {
      return { reason: `'${root.name}' la bien cuc bo cua template, khong phai property tren $scope` };
    }
    if (NG_INJECTED_VARS.includes(root.name) || SCOPE_BUILTINS.includes(root.name)) {
      return { reason: `'${root.name}' la bien dung san cua AngularJS` };
    }
    if (aliasOf(chain) === root.name) return { reason: 'Chua ho tro doi ten qua controllerAs' };
    return scopeTarget(deps, root.name, controllerOf(chain), root.span);
  }

  // Gia tri thuoc tinh do Linker phan giai: `pick-file="onPick($file)"`.
  for (const cand of facts.attrCandidates) {
    if (!inSpan(cand.valueSpan, offset)) continue;
    const ref = deps.resolveScopeRefs([cand]).find((r) => r.axis === 'ng-scope' && inSpan(r.span, offset));
    if (ref) return scopeTarget(deps, ref.name, ref.container, ref.span);
  }
  return { reason: 'Vi tri khong nam tren property nao cua $scope' };
}

function scopeTarget(
  deps: RenameSource,
  name: string,
  controller: string | null,
  span: Span,
): { name: string; controller: string; span: Span } | { reason: string } {
  if (!controller) return { reason: 'Khong tim thay ng-controller bao quanh' };
  if (!deps.findSymbols(name, controller).length) {
    return { reason: `Khong tim thay '${name}' tren scope cua '${controller}'` };
  }
  return { name, controller, span };
}

/** File .js khai bao mot controller — co the nhieu file neu bi khai bao trung ten. */
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
            `'${newName}' da co tren scope cua '${controller}' (${path}:${lineOf(source, a.span.start)})`,
          );
        }
        if (a.name === oldName) out.edits.push({ path, span: a.span, newText: newName });
      }
    }
  }
  return out;
}

/** Template tu khai bao ng-controller X — chi o do moi co ref toi $scope cua X. */
function templatesUsing(deps: RenameSource, controller: string): string[] {
  const paths = new Set([...deps.templatePaths(), ...deps.openTemplatePaths()]);
  return [...paths].filter((p) => {
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
    const fresh = extractTemplate(source, deps.config);
    const where = (span: Span) => `${path}:${lineOf(source, span.start)}`;

    // Moi cho dung $scope cua controller nay: goc trong bieu thuc, va goc trong gia tri
    // thuoc tinh do Linker phan giai. `shadowed`: ten MOI co bi bien cuc bo che tai do.
    const sites: Array<{ name: string; span: Span; shadowed: boolean }> = [];
    for (const expr of fresh.expressions) {
      if (controllerOf(expr.scopeChain) !== controller) continue;
      for (const root of expr.roots) {
        if (isLocal(root.name, expr.scopeChain)) continue;
        sites.push({ name: root.name, span: root.span, shadowed: !!findLocal(newName, expr.scopeChain) });
      }
    }
    for (const cand of fresh.attrCandidates) {
      if (cand.container !== controller) continue;
      for (const r of deps.resolveScopeRefs([cand])) {
        if (r.axis !== 'ng-scope') continue;
        sites.push({ name: r.name, span: r.span, shadowed: cand.locals.includes(newName) });
      }
    }

    for (const site of sites) {
      if (site.name === newName) {
        out.conflicts.push(
          `'${newName}' da co tren scope cua '${controller}' — dang duoc dung tai ${where(site.span)}`,
        );
      }
      if (site.name !== oldName) continue;
      if (site.shadowed) {
        out.conflicts.push(`'${newName}' se bi bien cuc bo cua template che tai ${where(site.span)}`);
      }
      // Bat bien: span phai tro dung vao ten cu. Lech la bug Layer 2 — tu choi, khong sua hong.
      if (source.slice(site.span.start, site.span.end) !== oldName) {
        out.conflicts.push(`Span lech tai ${where(site.span)} — khong dam sua, xin bao loi`);
        continue;
      }
      out.edits.push({ path, span: site.span, newText: newName });
    }

    // Vung extractor da hieu. Cho nam trong do ma khong duoc doi (controller khac, bien
    // cuc bo, khoa object) la co chu y — chi bao nhung cho NGOAI cac vung nay.
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
        `${leftovers.length} cho chua '${oldName}' khong duoc hieu la bieu thuc Angular nen KHONG doi: ` +
          lines.map((l) => `${path}:${l}`).join(', ') +
          (emSpace ? ' — dong co ky tu U+2003, trinh duyet khong coi la khoang trang trong the' : ' — kiem tra tay'),
      );
    }
  }
  return out;
}
