# 03 — Verify + tài liệu

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] E2E VS Code thật: đặt con trỏ trên `res.data` → chạy lệnh → logpoint `data = {res.data}` ở **đầu dòng**;
      chạy lại → mất; con trỏ trên vế trái của câu gán → logpoint ở **sau câu lệnh**; con trỏ trên `load()` → không có
      logpoint nào được tạo
- [ ] Kiểm phím tắt không trùng: `Cmd+Alt+L` trong VS Code sạch (ghi lại kết quả kiểm)
- [ ] `README.md` + `README.en.md`: ba chỗ bấm (lens, chuột phải, phím tắt) trong một đoạn
- [ ] `examples/log-at-runtime/README.md`: thêm bước dùng phím tắt cho một biến cục bộ
- [ ] `docs/kien-truc.md` + `docs/architecture.md` mục 5.3.5: thêm phần chuột phải/phím tắt, luật chọn biểu thức và vị trí, các lý do từ chối
- [ ] Cập nhật "Trạng thái" trong `spec.md`
