# 13 — Mapping khai tay kiểu `\\wsl.localhost\…` và mapping rộng đứng trước

**What to build:** Báo cáo thật ngày 2026-09-19 trên Remote-WSL: BE đã kết nối Docker + Node nhưng
không log nào của service hiện inline. Panel chỉ báo "file not readable", không nói đã tìm file ở đâu.

Nguyên nhân (đã xác nhận bằng `docker inspect` và `ls` trên máy người dùng):

1. `ejsng.runtimeLog.pathMappings` khai `local` dạng Windows `\\wsl.localhost\AlmaLinux-9\home\…`. Server
   chạy **trong** WSL nên không đọc được đường dẫn đó → mọi frame thành `unreadable-file`.
2. Mapping rộng `/home/cityos/aocs-cityos` đứng trước mapping lồng `/home/cityos/aocs-cityos/aocs`.
   Mapping khai tay là first-match-wins → mọi đường dẫn `aocs/…` bị đưa về bản `aocs-cityos-lusail/aocs/…`
   mà mount `~/projects/aocs` đè lên (file không tồn tại ở đó).
3. Log messaging của AOCS (log4js, mỗi message websocket một dòng) lấp đầy 5 ô "recent logs" nên log
   của người dùng không còn thấy trong panel; `node:events` hiện là "file not readable" gây nhiễu.

**Blocked by:** None

**Status:** done

- [x] `wslUncToLinuxPath` + `prepareDeclaredMappings`: đổi `\\wsl.localhost\<distro>\…` / `\\wsl$\…` sang
      đường dẫn Linux khi server không chạy trên Windows; xếp mapping khai tay theo `remote` dài nhất trước
      (sort ổn định; mapping khai tay vẫn thắng mapping suy từ mount).
- [x] Checklist Path Mapping: ghi chú mapping kiểu Windows kèm cách viết Linux, ghi chú đã xếp lại thứ tự,
      báo số log bị bỏ vì file ánh xạ không tồn tại; trạng thái `warn`.
- [x] Frame `unreadable-file` / `outside-workspace` mang `hostPath` — panel hiện "file not readable at …".
- [x] `node:*` vào `DEFAULT_SKIP_FRAME_PATTERNS`.
- [x] `recordFrameDiagnostic`: stack giống hệt chỉ giữ một ô, có `count` (panel hiện `×N`).
- [x] Test: `packages/core/test/runtime-log-wsl-mappings.test.js`, `packages/server/test/runtime-log-wsl-mappings.test.js`
      (dựng lại đúng cấu hình của người dùng), `formatSkipReason` ở client.
- [ ] Verify lại trên máy WSL thật của người dùng.
