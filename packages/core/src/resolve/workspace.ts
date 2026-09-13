import { readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import fg from 'fast-glob';
import type { AttrCandidate, Config, FileFacts, ScopeFrame, Span, TemplateExpression, TemplateFacts } from '../types';
import { DEFAULT_CONFIG } from '../types';
import { extractJs } from '../extract/js';
import { extractTemplate } from '../extract/template';
import { hashContent, IndexStore, type SymbolRow } from '../index/store';
import { INDEX_FILENAME, PARSER_VERSION } from '../index/schema';
import { aliasOf, controllerOf, findLocal, type RefInput } from './rows';
import { nearestRows, preferNearest } from './rename';
import { collectReferenceOffsets } from '../extract/bindings';
import { parseJsTolerant } from '../extract/js-common';
import { Linker } from './linker';
import { tryParseExpression } from '../ng/parser';
import { nodeAt, unwind, type Expr } from '../ng/ast';
import { resolveDefinition } from './definition';
import { type FactSource, shapeAtPath, shapeOf } from './shape';
import {
  prepareRenameAt as doPrepareRenameAt,
  renameAt as doRenameAt,
  type RenameSource,
} from './rename-orchestrator';

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
  /**
   * File cung khai bao ten nay nhung o thu muc XA hon, da bi loai khoi `targets`
   * (xem preferNearest). Giu lai de hover va CLI con chi ra duoc — khong giau ban nao.
   */
  otherFiles?: string[];
}

export type RenameEdit = Location & { newText: string };

export interface RenameResult {
  /** Ten cu. */
  query: string;
  edits: RenameEdit[];
  /** File khai bao controller cung ten nhung co tinh KHONG sua. */
  untouched: string[];
  /** Thong bao cho nguoi dung khi controller bi khai bao o nhieu file. */
  note?: string;
  /** Co khi khong doi ten duoc — khi do `edits` rong. */
  reason?: string;
}

export interface CompletionEntry {
  name: string;
  kind: 'variable' | 'property';
  detail: string;
}

export type PrepareRenameResult = { span: Span; placeholder: string } | { reason: string };

export interface IndexProgress {
  total: number;
  done: number;
  path: string;
}

export interface RefreshResult {
  /** File doc lai tu dia vi noi dung doi (ke ca file moi khi phai quet lai). */
  indexed: number;
  /** File go khoi index: da xoa, hoac nam trong thu muc bi xoa. */
  removed: number;
  /** Co file/thu muc moi -> da chay index() de ap include/exclude dung nhu luc quet. */
  rescanned: boolean;
  ms: number;
}

export const TEMPLATE_EXT = /\.(ejs|html|htm)$/i;
export const JS_EXT = /\.js$/i;

/** Loai file theo duoi; null = khong index. */
function kindOf(path: string): 'js' | 'template' | null {
  return TEMPLATE_EXT.test(path) ? 'template' : JS_EXT.test(path) ? 'js' : null;
}

export class Workspace implements FactSource, RenameSource {
  readonly config: Config;
  private store: IndexStore;
  /** Noi dung dang mo trong editor, de len tren noi dung tren dia. */
  private overlays = new Map<string, string>();
  private overlayFacts = new Map<string, FileFacts>();
  private linker = new Linker();

  /** FactSource.moduleAliases — dung cho definition resolution (packages/core/src/resolve/definition.ts). */
  get moduleAliases(): string[] {
    return this.config.moduleAliases;
  }

  /** FactSource.findSymbols — dung cho definition/shape resolution ben ngoai class. */
  findSymbols(name: string, container: string | null): SymbolRow[] {
    return this.store.findSymbols(name, container);
  }

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
      // Mot thu muc khong doc duoc khong duoc phep lam hong CA lan index (xem hasCandidates).
      suppressErrors: true,
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

      const kind = kindOf(rel);
      if (!kind) return;

      const facts = this.extractFacts(kind, source);

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

