# 03 — Server: kiểu đã thấy trong hover

**What to build:** Hover trên một biến scope trong template (và trên `$scope.x` / `this.x` trong
file JS) có thêm phần kiểu đã thấy, nối vào nội dung hover hiện có ở `connection.onHover`
(`packages/server/src/index.ts`). Không có setting — luôn bật (spec #1, #10).

**Blocked by:** 02

**Status:** done

- [x] Template: dùng `observedTypeAt`; hiện kiểu (code block), dòng "có thể rỗng khi render" nếu `nullable`,
      dòng "chỉ được gán trong callback (file:dòng) — chưa có giá trị ở lần render đầu" nếu `onlyInCallback`
- [x] Liệt kê tối đa 5 chỗ gán dạng link mở được (cùng kiểu link `fileLink` đang dùng)
- [x] Không suy ra được → dòng lý do + nguồn (spec #7)
- [x] File JS: hover trên chỗ gán `$scope.x = …` / `this.x = …` hiện cùng kiểu gộp đó (bản 1 chỉ hover, không inline)
- [x] Không phá hover hiện có (definition, scope chain, otherFiles) — test LSP cũ vẫn xanh
- [x] Test LSP stdio: hover trên `vm.rows` ra kiểu gộp + chỗ gán; hover trên biến `unknown` ra lý do

## Comments

**2026-09-19 — done.** `observedTypeLines` trong `packages/server/src/index.ts` dựng phần
**Observed type** (tiếng Anh, theo CLAUDE.md), nối sau hover cũ bằng `---`. Core:
`Workspace.observedTypeAt` nhận luôn vị trí trong file JS — con trỏ trên tên property của một
`ScopeWrite` (`x` trong `$scope.x = …`, `extra` trong `$scope.form.extra = …`) → kiểu gộp của đúng
đường dẫn đó; server chỉ gọi một API cho cả hai loại file.

Nội dung hover:
- code block `ts` với kiểu; `partial` → "Some assignments could not be inferred and are left out:" + nguồn.
- `text: null` → "Could not be inferred — assigned from `res.data` (link)"; không có nguồn nào
  (key không lần gán nào đặt, `ng-repeat` trên thứ không phải mảng) → câu chung, không ghi `unknown`.
- `nullable` → "Can be empty when rendered"; `onlyInCallback` → "Only assigned in a callback (link) — no value at the first render".
- "Assigned at:" ≤5 link `fileLink`. Nguồn unknown cũng ≤5.

Test: `packages/server/test/lsp.test.js` (2 test mới, fixture `mini` + thư mục `stats/` tạo lúc chạy),
`packages/core/test/observed-type.test.js` (+1 test phía JS). Test LSP hover cũ vẫn xanh.

Giới hạn thấy khi làm (có sẵn, ngoài ticket): extractor **không theo bí danh `var vm = this`** —
`vm.x = …` không thành `ScopeWrite` (cũng không thành `scopeMembers`), nên controller viết kiểu
controllerAs qua `vm` không có kiểu. Chỉ `this.x = …` trực tiếp và `$scope`/bí danh tham số được nhận.

**2026-09-19 — đã sửa giới hạn trên.** `thisAliasTest` trong `extract/js.ts`: biến khai báo
`var vm = this` ngay trong thân controller (không trong hàm lồng non-arrow) được coi là `via: 'this'`
cho cả `scopeMembers` và `scopeWrites`, kể cả khi dùng trong callback. Xác định qua `resolveBinding`
nên tham số lồng tên `vm` không bị nhận nhầm. `PARSER_VERSION` 13 → 14. Rename qua controllerAs vẫn
bị từ chối như trước (rename-orchestrator).
