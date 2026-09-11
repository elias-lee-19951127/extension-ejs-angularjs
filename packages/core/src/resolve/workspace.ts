import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import fg from 'fast-glob';
import type {
  Config,
  FileFacts,
  JsFacts,
  ScopeFrame,
  Span,
  TemplateExpression,
  TemplateFacts,
} from '../types';
import { DEFAULT_CONFIG } from '../types';
import { extractJs } from '../extract/js';
import { extractTemplate } from '../extract/template';
import { hashContent, IndexStore, type SymbolRow } from '../index/store';
import { INDEX_FILENAME, PARSER_VERSION } from '../index/schema';
import { aliasOf, controllerOf, findLocal } from './rows';
import { collectReferenceOffsets, JS_GLOBALS, resolveBinding } from '../extract/bindings';
import { parseJsTolerant } from '../extract/js-common';
import { Linker } from './linker';
import { tryParseExpression } from '../ng/parser';
import { nodeAt, unwind, type Expr } from '../ng/ast';
import { BUILTIN_FILTERS, NG_INJECTED_VARS, SCOPE_BUILTINS } from '../ng/normalize';

export interface Location {
  path: string;
  span: Span;
}

export interface DefinitionResult {
  targets: Array<Location & { kind: string; detail: string; confidence: string }>;
  /** Ten symbol dang duoc hoi — dung cho thong bao khi khong tim thay. */
  query: string;
  reason?: string;
  /**
   * true khi day la bien dung san cua AngularJS ($event, $index…).
   * Khong co dinh nghia de nhay toi, nhung CUNG KHONG PHAI LOI — diagnostics
   * phai bo qua, neu khong moi ng-click co $event deu bi gach do.
   */
  builtin?: boolean;
}

export interface IndexProgress {
  total: number;
  done: number;
  path: string;
}

const TEMPLATE_EXT = /\.(ejs|html|htm)$/i;
const JS_EXT = /\.js$/i;

export class Workspace {
  readonly config: Config;
  private store: IndexStore;
  /** Noi dung dang mo trong editor, de len tren noi dung tren dia. */
  private overlays = new Map<string, string>();
  private overlayFacts = new Map<string, FileFacts>();
  private linker = new Linker();

  constructor(config: Partial<Config> & { root: string }, dbPath?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = new IndexStore(dbPath ?? join(this.config.root, '.ejsng-cache', INDEX_FILENAME));
  }

  close(): void {
    this.store.close();
  }

  // ---------------------------------------------------------------- indexing

