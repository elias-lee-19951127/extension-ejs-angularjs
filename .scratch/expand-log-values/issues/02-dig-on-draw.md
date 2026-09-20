# 02 — Server: đào lúc vẽ, có chặn tần suất

**What to build:** Mỗi log được vẽ mang theo bản một dòng và bản trải ra, đào bằng `getProperties` với
ngân sách và chặn tần suất; server giữ `objectId` để ticket 03 đào sâu hơn (spec #4, #7, #9, #10).

**Blocked by:** 01

**Status:** done

- [x] `handleRuntimeLog`: sau khi gửi notification (ngoài `info.queue`, như `collectTypeEvidence`), đào mỗi đối số
      với `{ depth: 3, keys: 30, samples: 10, requests: 40 }`, rồi gửi bản cập nhật
- [x] Chặn tần suất: **≤ 1 lần đào mỗi `(file, dòng)` mỗi 300 ms**; log bị chặn vẫn vẽ với `value` như cũ
- [x] Notification `ejsng/runtimeLog` thêm `inline?`, `expanded?`, `logId?`; `value` **không đổi nghĩa** (client cũ vẫn chạy)
- [x] Cách gửi bản đã đào: hoặc gửi notification thứ hai cho cùng `logId`, hoặc chờ đào xong mới gửi một lần —
      chọn và ghi rõ lý do trong Comments (ràng buộc: không được làm chậm việc vẽ, không được vẽ hai lần nhấp nháy)
- [x] Giữ `objectId` theo `logId` trong RAM của kết nối, giới hạn (vd 200 log gần nhất); ngắt kết nối → xoá
- [x] Setting `ejsng.runtimeLog.expandValues` (mặc định `true`) trong `package.json` + `initializationOptions`; tắt → không đào, không trường mới
- [x] Test `node --inspect` thật: `console.log` một mảng object → `inline` có key thật, không có chữ `Object` trơn;
      log 50 lần/giây trên một dòng → số lệnh `getProperties` bị chặn đúng mức; setting `false` → không lệnh nào

## Comments

**2026-09-20 — done.** `handleRuntimeLog` gửi log như cũ (thêm `logId` khi việc trải ra đang bật), rồi
`expandLoggedValue` đào **sau** đó, ngoài hàng đợi vẽ, và gửi notification thứ hai `ejsng/runtimeLogExpanded`
`{ logId, inline, expanded }`.

**Chốt cách gửi (ticket để mở):** notification thứ hai, không phải chờ đào xong rồi gửi một lần. Lý do: đào là
một lượt đi-về với app đang chạy (qua Docker/Chrome có thể hàng chục ms), chờ nó sẽ làm chậm mọi log; còn đây
chỉ là một lần cập nhật nội dung của đúng dòng đó, không vẽ lại chỗ khác nên không nhấp nháy.

Chặn tần suất theo `(file, dòng)`, 300 ms, bảng có dọn định kỳ. `objectId` của tối đa 200 log gần nhất giữ trong
`info.loggedArgs` cho ticket 03. Kết nối hỏng/ngắt → xoá cả hai bảng. Setting `ejsng.runtimeLog.expandValues`
(mặc định `true`).

**Hai điều phát hiện khi test, đều đã sửa:**
1. **Chuỗi ở mức trên cùng bị in kèm nháy** — `'rows' [{…}]` thay vì `rows [{…}]`. Console thật in đối số chuỗi
   như văn bản, còn chuỗi *bên trong* một giá trị thì phải có nháy. Thêm `formatRuntimeArgsInline` /
   `formatRuntimeArgsPretty` ở core lo đúng việc này (kèm cả dấu nối: khoảng trắng cho `console.log(a, b)`,
   rỗng cho các phần của logpoint), và chia ngân sách độ dài cho từng đối số.
2. **V8 phát lại console entry đệm từ trước khi client kết nối, và bản phát lại KHÔNG có preview** — hai log đầu
   ra `rows Array(150)` chứ không phải `[Object, …]`. Không phải lỗi, nhưng test phải bám theo `logId` chứ không
   lấy log đầu tiên.

Test: `packages/server/test/runtime-log-type-evidence.test.js` (+2, `node --inspect` thật: mảng 150 object ra
`rows [{id: 0, title: 'Sensor 0', owner: {…}}, …]` không còn chữ `Object`; log ~30 lần/giây một dòng chỉ đào vài
lần; setting `false` → không notification nào, không `logId`), `packages/core/test/runtime-format.test.js` (+1).
Toàn bộ: 484/491 (5 lỗi smart-city có sẵn, 2 bỏ qua vì cổng 9229 bận).

**Client chưa dùng `inline`/`expanded`** — đó là ticket 03 (hover + tab JSON); tới đó người dùng mới thấy khác biệt.
