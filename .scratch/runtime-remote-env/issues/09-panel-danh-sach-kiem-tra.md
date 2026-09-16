# 09 — Panel: danh sách kiểm tra, nút sửa tại chỗ, Copy báo cáo

**What to build:** Thay panel hiện tại (ô host:port + vài nút) bằng một nút Connect lớn và một danh
sách kiểm tra từng bước, mỗi bước ✔/✖ kèm lý do, dòng nào sửa được thì có nút sửa ngay tại đó.
Không làm wizard riêng: wizard sẽ là bản thứ hai của cùng luồng Connect.

**Blocked by:** 02, 03, 04, 05, 06 — panel hiển thị kết quả của tất cả các bước đó.

**Status:** ready-for-agent

- [ ] Nút Connect chạy trọn chuỗi: nhận diện môi trường → Docker → target → mapping → kết nối
- [ ] Danh sách kiểm tra gồm: môi trường (kèm chế độ mạng khi là WSL), Docker/container, kết nối
      Node, trình duyệt, Path Mapping, và số `nhận / vẽ / bỏ`; bấm vào số bỏ xem lý do theo nhóm
- [ ] Nút sửa tại chỗ cho các ca sửa được: lưu mapping, bỏ qua frame, thêm thư mục vào workspace,
      copy đoạn compose mẫu khi container thiếu inspector, mở hướng dẫn chuyển WSL sang mirrored
- [ ] Nhận diện môi trường qua `remoteName` phía client, gửi cho server qua `initializationOptions`
- [ ] WSL NAT: báo thẳng log trình duyệt cần `networkingMode=mirrored` kèm các bước; extension
      không tự sửa `.wslconfig`
- [ ] Ô `host:port` cũ chuyển xuống mục "Nâng cao", vẫn hoạt động y như trước
- [ ] Nút **Copy báo cáo**: markdown gồm OS, loại remote, Docker, endpoint, trình duyệt, kết quả
      từng bước và lý do bỏ log; thay home bằng `~`; chỉ copy vào clipboard, không gửi đi đâu
- [ ] Mở workspace **không** tự kết nối
- [ ] Lưu cấu hình đúng chỗ: `skipFrames` và mapping đã bấm lưu vào workspace settings; port app đã
      chọn, trình duyệt tìm được, target lần trước vào `workspaceState`
