# 03 — Bấm để xem đầy đủ: tab JSON chỉ đọc

**What to build:** Hover của dòng log hiện bản trải ra + link **Show full value**; bấm → server đào sâu tối đa
theo `objectId` đã giữ và client mở một tab JSON chỉ đọc (spec #2, #3, #5).

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Server: request `ejsng/expandRuntimeLog { logId }` → đào `{ depth: 6, keys: 50, items: 200, requests: 200 }`,
      trả `{ json, stale }`; `objectId` không còn → `stale: true` + bản đã đào sẵn
- [ ] Client: hover dùng `expanded` (khối ```json) thay cho `value` khi có; giữ nguyên tiêu đề nguồn/thời điểm và danh sách lịch sử
- [ ] Link **Show full value** trong hover → lệnh `ejsng.showLogValue` (ẩn khỏi Command Palette), markdown tin cậy đúng lệnh này
      (thêm vào `enabledCommands` cạnh `ejsng.logVariable`)
- [ ] `TextDocumentContentProvider` scheme `ejsng-log:`, chỉ đọc, ngôn ngữ `json`, tiêu đề tab kiểu `rows — list.controller.js:36`;
      `stale: true` → dòng đầu ghi rõ runtime không còn giữ giá trị này
- [ ] Mở cùng một log hai lần không tạo hai tab; ngắt kết nối không đóng tab đang mở (văn bản tĩnh)
- [ ] Test LSP: `ejsng/expandRuntimeLog` trả JSON `JSON.parse` được; `logId` lạ / `objectId` đã mất → `stale`
- [ ] Test e2e VS Code thật: hover có link → bấm → tab `ejsng-log:` mở ra, nội dung parse được, gập/mở được (kiểm bằng `vscode.executeFoldingRangeProvider`)
