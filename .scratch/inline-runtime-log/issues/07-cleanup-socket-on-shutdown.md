# 07 — Dọn `runtimeLogSocket` khi server shutdown

**What to build:** `runtimeLogSocket` hiện chỉ bị đóng khi có lệnh `ejsng/connectRuntime` mới thay
thế nó — không có chỗ nào đóng nó khi server nhận đúng chuỗi tắt chuẩn của LSP (`shutdown`/`exit`).
Một kết nối debug đang mở bị bỏ lại treo khi server thoát.

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] Server đóng `runtimeLogSocket` (nếu đang mở) khi nhận chuỗi tắt chuẩn của LSP
- [x] Test qua LSP stdio: mở kết nối runtime, gửi `shutdown`, xác nhận socket được đóng tường minh
      (không dựa vào process bị kill mới dọn dẹp)

## Comments

**2026-09-19 — done.** Ticket viết từ thời còn một `runtimeLogSocket`; từ 02a server giữ
`runtimeLogConnections` (nhiều kết nối), nên `connection.onShutdown` giờ đóng **tất cả**:
xoá khỏi map trước (để handler `close` không báo `failed`), rồi `socket.close(1000)` — close frame
sạch, không phải `terminate()`. Test: `packages/server/test/runtime-log-shutdown-lsp.test.js` — mở 2
target, gửi `shutdown`, xác nhận inspector giả nhận close code 1000 trong khi process server vẫn
sống (chưa gửi `exit`), và `ejsng/runtimeStatus` trả về rỗng. Test fail khi bỏ fix.
