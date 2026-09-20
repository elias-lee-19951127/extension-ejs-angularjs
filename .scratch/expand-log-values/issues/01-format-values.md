# 01 — Core: định dạng giá trị đã đào

**What to build:** Từ một `RuntimeValue` (đã đào bằng `digRuntimeValue`), sinh ba dạng chữ: một dòng cho
inline, nhiều dòng gọn cho hover, và JSON hợp lệ cho tab (spec #1, #2, #6, #8). Thuần, không IO.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] `formatRuntimeValueInline(value, { depth: 2, maxLength: 200, maxString: 40 })` → `[{id: 0, title: 'Sensor 0', owner: {…}, …+2}, …+149]`;
      không bao giờ ra `Object` / `Array(150)` trơn; phần cắt ghi `…+N`
- [ ] `formatRuntimeValuePretty(value, { depth: 3, keys: 30, items: 10, maxString: 200, maxBytes: 8192 })` → nhiều dòng, dạng gọn kiểu JS
- [ ] `formatRuntimeValueJson(value, { depth: 6, keys: 50, items: 200, maxString: 10000, maxBytes: 2_000_000 })` → **JSON hợp lệ** (`JSON.parse` được)
- [ ] Vòng lặp tham chiếu theo `objectId` → `[Circular]`; getter → `[getter]` (không bao giờ chạy); hàm → `[Function: name]`;
      `Date`/`RegExp`/`Map`/`Set`/`Error` → mô tả của runtime; `undefined` → `undefined` (JSON: chuỗi `"undefined"`)
- [ ] Nhánh chưa đào (hết ngân sách) → `{…}` / `[…]` (JSON: `"[not expanded]"`), không giả vờ là rỗng
- [ ] `digRuntimeValue` chống vòng lặp: `objectId` đã đào thì không đào lại (hiện chưa có — `cyclic.self = cyclic` sẽ tiêu ngân sách vô ích)
- [ ] Test với fixture V8 thật và qua `node:inspector` trong tiến trình: mảng 150 object, object lồng sâu, object vòng lặp,
      getter, `Date`/`Map`, chuỗi dài, nhánh chưa đào; JSON sinh ra `JSON.parse` được
