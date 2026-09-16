# 09 — Nợ kỹ thuật: 02a đã publish nhưng chưa verify tay

**What to build:** Không phải tính năng mới — đây là ghi nhận nợ kỹ thuật. Ticket 02a (đổi server
sang multi-connection + kết nối qua host:port) đã publish lên Marketplace (`v0.2.2`) theo yêu cầu
người dùng **trước khi** hoàn tất verify tay qua Extension Development Host — khác quy trình đã
theo ở ticket 01 (verify xong mới publish). Phần server đã TDD đầy đủ (134/134 test xanh), nhưng
phần UI client (input box, Quick Pick, status bar đếm số, Disconnect) **chưa được xác nhận chạy
đúng trong VSCode thật**.

**Blocked by:** None — không chặn gì, nhưng nên làm sớm trước khi build tiếp lên trên (02b/03 phụ
thuộc đúng hành vi client của 02a).

**Status:** debt — chờ người dùng tự check

- [ ] Kết nối đơn: `EJS/NG: Connect to Runtime`, gõ `host:port` (không còn dán URL), status bar
      hiện `1 connected`, log hiện inline đúng dòng
- [ ] Nhiều kết nối đồng thời: kết nối 2 tiến trình Node khác cổng, status bar hiện `2 connected`
      (không phải kết nối sau thay thế kết nối trước)
- [ ] `EJS/NG: Disconnect Runtime` — Quick Pick liệt kê đúng các kết nối đang mở, ngắt đúng cái đã
      chọn, status bar giảm đúng số
- [ ] (Chưa thể tự test bằng Node) Nhánh discovery tìm thấy **nhiều target trên cùng port** → Quick
      Pick chọn target — cần Chrome thật (ticket 02b) mới tạo được tình huống này; ghi chú lại ở
      đây để không quên khi làm 02b
- [ ] Ticket 10 (auto-enable): gõ port app thật (không có `--inspect`) vào "Connect to Runtime" →
      tự kết nối được, không cần biết port debug là gì
- [ ] Ticket 11 (Docker mapping): cấu hình `ejsng.runtimeLog.pathMappings` trong Settings UI thật,
      kết nối container thật → decoration vẽ đúng dòng (đã verify bằng script thẳng, chưa qua UI
      VSCode thật)

## Comments

Tạo theo yêu cầu người dùng ngày 2026-09-14: "Publish giúp tôi và tạo file nợ kỹ thuật. Tôi sẽ
check sau." — publish đã xong, còn lại 3 mục đầu trong checklist là phần người dùng tự verify.

Cập nhật cùng ngày (sau): publish `v0.2.3` theo yêu cầu người dùng — gồm ticket 10, 11, 13 (panel
Activity Bar + nút Launch Chrome debug). Ticket 13 đã được người dùng bấm thử trong Extension
Development Host và xác nhận ổn trước khi publish; ticket 10/11 vẫn chưa qua UI thật, đặc biệt
**chưa từng chạy trên Windows** (nhánh auto-enable của ticket 10 không hoạt động trên Windows theo
thiết kế; so khớp URI decoration trên Windows chưa kiểm chứng).

Cập nhật cùng ngày: thêm 2 mục cho ticket 10/11 (auto-enable inspector, Docker path mapping) — cả
hai đã verify bằng tiến trình/container thật qua script trực tiếp (không qua VSCode UI), server-side
TDD đầy đủ, nhưng chưa qua UI thật trong Extension Development Host.

2026-09-16: phần lớn checklist này sẽ được trả bằng test tự động ở ticket
`.scratch/runtime-remote-env/issues/11-test-tu-dong-client.md` (`@vscode/test-electron`), thay vì
bấm tay. Phần còn lại cần mắt người (mở trình duyệt, nhìn decoration) vẫn giữ nguyên ở đây.