  /**
   * Cap nhat index cho cac duong dan client bao la doi tren dia (workspace/didChangeWatchedFiles):
   * git pull, checkout, tool khac.
   *
   * Index la lop "dia" va KHONG dung toi overlay: buffer dang mo van la nguon cho chinh file do
   * (`facts()`/`source()` doc overlay truoc). Nhung index phai theo dia de tra loi dung cho file
   * KHAC — VSCode tu nap lai buffer chua sua khi file doi tren dia, va template dang mo phai thay
   * ngay property moi cua controller.
   *
   * Khong dua vao loai su kien (Created/Changed/Deleted) ma doc trang thai that tren dia: su kien
   * co the bi gop, lap, hoac den sai thu tu. So theo HASH chu khong theo mtime nhu index(): file da
   * duoc bao la doi thi dang doc, con mtime co the giu nguyen (rsync -t, tar, cp -p; HFS+ chi phan
   * giai 1 giay).
   */
  refreshFiles(relPaths: string[]): RefreshResult {
    const t0 = Date.now();
    const stamps = this.store.loadFileStamps();
    const upserts: Parameters<IndexStore['upsertBatch']>[0] = [];
    const removed = new Set<string>();
    const deletedDirs: string[] = [];
    let rescan = false;

    for (const rel of new Set(relPaths)) {
      if (!rel || /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)) continue; // ngoai workspace
      const abs = join(this.config.root, rel);
      let st: Stats | null = null;
      try {
        st = statSync(abs);
      } catch (err) {
        // CHI ENOENT/ENOTDIR moi nghia la "da xoa". Loi khac (EACCES, EIO, volume roi ra) nghia la
        // KHONG BIET — bo qua path, tuyet doi khong go mot file dang ton tai khoi index.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') continue;
      }

      if (!st?.isFile()) {
        if (st?.isDirectory()) {
          // Thu muc con day thi file cua no cung con — khong go gi. Chi index() moi biet file moi
          // nao ben trong thuoc include.
          if (this.hasCandidates(rel, true)) rescan = true;
        } else if (stamps.has(rel)) {
          removed.add(rel);
        } else if (kindOf(rel) === null) {
          // Khong con tren dia va khong mang duoi file duoc index -> co the la CA THU MUC bi xoa,
          // vi client chi bao MOT su kien cho chinh thu muc. Gom lai, quet mot lan sau vong lap.
          deletedDirs.push(rel);
        }
        continue;
      }

      const kind = kindOf(rel);
      if (!kind) continue;
      const prev = stamps.get(rel);
      if (!prev) {
        // File moi: include/exclude chi index() quyet dung duoc — cung bo glob voi luc quet.
        if (this.hasCandidates(rel, false)) rescan = true;
        continue;
      }

      let source: string;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const hash = hashContent(source);
      if (hash === prev.hash) continue;
      upserts.push({
        path: rel,
        kind,
        mtimeMs: st.mtimeMs,
        size: st.size,
        hash,
        facts: this.extractFacts(kind, source),
      });
    }

