# 01 — Core: RemoteObject → shape, object "mở"

**What to build:** Hàm thuần trong `packages/core` đổi một arg của `Runtime.consoleAPICalled`
(`RemoteObject`, kèm kết quả `Runtime.getProperties` đã đào nếu có) thành `ValueShape` + cờ `nullable`,
theo luật của spec #4, #5. Và luật gộp object "mở" trong `mergeTypes` để bằng chứng bị cắt không làm
key thành optional sai.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] `ValueShape` thêm `open?: boolean` (object không chắc đủ key) và kiểu có tên (`Date`, `RegExp`, `Map`, `Set`,
      `Promise`, `Error`) — không làm vỡ Shape Walking / completion / bản 1
- [ ] Primitive: `string`/`number`/`boolean` có kiểu; `null` (subtype) và `undefined` → `nullable`, không vào `shapes`
- [ ] `function` → function, tham số parse từ `description` khi được (`function f(a, b) {}`), không được thì `[]`
- [ ] Object/mảng: dùng `getProperties` khi có, không thì preview; preview `overflow`, key lồng không có
      `valuePreview`, hoặc phần không đào → `open: true`
- [ ] Bỏ key `accessor` (không bao giờ chạy getter) và key bắt đầu `$$`
- [ ] Object > 50 key hoặc có key không phải định danh JS → `Record<string, T>`, `T` gộp từ các giá trị; không liệt kê key
- [ ] Phần tử mảng: gộp shape của các phần tử mẫu (tối đa 3) thành `element`
- [ ] `mergeTypes`: object `open` góp key nó có, nhưng key nó **thiếu** không thành optional; `open` ∪ `open` vẫn `open`;
      hiển thị object mở không thêm dấu gì khác thường (chỉ không có `?` sai)
- [ ] Chữ ký shape ổn định (không phụ thuộc thứ tự key) để ticket 03 khử trùng
- [ ] Test ở `packages/core/test/` với fixture `RemoteObject` **chép từ V8 thật** (cách đo trong spec), gồm:
      object 12 key (overflow), mảng 150 object, object có getter, `$$hashKey`, từ điển key email, `Date`, `null`/`undefined`
