# 03 — Port hiển thị sang IntelliJ

**What to build:** Decoration tương đương client VSCode nhưng trên `packages/intellij-client`
(LSP4IJ) — spec.md quyết định #2 loại IntelliJ khỏi v1 để tránh cộng dồn rủi ro thiết kế +
Kotlin/Gradle ngay từ đầu; lúc này logic map log→span đã chứng minh ổn ở server (seam 1-3),
ticket này chỉ còn việc vẽ decoration phía client.

**Blocked by:** 01 — Hoàn thiện client VSCode v1

**Status:** ready-for-agent

- [ ] `packages/intellij-client` nhận notification `ejsng/runtimeLog` qua LSP4IJ (custom
      notification, không phải capability LSP chuẩn — xem cách VSCode client ở ticket 01 làm)
- [ ] Vẽ decoration/inlay tương đương VSCode: giá trị mới nhất hiện cạnh đúng dòng
- [ ] Setting tương đương `ejsng.runtimeLog.inspectorUrl` và command tương đương
      `EJS/NG: Connect to Runtime` có mặt trong IntelliJ plugin
- [ ] Không sửa logic server — chỉ thêm client, đúng nguyên tắc "một server, hai client mỏng"
      quay lại đúng hình dạng ban đầu sau ticket này
