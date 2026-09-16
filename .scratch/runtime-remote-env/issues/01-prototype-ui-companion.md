# 01 — Prototype: extension phụ phía UI (code vứt đi)

**What to build:** Trả lời câu hỏi duy nhất còn treo của spec: một extension chạy phía máy người
dùng (`extensionKind: ["ui"]`) có chuyển được sự kiện CDP của Chrome về extension phía workspace
đủ nhanh và đủ tin cậy không. Đây là prototype: dựng đủ để đo, không dựng để ship, xong thì xoá
code và giữ lại kết quả.

Kết quả quyết định ticket 12 (extension phụ thật) làm hay bỏ. Bỏ thì Remote SSH và Dev Container
chỉ hỗ trợ log Node, còn WSL NAT vẫn phải chuyển sang mirrored.

**Blocked by:** None — can start immediately.

**Status:** blocked-on-user (code dựng xong, cần chạy đo trên Remote-WSL thật)

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

## Comments

**2026-09-16, agent:** Dựng xong cả hai cơ chế (`vscode.commands` và forwarded port qua
`vscode.env.asExternalUri` + `node:net`) cộng harness đo (trang tải 100 log/giây, WebSocket client
CDP tự viết, script phân tích) ở
[`prototype-companion/`](./prototype-companion/) — không đụng tới `packages/`. WS client đã tự-test
bằng server giả (PASS 25/25), `analyze.js` đã smoke-test bằng fixture giả lập drop + outlier. Không
có Remote-WSL/VS Code/Chrome thật trong sandbox viết ticket này nên **chưa đo được số thật** — cần
chạy [`prototype-companion/RUNBOOK.md`](./prototype-companion/RUNBOOK.md) trên máy Remote-WSL thật
rồi điền kết quả vào [`../prototype-companion.md`](../prototype-companion.md). Sau khi có số, xoá
`prototype-companion/` rồi mới đóng ticket.
