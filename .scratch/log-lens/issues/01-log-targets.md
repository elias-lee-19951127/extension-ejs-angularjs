# 01 — Core + server: đích log của một file

**What to build:** Một truy vấn trả **mọi** chỗ trong một file JS có thể đặt logpoint tự động, kèm đủ
thông tin để client dựng CodeLens và gọi `ejsng.logVariable` (spec #1, #4, #6).

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] Core: `logTargetsIn(facts, source)` (thuần) → `{ lensLine, line, character, expression, logMessage, inferred }[]`
      — `lensLine` là dòng của câu gán (chỗ đặt lens), `line`/`character` là vị trí **ngay sau câu lệnh**
- [x] Chỉ lần gán có `after` (spec #6); `expression` = `lhsText`; `logMessage` = `<tên ngắn> = {<lhsText>}`
      (tên ngắn = phần cuối của đường dẫn, `rows` cho `$scope.rows`)
- [x] `inferred: false` khi lần gán đó có shape `unknown` — client lọc theo setting `ejsng.logLens`
- [x] Nhiều lần gán trên **cùng một dòng** → một đích (lấy cái đầu), để không có hai lens chồng nhau
- [x] `Workspace.logTargets(relPath)`; server: request `ejsng/logTargets { uri }` → `{ targets }`, file ngoài workspace hoặc không phải `.js` → `{ targets: [] }`
- [x] Test core: nhiều lần gán, gán lồng (`$scope.form.extra`), `var vm = this`, dạng không có `after`, hai lần gán cùng dòng
- [x] Test LSP: `ejsng/logTargets` trả đúng vị trí cho một controller; uri lạ → rỗng

## Comments

**2026-09-20 — done.** `logTargetsIn(facts, source)` trong `packages/core/src/extract/js.ts` +
`Workspace.logTargets(relPath)` + request `ejsng/logTargets { uri }`. Mỗi dòng một đích (hai lần gán cùng dòng
thì lấy cái đầu, tránh hai lens chồng nhau); `inferred: false` khi lần gán có shape `unknown`; bỏ những lần gán
không có "ngay sau câu lệnh".

**Thống nhất nội dung logpoint:** đổi luôn link trong hover sang `rows = {$scope.rows}` (trước là
`$scope.rows = {$scope.rows}`). Test của lens phát hiện: hai chỗ bấm sinh hai nội dung khác nhau ở **cùng một
vị trí**, nên bấm cả hai sẽ ra hai logpoint chồng nhau.

Test: `packages/core/test/scope-writes.test.js` (+2), `packages/server/test/lsp.test.js` (+1).
