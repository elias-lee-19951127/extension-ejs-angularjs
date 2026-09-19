# 02 — Logpoint theo cột

**What to build:** Pipeline logpoint mang được **cột**: client gửi, server đặt breakpoint ở đúng cột và
resolve biểu thức của logpoint tại đúng vị trí đó (spec #5). Logpoint dev tự đặt ở lề (cột 0) không đổi.

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] `packages/vscode-client/src/logpoints.ts` — `BreakpointLike.location.range.start.character`; `LogpointParams.character?`
      (bỏ khi bằng 0, để notification của logpoint ở lề giữ nguyên)
- [x] Server `ejsng/setLogpoints` nhận `character` (số nguyên ≥ 0, sai kiểu → bỏ qua như cũ); `Logpoint.character`
- [x] `setLogpointBreakpoint` gửi `columnNumber` khi có — cho cả `urlRegex` lẫn `url` chính xác (`bindScriptLogpoints`)
- [x] `logpointTargets` resolve biểu thức tại offset của `(line, character)` khi có; không có → ký tự không trắng đầu dòng như cũ
- [x] `locations: []` trong trả lời của `setBreakpointByUrl` **không** coi là lỗi (V8 compile lười — đã đo)
- [x] Test `node --inspect` thật (`packages/server/test/runtime-log-logpoints.test.js`): logpoint theo cột trong hàm một dòng
      `function (res) { $scope.rows = res.data; }` log giá trị **sau** lần gán, và thành bằng chứng kiểu cho `rows`
- [x] Test client: `character` 0 → không có trường `character`; khác 0 → có

## Comments

**2026-09-20 — done.** Client `logpointsFrom` gửi `character` khi khác 0 (logpoint ở lề giữ nguyên notification cũ).
Server: `Logpoint.character` (chỉ nhận số nguyên > 0), `setLogpointBreakpoint` gửi `columnNumber` — dùng chung cho
`urlRegex` lẫn `url` chính xác từ `bindScriptLogpoints`; `logpointTargets` resolve tại cột khi có.
`locations: []` không bao giờ bị coi là lỗi (code vốn chỉ đọc `breakpointId`; ghi chú lại trong comment).

Test `node --inspect` thật (`packages/server/test/runtime-log-type-evidence.test.js`, +1): logpoint ngay sau
`$scope.rows = res.data;` trong callback một dòng → mọi giá trị log đều là mảng (không bao giờ `undefined`), log
vẽ đúng dòng, thành bằng chứng kiểu, hover trong file JS ra `{ id: number }[]`. **Kiểm ngược:** tạm bỏ
`columnNumber` → logpoint không bao giờ chạy, test đỏ (hết giờ, 0 log) — test bắt đúng lỗi.
Client: `packages/vscode-client/test/logpoints.test.js` (+1).

**Test chập chờn, đã nới:** `runtime-log-frame-selection.test.js` "wrapper-file suggestion" chờ 20 log với hạn
3 giây — đỏ 2/4 lần chạy cả bộ sau khi thêm các test `node --inspect` thật chạy song song; chạy riêng luôn xanh.
Nới hạn lên 10 giây (chỉ là cận trên, vòng lặp thoát ngay khi đủ). Sau đó 2/2 lần chạy cả bộ ổn định.
Toàn bộ: 469/474, 5 lỗi smart-city có sẵn.
