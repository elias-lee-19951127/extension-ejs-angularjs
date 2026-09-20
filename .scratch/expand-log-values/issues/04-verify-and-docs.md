# 04 — Verify + tài liệu

**What to build:** Kiểm trên demo và app thật, rồi ghi vào tài liệu (bản Việt chính, bản Anh đi kèm).

**Blocked by:** 03

**Status:** done — còn verify tay trong VS Code thật

- [x] `examples/log-at-runtime`: thêm một bước "xem giá trị đầy đủ" vào README; giá trị demo đủ sâu để thấy khác biệt
- [x] Đo lại trên Chrome thật với app Angular: inline có key thật, số lệnh `getProperties` mỗi giây khi log liên tục
- [x] `README.md` + `README.en.md`: dòng setting `ejsng.runtimeLog.expandValues`, một đoạn ngắn về inline/hover/tab JSON
- [x] `docs/kien-truc.md` + `docs/architecture.md`: mục mới cho việc trải giá trị log (bảng đo, vì sao đào theo tầng, chặn tần suất, vòng lặp tham chiếu)
- [x] `CONTEXT.md` + `CONTEXT.en.md`: nếu có thuật ngữ mới
- [x] Cập nhật "Trạng thái" trong `spec.md`

## Comments

**2026-09-20 — done, trừ verify tay.**

**Đo trên Chrome 153 thật** (trang log một mảng 150 object mỗi 30 ms, 5 giây, qua server thật):

| | Bật trải ra | Tắt |
|---|---|---|
| App chạy được | 33.4 vòng/giây | 33.4 vòng/giây |
| Log được vẽ | 167 | 167 |
| Lần đào | 16 (đúng 1 lần / 300 ms) | 0 |

Tức là việc đào **không làm app chậm đi ở mức đo được**, và không log nào bị bỏ. Inline ra
`rows [{id: 0, title: 'Sensor 0', owner: {…}, tags: […]}, …+149] 159`.

Demo `examples/log-at-runtime`: thêm `console.log('rows', $scope.rows)` (cũng thành bằng chứng kiểu cho R1) và
ba bước 8–10 trong README. Đổi dữ liệu giả từ "theo đồng hồ" sang "theo lần gọi" — lúc kiểm bị rơi đúng nhịp mảng
rỗng ba lần liền, khó hiểu cho người thử. Đã chạy lại demo đầu-cuối: `rows [Object]` → inline/hover trải ra, và
`ejsng/expandRuntimeLog` trả JSON parse được.

Tài liệu: README (cả hai bản, kèm dòng setting), kiến trúc mục mới **5.3.4** (ba mức hiển thị, vì sao gửi
notification thứ hai, số đo Chrome, vì sao tab JSON thay vì cây tự viết, getter/vòng lặp/chuỗi, chuyện V8 phát lại
console entry không kèm preview). CONTEXT: không thêm thuật ngữ mới — "trải giá trị log" là cách hiển thị, không
phải khái niệm domain.

**Còn lại cho người dùng:** mở demo trong VS Code thật, hover dòng `console.log` và bấm **Show full value** bằng
chuột (e2e đã phủ phần còn lại: inline, hover, mở tab, gập được).
