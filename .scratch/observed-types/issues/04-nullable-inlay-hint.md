# 04 — Inlay hint "có thể rỗng" + setting

**What to build:** Server trả `textDocument/inlayHint` cho biểu thức Angular trong template khi
biến gốc của nó `nullable` (spec #2, #3): chú thích ngắn, nhạt, **"có thể rỗng"**, không gọi là
lỗi. Setting `ejsng.typeHints.nullable` (mặc định `true`) tắt riêng tính năng này.

**Blocked by:** 02

**Status:** done — còn verify tay trong IDE

- [x] Khai `inlayHintProvider` trong `initialize`; handler chỉ trả hint trong range được hỏi
- [x] Mỗi biến chỉ **một** hint mỗi biểu thức, đặt sau identifier; tooltip dẫn về hover
- [x] **Không** hint cho: `onlyInCallback` mà không `nullable`, kiểu không suy ra được, file JS, EJS local
- [x] Setting `ejsng.typeHints.nullable` trong `packages/vscode-client/package.json`, truyền qua
      `initializationOptions` như các setting khác (đổi xong reload window)
- [x] Test LSP stdio: có hint khi có `= null`; không hint khi chỉ gán trong callback; setting `false` → không hint
- [ ] Verify tay trong VS Code (hint nhạt, không rối dòng). IntelliJ qua LSP4IJ: ghi là cần verify tay, không chặn ticket

## Comments

**2026-09-19 — done (trừ verify tay).** Core: `nullableHints(src, relPath, range?)` trong
`resolve/observed-type.ts` + `Workspace.nullableHints`. Với mỗi chuỗi property trong một biểu thức
Angular (`vm.user.name`), hint đặt sau tiền tố **đầu tiên** có kiểu `nullable` (`vm.user`); mỗi biến
một hint mỗi biểu thức. Đi qua controllerAs alias và phần tử `ng-repeat` (`row.owner`). Memo theo
(controller, đường dẫn) trong một lần gọi.

Server: `connection.languages.inlayHint.on`, `inlayHintProvider: true` luôn khai (setting tắt → trả `[]`).
Nhãn **`may be empty`** (tiếng Anh theo CLAUDE.md — bản dịch của "có thể rỗng"), `paddingLeft`, không
`kind`; tooltip markdown nói biến được gán `null`/`undefined` và trỏ sang hover.
Setting `ejsng.typeHints.nullable` (mặc định `true`) → `initializationOptions.typeHints.nullable`.
IntelliJ không gửi option → mặc định bật.

Test: `packages/core/test/observed-type.test.js` (+2), `packages/server/test/lsp.test.js` (+2:
hint có `= null`, không hint khi chỉ gán trong callback, setting `false`, range không chứa biến).

smart-city: 9 template → 127 hint (`notice`, `lastIngest`, `lastSearchMs`, `docStorage` — đều có
`= null` thật), 62ms cả 9 file, file nặng nhất 29ms khi hỏi cả file (trước memo: 90ms).

**Chưa làm:** verify tay trong VS Code (hint nhạt, không rối dòng) và IntelliJ qua LSP4IJ.
