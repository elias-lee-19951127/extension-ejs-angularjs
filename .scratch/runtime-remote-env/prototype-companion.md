# Prototype: extension phụ phía UI — kết quả (ticket 01)

**Status: ĐANG DỞ DANG.** Code prototype đã dựng và tự-test xong ở phía có thể test được (macOS,
không có VS Code/WSL/Chrome thật). Phần đo thật — thứ quyết định đạt/không đạt — **chưa chạy**, vì
nó bắt buộc phải chạy trên Remote-WSL thật (Windows + WSL AlmaLinux + Chrome trên Windows, xem
memory `user-real-runtime-setup`), môi trường không có trong sandbox viết ticket này.

Code nằm ở [`prototype-companion/`](./prototype-companion/); cách chạy đầy đủ ở
[`prototype-companion/RUNBOOK.md`](./prototype-companion/RUNBOOK.md). **Không sửa code sản phẩm** —
toàn bộ nằm ngoài `packages/`.

## Cơ chế đã dựng

1. **`vscode.commands`** — `proto-ui-companion` (extension host phía UI, `extensionKind: ["ui"]`)
   gọi `vscode.commands.executeCommand('protoWorkspace.ingest', payload)`; `proto-workspace-host`
   (extension host phía workspace, mặc định không khai `extensionKind`) đăng ký lệnh đó và ghi lại
   thời điểm nhận. Đây là cách VS Code tự proxy lệnh qua ranh giới hai extension host, không cần mở
   port riêng.
2. **Forwarded port** — `proto-workspace-host` mở một TCP server thô (`node:net`, không phải
   WebSocket — CDP framing chỉ cần ở nhánh 1, ở đây dữ liệu là NDJSON qua TCP) trên
   `127.0.0.1:<port ngẫu nhiên>`, gọi `vscode.env.asExternalUri(...)` để lấy URI đã được cơ chế
   forward của VS Code (Remote-WSL/SSH tunnel) đưa sang phía UI; `proto-ui-companion` nối vào URI đó
   bằng `net.connect` và gửi NDJSON qua socket.

Cả hai đều nhận sự kiện từ Chrome qua CDP WebSocket thật (không giả lập): `proto-ui-companion` dùng
lại package `ws` đã có sẵn trong `node_modules` gốc repo (cùng thư viện `packages/server` đang dùng
cho CDP — `ui-ext/ws-client.js` chỉ là một wrapper mỏng). Đã tự-test bằng một server WS giả
(`selftest-ws-client.js`, không cần Chrome) — PASS 25/25 sự kiện đúng thứ tự trên macOS.

`gen-log-page.html` là trang tải: bấm Start bắn `console.log('PROTO_LOG', seq, Date.now())` ở
~100Hz trong 30s (3000 log), có nút Start riêng để đảm bảo `Runtime.enable` được gửi trước khi log
đầu tiên phát sinh (tránh mất log sớm do gắn CDP muộn — chính lỗi mà spec cảnh báo).

`analyze.js` tính: số log mất (so `seq` nhận được với 3000 kỳ vọng), trễ trung vị/cao nhất
(`tReceiveMs - tSendMs`, ghi bởi `proto-workspace-host` lúc nhận), và in PASS/FAIL theo đúng tiêu
chí ticket. Đã smoke-test bằng fixture giả lập 1 log mất + 1 outlier 250ms — script báo đúng
`dropped: 1`, `latency max: 250.0 ms`, `PASS: NO`.

**Rủi ro đo lường cần lưu ý khi chạy thật:** `tSendMs`/`tReceiveMs` là `Date.now()` lấy ở hai máy vật
lý khác nhau về mặt logic (Windows host và WSL guest) dù chạy trên cùng một máy thật — đồng hồ WSL2
đồng bộ khá sát với host qua Hyper-V nên lệch thường dưới vài ms, nhưng nếu số trễ đo được ra âm
hoặc bất thường lớn, nghi đồng hồ lệch trước khi kết luận cơ chế chậm.

## Kết quả đo

