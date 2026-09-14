# 11 — Setting map đường dẫn container ↔ host (Docker)

**What to build:** Log từ tiến trình chạy trong Docker container báo đường dẫn **bên trong
container** (ví dụ `/app/app.js`), không khớp gì với đường dẫn thật trên máy host — hiện bị chặn
im lặng bởi guard "ngoài workspace" (đúng, vì `/app/app.js` không phải một relative path hợp lệ
dưới root thật). Đã verify thủ công bằng container thật (phiên 2026-09-14): kết nối được, nhận
được log, nhưng span/decoration không vẽ được vì lý do trên.

Không tự động dò mapping (Docker không expose thông tin mount path ra ngoài một cách đáng tin cậy
qua CDP) — làm **setting tự khai** kiểu `localRoot`/`remoteRoot` của debugger VSCode.

**Blocked by:** None — độc lập với ticket 10, làm trước/sau đều được.

**Status:** ready-for-agent

- [ ] Setting mới `ejsng.runtimeLog.pathMappings`: mảng `{remote: string, local: string}` (ví dụ
      `[{"remote": "/app", "local": "/Volumes/mac-dev/project/my-app"}]`), mặc định rỗng
- [ ] Mapping gửi lên server qua `initializationOptions` (giống `include`/`exclude`/... đã có),
      không cần request riêng
- [ ] Hàm thuần `mapContainerPath(fsPath, mappings)`: nếu `fsPath` bắt đầu bằng một `remote` đã
      khai, thay bằng `local` + phần còn lại; không khớp mapping nào thì trả nguyên `fsPath`
      (hành vi hiện tại, không đổi gì khi chưa cấu hình)
- [ ] Áp dụng `mapContainerPath` trước bước `workspace.toRelative(fsPath)` trong luồng xử lý log
      (chỗ đang bị guard "ngoài workspace" chặn nhầm log từ container)
- [ ] Test: log có `url` dạng đường dẫn container, có cấu hình mapping đúng → decoration vẽ đúng
      dòng trong file thật trên host; không có mapping khớp → vẫn bị chặn như cũ (không đổi hành
      vi mặc định)
