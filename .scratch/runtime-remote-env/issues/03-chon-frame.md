# 03 — Chọn frame: bỏ qua logger, file obfuscate, lọc ANSI

**What to build:** Log đi qua logger (log4js vendored trong `aocs/utility/`) hiện gắn vào dòng
`console.log` bên trong logger, không phải dòng code người dùng. Code platform lại bị obfuscate
không source map, nên dù chọn đúng frame cũng chỉ ra "dòng 1". Ticket này chọn frame đọc được đầu
tiên và làm sạch giá trị hiển thị.

**Blocked by:** 02 — cần bộ đếm lý do bỏ log để báo "bỏ hết frame".

**Status:** done

- [x] Danh sách bỏ qua mặc định: `node:internal/**`, `**/node_modules/**`, và thư mục của các
      logger phổ biến — chọn frame đầu tiên không bị bỏ
- [x] Setting `ejsng.runtimeLog.skipFrames` cho người dùng thêm pattern riêng (logger vendored,
      wrapper của team); mặc định rỗng và cộng vào danh sách mặc định, không thay thế
- [x] Nhận diện file minify/obfuscate không source map (gần như không có ký tự xuống dòng so với
      kích thước) và bỏ qua frame thuộc file đó
- [x] Bỏ hết frame thì log **không** vẽ inline, chỉ vào panel, và được đếm đúng lý do
- [x] Mã màu ANSI bị lọc khỏi giá trị trước khi hiển thị; màu theo mức log giữ nguyên như hiện tại
- [x] Panel xem được stack đã chọn và các frame đã bỏ của vài log gần nhất
- [x] Một frame gom quá nhiều log khác nhau (dấu hiệu wrapper) thì panel gợi ý bỏ qua file đó; chỉ
      ghi vào settings khi người dùng bấm

## Comments

**2026-09-16, agent:** Xong cả 7 mục. Vài quyết định đáng ghi lại:

- **Đổi shape `ParsedConsoleLog`**: `parseConsoleApiCalled` (packages/core) không còn tự chọn
  `callFrames[0]` — trả về `{callFrames, value, severity}` với TOÀN BỘ call frame (đã chuẩn hoá về
  `{url, lineNumber, columnNumber}`, bỏ `functionName`/`scriptId`… không dùng tới). Lý do: chọn
  frame giờ cần đọc nội dung file (heuristic obfuscate) và workspace/path-mapping — thứ tầng thuần
  `packages/core` không có IO để làm. `RuntimeLogMessageOutcome`'s `'log'` kind đổi theo tự động
  (cùng field `log`, chỉ shape bên trong đổi). Đã sửa lại toàn bộ test cũ của hàm này trong
  `packages/core/test/runtime-log.test.js` cho khớp shape mới — đây chính là hành vi ticket này
  thay thế, không phải hồi quy ngoài ý muốn.
