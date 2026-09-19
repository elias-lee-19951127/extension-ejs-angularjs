# 02 — Core: nối log với biến scope

**What to build:** Biết trước, cho mỗi lời gọi `console.*` trong file JS và mỗi biểu thức của một logpoint,
đối số nào là biến scope nào `(owner, path)` — để lúc nhận log server chỉ tra, không parse (spec #1, #2, #10).

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] Fact mới `JsFacts.consoleCalls`: span của lời gọi `console.<method>(…)` trực tiếp + mỗi đối số `{ owner, path } | null`
- [x] Đối số hợp lệ: chuỗi property thuần gốc ở `$scope` / bí danh tham số `$scope` / `this` / `var vm = this`
      (dùng lại `thisAliasTest` + `resolveBinding` — một định nghĩa "đây là scope" duy nhất), trong thân một khai báo
      Angular có scope; `owner` theo đúng luật của `scopeWrites`
- [x] `null` cho: `[i]`, biến cục bộ, lời gọi hàm, biểu thức tính toán, `console` bị che bởi biến cục bộ, lời gọi không trực tiếp (`logger.debug`)
- [x] Hàm tra: lời gọi tại một offset (offset từ frame V8 — xác định bằng test vị trí V8 báo cho một lời gọi `console.log`, không đoán)
- [x] Resolve biểu thức logpoint: `(relPath, dòng, exprText)` → `{ owner, path } | null` theo cùng luật; `{rows.length}`, `{a || b}` → `null`
- [x] Tăng `PARSER_VERSION` (ghi lý do trong `schema.ts`)
- [x] Test qua facts công khai: `$scope.rows`, `vm.form.owner` trong callback, tham số `$scope` đổi tên qua DI mảng,
      `console` bị che, wrapper, biểu thức logpoint hợp lệ và không hợp lệ

## Comments

**2026-09-19 — done.** `JsFacts.consoleCalls: ConsoleCall[]` (`{ method: Span, args: (ScopeTarget | null)[] }`),
trích ở `extractConsoleCalls` (`packages/core/src/extract/js.ts`) bằng đúng `scopePath` / `scopeParamName` /
`thisAliasTest` của `scopeWrites`. Chỉ ghi lời gọi có ít nhất một đối số là biến scope. `PARSER_VERSION` 14 → 15.

**Vị trí V8 báo (đo, Node 20.20):** frame của `console.log(…)` trỏ đúng **tên method** (`log`) — kể cả
`console . info (` và `console\n  .log(` xuống dòng; `console["log"](…)` thì trỏ dấu `(` (không hỗ trợ).
Nên tra bằng khớp **chính xác** `method.start === offset`, không khớp gần đúng. Có test chạy code thật
qua `node:inspector` để khẳng định, không đếm cột bằng tay.

Đối số sau spread (`...xs`) → `null` (không còn thẳng hàng với `args` của CDP). `console` bị che bởi
biến cục bộ → bỏ (qua `resolveBinding`).

Logpoint: `scopeTargetAt(source, facts, offset, expression)` + `Workspace.scopeTargetAt(relPath, offset, expr)` —
parse biểu thức bằng `acorn.parseExpressionAt`, chọn khai báo trong cùng chứa `offset`, gốc của biểu thức
resolve **tại `offset`** (không phải tại vị trí trong chuỗi biểu thức). Parse lại file mỗi lần gọi —
chấp nhận được vì chỉ gọi lúc `ejsng/setLogpoints`; ticket 03 nên gọi một lần mỗi logpoint, không mỗi log.
`Workspace.consoleCallAt(relPath, offset)` cho server.

Test: `packages/core/test/console-calls.test.js` (6). Toàn bộ: 448/453, 5 lỗi smart-city có sẵn (xem ticket 01).
