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
      const target = resolveTemplateUrl(link.url, config, exists);
      if (!target) {
        index.issues.push({ ...base, reason: 'no-file', detail: `no indexed file matches '${link.url}' — check templateRoots` });
        continue;
      }
      index.urlTargets.set(`${path}:${link.urlSpan.start}`, target);
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

/**
 * Map a runtime `templateUrl` to an indexed file. Tries each `templateRoots` entry whose
 * `urlPrefix` matches (longest prefix first), then the URL as a path from the workspace root.
 * Within a root, the file as named comes first, then each of its `extensions` — swapped for the
 * URL's own extension (`profile.html` -> `profile.ejs`) or appended when the URL has none.
 */
export function resolveTemplateUrl(url: string, config: Config, exists: Set<string>): string | null {
  const clean = url.split(/[?#]/)[0]!;
  const roots = [...(config.templateRoots ?? [])].sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
  for (const root of roots) {
    if (!clean.startsWith(root.urlPrefix)) continue;
    const dir = workspaceRelative(root.fsPath, config.root);
    if (dir === null) continue;
    const hit = firstExisting(posix.join(dir, clean.slice(root.urlPrefix.length)), root.extensions ?? [], exists);
    if (hit) return hit;
  }
  return firstExisting(clean, [], exists);
}

/** Map the view name of `res.render('user/profile')` to an indexed file under `expressViewsDir`. */
export function resolveViewPath(viewPath: string, config: Config, exists: Set<string>): string | null {
  const dir = workspaceRelative(config.expressViewsDir ?? DEFAULT_VIEWS_DIR, config.root);
  if (dir === null) return null;
  return firstExisting(posix.join(dir, viewPath), VIEW_EXTENSIONS, exists);
}

function firstExisting(path: string, extensions: string[], exists: Set<string>): string | null {
  const base = posix.normalize(path).replace(/^\/+/, '');
  if (base === '' || base === '.' || base.startsWith('../')) return null;
  const ext = posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const tries = [base, ...extensions.map((e) => stem + e), ...(ext ? extensions.map((e) => base + e) : [])];
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
