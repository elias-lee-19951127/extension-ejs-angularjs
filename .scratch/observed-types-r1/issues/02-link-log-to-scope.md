# 02 — Core: nối log với biến scope

**What to build:** Biết trước, cho mỗi lời gọi `console.*` trong file JS và mỗi biểu thức của một logpoint,
đối số nào là biến scope nào `(owner, path)` — để lúc nhận log server chỉ tra, không parse (spec #1, #2, #10).

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Fact mới `JsFacts.consoleCalls`: span của lời gọi `console.<method>(…)` trực tiếp + mỗi đối số `{ owner, path } | null`
- [ ] Đối số hợp lệ: chuỗi property thuần gốc ở `$scope` / bí danh tham số `$scope` / `this` / `var vm = this`
      (dùng lại `thisAliasTest` + `resolveBinding` — một định nghĩa "đây là scope" duy nhất), trong thân một khai báo
      Angular có scope; `owner` theo đúng luật của `scopeWrites`
- [ ] `null` cho: `[i]`, biến cục bộ, lời gọi hàm, biểu thức tính toán, `console` bị che bởi biến cục bộ, lời gọi không trực tiếp (`logger.debug`)
- [ ] Hàm tra: lời gọi tại một offset (offset từ frame V8 — xác định bằng test vị trí V8 báo cho một lời gọi `console.log`, không đoán)
- [ ] Resolve biểu thức logpoint: `(relPath, dòng, exprText)` → `{ owner, path } | null` theo cùng luật; `{rows.length}`, `{a || b}` → `null`
- [ ] Tăng `PARSER_VERSION` (ghi lý do trong `schema.ts`)
- [ ] Test qua facts công khai: `$scope.rows`, `vm.form.owner` trong callback, tham số `$scope` đổi tên qua DI mảng,
      `console` bị che, wrapper, biểu thức logpoint hợp lệ và không hợp lệ
