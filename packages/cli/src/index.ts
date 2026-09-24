#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { Workspace, type Config, type RenameResult } from '@ejsng/core';

/**
 * CLI for the toolkit.
 *
 * Not a side project (docs/kien-truc.md section 9): it lets you run and
 * measure the entire core layer without opening an IDE, speeding up
 * development and debugging many times over. Every LSP feature must have
 * an equivalent path here.
 */

function usage(): never {
  console.log(`
ejsng — tracks variables/functions between EJS and AngularJS 1.x

  ejsng index [root]                    Index the workspace
  ejsng stats [root]                    Index statistics
  ejsng def   <file> <line> <col>       Go-to-definition at a position
  ejsng refs  <file> <line> <col>       Find-all-references at a position
  ejsng rename <file> <line> <col> <new-name>
                                        Preview a rename — does NOT write files
  ejsng members <controller> [root]     List scope properties of a controller
  ejsng unused [root]                   Symbols with no usages found (dead-code candidates)
  ejsng sweep [root]                    Try to resolve EVERY identifier in every template,
                                        report coverage and list the unresolved ones,
                                        plus every templateUrl that could not be linked
  ejsng scan  <file>                    Show the facts extracted from a file

Options:
  --root <path>            Root directory (default: current directory)
  --module-alias <name>    Add a name treated as an angular module (repeatable)
  --delimiter <char>       EJS delimiter (default '%')
  --template-root <urlPrefix>=<fsPath>[=<.ext,.ext>]
                           Map a templateUrl prefix to a directory (repeatable),
                           e.g. /views/=src/views=.ejs,.html
  --template-map <templateUrl>=<file>
                           Link one templateUrl to its template by hand (repeatable);
                           .vscode/settings.json ejsng.templateUrlMap is read too
  --views-dir <path>       Express views directory for res.render() (default 'views')
  --json                   Output JSON
`);
  process.exit(1);
}

interface Opts {
  root: string;
  json: boolean;
  moduleAliases: string[];
  delimiter: string;
  templateRoots: Config['templateRoots'];
  templateUrlMap: Record<string, string>;
  viewsDir?: string;
  rest: string[];
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { root: process.cwd(), json: false, moduleAliases: [], delimiter: '%', templateRoots: [], templateUrlMap: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--root') opts.root = argv[++i] ?? opts.root;
    else if (a === '--module-alias') opts.moduleAliases.push(argv[++i] ?? '');
    else if (a === '--delimiter') opts.delimiter = argv[++i] ?? '%';
    else if (a === '--template-root') opts.templateRoots.push(parseTemplateRoot(argv[++i] ?? ''));
    else if (a === '--views-dir') opts.viewsDir = argv[++i];
    else if (a === '--template-map') {
      const [url, file] = (argv[++i] ?? '').split('=');
      if (!url || !file) usage();
      opts.templateUrlMap[url] = file;
    }
    else if (a === '--json') opts.json = true;
    else opts.rest.push(a);
  }
  return opts;
}

/** `/views/=src/views=.ejs,.html` -> `{ urlPrefix: '/views/', fsPath: 'src/views', extensions: ['.ejs', '.html'] }`. */
function parseTemplateRoot(arg: string): Config['templateRoots'][number] {
  const [urlPrefix, fsPath, exts] = arg.split('=');
  if (!urlPrefix || !fsPath) usage();
  return { urlPrefix, fsPath, ...(exts ? { extensions: exts.split(',').filter(Boolean) } : {}) };
}

function makeWorkspace(opts: Opts): Workspace {
  const cfg: Partial<Config> & { root: string } = { root: resolvePath(opts.root) };
  if (opts.moduleAliases.length) {
    cfg.moduleAliases = ['myApp', 'app', 'appModule', ...opts.moduleAliases];
  }
  cfg.ejsDelimiter = opts.delimiter;
  if (opts.templateRoots.length) cfg.templateRoots = opts.templateRoots;
  if (opts.viewsDir) cfg.expressViewsDir = opts.viewsDir;
  // The links set by hand in the editor, then any given here.
  cfg.templateUrlMap = { ...editorTemplateUrlMap(cfg.root), ...opts.templateUrlMap };
  return new Workspace(cfg);
}

