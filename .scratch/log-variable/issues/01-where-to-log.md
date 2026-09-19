# 01 — Core: chỗ đặt logpoint cho một lần gán

**What to build:** Với mỗi lần gán vào scope là **cả một câu lệnh biểu thức**, index biết vị trí "ngay sau
câu lệnh" — nơi logpoint chạy sau lần gán (spec #3, đã đo). Kết quả kiểu đã thấy mang vị trí đó và vế
trái của lần gán, để server dựng link (spec #4).

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] `ScopeWrite.after?: number` — offset ngay sau câu lệnh chứa lần gán (sau `;`, hoặc cuối câu khi không có `;`),
      chỉ khi lần gán là `expression` của một `ExpressionStatement` (kể cả chuỗi `a = b = x;` — lấy câu lệnh ngoài cùng)
- [x] Không có `after` khi gán nằm trong biểu thức khác: `return $scope.x = y`, `if ((x = y))`, `f($scope.x = y)`,
      thân arrow rút gọn `res => $scope.rows = res.data`, `for (…; …; $scope.i = …)`
- [x] `ScopeWrite.lhsText` — vế trái đúng như viết (`$scope.rows`, `vm.rows`, `this.form.owner`)
- [x] `ObservedTypeResult.unknownFrom[]` mang thêm `after?` và `lhsText`
- [x] Tăng `PARSER_VERSION` (ghi lý do trong `schema.ts`)
- [x] Test qua facts công khai: nhiều dòng, hàm một dòng, `if` một dòng, câu gán không có `;`, chuỗi gán,
      các dạng không có `after`; `lhsText` với `$scope` đổi tên qua DI mảng và `var vm = this`

## Comments

**2026-09-20 — done.** `ScopeWrite.lhsText` + `ScopeWrite.after?` (`packages/core/src/types.ts`), tính ở
`extractScopeWrites` bằng `statementEnd(ancestors)`: leo qua chuỗi gán (`a = b = x;` → cả hai lần gán cùng
`after`), dừng ở `ExpressionStatement` — cha nào khác (`return`, lời gọi, điều kiện `if`, `for`, thân arrow
rút gọn, `SequenceExpression`) → không có `after`. `ExpressionStatement.end` của acorn đã gồm `;`; không có
`;` (ASI) thì là cuối biểu thức. `PARSER_VERSION` 15 → 16.
`TypeEvidence` + `ObservedTypeResult.unknownFrom[]` mang thêm `lhsText` / `after`.
Test: `packages/core/test/scope-writes.test.js` (+3), `packages/core/test/observed-type.test.js` (+1).
Toàn bộ: 5 lỗi smart-city có sẵn, còn lại xanh.
