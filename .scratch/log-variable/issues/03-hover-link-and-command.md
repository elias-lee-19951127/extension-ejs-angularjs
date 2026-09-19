# 03 — Link "Log at runtime" trong hover + lệnh `ejsng.logVariable`

**What to build:** Cạnh mỗi lần gán không suy ra được kiểu trong hover, một link bấm được đặt logpoint VS
Code ngay sau lần gán đó (spec #1, #2, #4, #6–#10). Chỉ khi client khai báo chạy được lệnh.

**Blocked by:** 01, 02

**Status:** done

- [x] Server: `initializationOptions.commands` (mảng chuỗi); có `'ejsng.logVariable'` → `observedTypeLines` thêm
      `· [Log at runtime](command:ejsng.logVariable?<args>)` sau mỗi nguồn trong `unknownFrom` có `after`
      (cả ba dạng dòng: "Could not be inferred", "Some assignments…", "Not inferred statically…")
- [x] Tham số lệnh: `{ uri, line, character, logMessage }` — `uri` của file JS (qua `workspaceUri`), vị trí từ `after`,
      `logMessage` = `<lhsText> = {<lhsText>}`; mã hoá đúng dạng `command:` URI của VS Code
- [x] Client: `markdown: { isTrusted: { enabledCommands: ['ejsng.logVariable'] } }` trong `LanguageClientOptions`;
      `initializationOptions.commands: ['ejsng.logVariable']`
- [x] Lệnh `ejsng.logVariable` trong `package.json` (tiêu đề tiếng Anh), ẩn khỏi Command Palette (`"when": "false"`)
- [x] Thêm `vscode.SourceBreakpoint` (vị trí có cột, không `condition`) bằng `vscode.debug.addBreakpoints`
- [x] Không trùng: đã có breakpoint ở đúng `(uri, dòng, cột)` → cùng `logMessage` mà đang tắt thì bật lại, còn lại thì chỉ báo
- [x] Thông báo: "Logging `<lhs>` after <file>:<dòng> — hover again once that line runs." + nút **Connect Runtime**
      (khi không có kết nối nào) và **Show** (mở file tại chỗ đặt); `ejsng.runtimeLog.logpoints` tắt → báo + nút mở setting, không tự bật
- [x] Phần thuần tách khỏi `vscode` (như `logpoints.ts`): dựng tham số, kiểm trùng — test không cần Extension Host
- [x] Test LSP stdio: có link khi khai `commands`, không có khi không khai (IntelliJ); không có link khi lần gán không có `after`
      hoặc kiểu đã suy ra được

## Comments

**2026-09-20 — done.** Server: `logVariableLinks` bật khi `initializationOptions.commands` có `'ejsng.logVariable'`;
`logVariableLink(u)` thêm `· [Log at runtime](command:ejsng.logVariable?…)` sau mỗi nguồn trong `unknownFrom` có
`after` + `lhsText` — dùng chung cho cả ba dạng dòng vì chúng cùng dựng từ một danh sách `sources`. Tham số:
`{ uri, line, character, expression, logMessage }` (thêm `expression` so với checklist — để thông báo nêu tên biến
mà không phải bóc lại từ `logMessage`). Mã hoá thêm `(`/`)` — một `)` trong đường dẫn sẽ cắt link markdown.

Client: `markdown.isTrusted: { enabledCommands: ['ejsng.logVariable'] }`, `initializationOptions.commands`, lệnh
trong `package.json` + ẩn khỏi palette. Phần thuần ở `packages/vscode-client/src/log-variable.ts`
(`parseLogVariableArgs`, `planLogVariable`, `fileNameOf`). "Bật lại" = gỡ breakpoint cũ rồi thêm bản bật (API VS Code
không cho sửa `enabled`). **Thông báo không được `await`:** lệnh xong khi đã đặt logpoint, không phải khi người dùng
đóng thông báo (thấy khi viết e2e — lệnh treo tới khi đóng).

Test:
- `packages/vscode-client/test/log-variable.test.js` (5, phần thuần);
- `packages/server/test/lsp.test.js` (+1: có link khi khai `commands`, tham số đúng vị trí trong callback một dòng;
  không link cho `return $scope.picked = …` và cho kiểu đã biết; client không khai → không link);
- **e2e trong VS Code 1.138 thật** (`packages/vscode-client/test-e2e/suite/log-variable.e2e.js`, fixture
  `list.controller.js` / `list.html`): hover qua `vscode.executeHoverProvider` có link, markdown `isTrusted` đúng
  `{ enabledCommands: ['ejsng.logVariable'] }`, chạy lệnh từ đúng tham số của link → một logpoint ở đúng cột, bấm
  lần hai vẫn một, nối runtime giả → `setBreakpointByUrl` có `lineNumber` + `columnNumber` đúng. 9/9 e2e xanh.

Toàn bộ test đơn vị: 475/480, 5 lỗi smart-city có sẵn. Chưa kiểm bằng tay: bấm link bằng chuột trong hover thật,
và các nút của thông báo (ticket 04).
