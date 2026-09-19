# 03 — Link "Log at runtime" trong hover + lệnh `ejsng.logVariable`

**What to build:** Cạnh mỗi lần gán không suy ra được kiểu trong hover, một link bấm được đặt logpoint VS
Code ngay sau lần gán đó (spec #1, #2, #4, #6–#10). Chỉ khi client khai báo chạy được lệnh.

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] Server: `initializationOptions.commands` (mảng chuỗi); có `'ejsng.logVariable'` → `observedTypeLines` thêm
      `· [Log at runtime](command:ejsng.logVariable?<args>)` sau mỗi nguồn trong `unknownFrom` có `after`
      (cả ba dạng dòng: "Could not be inferred", "Some assignments…", "Not inferred statically…")
- [ ] Tham số lệnh: `{ uri, line, character, logMessage }` — `uri` của file JS (qua `workspaceUri`), vị trí từ `after`,
      `logMessage` = `<lhsText> = {<lhsText>}`; mã hoá đúng dạng `command:` URI của VS Code
- [ ] Client: `markdown: { isTrusted: { enabledCommands: ['ejsng.logVariable'] } }` trong `LanguageClientOptions`;
      `initializationOptions.commands: ['ejsng.logVariable']`
- [ ] Lệnh `ejsng.logVariable` trong `package.json` (tiêu đề tiếng Anh), ẩn khỏi Command Palette (`"when": "false"`)
- [ ] Thêm `vscode.SourceBreakpoint` (vị trí có cột, không `condition`) bằng `vscode.debug.addBreakpoints`
- [ ] Không trùng: đã có breakpoint ở đúng `(uri, dòng, cột)` → cùng `logMessage` mà đang tắt thì bật lại, còn lại thì chỉ báo
- [ ] Thông báo: "Logging `<lhs>` after <file>:<dòng> — hover again once that line runs." + nút **Connect Runtime**
      (khi không có kết nối nào) và **Show** (mở file tại chỗ đặt); `ejsng.runtimeLog.logpoints` tắt → báo + nút mở setting, không tự bật
- [ ] Phần thuần tách khỏi `vscode` (như `logpoints.ts`): dựng tham số, kiểm trùng — test không cần Extension Host
- [ ] Test LSP stdio: có link khi khai `commands`, không có khi không khai (IntelliJ); không có link khi lần gán không có `after`
      hoặc kiểu đã suy ra được
