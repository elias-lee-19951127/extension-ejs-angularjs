# 05 — Lịch sử/đếm log theo dòng

**What to build:** Mở rộng state model "chỉ giá trị mới nhất mỗi dòng" (spec.md quyết định #6)
thành có lịch sử/đếm — hữu ích khi một dòng chạy nhiều lần trong vòng lặp. Quyết định #6 đã nói
rõ đây là "cải tiến sau nếu thấy thiếu", không phải hành vi tối thiểu của v1.

**Blocked by:** 01 — Hoàn thiện client VSCode v1

**Status:** ready-for-agent

- [ ] Server giữ N log gần nhất (hoặc bộ đếm số lần) cho mỗi dòng, thay vì ghi đè hoàn toàn giá
      trị cũ như v1
- [ ] Có giới hạn bộ nhớ hợp lý cho buffer lịch sử (không phình vô hạn với log tần suất cao)
- [ ] Client hiện được số lần log (ví dụ `"tổng: 42" (×3)`) cạnh giá trị mới nhất, hoặc cho xem
      lịch sử đầy đủ khi hover vào decoration
- [ ] Reset lịch sử đúng lúc: khi tiến trình target restart, hoặc khi dòng dịch chuyển do sửa
      file — giữ đúng hành vi reset đã có ở v1, chỉ mở rộng phần lưu trữ
