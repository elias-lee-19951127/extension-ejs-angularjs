# 10 — Gõ port app thật, tự bật inspector nếu chưa có

**What to build:** Bỏ yêu cầu người dùng phải biết "port debug" là gì hay phải sửa script thêm
`--inspect`. `ejsng/connectRuntime` nhận **một port bất kỳ**: nếu port đó đã nói được giao thức
debug (`/json/list` trả về được) thì kết nối thẳng như hiện tại; nếu không, tự tìm tiến trình đang
nghe port đó (`lsof -ti :<port>`), gửi tín hiệu `SIGUSR1` để Node tự bật inspector cho chính tiến
trình đang chạy (không cần restart), rồi tự dò lại ở port debug mặc định (9229).

Đã verify thủ công cơ chế này hoạt động đúng trên máy thật (phiên 2026-09-14): tiến trình chạy
không có `--inspect`, gửi `SIGUSR1` → inspector bật ngay tại port 9229, app không gián đoạn.

**Blocked by:** 02a — Đổi server sang multi-connection + kết nối qua host:port (đã xong)

**Status:** done — verify tay UI còn lại

- [x] `ejsng/connectRuntime` nhận `{host, port}` như cũ — thử `discoverTargets(host, port)` trước;
      có kết quả thì đi đúng luồng hiện có (connected/choose/not-found), không đổi gì
- [x] Nếu `discoverTargets` thất bại (không có gì nghe port đó theo giao thức debug): tìm PID đang
      nghe port đó trên host bằng `lsof -ti :<port>` — không tìm thấy thì trả `not-found` như cũ
- [x] Tìm thấy PID: gửi `process.kill(pid, 'SIGUSR1')`, đợi một khoảng ngắn, thử lại
      `discoverTargets('127.0.0.1', 9229)` (port debug mặc định — không biết được nếu tiến trình
      đã tự set `--inspect-port` khác, chấp nhận giới hạn này)
- [x] Chỉ làm trên POSIX (`process.platform !== 'win32'`) — Windows không có `SIGUSR1`, bỏ qua
      bước tự bật, rơi thẳng về `not-found` như hành vi cũ (không throw, không crash)
- [x] Test bằng tiến trình Node thật (spawn trong test, không `--inspect`) — xác nhận trước khi
      gửi tín hiệu không có inspector, sau khi gửi thì có, dùng port thật không phải fake server
      (6 test mới ở `runtime-log-auto-enable.test.js`, gồm 1 test LSP end-to-end qua request thật)

## Comments

Bug thật bắt được lúc viết test: `lsof -ti :<port>` (không lọc state) đôi khi trả về PID của một
kết nối đã đóng/không liên quan cùng nhắc tới port đó, không phải PID đang LISTEN — sửa bằng thêm
`-sTCP:LISTEN`. Cũng phát hiện bug root-containment với symlink (macOS `tmpdir()`), tách ra ticket
12 vì không liên quan trực tiếp tới auto-enable.

Client: input box đổi placeholder/prompt phản ánh đúng khả năng mới (gõ port app thật); response
`choose`/`connected` giờ có field `port` hiệu lực (có thể khác port đã gõ nếu auto-enable xảy ra),
client dùng field đó cho bước tiếp theo thay vì port gốc.

Còn thiếu: verify tay qua Extension Development Host (gõ port app đang chạy không có `--inspect`,
xác nhận tự kết nối được) — gộp chung với các mục verify còn treo ở ticket 09.
