# 08 — Log từ file ngoài workspace

**What to build:** Với mount lồng nhau, file runtime thật sự chạy có thể nằm ở một repo khác chưa
mở trong workspace. Hiện các log đó bị bỏ im lặng. Ticket này vẫn vẽ chúng khi người dùng mở file,
trong giới hạn an toàn: Runtime Path do một tiến trình mạng gửi tới, không đáng tin.

**Blocked by:** 06 — chỉ vẽ sau khi nội dung đã được kiểm.

**Status:** ready-for-agent

- [ ] Server chỉ đọc file nằm **dưới phía host của một Path Mapping** (mount hoặc tự khai), hoặc
      trong workspace; ngoài phạm vi đó thì bỏ và đếm
- [ ] File chỉ được đọc để tính vị trí dòng; nội dung hiển thị vẫn là giá trị log
- [ ] Mở file đó trong editor thì decoration hiện đúng dòng, kể cả file ngoài workspace
- [ ] Panel có nút gợi ý thêm thư mục liên quan vào workspace; extension **không** tự thêm
- [ ] Test qua LSP: log trỏ tới file ngoài mọi mapping phải bị từ chối đọc
