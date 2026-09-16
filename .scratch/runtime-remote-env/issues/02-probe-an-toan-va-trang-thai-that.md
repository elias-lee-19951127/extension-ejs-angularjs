# 02 — Probe an toàn, đường dẫn thật, và nói thật trạng thái

**What to build:** Ba chỗ đang nói dối hoặc âm thầm hỏng, gộp lại vì cùng đụng một luồng:

1. Kết nối tới host không phải `localhost` luôn hỏng — mọi probe phải gửi header `Host: localhost`
   (Chrome và Node inspector từ chối header `Host` không phải IP/localhost để chống DNS rebinding),
   và ws URL runtime trả về phải được viết lại theo host:port thật đã dùng để tới nó.
2. Workspace root nằm sau symlink thì mọi log bị coi là "ngoài workspace" (ticket 12 của
   `.scratch/inline-runtime-log/`, chuyển hẳn về đây).
3. Panel báo `connected` ngay khi tạo socket chứ không đợi mở xong (ticket 06 cũ), và mọi log bị bỏ
   đều bỏ im lặng.

Xong ticket này, người dùng kết nối `cityos-web` sẽ thấy ngay "nhận 120 / vẽ 0 / bỏ 86 — ngoài
mapping", tức tự chẩn đoán được ca đã tốn cả phiên grill để tìm ra.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Prefactor trước: chuyển các hàm thuần của runtime-log (parse, format, so khớp) xuống
      `packages/core`, giữ adapter IO ở `packages/server` — các ticket sau có chỗ đặt logic thuần
- [ ] Probe discovery gửi `Host: localhost`; kết nối được tới một endpoint qua hostname không phải
      localhost (test dựng endpoint giả buộc kiểm tra header)
- [ ] ws URL được viết lại theo host:port đã dùng để tới, không dùng nguyên chuỗi runtime trả về
- [ ] Root và Runtime Path đều được resolve symlink trước khi so; file không tồn tại thì coi như
      không resolve được, không throw
- [ ] Trạng thái `connected` chỉ báo khi WebSocket mở thật; trước đó là `connecting`, hỏng thì là
      `failed` kèm lý do
- [ ] Server giữ, cho mỗi kết nối: số log nhận, số vẽ, số bỏ **theo từng lý do**; client hỏi được
      con số này qua LSP
- [ ] Status bar và panel hiện `nhận / vẽ / bỏ` thay vì chỉ `N connected`
- [ ] Các request LSP cũ (`ejsng/connectRuntime`, `connectRuntimeTarget`, `disconnectRuntime`) giữ
      nguyên shape — không phá client IntelliJ tương lai
