# 04 — Verify trong VS Code thật + tài liệu

**What to build:** Kiểm luồng đầy đủ trên `smart-city` trong VS Code thật, rồi ghi tính năng vào tài liệu
(bản Việt chính, bản Anh đi kèm — CLAUDE.md).

**Blocked by:** 03

**Status:** done — còn verify tay trong VS Code thật

- [ ] VS Code thật, `smart-city`: hover một biến gán từ `res.data` → bấm **Log at runtime** → logpoint hiện ở lề đúng
      chỗ sau câu gán → nối Runtime Log vào Chrome → dòng đó chạy → hover có kiểu + *Seen at runtime*
- [ ] Bấm lần hai không sinh logpoint thứ hai; nút Connect Runtime / Show hoạt động
- [x] `README.md` + `README.en.md`: đoạn "Kiểu thấy lúc chạy" nói tới link Log at runtime
- [x] `docs/kien-truc.md` + `docs/architecture.md` mục 5.3.2: logpoint theo cột (bảng đo), vì sao không code action,
      vì sao không tự gỡ
- [x] `CONTEXT.md` + `CONTEXT.en.md`: chỉ khi có thuật ngữ mới
- [x] Cập nhật "Trạng thái" trong `spec.md`

## Comments

**2026-09-20 — tài liệu xong.** README (cả hai bản): đoạn "Kiểu thấy lúc chạy" mở đầu bằng link **Log at runtime**.
Kiến trúc: mục mới **5.3.3** (bảng đo cột vs dòng, `ScopeWrite.after`/`lhsText`, vì sao không code action, vì sao
không tự gỡ, tin cậy markdown cho đúng một lệnh); câu "hướng tiếp theo" ở 5.3.2 trỏ sang 5.3.3. CONTEXT: không có
thuật ngữ mới (link và lệnh không phải khái niệm domain) — không sửa.

Đã có e2e trong VS Code 1.138 thật (ticket 03) phủ: link lấy từ hover, markdown được tin cậy, logpoint đúng cột, bấm
lần hai vẫn một, `columnNumber` tới runtime.

**Còn lại cho người dùng (2 mục đầu của checklist):** trong VS Code thật với `smart-city` — bấm link bằng chuột,
thấy logpoint ở lề đúng chỗ, nối Runtime Log vào Chrome, dòng đó chạy → hover có kiểu + *Seen at runtime*; thử nút
Connect Runtime / Show của thông báo.

**2026-09-20 — demo để verify tay.** Người dùng không tìm thấy ca `res.data` trong `smart-city`. Đo lại: repo đó có
**105** lần gán không suy ra được kiểu, **tất cả** đều có link — dạng hay gặp là `data.voices || []`, `item.voiceId`,
`stats || { … }`, không phải `res.data`. Ví dụ kiểm được ngay: `new-version-2/new-index.js:406`
(`$scope.voice.voices = data.voices || []`) — đã chạy server thật trên `smart-city` và đọc hover, link có đúng.

Thêm `examples/log-at-runtime/` (`list.controller.js` + `list.html` + `README.md`) — **không** đặt trong
`.scratch/` vì Finder của macOS ẩn thư mục bắt đầu bằng dấu chấm, người dùng không mở được: một controller chạy được bằng `node --inspect`
(có `angular` giả), không cần trình duyệt. Đã chạy tự động trọn kịch bản của README: hover → tham số của link →
đặt logpoint → nối runtime → hover ra kiểu thật + *Seen at runtime*, `selected` ra `… | null` + *Seen null at runtime*
mà **không** sinh inlay hint. Còn lại cho người dùng: bấm chuột vào link và thử các nút của thông báo.
