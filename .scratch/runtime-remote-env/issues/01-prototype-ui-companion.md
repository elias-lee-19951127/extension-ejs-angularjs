# 01 — Prototype: extension phụ phía UI (code vứt đi)

**What to build:** Trả lời câu hỏi duy nhất còn treo của spec: một extension chạy phía máy người
dùng (`extensionKind: ["ui"]`) có chuyển được sự kiện CDP của Chrome về extension phía workspace
đủ nhanh và đủ tin cậy không. Đây là prototype: dựng đủ để đo, không dựng để ship, xong thì xoá
code và giữ lại kết quả.

Kết quả quyết định ticket 12 (extension phụ thật) làm hay bỏ. Bỏ thì Remote SSH và Dev Container
chỉ hỗ trợ log Node, còn WSL NAT vẫn phải chuyển sang mirrored.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Thử ít nhất 2 cơ chế nối giữa hai extension host (gọi lệnh qua `vscode.commands`, và mở cổng
      phía workspace rồi cho phía UI kết nối vào qua cơ chế forward của VS Code) — ghi lại cái nào
      chạy được trên Remote-WSL thật
- [ ] Đo với một trang bắn 100 log/giây trong 30 giây: số log mất, độ trễ trung vị và cao nhất
- [ ] Đạt = **không mất log** và **trễ dưới 200 ms**; ghi rõ đạt hay không đạt, không diễn giải lại
      tiêu chí
- [ ] Ghi cách đóng gói khả dĩ (hai extension trong một `extensionPack`, hay bản chính yêu cầu cài
      bản phụ khi cần) kèm hệ quả cho việc publish
- [ ] Viết kết quả vào `.scratch/runtime-remote-env/prototype-companion.md`; **xoá code prototype**
      khỏi repo trước khi đóng ticket
- [ ] Không sửa bất kỳ code sản phẩm nào trong ticket này
