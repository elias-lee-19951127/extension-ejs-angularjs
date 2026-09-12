/**
 * Tien ich dung chung cho cac file test.
 *
 * Dinh vi bang CHUOI chu khong bang so dong/cot: dem cot bang tay da vai lan
 * lam ket luan sai ve san pham (docs/kien-truc.md phu luc F.3).
 */
const assert = require('node:assert');

/** Vi tri cua lan xuat hien thu `nth` cua `needle`, dich them `offset` ky tu. */
function at(ws, rel, needle, { nth = 1, offset = 0 } = {}) {
  const src = ws.source(rel);
  assert.ok(src, `khong doc duoc ${rel}`);
  let idx = -1;
  for (let n = 0; n < nth; n++) {
    idx = src.indexOf(needle, idx + 1);
    assert.notStrictEqual(idx, -1, `khong tim thay lan ${nth} cua ${JSON.stringify(needle)} trong ${rel}`);
  }
  return idx + offset;
}

function textAt(ws, target) {
  const src = ws.source(target.path) ?? '';
  return src.slice(target.span.start, target.span.end);
}

/**
 * Ap cac edit cua mot lan rename, tra ve { [path]: noi dung moi } — chi file bi sua.
 * Ap tu cuoi file len dau de edit phia sau khong lam lech offset cua edit phia truoc.
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
