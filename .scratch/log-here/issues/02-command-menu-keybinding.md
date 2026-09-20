# 02 — Client: lệnh, menu chuột phải, phím tắt

**What to build:** `ejsng.logHere` trong menu chuột phải của editor và trên phím tắt; tạo hoặc gỡ logpoint,
báo rõ khi từ chối (spec #1, #6, #8).

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Lệnh `ejsng.logHere` — "EJS/NG: Log This at Runtime"; gọi `ejsng/logHere` với con trỏ + phần bôi đen
- [ ] `menus.editor/context`: nhóm `debug`, `when: editorLangId == javascript`; vẫn hiện trong Command Palette
      (khác `ejsng.logVariable` / `ejsng.showLogValue`, hai lệnh đó cần tham số nên bị ẩn)
- [ ] `keybindings`: `cmd+alt+l` (mac) / `ctrl+alt+l`, `when: editorTextFocus && editorLangId == javascript`
- [ ] Có rồi thì gỡ (dùng `planLogVariable`, `toggle: true`)
- [ ] Từ chối → thông báo nói đúng lý do, tiếng Anh: gọi hàm (chạy thật mỗi lần), `this` trong callback (gợi ý `vm`/`$scope`),
      không đọc được biểu thức, không phải file JS
- [ ] Thông báo khi tạo thành công dùng lại đường của lens/hover (nút **Connect Runtime** / **Show**, cảnh báo khi logpoint bị tắt)
- [ ] Test client cho phần thuần nếu có; phần còn lại để e2e
