# 01 — Core + server: log cái gì, ở đâu, hay vì sao không

**What to build:** Từ một vị trí con trỏ (và phần bôi đen nếu có) trong file JS, trả về logpoint nên đặt —
biểu thức, vị trí, nội dung — hoặc lý do không đặt được (spec #2, #3, #4, #5).

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Core `logHereAt(source, facts, offset, selection?)` → `{ line, character, expression, logMessage }` hoặc `{ reason }`
- [ ] Thứ tự chọn biểu thức (spec #2): bôi đen parse được → chuỗi property dưới con trỏ → biến được gán trên dòng
- [ ] Vị trí (spec #3): vế trái của câu gán → ngay sau câu lệnh (dùng lại `statementEnd`); còn lại → đầu dòng
      (sau khoảng trắng đầu dòng)
- [ ] Lý do từ chối (spec #4), mỗi lý do một mã máy đọc được: `call`, `this-in-callback`, `unparsable`, `nothing-here`
- [ ] `logMessage` = `<tên ngắn> = {<biểu thức>}`, giống CodeLens/hover (spec #5)
- [ ] Server: request `ejsng/logHere { uri, line, character, selection }` → `{ target }` | `{ reason }`; file không phải `.js`
      hoặc ngoài workspace → `{ reason: 'not-js' }`
- [ ] Test core: bôi đen `res.data`; con trỏ giữa `vm.form.owner`; con trỏ trên dòng gán nhưng không trúng chữ;
      con trỏ trên `load()`; `this` trong callback; dòng trống; bôi đen `a +` (không parse được)
- [ ] Test LSP: một controller thật, ba vị trí, một lý do từ chối
