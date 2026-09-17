/**
 * Entry point `@vscode/test-electron` loads inside the extension host. A deliberately tiny
 * runner — sequential, one timeout per test, a TAP-like line per result — rather than pulling in
 * mocha: the tests share one VS Code window and must never run concurrently anyway.
 */
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { registeredTests } = require('./helpers');

const TEST_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${name}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

exports.run = async function run() {
  for (const file of readdirSync(__dirname).filter((f) => f.endsWith('.e2e.js')).sort()) {
    require(join(__dirname, file));
  }

  const failures = [];
  const suiteStart = Date.now();
  for (const [index, { name, fn, cleanup }] of registeredTests.entries()) {
    const start = Date.now();
    try {
      await withTimeout(Promise.resolve().then(fn), TEST_TIMEOUT_MS, name);
      console.log(`ok ${index + 1} - ${name} (${Date.now() - start}ms)`);
    } catch (err) {
      failures.push(name);
      console.log(`not ok ${index + 1} - ${name} (${Date.now() - start}ms)`);
      console.log(`  ${String(err && err.stack ? err.stack : err).split('\n').join('\n  ')}`);
    } finally {
      for (const step of cleanup.splice(0).reverse()) {
        try {
          await step();
        } catch (err) {
          console.log(`  cleanup failed: ${err}`);
        }
      }
    }
  }
  console.log(`# tests ${registeredTests.length}, pass ${registeredTests.length - failures.length}, fail ${failures.length}, ${Date.now() - suiteStart}ms`);
  if (failures.length > 0) throw new Error(`${failures.length} e2e test(s) failed: ${failures.join('; ')}`);
};
