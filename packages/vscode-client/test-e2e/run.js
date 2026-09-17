/**
 * Seam 3 of the runtime-remote-env spec, ticket 11 (.scratch/runtime-remote-env/issues/11-test-tu-dong-client.md):
 * run the extension inside a real VS Code (`@vscode/test-electron`) against its real, bundled
 * language server and a fake CDP runtime, and check what the user would see — decorations, the
 * status bar, the panel.
 *
 * Usage: `npm run test:e2e -w packages/vscode-client` (builds first). On Linux without a display,
 * wrap it in `xvfb-run -a`. `VSCODE_TEST_VERSION` picks the VS Code build (default: stable).
 */
const { runTests } = require('@vscode/test-electron');
const { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join } = require('node:path');

/**
 * A `docker` that knows no containers, first on PATH. Connect always tries Docker discovery
 * before anything else; on a developer machine with real Node containers running, that would
 * attach the tests to them instead of to the fake runtimes.
 */
function writeEmptyDocker(dir) {
  const script = join(dir, 'docker');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      "const cmd = process.argv[2];",
      "if (cmd === 'version') { process.stdout.write('0.0.0-e2e\\n'); process.exit(0); }",
      "if (cmd === 'ps') process.exit(0);",
      "if (cmd === 'inspect') { process.stdout.write('[]'); process.exit(0); }",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
}

async function main() {
  const packageRoot = join(__dirname, '..');
  // realpath: on macOS the temp dir sits behind a symlink, and the tests compare file URIs.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ejsng-e2e-')));
  const workspace = join(scratch, 'workspace');
  const bin = join(scratch, 'bin');
  cpSync(join(__dirname, 'fixture'), workspace, { recursive: true });
  mkdirSync(bin);
  writeEmptyDocker(bin);

  const startedAt = Date.now();
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || 'stable',
      cachePath: join(packageRoot, '.vscode-test'),
      extensionDevelopmentPath: packageRoot,
      extensionTestsPath: join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${join(scratch, 'user-data')}`,
      ],
      extensionTestsEnv: {
        EJSNG_EXTENSION_TEST: '1',
        EJSNG_E2E_WORKSPACE: workspace,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
    });
  } finally {
    console.log(`e2e: VS Code run took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
