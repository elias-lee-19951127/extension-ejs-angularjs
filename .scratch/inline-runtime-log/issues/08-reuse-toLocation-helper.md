# 08 — Dùng lại `toLocation` thay vì tự dựng URI trong `ejsng/connectRuntime`

**What to build:** Handler `ejsng/connectRuntime` tự dựng `uri`/`range` bằng tay, trong khi file đã
có sẵn helper `toLocation(relPath, span)` làm đúng việc đó (đọc source, dựng URI, tính range) —
dùng ở mọi chỗ khác trong file. Đây là chỗ duy nhất còn tự làm lại theo cách khác, dọn cho nhất
quán, tránh phải sửa hai nơi nếu sau này đổi cách dựng URI.

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] Handler `ejsng/connectRuntime` gọi `toLocation(relPath, {start: offset, end: offset})` thay
      vì tự dựng `URI.file(...)` + `toRange(...)` tay
- [x] Không đổi hành vi quan sát được — bộ test LSP hiện có của tính năng này vẫn xanh, không cần
      sửa assertion

## Comments

**2026-09-19 — done, theo tinh thần chứ không theo đúng chữ.** Từ khi có log file ngoài workspace
(runtime-remote-env ticket 08), chỗ này dựng URI cho cả `hostPath` tuyệt đối — `toLocation` trả
`null` cho file đó. Và `source` ở đây đã đọc + verify trước một `await`; gọi `toLocation` sẽ đọc lại,
có thể lệch với `offset` đã tính. Nên thay vì gọi `toLocation`, tách helper `workspaceUri(ws, relPath)`
— giờ là chỗ DUY NHẤT dựng URI workspace-relative, dùng chung bởi `toLocation`, `fileLink` (hover)
và `ejsng/runtimeLog`. Không đổi hành vi; bộ test giữ nguyên, không sửa assertion.
