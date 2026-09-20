# 03 — Verify + tài liệu

**Blocked by:** 02

**Status:** done

- [x] E2E VS Code thật: đặt con trỏ trên `res.data` → chạy lệnh → logpoint `data = {res.data}` ở **đầu dòng**;
      chạy lại → mất; con trỏ trên vế trái của câu gán → logpoint ở **sau câu lệnh**; con trỏ trên `load()` → không có
      logpoint nào được tạo
- [x] Kiểm phím tắt không trùng: `Cmd+Alt+L` trong VS Code sạch (ghi lại kết quả kiểm)
- [x] `README.md` + `README.en.md`: ba chỗ bấm (lens, chuột phải, phím tắt) trong một đoạn
- [x] `examples/log-at-runtime/README.md`: thêm bước dùng phím tắt cho một biến cục bộ
- [x] `docs/kien-truc.md` + `docs/architecture.md` mục 5.3.5: thêm phần chuột phải/phím tắt, luật chọn biểu thức và vị trí, các lý do từ chối
- [x] Cập nhật "Trạng thái" trong `spec.md`

## Comments

**2026-09-20 — done.** E2E VS Code 1.138 thật (+2, tổng 14/14): log biến cục bộ dưới con trỏ (đặt ở đầu dòng),
bấm lại thì gỡ, vế trái của câu gán thì đặt sau câu lệnh, bôi đen thắng con trỏ, và trỏ vào `load()` thì **không**
tạo logpoint nào mà hiện thông báo nêu lý do. Test thứ hai kiểm chính `package.json`: phím tắt gắn đúng lệnh,
`cmd+alt+l` cho macOS, chỉ trong file JavaScript.

**Phím tắt:** `Cmd+Alt+L` không trùng phím mặc định nào của VS Code (kiểm trong bản sạch của e2e — không có lệnh
nào khác nhận nó). Extension khác có thể trùng; đổi được trong Keyboard Shortcuts.

Tài liệu: README (cả hai bản) có bảng **ba cách đặt logpoint**; demo thêm bước 7b dùng phím tắt cho một biến
cục bộ và thử ca bị từ chối; kiến trúc mục 5.3.5 thêm phần chuột phải/phím tắt, luật chọn biểu thức, luật vị trí
và các lý do từ chối.

Đơn vị: 500/505 (5 lỗi smart-city có sẵn). Đóng gói lại `0.5.0.vsix`.
