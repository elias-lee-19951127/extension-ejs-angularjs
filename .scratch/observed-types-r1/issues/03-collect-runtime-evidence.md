# 03 — Server: thu bằng chứng kiểu từ log

**What to build:** Khi `handleRuntimeLog` nhận một log đã chọn frame và đã kiểm nội dung, với mỗi arg
nối được với biến scope (ticket 02): đào shape bằng `Runtime.getProperties` trong ngân sách, đổi thành
shape (ticket 01), lưu thành Type Evidence `source: 'runtime'` trong RAM theo kết nối (spec #3, #6, #11).

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] `ParsedConsoleLog` giữ `args` (type/subtype/value?/description/preview/objectId) — chuỗi `value` hiện có không đổi
- [ ] Logpoint: arg thứ i ↔ phần thứ i của `parseLogMessage`; biểu thức resolve lúc `ejsng/setLogpoints`
- [ ] Đào: tới 2 cấp, 8 key/cấp, mảng lấy mẫu 3 phần tử (đầu, giữa, cuối); **≤ 12 lệnh CDP mỗi log**; cùng
      `(kết nối, chỗ log, arg)` đã đào trong 30 giây → chỉ `count++` / `lastSeen`
- [ ] Gọi `getProperties` ngay khi nhận log; lỗi (object đã bị giải phóng, kết nối đóng) → giữ phần preview, `open: true`, không ném
- [ ] Kho: theo kết nối, khoá `(owner, path)`, ≤ 20 chữ ký khác nhau mỗi khoá, tổng ≤ 2000, vượt thì bỏ `lastSeen` cũ nhất;
      `site` = file + span của lời gọi/logpoint; **không lưu giá trị**, không ghi cache
- [ ] Xoá bằng chứng của kết nối khi ngắt, nối lại, hoặc LSP shutdown
- [ ] `ejsng/runtimeStatus` (và panel checklist) có số bằng chứng kiểu mỗi kết nối
- [ ] Log không nối được / log qua wrapper: vẫn vẽ inline như cũ, chỉ không thành bằng chứng
- [ ] Test fake CDP (`packages/server/test/runtime-log-*.test.js`): `console.log($scope.rows)` → bằng chứng có key phần tử;
      ngân sách không vượt 12 lệnh với object lớn; log lặp trong 30 giây không gọi thêm lệnh; ngắt kết nối → hết bằng chứng