/** `ejsng.templateUrlMap` from the workspace's `.vscode/settings.json` (JSON with comments), if any. */
function editorTemplateUrlMap(root: string): Record<string, string> {
  try {
    const text = readFileSync(join(root, '.vscode', 'settings.json'), 'utf8')
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    const map = JSON.parse(text)['ejsng.templateUrlMap'];
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

/**
 * Is this offset inside a string or a comment?
 * Linear scan from the start of the file — fast enough for statistics
 * purposes, and avoids miscounting text inside a comment as an
 * "unresolved identifier".
 */
function inStringOrComment(source: string, offset: number): boolean {
  let i = 0;
  let quote: string | null = null;
  let comment: 'line' | 'block' | null = null;

  while (i < offset && i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (comment === 'line') {
      if (c === '\n') comment = null;
      i++;
      continue;
    }
    if (comment === 'block') {
      if (c === '*' && next === '/') {
        comment = null;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      comment = 'line';
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      comment = 'block';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i++;
      continue;
    }
    i++;
  }

  return quote !== null || comment !== null;
}

/** Convert a 1-based (line, col) to an offset. */
function toOffset(source: string, line: number, col: number): number {
  const lines = source.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i]!.length + 1;
  return off + col - 1;
}

/** Convert an offset to a 1-based (line, col). */
function toLineCol(source: string, offset: number): { line: number; col: number } {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

/** Print a rename result as a preview. The CLI never writes files. */
function printRename(ws: Workspace, r: RenameResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (r.reason) {
    console.log(`Cannot rename: ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`'${r.query}' — ${r.edits.length} location(s) to edit (preview, does NOT write files):`);
  for (const e of r.edits) {
    const src = ws.source(e.path) ?? '';
    const lc = toLineCol(src, e.span.start);
    const lineText = src.split('\n')[lc.line - 1]?.trim().slice(0, 80) ?? '';
    console.log(`  ${e.path}:${lc.line}:${lc.col}  ${lineText}`);
  }
  if (r.note) console.log(`\n${r.note}`);
}

function main(): void {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd) usage();
  const opts = parseArgs(argv);

  switch (cmd) {
    case 'index': {
      if (opts.rest[0]) opts.root = opts.rest[0];
      const ws = makeWorkspace(opts);
      const r = ws.index();
      console.log(
        `Indexed ${r.indexed} file(s), skipped ${r.skipped} (unchanged), removed ${r.removed}, linked ${r.linkedRefs} additional ref(s), took ${r.ms}ms`,
      );
      console.log(JSON.stringify(ws.stats(), null, 2));
      ws.close();
      break;
    }

    case 'stats': {
      if (opts.rest[0]) opts.root = opts.rest[0];
      const ws = makeWorkspace(opts);
      console.log(JSON.stringify(ws.stats(), null, 2));
      ws.close();
      break;
    }

    case 'def':
    case 'refs': {
      const [file, lineStr, colStr] = opts.rest;
      if (!file || !lineStr || !colStr) usage();
      const ws = makeWorkspace(opts);
      const rel = ws.toRelative(file);
      const source = readFileSync(resolvePath(file), 'utf8');
      const offset = toOffset(source, Number(lineStr), Number(colStr));

      if (cmd === 'def') {
        const r = ws.definitionAt(rel, offset);
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (!r.targets.length) console.log(`Not found: ${r.reason ?? ''} (query='${r.query}')`);
        else {
          console.log(`'${r.query}' →`);
          for (const t of r.targets) {
            const src = ws.source(t.path) ?? '';
            const lc = toLineCol(src, t.span.start);
            console.log(`  ${t.path}:${lc.line}:${lc.col}  [${t.kind}, ${t.confidence}] ${t.detail}`);
          }
          if (r.otherFiles?.length) {
            console.log(`  (${r.otherFiles.length} more match(es) in a farther directory: ${r.otherFiles.join(', ')})`);
          }
        }
      } else {
        const r = ws.referencesAt(rel, offset);
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(`'${r.query}' — ${r.locations.length} reference(s):`);
          for (const l of r.locations) {
            const src = ws.source(l.path) ?? '';
            const lc = toLineCol(src, l.span.start);
            const lineText = src.split('\n')[lc.line - 1]?.trim().slice(0, 80) ?? '';
            console.log(`  ${l.path}:${lc.line}:${lc.col}  [${l.axis}]  ${lineText}`);
          }
        }
      }
      ws.close();
      break;
    }

    case 'rename': {
      const [file, lineStr, colStr, newName] = opts.rest;
      if (!file || !lineStr || !colStr || !newName) usage();
      const ws = makeWorkspace(opts);
      ws.index(); // a stale index means stale spans — rename needs the latest facts
      const source = readFileSync(resolvePath(file), 'utf8');
      const r = ws.renameAt(ws.toRelative(file), toOffset(source, Number(lineStr), Number(colStr)), newName);
      printRename(ws, r, opts.json);
      ws.close();
      break;
    }

    case 'members': {
      const [controller] = opts.rest;
      if (!controller) usage();
      const ws = makeWorkspace(opts);
      const rows = ws.membersOf(controller);
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log(`${rows.length} properties on the scope of '${controller}':`);
        for (const r of rows) {
          const src = ws.source(r.path) ?? '';
          const lc = toLineCol(src, r.span.start);
          console.log(`  ${r.name.padEnd(24)} ${r.path}:${lc.line}`);
        }
      }
      ws.close();
      break;
    }

    case 'unused': {
      if (opts.rest[0]) opts.root = opts.rest[0];
      const ws = makeWorkspace(opts);
      const rows = ws.unused();
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log(`${rows.length} symbol(s) with no usages found:`);
        for (const r of rows) {
          const src = ws.source(r.path) ?? '';
          const lc = toLineCol(src, r.span.start);
          console.log(`  ${r.kind.padEnd(14)} ${r.name.padEnd(30)} ${r.path}:${lc.line}`);
        }
      }
      ws.close();
      break;
    }

    case 'sweep': {
      // Field-wide test: instead of spot-checking a few positions, try ALL of them.
      // This is the only way to know which expressions are still unresolved.
      if (opts.rest[0]) opts.root = opts.rest[0];
      const ws = makeWorkspace(opts);
      ws.index();

      let total = 0;
      let resolved = 0;
      let builtin = 0;
      const failures: string[] = [];

      // --- .js files: try every identifier in the source code ---
      for (const rel of ws.jsPaths()) {
        const src = ws.source(rel);
        if (!src) continue;
        for (const off of ws.jsReferenceOffsets(rel)) {
          total++;
          const d = ws.definitionAt(rel, off);
          if (d.targets.length) resolved++;
          else if (d.builtin) builtin++;
          else {
            const lc = toLineCol(src, off);
            failures.push(`  ${rel}:${lc.line}:${lc.col}  ${d.query || '?'} — ${d.reason ?? ''}`);
          }
        }
      }

      // --- Templates: try every identifier in Angular expressions ---
      for (const rel of ws.templatePaths()) {
        const facts = ws.facts(rel);
        if (!facts || facts.kind !== 'template') continue;
        const src = ws.source(rel) ?? '';

        for (const expr of facts.expressions) {
          for (const root of expr.roots) {
            // Try both the root identifier and each property segment after it.
            const probes = [root.span.start];
            let cursor = root.span.end;
            for (const seg of root.path) {
              const at = src.indexOf(seg, cursor);
              if (at === -1 || at > cursor + 2) break;
              probes.push(at);
              cursor = at + seg.length;
            }

            for (const off of probes) {
              total++;
              const d = ws.definitionAt(rel, off);
              if (d.targets.length) resolved++;
              else if (d.builtin) builtin++;
              else {
                const lc = toLineCol(src, off);
                failures.push(`  ${rel}:${lc.line}:${lc.col}  ${d.query || '?'} — ${d.reason ?? ''}`);
              }
            }
          }
        }
      }

      const covered = resolved + builtin;
      console.log(`Total positions checked : ${total}`);
      console.log(`Resolved                : ${resolved}`);
      console.log(`Builtin variables       : ${builtin}  (no definition, not an error)`);
      console.log(`Still unresolved        : ${failures.length}`);
      console.log(`Coverage                : ${total ? ((covered / total) * 100).toFixed(1) : '0'}%`);
      if (failures.length) {
        console.log('\n--- unresolved spots ---');
        failures.slice(0, 40).forEach((f) => console.log(f));
        if (failures.length > 40) console.log(`  … ${failures.length - 40} more`);
        process.exitCode = 1;
      }

      // Reported, not counted as failures: a dynamic templateUrl is legitimate code, it just
      // needs the user to know that link is missing (docs/kien-truc.md section 5.1).
      const linkIssues = ws.templateLinkIssues();
      console.log(`\nUnresolved template links: ${linkIssues.length}`);
      for (const issue of linkIssues.slice(0, 40)) {
        const lc = toLineCol(ws.source(issue.path) ?? '', issue.span.start);
        console.log(`  ${issue.path}:${lc.line}:${lc.col}  ${issue.via} '${issue.owner}' [${issue.reason}] — ${issue.detail}`);
      }
      if (linkIssues.length > 40) console.log(`  … ${linkIssues.length - 40} more`);
      ws.close();
      break;
    }

    case 'scan': {
      const [file] = opts.rest;
      if (!file) usage();
      const ws = makeWorkspace(opts);
      const source = readFileSync(resolvePath(file), 'utf8');
      ws.setOverlay(ws.toRelative(file), source);
      const facts = ws.facts(ws.toRelative(file));
      console.log(JSON.stringify(facts, null, 2));
      ws.close();
      break;
    }

    default:
      usage();
  }
}

main();
