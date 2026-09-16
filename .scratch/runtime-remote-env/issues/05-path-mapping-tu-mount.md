# 05 — Path Mapping suy từ mount Docker

**What to build:** Log từ container báo Runtime Path kiểu `/home/cityos/aocs-cityos/aocs/...`,
không tồn tại trên máy chạy extension. Mount của chính container biết chính xác nó là thư mục nào,
kể cả khi mount lồng nhau — trường hợp mà đoán theo tên thư mục sẽ ra nhầm repo.

**Blocked by:** 04 — phải biết đang kết nối container nào mới đọc được mount của nó.

**Status:** ready-for-agent

- [ ] Mapping suy từ mount của container đang kết nối, áp dụng **mount có đích dài nhất trước**
- [ ] `ejsng.runtimeLog.pathMappings` do người dùng khai vẫn **thắng** mọi mapping suy ra
- [ ] Phía `local` của mapping hỗ trợ `${workspaceFolder}`; đường dẫn tuyệt đối cũ vẫn chạy y như
      trước (tương thích ngược)
- [ ] Mapping suy từ mount **không** ghi vào settings — tính lại mỗi lần Connect
- [ ] Không mapping nào bao phủ thì log bị bỏ và đếm đúng lý do (không im lặng)
- [ ] Test qua LSP với fixture mount lồng nhau thật: log từ thư mục bị che phải về repo đang thật
      sự chạy, không về repo bị che
