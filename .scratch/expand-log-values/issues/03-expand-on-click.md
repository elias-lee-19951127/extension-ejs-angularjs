# 03 — Bấm để xem đầy đủ: tab JSON chỉ đọc

**What to build:** Hover của dòng log hiện bản trải ra + link **Show full value**; bấm → server đào sâu tối đa
theo `objectId` đã giữ và client mở một tab JSON chỉ đọc (spec #2, #3, #5).

**Blocked by:** 02

**Status:** done

- [x] Server: request `ejsng/expandRuntimeLog { logId }` → đào `{ depth: 6, keys: 50, items: 200, requests: 200 }`,
      trả `{ json, stale }`; `objectId` không còn → `stale: true` + bản đã đào sẵn
- [x] Client: hover dùng `expanded` (khối ```json) thay cho `value` khi có; giữ nguyên tiêu đề nguồn/thời điểm và danh sách lịch sử
- [x] Link **Show full value** trong hover → lệnh `ejsng.showLogValue` (ẩn khỏi Command Palette), markdown tin cậy đúng lệnh này
      (thêm vào `enabledCommands` cạnh `ejsng.logVariable`)
- [x] `TextDocumentContentProvider` scheme `ejsng-log:`, chỉ đọc, ngôn ngữ `json`, tiêu đề tab kiểu `rows — list.controller.js:36`;
      `stale: true` → dòng đầu ghi rõ runtime không còn giữ giá trị này
- [x] Mở cùng một log hai lần không tạo hai tab; ngắt kết nối không đóng tab đang mở (văn bản tĩnh)
- [x] Test LSP: `ejsng/expandRuntimeLog` trả JSON `JSON.parse` được; `logId` lạ / `objectId` đã mất → `stale`
- [x] Test e2e VS Code thật: hover có link → bấm → tab `ejsng-log:` mở ra, nội dung parse được, gập/mở được (kiểm bằng `vscode.executeFoldingRangeProvider`)

## Comments

**2026-09-20 — done.** Server: request `ejsng/expandRuntimeLog { logId }` đào `{ depth: 6, keys: 50, samples: 200,
requests: 200 }` từ `objectId` đã giữ, trả `{ json, stale }`. **Cách nhận biết `stale`:** một handle runtime đã thả
thì `getProperties` không trả gì, nên chỗ đáng lẽ có thuộc tính lại trống — dùng đúng dấu hiệu đó, không phải bắt lỗi.

Client: `RuntimeLogEntry` thêm `logId` / `inline` / `expanded`; `RuntimeLogState.expand(logId, …)` thay chữ **tại
chỗ** trong lịch sử (log mới hơn vẫn là cái được vẽ, không bị log cũ đào xong chen lên); `formatRuntimeLogInline`
dùng `inline` khi đã có. Hover: khối `js` là bản trải ra + link **Show full value**. Lệnh `ejsng.showLogValue` mở
`ejsng-log:<tên>.json` qua `TextDocumentContentProvider` chỉ đọc; `stale` → ngôn ngữ `jsonc` + một dòng `//` nói rõ
runtime không còn giữ giá trị (JSON thuần không có chỗ cho ghi chú). Markdown của hover tin cậy đúng hai lệnh của
extension.

**Ba điều phát hiện khi test e2e:**
1. Hover của log là `hoverMessage` của decoration, **không** phải HoverProvider — `executeHoverProvider` không thấy.
   Thêm `markdown` vào `hovers()` của test API để test đọc được.
2. Test e2e dùng chung một cửa sổ VS Code; vẽ log lên `app.js` làm hỏng test khác vốn so khớp decoration của file đó
   nguyên văn. Dùng fixture riêng `values.js` (test logpoint cũ đã ghi chú đúng bài học này).
3. Test e2e cũ so khớp **nguyên danh sách** `enabledCommands`; giờ có hai lệnh. Đổi thành: phải chứa lệnh của nó và
   mọi lệnh đều thuộc `ejsng.` — kiểm đúng điều cần kiểm (không mở toàn quyền) mà không vỡ khi thêm lệnh sau này.

Fake runtime trong e2e học được `sendObjectLog` + trả lời `Runtime.getProperties`, mô phỏng đúng cách V8 gửi: preview
một cấp, các cấp sâu chỉ có khi hỏi.

Test: e2e VS Code thật (+1: inline không còn chữ `Object`, hover có bản trải ra và link, bấm link mở tab
`ejsng-log:` parse được, đào sâu hơn bản inline, ngôn ngữ `json`, và **gập được** — kiểm bằng
`executeFoldingRangeProvider`), server LSP (+1), client (+1). Toàn bộ: e2e 10/10; đơn vị 486/493 (5 lỗi smart-city
có sẵn, 2 bỏ qua vì cổng 9229 bận).
