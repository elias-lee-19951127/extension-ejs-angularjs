/**
 * Invariant: every span in a template's facts must point EXACTLY at the character it represents.
 *
 * Navigation doesn't catch a span off by one character — `inSpan` checks both endpoints
 * inclusively, so placing the cursor on either boundary character of the name still
 * "matches". Rename does: an edit off by one character breaks the user's code. See
 * docs/kien-truc.md Appendix I.
 */
const test = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { existsSync, readFileSync } = require('node:fs');
const fg = require('fast-glob');
const C = require('../dist');

const FIXTURE = join(__dirname, '..', '..', '..', 'fixtures', 'mini');
const REAL = '/Volumes/mac-dev/project/smart-city';

function spanViolations(root) {
  const files = fg.sync(['**/*.ejs', '**/*.html', '**/*.htm'], {
    cwd: root,
    ignore: C.DEFAULT_CONFIG.exclude,
  });
  const bad = [];
  const check = (rel, src, span, want, what) => {
    const got = src.slice(span.start, span.end);
    if (got !== want) bad.push(`${rel} ${what}: expected ${JSON.stringify(want)}, span points at ${JSON.stringify(got)}`);
  };
  for (const rel of files) {
    const src = readFileSync(join(root, rel), 'utf8');
    const f = C.extractTemplate(src, { ...C.DEFAULT_CONFIG, root });
    for (const e of f.expressions) {
      check(rel, src, e.span, e.text, `expression ${e.source}`);
      for (const r of e.roots) check(rel, src, r.span, r.name, `root '${r.name}'`);
      for (const fl of e.filters) check(rel, src, fl.span, fl.name, `filter '${fl.name}'`);
      for (const frame of e.scopeChain) {
        for (const l of frame.locals) {
          if (l.span.start === l.span.end) continue; // a built-in variable ($index…) has no declaration site
          check(rel, src, l.span, l.name, `local variable '${l.name}'`);
        }
      }
    }
    for (const c of f.controllers) check(rel, src, c.span, c.name, 'ng-controller name');
    for (const a of f.attrCandidates) check(rel, src, a.valueSpan, a.value, `attribute value ${a.attr}`);
  }
  return { files: files.length, bad };
}

test('template spans point exactly at their text: fixture', () => {
  assert.deepStrictEqual(spanViolations(FIXTURE).bad, []);
});

test('template spans point exactly at their text: smart-city', { skip: !existsSync(REAL) && 'smart-city repo not available' }, () => {
  const { files, bad } = spanViolations(REAL);
  assert.ok(files > 0);
  assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length} span(s) off`);
});
