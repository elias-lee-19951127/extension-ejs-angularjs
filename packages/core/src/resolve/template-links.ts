import { isAbsolute, posix, relative, sep } from 'node:path';
import type { Config, FileFacts, JsFacts, ScopeFrame, Span, TemplateFacts, TemplateLink } from '../types';
import type { DefinitionResult } from './workspace';

/**
 * Layer 4 — which controller owns a template's scope when the template doesn't say so itself
 * (docs/kien-truc.md section 5.1, sources 2–5), and which `res.render()` calls feed an EJS view.
 *
 * `templateUrl: '/views/profile.html'` is a runtime URL, not a path on disk, and the file behind
 * it may well be `profile.ejs` — so the URL is mapped through `config.templateRoots`. The view
 * name in `res.render('user/profile')` is mapped through `config.expressViewsDir`.
 *
 * Pure: a function of the facts, the config and the set of indexed paths — no disk access.
 */

/** A controller a template's scope is bound to by a `templateUrl` somewhere else. */
export interface TemplateBinding {
  controller: string;
  alias: string | null;
  /** Where the binding was declared: the `templateUrl` value. */
  from: { path: string; span: Span; via: TemplateLink['via']; owner: string; url: string };
}

/** A `templateUrl` the linker could not use — the "unresolved links" report of section 5.1. */
export interface TemplateLinkIssue {
  path: string;
  span: Span;
  via: TemplateLink['via'];
  owner: string;
  url: string | null;
  reason: 'dynamic' | 'no-file' | 'ambiguous-controller';
  detail: string;
}

export interface RenderSite {
  path: string;
  call: JsFacts['renderCalls'][number];
}

export interface TemplateLinkIndex {
  /** Template path -> the one controller bound to it. Absent when none, or when links disagree. */
  bindings: Map<string, TemplateBinding>;
  issues: TemplateLinkIssue[];
  /** `${jsPath}:${urlSpan.start}` -> the template path that `templateUrl` resolved to. */
  urlTargets: Map<string, string>;
  /** `${jsPath}:${viewSpan.start}` -> the view file a `res.render()` resolved to. */
  viewTargets: Map<string, string>;
  /** View path -> every `res.render()` call rendering it. */
  renderers: Map<string, RenderSite[]>;
  /** Template path -> every `templateUrl` that resolved to it: the way back from the HTML to its JS. */
  usedBy: Map<string, TemplateUse[]>;
  /** Every indexed path — what a `templateUrl` in an edited, not yet indexed buffer resolves against. */
  paths: Set<string>;
  /** What the Express code serves, read once per link pass. */
  served: ServedDirs;
}

/** One `templateUrl` site pointing at a template. */
export interface TemplateUse {
  path: string;
  span: Span;
  via: TemplateLink['via'];
  owner: string;
  url: string;
  controller: string | null;
}

/**
 * A JS↔template link to mark beside the code — the editor's gutter icon:
 * - in a `.js` file: each `templateUrl` string that maps to a template, pointing at that file;
 * - in a template: the whole file, pointing at each `templateUrl` that loads it.
 */
export interface TemplateLinkMarker {
  /** Where the marker sits in the file asked about. */
  span: Span;
  target: { path: string; span: Span };
  /** `'template'`: the marker opens a template. `'templateUrl'`: it opens the JS that loads this one. */
  kind: 'template' | 'templateUrl';
  via: TemplateLink['via'];
  owner: string;
  url: string;
  controller: string | null;
}

/** Express's own default when no views directory is configured: `<app root>/views`. */
const DEFAULT_VIEWS_DIR = 'views';
/** Tried in order when a view name has no extension — EJS first, it's what `res.render` defaults to here. */
const VIEW_EXTENSIONS = ['.ejs', '.html'];

