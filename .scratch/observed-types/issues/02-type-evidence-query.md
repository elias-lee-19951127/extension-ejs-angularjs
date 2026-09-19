# 02 — Core: Type Evidence, gộp kiểu, API truy vấn tại một vị trí

**What to build:** Một module thuần ở `packages/core/src/resolve/` (gợi ý `observed-type.ts`) biến
các lần gán của ticket 01 thành **kiểu đã thấy** của một biến, theo mô hình **Bằng chứng kiểu**
(spec #8) — bản này chỉ có bằng chứng `static`. Cộng một API trên `Workspace` trả về kiểu tại một
vị trí trong template.

**Blocked by:** 01

**Status:** done

- [x] Kiểu `TypeEvidence { source: 'static' | 'runtime'; shape; site?: {path, span}; connection?; count; lastSeen? }`
      — trường runtime có sẵn trong kiểu, bản này không điền
- [x] Gộp theo spec #4: cùng loại → một shape, key thiếu ở vài lần gán → optional; khác loại → union.
      Gán lồng (`path.length > 1`) bổ sung key optional vào shape của gốc
- [x] Chỉ gộp từ bản controller gần file đang hỏi nhất (spec #5, dùng lại `nearestRows`/`preferNearest`)
- [x] `nullable` của biến = OR của các lần gán; `onlyInCallback` = mọi lần gán đều `inCallback`
- [x] Hàm định dạng kiểu thành chuỗi kiểu TypeScript với giới hạn 2 cấp / 8 key / `…+N` (spec #4) — thuần, test riêng được
- [x] `Workspace.observedTypeAt(relPath, offset)` cho template: nhận `vm.rows`, `rows`, `vm.form.name`
      (đi theo shape), phần tử `ng-repeat` (`row`); đi qua `facts()` nên template gắn controller qua
      `templateUrl` cũng có kiểu. Trả `{ text, nullable, onlyInCallback, sites (≤5), unknownReason? }` hoặc `null`
- [x] Không suy ra được → `unknownReason` có nguồn (`rhsText` + file:dòng), không bao giờ chỉ `unknown` (spec #7)
- [x] Test qua `Workspace` public API: gộp optional, union khác loại, gán lồng hiện đúng key, controller
      khai báo ở 2 file chỉ lấy bản gần, `ng-repeat` element, template gắn qua `templateUrl`

## Comments

**2026-09-19 — done.** `packages/core/src/resolve/observed-type.ts` (thuần) + `Workspace.observedTypeAt`
và `Workspace.observedTypeOf(from, controller, memberPath)` (cho hover phía JS ở ticket 03). Test:
`packages/core/test/observed-type.test.js` (10 test).

Cho ticket 03/04 biết:
- `TypeEvidence` có thêm `path` (phần nào của biến nó mô tả: `['form']` / `['form','extra']`).
- Kết quả trả **`unknownFrom: [{path, span, rhsText}]`** (có cấu trúc) thay vì một chuỗi
  `unknownReason` — hover tự dựng câu (tiếng Anh, theo CLAUDE.md) và số dòng. `text: null` = không biết gì.
- `partial: true` khi có lần gán `unknown` bị bỏ khỏi `text` vì lần khác đã biết (vd `[]` rồi `res.data`
  → `unknown[]`, partial) — hover nên nói "một số lần gán không suy ra được".
- Key optional **không** làm `nullable` (spec #3 chỉ tính null tường minh).
- Con trỏ trên key tính toán (`a[0].b`) hoặc ngoài định danh → `null`, không đoán.
- `ng-repeat` qua alias (`row in vm.rows`) được xử lý: bỏ alias khỏi đường dẫn collection.

Chạy trên smart-city: 1173 định danh trong template → 1037 có kết quả, 518 là dữ liệu (còn lại là
hàm), 89 nullable, 68 partial; 109ms cho cả 1173 lần hỏi (~0.1ms/lần).
