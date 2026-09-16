# 07 — Khớp đuôi URL cho log trình duyệt

**What to build:** Log từ Chrome mang URL (`http://localhost:5000/javascripts/index.js`), không phải
đường dẫn file, và không có mount nào nói nó là file nào. Ticket này khớp phần đuôi đường dẫn với
file đã index — nhưng **chỉ cho URL**, không bao giờ cho đường dẫn file của Node, vì với mount lồng
nhau kiểu khớp này sai một cách thuyết phục.

**Blocked by:** 05, 06 — khớp đuôi là nguồn cuối cùng sau mapping, và kết quả của nó phải qua kiểm
tra nội dung mới được vẽ.

**Status:** ready-for-agent

- [ ] Chỉ áp dụng cho Runtime Path dạng `http(s)://`; đường dẫn file không bao giờ đi qua đường này
- [ ] Chọn file có đuôi trùng **dài nhất và duy nhất**
- [ ] Khớp nhiều file → **không vẽ**, đếm đúng lý do, panel nói ra các ứng viên
- [ ] Mapping suy ra chỉ sống trong phiên kết nối; panel có nút lưu, chỉ ghi settings khi người
      dùng bấm (ghi theo quy ước của ticket 05: `${workspaceFolder}`, không thì User settings)
- [ ] Kiểm tra nội dung của ticket 06 vẫn là điều kiện bắt buộc — bắt được ca URL khớp bản đọc được
      trong khi server trả bản obfuscate
