# 02 — Client: CodeLens "Log at runtime"

**What to build:** CodeLens trên mỗi dòng gán vào scope, bấm một cái là có logpoint; bấm lại thì gỡ
(spec #1, #2, #3, #4, #7, #8).

**Blocked by:** 01

**Status:** done

- [x] `registerCodeLensProvider` cho `{ scheme: 'file', language: 'javascript' }`; lấy đích qua `ejsng/logTargets`
- [x] Setting `ejsng.logLens`: `"unknown"` (mặc định) / `"all"` / `"off"` trong `package.json`, mô tả nói rõ số lens
- [x] Nhãn: `Log rows at runtime`; dòng đã có logpoint của extension → `Logging rows — click to remove`
- [x] Bấm → `ejsng.logVariable` với `toggle: true`: chưa có thì tạo, có rồi thì gỡ (link trong hover **không** đổi hành vi)
- [x] Vẽ lại lens khi: breakpoint đổi (`onDidChangeBreakpoints`), setting đổi, file đổi nội dung
- [x] Phần thuần trong `log-variable.ts` (dựng nhãn + quyết định tạo/gỡ) — test không cần Extension Host
- [x] Test client: nhãn theo trạng thái; lọc theo `unknown`/`all`/`off`

## Comments

**2026-09-20 — done.** `logLenses(targets, mode, uri, breakpoints)` thuần trong `log-variable.ts` (lọc theo
mode, dựng nhãn theo trạng thái), `registerCodeLensProvider` cho `{ scheme: 'file', language: 'javascript' }`
trong `extension.ts`. Lens vẽ lại khi breakpoint đổi hoặc setting đổi (`EventEmitter` + `onDidChangeCodeLenses`),
nên đổi `ejsng.logLens` **không cần reload**.

Nhãn dùng icon sẵn có của VS Code: `$(debug-breakpoint-log) Log rows at runtime`, đã log rồi thì
`$(debug-breakpoint-log) Logging rows — click to remove`. Bấm → `ejsng.logVariable` với `toggle: true`: có rồi
thì gỡ. Link trong hover **không** đổi hành vi (bấm lại chỉ báo "đã log rồi") — hover là "thêm", lens ở ngay
trên dòng nên là "bật/tắt".

Test: `packages/vscode-client/test/log-variable.test.js` (+2).
