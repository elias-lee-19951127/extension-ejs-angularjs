# 05 — Lịch sử/đếm log theo dòng

**What to build:** Mở rộng state model "chỉ giá trị mới nhất mỗi dòng" (spec.md quyết định #6)
thành có lịch sử/đếm — hữu ích khi một dòng chạy nhiều lần trong vòng lặp. Quyết định #6 đã nói
rõ đây là "cải tiến sau nếu thấy thiếu", không phải hành vi tối thiểu của v1.

**Blocked by:** 01 — Hoàn thiện client VSCode v1

**Status:** done — 2026-09-19, chưa publish

- [x] Giữ N log gần nhất (10) + bộ đếm cho mỗi dòng — ở **client** (`RuntimeLogState`), không ở
      server; xem Comments
- [x] Có giới hạn bộ nhớ hợp lý cho buffer lịch sử (không phình vô hạn với log tần suất cao)
- [x] Client hiện được số lần log (ví dụ `"tổng: 42" (×3)`) cạnh giá trị mới nhất, hoặc cho xem
      lịch sử đầy đủ khi hover vào decoration
- [x] Reset lịch sử đúng lúc: khi tiến trình target restart, hoặc khi dòng dịch chuyển do sửa
      file — giữ đúng hành vi reset đã có ở v1, chỉ mở rộng phần lưu trữ

## Comments

**2026-09-19 — đã làm.**

- **Lịch sử ở client, không ở server.** Server chưa từng giữ trạng thái đã vẽ: giá trị mới nhất mỗi
  dòng (v1) vốn nằm ở `RuntimeLogState` phía client, nên lịch sử đặt cạnh nó. Khi port IntelliJ,
  client đó phải tự giữ — chỉ là một cấu trúc nhỏ, và hai client đều nhận đủ dữ liệu qua
  `ejsng/runtimeLog` (`source`, `endpoint`).
- **Hiển thị:** inline `» giá trị (×N)` khi N > 1; hover: nguồn · mức · giờ của giá trị mới nhất, giá trị
  đầy đủ, rồi tối đa 9 giá trị trước đó (mỗi cái có nguồn và giờ riêng — hai container có thể thay
  nhau chạy qua một dòng), và "…and K earlier not kept".
- **Reset — v1 thực ra chưa có:** `RuntimeLogState.clear()` tồn tại nhưng không ai gọi. Nay:
  - Kết nối lại một endpoint (`ejsng/runtimeStatusChanged` → `connected`, mang `endpoint`) = một lần
    chạy mới của app → xoá giá trị và số đếm **của endpoint đó**; runtime khác trên cùng dòng giữ
    nguyên. Reset lúc kết nối lại chứ không lúc rớt kết nối, để giá trị cuối trước khi app crash vẫn
    đọc được tới khi app lên lại.
  - Sửa file: lịch sử **dời theo** dòng (thêm/bớt dòng phía trên), dòng nằm trong một đoạn nhiều dòng
    bị thay thì bỏ. Không xoá cả file như cách hiểu "reset" ban đầu — giá trị vẫn đúng với code của nó.
- Test: `packages/vscode-client/test/runtime-log-state.test.js` (giới hạn, đếm, reset theo endpoint, dời
  dòng, định dạng); e2e trong VS Code thật: `(×2)` + lịch sử trong hover, và kết nối lại thì xoá.
