# 01 — Hoàn thiện client VSCode v1 (setting, command, decoration, status bar)

**What to build:** Phần client còn thiếu của v1 (spec.md quyết định #7) — server đã có sẵn pipeline
đầy đủ (`ejsng/connectRuntime` → `ejsng/runtimeLog`, xem `.scratch/inline-runtime-log/spec.md`
mục "Điểm neo trong code"), nhưng chưa có cách nào trong VSCode để kích hoạt hay nhìn thấy kết quả.
Ticket này hoàn thiện đúng phần đó — không đổi logic server.

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] Setting `ejsng.runtimeLog.inspectorUrl` khai trong `packages/vscode-client/package.json`
      (mặc định rỗng = tắt tính năng, đúng quyết định #4 trong spec)
- [x] Command `EJS/NG: Connect to Runtime` gọi request `ejsng/connectRuntime` với giá trị setting
      hiện tại — kích hoạt thủ công, không tự động connect/retry (quyết định #7)
- [x] Client lắng nghe notification `ejsng/runtimeLog`, vẽ decoration
      (`TextEditorDecorationType`) ở cuối dòng tương ứng — chỉ giữ giá trị **mới nhất** mỗi dòng,
      đè khi có log mới tới (quyết định #6, không lịch sử)
- [x] Status bar item phản ánh trạng thái kết nối (connected / disconnected / error)
- [x] Xác minh bằng tay qua Extension Development Host — người dùng xác nhận connected, thấy log
      inline đúng dòng, màu theo severity (log/warn/error), object/array hiện chi tiết qua preview

## Comments

Sau khi xác minh thủ công vòng đầu, phát sinh 2 chỉnh sửa nhỏ (không đổi acceptance criteria):
decoration ban đầu neo theo cột CDP báo về (bị tách giữa `console.log(...)`) — sửa lại neo ở cuối
dòng; và bổ sung phân loại `severity` (log/warning/error) + màu tương ứng + hiện chi tiết
object/array qua CDP `preview` (không có trong acceptance criteria gốc nhưng người dùng yêu cầu
thêm trong lúc xác minh, đã TDD ở seam 2 server-side).
