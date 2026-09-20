# 02 — Server: đào lúc vẽ, có chặn tần suất

**What to build:** Mỗi log được vẽ mang theo bản một dòng và bản trải ra, đào bằng `getProperties` với
ngân sách và chặn tần suất; server giữ `objectId` để ticket 03 đào sâu hơn (spec #4, #7, #9, #10).

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `handleRuntimeLog`: sau khi gửi notification (ngoài `info.queue`, như `collectTypeEvidence`), đào mỗi đối số
      với `{ depth: 3, keys: 30, samples: 10, requests: 40 }`, rồi gửi bản cập nhật
- [ ] Chặn tần suất: **≤ 1 lần đào mỗi `(file, dòng)` mỗi 300 ms**; log bị chặn vẫn vẽ với `value` như cũ
- [ ] Notification `ejsng/runtimeLog` thêm `inline?`, `expanded?`, `logId?`; `value` **không đổi nghĩa** (client cũ vẫn chạy)
- [ ] Cách gửi bản đã đào: hoặc gửi notification thứ hai cho cùng `logId`, hoặc chờ đào xong mới gửi một lần —
      chọn và ghi rõ lý do trong Comments (ràng buộc: không được làm chậm việc vẽ, không được vẽ hai lần nhấp nháy)
- [ ] Giữ `objectId` theo `logId` trong RAM của kết nối, giới hạn (vd 200 log gần nhất); ngắt kết nối → xoá
- [ ] Setting `ejsng.runtimeLog.expandValues` (mặc định `true`) trong `package.json` + `initializationOptions`; tắt → không đào, không trường mới
- [ ] Test `node --inspect` thật: `console.log` một mảng object → `inline` có key thật, không có chữ `Object` trơn;
      log 50 lần/giây trên một dòng → số lệnh `getProperties` bị chặn đúng mức; setting `false` → không lệnh nào
