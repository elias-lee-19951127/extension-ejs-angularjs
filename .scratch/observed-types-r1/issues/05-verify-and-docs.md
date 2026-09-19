# 05 — Verify trên app thật + tài liệu

**What to build:** Kiểm R1 chạy thật với Chrome + app Angular, sửa số đo nếu Chrome khác Node, và ghi
tính năng vào tài liệu (bản Việt chính, bản Anh đi kèm — CLAUDE.md).

**Blocked by:** 04

**Status:** done — còn verify tay hover trong VS Code thật

- [x] Đo lại trên Chrome thật: giới hạn preview object/mảng, có `valuePreview` lồng không; ghi vào "Số liệu đo" của spec
- [ ] Trên `smart-city` (VS Code): logpoint `{vm.rows}` và `console.log($scope.x)` → hover có kiểu runtime; số lệnh
      `getProperties` thực tế mỗi log
- [x] `CONTEXT.md` + `CONTEXT.en.md`: Bằng chứng kiểu runtime (nguồn, vòng đời theo kết nối, không lưu giá trị)
- [x] `README.md` + `README.en.md`: đoạn ngắn "log một biến scope → hover có kiểu thật"
- [x] `docs/kien-truc.md` + `docs/architecture.md` mục 5.3.1: sửa câu R1 "gần như miễn phí", thêm số đo và luật object "mở"
- [x] Cập nhật "Trạng thái" trong `spec.md`

## Comments

**2026-09-20 — done, trừ verify tay.** Chrome 153 headless (profile tạm): preview object 5 key, mảng 100,
object lồng / phần tử mảng không có key, getter không chạy, `getProperties` mảng 150 phần tử 3.8 ms —
giống hệt Node, ghi vào "Số liệu đo" của spec. DOM node hiện theo tên class.

`smart-city`: 288 `console.*`, 8 trong controller, **0** log biến scope → R1 trên repo này chỉ có tác
dụng qua logpoint dev tự đặt. Ghi vào spec, `docs/kien-truc.md` / `docs/architecture.md` mục **5.3.2**
(mục mới, không nhồi vào 5.3.1), README cũng nói "đặt một logpoint" là cách dùng chính.

Tài liệu: CONTEXT (sửa mục Type Evidence, thêm **Object mở**), README (đoạn "Kiểu thấy lúc chạy"),
kiến trúc 5.3.1 (dòng R1 trong bảng lộ trình) + 5.3.2.

**Chưa làm (cần người dùng):** trong VS Code thật với `smart-city` — nối Runtime Log vào Chrome, đặt logpoint
`{vm.rows}` (hoặc biến tương tự) trong controller, xem hover trong template có kiểu + dòng *Seen at runtime*
và thanh trạng thái có `N types seen`. Mọi phần khác đã có test đầu-cuối với `node --inspect` thật.
