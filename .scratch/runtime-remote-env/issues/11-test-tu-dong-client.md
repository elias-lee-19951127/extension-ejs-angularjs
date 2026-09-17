# 11 — Test tự động cho client VSCode

**What to build:** Trả nợ verify tay (ticket 09 của `.scratch/inline-runtime-log/`) bằng test thay
vì bấm tay. Hiện `packages/vscode-client` chỉ có test thuần, nên decoration, status bar và panel
chưa từng được test — đó là lý do mỗi lần publish lại tích thêm nợ.

**Blocked by:** 09 — hình dạng UI chốt ở đó; làm sớm hơn sẽ phải viết lại test.

**Status:** done — chỉ còn chờ lần chạy CI đầu tiên (xem Comments)

- [x] Dựng seam chạy VS Code thật (`@vscode/test-electron`) cho `packages/vscode-client`
- [x] Test: connect → decoration hiện đúng dòng trong file thật, với server giả hoặc runtime giả
- [x] Test: nhiều kết nối cùng lúc → panel và status bar đếm đúng, disconnect đúng cái đã chọn
- [x] Test: danh sách kiểm tra phản ánh đúng các bước hỏng (mapping thiếu, Stale File, bỏ hết frame)
- [ ] Chạy được trên CI macOS và Linux; thời gian chạy được ghi lại để biết CI nặng thêm bao nhiêu
- [x] Cập nhật ticket 09 của feature cũ: mục nào đã chuyển thành test tự động thì đánh dấu, phần
      còn lại (mở trình duyệt, nhìn tận mắt) giữ nguyên là việc tay

## Comments

**2026-09-17, agent:** Xong 5/6 mục; mục CI đã có workflow nhưng **chưa chạy lần nào** (cần push).

- **Seam:** `npm run test:e2e -w packages/vscode-client` → build → `test-e2e/run.js` gọi
  `@vscode/test-electron` (devDependency mới, `3.1.0`), mở **VS Code stable thật** (tải về
  `packages/vscode-client/.vscode-test/`, đã thêm vào `.gitignore` và `.vscodeignore`) trên một bản
  copy của `test-e2e/fixture/` trong thư mục tạm. Extension thật + language server bundle thật
  (`dist/server.js`) + **runtime CDP giả** (HTTP `/json/list` + WebSocket, có cả domain `Debugger`).
  Không kéo mocha: `test-e2e/suite/index.js` là runner tuần tự ~50 dòng, in `ok`/`not ok` từng ca.
  Không nằm trong `npm test` ở gốc (cần tải VS Code và mở cửa sổ).
- **Cửa sổ quan sát cho test:** VS Code không có API đọc lại decoration, text status bar hay nội
  dung webview. `activate` giờ trả về `EjsngTestApi` (decoration đã đưa vào `setDecorations` theo
  từng file, text status bar, message `status` cuối cùng gửi tới panel, checklist, khoá kết nối) —
  **chỉ khi `EJSNG_EXTENSION_TEST=1`**, runner tự đặt biến này; bản publish không export gì. Panel
  chỉ ghi lại message khi webview đã thật sự được mở.
- **Lái như người dùng:** kết nối qua đúng lệnh `EJS/NG: Connect to Runtime` (stub ô nhập
  `host:port`), ngắt qua `EJS/NG: Disconnect Runtime` (stub Quick Pick chọn đúng khoá), mở panel
  bằng lệnh của view container. `run.js` đặt một `docker` rỗng lên đầu PATH: nếu không, trên máy dev
  có container Node thật, bước dò Docker của Connect sẽ gắn test vào container thật.
- **Mapping lấy từ settings thật:** fixture có `.vscode/settings.json` khai
  `/srv/app -> ${workspaceFolder}`, mọi log đều đến từ đường dẫn kiểu container.
- **5 ca:**
  1. Mở workspace không kết nối gì: status bar `off`, checklist 6 bước `pending`.
  2. Connect → log vẽ ở **cuối đúng dòng** của file thật (`[{line: 1, text: '  » hello'}]`),
     status bar `received 1 / drawn 1 / dropped 0`.
  3. Hai log cùng dòng → giá trị sau thắng; file mở **sau khi** có log vẫn được vẽ khi mở.
  4. Hai kết nối cùng lúc → status bar và panel (`count`, bước Logs, bước Node) đếm đúng;
     Disconnect chọn A → chỉ socket của A đóng, B còn sống, số đếm giảm đúng.
  5. Checklist nêu đúng chỗ hỏng: log từ đường dẫn không mapping (`no-path-mapping`), **Stale
     File** (sửa và lưu trong editor sau khi runtime nạp, không restart), và log mà mọi frame bị bỏ
     (`node:internal/...`) → bước Logs `fail` với đủ 3 nhóm lý do, bước Path Mapping `fail` kèm nút
     khai mapping, file stale **không** được vẽ, panel nhận cùng checklist.
- **Test bắt được lỗi thật:** cố ý vẽ decoration lên dòng 0 và cho Disconnect xoá mọi kết nối →
  4/5 ca đỏ; trả code về thì 5/5 xanh.
- **Một phát hiện khi viết ca 5:** nếu file đang mở trong editor mà bị sửa **ngoài** VS Code, log
  gửi tới trước khi VS Code nạp lại file vẫn được vẽ — server so với nội dung editor (bản cũ, trùng
  với runtime). Khi người dùng sửa **trong** editor thì phát hiện Stale File đúng, nên test dùng
  đúng thao tác đó. Khe hở này chỉ tồn tại trong vài trăm ms trước khi editor nạp lại; ghi lại ở
  đây, không sửa trong ticket này.
- **Thời gian (macOS arm64, máy dev):** 5 ca chạy **16.5 s**; cả lượt VS Code (khởi động + chạy +
  tắt) **19.4 s** khi đã có bản VS Code trong cache; `npm run test:e2e` gồm cả build ~21 s. Lần đầu
  có tải VS Code (~150 MB) mất khoảng 50 s (con số đó còn lẫn một ca timeout 15 s lúc đang gỡ lỗi,
  nên thời gian tải thực tế ngắn hơn). `npm test` ở gốc vẫn 355 test, 350 pass (5 fail là
  `smart-city`, repo đó chỉ có trên máy này — trên CI các ca này tự skip).
- **CI:** `.github/workflows/ci.yml` — ma trận `ubuntu-latest` + `macos-latest`, Node 20:
  `npm ci` → `npm test` → cache `.vscode-test` → `test:e2e` (Linux bọc `xvfb-run -a`).

- [ ] Push lên GitHub, xác nhận workflow xanh trên cả hai OS và ghi lại thời gian job thật (chưa chạy
      được từ phiên này). Điểm có thể vấp: `lsof` trên runner Ubuntu (test auto-enable của server),
      và Electron cần `xvfb` — `ubuntu-latest` có sẵn cả hai theo tài liệu runner, nhưng chưa kiểm.
