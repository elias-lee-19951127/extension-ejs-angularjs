#!/usr/bin/env node
/**
 * Test harness: locate by STRING instead of by line/column numbers.
 *
 * Reason for existing: when testing by hand, counting columns is very easy
 * to get wrong — during development there were several "not found" false
 * alarms just because the cursor landed on `id="kbm-file-input"` instead of
 * the `kbm-file` attribute, or in the middle of `data-ng-class=` instead of
 * inside the expression. A mistake in the test is more dangerous than a
 * mistake in the code: it leads to a wrong conclusion about the product.
 *
 * Usage:
 *   ejsng-probe <file> <needle> [--nth N] [--offset K] [--refs] --root <path>
 *
 *   <needle>   the string to find in the file, e.g. "section.enabled"
 *   --nth N    use the Nth occurrence found (default 1)
 *   --offset K shift K characters from the start of the match — to land in
 *              the middle of a string, e.g. "section.id" with --offset 8
 *              lands on the letter 'id'
 *   --refs     run find-references instead of go-to-definition
 *   --rename T preview a rename to T (does NOT write files)
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Workspace, type Config } from '@ejsng/core';

interface Args {
  file: string;
  needle: string;
  nth: number;
  offset: number;
  refs: boolean;
  rename: string;
  root: string;
  moduleAliases: string[];
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Args = {
    file: '',
    needle: '',
    nth: 1,
    offset: 0,
    refs: false,
    rename: '',
    root: process.cwd(),
    moduleAliases: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--nth') args.nth = Number(argv[++i] ?? 1);
    else if (a === '--offset') args.offset = Number(argv[++i] ?? 0);
    else if (a === '--refs') args.refs = true;
    else if (a === '--rename') args.rename = argv[++i] ?? '';
    else if (a === '--root') args.root = argv[++i] ?? args.root;
    else if (a === '--module-alias') args.moduleAliases.push(argv[++i] ?? '');
    else positional.push(a);
  }

  args.file = positional[0] ?? '';
  args.needle = positional[1] ?? '';
  if (!args.file || !args.needle) {
    console.error('Usage: ejsng-probe <file> <needle> [--nth N] [--offset K] [--refs] --root <path>');
    process.exit(2);
  }
  return args;
}

function lineColOf(source: string, offset: number): { line: number; col: number } {
  const before = source.slice(0, offset);
  return { line: before.split('\n').length, col: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const abs = resolvePath(args.file);
  const source = readFileSync(abs, 'utf8');

  // Find the nth occurrence
  let idx = -1;
  for (let n = 0; n < args.nth; n++) {
    idx = source.indexOf(args.needle, idx + 1);
    if (idx === -1) {
      console.error(`Could not find occurrence #${args.nth} of ${JSON.stringify(args.needle)}`);
      process.exit(1);
    }
  }
  const offset = idx + args.offset;
  const { line, col } = lineColOf(source, offset);

  const cfg: Partial<Config> & { root: string } = { root: resolvePath(args.root) };
  if (args.moduleAliases.length) {
    cfg.moduleAliases = ['myApp', 'app', 'appModule', ...args.moduleAliases];
  }
  const ws = new Workspace(cfg);
  const rel = ws.toRelative(abs);

  // Print exactly which character the cursor lands on — so the result can be read, not guessed.
  const around = source.slice(Math.max(0, offset - 22), offset);
  const at = source.slice(offset, offset + 18).split('\n')[0];
  console.log(`${rel}:${line}:${col}  …${around}[${at}`);

  if (args.rename) {
    ws.index(); // rename needs the latest facts
    const r = ws.renameAt(rel, offset, args.rename);
    if (r.reason) {
      console.log(`  ✗ RENAME REFUSED: ${r.reason}`);
      process.exitCode = 1;
    } else {
      const perFile = new Map<string, number>();
      for (const e of r.edits) perFile.set(e.path, (perFile.get(e.path) ?? 0) + 1);
      console.log(`  rename '${r.query}' -> '${args.rename}': ${r.edits.length} location(s) (preview, does NOT write files)`);
      for (const [path, n] of perFile) console.log(`    ${String(n).padStart(4)}  ${path}`);
      if (r.note) console.log(`  ⓘ  ${r.note.split('\n').join('\n  ⓘ  ')}`);
    }
  } else if (args.refs) {
    const r = ws.referencesAt(rel, offset);
    console.log(`  refs '${r.query}': ${r.locations.length}`);
    for (const l of r.locations.slice(0, 12)) {
      const src = ws.source(l.path) ?? '';
      const lc = lineColOf(src, l.span.start);
      console.log(`    ${l.path}:${lc.line}:${lc.col} [${l.axis}]`);
    }
    if (r.locations.length > 12) console.log(`    … ${r.locations.length - 12} more`);
  } else {
    const d = ws.definitionAt(rel, offset);
    if (!d.targets.length && d.builtin) {
      // Builtin (window, $event…): no definition but NOT an error.
      console.log(`  ⓘ  ${d.reason}`);
    } else if (!d.targets.length) {
      console.log(`  ✗ NOT RESOLVED: ${d.reason ?? ''} (query='${d.query}')`);
      process.exitCode = 1;
    } else {
      for (const t of d.targets) {
        const src = ws.source(t.path) ?? '';
        const lc = lineColOf(src, t.span.start);
        const line = (src.split('\n')[lc.line - 1] ?? '').trim().slice(0, 70);
        console.log(`  ✓ ${t.path}:${lc.line}:${lc.col} [${t.kind}] ${line}`);
      }
    }
  }

  ws.close();
}

main();
