/**
 * Bat bien: moi span trong fact template phai tro DUNG vao chu no dai dien.
 *
 * Dieu huong khong phat hien duoc span lech mot ky tu — `inSpan` tinh ca hai dau
 * mut, nen dat con tro o ky tu nao cua ten van "trung". Rename thi co: sua lech
 * mot ky tu la lam hong code nguoi dung. Xem docs/kien-truc.md phu luc I.
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
    if (got !== want) bad.push(`${rel} ${what}: can ${JSON.stringify(want)}, span tro vao ${JSON.stringify(got)}`);
  };
  for (const rel of files) {
    const src = readFileSync(join(root, rel), 'utf8');
    const f = C.extractTemplate(src, { ...C.DEFAULT_CONFIG, root });
    for (const e of f.expressions) {
      check(rel, src, e.span, e.text, `bieu thuc ${e.source}`);
      for (const r of e.roots) check(rel, src, r.span, r.name, `goc '${r.name}'`);
      for (const fl of e.filters) check(rel, src, fl.span, fl.name, `filter '${fl.name}'`);
      for (const frame of e.scopeChain) {
        for (const l of frame.locals) {
          if (l.span.start === l.span.end) continue; // bien dung san ($index…) khong co cho khai bao
          check(rel, src, l.span, l.name, `bien cuc bo '${l.name}'`);
        }
      }
    }
    for (const c of f.controllers) check(rel, src, c.span, c.name, 'ten ng-controller');
    for (const a of f.attrCandidates) check(rel, src, a.valueSpan, a.value, `gia tri thuoc tinh ${a.attr}`);
  }
  return { files: files.length, bad };
}

test('span template tro dung vao chu: fixture', () => {
  assert.deepStrictEqual(spanViolations(FIXTURE).bad, []);
});

test('span template tro dung vao chu: smart-city', { skip: !existsSync(REAL) && 'khong co repo smart-city' }, () => {
  const { files, bad } = spanViolations(REAL);
  assert.ok(files > 0);
  assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length} span lech`);
});
