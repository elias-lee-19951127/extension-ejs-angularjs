# 12 — Extension phụ phía UI (chỉ làm nếu prototype đạt)

**What to build:** Cho Remote SSH, Dev Container và WSL NAT, trình duyệt nằm ở máy khác với extension
nên không có đường mạng nào tới debug port. Extension phụ chạy phía UI nói chuyện với trình duyệt
qua localhost của chính máy đó rồi chuyển log về extension chính.

**Điều kiện:** chỉ làm nếu ticket 01 đạt tiêu chí (không mất log, trễ dưới 200 ms). Không đạt thì
đóng ticket này với lý do, và Remote SSH / Dev Container chỉ hỗ trợ log Node.

**Blocked by:** 01 (kết quả prototype), 09 (panel là nơi báo trạng thái và hướng dẫn cài).

**Status:** ready-for-agent

- [ ] Extension phụ `extensionKind: ["ui"]` dùng lại cơ chế nối đã chứng minh ở ticket 01
- [ ] Tìm trình duyệt và mở nó **phía UI** (dùng lại logic của ticket 10, chạy ở phía kia)
- [ ] Log trình duyệt chuyển về server và đi qua đúng pipeline hiện có (chọn frame, mapping, kiểm
      tra nội dung) — không có nhánh xử lý riêng
- [ ] Thiếu extension phụ thì panel báo rõ và hướng dẫn cài, không im lặng hỏng
- [ ] Đóng gói và publish: ghi rõ cách người dùng nhận được cả hai phần
- [ ] Viết ADR cho quyết định này (lúc này mới đủ ba điều kiện: khó đảo ngược, gây ngạc nhiên,
      là kết quả đánh đổi thật)
