# 06 — Kiểm tra nội dung: Stale File và Shadowed File

**What to build:** Khớp đường dẫn không đảm bảo khớp nội dung. Ba ca thật: file đã sửa mà runtime
chưa nạp lại (**Stale File**), file trong workspace bị mount khác che nên runtime chạy bản khác
(**Shadowed File**), và mapping tự khai trỏ nhầm. Cả ba đều khiến log vẽ **sai dòng mà trông như
đúng** — tệ hơn không vẽ. Ticket này bắt vẽ inline phải có điều kiện: nội dung khớp.

**Blocked by:** 05 — cần mapping ra file trên đĩa trước khi so nội dung.

**Status:** done

- [x] Bắt đầu bằng thí nghiệm với Node thật: metadata script V8 báo về (độ dài, dòng cuối) có khớp
      file trên đĩa không, kể cả với CommonJS. Kết quả quyết định cách so sánh; **ghi vào ticket**
      trước khi viết tiếp — xem "Kết quả thí nghiệm" bên dưới
- [x] Bật domain `Debugger` chỉ để nhận sự kiện: không đặt breakpoint, không pause runtime
- [x] Nội dung khớp → vẽ inline như hiện tại
- [x] Lệch và file trên đĩa mới hơn lúc runtime nạp → không vẽ, báo **Stale File** kèm gợi ý restart
- [x] Lệch kiểu khác → không vẽ, báo nghi **Shadowed File** hoặc mapping sai; nếu biết mount thì
      chỉ ra đường dẫn bản runtime đang chạy
- [x] Mọi trường hợp không vẽ đều vào bộ đếm lý do của ticket 02
- [x] Chi phí bật `Debugger` với dự án vài nghìn file được đo và ghi lại; nếu nặng thì giới hạn
      phạm vi script quan tâm

## Kết quả thí nghiệm (item 1)

**2026-09-17, agent.** Chạy `node --inspect` thật (Node v20.20.0, macOS), bật domain `Debugger`,
thu `Debugger.scriptParsed` rồi đối chiếu từng field với file trên đĩa. Script thí nghiệm dựng
trong scratchpad, không commit vào repo (code vứt đi, giống ticket 01).

Fixture cố tình lệch nhau về hình dạng: có/không newline cuối, CRLF, BOM, shebang, CommonJS được
`require()`, và một file ESM.

| File | `endLine` | `endColumn` | `length` | Dòng cuối trên đĩa (index / độ dài) | Độ dài trên đĩa | `getScriptSource` === đĩa |
| --- | --- | --- | --- | --- | --- | --- |
| `entry.js` (CJS, entry) | 7 | 0 | 193 | 7 / 0 | 193 | có |
| `plain.js` (CJS, require) | 2 | 0 | 38 | 2 / 0 | 38 | có |
| `no-trailing-newline.js` | 0 | 35 | 35 | 0 / 35 | 35 | có |
| `crlf.js` | 2 | 0 | 39 | 2 / 0 | 39 | có |
| `bom.js` | 1 | 0 | 21 | 1 / 0 | 21 | có |
| `shebang.js` | 2 | 0 | 44 | 2 / 0 | 44 | có |
| `esm.mjs` | 2 | 0 | 40 | 2 / 0 | 40 | có |

**Ba kết luận quyết định cách so sánh:**

1. **Không có wrapper CommonJS nào lọt vào.** Đây là điều đáng lo nhất trước khi đo: Node cũ bọc
   module trong `(function (exports, require, module, __filename, __dirname) { … })`, nếu wrapper
   đó tính vào `length`/`endColumn` thì mọi so sánh đều lệch một lượng cố định và phải trừ bù theo
   phiên bản Node. Node hiện đại biên dịch CJS bằng `compileFunction`, nên `getScriptSource` trả về
   **đúng từng byte** nội dung file, và `length` bằng đúng độ dài file. Không cần trừ bù gì cả.
2. **`length` + `endLine` + `endColumn` là đủ cho phép so sánh rẻ.** Cả ba khớp chính xác với
   `source.length`, `split('\n').length - 1`, và độ dài dòng cuối — kể cả với BOM (tính vào độ
   dài), CRLF (`\r` tính vào cột của dòng trước), shebang (không bị cắt), và file không có newline
   cuối. Nghĩa là **không cần round-trip nào** để kiểm tra ca thường: metadata đã có sẵn trong
   `scriptParsed`, so với file mà `selectRuntimeLogFrame` dù sao cũng đã đọc rồi.
