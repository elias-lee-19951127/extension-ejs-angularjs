# 03 — Server: kiểu đã thấy trong hover

**What to build:** Hover trên một biến scope trong template (và trên `$scope.x` / `this.x` trong
file JS) có thêm phần kiểu đã thấy, nối vào nội dung hover hiện có ở `connection.onHover`
(`packages/server/src/index.ts`). Không có setting — luôn bật (spec #1, #10).

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Template: dùng `observedTypeAt`; hiện kiểu (code block), dòng "có thể rỗng khi render" nếu `nullable`,
      dòng "chỉ được gán trong callback (file:dòng) — chưa có giá trị ở lần render đầu" nếu `onlyInCallback`
- [ ] Liệt kê tối đa 5 chỗ gán dạng link mở được (cùng kiểu link `fileLink` đang dùng)
- [ ] Không suy ra được → dòng lý do + nguồn (spec #7)
- [ ] File JS: hover trên chỗ gán `$scope.x = …` / `this.x = …` hiện cùng kiểu gộp đó (bản 1 chỉ hover, không inline)
- [ ] Không phá hover hiện có (definition, scope chain, otherFiles) — test LSP cũ vẫn xanh
- [ ] Test LSP stdio: hover trên `vm.rows` ra kiểu gộp + chỗ gán; hover trên biến `unknown` ra lý do
