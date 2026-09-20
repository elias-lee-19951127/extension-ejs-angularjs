# 03 — Verify + tài liệu

**What to build:** Kiểm trong VS Code thật, rồi ghi vào tài liệu (bản Việt chính, bản Anh đi kèm).

**Blocked by:** 02

**Status:** done

- [x] Test e2e VS Code thật: `executeCodeLensProvider` trên fixture có lens đúng dòng, bấm → có logpoint đúng vị trí,
      bấm lại → mất; đổi setting sang `off` → không lens; `all` → nhiều lens hơn
- [x] `examples/log-at-runtime/README.md`: thêm bước dùng CodeLens (một click, không gõ)
- [x] `README.md` + `README.en.md`: dòng setting `ejsng.logLens` + một câu trong phần "Log at runtime"
- [x] `docs/kien-truc.md` + `docs/architecture.md`: mục mới — vì sao CodeLens (VS Code không cho điền sẵn ô Add Logpoint),
      bảng đo số lens, vì sao mặc định chỉ lấy lần gán không suy ra được kiểu
- [x] Cập nhật "Trạng thái" trong `spec.md`

## Comments

**2026-09-20 — done.** Test e2e VS Code 1.138 thật (+2): lens đúng **một** cái ở chế độ mặc định và nằm trên
dòng `$http.get(...).then(function (res) { $scope.rows = res.data; })` — đúng ca mà logpoint đặt ở lề không làm
được; bấm → logpoint ở đúng dòng+cột với nội dung `rows = {$scope.rows}`; nhãn đổi thành "click to remove"; bấm
lại → mất. Chế độ `all` ra 2 lens, `off` ra 0. 12/12 e2e xanh.

Fixture `list.controller.js` của e2e thêm một dòng `$scope.rows = []` để phân biệt `unknown` với `all`.

Tài liệu: README (cả hai bản, kèm dòng setting `ejsng.logLens`), demo `examples/log-at-runtime` (bước 1 giờ là
CodeLens), kiến trúc mục mới **5.3.5** (vì sao phải là CodeLens — VS Code không cho điền sẵn ô Add Logpoint;
bảng đo số lens; vì sao lens dựng ở client; chuyện thống nhất nội dung logpoint).

Đóng gói lại `ejs-angularjs-navigator-0.5.0.vsix` để bản này có luôn CodeLens.
