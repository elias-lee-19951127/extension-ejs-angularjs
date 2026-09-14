# 10 — Gõ port app thật, tự bật inspector nếu chưa có

**What to build:** Bỏ yêu cầu người dùng phải biết "port debug" là gì hay phải sửa script thêm
`--inspect`. `ejsng/connectRuntime` nhận **một port bất kỳ**: nếu port đó đã nói được giao thức
debug (`/json/list` trả về được) thì kết nối thẳng như hiện tại; nếu không, tự tìm tiến trình đang
nghe port đó (`lsof -ti :<port>`), gửi tín hiệu `SIGUSR1` để Node tự bật inspector cho chính tiến
trình đang chạy (không cần restart), rồi tự dò lại ở port debug mặc định (9229).

Đã verify thủ công cơ chế này hoạt động đúng trên máy thật (phiên 2026-09-14): tiến trình chạy
không có `--inspect`, gửi `SIGUSR1` → inspector bật ngay tại port 9229, app không gián đoạn.

**Blocked by:** 02a — Đổi server sang multi-connection + kết nối qua host:port (đã xong)

**Status:** ready-for-agent

- [ ] `ejsng/connectRuntime` nhận `{host, port}` như cũ — thử `discoverTargets(host, port)` trước;
      có kết quả thì đi đúng luồng hiện có (connected/choose/not-found), không đổi gì
- [ ] Nếu `discoverTargets` thất bại (không có gì nghe port đó theo giao thức debug): tìm PID đang
      nghe port đó trên host bằng `lsof -ti :<port>` — không tìm thấy thì trả `not-found` như cũ
- [ ] Tìm thấy PID: gửi `process.kill(pid, 'SIGUSR1')`, đợi một khoảng ngắn, thử lại
      `discoverTargets('127.0.0.1', 9229)` (port debug mặc định — không biết được nếu tiến trình
      đã tự set `--inspect-port` khác, chấp nhận giới hạn này)
- [ ] Chỉ làm trên POSIX (`process.platform !== 'win32'`) — Windows không có `SIGUSR1`, bỏ qua
      bước tự bật, rơi thẳng về `not-found` như hành vi cũ (không throw, không crash)
- [ ] Test bằng tiến trình Node thật (spawn trong test, không `--inspect`) — xác nhận trước khi
      gửi tín hiệu không có inspector, sau khi gửi thì có, dùng port thật không phải fake server