**Chưa đo.** Chạy theo `RUNBOOK.md`, điền bảng dưới đây bằng output thật của `analyze.js` — không
suy diễn, không ước lượng.

| Cơ chế | Chạy được trên Remote-WSL thật? | Log gửi | Log nhận (unique seq) | Log mất | Trễ trung vị | Trễ cao nhất | Đạt (không mất log **và** <200ms)? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `vscode.commands` | ? | 3000 | ? | ? | ? ms | ? ms | ? |
| forwarded port | ? | 3000 | ? | ? | ? ms | ? ms | ? |

**Kết luận đạt/không đạt:** _(điền sau khi có bảng trên — đạt nghĩa là ít nhất một cơ chế thoả cả
hai điều kiện `dropped = 0` và `latency max < 200ms`; không diễn giải lại tiêu chí này)_

## Đóng gói khả dĩ

Hai phương án, không cần đo thật để trả lời — dựa trên cách VS Code Marketplace xử lý
`extensionPack`/`extensionDependencies`:

**A. `extensionPack`** — extension chính khai `"extensionPack": ["phule.<id-companion>"]`; cài
extension chính qua Marketplace UI thì companion tự cài theo. Hệ quả: companion bị cài cho **mọi**
người dùng, kể cả macOS/Linux local và WSL mirrored (story #44/#45) không bao giờ cần tới nó — thừa
một extension vô dụng trong danh sách Extensions của họ. Hai listing Marketplace riêng, phải giữ
version đồng bộ mỗi lần publish, hai bước CI publish.

**B. Cài theo yêu cầu** (khớp cách diễn đạt ticket 12: "bản chính yêu cầu cài bản phụ khi cần") —
không khai `extensionPack`; panel (đã có từ ticket 09, sửa ở ticket 12) tự phát hiện lúc runtime khi
nào cần companion (remote + WSL NAT/SSH/Dev Container mà chưa thấy companion phản hồi lệnh
`protoWorkspace.ingest`-kiểu-thật), rồi hiện nút gọi lệnh có sẵn của VS Code
(`workbench.extensions.installExtension` với id companion) hoặc mở trang Marketplace. Companion chỉ
cài ở đúng nhóm người dùng cần nó.

**Khuyến nghị: B**, vì phần lớn người dùng cam kết hỗ trợ (macOS/Linux local, WSL mirrored) không
cần companion — ép cài cho tất cả là chi phí không cần thiết. Vẫn giữ nguyên yêu cầu bắt buộc của
ticket 12 dù chọn A hay B: panel phải tự phát hiện companion thiếu/tắt và hướng dẫn cài rõ ràng,
không im lặng hỏng — vì `extensionPack` chỉ đảm bảo cài lúc cài extension chính, không đảm bảo
companion còn bật ở mọi lần dùng sau (người dùng có thể tắt/gỡ riêng). Điểm cần nghĩ thêm khi làm
ticket 12: hai extension nói chuyện qua giao thức riêng (tên lệnh, hình dạng payload) — nếu giao
thức đổi giữa hai bản, cần một cách báo lệch version rõ ràng thay vì lỗi im lặng, tương tự cách
`vscode-languageclient` kiểm version LSP.

## Hệ quả cho ticket 12

_(điền sau khi có kết quả đo)_ — nếu ít nhất một cơ chế đạt: ticket 12 dùng đúng cơ chế đó (ưu tiên
cơ chế đơn giản hơn nếu cả hai đều đạt). Nếu không cơ chế nào đạt: đóng ticket 12 với lý do là kết
quả đo ở đây, Remote SSH và Dev Container chỉ hỗ trợ log Node, WSL NAT tiếp tục yêu cầu chuyển
`networkingMode=mirrored`.

## Dọn dẹp

**Chưa xoá code prototype** — đang chờ số đo thật để điền bảng trên. Sau khi điền xong: xoá cả thư
mục [`prototype-companion/`](./prototype-companion/) (`ui-ext/`, `workspace-ext/`, `results/`,
`gen-log-page.html`, `analyze.js`, `selftest-ws-client.js`, `RUNBOOK.md`) rồi mới tick hết checklist
và đóng ticket 01.