export function linkTemplates(all: Array<{ path: string; facts: FileFacts }>, config: Config): TemplateLinkIndex {
  const exists = new Set(all.map((f) => f.path));
  const index: TemplateLinkIndex = {
    bindings: new Map(),
    issues: [],
    urlTargets: new Map(),
    viewTargets: new Map(),
    renderers: new Map(),
    usedBy: new Map(),
    paths: exists,
    served: servedDirs(all, config, exists),
  };
  const candidates = new Map<string, TemplateBinding[]>();

  for (const { path, facts } of all) {
    if (facts.kind !== 'js') continue;

    for (const link of facts.templateLinks ?? []) {
      const base = { path, span: link.urlSpan, via: link.via, owner: link.owner, url: link.url };
      if (link.url === null) {
        index.issues.push({ ...base, reason: 'dynamic', detail: 'templateUrl is an expression, not a string literal' });
        continue;
      }
      const target = resolveTemplateUrl(link.url, config, exists, path, index.served, link.suffixOnly);
      if (!target) {
        index.issues.push({ ...base, reason: 'no-file', detail: `no indexed file matches '${link.url}' — link it by hand (ejsng.templateUrlMap / --template-map) or add a templateRoots entry` });
        continue;
      }
      index.urlTargets.set(`${path}:${link.urlSpan.start}`, target);
      const uses = index.usedBy.get(target) ?? [];
      uses.push({ path, span: link.urlSpan, via: link.via, owner: link.owner, url: link.url, controller: link.controller });
      index.usedBy.set(target, uses);
      if (!link.controller) continue; // a template with no controller of its own: nothing to bind
      const list = candidates.get(target) ?? [];
      list.push({ controller: link.controller, alias: link.controllerAs, from: { path, span: link.urlSpan, via: link.via, owner: link.owner, url: link.url } });
      candidates.set(target, list);
    }

    for (const call of facts.renderCalls) {
      if (!call.viewSpan) continue; // facts from before PARSER_VERSION 12
      const view = resolveViewPath(call.viewPath, config, exists);
      if (!view) continue;
      index.viewTargets.set(`${path}:${call.viewSpan.start}`, view);
      const sites = index.renderers.get(view) ?? [];
      sites.push({ path, call });
      index.renderers.set(view, sites);
    }
  }

  for (const [template, list] of candidates) {
    const distinct = new Set(list.map((b) => `${b.controller}\u0000${b.alias ?? ''}`));
    if (distinct.size === 1) {
      index.bindings.set(template, list[0]!);
      continue;
    }
    // Two routes/directives putting DIFFERENT controllers on one template: guessing would make
    // every expression in it resolve against the wrong controller half the time. Report instead.
    const names = [...new Set(list.map((b) => (b.alias ? `${b.controller} as ${b.alias}` : b.controller)))].join(', ');
    for (const b of list) {
      index.issues.push({
        path: b.from.path,
        span: b.from.span,
        via: b.from.via,
        owner: b.from.owner,
        url: b.from.url,
        reason: 'ambiguous-controller',
        detail: `${template} is used with several controllers (${names}) — not bound to any`,
      });
    }
  }

  return index;
}

/** What the Express code in the workspace serves, as workspace-relative directories. */
export interface ServedDirs {
  /** `express.static` mounts, longest URL prefix first. */
  statics: Array<{ urlPrefix: string; dir: string }>;
  /** Views directories: `app.set('views', …)`, plus `expressViewsDir` (default `views`). */
  views: string[];
  /** Routes rendering a view named by the URL: `/partials/:name` -> `partials/<name>`. */
  renderRoutes: Array<{ urlPrefix: string; viewPrefix: string }>;
}

/** Extensions a template file may have — tried in place of the URL's when nothing has its exact name. */
const TEMPLATE_EXTENSIONS = ['.html', '.ejs', '.htm'];

