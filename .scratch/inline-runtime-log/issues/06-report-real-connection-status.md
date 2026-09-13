# 06 — Báo trạng thái kết nối thật, không chỉ ack lạc quan

**What to build:** `ejsng/connectRuntime` hiện trả `{connected: true}` ngay lập tức, trước khi
socket CDP thật sự mở hay báo lỗi — client (ticket 01) đang hiển thị "connected" dựa trên ack đó,
không phải trạng thái thật. Nếu kết nối thất bại ngay sau đó, hoặc rớt giữa chừng (tiến trình
target thoát, mất mạng), status bar vẫn kẹt ở "connected" — không có tín hiệu nào báo lại.

**Blocked by:** 01 — Hoàn thiện client VSCode v1 (dùng lại hạ tầng status bar đã có, chỉ thêm chỗ
nhận cập nhật trạng thái)

**Status:** ready-for-agent

- [ ] Request `ejsng/connectRuntime` chỉ resolve (hoặc kèm một notification riêng) **sau khi**
      socket thật sự `open` hoặc `error` — không ack lạc quan trước đó
- [ ] Kết nối rớt sau đó (tiến trình target thoát, socket đóng bất ngờ) cũng phát ra tín hiệu cho
      client — status bar chuyển về "disconnected"/"error" thay vì kẹt ở "connected"
- [ ] Test qua LSP stdio: giả lập một CDP endpoint không mở được, và một endpoint đóng kết nối
      giữa chừng sau khi đã mở — xác nhận client nhận đúng cả hai tình huống
