# 01 — Phần thuần ở core: dựng điều kiện logpoint, nhận ra log của logpoint

**What to build:** Module thuần `packages/core/src/logpoint.ts` và một chỗ sửa trong
`parseConsoleApiCalled`, không IO. Xem spec, quyết định #4, #5, #6, #7(a).

**Blocked by:** None

**Status:** done

- [x] `parseLogMessage(message)` → đoạn văn bản / `{biểu thức}`, đếm ngoặc lồng; `{` không đóng thì phần còn lại là văn bản.
- [x] `buildLogpointCondition({ id, logMessage, condition? })` → chuỗi `condition` cho `Debugger.setBreakpointByUrl`: luôn trả `false`, mỗi biểu thức bọc `try/catch`, dùng inspector console nếu có, gắn `//# sourceURL=ejsng-logpoint-<id>`.
- [x] `logpointIdFromUrl(url)` → id hoặc `null`.
- [x] `runtimePathCandidates(localPath, mappings)` (ánh xạ ngược) và `logpointUrlRegex(runtimePath)`.
- [x] `parseConsoleApiCalled`: frame đầu là `ejsng-logpoint-<id>` → bỏ frame đó, nối đối số không chèn dấu cách, gắn `logpointId`.
- [x] Test ở `packages/core/test/logpoint.test.js`, trong đó có test chạy điều kiện đã dựng bằng `vm` để chắc nó là JS hợp lệ và luôn trả `false`.
