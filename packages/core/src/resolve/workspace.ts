import { readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
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

/** Is `relPath` a normal in-workspace relative path — not `..`-escaping the root, not absolute? */
export function isWithinRoot(relPath: string): boolean {
  return Boolean(relPath) && !/^\.\.(?:[\\/]|$)/.test(relPath) && !isAbsolute(relPath);
}

/**
 * Resolve symlinks in `path`, for accurate containment comparisons when the workspace root (or
 * any ancestor directory) sits behind a symlink — common on macOS (`os.tmpdir()` itself:
 * `/var/folders/...` -> `/private/var/folders/...`), some `nvm`/`asdf` setups, or a directory
 * mounted through a symlink. `path.resolve` alone does NOT resolve symlinks, so comparing an
 * unresolved root against a REALPATH the runtime reports (V8/CDP report realpaths in stack
 * traces) never matches (ticket .scratch/inline-runtime-log/issues/12-symlinked-root-path-mismatch.md).
 *
 * Never throws: `fs.realpathSync` throws when `path` doesn't exist (a virtual/eval path CDP can
 * report, or a file not yet flushed to disk) — treated as "couldn't resolve", returning `path`
 * unchanged so the caller's existing "outside workspace" guard still applies safely.
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface Location {
  path: string;
  span: Span;
}

export interface DefinitionResult {
  targets: Array<Location & { kind: string; detail: string; confidence: string }>;
  /** The name of the symbol being queried — used for messages when nothing is found. */
  query: string;
  reason?: string;
  /**
   * true when this is a built-in AngularJS variable ($event, $index…).
   * Has no definition to jump to, but this is NOT AN ERROR — diagnostics must ignore it,
   * or every ng-click with $event would get flagged.
   */
  builtin?: boolean;
  /**
   * Files that also declare this name but in a FARTHER directory, already filtered out
   * of `targets` (see preferNearest). Kept so hover and the CLI can still point to them
   * — no copy is hidden.
   */
  otherFiles?: string[];
}

export type RenameEdit = Location & { newText: string };

export interface RenameResult {
  /** The old name. */
  query: string;
  edits: RenameEdit[];
  /** Files that declare the same-named controller but are intentionally NOT changed. */
  untouched: string[];
  /** Note to the user when the controller is declared in multiple files. */
  note?: string;
  /** Set when the rename couldn't be done — in that case `edits` is empty. */
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
  /** Files re-read from disk because their content changed (including new files that needed a rescan). */
  indexed: number;
  /** Files removed from the index: deleted, or under a deleted directory. */
  removed: number;
  /** Set when a new file/directory appeared -> ran index() to apply include/exclude exactly as at scan time. */
  rescanned: boolean;
  ms: number;
}

export const TEMPLATE_EXT = /\.(ejs|html|htm)$/i;
export const JS_EXT = /\.js$/i;

/** File kind by extension; null = not indexed. */
function kindOf(path: string): 'js' | 'template' | null {
  return TEMPLATE_EXT.test(path) ? 'template' : JS_EXT.test(path) ? 'js' : null;
}

export class Workspace implements FactSource, RenameSource {
  readonly config: Config;
  private store: IndexStore;
  /** Content currently open in the editor, layered on top of the on-disk content. */
  private overlays = new Map<string, string>();
  private overlayFacts = new Map<string, FileFacts>();
  private linker = new Linker();
  /**
   * `config.root` with symlinks resolved, computed once and cached — used ONLY for the
   * containment comparison in `toRelative`. `config.root` itself is left untouched everywhere
   * else (indexing, `source()`, URIs handed back to the editor): those must keep matching the
   * path the editor actually opened, not its resolved realpath.
   */
  private readonly resolvedRoot: string;

  /** FactSource.moduleAliases — used by definition resolution (packages/core/src/resolve/definition.ts). */
  get moduleAliases(): string[] {
    return this.config.moduleAliases;
  }

  /** FactSource.findSymbols — used by definition/shape resolution outside the class. */
  findSymbols(name: string, container: string | null): SymbolRow[] {
    return this.store.findSymbols(name, container);
  }

  constructor(config: Partial<Config> & { root: string }, dbPath?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resolvedRoot = safeRealpath(this.config.root);
    this.store = new IndexStore(dbPath ?? join(this.config.root, '.ejsng-cache', INDEX_FILENAME));
  }

  close(): void {
    this.store.close();
  }

  // ---------------------------------------------------------------- indexing

