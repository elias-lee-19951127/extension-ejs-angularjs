# 01 — Core + server: đích log của một file

**What to build:** Một truy vấn trả **mọi** chỗ trong một file JS có thể đặt logpoint tự động, kèm đủ
thông tin để client dựng CodeLens và gọi `ejsng.logVariable` (spec #1, #4, #6).

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Core: `logTargetsIn(facts, source)` (thuần) → `{ lensLine, line, character, expression, logMessage, inferred }[]`
      — `lensLine` là dòng của câu gán (chỗ đặt lens), `line`/`character` là vị trí **ngay sau câu lệnh**
- [ ] Chỉ lần gán có `after` (spec #6); `expression` = `lhsText`; `logMessage` = `<tên ngắn> = {<lhsText>}`
      (tên ngắn = phần cuối của đường dẫn, `rows` cho `$scope.rows`)
- [ ] `inferred: false` khi lần gán đó có shape `unknown` — client lọc theo setting `ejsng.logLens`
- [ ] Nhiều lần gán trên **cùng một dòng** → một đích (lấy cái đầu), để không có hai lens chồng nhau
- [ ] `Workspace.logTargets(relPath)`; server: request `ejsng/logTargets { uri }` → `{ targets }`, file ngoài workspace hoặc không phải `.js` → `{ targets: [] }`
- [ ] Test core: nhiều lần gán, gán lồng (`$scope.form.extra`), `var vm = this`, dạng không có `after`, hai lần gán cùng dòng
- [ ] Test LSP: `ejsng/logTargets` trả đúng vị trí cho một controller; uri lạ → rỗng