    // Mot lan duyet `stamps` cho MOI thu muc bi xoa, thay vi quet lai theo tung path: `rm -rf` hay
    // doi nhanh gui hang nghin su kien, ma moi lan quet la O(so file da index).
    if (deletedDirs.length) {
      const dirs = new Set(deletedDirs);
      for (const p of stamps.keys()) {
        for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
          if (dirs.has(p.slice(0, i))) {
            removed.add(p);
            break;
          }
        }
      }
    }

    this.store.upsertBatch(upserts);
    this.store.deleteFiles([...removed]);

    if (rescan) {
      const r = this.index();
      return {
        indexed: upserts.length + r.indexed,
        removed: removed.size + r.removed,
        rescanned: true,
        ms: Date.now() - t0,
      };
    }
    // Sua mot controller khong can parse lai template nao — chi noi lai (Layer 4).
    if (upserts.length || removed.size) this.link();
    return { indexed: upserts.length, removed: removed.size, rescanned: false, ms: Date.now() - t0 };
  }

  /**
   * Duong dan moi co file nao CO THE vao index khong: dung duoi, khong bi `exclude`. Exclude ap
   * bang chinh fast-glob (khong tu viet lai luat glob), voi thu muc chi duyet cay con cua no.
   * Include de index() quyet.
   */
  private hasCandidates(relPath: string, isDir: boolean): boolean {
    const pattern = fg.escapePath(relPath) + (isDir ? '/**' : '');
    return fg
      .sync(pattern, {
        cwd: this.config.root,
        ignore: this.config.exclude,
        onlyFiles: true,
        dot: false,
        // Mac dinh cua fast-glob la NEM loi (EACCES…). Mot thu muc khong doc duoc ma lam hong ca
        // lo cap nhat thi te hon nhieu so voi viec coi nhu no khong co ung vien nao.
        suppressErrors: true,
      })
      .some((p) => kindOf(p) !== null);
  }

  private extractFacts(kind: 'js' | 'template', source: string): FileFacts {
    return kind === 'js' ? extractJs(source, this.config) : extractTemplate(source, this.config);
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

  /**
   * Glob can theo doi de biet FILE NAO doi noi dung (dang duoc index).
   *
   * Bo cac mau phu dinh `!…` cua `config.include` — chung loai tru khoi tap hop can index
   * (xem `index()`, dung chung voi `fast-glob`), khong phai mau can dang ky watcher rieng.
   * Chi Workspace moi biet ngu nghia `include`/`exclude`; server (LSP) chi goi ham nay,
   * khong tu doc `config.include` roi doan.
   */
  changeWatchPatterns(): string[] {
    return this.config.include.filter((p) => !p.startsWith('!'));
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

  /** Go-to-definition. Thuat toan chinh: packages/core/src/resolve/definition.ts. */
  definitionAt(relPath: string, offset: number): DefinitionResult {
    return preferNearest(relPath, resolveDefinition(this, relPath, offset));
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
      const hit = expressionAt(facts, offset);
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

  // ---------------------------------------------------------------- rename

  /**
   * Doi ten mot property tren $scope, dong bo ra moi template dung no.
   *
   * Edit tinh tren noi dung HIEN TAI cua file (buffer dang mo, roi toi dia) va
   * trich fact lai ngay luc do, khong dung fact trong index: index co the cu hon
   * file, ma mot span lech mot ky tu la sua hong code nguoi dung.
   *
   * Gap BAT KY xung dot nao thi tu choi ca lan doi ten, khong sua mot phan: doi
   * ten do dang con te hon khong doi.
   */
  /** Doi ten mot property tren $scope, dong bo qua ca JS lan template. Thuat toan chinh: packages/core/src/resolve/rename-orchestrator.ts. */
  renameAt(relPath: string, offset: number, newName: string): RenameResult {
    return doRenameAt(this, relPath, offset, newName);
  }

  /**
   * Buoc hoi truoc cua rename (LSP textDocument/prepareRename): con tro co nam tren
   * thu doi ten duoc khong, va ten hien tai de IDE dien san vao o nhap.
   */
  prepareRenameAt(relPath: string, offset: number): PrepareRenameResult {
    return doPrepareRenameAt(this, relPath, offset);
  }

  /** RenameSource.openTemplatePaths — template dang mo (overlay) nhung chua co trong index. */
  openTemplatePaths(): string[] {
    return [...this.overlays.keys()].filter((p) => TEMPLATE_EXT.test(p));
  }

  /** RenameSource.resolveScopeRefs — boc Linker, khong lo Linker ra ngoai Workspace. */
  resolveScopeRefs(candidates: AttrCandidate[]): RefInput[] {
    return this.linker.resolveCandidates(candidates);
  }

  /** Symbol khong ai dung — ung vien dead code. */
  unused(): SymbolRow[] {
    return this.store.unusedSymbols(['controller', 'filter', 'directive', 'service', 'factory', 'scope-member']);
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

  /** Goi y tai mot vi tri trong template. */
  completionAt(relPath: string, offset: number): CompletionEntry[] {
    const facts = this.facts(relPath);
    const source = this.source(relPath);
    if (!facts || facts.kind !== 'template' || source === null) return [];

    // Bieu thuc dang go do (`{{ busy. }}`) khong parse duoc nen extractor bo han no.
    // Chen mot dinh danh gia vao dung con tro roi trich lai: bieu thuc thanh hop le, va
    // node chua dinh danh do cho biet nguoi dung dang go sau chuoi property nao.
    const patched = source.slice(0, offset) + COMPLETION_DUMMY + source.slice(offset);
    const hit = expressionAt(extractTemplate(patched, this.config), offset);
    if (hit) {
      if (hit.node.type === 'Literal') return []; // dang go trong chuoi
      const { root, path } = unwind(hit.node);
      if (root && path.at(-1)?.includes(COMPLETION_DUMMY)) {
        return this.memberCompletions(relPath, root.name, path.slice(0, -1), hit.expr.scopeChain);
      }
      return this.rootCompletions(relPath, hit.expr.scopeChain);
    }

    // Chen xong van khong parse duoc (`{{ a | }}`): lay chuoi scope cua bieu thuc goc.
    for (const expr of facts.expressions) {
      if (offset >= expr.span.start && offset <= expr.span.end + 1) {
        return this.rootCompletions(relPath, expr.scopeChain);
      }
    }

    // Chua co bieu thuc nao (vua go '{{', chua dong): dung controller gan nhat.
    const enclosing = facts.controllers
      .filter((c) => inSpan(c.elementSpan, offset))
      .sort((a, b) => b.elementSpan.start - a.elementSpan.start)[0];
    if (!enclosing) return [];
    return this.rootCompletions(relPath, [
      {
        kind: 'controller',
        controllerName: enclosing.name,
        alias: enclosing.alias,
        locals: [],
        elementSpan: enclosing.elementSpan,
      },
    ]);
  }

  /** Goi y o vi tri dinh danh goc: bien cuc bo cua template + property tren scope. */
  private rootCompletions(from: string, chain: ScopeFrame[]): CompletionEntry[] {
    const out: CompletionEntry[] = [];
    for (const frame of chain) {
      for (const local of frame.locals) {
        out.push({ name: local.name, kind: 'variable', detail: `bien ${frame.kind} cua template` });
      }
    }
    const container = controllerOf(chain);
    if (container) {
      for (const row of this.membersOf(container, from)) {
        out.push({ name: row.name, kind: 'property', detail: `tren $scope cua ${container}` });
      }
    }
    const seen = new Set<string>();
    return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }

  /**
   * Goi y sau dau cham, di theo shape suy tu object literal:
   *   `busy.`    -> khoa cua $scope.busy
   *   `section.` -> khoa cua PHAN TU trong $scope.sections (bien ng-repeat)
   */
  private memberCompletions(
    from: string,
    rootName: string,
    path: string[],
    chain: ScopeFrame[],
  ): CompletionEntry[] {
    const container = controllerOf(chain);
    if (!container) return [];

    const local = findLocal(rootName, chain);
    if (local && !local.collection) return [];
    const member = local?.collection?.root ?? rootName;
    const owner = [rootName, ...path].join('.');

    const out = new Map<string, CompletionEntry>();
    for (const row of nearestRows(from, this.store.findSymbols(member, container))) {
      let shape = shapeOf(this, row) ?? undefined;
      if (local?.collection) {
        shape = shapeAtPath(shape, local.collection.path);
        shape = shape?.kind === 'array' ? shape.element : undefined;
      }
      shape = shapeAtPath(shape, path);
      if (shape?.kind !== 'object' || !shape.props) continue;
      for (const [name, prop] of Object.entries(shape.props)) {
        out.set(name, { name, kind: 'property', detail: `khoa cua ${owner} (${prop.kind})` });
      }
    }
    return [...out.values()];
  }

  /** Property tren $scope cua mot controller. `from`: chi lay ban gan file do nhat (phu luc K). */
  membersOf(controllerName: string, from?: string): SymbolRow[] {
    const rows = this.store
      .findSymbolsByKind('scope-member')
      .filter((s) => s.container === controllerName);
    return from === undefined ? rows : nearestRows(from, rows);
  }
}

/** Dinh danh gia chen vao con tro de bieu thuc dang go do parse duoc (xem completionAt). */
const COMPLETION_DUMMY = '__ejsngCursor__';

/** Tim bieu thuc chua offset, va node nho nhat trong bieu thuc do. */
export function expressionAt(
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

/** Cac `kind` la khai bao Angular that su (khong ke js-global, bridge, event…). */
export const ANGULAR_DECL_KINDS = new Set([
  'controller', 'service', 'factory', 'provider',
  'directive', 'filter', 'component', 'value', 'constant',
]);

export function inSpan(span: Span, offset: number): boolean {
  return offset >= span.start && offset <= span.end;
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
