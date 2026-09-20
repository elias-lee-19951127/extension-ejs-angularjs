# 02 — Client: CodeLens "Log at runtime"

**What to build:** CodeLens trên mỗi dòng gán vào scope, bấm một cái là có logpoint; bấm lại thì gỡ
(spec #1, #2, #3, #4, #7, #8).

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `registerCodeLensProvider` cho `{ scheme: 'file', language: 'javascript' }`; lấy đích qua `ejsng/logTargets`
- [ ] Setting `ejsng.logLens`: `"unknown"` (mặc định) / `"all"` / `"off"` trong `package.json`, mô tả nói rõ số lens
- [ ] Nhãn: `Log rows at runtime`; dòng đã có logpoint của extension → `Logging rows — click to remove`
- [ ] Bấm → `ejsng.logVariable` với `toggle: true`: chưa có thì tạo, có rồi thì gỡ (link trong hover **không** đổi hành vi)
- [ ] Vẽ lại lens khi: breakpoint đổi (`onDidChangeBreakpoints`), setting đổi, file đổi nội dung
- [ ] Phần thuần trong `log-variable.ts` (dựng nhãn + quyết định tạo/gỡ) — test không cần Extension Host
- [ ] Test client: nhãn theo trạng thái; lọc theo `unknown`/`all`/`off`
