# 07 — Dọn `runtimeLogSocket` khi server shutdown

**What to build:** `runtimeLogSocket` hiện chỉ bị đóng khi có lệnh `ejsng/connectRuntime` mới thay
thế nó — không có chỗ nào đóng nó khi server nhận đúng chuỗi tắt chuẩn của LSP (`shutdown`/`exit`).
Một kết nối debug đang mở bị bỏ lại treo khi server thoát.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Server đóng `runtimeLogSocket` (nếu đang mở) khi nhận chuỗi tắt chuẩn của LSP
- [ ] Test qua LSP stdio: mở kết nối runtime, gửi `shutdown`, xác nhận socket được đóng tường minh
      (không dựa vào process bị kill mới dọn dẹp)
