# 02 — (đã tách) Bắt log browser-side qua CDP

Sau phiên `/grill-me` ngày 2026-09-14, ticket này phình to hơn dự kiến ban đầu — không chỉ là
"thêm CDP cho browser" mà kéo theo đổi cả mô hình kết nối server từ 1-socket sang nhiều kết nối
đồng thời. Tách thành hai ticket theo đúng tracer-bullet (mỗi ticket verify được độc lập):

- **02a** — đổi server sang multi-connection + kết nối qua host:port (test được hết bằng Node,
  không cần Chrome thật)
- **02b** — xác minh với Chrome/Edge thật (blocked by 02a)

Xem chi tiết quyết định kiến trúc trong hai file đó.
