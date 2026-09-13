# 04 — Auto-detect tiến trình/container thay vì cấu hình tay

**What to build:** Loại bỏ bước "tự gõ `ejsng.runtimeLog.inspectorUrl`" cho trường hợp phổ biến —
spec.md quyết định #4 chọn cấu hình tay cho v1 vì auto-detect "là một tính năng riêng có thể thêm
sau, không chặn v1". Ticket này chính là "sau" đó.

**Blocked by:** 01 — Hoàn thiện client VSCode v1

**Status:** ready-for-agent

- [ ] Tự phát hiện tiến trình Node đang chạy với `--inspect`/`--inspect-brk` trên máy host, không
      cần người dùng tự tìm cổng
- [ ] Tự phát hiện container Docker có expose cổng debug (best-effort — nếu không tìm được, không
      lỗi, chỉ rơi về yêu cầu cấu hình tay)
- [ ] Setting `ejsng.runtimeLog.inspectorUrl` vẫn hoạt động như cũ cho người dùng muốn cấu hình
      tay — đây là bổ sung, không phải breaking change
- [ ] Khi có nhiều hơn một tiến trình/container khớp, có cách chọn rõ ràng (danh sách để chọn,
      không tự đoán im lặng)
