# 02a — Đổi server sang multi-connection + kết nối qua host:port

**What to build:** Nền tảng cho browser-side CDP (02b) — nhưng test được hoàn toàn bằng Node
(testbed đã có ở `/Volumes/mac-dev/project/ejsng-runtime-log-testbed`), không cần Chrome thật.
Server đổi từ giữ **một** `runtimeLogSocket` (epoch-guard, kết nối mới thay thế kết nối cũ — ticket
01) sang giữ **nhiều** kết nối đồng thời. Client đổi từ setting `ejsng.runtimeLog.inspectorUrl`
(URL đầy đủ, giờ xoá hẳn) sang command hỏi host:port, server tự dò target qua endpoint discovery
chuẩn của CDP (`http://<host>:<port>/json/list`) — dùng chung được cho cả Node `--inspect` lẫn
Chrome `--remote-debugging-port` sau này, vì cả hai expose cùng cơ chế.

**Blocked by:** 01 — Hoàn thiện client VSCode v1 (đã xong)

**Status:** ready-for-agent

- [ ] Server đổi từ `runtimeLogSocket: WebSocket | null` + epoch-guard sang quản lý **nhiều** kết
      nối cùng lúc (map theo key ổn định, ví dụ `host:port:targetId`) — kết nối mới **không** tự
      thay thế kết nối khác, chỉ thay khi trùng key
- [ ] Request kết nối nhận `{host, port}` (không phải URL đầy đủ) — server tự `GET
      http://<host>:<port>/json/list`, lọc target theo `type` thuộc `{page, node}` (Node Inspector
      tự khai `type: "node"`, không phải `"page"` — phải lọc cả hai, không chỉ `page`)
- [ ] Đúng 1 target khớp → tự kết nối ngay, trả về key của kết nối vừa tạo
- [ ] Nhiều hơn 1 target khớp → trả danh sách target (id, title, url, type) cho client, **không**
      tự kết nối
- [ ] 0 target khớp → trả kết quả rõ ràng báo không tìm thấy target nào (không phải lỗi im lặng
      hay throw)
- [ ] Request riêng để kết nối tới một target cụ thể theo id (dùng sau khi client đã chọn từ danh
      sách nhiều target)
- [ ] Request riêng để ngắt một kết nối cụ thể theo key
- [ ] Client: command `EJS/NG: Connect to Runtime` đổi sang hỏi host:port qua input box; **xoá
      hẳn** setting `ejsng.runtimeLog.inspectorUrl` (đã publish ở v0.2.0, nhưng khả năng cao chỉ
      người dùng hiện tại đang dùng — chấp nhận breaking change, không giữ lại giá trị mặc định)
  — nếu server trả danh sách nhiều target thì hiện Quick Pick (tiêu đề + url mỗi target) để chọn
- [ ] Client: status bar đổi sang hiện **số kết nối đang mở** (`EJS/NG Runtime: N connected`)
- [ ] Client: thêm command `EJS/NG: Disconnect Runtime` — Quick Pick liệt kê các kết nối đang mở
      (theo key) để chọn ngắt một cái
- [ ] Test toàn bộ bằng Node testbed đã có — không cần Chrome thật cho ticket này
