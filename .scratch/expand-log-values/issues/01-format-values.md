# 01 — Core: định dạng giá trị đã đào

**What to build:** Từ một `RuntimeValue` (đã đào bằng `digRuntimeValue`), sinh ba dạng chữ: một dòng cho
inline, nhiều dòng gọn cho hover, và JSON hợp lệ cho tab (spec #1, #2, #6, #8). Thuần, không IO.

**Blocked by:** None — bắt đầu ngay.

**Status:** done

- [x] `formatRuntimeValueInline(value, { depth: 2, maxLength: 200, maxString: 40 })` → `[{id: 0, title: 'Sensor 0', owner: {…}, …+2}, …+149]`;
      không bao giờ ra `Object` / `Array(150)` trơn; phần cắt ghi `…+N`
- [x] `formatRuntimeValuePretty(value, { depth: 3, keys: 30, items: 10, maxString: 200, maxBytes: 8192 })` → nhiều dòng, dạng gọn kiểu JS
- [x] `formatRuntimeValueJson(value, { depth: 6, keys: 50, items: 200, maxString: 10000, maxBytes: 2_000_000 })` → **JSON hợp lệ** (`JSON.parse` được)
- [x] Vòng lặp tham chiếu: dừng ở giới hạn độ sâu (`{…}`) — `objectId` **không** nhận ra được danh tính (đo: V8 cấp id mới mỗi tham chiếu);
      getter → `[getter]` (không bao giờ chạy); hàm → `[Function: name]`;
      `Date`/`RegExp`/`Map`/`Set`/`Error` → mô tả của runtime; `undefined` → `undefined` (JSON: chuỗi `"undefined"`)
- [x] Nhánh chưa đào (hết ngân sách) → `{…}` / `[…]` (JSON: `"[not expanded]"`), không giả vờ là rỗng
- [x] `digRuntimeValue` chống vòng lặp: `objectId` đã đào thì không đào lại (hiện chưa có — `cyclic.self = cyclic` sẽ tiêu ngân sách vô ích)
- [x] Test với fixture V8 thật và qua `node:inspector` trong tiến trình: mảng 150 object, object lồng sâu, object vòng lặp,
      getter, `Date`/`Map`, chuỗi dài, nhánh chưa đào; JSON sinh ra `JSON.parse` được

## Comments

**2026-09-20 — done.** `packages/core/src/runtime-format.ts`: `formatRuntimeValueInline` / `…Pretty` / `…Json`
cùng dựng một cây `Node` trung gian rồi viết ra ba kiểu — một chỗ quyết định "giá trị này hiện thế nào", ba chỗ
quyết định "viết ra sao". Hằng số: `INLINE_VALUE_LIMITS` (sâu 2, 6 key, 200 ký tự), `HOVER_VALUE_LIMITS` (sâu 3),
`JSON_VALUE_LIMITS` (sâu 6) — đặt tên có `VALUE` vì `HOVER_LIMITS` đã thuộc về phần kiểu (`observed-type.ts`).

**Sửa quyết định #6 của spec, sau khi đo:** V8 cấp `objectId` **mới cho mỗi lần tham chiếu** cùng một object
(`…1.1`, `…1.2`, `…1.3` cho `root`, `root.self`, `root.again`). Nên không nhận ra vòng lặp bằng danh tính được;
muốn biết phải gọi thêm `Runtime.callFunctionOn` so từng tổ tiên — vài lệnh mỗi nút vào app đang chạy. Bỏ lời hứa
`[Circular]`: vòng lặp dừng ở **giới hạn độ sâu** và hiện `{…}` / `"[not expanded]"`. Có test khẳng định điều đó.

**Ngân sách inline theo độ dài:** phần không vừa được cộng vào `…+N` của chính object/mảng chứa nó nên dấu đóng
luôn còn; nếu vẫn lố (đuôi `…+N` của các cấp lồng viết sau lúc kiểm) thì thử lại với ngân sách nhỏ dần.

**Dọn dẹp ngoài ticket:** 4 file nguồn chứa **byte NUL thật** (`store.ts`, `runtime-log-checklist.ts`,
`runtime-evidence.ts`, `server/index.ts`) — dùng làm dấu phân cách khoá. Đổi sang escape kiểu `u0000`: cùng nghĩa,
nhưng nhìn thấy được trong editor và `grep` không còn coi file nguồn là nhị phân (đây chính là nguyên nhân của
mẹo "phải dùng `grep -a`" bấy lâu).

Test: `packages/core/test/runtime-format.test.js` (8, V8 thật qua `node:inspector`): mảng 150 object không còn chữ
`Object` nào; JSON parse được và phần tử chưa đào ghi `[not expanded]`; getter không bao giờ chạy; `Date`/`RegExp`/`Map`
hiện theo mô tả; vòng lặp dừng ở độ sâu; chuỗi dài bị cắt; JSON quá lớn thì thu nhỏ chứ không cắt hỏng; `$$hashKey` bị bỏ.
Toàn bộ: 481/488 (5 lỗi smart-city có sẵn; 2 test bỏ qua vì cổng 9229 đang bận — demo của người dùng đang chạy).