  /**
   * Danh index toan workspace.
   *
   * File chi duoc parse lai khi mtime HOAC hash HOAC parser_version lech.
   * So sanh hash chu khong chi mtime: `git checkout` doi mtime cua ca nghin file
   * ma noi dung phan lon khong doi.
   */
  index(onProgress?: (p: IndexProgress) => void): {
    indexed: number;
    skipped: number;
    removed: number;
    linkedRefs: number;
    ms: number;
  } {
    const t0 = Date.now();
    const files = fg.sync(this.config.include, {
      cwd: this.config.root,
      ignore: this.config.exclude,
      absolute: false,
      onlyFiles: true,
      dot: false,
    });

    const stamps = this.store.loadFileStamps();
    const seen = new Set<string>();
    const batch: Parameters<IndexStore['upsertBatch']>[0] = [];
    let indexed = 0;
    let skipped = 0;

    files.forEach((rel, i) => {
      seen.add(rel);
      const abs = join(this.config.root, rel);
      let st;
      try {
        st = statSync(abs);
      } catch {
        return;
      }

      const prev = stamps.get(rel);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.parserVersion === PARSER_VERSION) {
        skipped++;
        return;
      }

      let source: string;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        return;
      }

      const hash = hashContent(source);
      if (prev && prev.hash === hash && prev.parserVersion === PARSER_VERSION) {
        skipped++;
        return;
      }

      const kind = TEMPLATE_EXT.test(rel) ? 'template' : JS_EXT.test(rel) ? 'js' : null;
      if (!kind) return;

      const facts = kind === 'js' ? extractJs(source, this.config) : extractTemplate(source, this.config);

      batch.push({ path: rel, kind, mtimeMs: st.mtimeMs, size: st.size, hash, facts });
      indexed++;

      // Ghi theo lo 500: moi lan ghi keo theo mot lan dung lai bang tra nguoc,
      // nen gom lo re hon nhieu so voi ghi tung file.
      if (batch.length >= 500) {
        this.store.upsertBatch(batch.splice(0));
      }
      onProgress?.({ total: files.length, done: i + 1, path: rel });
    });

    if (batch.length) this.store.upsertBatch(batch);

    const removed = [...stamps.keys()].filter((p) => !seen.has(p));
    if (removed.length) this.store.deleteFiles(removed);

    const linkedRefs = this.link();

    return { indexed, skipped, removed: removed.length, linkedRefs, ms: Date.now() - t0 };
  }

  /**
   * Layer 4 — noi lai cac tham chieu can thong tin lien file.
   *
   * Re hon parse rat nhieu: chi doc lai fact da co san, khong dung toi parser.
   * Vi vay sua mot controller chi ton mot lan chay ham nay, khong phai
   * parse lai template nao.
   */
  link(): number {
    const all = this.store.allFacts();
    this.linker.loadDirectives(all);

    const entries: Array<{ path: string; refs: ReturnType<Linker['resolveCandidates']> }> = [];
    let total = 0;
    for (const { path, facts } of all) {
      if (facts.kind !== 'template') continue;
      const refs = this.linker.resolveCandidates(facts.attrCandidates);
      // The custom trung ten mot directive da biet -> tham chieu that.
      for (const el of facts.customElements) {
        if (this.linker.resolveElement(el.tag)) {
          refs.push({ name: el.tag, container: null, axis: 'ng-directive', span: el.span });
        }
      }
      if (refs.length) {
        entries.push({ path, refs });
        total += refs.length;
      }
    }
    this.store.replaceLinkedRefs(entries);
    return total;
  }

  /** Cap nhat mot file tu buffer trong editor, khong cham dia. */
  setOverlay(relPath: string, source: string): void {
    this.overlays.set(relPath, source);
    const kind = TEMPLATE_EXT.test(relPath) ? 'template' : 'js';
    const facts =
      kind === 'js' ? extractJs(source, this.config) : extractTemplate(source, this.config);
    this.overlayFacts.set(relPath, facts);
  }

  clearOverlay(relPath: string): void {
    this.overlays.delete(relPath);
    this.overlayFacts.delete(relPath);
  }

  /** Ghi overlay xuong index (goi khi save). */
  flushOverlay(relPath: string): void {
    const source = this.overlays.get(relPath);
    const facts = this.overlayFacts.get(relPath);
    if (!source || !facts) return;
    const abs = join(this.config.root, relPath);
    let mtimeMs = Date.now();
    let size = source.length;
    try {
      const st = statSync(abs);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      /* file moi chua ton tai tren dia */
    }
    this.store.upsertBatch([
      {
        path: relPath,
        kind: facts.kind === 'js' ? 'js' : 'template',
        mtimeMs,
        size,
        hash: hashContent(source),
        facts,
      },
    ]);
  }

  facts(relPath: string): FileFacts | null {
    return this.overlayFacts.get(relPath) ?? this.store.getFacts(relPath);
  }

  source(relPath: string): string | null {
    const overlay = this.overlays.get(relPath);
    if (overlay !== undefined) return overlay;
    try {
      return readFileSync(join(this.config.root, relPath), 'utf8');
    } catch {
      return null;
    }
  }

  toRelative(absPath: string): string {
    return relative(this.config.root, resolvePath(absPath));
  }

  stats(): Record<string, number> {
    return this.store.stats();
  }

  /**
   * Vi tri cua moi dinh danh o vi tri tham chieu trong mot file .js.
   * Dung cho lenh `sweep` de do do phu.
   */
  jsReferenceOffsets(relPath: string): number[] {
    const source = this.source(relPath);
    if (!source) return [];
    const ast = parseJsTolerant(source);
    return ast ? collectReferenceOffsets(ast) : [];
  }

  /** Duong dan tuong doi cua moi file .js da index. */
  jsPaths(): string[] {
    return this.store
      .allFacts()
      .filter((f) => f.facts.kind === 'js')
      .map((f) => f.path);
  }

  /** Duong dan tuong doi cua moi template da index. */
  templatePaths(): string[] {
    return this.store
      .allFacts()
      .filter((f) => f.facts.kind === 'template')
      .map((f) => f.path);
  }

  // -------------------------------------------------------------- queries

  /**
   * Go-to-definition.
   *
   * Thu tu resolve trong template (docs/kien-truc.md muc 5.2):
   *   1. bien cuc bo cua template (ng-repeat / ng-init) -> nhay trong cung file
   *   2. controllerAs alias -> khai bao controller
   *   3. property tren $scope / this cua controller dang bao quanh
   *   4. filter / directive / service
   */
  definitionAt(relPath: string, offset: number): DefinitionResult {
    const facts = this.facts(relPath);
    if (!facts) return { targets: [], query: '', reason: 'File chua duoc danh index' };

    if (facts.kind === 'template') return this.templateDefinition(relPath, offset, facts);
    return this.jsDefinition(relPath, offset);
  }

  private templateDefinition(relPath: string, offset: number, facts: TemplateFacts): DefinitionResult {
    // ng-controller="Ten" -> nhay toi khai bao controller
    for (const c of facts.controllers) {
      if (inSpan(c.span, offset)) {
        return {
          query: c.name,
          targets: this.symbolTargets(this.store.findSymbols(c.name, null), 'controller'),
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
        const rows = this.store.findSymbols(f.name, null).filter((r) => r.kind === 'filter');
        if (rows.length) return { query: f.name, targets: this.symbolTargets(rows, 'filter') };
        return { targets: [], query: f.name, reason: `Khong tim thay filter '${f.name}'` };
      }
    }

    const hit = this.expressionAt(facts, offset);
    if (!hit) return this.candidateDefinition(relPath, offset, facts);

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
        const members = this.store.findSymbols(local.collection.root, container);

        if (members.length) {
          // `sections` la mang -> walkShape tu dong di vao shape phan tu.
          const full = [...local.collection.path, ...rest];
          const targets = members.map((m) => {
            const walked = this.walkShape(m, full);
            return {
              path: m.path,
              span: walked.span ?? m.span,
              kind: walked.span ? 'shape-property' : 'scope-member',
              detail: walked.span
                ? `${root.name}.${rest.join('.')} — phan tu cua ${local.collection!.root}`
                : `${local.collection!.root} (khong suy duoc shape phan tu)`,
              confidence: walked.span ? m.confidence : ('medium' as const),
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
        targets: this.symbolTargets(this.store.findSymbols(container, null), 'controller'),
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
    const members = this.store.findSymbols(rootMember, container);
    if (!members.length) {
      return {
        targets: [],
        query: rootMember,
        reason: `Khong tim thay '${rootMember}' tren scope cua '${container}'`,
      };
    }

    // Di theo shape de nhay thang vao khoa long nhau khi biet duoc.
    const targets = members.map((m) => {
      const walked = this.walkShape(m, fullPath.slice(1, Math.max(depth, 1)));
      return {
        path: m.path,
        span: walked.span ?? m.span,
        kind: walked.span ? 'shape-property' : 'scope-member',
        detail: walked.span
          ? `${fullPath.slice(0, walked.depth + 1).join('.')} tren scope cua ${container}`
          : walked.partial
            ? `${rootMember} tren scope cua ${container} (khong suy duoc shape cua '${fullPath[walked.depth] ?? ''}')`
            : `scope-member '${rootMember}' cua ${container}`,
        confidence: walked.span ? m.confidence : ('medium' as const),
      };
    });

    return { query: fullPath.slice(0, Math.max(depth, 1)).join('.'), targets };
  }

  /**
   * Di theo duong dan property tren shape da suy luan.
   *
   * Tra ve span cua khoa sau cung tim duoc. Khi khong di het duong dan (vi du
   * `$scope.stats = res.data` — shape unknown), tra ve `partial: true` va nguoi dung
   * van duoc nhay toi khai bao goc thay vi nhan mot thong bao "khong tim thay".
   * Nhay gan dung van huu ich hon la khong nhay.
   */
  private walkShape(
    member: SymbolRow,
    rest: string[],
  ): { span?: Span; depth: number; partial: boolean } {
    if (!rest.length) return { depth: 0, partial: false };

    const facts = this.facts(member.path);
    if (!facts || facts.kind !== 'js') return { depth: 0, partial: true };
    const sm = facts.scopeMembers.find(
      (m) => m.span.start === member.span.start && m.name === member.name,
    );
    if (!sm) return { depth: 0, partial: true };

    let shape = sm.shape;
    let lastSpan: Span | undefined;
    let depth = 0;
    for (const seg of rest) {
      if (shape.kind === 'array' && shape.element) shape = shape.element;
      const next = shape.kind === 'object' ? shape.props?.[seg] : undefined;
      if (!next) return { span: lastSpan, depth, partial: true };
      shape = next;
      lastSpan = next.span;
      depth++;
    }
    return { span: lastSpan, depth, partial: false };
  }

  /**
   * Go-to-definition trong mot thuoc tinh chua duoc phan giai o Layer 2
   * (`kbm-file="onFilePicked($file)"`, `<cityos-dha data="CTX">`).
   * Can bang directive cua Linker nen chi lam duoc o day, khong lam duoc luc trich fact.
   */
  private candidateDefinition(
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
        const rows = this.store.findSymbols(cand.attr, null);
        if (rows.length) return { query: cand.attr, targets: this.symbolTargets(rows, 'directive') };
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
      const rows = this.store.findSymbols(root.name, cand.container);
      if (rows.length) return { query: root.name, targets: this.symbolTargets(rows, 'scope-member') };
      return {
        targets: [],
        query: root.name,
        reason: `Khong tim thay '${root.name}' tren scope cua '${cand.container}'`,
      };
    }

    // Con tro tren the custom: `<cityos-dha>` -> khai bao component
    for (const el of facts.customElements) {
      if (!inSpan(el.span, offset)) continue;
      const rows = this.store.findSymbols(el.tag, null);
      if (rows.length) return { query: el.tag, targets: this.symbolTargets(rows, 'directive') };
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
  private jsDefinition(relPath: string, offset: number): DefinitionResult {
    const source = this.source(relPath);
    if (!source) return { targets: [], query: '', reason: 'Khong doc duoc file' };

    const word = wordAt(source, offset);
    if (!word) return { targets: [], query: '', reason: 'Khong co dinh danh tai vi tri nay' };

    const facts = this.facts(relPath);
    const jsFacts = facts?.kind === 'js' ? facts : null;

    // 1. `$scope.foo` / `this.foo` — property tren scope.
    const owner = jsFacts && this.declarationAround(jsFacts, offset);
    if (owner && isMemberOfScopeObject(source, word.span.start)) {
      const rows = this.store.findSymbols(word.text, owner);
      if (rows.length) return { query: word.text, targets: this.symbolTargets(rows, 'scope-member') };
    }

    // Chi lay khai bao Angular THAT SU. `findSymbols` con tra ve ca 'js-global'
    // va 'bridge' cung ten, va neu de lot thi mot `const aocs` toan cuc o file
    // khac se chen len truoc `.factory("aocs")` — sai thu tu uu tien.
    const angular = this.store
      .findSymbols(word.text, null)
      .filter((r) => ANGULAR_DECL_KINDS.has(r.kind));
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
        targets: [...this.symbolTargets(angular, 'declaration'), ...bindingTarget],
      };
    }

    // 3./4. Khai bao JavaScript thuan.
    if (binding) {
      return {
        query: word.text,
        targets: [...bindingTarget, ...this.symbolTargets(angular, 'declaration')],
      };
    }

    // 5. Khai bao o pham vi file KHAC (global kieu <script> tag).
    const globals = this.store
      .findSymbols(word.text, null)
      .filter((r) => r.kind === 'js-global' && r.path !== relPath);
    if (globals.length) {
      return { query: word.text, targets: this.symbolTargets(globals, 'js-global') };
    }

    // 6. Bien toan cuc cua trinh duyet, hoac module Angular do nen tang cap
    //    (`myApp`) — khong co khai bao trong repo, va khong phai loi.
    if (JS_GLOBALS.has(word.text) || this.config.moduleAliases.includes(word.text)) {
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
      const hits = this.store.findSymbols(quoted.text, null);
      if (hits.length) return { query: quoted.text, targets: this.symbolTargets(hits, 'declaration') };
    }

    return { targets: [], query: word.text, reason: `Khong tim thay khai bao cho '${word.text}'` };
  }

  /** Khai bao Angular (controller/service/...) bao quanh mot offset. */
  private declarationAround(facts: JsFacts, offset: number): string | null {
    let best: { name: string; size: number } | null = null;
    for (const d of facts.declarations) {
      if (offset < d.bodySpan.start || offset > d.bodySpan.end) continue;
      const size = d.bodySpan.end - d.bodySpan.start;
      if (!best || size < best.size) best = { name: d.name, size };
    }
    return best?.name ?? null;
  }

  /**
   * Find-all-references. Tra ve moi noi dung symbol, ca trong template lan trong JS.
   */
  referencesAt(relPath: string, offset: number): { query: string; locations: Array<Location & { axis: string }> } {
    const facts = this.facts(relPath);
    if (!facts) return { query: '', locations: [] };

    let name: string | null = null;
    let container: string | null = null;

    if (facts.kind === 'js') {
      const source = this.source(relPath);
      if (!source) return { query: '', locations: [] };

      // Con tro tren `$scope.foo` / `this.foo` -> tim ref theo (foo, controller chua no)
      const member = facts.scopeMembers.find((m) => inSpan(m.span, offset));
      if (member) {
        name = member.name;
        container = member.owner;
      } else {
        const decl = facts.declarations.find((d) => inSpan(d.nameSpan, offset));
        if (decl) name = decl.name;
        else {
          const w = wordAt(source, offset);
          name = w?.text ?? null;
        }
      }
    } else {
      const hit = this.expressionAt(facts, offset);
      if (hit) {
        const { root, path } = unwind(hit.node);
        const alias = aliasOf(hit.expr.scopeChain);
        container = controllerOf(hit.expr.scopeChain);
        name = root ? (alias && root.name === alias ? (path[0] ?? root.name) : root.name) : null;
      } else {
        const c = facts.controllers.find((x) => inSpan(x.span, offset));
        if (c) name = c.name;
      }
    }

    if (!name) return { query: '', locations: [] };

    const rows = container
      ? [...this.store.findRefs(name, container), ...this.store.findRefs(name, null)]
      : this.store.findRefs(name);

    const seen = new Set<string>();
    const locations: Array<Location & { axis: string }> = [];
    for (const r of rows) {
      const key = `${r.path}:${r.span.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ path: r.path, span: r.span, axis: r.axis });
    }
    return { query: name, locations };
  }

  /** Symbol khong ai dung — ung vien dead code. */
  unused(): SymbolRow[] {
    return this.store.unusedSymbols(['controller', 'filter', 'directive', 'service', 'factory', 'scope-member']);
  }

  /** Tim bieu thuc chua offset, va node nho nhat trong bieu thuc do. */
  private expressionAt(
    facts: TemplateFacts,
    offset: number,
  ): { expr: TemplateExpression; node: Expr } | null {
    for (const expr of facts.expressions) {
      if (!inSpan(expr.span, offset)) continue;
      const program = tryParseExpression(expr.text, expr.span.start);
      if (!program) continue;
      const node = nodeAt(program, offset);
      if (node) return { expr, node };
    }
    return null;
  }

  private symbolTargets(rows: SymbolRow[], fallbackKind: string) {
    return rows.map((r) => ({
      path: r.path,
      span: r.span,
      kind: r.kind || fallbackKind,
      detail: r.container ? `${r.kind} '${r.name}' cua ${r.container}` : `${r.kind} '${r.name}'`,
      confidence: r.confidence,
    }));
  }

  /** Chuoi scope tai mot vi tri — dung cho hover va completion. */
  scopeChainAt(relPath: string, offset: number): ScopeFrame[] | null {
    const facts = this.facts(relPath);
    if (!facts || facts.kind !== 'template') return null;
    for (const expr of facts.expressions) {
      if (inSpan(expr.span, offset)) return expr.scopeChain;
    }
    return null;
  }

  /** Cac property co the goi y tai mot vi tri trong template. */
  completionAt(relPath: string, offset: number): Array<{ name: string; kind: string; detail: string }> {
    const facts = this.facts(relPath);
    if (!facts || facts.kind !== 'template') return [];

    let chain: ScopeFrame[] | null = null;
    for (const expr of facts.expressions) {
      if (offset >= expr.span.start && offset <= expr.span.end + 1) chain = expr.scopeChain;
    }
    if (!chain) {
      // Chua co bieu thuc nao o day (nguoi dung vua go '{{'): dung controller gan nhat.
      const enclosing = facts.controllers
        .filter((c) => inSpan(c.elementSpan, offset))
        .sort((a, b) => b.elementSpan.start - a.elementSpan.start)[0];
      if (!enclosing) return [];
      chain = [{ kind: 'controller', controllerName: enclosing.name, alias: enclosing.alias, locals: [], elementSpan: enclosing.elementSpan }];
    }

    const out: Array<{ name: string; kind: string; detail: string }> = [];
    for (const frame of chain) {
      for (const local of frame.locals) {
        out.push({ name: local.name, kind: 'variable', detail: `bien ${frame.kind} cua template` });
      }
    }

    const container = controllerOf(chain);
    if (container) {
      for (const row of this.membersOf(container)) {
        out.push({
          name: row.name,
          kind: 'property',
          detail: `tren $scope cua ${container}`,
        });
      }
    }

    const seen = new Set<string>();
    return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }

  membersOf(controllerName: string): SymbolRow[] {
    return this.store
      .findSymbolsByKind('scope-member')
      .filter((s) => s.container === controllerName);
  }
}

/** Cac `kind` la khai bao Angular that su (khong ke js-global, bridge, event…). */
const ANGULAR_DECL_KINDS = new Set([
  'controller', 'service', 'factory', 'provider',
  'directive', 'filter', 'component', 'value', 'constant',
]);

export function inSpan(span: Span, offset: number): boolean {
  return offset >= span.start && offset <= span.end;
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

const IDENT_CHAR = /[A-Za-z0-9_$]/;

export function wordAt(source: string, offset: number): { text: string; span: Span } | null {
  let start = offset;
  let end = offset;
  while (start > 0 && IDENT_CHAR.test(source[start - 1] ?? '')) start--;
  while (end < source.length && IDENT_CHAR.test(source[end] ?? '')) end++;
  if (start === end) return null;
  return { text: source.slice(start, end), span: { start, end } };
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
