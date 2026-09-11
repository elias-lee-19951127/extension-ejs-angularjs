#!/usr/bin/env node
/**
 * Dong goi extension VSCode.
 *
 * VI SAO PHAI BUNDLE thay vi tro thang toi packages/server:
 * ban dau extension.ts tro toi `../server/dist/index.js` bang asAbsolutePath.
 * Cach do chay duoc trong monorepo luc phat trien, nhung khi dong goi .vsix thi
 * duong dan do nam NGOAI thu muc extension nen khong duoc dong goi vao — extension
 * cai tu Marketplace se khong tim thay server.
 *
 * Ngoai ra VSCode chay extension trong Electron: bundle het thanh mot file CommonJS
 * giup khoi dong nhanh hon va khong phu thuoc cach npm dung cay node_modules.
 *
 * Bundle duoc la nho da bo `better-sqlite3` (docs/kien-truc.md phu luc D):
 * native module khong the bundle, va ABI cua Electron khac han Node thuong.
 */
const esbuild = require('esbuild');
const { join, resolve } = require('node:path');

const ROOT = __dirname;
const REPO = resolve(ROOT, '..', '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

const targets = [
  {
    // Phia client: `vscode` do runtime cung cap, khong duoc bundle.
    ...common,
    entryPoints: [join(ROOT, 'out', 'extension.js')],
    outfile: join(ROOT, 'dist', 'extension.js'),
    external: ['vscode'],
  },
  {
    // Language server: bundle ca @ejsng/core va moi dependency vao mot file.
    ...common,
    entryPoints: [join(REPO, 'packages', 'server', 'dist', 'index.js')],
    outfile: join(ROOT, 'dist', 'server.js'),
    external: [],
  },
];

async function main() {
  if (watch) {
    const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('esbuild: dang theo doi thay doi...');
    return;
  }

  for (const target of targets) await esbuild.build(target);
  console.log('esbuild: xong');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
