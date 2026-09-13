# 01 — Hoàn thiện client VSCode v1 (setting, command, decoration, status bar)

**What to build:** Phần client còn thiếu của v1 (spec.md quyết định #7) — server đã có sẵn pipeline
đầy đủ (`ejsng/connectRuntime` → `ejsng/runtimeLog`, xem `.scratch/inline-runtime-log/spec.md`
mục "Điểm neo trong code"), nhưng chưa có cách nào trong VSCode để kích hoạt hay nhìn thấy kết quả.
Ticket này hoàn thiện đúng phần đó — không đổi logic server.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Setting `ejsng.runtimeLog.inspectorUrl` khai trong `packages/vscode-client/package.json`
      (mặc định rỗng = tắt tính năng, đúng quyết định #4 trong spec)
- [ ] Command `EJS/NG: Connect to Runtime` gọi request `ejsng/connectRuntime` với giá trị setting
      hiện tại — kích hoạt thủ công, không tự động connect/retry (quyết định #7)
- [ ] Client lắng nghe notification `ejsng/runtimeLog`, vẽ decoration
      (`TextEditorDecorationType`) ở cuối dòng tương ứng — chỉ giữ giá trị **mới nhất** mỗi dòng,
      đè khi có log mới tới (quyết định #6, không lịch sử)
- [ ] Status bar item phản ánh trạng thái kết nối (connected / disconnected / error)
- [ ] Xác minh bằng tay qua Extension Development Host hoặc skill `run` — phần UI client không
      nằm trong bộ test tự động qua stdio (đúng phạm vi đã chốt lúc TDD seam 1-3)
