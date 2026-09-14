# 02b — Xác minh kết nối CDP tới trình duyệt thật (Chrome/Edge)

**What to build:** Xác nhận cơ chế multi-connection + host:port discovery đã xây ở 02a hoạt động
đúng khi target thật là một **tab Chrome/Edge** (`--remote-debugging-port`), không chỉ Node. Chỉ
hỗ trợ Chromium — không Firefox (giao thức debug khác hẳn CDP, ngoài phạm vi).

**Blocked by:** 02a — Đổi server sang multi-connection + kết nối qua host:port

**Status:** verify tay còn lại (phần script-level đã xác nhận, phần UI VSCode thật thì chưa)

- [ ] Mở Chrome/Edge với `--remote-debugging-port=<port>`, `console.log`/`warn`/`error` chạy
      trong code AngularJS 1.x phía trình duyệt hiện inline đúng dòng, dùng đúng cơ chế đã build
      ở 02a — không có code kết nối riêng cho browser, dùng lại y hệt luồng host:port → discovery
      (script-level: OK — xem Comments; còn thiếu: nhìn decoration thật trong editor)
- [ ] Khi Chrome có nhiều tab cùng mở trên port đó, Quick Pick hiện đúng danh sách tab (tiêu đề +
      URL mỗi tab) để chọn — đúng test case "nhiều target" đã xây ở 02a nhưng với dữ liệu thật
      (script-level: discovery trả đúng 2 target kèm title thật — còn thiếu: tự tay chọn qua Quick
      Pick trong VSCode)
- [ ] Kết nối server (Node) và kết nối browser (tab Chrome) chạy **đồng thời** không ảnh hưởng
      nhau — log từ cả hai nguồn cùng hiện đúng trong cùng một phiên VSCode
      (script-level: OK — xem Comments; còn thiếu: xác nhận qua status bar/decoration thật)
- [ ] Không sửa đổi pipeline map log→span gốc (seam 1-3 của v1: `offsetForLocation`,
      `parseConsoleApiCalled`, `parseRuntimeLogMessage`) — nếu browser gửi field khác Node (ví dụ
      `url` dạng khác, không phải đường dẫn file hệ thống), xử lý ở lớp resolve path, không đổi
      logic parse CDP event
      (script-level: OK — xem Comments, đã xác nhận cần cấu hình `pathMappings`, không cần code mới)

## Comments

Verify script-level ngày 2026-09-14: dựng testbed browser-side riêng
(`/Volumes/mac-dev/project/ejsng-runtime-log-browser-testbed`, không commit vào repo này — 2 trang
AngularJS 1.x thật, `page-a.html`/`page-b.html`, mỗi trang tự sinh `console.log/warn/error` qua
`?auto=1`, không cần bấm chuột). Mở Chrome thật (`open -na "Google Chrome" --args
--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-ejsng-testbed ...`), gọi thẳng
`discoverTargets`/`connectRuntimeLog`/`parseRuntimeLogMessage` từ `dist/runtime-log.js` đã build
(script ở scratchpad phiên, không phải phần code sản phẩm) — không đi qua UI VSCode.

Kết quả:
- Discovery trả đúng **2** target `type: "page"`, title "Testbed Page A"/"Testbed Page B" — noise
  (`browser_ui`, `background_page`, `service_worker`) bị lọc đúng như 02a đã TDD, giờ xác nhận với
  data thật thay vì mock.
- Kết nối đồng thời 2 tab Chrome + 1 process Node (testbed cũ, ticket 01) — 3 WebSocket cùng lúc,
  không lẫn log giữa các nguồn, đúng key.
- `parseConsoleApiCalled`/`offsetForLocation` map đúng dòng+cột cho mọi log của cả 2 trang (đối
  chiếu tay với số dòng thật trong `page-a.js`/`page-b.js`) và đúng severity (`console.warn` →
  `warning`, `console.error` → `error`) — seam 1-3 không cần sửa, đúng yêu cầu ticket.
- Rủi ro đã nêu trước khi làm (lớp resolve path ở `packages/server/src/index.ts`): xác nhận
  **đúng** — `frame.url` Chrome trả về là `http://localhost:3100/page-a.js`, không phải `file://`.
  Không cấu hình `pathMappings` → giữ nguyên chuỗi HTTP, không khớp file đĩa (decoration sẽ không
  vẽ được). Cấu hình `ejsng.runtimeLog.pathMappings` có sẵn từ ticket 11 (`remote:
  "http://localhost:3100"`, `local: "<thư mục /public>"`) → resolve đúng ra file thật trên đĩa
  (`fs.existsSync` = true). Kết luận: **không cần code mới** cho việc này, chỉ cần tài liệu hướng
  dẫn người dùng cấu hình `pathMappings` cho target browser giống hệt cách đã hướng dẫn cho Docker.

Chưa làm được (cần tay người dùng, giống lý do đã ghi ở ticket 09): thao tác qua Command Palette
thật (`EJS/NG: Connect to Runtime`, gõ `127.0.0.1:9222`), chọn Quick Pick khi có 2 target, nhìn
status bar đổi `N connected`, và nhìn decoration thật vẽ đúng dòng trong editor của Extension
Development Host — cả 4 việc này cần thao tác chuột/phím trong VSCode + Chrome thật, ngoài khả năng
tool hiện có của agent. Chrome debug (`127.0.0.1:9222`, 2 tab testbed đã mở) và 2 server testbed
(`:3100` browser, `:3000`/`:9229` Node) đang chạy sẵn — chỉ cần bấm F5 trong
`extension-ejs-angularjs` rồi làm theo
`/Volumes/mac-dev/project/ejsng-runtime-log-browser-testbed/README.md` mục 4a-4c.
