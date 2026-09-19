# 03 — Server: thu bằng chứng kiểu từ log

**What to build:** Khi `handleRuntimeLog` nhận một log đã chọn frame và đã kiểm nội dung, với mỗi arg
nối được với biến scope (ticket 02): đào shape bằng `Runtime.getProperties` trong ngân sách, đổi thành
shape (ticket 01), lưu thành Type Evidence `source: 'runtime'` trong RAM theo kết nối (spec #3, #6, #11).

**Blocked by:** 01, 02

**Status:** done

- [x] `ParsedConsoleLog` giữ `args` (type/subtype/value?/description/preview/objectId) — chuỗi `value` hiện có không đổi
- [x] Logpoint: arg thứ i ↔ phần thứ i của `parseLogMessage`; biểu thức resolve lúc `ejsng/setLogpoints`
- [x] Đào: tới 2 cấp, 8 key/cấp, mảng lấy mẫu 3 phần tử (đầu, giữa, cuối); **≤ 12 lệnh CDP mỗi log**; cùng
      `(kết nối, chỗ log, arg)` đã đào trong 30 giây → chỉ `count++` / `lastSeen`
- [x] Gọi `getProperties` ngay khi nhận log; lỗi (object đã bị giải phóng, kết nối đóng) → giữ phần preview, `open: true`, không ném
- [x] Kho: theo kết nối, khoá `(owner, path)`, ≤ 20 chữ ký khác nhau mỗi khoá, tổng ≤ 2000, vượt thì bỏ `lastSeen` cũ nhất;
      `site` = file + span của lời gọi/logpoint; **không lưu giá trị**, không ghi cache
- [x] Xoá bằng chứng của kết nối khi ngắt, nối lại, hoặc LSP shutdown
- [x] `ejsng/runtimeStatus` (và panel checklist) có số bằng chứng kiểu mỗi kết nối
- [x] Log không nối được / log qua wrapper: vẫn vẽ inline như cũ, chỉ không thành bằng chứng
- [x] Test fake CDP (`packages/server/test/runtime-log-*.test.js`): `console.log($scope.rows)` → bằng chứng có key phần tử;
      ngân sách không vượt 12 lệnh với object lớn; log lặp trong 30 giây không gọi thêm lệnh; ngắt kết nối → hết bằng chứng

## Comments

**2026-09-19 — done.** Core: `packages/core/src/runtime-evidence.ts` — `digRuntimeValue(object, getProperties, limits)`
(đào theo tầng, lệnh trong một tầng chạy song song, tầng nông trước; phần tử mảng tính cùng tầng với mảng
như cách hover hiển thị; `request` truyền vào nên core không có IO) và `RuntimeEvidenceStore` (`claim` /
`record` / `forMember` / `clear`; khử trùng theo chữ ký kiểu, 20/biến, 2000 tổng, bỏ `lastSeen` cũ nhất).
`ParsedConsoleLog.args` giữ nguyên `RemoteObject` (3 test cũ so nguyên object được cập nhật).

Server (`packages/server/src/index.ts`): `collectTypeEvidence` chạy **sau khi** đã gửi `ejsng/runtimeLog`
và **ngoài** `info.queue` — `getProperties` không làm chậm việc vẽ log kế tiếp. Chỉ file trong workspace.
Kho gắn vào `RuntimeLogConnectionInfo.typeEvidence`: nối lại → info mới, ngắt → info bị xoá khỏi map,
`failed` → `clear()`. Logpoint: `Logpoint.relPath` + `targets` tính một lần ở `ejsng/setLogpoints`
(offset = ký tự không trắng đầu tiên của dòng); log của logpoint cũ (id không còn) bị bỏ qua.

`ejsng/runtimeStatus` có `typeEvidence` mỗi kết nối. **Hiển thị:** trên thanh trạng thái
(`… / dropped 0 · 3 types seen`, chỉ khi > 0) thay vì trong checklist của panel — thanh trạng thái là chỗ
đã tóm tắt các con số của từng kết nối; checklist là để chẩn đoán kết nối.

**Test:** phần ngân sách / đào lại trong 30 giây được test ở core với **V8 thật** qua `node:inspector`
(đếm đúng số lệnh `getProperties`), thay vì fake CDP như checklist ghi — fake sẽ phải tự bịa câu trả lời
của `getProperties`. `packages/core/test/runtime-evidence.test.js` (8), `packages/server/test/runtime-log-type-evidence.test.js`
(1, `node --inspect` thật: `console.log($scope.rows)` + logpoint `{vm.form}` → đúng 2 bằng chứng, lặp lại
không tăng, biến cục bộ `n` không thành bằng chứng, runtime chết → 0), `packages/vscode-client/test/runtime-log-state.test.js` (+1).
Nội dung của bằng chứng được kiểm qua hover ở ticket 04. Toàn bộ: 458/463, 5 lỗi smart-city có sẵn.
