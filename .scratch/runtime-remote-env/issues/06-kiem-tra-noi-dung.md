# 06 — Kiểm tra nội dung: Stale File và Shadowed File

**What to build:** Khớp đường dẫn không đảm bảo khớp nội dung. Ba ca thật: file đã sửa mà runtime
chưa nạp lại (**Stale File**), file trong workspace bị mount khác che nên runtime chạy bản khác
(**Shadowed File**), và mapping tự khai trỏ nhầm. Cả ba đều khiến log vẽ **sai dòng mà trông như
đúng** — tệ hơn không vẽ. Ticket này bắt vẽ inline phải có điều kiện: nội dung khớp.

**Blocked by:** 05 — cần mapping ra file trên đĩa trước khi so nội dung.

**Status:** ready-for-agent

- [ ] Bắt đầu bằng thí nghiệm với Node thật: metadata script V8 báo về (độ dài, dòng cuối) có khớp
      file trên đĩa không, kể cả với CommonJS. Kết quả quyết định cách so sánh; **ghi vào ticket**
      trước khi viết tiếp
- [ ] Bật domain `Debugger` chỉ để nhận sự kiện: không đặt breakpoint, không pause runtime
- [ ] Nội dung khớp → vẽ inline như hiện tại
- [ ] Lệch và file trên đĩa mới hơn lúc runtime nạp → không vẽ, báo **Stale File** kèm gợi ý restart
- [ ] Lệch kiểu khác → không vẽ, báo nghi **Shadowed File** hoặc mapping sai; nếu biết mount thì
      chỉ ra đường dẫn bản runtime đang chạy
- [ ] Mọi trường hợp không vẽ đều vào bộ đếm lý do của ticket 02
- [ ] Chi phí bật `Debugger` với dự án vài nghìn file được đo và ghi lại; nếu nặng thì giới hạn
      phạm vi script quan tâm
