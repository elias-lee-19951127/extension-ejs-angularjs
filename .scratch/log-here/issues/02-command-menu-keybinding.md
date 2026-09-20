# 02 — Client: lệnh, menu chuột phải, phím tắt

**What to build:** `ejsng.logHere` trong menu chuột phải của editor và trên phím tắt; tạo hoặc gỡ logpoint,
báo rõ khi từ chối (spec #1, #6, #8).

**Blocked by:** 01

**Status:** done

- [x] Lệnh `ejsng.logHere` — "EJS/NG: Log This at Runtime"; gọi `ejsng/logHere` với con trỏ + phần bôi đen
- [x] `menus.editor/context`: nhóm `debug`, `when: editorLangId == javascript`; vẫn hiện trong Command Palette
      (khác `ejsng.logVariable` / `ejsng.showLogValue`, hai lệnh đó cần tham số nên bị ẩn)
- [x] `keybindings`: `cmd+alt+l` (mac) / `ctrl+alt+l`, `when: editorTextFocus && editorLangId == javascript`
- [x] Có rồi thì gỡ (dùng `planLogVariable`, `toggle: true`)
- [x] Từ chối → thông báo nói đúng lý do, tiếng Anh: gọi hàm (chạy thật mỗi lần), `this` trong callback (gợi ý `vm`/`$scope`),
      không đọc được biểu thức, không phải file JS
- [x] Thông báo khi tạo thành công dùng lại đường của lens/hover (nút **Connect Runtime** / **Show**, cảnh báo khi logpoint bị tắt)
- [x] Test client cho phần thuần nếu có; phần còn lại để e2e

## Comments

**2026-09-20 — done.** Lệnh `ejsng.logHere` trong `extension.ts`: gửi con trỏ + phần bôi đen, nhận `target`
hoặc `reason`, rồi gọi thẳng `logVariable({ ...target, toggle: true })` — nên phần tạo/gỡ/thông báo dùng chung
một đường với CodeLens và link trong hover. `menus.editor/context` nhóm `debug@1` (`when: editorLangId == javascript`),
`keybindings` `cmd+alt+l` / `ctrl+alt+l` với cùng điều kiện. Lệnh này **không** ẩn khỏi Command Palette (khác
`logVariable`/`showLogValue`) vì nó chạy được từ con trỏ hiện tại.

Mỗi `reason` có một câu tiếng Anh nói luôn cách làm khác: lời gọi thì "point at a variable instead", `this`
trong callback thì "use `vm` or `$scope`".
