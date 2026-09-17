# 10 — Launch trình duyệt phía UI và tự kết nối

**What to build:** Nút Launch hiện `spawn` ngay trên máy chạy extension, nên với Remote-WSL nó mở
trình duyệt Linux trong WSL (hoặc lỗi), không phải Chrome trên Windows của người dùng. Ticket này
mở đúng trình duyệt phía người dùng, kèm debug port, đúng URL app, rồi tự kết nối.

Ràng buộc không đổi được: Chrome 136+ bỏ qua `--remote-debugging-port` trên profile mặc định, nên
bắt buộc profile riêng.

**Blocked by:** 04 (biết port app của container), 09 (panel là nơi đặt nút và báo kết quả).

**Status:** done

- [x] Tìm trình duyệt phía UI theo thứ tự Chrome → Edge → Brave; hỏi registry trước khi dò các
      đường dẫn cài đặt cố định; `ejsng.runtimeLog.chromeExecutablePath` khác rỗng thì thắng
- [x] Remote-WSL: chạy trình duyệt Windows qua interop, `--user-data-dir` là **đường dẫn Windows**
- [x] Profile debug riêng, **giữ lâu dài** (đăng nhập một lần là còn phiên); không bao giờ dùng
      profile thật của người dùng
- [x] Tự mở URL app suy từ port app của container; nhiều port thì hỏi một lần rồi nhớ trong
      `workspaceState`
- [x] Tự kết nối khi tab app đã load, không bắt bấm Connect lần hai
- [x] WSL NAT: vẫn mở được trình duyệt, nhưng báo ngay rằng extension chưa với tới debug port và
      chỉ ra cách chuyển mirrored
- [x] Không test tự động phần interop/mở trình duyệt; để lại checklist tay trong ticket

## Comments

**2026-09-17, agent:** Xong cả 7 mục (mục 7 = checklist tay bên dưới). Những điểm đáng ghi lại:

- **Nút "Launch browser" lên khu vực chính** của panel, ngay dưới Connect; ô debug port nằm trong
  "Advanced". Thêm lệnh `EJS/NG: Launch Browser and Connect`. Tên setting cũ
  (`chromeExecutablePath`, `chromeDebugPort`) giữ nguyên để không phá cấu hình đang có.
- **Ba đường đi**, quyết định bởi `vscode.env.remoteName` (`launchRouteFor`): local → spawn trực
  tiếp; `wsl` → chạy file `.exe` của Windows qua interop; SSH/Dev Container/Codespaces → **không
  spawn gì**, báo rõ là chưa hỗ trợ (cần extension phụ của ticket 12) và cách tự mở Chrome.
