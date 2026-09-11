#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Workspace, type Config } from '@ejsng/core';

/**
 * CLI cua bo cong cu.
 *
 * Khong phai thu phu (docs/kien-truc.md muc 9): no cho phep chay va do
 * toan bo tang core ma khong can mo IDE, nen tang toc phat trien va debug
 * len nhieu lan. Moi tinh nang LSP deu phai co duong tuong duong o day.
 */

function usage(): never {
  console.log(`
ejsng — cong cu track bien/ham giua EJS va AngularJS 1.x

  ejsng index [root]                    Danh index workspace
  ejsng stats [root]                    Thong ke index
  ejsng def   <file> <line> <col>       Go-to-definition tai vi tri
  ejsng refs  <file> <line> <col>       Find-all-references tai vi tri
  ejsng members <controller> [root]     Liet ke property tren scope cua controller
  ejsng unused [root]                   Symbol khong ai dung (ung vien dead code)
  ejsng sweep [root]                    Thu resolve MOI dinh danh trong moi template,
                                        bao cao do phu va liet ke cho con sot
  ejsng scan  <file>                    Do fact trich duoc tu mot file

Tuy chon:
  --root <path>            Thu muc goc (mac dinh: thu muc hien tai)
  --module-alias <ten>     Them ten bien duoc coi la angular module (lap lai duoc)
  --delimiter <ky tu>      Delimiter EJS (mac dinh '%')
  --json                   Xuat JSON
`);
  process.exit(1);
}

interface Opts {
  root: string;
  json: boolean;
  moduleAliases: string[];
  delimiter: string;
  rest: string[];
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { root: process.cwd(), json: false, moduleAliases: [], delimiter: '%', rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--root') opts.root = argv[++i] ?? opts.root;
    else if (a === '--module-alias') opts.moduleAliases.push(argv[++i] ?? '');
    else if (a === '--delimiter') opts.delimiter = argv[++i] ?? '%';
    else if (a === '--json') opts.json = true;
    else opts.rest.push(a);
  }
  return opts;
}

function makeWorkspace(opts: Opts): Workspace {
  const cfg: Partial<Config> & { root: string } = { root: resolvePath(opts.root) };
  if (opts.moduleAliases.length) {
    cfg.moduleAliases = ['myApp', 'app', 'appModule', ...opts.moduleAliases];
  }
  cfg.ejsDelimiter = opts.delimiter;
  return new Workspace(cfg);
}

/**
 * Offset nay co nam trong chuoi hoac chu thich khong?
 * Quet tuyen tinh tu dau file — du nhanh cho muc dich thong ke, va tranh dem
 * nham chu trong chu thich thanh "dinh danh khong resolve duoc".
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

/** Doi (dong, cot) 1-based sang offset. */
function toOffset(source: string, line: number, col: number): number {
  const lines = source.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i]!.length + 1;
  return off + col - 1;
}

/** Doi offset sang (dong, cot) 1-based. */
function toLineCol(source: string, offset: number): { line: number; col: number } {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
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
        `Da index ${r.indexed} file, bo qua ${r.skipped} (khong doi), xoa ${r.removed}, noi them ${r.linkedRefs} ref, mat ${r.ms}ms`,
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
        else if (!r.targets.length) console.log(`Khong tim thay: ${r.reason ?? ''} (query='${r.query}')`);
        else {
          console.log(`'${r.query}' →`);
          for (const t of r.targets) {
            const src = ws.source(t.path) ?? '';
            const lc = toLineCol(src, t.span.start);
            console.log(`  ${t.path}:${lc.line}:${lc.col}  [${t.kind}, ${t.confidence}] ${t.detail}`);
          }
        }
      } else {
        const r = ws.referencesAt(rel, offset);
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(`'${r.query}' — ${r.locations.length} tham chieu:`);
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

    case 'members': {
      const [controller] = opts.rest;
      if (!controller) usage();
      const ws = makeWorkspace(opts);
      const rows = ws.membersOf(controller);
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log(`${rows.length} property tren scope cua '${controller}':`);
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
        console.log(`${rows.length} symbol khong tim thay noi su dung:`);
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
      // Kiem thu dien rong: thay vi kiem diem le vai vi tri, thu TAT CA.
      // Day la cach duy nhat biet duoc con sot dang bieu thuc nao.
      if (opts.rest[0]) opts.root = opts.rest[0];
      const ws = makeWorkspace(opts);
      ws.index();

      let total = 0;
      let resolved = 0;
      let builtin = 0;
      const failures: string[] = [];

      // --- File .js: thu moi dinh danh trong ma nguon ---
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

      // --- Template: thu moi dinh danh trong bieu thuc Angular ---
      for (const rel of ws.templatePaths()) {
        const facts = ws.facts(rel);
        if (!facts || facts.kind !== 'template') continue;
        const src = ws.source(rel) ?? '';

        for (const expr of facts.expressions) {
          for (const root of expr.roots) {
            // Thu ca dinh danh goc lan tung doan property phia sau.
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
      console.log(`Tong so vi tri thu : ${total}`);
      console.log(`Resolve duoc       : ${resolved}`);
      console.log(`Bien dung san      : ${builtin}  (khong co dinh nghia, khong phai loi)`);
      console.log(`Con sot            : ${failures.length}`);
      console.log(`Do phu             : ${total ? ((covered / total) * 100).toFixed(1) : '0'}%`);
      if (failures.length) {
        console.log('\n--- cho con sot ---');
        failures.slice(0, 40).forEach((f) => console.log(f));
        if (failures.length > 40) console.log(`  … con ${failures.length - 40} cho nua`);
        process.exitCode = 1;
      }
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
