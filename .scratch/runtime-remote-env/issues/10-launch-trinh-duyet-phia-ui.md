# 10 — Launch trình duyệt phía UI và tự kết nối

**What to build:** Nút Launch hiện `spawn` ngay trên máy chạy extension, nên với Remote-WSL nó mở
trình duyệt Linux trong WSL (hoặc lỗi), không phải Chrome trên Windows của người dùng. Ticket này
mở đúng trình duyệt phía người dùng, kèm debug port, đúng URL app, rồi tự kết nối.

Ràng buộc không đổi được: Chrome 136+ bỏ qua `--remote-debugging-port` trên profile mặc định, nên
bắt buộc profile riêng.

**Blocked by:** 04 (biết port app của container), 09 (panel là nơi đặt nút và báo kết quả).

**Status:** ready-for-agent

- [ ] Tìm trình duyệt phía UI theo thứ tự Chrome → Edge → Brave; hỏi registry trước khi dò các
      đường dẫn cài đặt cố định; `ejsng.runtimeLog.chromeExecutablePath` khác rỗng thì thắng
- [ ] Remote-WSL: chạy trình duyệt Windows qua interop, `--user-data-dir` là **đường dẫn Windows**
- [ ] Profile debug riêng, **giữ lâu dài** (đăng nhập một lần là còn phiên); không bao giờ dùng
      profile thật của người dùng
- [ ] Tự mở URL app suy từ port app của container; nhiều port thì hỏi một lần rồi nhớ trong
      `workspaceState`
- [ ] Tự kết nối khi tab app đã load, không bắt bấm Connect lần hai
- [ ] WSL NAT: vẫn mở được trình duyệt, nhưng báo ngay rằng extension chưa với tới debug port và
      chỉ ra cách chuyển mirrored
- [ ] Không test tự động phần interop/mở trình duyệt; để lại checklist tay trong ticket