- **Tìm trình duyệt** (`browser-locator.ts` thuần + `browser-launch.ts` IO, đều ở client —
  quyết định #15): setting khác rỗng thì thắng, và nếu đường dẫn đó không tồn tại thì **báo lỗi**,
  không lặng lẽ đổi sang trình duyệt khác. Không có setting: Chrome → Edge → Brave; trên Windows,
  mỗi trình duyệt hỏi `reg.exe query "...\App Paths\<exe>" /ve` (HKCU rồi HKLM) **trước**, rồi mới
  tới Program Files / Program Files (x86) / LocalAppData. Giá trị registry được đọc theo cột
  `REG_SZ`, không theo tên `(Default)` vốn bị dịch theo ngôn ngữ Windows. macOS dò `/Applications`
  và `~/Applications`; Linux dùng `which` (Chromium tính là Chrome). Setting trong WSL nhận cả
  đường dẫn Windows `C:\...`.
- **WSL:** đường dẫn Windows đổi sang `/mnt/c/...` bằng `wslpath -u` (dự phòng bằng hàm thuần khi
  thiếu `wslpath`) để kiểm tồn tại và spawn; `cmd.exe`/`reg.exe` thử theo PATH rồi tới
  `/mnt/c/Windows/System32/`; cwd đặt ở ổ Windows để tránh lỗi UNC. `--user-data-dir` là
  `%LOCALAPPDATA%\ejsng\browser-profile` — **đường dẫn Windows**.
- **Profile riêng, giữ lâu dài:** WSL dùng thư mục trên; local giữ thư mục cũ trong global
  storage của extension (người đã đăng nhập ở bản trước không mất phiên). Không bao giờ dùng
  profile thật.
- **URL app** (`chooseAppPort`): server có request mới `ejsng/listDockerContainers` — liệt kê
  container Node kèm port app **mà không kết nối** cái nào. Port đã nhớ trong `workspaceState` (cùng
  key với Quick Pick của ticket 09) còn được container publish thì dùng luôn; chỉ có một port thì
  dùng luôn; nhiều port thì hỏi một lần rồi nhớ; không có container nào thì hỏi port/URL.
- **Tự kết nối khi tab app xuất hiện:** client hỏi request mới `ejsng/findBrowserTarget` mỗi giây
  (một lần dò mỗi request, nên hủy được và không giữ request mở trên server), rồi kết nối bằng
  `ejsng/connectRuntimeTarget` có sẵn. Tab được chọn bằng `findAppTarget` (core): tab `page` **cùng
  origin** với URL app (`localhost` ≡ `127.0.0.1`), path nào cũng được — nên khi tab đang ở trang
  Keycloak khác origin thì **chờ**, không gắn nhầm vào trang login. Chờ tối đa 3 phút (đủ để đăng
  nhập); debug port không trả lời sau 20 giây thì dừng và nói lý do. Thông báo tiến trình chỉ hiện
  origin + path của tab, bỏ query string vì redirect login có thể mang token.
  **Không** đi qua `ejsng/connectRuntime`: luồng đó khi dò hỏng sẽ `SIGUSR1` tiến trình giữ port —
  ở đây chính là trình duyệt.
- **WSL NAT:** trình duyệt vẫn mở, rồi hỏi `ejsng/detectRuntimeEnvironment`; nếu `nat` thì báo
  ngay là không với tới debug port kèm nút mở hướng dẫn mirrored, không chờ vô ích. Nếu `unknown`
  thì cứ dò, hết 20 giây không tới được thì cũng gợi ý mirrored.
- **Test:** `packages/core/test/runtime-log.test.js` (+2 ca `findAppTarget`);
  `packages/server/test/runtime-log-browser-launch-lsp.test.js` (4 ca LSP: liệt kê container không
  kết nối, không có docker, debug port không tới được, và tab đi qua trang login khác origin rồi mới
  tới app — kết nối đúng tab app); `packages/vscode-client/test/browser-locator.test.js` (14 ca
  thuần). `npm test`: 355 test, 350 pass — 5 fail còn lại là fixture `smart-city` có sẵn.
- **Chạy thử trên macOS với Chrome thật** (script ngoài repo, Chrome `--headless=new`, profile
  tạm): `locateBrowser` tìm ra `/Applications/Google Chrome.app/...`; spawn bằng đúng
  `browserLaunchArgs`; `findBrowserTarget` báo `unreachable` ~1 giây rồi `found` đúng tab app;
  `connectRuntimeTarget` kết nối, `runtimeStatus` nhận được log từ trang. Setting trỏ tới file
  không tồn tại → `configuredMissing`.

**Checklist tay (mục 7 — cần máy Windows + WSL thật):**

- [ ] Remote-WSL mirrored: bấm Launch browser → Chrome **trên Windows** mở `http://localhost:5000`
      (port của `cityos-web`), profile ở `%LOCALAPPDATA%\ejsng\browser-profile`
- [ ] Đăng nhập Keycloak xong → panel tự kết nối tab app, không phải bấm Connect; log AngularJS hiện
      đúng dòng
- [ ] Đóng Chrome, Launch lại → vẫn còn phiên đăng nhập
- [ ] Gỡ/đổi tên Chrome (hoặc thử máy không có Chrome) → rơi xuống Edge; đặt
      `chromeExecutablePath` = `C:\...\msedge.exe` → dùng đúng đường dẫn đó
- [ ] Nhiều container có port app → hỏi một lần; Launch lần sau không hỏi lại
- [ ] WSL NAT: Chrome vẫn mở, cảnh báo mirrored hiện ngay, nút mở đúng trang hướng dẫn
- [ ] Remote SSH / Dev Container: bấm Launch → chỉ có cảnh báo, không có tiến trình nào được mở
- [ ] macOS/Linux local: Launch mở trình duyệt có cửa sổ và tự kết nối (đã thử headless trên macOS,
      chưa thử bằng VS Code thật)
