/**
 * Shared utilities for the test files.
 *
 * Locates positions by STRING rather than line/column numbers: counting columns by hand
 * has led to wrong conclusions about the product more than once (docs/kien-truc.md Appendix F.3).
 */
const assert = require('node:assert');

/** Position of the `nth` occurrence of `needle`, shifted by `offset` characters. */
function at(ws, rel, needle, { nth = 1, offset = 0 } = {}) {
  const src = ws.source(rel);
  assert.ok(src, `could not read ${rel}`);
  let idx = -1;
  for (let n = 0; n < nth; n++) {
    idx = src.indexOf(needle, idx + 1);
    assert.notStrictEqual(idx, -1, `occurrence ${nth} of ${JSON.stringify(needle)} not found in ${rel}`);
  }
  return idx + offset;
}

function textAt(ws, target) {
  const src = ws.source(target.path) ?? '';
  return src.slice(target.span.start, target.span.end);
}

/**
 * Apply the edits of a rename, returning { [path]: new content } — only the changed files.
 * Applied from the end of the file backward so a later edit doesn't shift the offset of an earlier one.
 */
function applyEdits(ws, edits) {
  const byPath = new Map();
  for (const e of edits) {
    if (!byPath.has(e.path)) byPath.set(e.path, []);
    byPath.get(e.path).push(e);
  }
  const out = {};
  for (const [path, list] of byPath) {
    let src = ws.source(path);
    for (const e of [...list].sort((a, b) => b.span.start - a.span.start)) {
      src = src.slice(0, e.span.start) + e.newText + src.slice(e.span.end);
    }
    out[path] = src;
  }
  return out;
}

module.exports = { at, textAt, applyEdits };
