# 01 — Extractor: ghi mọi lần gán, gán lồng, primitive có kiểu, cờ rỗng / callback

**What to build:** Layer 2 ghi **mọi** lần gán vào scope của một controller/directive/component —
không chỉ lần đầu — vào một fact mới, tách khỏi `scopeMembers` (spec #9). Bao gồm gán lồng
`$scope.form.extra = …` (spec #6). Mỗi lần gán mang đủ thông tin để ticket 02 gộp và để hover nói
lý do khi không suy ra được kiểu.

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] Fact mới trong `JsFacts` (tên gợi ý `scopeWrites`): mỗi phần tử có `owner`, `via` (`$scope`/`this`),
      `path` (`['form']`, hoặc `['form', 'extra']` cho gán lồng), `span` của vế trái, `shape`,
      `nullable` (bool), `inCallback` (bool), và `rhsText` rút gọn (≤ 40 ký tự) cho hover khi shape là `unknown`
- [x] `scopeMembers` **giữ nguyên** hành vi (chỉ lần gán đầu) — go-to-definition và rename không đổi
- [x] `inferShape`: `Literal` phân loại `string` / `number` / `boolean` / `null`; `TemplateLiteral` → `string`;
      `!x` → `boolean`; phép so sánh → `boolean`. Mở rộng `ValueShape` cho việc này mà không làm vỡ
      người dùng cũ của `kind: 'primitive'` (Shape Walking, completion)
- [x] `nullable`: `null`, `undefined`, `void 0`; nhánh của `a ? b : c`; vế phải của `a || b` / `a ?? b`
- [x] `inCallback`: lần gán nằm trong một hàm lồng bên trong thân controller (callback `$http`, `$timeout`, handler), không phải thân chính
- [x] Tăng `PARSER_VERSION` (ghi lý do trong comment của `schema.ts`)
- [x] Test ở `packages/core/test/` qua facts công khai (`extractJs` / `Workspace.facts`), gồm: gán nhiều lần,
      gán lồng hai cấp, `x ? obj : null`, gán trong `.then(function(){…})`, controller dạng mảng DI đổi tên `$scope`
- [x] Sweep `smart-city` không đổi (go-to-definition không bị ảnh hưởng)

## Comments

**2026-09-19 — done.** `JsFacts.scopeWrites: ScopeWrite[]` (`packages/core/src/types.ts`), trích ở
`extractScopeWrites` (`packages/core/src/extract/js.ts`); `PARSER_VERSION` 12 → 13. Test:
`packages/core/test/scope-writes.test.js` (7 test). Sweep smart-city trùng từng dòng.

Khác với chữ của ticket, cho ticket 02 biết:
- **`shapes: ValueShape[]` thay vì `shape`** — một shape cho mỗi nhánh của `a ? b : c` / `a || b`,
  đã bỏ nhánh null/undefined (thể hiện bằng `nullable`). Gán chỉ `null` → `shapes: []`.
  `a || []` → `[unknown, array]`: ticket 02 quyết định gộp "unknown | array" thế nào.
- `ValueShape.primitive?: 'string' | 'number' | 'boolean' | 'null' | 'undefined'` — trường tuỳ chọn,
  `kind` vẫn là `'primitive'`, nên Shape Walking/completion không đổi.
- `this` trong hàm lồng **không phải arrow** không được tính (đó là `this` của hàm đó) — khác
  `scopeMembers`, vốn vẫn tính.

Số liệu trên smart-city: 589 lần gán, **261 lồng** (gần nửa — xác nhận quyết định #6), 353 trong
callback, 43 nullable; primitive: 136 boolean, 90 string, 10 number.

**Chưa phủ (có từ trước, không riêng ticket này):** alias `const ctrl = this; ctrl.x = …` — cả
`scopeMembers` lẫn `scopeWrites` đều không nhận. Có trong `dha.controller.js` của smart-city. Tách
thành việc riêng.
