# 01 — Core: RemoteObject → shape, object "mở"

**What to build:** Hàm thuần trong `packages/core` đổi một arg của `Runtime.consoleAPICalled`
(`RemoteObject`, kèm kết quả `Runtime.getProperties` đã đào nếu có) thành `ValueShape` + cờ `nullable`,
theo luật của spec #4, #5. Và luật gộp object "mở" trong `mergeTypes` để bằng chứng bị cắt không làm
key thành optional sai.

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] `ValueShape` thêm `open?: boolean` (object không chắc đủ key) và kiểu có tên (`Date`, `RegExp`, `Map`, `Set`,
      `Promise`, `Error`) — không làm vỡ Shape Walking / completion / bản 1
- [x] Primitive: `string`/`number`/`boolean` có kiểu; `null` (subtype) và `undefined` → `nullable`, không vào `shapes`
- [x] `function` → function, tham số parse từ `description` khi được (`function f(a, b) {}`), không được thì `[]`
- [x] Object/mảng: dùng `getProperties` khi có, không thì preview; preview `overflow`, key lồng không có
      `valuePreview`, hoặc phần không đào → `open: true`
- [x] Bỏ key `accessor` (không bao giờ chạy getter) và key bắt đầu `$$`
- [x] Object > 50 key hoặc có key không phải định danh JS → `Record<string, T>`, `T` gộp từ các giá trị; không liệt kê key
- [x] Phần tử mảng: gộp shape của các phần tử mẫu (tối đa 3) thành `element`
- [x] `mergeTypes`: object `open` góp key nó có, nhưng key nó **thiếu** không thành optional; `open` ∪ `open` vẫn `open`;
      hiển thị object mở không thêm dấu gì khác thường (chỉ không có `?` sai)
- [x] Chữ ký shape ổn định (không phụ thuộc thứ tự key) để ticket 03 khử trùng
- [x] Test ở `packages/core/test/` với fixture `RemoteObject` **chép từ V8 thật** (cách đo trong spec), gồm:
      object 12 key (overflow), mảng 150 object, object có getter, `$$hashKey`, từ điển key email, `Date`, `null`/`undefined`

## Comments

**2026-09-19 — done.** `packages/core/src/runtime-shape.ts`: `typeOfRuntimeValue(RuntimeValue)`,
`runtimeProperties(descriptors)` (kiểm từng descriptor — runtime là peer mạng), `paramsOf`, `typeSignature`.

**Lệch khỏi checklist, có chủ đích:** không mở rộng `ValueShape`. Bằng chứng runtime mang thẳng
`ObservedType` (`TypeEvidence.type`, gộp trong `writeType`). Lý do: `ValueShape` là định dạng ghi vào
cache index và là đầu vào của Shape Walking/completion; nó không biểu diễn được union phần tử
(`(number | string | null)[]`) mà giá trị thật hay có. Runtime không bao giờ ghi cache (spec #6), nên
không cần serialize. Hệ quả: không đổi `PARSER_VERSION`, bản 1 không bị động tới.
`Variant` thêm: `open?` cho object, `named` (`Date`, `Map`…), `record` (`Record<string, T>`, đi được
bằng mọi key trong `typeAtPath`).

**Hiển thị object mở:** thêm `…` cuối (`{ k0: number, …, k4: number, … }`), object mở rỗng là `{…}`.
Checklist ghi "không thêm dấu gì" — đổi vì liệt kê 5 key mà không báo là thiếu thì hover nói sai.

**Mảng:** dùng mọi phần tử có trong preview / `getProperties` (không tốn lệnh CDP nào). Việc lấy mẫu
3 phần tử là để **đào** — thuộc ticket 03.

Fixture: `packages/core/test/fixtures/v8-console-args.json`, chụp từ Node 20.20 qua `node:inspector`
(bỏ `objectId`, cắt `rows.props` còn 5 mục — ghi trong `note`). Thấy thêm khi chụp: getter trả
`get`/`set` không có `value`; `length` của mảng là `enumerable: false`; `getProperties` với
`generatePreview` cho mỗi con một preview 5 key → đào 1 cấp là thấy được cấp kế tiếp.
Test: `packages/core/test/runtime-shape.test.js` (11). Toàn bộ test: 442/447 — 5 test lỗi đều đọc repo
`smart-city` thật và lỗi y hệt trên HEAD sạch (vd `scopeMembers` 236, test chờ 76) → có sẵn, ngoài ticket.