  /**
   * Index the whole workspace.
   *
   * A file is only re-parsed when its mtime OR hash OR parser_version differs. Compared
   * by hash, not just mtime: `git checkout` changes the mtime of thousands of files whose
   * content mostly hasn't changed.
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
      // An unreadable directory must not be allowed to break the WHOLE indexing run (see hasCandidates).
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

      // Written in batches of 500: each write triggers rebuilding the reverse lookup
      // table, so batching is far cheaper than writing file by file.
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
   * Layer 4 — join references that need cross-file information.
   *
   * Much cheaper than parsing: only reads facts already computed, never touches the
   * parser. So fixing one controller costs only one run of this function, never a
   * re-parse of any template.
   */
  link(): number {
    const all = this.store.allFacts();
    this.linker.loadDirectives(all);

    const entries: Array<{ path: string; refs: ReturnType<Linker['resolveCandidates']> }> = [];
    let total = 0;
    for (const { path, facts } of all) {
      if (facts.kind !== 'template') continue;
      const refs = this.linker.resolveCandidates(facts.attrCandidates);
      // A custom element matching a known directive's name -> a real reference.
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
   * Update the index for paths the client reports as changed on disk (workspace/didChangeWatchedFiles):
   * git pull, checkout, another tool.
   *
   * The index is the "disk" layer and does NOT use the overlay: an open buffer is still
   * the source of truth for its own file (`facts()`/`source()` read the overlay first).
   * But the index must follow disk to answer correctly for OTHER files — VSCode
   * auto-reloads an unmodified buffer when the file changes on disk, and an open template
   * must immediately see the controller's new property.
   *
   * Doesn't rely on the event kind (Created/Changed/Deleted), reads the actual state on
   * disk instead: events can be coalesced, duplicated, or arrive out of order. Compared
   * by HASH rather than mtime like index() does: a file reported as changed is read
   * regardless, while mtime can stay the same (rsync -t, tar, cp -p; HFS+ only resolves
   * to 1 second).
   */
  refreshFiles(relPaths: string[]): RefreshResult {
    const t0 = Date.now();
    const stamps = this.store.loadFileStamps();
    const upserts: Parameters<IndexStore['upsertBatch']>[0] = [];
    const removed = new Set<string>();
    const deletedDirs: string[] = [];
    let rescan = false;

    for (const rel of new Set(relPaths)) {
      if (!isWithinRoot(rel)) continue; // outside the workspace
      const abs = join(this.config.root, rel);
      let st: Stats | null = null;
      try {
        st = statSync(abs);
      } catch (err) {
        // ONLY ENOENT/ENOTDIR mean "deleted". Any other error (EACCES, EIO, the volume
        // dropping out) means we DON'T KNOW — skip the path, and never remove a file that
        // still exists from the index.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') continue;
      }

      if (!st?.isFile()) {
        if (st?.isDirectory()) {
          // The directory still exists, so its files still exist too — nothing to
          // remove. Only index() knows which new files inside it belong to include.
          if (this.hasCandidates(rel, true)) rescan = true;
        } else if (stamps.has(rel)) {
          removed.add(rel);
        } else if (kindOf(rel) === null) {
          // No longer on disk and doesn't carry an indexed extension -> may be a WHOLE
          // DIRECTORY that was deleted, since the client reports only ONE event for the
          // directory itself. Collect it, scan once after the loop.
          deletedDirs.push(rel);
        }
        continue;
      }

      const kind = kindOf(rel);
      if (!kind) continue;
      const prev = stamps.get(rel);
      if (!prev) {
        // A new file: only index() can decide correctly under include/exclude — using
        // the same glob as at scan time.
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

    // One pass over `stamps` for ALL deleted directories combined, instead of scanning
    // per path: `rm -rf` or a fast checkout sends thousands of events, and each scan is
    // O(number of indexed files).
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
    // Fixing one controller doesn't require re-parsing any template — only re-linking (Layer 4).
    if (upserts.length || removed.size) this.link();
    return { indexed: upserts.length, removed: removed.size, rescanned: false, ms: Date.now() - t0 };
  }

  /**
   * Could ANY file at this path end up in the index: right extension, not excluded.
   * Exclusion is applied by fast-glob itself (we don't reimplement glob rules), and for
   * a directory only its own subtree is walked. Inclusion is left for index() to decide.
   */
  private hasCandidates(relPath: string, isDir: boolean): boolean {
    const pattern = fg.escapePath(relPath) + (isDir ? '/**' : '');
    return fg
      .sync(pattern, {
        cwd: this.config.root,
        ignore: this.config.exclude,
        onlyFiles: true,
        dot: false,
        // fast-glob's default is to THROW on errors (EACCES…). An unreadable directory
        // breaking the whole update batch is far worse than treating it as having no
        // candidates.
        suppressErrors: true,
      })
      .some((p) => kindOf(p) !== null);
  }

  private extractFacts(kind: 'js' | 'template', source: string): FileFacts {
    return kind === 'js' ? extractJs(source, this.config) : extractTemplate(source, this.config);
  }

  /** Update a file from the editor's buffer, without touching disk. */
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

  /** Write the overlay down to the index (called on save). */
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
      /* a new file that doesn't exist on disk yet */
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

  /**
   * Symlink-aware: resolves symlinks on BOTH sides before comparing — `resolvedRoot` was already
   * cached at construction, `absPath` is resolved fresh every call since it's external input
   * (a CDP-reported path, a file-watcher event). See `safeRealpath` above (ticket 12).
   *
   * This is called on every buffer edit (`onDidChangeContent`), hover, definition, and file-watch
   * event — not just from the runtime-log path the symlink fix targeted — so it takes a fast path
   * first: a plain (non-realpath'd) comparison, which is exactly the pre-fix behavior and is
   * already correct whenever no symlink is involved (the overwhelmingly common case). Only when
   * THAT says "outside the workspace" does it pay for `realpathSync` — needed only to tell a
   * genuine outside path apart from one that merely mismatches through a symlink.
   *
   * When `absPath` can't be resolved (most commonly: a file just DELETED — refreshFiles calls
   * this for a delete event too, and by definition the file no longer exists to realpath) this
   * falls back to the same plain comparison — mixing a resolved root with an unresolved path
   * would falsely read as "outside the workspace" for every such path whenever the root itself
   * sits behind a symlink (e.g. macOS's own tmpdir()), silently breaking deletion handling.
   */
  toRelative(absPath: string): string {
    const resolved = resolvePath(absPath);
    const plain = relative(this.config.root, resolved);
    if (isWithinRoot(plain)) return plain;
    try {
      return relative(this.resolvedRoot, realpathSync(resolved));
    } catch {
      return plain;
    }
  }

  /**
   * The globs to watch to know WHICH FILES have changed content (are being indexed).
   *
   * Drops the negation patterns `!…` from `config.include` — they exclude paths from
   * the set to index (see `index()`, shared with `fast-glob`), they aren't a separate
   * pattern to register a watcher for. Only Workspace knows the semantics of
   * `include`/`exclude`; the server (LSP) just calls this function instead of reading
   * `config.include` and guessing.
   */
  changeWatchPatterns(): string[] {
    return this.config.include.filter((p) => !p.startsWith('!'));
  }

  stats(): Record<string, number> {
    return this.store.stats();
  }

  /**
   * The position of every identifier at a reference site in a .js file.
   * Used by the `sweep` command to measure coverage.
   */
  jsReferenceOffsets(relPath: string): number[] {
    const source = this.source(relPath);
    if (!source) return [];
    const ast = parseJsTolerant(source);
    return ast ? collectReferenceOffsets(ast) : [];
  }

  /** Relative path of every indexed .js file. */
  jsPaths(): string[] {
    return this.store
      .allFacts()
      .filter((f) => f.facts.kind === 'js')
      .map((f) => f.path);
  }

  /** Relative path of every indexed template. */
  templatePaths(): string[] {
    return this.store
      .allFacts()
      .filter((f) => f.facts.kind === 'template')
      .map((f) => f.path);
  }

  // -------------------------------------------------------------- queries

  /** Go-to-definition. Main algorithm: packages/core/src/resolve/definition.ts. */
  definitionAt(relPath: string, offset: number): DefinitionResult {
    return preferNearest(relPath, resolveDefinition(this, relPath, offset));
  }

  /**
   * Find-all-references. Returns every place a symbol is used, both in templates and in JS.
   */
  referencesAt(relPath: string, offset: number): { query: string; locations: Array<Location & { axis: string }> } {
    const facts = this.facts(relPath);
    if (!facts) return { query: '', locations: [] };

    let name: string | null = null;
    let container: string | null = null;

    if (facts.kind === 'js') {
      const source = this.source(relPath);
      if (!source) return { query: '', locations: [] };

      // Cursor on `$scope.foo` / `this.foo` -> find refs by (foo, its enclosing controller)
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

  /** Rename a property on $scope, synchronized across both JS and templates. Main algorithm: packages/core/src/resolve/rename-orchestrator.ts. */
  renameAt(relPath: string, offset: number, newName: string): RenameResult {
    return doRenameAt(this, relPath, offset, newName);
  }

  /**
   * The pre-check step of rename (LSP textDocument/prepareRename): is the cursor on
   * something renameable, and what's its current name so the IDE can pre-fill the input.
   */
  prepareRenameAt(relPath: string, offset: number): PrepareRenameResult {
    return doPrepareRenameAt(this, relPath, offset);
  }

  /** RenameSource.openTemplatePaths — templates open (overlay) but not yet in the index. */
  openTemplatePaths(): string[] {
    return [...this.overlays.keys()].filter((p) => TEMPLATE_EXT.test(p));
  }

  /** RenameSource.resolveScopeRefs — wraps the Linker, keeping it from leaking out of Workspace. */
  resolveScopeRefs(candidates: AttrCandidate[]): RefInput[] {
    return this.linker.resolveCandidates(candidates);
  }

  /** Symbols nobody uses — dead-code candidates. */
  unused(): SymbolRow[] {
    return this.store.unusedSymbols(['controller', 'filter', 'directive', 'service', 'factory', 'scope-member']);
  }

  /** The scope chain at a position — used by hover and completion. */
  scopeChainAt(relPath: string, offset: number): ScopeFrame[] | null {
    const facts = this.facts(relPath);
    if (!facts || facts.kind !== 'template') return null;
    for (const expr of facts.expressions) {
      if (inSpan(expr.span, offset)) return expr.scopeChain;
    }
    return null;
  }

  /** Suggestions at a position in a template. */
  completionAt(relPath: string, offset: number): CompletionEntry[] {
    const facts = this.facts(relPath);
    const source = this.source(relPath);
    if (!facts || facts.kind !== 'template' || source === null) return [];

    // An expression still being typed (`{{ busy. }}`) can't be parsed, so the extractor
    // drops it entirely. Insert a dummy identifier right at the cursor and re-extract:
    // the expression becomes valid, and the node containing the dummy tells us which
    // property chain the user is typing after.
    const patched = source.slice(0, offset) + COMPLETION_DUMMY + source.slice(offset);
    const hit = expressionAt(extractTemplate(patched, this.config), offset);
    if (hit) {
      if (hit.node.type === 'Literal') return []; // typing inside a string
      const { root, path } = unwind(hit.node);
      if (root && path.at(-1)?.includes(COMPLETION_DUMMY)) {
        return this.memberCompletions(relPath, root.name, path.slice(0, -1), hit.expr.scopeChain);
      }
      return this.rootCompletions(relPath, hit.expr.scopeChain);
    }

    // Still unparseable after inserting the dummy (`{{ a | }}`): use the scope chain of
    // the original expression.
    for (const expr of facts.expressions) {
      if (offset >= expr.span.start && offset <= expr.span.end + 1) {
        return this.rootCompletions(relPath, expr.scopeChain);
      }
    }

    // No expression yet (just typed '{{', not closed): use the nearest controller.
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

  /** Suggestions at a root-identifier position: local variables of the template + properties on scope. */
  private rootCompletions(from: string, chain: ScopeFrame[]): CompletionEntry[] {
    const out: CompletionEntry[] = [];
    for (const frame of chain) {
      for (const local of frame.locals) {
        out.push({ name: local.name, kind: 'variable', detail: `${frame.kind} variable of the template` });
      }
    }
    const container = controllerOf(chain);
    if (container) {
      for (const row of this.membersOf(container, from)) {
        out.push({ name: row.name, kind: 'property', detail: `on the $scope of ${container}` });
      }
    }
    const seen = new Set<string>();
    return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }

  /**
   * Suggestions after a dot, following the shape inferred from an object literal:
   *   `busy.`    -> keys of $scope.busy
   *   `section.` -> keys of an ELEMENT in $scope.sections (an ng-repeat variable)
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
        out.set(name, { name, kind: 'property', detail: `key of ${owner} (${prop.kind})` });
      }
    }
    return [...out.values()];
  }

  /** Properties on the $scope of a controller. `from`: keep only the copy nearest that file (Appendix K). */
  membersOf(controllerName: string, from?: string): SymbolRow[] {
    const rows = this.store
      .findSymbolsByKind('scope-member')
      .filter((s) => s.container === controllerName);
    return from === undefined ? rows : nearestRows(from, rows);
  }
}

/** Placeholder identifier inserted at the cursor so an in-progress expression can be parsed (see completionAt). */
const COMPLETION_DUMMY = '__ejsngCursor__';

/** Find the expression containing an offset, and the smallest node within it. */
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

/** `kind`s that are REAL Angular declarations (excludes js-global, bridge, event…). */
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