/** Collect `ServedDirs` from every `.js` file's `serverRoots`. */
export function servedDirs(all: Array<{ path: string; facts: FileFacts }>, config: Config, exists: Set<string>): ServedDirs {
  const statics: ServedDirs['statics'] = [];
  const views: string[] = [];
  const renderRoutes: ServedDirs['renderRoutes'] = [];
  const dirs = new Set<string>();
  for (const p of exists) for (let d = posix.dirname(p); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  const inWorkspace = (dir: string) => dir === '' || dirs.has(dir);
  const place = (from: string, dir: string, fromFile: boolean): string | null => {
    const tries = fromFile ? [posix.join(posix.dirname(from), dir)] : [dir, posix.join(posix.dirname(from), dir)];
    for (const t of tries) {
      const norm = posix.normalize(t).replace(/^\.\/?/, '').replace(/\/+$/, '');
      if (!norm.startsWith('..') && inWorkspace(norm)) return norm;
    }
    return null;
  };
  for (const { path, facts } of all) {
    if (facts.kind !== 'js') continue;
    for (const r of facts.serverRoots ?? []) {
      if (r.kind === 'render-route') {
        renderRoutes.push({ urlPrefix: r.urlPrefix, viewPrefix: r.viewPrefix ?? '' });
        continue;
      }
      const dir = place(path, r.dir, r.fromFile);
      if (dir === null) continue;
      if (r.kind === 'static') statics.push({ urlPrefix: r.urlPrefix, dir });
      else if (!views.includes(dir)) views.push(dir);
    }
  }
  const configured = workspaceRelative(config.expressViewsDir ?? DEFAULT_VIEWS_DIR, config.root);
  if (configured !== null && !views.includes(configured)) views.push(configured);
  statics.sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
  renderRoutes.sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
  return { statics, views, renderRoutes };
}

const NO_SERVED: ServedDirs = { statics: [], views: [], renderRoutes: [] };

/**
 * Map a runtime `templateUrl` to an indexed file. Tried in order, first with the file name as
 * written, then — only if nothing matched — with its extension swapped for another template one
 * (`list.html` -> `list.ejs`) or added when it has none (`/partials/list` -> `partials/list.ejs`):
 * 1. `templateRoots` entries whose `urlPrefix` matches, longest first (each with its own `extensions`);
 * 2. `express.static` mounts found in the code, longest prefix first;
 * 3. routes rendering a view named by the URL (`/partials/:name` -> `<views>/partials/<name>.ejs`);
 * 4. the URL as a path from the workspace root;
 * 5. the URL under each directory above `fromPath`, nearest first — Angular fetches a `templateUrl`
 *    relative to the PAGE, which is almost always served from a directory above its scripts;
 * 6. the URL under each views directory;
 * 7. the one indexed file whose path ends with the URL (`/` boundary), nearest `fromPath` — a tie links none.
 * `suffixOnly`: the URL is only the static END of an expression (`base + '/list.html'`): step 7 alone.
 */
export function resolveTemplateUrl(
  url: string,
  config: Config,
  exists: Set<string>,
  fromPath?: string,
  served: ServedDirs = NO_SERVED,
  suffixOnly = false,
): string | null {
  return traceTemplateUrl(url, config, exists, fromPath, served, suffixOnly).target;
}

/** How a `templateUrl` was resolved — or every place it was looked for — for the hover. */
export interface TemplateUrlTrace {
  target: string | null;
  /** Which rule found it: `'set by hand (ejsng.templateUrlMap)'`, `'express.static mount "/assets" -> client'`… */
  how: string | null;
  /** What was looked for, in order, when nothing matched. */
  tried: string[];
}

/** `resolveTemplateUrl`, keeping the reason. */
export function traceTemplateUrl(
  url: string,
  config: Config,
  exists: Set<string>,
  fromPath?: string,
  served: ServedDirs = NO_SERVED,
  suffixOnly = false,
): TemplateUrlTrace {
  const tried: string[] = [];
  const found = (target: string, how: string): TemplateUrlTrace => ({ target, how, tried });
  const manual = config.templateUrlMap?.[url];
  if (manual !== undefined) {
    const path = posix.normalize(manual.split('\\').join('/')).replace(/^\.?\//, '');
    if (exists.has(path)) return found(path, 'set by hand (ejsng.templateUrlMap)');
    tried.push(`ejsng.templateUrlMap -> ${manual} (not an indexed file)`);
  }
  const clean = stripOrigin(url.split(/[?#]/)[0]!.trim());
  if (clean === '') return { target: null, how: null, tried };
  // `./x.html` and `../x.html` name a file relative to the page, which we don't know: keep the rest.
  const tail = posix.normalize(clean.replace(/^\/+/, '')).replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  if (tail === '' || tail === '.' || tail === '..') return { target: null, how: null, tried };
  if (suffixOnly) {
    const hit = nearestBySuffix(tail, exists, fromPath ?? '', false) ?? nearestBySuffix(tail, exists, fromPath ?? '', true);
    if (hit) return found(hit, 'the end of its path — the start is computed at runtime');
    tried.push(`any file ending in /${tail} (the start of this URL is computed at runtime)`);
    return { target: null, how: null, tried };
  }

  const roots = [...(config.templateRoots ?? [])].sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
  for (const root of roots) {
    if (!clean.startsWith(root.urlPrefix)) continue;
    const dir = workspaceRelative(root.fsPath, config.root);
    if (dir === null) continue;
    const hit = firstExisting(posix.join(dir, clean.slice(root.urlPrefix.length)), root.extensions ?? [], exists);
    if (hit) return found(hit, `templateRoots "${root.urlPrefix}" -> ${root.fsPath}`);
    tried.push(`templateRoots "${root.urlPrefix}" -> ${posix.join(dir, clean.slice(root.urlPrefix.length))}`);
  }

  const abs = clean.startsWith('/') ? clean : '/' + tail;
  for (const alt of [false, true]) {
    const other = alt ? ' (another template extension)' : '';
    const at = (p: string, how: string): TemplateUrlTrace | null => {
      const hit = alt ? firstExisting(p, TEMPLATE_EXTENSIONS.filter((e) => e !== posix.extname(p)), exists, true) : firstExisting(p, [], exists);
      if (hit) return found(hit, how + other);
      if (!alt) tried.push(posix.normalize(p).replace(/^\/+/, '') + `  (${how})`);
      return null;
    };
    for (const s of served.statics) {
      const prefix = s.urlPrefix.endsWith('/') ? s.urlPrefix : s.urlPrefix + '/';
      if (s.urlPrefix !== '/' && !abs.startsWith(prefix) && abs !== s.urlPrefix) continue;
      const hit = at(posix.join(s.dir, s.urlPrefix === '/' ? abs : abs.slice(prefix.length - 1)), `express.static "${s.urlPrefix}" -> ${s.dir || '.'}`);
      if (hit) return hit;
    }
    if (!alt) {
      for (const r of served.renderRoutes) {
        if (!abs.startsWith(r.urlPrefix)) continue;
        const rest = abs.slice(r.urlPrefix.length);
        const name = r.viewPrefix + rest.slice(0, rest.length - posix.extname(rest).length);
        for (const v of served.views) {
          const hit = firstExisting(posix.join(v, name), VIEW_EXTENSIONS, exists);
          if (hit) return found(hit, `route "${r.urlPrefix}…" renders the view ${r.viewPrefix}…`);
          tried.push(`${posix.join(v, name)}.ejs  (route "${r.urlPrefix}…" rendering ${r.viewPrefix}…)`);
        }
      }
    }
    const direct = at(tail, 'from the workspace root');
    if (direct) return direct;
    if (fromPath) {
      for (let dir = posix.dirname(fromPath); dir !== '.' && dir !== '/' && dir !== ''; dir = posix.dirname(dir)) {
        const hit = at(posix.join(dir, tail), 'relative to a directory above the script, where its page is served');
        if (hit) return hit;
      }
    }
    for (const v of served.views) {
      const hit = at(posix.join(v, tail), `under the views directory ${v}`);
      if (hit) return hit;
    }
    const bySuffix = nearestBySuffix(tail, exists, fromPath ?? '', alt);
    if (bySuffix) return found(bySuffix, 'the only file whose path ends with it' + other);
    if (!alt) tried.push(`any file ending in /${tail}`);
  }
  tried.push('each of the above with .html / .ejs / .htm in place of its extension');
  return { target: null, how: null, tried };
}

/** `http://host:3000/views/a.html` and `//cdn/views/a.html` -> `/views/a.html`. */
function stripOrigin(url: string): string {
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i.exec(url);
  return m ? (m[1] ?? '') : url;
}

/**
 * The indexed file ending in `/<tail>` (or, with `alt`, in `/<tail>` with another template extension)
 * that shares the most leading directories with `fromPath`; `null` when none, or on a tie.
 */
function nearestBySuffix(tail: string, exists: Set<string>, fromPath: string, alt: boolean): string | null {
  const ext = posix.extname(tail);
  const stem = ext && TEMPLATE_EXTENSIONS.includes(ext) ? tail.slice(0, -ext.length) : tail;
  const suffixes = alt ? TEMPLATE_EXTENSIONS.filter((e) => e !== ext).map((e) => '/' + stem + e) : ['/' + tail];
  const from = fromPath.split('/');
  let best: string | null = null;
  let bestScore = -1;
  let tie = false;
  for (const p of exists) {
    if (!suffixes.some((s) => p.endsWith(s) || '/' + p === s)) continue;
    const parts = p.split('/');
    let score = 0;
    while (score < parts.length - 1 && score < from.length - 1 && parts[score] === from[score]) score++;
    if (score > bestScore) {
      best = p;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** Map the view name of `res.render('user/profile')` to an indexed file under `expressViewsDir`. */
export function resolveViewPath(viewPath: string, config: Config, exists: Set<string>): string | null {
  const dir = workspaceRelative(config.expressViewsDir ?? DEFAULT_VIEWS_DIR, config.root);
  if (dir === null) return null;
  return firstExisting(posix.join(dir, viewPath), VIEW_EXTENSIONS, exists);
}

/** `path` itself, then each extension swapped in (or appended). `altOnly`: skip `path` itself. */
function firstExisting(path: string, extensions: string[], exists: Set<string>, altOnly = false): string | null {
  const base = posix.normalize(path).replace(/^\/+/, '');
  if (base === '' || base === '.' || base.startsWith('../')) return null;
  const ext = posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const tries = [...(altOnly ? [] : [base]), ...extensions.map((e) => stem + e), ...(ext ? extensions.map((e) => base + e) : [])];
  return tries.find((p) => exists.has(p)) ?? null;
}

/** A configured directory as a workspace-relative POSIX path, or `null` when it lies outside the root. */
function workspaceRelative(dir: string, root: string): string | null {
  const rel = isAbsolute(dir) ? relative(root, dir).split(sep).join('/') : dir.split('\\').join('/');
  const norm = posix.normalize(rel).replace(/\/+$/, '');
  if (norm.startsWith('../') || norm === '..') return null;
  return norm === '.' ? '' : norm;
}

/**
 * The template's facts as seen through its binding: every expression's scope chain gets the
 * bound controller as its OUTERMOST controller frame, just inside the root — where Angular puts
 * it at runtime. An `ng-controller` inside the template stays nearer, so it still wins.
 *
 * A query-time view only: the facts in the index stay a pure function of the file.
 */
export function withBinding(facts: TemplateFacts, binding: TemplateBinding): TemplateFacts {
  const frameFor = (root: ScopeFrame | undefined): ScopeFrame => ({
    kind: 'controller',
    controllerName: binding.controller,
    ...(binding.alias ? { alias: binding.alias } : {}),
    locals: [],
    elementSpan: root?.elementSpan ?? { start: 0, end: 0 },
  });
  return {
    ...facts,
    expressions: facts.expressions.map((e) => {
      const chain = e.scopeChain;
      const last = chain[chain.length - 1];
      const scopeChain =
        last?.kind === 'root' ? [...chain.slice(0, -1), frameFor(last), last] : [...chain, frameFor(undefined)];
      return { ...e, scopeChain };
    }),
  };
}

/**
 * The JS↔template markers of one file. A `.js` file's own `templateUrl`s are resolved from the facts
 * passed in (the open buffer's, when it is being edited), so a marker follows the code as it moves.
 */
export function linkMarkers(index: TemplateLinkIndex, config: Config, relPath: string, facts: FileFacts): TemplateLinkMarker[] {
  if (facts.kind === 'js') {
    const out: TemplateLinkMarker[] = [];
    for (const link of facts.templateLinks ?? []) {
      if (link.url === null) continue;
      const target = resolveTemplateUrl(link.url, config, index.paths, relPath, index.served, link.suffixOnly);
      if (!target) continue;
      out.push({
        span: link.urlSpan,
        target: { path: target, span: { start: 0, end: 0 } },
        kind: 'template',
        via: link.via,
        owner: link.owner,
        url: link.url,
        controller: link.controller,
      });
    }
    return out;
  }
  return (index.usedBy.get(relPath) ?? []).map((u) => ({
    span: { start: 0, end: 0 },
    target: { path: u.path, span: u.span },
    kind: 'templateUrl' as const,
    via: u.via,
    owner: u.owner,
    url: u.url,
    controller: u.controller,
  }));
}

/** The `templateUrl` under the cursor, with how it resolved — what its hover says. */
export interface TemplateUrlInfo {
  url: string | null;
  span: Span;
  via: TemplateLink['via'];
  owner: string;
  controller: string | null;
  suffixOnly: boolean;
  trace: TemplateUrlTrace;
}

export function templateUrlAt(index: TemplateLinkIndex, config: Config, relPath: string, offset: number, facts: FileFacts): TemplateUrlInfo | null {
  if (facts.kind !== 'js') return null;
  const link = (facts.templateLinks ?? []).find((l) => offset >= l.urlSpan.start && offset <= l.urlSpan.end);
  if (!link) return null;
  const trace: TemplateUrlTrace =
    link.url === null
      ? { target: null, how: null, tried: [] }
      : traceTemplateUrl(link.url, config, index.paths, relPath, index.served, link.suffixOnly);
  return {
    url: link.url,
    span: link.urlSpan,
    via: link.via,
    owner: link.owner,
    controller: link.controller,
    suffixOnly: !!link.suffixOnly,
    trace,
  };
}

/**
 * Go-to-definition for what this module links, or `null` to let ordinary resolution run:
 * - on a `templateUrl` string -> the template file it maps to
 * - on the view name in `res.render('user/profile', ...)` -> the view file
 * - on an EJS local (`<%= user %>`) -> the `user` key of every `res.render()` rendering this view
 */
export function linkDefinition(
  index: TemplateLinkIndex,
  relPath: string,
  offset: number,
  facts: FileFacts,
): DefinitionResult | null {
  const inside = (span: Span) => offset >= span.start && offset <= span.end;

  if (facts.kind === 'js') {
    for (const link of facts.templateLinks ?? []) {
      // An expression (`base + '/x.html'`) is ordinary code: `base` must still jump to its declaration.
      if (link.url === null || !inside(link.urlSpan)) continue;
      const target = index.urlTargets.get(`${relPath}:${link.urlSpan.start}`);
      if (!target) {
        const reason = `No indexed file matches '${link.url}' — add a templateRoots entry mapping its URL prefix`;
        return { targets: [], query: link.url, reason };
      }
      return { query: link.url, targets: [fileTarget(target, 'template', `templateUrl of ${link.via} '${link.owner}'`)] };
    }
    for (const call of facts.renderCalls) {
      if (!call.viewSpan || !inside(call.viewSpan)) continue;
      const target = index.viewTargets.get(`${relPath}:${call.viewSpan.start}`);
      if (!target) {
        return { targets: [], query: call.viewPath, reason: `No view '${call.viewPath}' under expressViewsDir` };
      }
      return { query: call.viewPath, targets: [fileTarget(target, 'view', `view rendered by res.render('${call.viewPath}')`)] };
    }
    return null;
  }

  const local = facts.ejsLocals.find((l) => inside(l.span));
  if (!local) return null;
  const sites = index.renderers.get(relPath);
  if (!sites?.length) return null;
  const targets = sites.flatMap(({ path, call }) =>
    (call.locals ?? [])
      .filter((l) => l.name === local.name)
      .map((l) => ({
        path,
        span: l.span,
        kind: 'ejs-local',
        detail: `passed by res.render('${call.viewPath}')`,
        confidence: 'high',
      })),
  );
  if (targets.length) return { query: local.name, targets };
  return {
    targets: [],
    query: local.name,
    reason: `None of the ${sites.length} res.render() call(s) for this view passes '${local.name}'`,
  };
}

function fileTarget(path: string, kind: string, detail: string): DefinitionResult['targets'][number] {
  return { path, span: { start: 0, end: 0 }, kind, detail, confidence: 'high' };
}