3. **`Debugger.getScriptSource` là oracle chính xác, để dành cho ca lệch.** Chỉ gọi khi metadata đã
   lệch — lúc đó mới cần biết runtime *đang thật sự chạy nội dung gì* để phân biệt Shadowed File
   với Stale File. Không dùng `hash`: V8 tự tính theo thuật toán riêng, tái hiện phía client là
   phụ thuộc phiên bản một cách không cần thiết khi đã có ba field trên.

**Chi phí bật `Debugger` (item 7)** — dự án sinh tự động, mỗi module ~40 dòng, bật domain SAU khi
app đã nạp xong (đúng hình dạng thật: người dùng bấm Connect vào app đang chạy):

| Số module | `Debugger.enable` trả về | Backlog `scriptParsed` chảy hết | Số sự kiện | Kích thước |
| --- | --- | --- | --- | --- |
| 3.000 | 112 ms | 112 ms | 3.092 | 1,8 MB |
| 10.000 | 246 ms | 246 ms | 10.091 | 5,9 MB |

Tuyến tính, một lần duy nhất lúc Connect, và ở mức 10.000 module vẫn dưới 1/4 giây. **Không cần
giới hạn phạm vi script quan tâm** — mục 7 của checklist đóng ở đây, chỉ cần giữ metadata (không
giữ source) để bộ nhớ không phình theo kích thước code.

**Ghi nhận phụ, không thuộc ticket này:** Node 20 quảng cáo `webSocketDebuggerUrl` là
`ws://localhost/<id>` — **không có port**. Nối thẳng vào chuỗi đó là ra port 80. Đây đúng là ca
ticket 02 đã viết `rewriteWebSocketUrl` để xử lý; thí nghiệm này xác nhận nó không phải phòng xa
mà là đường đi bắt buộc trên Node hiện tại.

## Comments

**2026-09-17, agent:** Xong cả 7 mục. Các quyết định đáng ghi lại:

- **Hai tầng kiểm, theo thứ tự chi phí.** Tầng rẻ là `sourceMatchesScript` (thuần, `packages/core`):
  so `length` + `endLine` + `endColumn` của `Debugger.scriptParsed` với file mà bước chọn frame dù
  sao cũng đã đọc — **không round-trip nào**. Tầng chính xác là `Debugger.getScriptSource`, chỉ gọi
  khi tầng rẻ đã PASS, để bắt ca metadata không nhìn thấy: sửa đổi byte mà không đổi độ dài lẫn cấu
  trúc dòng (đổi tên biến sang tên khác cùng độ dài). Kết quả cache theo `scriptId` + đường dẫn
  host, nên tốn một round-trip mỗi *script*, không phải mỗi *log*. Ban đầu tôi định chỉ dùng
  metadata cho gọn — nhưng ca cùng độ dài chính là ca "mapping tự khai trỏ nhầm" mà ticket muốn
  chặn, và nó vẽ *sai dòng mà trông như đúng*, đúng thứ tệ nhất. Có test riêng cho ca này.
- **Shadowed File được CHỨNG MINH, không đoán.** `candidateHostPaths` (thuần) trả về *mọi* đường dẫn
  host mà các mapping phủ lên Runtime Path, không chỉ cái đầu tiên `mapContainerPath` chọn. Khi lệch,
  server đọc các ứng viên còn lại và tìm cái khớp metadata — với mount lồng nhau đó chính là bản
  runtime đang thật sự chạy, nên panel **nêu tên file** thay vì nói chung chung. Đây là lý do mục 4
  ("nếu biết mount thì chỉ ra đường dẫn bản runtime đang chạy") làm được mà không cần heuristic nào.
  Chỉ đọc file nằm dưới phía host của một mapping — Runtime Path do một tiến trình mạng gửi tới,
  không được phép lái lệnh đọc đi chỗ khác (cùng quy tắc ticket 08 sẽ dựng).
