#!/usr/bin/env node
/**
 * Harness kiem thu: dinh vi bang CHUOI thay vi bang so dong/cot.
 *
 * Ly do ton tai: khi kiem thu bang tay, dem cot rat de sai — trong qua trinh
 * phat trien da vai lan bao "khong tim thay" chi vi tro nham vao `id="kbm-file-input"`
 * thay vi thuoc tinh `kbm-file`, hoac tro vao giua `data-ng-class=` thay vi vao
 * bieu thuc. Sai o cho kiem thu nguy hiem hon sai o code: no lam ta ket luan nham
 * ve san pham.
 *
 * Cach dung:
 *   ejsng-probe <file> <needle> [--nth N] [--offset K] [--refs] --root <path>
 *
 *   <needle>   chuoi can tim trong file, vi du "section.enabled"
 *   --nth N    lay lan xuat hien thu N (mac dinh 1)
 *   --offset K dich K ky tu tu dau chuoi tim duoc — de tro vao giua chuoi,
 *              vi du "section.id" voi --offset 8 se tro vao chu 'id'
 *   --refs     chay find-references thay vi go-to-definition
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
    root: process.cwd(),
    moduleAliases: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--nth') args.nth = Number(argv[++i] ?? 1);
    else if (a === '--offset') args.offset = Number(argv[++i] ?? 0);
    else if (a === '--refs') args.refs = true;
    else if (a === '--root') args.root = argv[++i] ?? args.root;
    else if (a === '--module-alias') args.moduleAliases.push(argv[++i] ?? '');
    else positional.push(a);
  }

  args.file = positional[0] ?? '';
  args.needle = positional[1] ?? '';
  if (!args.file || !args.needle) {
    console.error('Dung: ejsng-probe <file> <needle> [--nth N] [--offset K] [--refs] --root <path>');
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

  // Tim lan xuat hien thu nth
  let idx = -1;
  for (let n = 0; n < args.nth; n++) {
    idx = source.indexOf(args.needle, idx + 1);
    if (idx === -1) {
      console.error(`Khong tim thay lan thu ${args.nth} cua ${JSON.stringify(args.needle)}`);
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

  // In ra chinh xac dang tro vao ky tu nao — de doc ket qua khong phai doan.
  const around = source.slice(Math.max(0, offset - 22), offset);
  const at = source.slice(offset, offset + 18).split('\n')[0];
  console.log(`${rel}:${line}:${col}  …${around}[${at}`);

  if (args.refs) {
    const r = ws.referencesAt(rel, offset);
    console.log(`  refs '${r.query}': ${r.locations.length}`);
    for (const l of r.locations.slice(0, 12)) {
      const src = ws.source(l.path) ?? '';
      const lc = lineColOf(src, l.span.start);
      console.log(`    ${l.path}:${lc.line}:${lc.col} [${l.axis}]`);
    }
    if (r.locations.length > 12) console.log(`    … con ${r.locations.length - 12} cho nua`);
  } else {
    const d = ws.definitionAt(rel, offset);
    if (!d.targets.length && d.builtin) {
      // Dung san (window, $event…): khong co dinh nghia nhung KHONG phai loi.
      console.log(`  ⓘ  ${d.reason}`);
    } else if (!d.targets.length) {
      console.log(`  ✗ KHONG RESOLVE: ${d.reason ?? ''} (query='${d.query}')`);
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
