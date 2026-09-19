# 02 — Logpoint theo cột

**What to build:** Pipeline logpoint mang được **cột**: client gửi, server đặt breakpoint ở đúng cột và
resolve biểu thức của logpoint tại đúng vị trí đó (spec #5). Logpoint dev tự đặt ở lề (cột 0) không đổi.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] `packages/vscode-client/src/logpoints.ts` — `BreakpointLike.location.range.start.character`; `LogpointParams.character?`
      (bỏ khi bằng 0, để notification của logpoint ở lề giữ nguyên)
- [ ] Server `ejsng/setLogpoints` nhận `character` (số nguyên ≥ 0, sai kiểu → bỏ qua như cũ); `Logpoint.character`
- [ ] `setLogpointBreakpoint` gửi `columnNumber` khi có — cho cả `urlRegex` lẫn `url` chính xác (`bindScriptLogpoints`)
- [ ] `logpointTargets` resolve biểu thức tại offset của `(line, character)` khi có; không có → ký tự không trắng đầu dòng như cũ
- [ ] `locations: []` trong trả lời của `setBreakpointByUrl` **không** coi là lỗi (V8 compile lười — đã đo)
- [ ] Test `node --inspect` thật (`packages/server/test/runtime-log-logpoints.test.js`): logpoint theo cột trong hàm một dòng
      `function (res) { $scope.rows = res.data; }` log giá trị **sau** lần gán, và thành bằng chứng kiểu cho `rows`
- [ ] Test client: `character` 0 → không có trường `character`; khác 0 → có
