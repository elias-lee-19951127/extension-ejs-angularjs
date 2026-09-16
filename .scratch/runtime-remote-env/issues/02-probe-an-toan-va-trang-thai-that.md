# 02 — Probe an toàn, đường dẫn thật, và nói thật trạng thái

**What to build:** Ba chỗ đang nói dối hoặc âm thầm hỏng, gộp lại vì cùng đụng một luồng:

1. Kết nối tới host không phải `localhost` luôn hỏng — mọi probe phải gửi header `Host: localhost`
   (Chrome và Node inspector từ chối header `Host` không phải IP/localhost để chống DNS rebinding),
   và ws URL runtime trả về phải được viết lại theo host:port thật đã dùng để tới nó.
2. Workspace root nằm sau symlink thì mọi log bị coi là "ngoài workspace" (ticket 12 của
   `.scratch/inline-runtime-log/`, chuyển hẳn về đây).
3. Panel báo `connected` ngay khi tạo socket chứ không đợi mở xong (ticket 06 cũ), và mọi log bị bỏ
   đều bỏ im lặng.

Xong ticket này, người dùng kết nối `cityos-web` sẽ thấy ngay "nhận 120 / vẽ 0 / bỏ 86 — ngoài
mapping", tức tự chẩn đoán được ca đã tốn cả phiên grill để tìm ra.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Prefactor trước: chuyển các hàm thuần của runtime-log (parse, format, so khớp) xuống
      `packages/core`, giữ adapter IO ở `packages/server` — các ticket sau có chỗ đặt logic thuần
- [x] Probe discovery gửi `Host: localhost`; kết nối được tới một endpoint qua hostname không phải
      localhost (test dựng endpoint giả buộc kiểm tra header)
- [x] ws URL được viết lại theo host:port đã dùng để tới, không dùng nguyên chuỗi runtime trả về
- [x] Root và Runtime Path đều được resolve symlink trước khi so; file không tồn tại thì coi như
      không resolve được, không throw
- [x] Trạng thái `connected` chỉ báo khi WebSocket mở thật; trước đó là `connecting`, hỏng thì là
      `failed` kèm lý do
- [x] Server giữ, cho mỗi kết nối: số log nhận, số vẽ, số bỏ **theo từng lý do**; client hỏi được
      con số này qua LSP
- [x] Status bar và panel hiện `nhận / vẽ / bỏ` thay vì chỉ `N connected`
- [x] Các request LSP cũ (`ejsng/connectRuntime`, `connectRuntimeTarget`, `disconnectRuntime`) giữ
      nguyên shape — không phá client IntelliJ tương lai

## Comments

**2026-09-16, agent:** Xong cả 3 bug + prefactor. Vài quyết định đáng ghi lại:

- **Prefactor**: các hàm thuần của runtime-log (`parseConsoleApiCalled`, `parseRuntimeLogMessage`,
  `filterConnectableTargets`, `mapContainerPath`, `offsetForLocation`) chuyển xuống
  `packages/core/src/runtime-log.ts`; adapter IO (`connectRuntimeLog`, `discoverTargets`,
  `findPidListeningOnPort`, `waitForTargets`) ở lại `packages/server/src/runtime-log.ts`, giờ chỉ
  còn wiring. `parseRuntimeLogMessage` đổi từ `ParsedConsoleLog | null` sang outcome
  `{kind: 'log'|'unanchored'|'ignored'}` để đếm được lý do bỏ log không có stack trace
  (`no-stack-trace`) — trước đây loại log này biến mất im lặng trước cả khi tới `onLog`.
- **Symlink (mục 2)**: sửa sâu ở `Workspace.toRelative` (`packages/core`), đúng như ticket 12 cũ
  gợi ý — vì `refreshFiles` và luồng runtime-log trong `packages/server/src/index.ts` đều gọi
  chung `rel(uri)` → `workspace.toRelative`, một chỗ sửa fix cả hai. Cache `resolvedRoot` một lần
  lúc khởi tạo; `absPath` resolve mỗi lần gọi (input từ ngoài). **Bẫy phát hiện khi viết test**:
  nếu `absPath` không resolve được (ví dụ file vừa bị xoá — refreshFiles gọi `toRelative` cho cả
  sự kiện delete), so nó với `resolvedRoot` (đã resolve) ra sai lệch giả — phải fallback về so với
  `config.root` (chưa resolve) trong đúng trường hợp đó. Không có fallback này thì 2 test cũ trong
  `packages/server/test/lsp.test.js` (xoá file, xoá thư mục) hỏng ngay trên máy có `tmpdir()` nằm
  sau symlink (macOS) — đã thêm test hồi quy riêng cho đúng ca này trong
  `packages/core/test/workspace-symlink.test.js`.
- **ws URL rewrite (mục 1)**: rewrite theo host:port ĐÃ DÙNG để tới discovery (không phải
  host:port runtime tự báo) — áp dụng ngay trong `discoverTargets`, nên mọi caller (connect trực
  tiếp, auto-enable qua SIGUSR1) đều tự động đúng. Hệ quả phụ: các test cũ mô phỏng discovery +
  CDP endpoint là 2 server riêng port khác nhau không còn đúng thực tế (`node --inspect`/Chrome
  luôn phục vụ cả hai từ CÙNG một port) — đã gộp lại thành 1 server dùng chung trong
  `runtime-log-connections-lsp.test.js` và `runtime-log-path-mapping.test.js`.
- **Trạng thái thật + đếm (mục 4)**: `ejsng/connectRuntime`/`connectRuntimeTarget` GIỮ NGUYÊN trả
  lời `'connected'` ngay khi tìm thấy target (để không phá shape cũ — mục 5); trạng thái thật
  (`connecting`→`connected`/`failed` kèm lý do) và số đếm nhận/vẽ/bỏ-theo-lý-do chỉ lộ ra qua 2
  cái MỚI, thuần cộng thêm: request `ejsng/runtimeStatus` (client hỏi bất cứ lúc nào) và
  notification `ejsng/runtimeStatusChanged` (server đẩy mỗi khi một kết nối đổi trạng thái, để
  client không phải chờ tick polling mới biết kết nối thật sự sống hay đã hỏng). vscode-client
  vừa nghe notification này vừa poll `ejsng/runtimeStatus` mỗi 2s khi có kết nối (giữ số liên tục
  cập nhật) — status bar/panel đổi từ `N connected` sang `received X / drawn Y / dropped Z`.
- Không đụng `.scratch/runtime-remote-env/prototype-companion/` hay ticket 01 (đang
  `blocked-on-user`), đúng như yêu cầu.
