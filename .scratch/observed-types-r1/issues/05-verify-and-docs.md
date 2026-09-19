# 05 — Verify trên app thật + tài liệu

**What to build:** Kiểm R1 chạy thật với Chrome + app Angular, sửa số đo nếu Chrome khác Node, và ghi
tính năng vào tài liệu (bản Việt chính, bản Anh đi kèm — CLAUDE.md).

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Đo lại trên Chrome thật: giới hạn preview object/mảng, có `valuePreview` lồng không; ghi vào "Số liệu đo" của spec
- [ ] Trên `smart-city` (VS Code): logpoint `{vm.rows}` và `console.log($scope.x)` → hover có kiểu runtime; số lệnh
      `getProperties` thực tế mỗi log
- [ ] `CONTEXT.md` + `CONTEXT.en.md`: Bằng chứng kiểu runtime (nguồn, vòng đời theo kết nối, không lưu giá trị)
- [ ] `README.md` + `README.en.md`: đoạn ngắn "log một biến scope → hover có kiểu thật"
- [ ] `docs/kien-truc.md` + `docs/architecture.md` mục 5.3.1: sửa câu R1 "gần như miễn phí", thêm số đo và luật object "mở"
- [ ] Cập nhật "Trạng thái" trong `spec.md`
