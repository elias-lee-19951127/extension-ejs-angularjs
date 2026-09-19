# 06 — Báo trạng thái kết nối thật, không chỉ ack lạc quan

**What to build:** `ejsng/connectRuntime` hiện trả `{connected: true}` ngay lập tức, trước khi
socket CDP thật sự mở hay báo lỗi — client (ticket 01) đang hiển thị "connected" dựa trên ack đó,
không phải trạng thái thật. Nếu kết nối thất bại ngay sau đó, hoặc rớt giữa chừng (tiến trình
target thoát, mất mạng), status bar vẫn kẹt ở "connected" — không có tín hiệu nào báo lại.

**Blocked by:** 01 — Hoàn thiện client VSCode v1 (dùng lại hạ tầng status bar đã có, chỉ thêm chỗ
nhận cập nhật trạng thái)

**Status:** done (phần lớn qua runtime-remote-env/02 — xem Comments)

- [x] Request `ejsng/connectRuntime` chỉ resolve (hoặc kèm một notification riêng) **sau khi**
      socket thật sự `open` hoặc `error` — không ack lạc quan trước đó
- [x] Kết nối rớt sau đó (tiến trình target thoát, socket đóng bất ngờ) cũng phát ra tín hiệu cho
      client — status bar chuyển về "disconnected"/"error" thay vì kẹt ở "connected"
- [x] Test qua LSP stdio: giả lập một CDP endpoint không mở được, và một endpoint đóng kết nối
      giữa chừng sau khi đã mở — xác nhận client nhận đúng cả hai tình huống

## Comments

**2026-09-19 — đóng.** Ticket này đã được gộp vào `.scratch/runtime-remote-env/issues/02-probe-an-toan-va-trang-thai-that.md`
(mục 3, "ticket 06 cũ"), đã `done`. Đối chiếu từng mục:

- **Mục 1 — làm khác chữ, có chủ đích:** `ejsng/connectRuntime` VẪN trả `'connected'` ngay khi tìm
  thấy target, để không đổi shape cho client IntelliJ sau này. Trạng thái thật
  `connecting → connected/failed` (kèm lý do) đi qua request `ejsng/runtimeStatus` và notification
  `ejsng/runtimeStatusChanged`; client dựa vào đó chứ không dựa vào ack.
- **Mục 2:** `onClose` của socket chuyển kết nối sang `failed`; vscode-client nghe notification,
  status bar hiện `(failed)`.
- **Mục 3:** test "socket không mở được" đã có từ trước
  (`runtime-log-connections-lsp.test.js`, "...socket is unreachable, and eventually reports it failed").
  Nửa còn thiếu — "đã mở rồi rớt giữa chừng" — thêm hôm nay: "a connection that opened and then
  drops is pushed to the client as failed" (inspector giả `terminate()` socket sau khi đã
  `connected`). Đã kiểm tra ngược: bỏ `setConnectionState(... 'failed' ...)` trong `onClose` thì test fail.