- **Vòng lặp chọn frame** (`selectRuntimeLogFrame`, `packages/server/src/index.ts`): sau khi lọc
  theo pattern (`classifyFrameCandidates`, thuần, `packages/core`), đi qua từng candidate còn lại
  THEO THỨ TỰ; một frame hỏng vì BẤT KỲ lý do nào trong ba (`outside-workspace`, `unreadable-file`,
  `obfuscated`) đều KHÔNG dừng cả chuỗi — thử tiếp frame kế. Bản đầu tôi viết chỉ cho obfuscation
  đi tiếp còn outside-workspace/unreadable thì dừng ngay (để giữ y nguyên hành vi cũ); code-review
  tool phát hiện điều này trái tinh thần spec ("chọn frame đọc được đầu tiên", story #16) — đã sửa
  lại để CẢ BA đều đi tiếp, kèm test hồi quy mới (`runtime-log-frame-selection.test.js`: "a top
  frame outside the workspace does not block a later, perfectly good frame"). Lý do bỏ cuối cùng
  khi hết candidate: nếu candidate cuối cùng thử là do `outside-workspace`/`unreadable-file` thì
  giữ đúng lý do cụ thể đó (test cũ của ticket 02 — 1 frame duy nhất ngoài workspace — vẫn ra đúng
  `droppedByReason: {'outside-workspace': 1}` không đổi); nếu candidate cuối là `obfuscated`, hoặc
  danh sách candidate rỗng ngay từ đầu (mọi frame bị pattern loại hết), thì gộp vào
  `all-frames-skipped` — đúng như mục 4 của checklist.
- **Danh sách pattern mặc định**: `node:internal/**`, `**/node_modules/**`, cộng 4 thư mục logger
  phổ biến (`log4js`, `winston`, `bunyan`, `pino`) — ca `aocs/utility/log4js/` trong spec là logger
  VENDORED THẲNG vào repo (không qua `node_modules`), nên cần entry riêng. Dùng `micromatch` (thêm
  dependency thẳng cho `packages/core` — trước đó chỉ có sẵn gián tiếp qua `fast-glob`) để khớp
  glob theo string, khác với `fast-glob` (quét filesystem thật, đã dùng cho `include`/`exclude`).
- **Heuristic obfuscate** (`isLikelyMinified`): đo trung bình ký tự/dòng (`length / (newline + 1)`)
  thay vì đếm newline thô, và CHỈ áp dụng khi file đủ dài (`length >= 300`) — nếu không, mọi fixture
  test một dòng (`console.log(1);\n`, rất phổ biến trong repo này) sẽ bị nhận nhầm là obfuscate.
  Ngưỡng trung bình dòng > 200 ký tự thì coi là obfuscate; test trực tiếp trong
  `packages/core/test/runtime-log.test.js` (không cần minifier thật, dùng fixture dựng tay).
- **Lọc ANSI**: chỉ bắt CSI sequence chuẩn (`ESC [ <params> <chữ cuối>`, đúng dạng log4js layout
  dùng cho màu SGR) — đủ cho ca động lực của spec, không cố bắt mọi biến thể ANSI (OSC, …).
- **Gợi ý wrapper file**: server giữ ring buffer `recentChosenPaths` (50 gần nhất, per-connection)
  và `suggestWrapperFile` (thuần, `packages/core`) — cần ít nhất 20 mẫu và một file chiếm ≥60% mới
  gợi ý, tránh gợi ý sớm khi mới có vài log từ một script test 1-file. Panel chỉ GHI vào
  `ejsng.runtimeLog.skipFrames` khi người dùng bấm nút — pattern ghi ra là `**/<path>` với
  `path` (workspace-relative) đã escape ký tự đặc biệt của glob (`escapeGlobPath`,
  `packages/vscode-client/src/runtime-log-state.ts`) để không vỡ nếu tên file chứa `()`, `[]`, …
- **Diagnostic "stack đã chọn/đã bỏ" cho panel**: cộng thêm, KHÔNG đổi shape cũ — `ejsng/runtimeStatus`
  (request ticket 02 đã thêm) có thêm 2 field mới per-connection: `recentLogs` (5 log gần nhất, mỗi
  cái có `frames[]` kèm lý do bỏ + `chosenPath`) và `wrapperSuggestion`. Mỗi entry có `at` (epoch ms)
  để `summarizeRuntimeStatus` (vscode-client) gộp đúng theo thời gian thật khi có NHIỀU kết nối
  cùng lúc (sort theo `at` trước khi cắt còn 5 cái gần nhất) thay vì theo thứ tự Map.entries() —
  nếu không sẽ có thể giữ nhầm log CŨ của kết nối B thay vì log MỚI của kết nối A.
- **`ejsng/connectRuntime`/`connectRuntimeTarget`/`disconnectRuntime`/`runtimeLog` giữ nguyên
  shape** — không đụng, đúng hợp đồng LSP trong spec.
- **Phối hợp với ticket 04** (đang chạy song song, worktree khác): mọi thay đổi ở
  `packages/core/src/runtime-log.ts` và `packages/core/src/index.ts` (barrel) được thêm vào CUỐI
  file bằng một khối comment phân cách rõ ("Ticket 03 — frame selection"), không sắp xếp lại code
  cũ — giảm xung đột merge khi ráp với phần Docker/target-discovery của ticket 04.
- Không đụng `.scratch/runtime-remote-env/prototype-companion/` hay ticket 01 (đang
  `blocked-on-user`), đúng như yêu cầu.
- Test: `packages/core/test/runtime-log.test.js` (mở rộng, seam 2), file mới
  `packages/server/test/runtime-log-frame-selection.test.js` (seam 1, LSP end-to-end — log4js
  skip, custom skipFrames, obfuscation fallback, mọi frame bị bỏ, ANSI strip, wrapper suggestion, 2
  ca hồi quy cho việc fall-through outside-workspace/unreadable), và mở rộng
  `packages/vscode-client/test/runtime-log-state.test.js` cho các hàm format/merge mới. Không thêm
  `@vscode/test-electron` (seam của ticket 09). `npm test` ở gốc repo: 208/213 pass — 5 fail còn
  lại là fixture `smart-city` có sẵn từ trước, không liên quan runtime-log (đã xác nhận không có
  fail mới nào ngoài 5 cái này).
