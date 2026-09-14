# 13 — Panel riêng ở Activity Bar cho runtime log

**What to build:** Người dùng phải mở Command Palette gõ tên đầy đủ mỗi lần muốn
`EJS/NG: Connect to Runtime`/`Disconnect Runtime`, hoặc lục Settings để sửa `pathMappings` — thêm
1 icon riêng ở Activity Bar (leftbar) mở ra 1 panel có sẵn ô nhập host:port và nút bấm ngay trong
panel (không phải `showInputBox` popup), cộng thêm 1 nút tự mở Chrome kèm `--remote-debugging-port`
(người dùng hay phải tự gõ lệnh này tay khi verify — xem `ejsng-runtime-log-browser-testbed`, ticket
02b). Chỉ là lối tắt UI + tiện ích mở Chrome, không đổi logic kết nối/parse CDP đã có từ 01/02a.

**Blocked by:** None — độc lập với 02a/02b, chỉ là lớp UI gọi lại command/logic sẵn có.

**Status:** done — verify tay UI còn lại (giống mọi UI khác của feature này, xem ticket 09)

- [x] `contributes.viewsContainers.activitybar` + `contributes.views`: 1 container `ejsngPanel`
      (icon `media/runtime-icon.svg`, tự vẽ tay — không dùng icon có sẵn/copyrighted), 1 view
      `ejsngRuntimeView`
- [x] `RuntimeLogViewProvider` (`packages/vscode-client/src/runtime-log-view.ts`) đổi từ
      `TreeDataProvider` tĩnh sang `WebviewView` — vì cần ô `<input>` thật trong panel, TreeView
      không hỗ trợ nhập liệu. Nội dung: dòng trạng thái (`N connected`), ô host:port + nút
      **Connect**, nút **Disconnect…** (vẫn mở Quick Pick như cũ — có thể nhiều kết nối), ô port +
      nút **Launch Chrome debug**, link **Runtime Log Settings…**
- [x] Tách logic connect/disconnect ra khỏi 2 command handler cũ thành hàm dùng chung
      (`connectToRuntime`, `disconnectRuntime`, `parseHostPort` trong `extension.ts`) — Command
      Palette và ô input trong panel giờ gọi cùng 1 chỗ, không có 2 bản logic lệch nhau
- [x] Nút **Launch Chrome debug**: `child_process.spawn` thẳng executable (không qua shell — không
      dựng chuỗi lệnh từ input để tránh injection), luôn kèm `--user-data-dir` **profile riêng**
      (dưới `context.globalStorageUri`, không đụng profile Chrome thật của người dùng — debug port
      mở trên profile thật là đường vào mọi session đã đăng nhập cho ai đó chạy được tiến trình
      local, không phải rủi ro nên chấp nhận cho tiện)
- [x] 2 setting mới: `ejsng.runtimeLog.chromeExecutablePath` (rỗng = tự đoán theo OS — mac/win/linux
      có nhánh riêng, không hard-code 1 đường dẫn), `ejsng.runtimeLog.chromeDebugPort` (mặc định
      9222, dùng làm giá trị điền sẵn cho cả ô Launch lẫn ô Connect)
- [x] `updateRuntimeStatusBar()` (đã chạy mỗi khi số kết nối đổi) `postMessage` trạng thái mới sang
      webview — dòng trạng thái trong panel tự cập nhật cùng lúc với status bar
- [x] `.vscodeignore` không loại `media/**` — icon vẫn được đóng gói khi `vsce package`

## Comments

Làm theo yêu cầu người dùng ngày 2026-09-14, 2 lượt: lượt 1 dựng bản tĩnh (TreeView, chỉ gọi lại
command có sẵn), lượt 2 nâng lên webview theo yêu cầu cụ thể — "để input vào leftbar luôn" (ô
host:port ngay trong panel, không popup) + "thêm nút bật Chrome debug kèm setting của Chrome".

Build sạch (`tsc --build`), 7/7 test `vscode-client` cũ vẫn xanh. Không thêm test riêng cho phần
UI (webview HTML/JS, spawn Chrome) — không có logic thuần đáng test, hành vi kết nối/parse CDP thật
vẫn nằm nguyên ở `connectToRuntime`/server-side đã test từ 01/02a; `parseHostPort` là hàm thuần nhỏ
nhưng đã có test tương đương ở luồng command cũ, không tách thêm.

Chưa verify: bấm thử panel thật trong Extension Development Host — gõ host:port trong ô, bấm
Connect, bấm Launch Chrome debug (xem Chrome có mở đúng port, đúng profile riêng không), xem
trạng thái panel/status bar đồng bộ. Cần tay người dùng, gộp chung nhóm verify UI còn treo ở
ticket 09.

**Bug tìm thấy lúc verify tay (2026-09-14), đã sửa:** đổi provider sang `registerWebviewViewProvider`
ở lượt 2 nhưng quên đổi khai báo view trong `package.json` — mặc định (không ghi `type`) VSCode
hiểu 1 view là TreeView, đợi `registerTreeDataProvider`, nên báo "There is no data provider
registered that can provide view data." dù code phía extension host chạy đúng. Fix: thêm
`"type": "webview"` vào entry `ejsngRuntimeView`. Bài học: đổi loại view (TreeView ↔ WebviewView)
phải sửa cả 2 phía — provider trong code VÀ khai báo `type` trong `package.json` — thiếu 1 bên là
lỗi im lặng, TypeScript không bắt được vì `package.json` không qua `tsc`.
