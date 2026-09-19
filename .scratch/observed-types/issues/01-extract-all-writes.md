# 01 — Extractor: ghi mọi lần gán, gán lồng, primitive có kiểu, cờ rỗng / callback

**What to build:** Layer 2 ghi **mọi** lần gán vào scope của một controller/directive/component —
không chỉ lần đầu — vào một fact mới, tách khỏi `scopeMembers` (spec #9). Bao gồm gán lồng
`$scope.form.extra = …` (spec #6). Mỗi lần gán mang đủ thông tin để ticket 02 gộp và để hover nói
lý do khi không suy ra được kiểu.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Fact mới trong `JsFacts` (tên gợi ý `scopeWrites`): mỗi phần tử có `owner`, `via` (`$scope`/`this`),
      `path` (`['form']`, hoặc `['form', 'extra']` cho gán lồng), `span` của vế trái, `shape`,
      `nullable` (bool), `inCallback` (bool), và `rhsText` rút gọn (≤ 40 ký tự) cho hover khi shape là `unknown`
- [ ] `scopeMembers` **giữ nguyên** hành vi (chỉ lần gán đầu) — go-to-definition và rename không đổi
- [ ] `inferShape`: `Literal` phân loại `string` / `number` / `boolean` / `null`; `TemplateLiteral` → `string`;
      `!x` → `boolean`; phép so sánh → `boolean`. Mở rộng `ValueShape` cho việc này mà không làm vỡ
      người dùng cũ của `kind: 'primitive'` (Shape Walking, completion)
- [ ] `nullable`: `null`, `undefined`, `void 0`; nhánh của `a ? b : c`; vế phải của `a || b` / `a ?? b`
- [ ] `inCallback`: lần gán nằm trong một hàm lồng bên trong thân controller (callback `$http`, `$timeout`, handler), không phải thân chính
- [ ] Tăng `PARSER_VERSION` (ghi lý do trong comment của `schema.ts`)
- [ ] Test ở `packages/core/test/` qua facts công khai (`extractJs` / `Workspace.facts`), gồm: gán nhiều lần,
      gán lồng hai cấp, `x ? obj : null`, gán trong `.then(function(){…})`, controller dạng mảng DI đổi tên `$scope`
- [ ] Sweep `smart-city` không đổi (go-to-definition không bị ảnh hưởng)
