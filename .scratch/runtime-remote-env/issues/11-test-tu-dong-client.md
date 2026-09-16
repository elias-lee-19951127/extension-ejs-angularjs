# 11 — Test tự động cho client VSCode

**What to build:** Trả nợ verify tay (ticket 09 của `.scratch/inline-runtime-log/`) bằng test thay
vì bấm tay. Hiện `packages/vscode-client` chỉ có test thuần, nên decoration, status bar và panel
chưa từng được test — đó là lý do mỗi lần publish lại tích thêm nợ.

**Blocked by:** 09 — hình dạng UI chốt ở đó; làm sớm hơn sẽ phải viết lại test.

**Status:** ready-for-agent

- [ ] Dựng seam chạy VS Code thật (`@vscode/test-electron`) cho `packages/vscode-client`
- [ ] Test: connect → decoration hiện đúng dòng trong file thật, với server giả hoặc runtime giả
- [ ] Test: nhiều kết nối cùng lúc → panel và status bar đếm đúng, disconnect đúng cái đã chọn
- [ ] Test: danh sách kiểm tra phản ánh đúng các bước hỏng (mapping thiếu, Stale File, bỏ hết frame)
- [ ] Chạy được trên CI macOS và Linux; thời gian chạy được ghi lại để biết CI nặng thêm bao nhiêu
- [ ] Cập nhật ticket 09 của feature cũ: mục nào đã chuyển thành test tự động thì đánh dấu, phần
      còn lại (mở trình duyệt, nhìn tận mắt) giữ nguyên là việc tay
