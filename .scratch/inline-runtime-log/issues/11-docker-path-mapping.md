# 11 — Setting map đường dẫn container ↔ host (Docker)

**What to build:** Log từ tiến trình chạy trong Docker container báo đường dẫn **bên trong
container** (ví dụ `/app/app.js`), không khớp gì với đường dẫn thật trên máy host — hiện bị chặn
im lặng bởi guard "ngoài workspace" (đúng, vì `/app/app.js` không phải một relative path hợp lệ
dưới root thật). Đã verify thủ công bằng container thật (phiên 2026-09-14): kết nối được, nhận
được log, nhưng span/decoration không vẽ được vì lý do trên.

Không tự động dò mapping (Docker không expose thông tin mount path ra ngoài một cách đáng tin cậy
qua CDP) — làm **setting tự khai** kiểu `localRoot`/`remoteRoot` của debugger VSCode.

**Blocked by:** None — độc lập với ticket 10, làm trước/sau đều được.

**Status:** done — verify tay UI còn lại

- [x] Setting mới `ejsng.runtimeLog.pathMappings`: mảng `{remote: string, local: string}` (ví dụ
      `[{"remote": "/app", "local": "/Volumes/mac-dev/project/my-app"}]`), mặc định rỗng
- [x] Mapping gửi lên server qua `initializationOptions` (giống `include`/`exclude`/... đã có),
      không cần request riêng
- [x] Hàm thuần `mapContainerPath(fsPath, mappings)`: nếu `fsPath` bắt đầu bằng một `remote` đã
      khai, thay bằng `local` + phần còn lại; không khớp mapping nào thì trả nguyên `fsPath`
      (hành vi hiện tại, không đổi gì khi chưa cấu hình)
- [x] Áp dụng `mapContainerPath` trước bước `workspace.toRelative(fsPath)` trong luồng xử lý log
      (chỗ đang bị guard "ngoài workspace" chặn nhầm log từ container)
- [x] Test: log có `url` dạng đường dẫn container, có cấu hình mapping đúng → decoration vẽ đúng
      dòng trong file thật trên host; không có mapping khớp → vẫn bị chặn như cũ (không đổi hành
      vi mặc định) — 8 test mới ở `runtime-log-path-mapping.test.js` (6 thuần + 2 LSP)

## Comments

Verify bằng container Docker thật (không chỉ test giả lập): container `node:20-alpine` báo
`console.log` từ `/app/app.js`, cấu hình `pathMappings: [{remote: "/app", local: <root>}]` →
notification `ejsng/runtimeLog` trả đúng `uri: file://<root>/app.js` — đúng chính xác kịch bản bị
chặn im lặng phát hiện lúc đầu phiên, giờ đã hoạt động đúng.

Còn thiếu: verify tay UI setting trong VSCode Settings thật (gõ mapping, kết nối container thật,
xem decoration vẽ đúng) — gộp vào danh sách verify còn treo ở ticket 09.
