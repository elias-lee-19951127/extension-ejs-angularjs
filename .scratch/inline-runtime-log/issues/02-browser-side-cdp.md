# 02 — Bắt log browser-side qua CDP (AngularJS 1.x)

**What to build:** Nguồn log thứ hai — `console.log` chạy trong code AngularJS phía trình duyệt —
hiện inline giống hệt server-side, dùng lại đúng pipeline/notification `ejsng/runtimeLog` đã có.
Đây là mục bị loại khỏi v1 (spec.md quyết định #1: "Chứng minh pipeline với 1 nguồn trước khi nhân
đôi"), nên ticket này chỉ mở khi v1 đã chạy ổn.

**Blocked by:** 01 — Hoàn thiện client VSCode v1

**Status:** ready-for-agent

- [ ] Chốt kịch bản kết nối tới trình duyệt (remote-debugging port có sẵn, hay extension tự mở
      trình duyệt) — đây là quyết định kiến trúc khó hoàn tác, nên chạy `/grill-me` riêng cho
      ticket này trước khi code, đúng khuyến nghị trong
      `docs/research/console-ninja-inline-log.md`
- [ ] `console.log`/`warn`/`error` chạy trong code AngularJS phía client hiện inline đúng dòng,
      qua kết nối CDP tới `Runtime.consoleAPICalled` của trình duyệt
- [ ] Không sửa đổi hành vi pipeline server-side đã có (seam 1-3 của v1 giữ nguyên, chỉ thêm
      nguồn dữ liệu thứ hai)
