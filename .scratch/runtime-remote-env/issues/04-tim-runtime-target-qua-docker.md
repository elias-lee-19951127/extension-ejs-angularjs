# 04 — Tìm Runtime Target qua Docker

**What to build:** Bấm Connect mà không gõ gì, extension tự liệt kê container Node có inspector và
hiện chúng theo cách người dùng vẫn nhớ service: **tên container + port app** (`cityos-web: 5000`),
không phải port debug. Gõ port app cũng ra đúng container đó.

Quét port cố định không đủ: một container có thể publish inspector ra port bất kỳ (thực tế:
`9228->9229`), và hai container cùng có inspector thì port thôi không phân biệt được.

**Blocked by:** 02 — cần probe an toàn và ws URL viết lại đúng.

**Status:** ready-for-agent

- [ ] Liệt kê container qua CLI `docker`; không có `docker` thì im lặng rơi về luồng cũ (host:port,
      `lsof` + `SIGUSR1`, quét port phổ biến), không lỗi
- [ ] Mỗi container đọc ra: các cặp port publish, port inspector bên trong (từ `--inspect`,
      `--inspect-brk`, hoặc `NODE_OPTIONS`), và danh sách mount
- [ ] Suy port inspector **trên host** bằng cách khớp phía container của cặp port — bắt được cả
      `9228->9229`
- [ ] Gõ port app (5000) → chọn container publish port đó, kết nối inspector của nó
- [ ] Đúng một ứng viên thì kết nối luôn; nhiều thì Quick Pick ghi tên container + port app
- [ ] Container có Node nhưng không publish port inspector: báo đúng container đó, không tự
      `docker exec` hay can thiệp gì vào container
- [ ] Test qua LSP với một `docker` giả đặt trong `PATH` tạm, fixture lấy từ máy thật (mount lồng
      nhau, `9228->9229`)
