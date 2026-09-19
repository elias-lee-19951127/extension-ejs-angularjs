# 01 — Core: chỗ đặt logpoint cho một lần gán

**What to build:** Với mỗi lần gán vào scope là **cả một câu lệnh biểu thức**, index biết vị trí "ngay sau
câu lệnh" — nơi logpoint chạy sau lần gán (spec #3, đã đo). Kết quả kiểu đã thấy mang vị trí đó và vế
trái của lần gán, để server dựng link (spec #4).

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] `ScopeWrite.after?: number` — offset ngay sau câu lệnh chứa lần gán (sau `;`, hoặc cuối câu khi không có `;`),
      chỉ khi lần gán là `expression` của một `ExpressionStatement` (kể cả chuỗi `a = b = x;` — lấy câu lệnh ngoài cùng)
- [ ] Không có `after` khi gán nằm trong biểu thức khác: `return $scope.x = y`, `if ((x = y))`, `f($scope.x = y)`,
      thân arrow rút gọn `res => $scope.rows = res.data`, `for (…; …; $scope.i = …)`
- [ ] `ScopeWrite.lhsText` — vế trái đúng như viết (`$scope.rows`, `vm.rows`, `this.form.owner`)
- [ ] `ObservedTypeResult.unknownFrom[]` mang thêm `after?` và `lhsText`
- [ ] Tăng `PARSER_VERSION` (ghi lý do trong `schema.ts`)
- [ ] Test qua facts công khai: nhiều dòng, hàm một dòng, `if` một dòng, câu gán không có `;`, chuỗi gán,
      các dạng không có `after`; `lhsText` với `$scope` đổi tên qua DI mảng và `var vm = this`
