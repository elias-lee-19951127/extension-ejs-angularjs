# 04 — Inlay hint "có thể rỗng" + setting

**What to build:** Server trả `textDocument/inlayHint` cho biểu thức Angular trong template khi
biến gốc của nó `nullable` (spec #2, #3): chú thích ngắn, nhạt, **"có thể rỗng"**, không gọi là
lỗi. Setting `ejsng.typeHints.nullable` (mặc định `true`) tắt riêng tính năng này.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Khai `inlayHintProvider` trong `initialize`; handler chỉ trả hint trong range được hỏi
- [ ] Mỗi biến chỉ **một** hint mỗi biểu thức, đặt sau identifier; tooltip dẫn về hover
- [ ] **Không** hint cho: `onlyInCallback` mà không `nullable`, kiểu không suy ra được, file JS, EJS local
- [ ] Setting `ejsng.typeHints.nullable` trong `packages/vscode-client/package.json`, truyền qua
      `initializationOptions` như các setting khác (đổi xong reload window)
- [ ] Test LSP stdio: có hint khi có `= null`; không hint khi chỉ gán trong callback; setting `false` → không hint
- [ ] Verify tay trong VS Code (hint nhạt, không rối dòng). IntelliJ qua LSP4IJ: ghi là cần verify tay, không chặn ticket
