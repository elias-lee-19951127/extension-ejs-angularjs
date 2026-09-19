# 02 — Core: Type Evidence, gộp kiểu, API truy vấn tại một vị trí

**What to build:** Một module thuần ở `packages/core/src/resolve/` (gợi ý `observed-type.ts`) biến
các lần gán của ticket 01 thành **kiểu đã thấy** của một biến, theo mô hình **Bằng chứng kiểu**
(spec #8) — bản này chỉ có bằng chứng `static`. Cộng một API trên `Workspace` trả về kiểu tại một
vị trí trong template.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Kiểu `TypeEvidence { source: 'static' | 'runtime'; shape; site?: {path, span}; connection?; count; lastSeen? }`
      — trường runtime có sẵn trong kiểu, bản này không điền
- [ ] Gộp theo spec #4: cùng loại → một shape, key thiếu ở vài lần gán → optional; khác loại → union.
      Gán lồng (`path.length > 1`) bổ sung key optional vào shape của gốc
- [ ] Chỉ gộp từ bản controller gần file đang hỏi nhất (spec #5, dùng lại `nearestRows`/`preferNearest`)
- [ ] `nullable` của biến = OR của các lần gán; `onlyInCallback` = mọi lần gán đều `inCallback`
- [ ] Hàm định dạng kiểu thành chuỗi kiểu TypeScript với giới hạn 2 cấp / 8 key / `…+N` (spec #4) — thuần, test riêng được
- [ ] `Workspace.observedTypeAt(relPath, offset)` cho template: nhận `vm.rows`, `rows`, `vm.form.name`
      (đi theo shape), phần tử `ng-repeat` (`row`); đi qua `facts()` nên template gắn controller qua
      `templateUrl` cũng có kiểu. Trả `{ text, nullable, onlyInCallback, sites (≤5), unknownReason? }` hoặc `null`
- [ ] Không suy ra được → `unknownReason` có nguồn (`rhsText` + file:dòng), không bao giờ chỉ `unknown` (spec #7)
- [ ] Test qua `Workspace` public API: gộp optional, union khác loại, gán lồng hiện đúng key, controller
      khai báo ở 2 file chỉ lấy bản gần, `ng-repeat` element, template gắn qua `templateUrl`
