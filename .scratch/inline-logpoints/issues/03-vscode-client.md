# 03 — VS Code client gửi logpoint cho server

**What to build:** Đọc `vscode.debug.breakpoints`, lọc (`SourceBreakpoint`, đang bật, có
`logMessage`, scheme `file`), gửi `ejsng/setLogpoints` lúc server sẵn sàng và mỗi lần
`onDidChangeBreakpoints`. Setting `ejsng.runtimeLog.logpoints` (mặc định `true`): tắt thì gửi danh
sách rỗng. Xem spec, quyết định #2, #3, #8.

**Blocked by:** 02

**Status:** done — còn verify tay: cùng lúc debug bằng js-debug (trùng Debug Console, spec #8)

- [x] Hàm lọc thuần (không import `vscode`) để test được bằng `node --test`.
- [x] `package.json`: setting mới.
- [x] Đổi setting có hiệu lực ngay, không cần reload.
- [x] Test e2e trong VS Code thật (`test-e2e/suite/logpoints.e2e.js`): logpoint thêm qua API breakpoint của VS Code được đặt lên runtime theo đường dẫn container (qua mapping `/srv/app` của fixture), breakpoint thường không bao giờ được đặt, output vẽ inline, gỡ logpoint / tắt setting thì breakpoint bị gỡ.