- **Cách định ngày "lúc runtime nạp".** CDP không nói script được nạp lúc nào. Mốc dùng là
  `openedAt` — thời điểm kết nối mở: mọi thứ runtime đã biên dịch trước đó đều được nạp trước mốc
  này. File lệch **và** mtime mới hơn mốc → **Stale File** chắc chắn, gợi ý restart. Lệch mà sửa từ
  trước khi kết nối thì không định ngày được bằng cách này, và rơi vào `content-mismatch` — báo cả
  hai cách sửa (mapping sai / restart) thay vì đoán bừa một cái. Đã cân nhắc lấy `State.StartedAt`
  của container để có mốc chính xác hơn, nhưng để lại: nó chỉ giúp ca Docker, mà ca Docker phần lớn
  đã được nhánh Shadowed bắt trước rồi.
- **Không verify được thì VẼ, không im lặng.** Frame không có `scriptId`, không có metadata cho
  script đó, hoặc runtime không trả lời `getScriptSource` (socket đóng, timeout 2s) → coi như khớp
  và vẽ như trước ticket này. Trình duyệt và mọi target không gửi `scriptParsed` phải chạy y như cũ;
  một request không có hồi âm không được phép nuốt log. Có test riêng cho ca này.
- **`onLog` thành bất đồng bộ, và phải giữ thứ tự.** Vì có round-trip, mỗi log được nối vào
  `info.queue` (promise chain per-connection) thay vì chạy song song — nếu không, hai log đua nhau
  ở điểm `await` có thể khiến giá trị CŨ của một dòng tới client SAU giá trị mới. Có test 10 log
  liên tiếp kiểm đúng thứ tự.
- **Chỉ bật `Debugger` để nghe** (mục 2): adapter gửi `Debugger.enable` ngay sau `Runtime.enable`,
  và không bao giờ gửi `setBreakpoint`/`pause`/`resume`. Target chạy y như không có debugger.
  `parseRuntimeLogMessage` có thêm 2 kind: `'script'` (metadata) và `'reply'` (hồi âm JSON-RPC theo
  `id`) — trước đây hồi âm rơi vào `'ignored'` vì chưa có ai gửi request bao giờ. Chỉ giữ metadata,
  **không giữ source**, để bộ nhớ không phình theo kích thước code người dùng.
- **`CallFrame.scriptId` là optional**, không bắt buộc: không phải CDP peer nào cũng gửi, và biến nó
  thành bắt buộc sẽ khiến `isCallFrame` từ chối những event hoàn toàn hợp lệ. Thiếu nó chỉ có nghĩa
  "không verify được", xử lý như trên.
- **Lý do bỏ mới**: `stale-file`, `shadowed-file`, `content-mismatch` — đều vào `droppedByReason`
  của ticket 02 (mục 6) và vào `skipReason` của frame trong `recentLogs`, kèm `runtimePath` cho ca
  shadowed. `formatSkipReason` phía panel nói thẳng cách sửa từng ca.
- **Verification chạy SAU khi chọn frame, không lồng vào vòng lặp chọn.** Tức là một frame lệch nội
  dung không làm vòng lặp thử tiếp frame dưới (khác với `outside-workspace`/`obfuscated` của ticket
  03). Cố ý: đưa round-trip vào trong vòng lặp sẽ biến mỗi log thành nhiều round-trip, trong khi
  frame dưới gần như chắc chắn cũng thuộc cùng một bản lệch. Nếu thực tế cho thấy cần, đây là chỗ
  để nới.
- **Test**: `packages/core/test/runtime-log.test.js` (so khớp metadata với hằng số **đo được từ
  Node thật**, `candidateHostPaths`, 2 kind mới của `parseRuntimeLogMessage`), và file mới
  `packages/server/test/runtime-log-content-verification.test.js` — fake runtime ở đây nói cả nửa
  `Debugger` của CDP và **tự suy metadata từ source**, nên test chỉ khai "runtime đang chạy nội dung
  gì", không tay tính `endLine`/`length`. Đã kiểm chứng bằng cách vô hiệu hoá verification: 3 test
  (stale, shadowed, cùng-độ-dài) đỏ ngay, 3 test còn lại xanh.
- **Bẫy đã gặp khi viết test**, ghi lại vì dễ lặp: (1) gửi log ngay khi socket mở thì đua với
  `scriptParsed` — fake phải báo sẵn sàng *sau* khi đã đẩy metadata; (2) `received` tăng đồng bộ còn
  verdict ghi sau `await`, nên poll theo `received > 0` sẽ đọc counter đúng vào khe giữa hai thứ.
  Đã sửa cả test của ticket 05 theo (2).
- `npm test` ở gốc repo: 269 test, 264 pass — 5 fail còn lại là fixture `smart-city` có sẵn từ trước.
