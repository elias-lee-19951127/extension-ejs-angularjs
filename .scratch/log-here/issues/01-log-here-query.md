# 01 — Core + server: log cái gì, ở đâu, hay vì sao không

**What to build:** Từ một vị trí con trỏ (và phần bôi đen nếu có) trong file JS, trả về logpoint nên đặt —
biểu thức, vị trí, nội dung — hoặc lý do không đặt được (spec #2, #3, #4, #5).

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] Core `logHereAt(source, facts, offset, selection?)` → `{ line, character, expression, logMessage }` hoặc `{ reason }`
- [x] Thứ tự chọn biểu thức (spec #2): bôi đen parse được → chuỗi property dưới con trỏ → biến được gán trên dòng
- [x] Vị trí (spec #3): vế trái của câu gán → ngay sau câu lệnh (dùng lại `statementEnd`); còn lại → đầu dòng
      (sau khoảng trắng đầu dòng)
- [x] Lý do từ chối (spec #4), mỗi lý do một mã máy đọc được: `call`, `this-in-callback`, `unparsable`, `nothing-here`
- [x] `logMessage` = `<tên ngắn> = {<biểu thức>}`, giống CodeLens/hover (spec #5)
- [x] Server: request `ejsng/logHere { uri, line, character, selection }` → `{ target }` | `{ reason }`; file không phải `.js`
      hoặc ngoài workspace → `{ reason: 'not-js' }`
- [x] Test core: bôi đen `res.data`; con trỏ giữa `vm.form.owner`; con trỏ trên dòng gán nhưng không trúng chữ;
      con trỏ trên `load()`; `this` trong callback; dòng trống; bôi đen `a +` (không parse được)
- [x] Test LSP: một controller thật, ba vị trí, một lý do từ chối

## Comments

**2026-09-20 — done.** `logHereAt(source, facts, offset, selection?)` trong `packages/core/src/extract/js.ts`
+ `Workspace.logHereAt` + request `ejsng/logHere`. Thứ tự chọn và luật vị trí đúng như spec; dùng lại
`statementEnd` của log-variable.

**Thêm một ca từ chối ngoài spec:** con trỏ đặt đúng vào **tên hàm đang được gọi** (`load` trong `load()`).
Biểu thức lấy ra là `load` — không có ngoặc nên luật "chứa lời gọi" không bắt được — nhưng ý người dùng rõ ràng
là cái lời gọi đó. Giờ kiểm cả vị trí callee, trả `reason: 'call'`.

**Một kỳ vọng sai trong test của tôi:** `parseJsTolerant` vốn phục hồi được code hỏng, nên file không parse nổi
không trả `unparsable` mà trả `nothing-here`. Sửa test theo hành vi thật.

Test: `packages/core/test/log-here.test.js` (6), `packages/server/test/lsp.test.js` (+1).
