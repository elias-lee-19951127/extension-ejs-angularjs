# 02b — Xác minh kết nối CDP tới trình duyệt thật (Chrome/Edge)

**What to build:** Xác nhận cơ chế multi-connection + host:port discovery đã xây ở 02a hoạt động
đúng khi target thật là một **tab Chrome/Edge** (`--remote-debugging-port`), không chỉ Node. Chỉ
hỗ trợ Chromium — không Firefox (giao thức debug khác hẳn CDP, ngoài phạm vi).

**Blocked by:** 02a — Đổi server sang multi-connection + kết nối qua host:port

**Status:** ready-for-agent

- [ ] Mở Chrome/Edge với `--remote-debugging-port=<port>`, `console.log`/`warn`/`error` chạy
      trong code AngularJS 1.x phía trình duyệt hiện inline đúng dòng, dùng đúng cơ chế đã build
      ở 02a — không có code kết nối riêng cho browser, dùng lại y hệt luồng host:port → discovery
- [ ] Khi Chrome có nhiều tab cùng mở trên port đó, Quick Pick hiện đúng danh sách tab (tiêu đề +
      URL mỗi tab) để chọn — đúng test case "nhiều target" đã xây ở 02a nhưng với dữ liệu thật
- [ ] Kết nối server (Node) và kết nối browser (tab Chrome) chạy **đồng thời** không ảnh hưởng
      nhau — log từ cả hai nguồn cùng hiện đúng trong cùng một phiên VSCode
- [ ] Không sửa đổi pipeline map log→span gốc (seam 1-3 của v1: `offsetForLocation`,
      `parseConsoleApiCalled`, `parseRuntimeLogMessage`) — nếu browser gửi field khác Node (ví dụ
      `url` dạng khác, không phải đường dẫn file hệ thống), xử lý ở lớp resolve path, không đổi
      logic parse CDP event
