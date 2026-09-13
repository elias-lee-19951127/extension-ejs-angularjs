# 08 — Dùng lại `toLocation` thay vì tự dựng URI trong `ejsng/connectRuntime`

**What to build:** Handler `ejsng/connectRuntime` tự dựng `uri`/`range` bằng tay, trong khi file đã
có sẵn helper `toLocation(relPath, span)` làm đúng việc đó (đọc source, dựng URI, tính range) —
dùng ở mọi chỗ khác trong file. Đây là chỗ duy nhất còn tự làm lại theo cách khác, dọn cho nhất
quán, tránh phải sửa hai nơi nếu sau này đổi cách dựng URI.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Handler `ejsng/connectRuntime` gọi `toLocation(relPath, {start: offset, end: offset})` thay
      vì tự dựng `URI.file(...)` + `toRange(...)` tay
- [ ] Không đổi hành vi quan sát được — bộ test LSP hiện có của tính năng này vẫn xanh, không cần
      sửa assertion
