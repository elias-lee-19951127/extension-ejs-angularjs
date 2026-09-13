# Research: nền tảng kỹ thuật cho "inline log" kiểu Console Ninja

**Ngày:** 2026-09-13 · **Phạm vi:** trả lời 5 câu hỏi trong yêu cầu nghiên cứu, làm nền cho quyết định
kiến trúc (2) trong `/private/tmp/ejsng-handoff-2026-09-13.md`. Chỉ dùng nguồn sơ cấp (tài liệu
chính thức, source code, spec) — không dùng blog/secondary write-up trừ khi không có nguồn sơ cấp.

---

## 1. Cơ chế thật của Console Ninja

Console Ninja là closed-source, nên phần này tách rõ **đã xác nhận** (chính README/tài liệu chính
thức của tác giả nói) và **suy luận** (không có nguồn sơ cấp xác nhận trực tiếp).

### Đã xác nhận (từ README chính thức `wallabyjs/console-ninja`)

- **Instrumentation lúc build, không phải require hook đơn thuần cho mọi trường hợp.** Với các
  framework có hỗ trợ sẵn (Vite, Next.js, Angular CLI, Remix, Astro...), README nói: "Console Ninja
  integrates with locally installed tools that are building/preparing your code, and then inspects
  and adjusts your code... before it gets to the runtime" và "Console Ninja patches your locally
  installed node modules" — tức là **patch node_modules của build tool** (bundler/dev-server), không
  phải patch code người dùng viết.
  Nguồn: [README.md](https://github.com/wallabyjs/console-ninja/blob/main/README.md) — mục
  "How does it work" và dòng 285 ("To integrate with supported tools seamlessly, Console Ninja
  patches your locally installed node modules").
- **Với Node app tuỳ ý (Express/Hapi/Fastify/custom), cơ chế là CLI wrapper, gần với require hook.**
  README, mục "Universal Node applications" (dòng 154-160): "simply prefix your `node app.js`
  command with `console-ninja`" — ví dụ `console-ninja node --watch app.js`,
  `console-ninja npx nodemon app.js`. Đây là dấu hiệu rõ của **CLI wrapper tiêm loader** (kiểu
  `node -r <loader>.js app.js` hoặc set `NODE_OPTIONS`) để hook vào module resolution trước khi code
  người dùng chạy — README không nói chữ "require hook" hay "module resolution" tường minh, đây là
  suy luận hợp lý từ hành vi quan sát được (prefix CLI, không cần sửa code), **không phải câu chữ
  gốc**.
- **Kênh truyền dữ liệu runtime → editor là WebSocket cục bộ.** README (dòng 258): "Console Ninja
  uses a local websocket server to communicate with your editor, and VPNs and firewalls can
  interfere with this communication." Và mục bảo mật (dòng 297): "Console Ninja instrumentation is
  limited to sending runtime values for `console.log` and errors to your locally running editor
  only (`localhost` hosted websocket server)."
- **Production-safety guard:** README dòng 295: "Console Ninja detects if you are running your tool
  in production mode (by checking CLI flags and process environment variables). When production
  mode is detected, the tool will not modify your application code."
- **Tính năng "Logpoints" dùng chính breakpoint UI của VS Code**, không phải cơ chế console.log-only:
  README (mục "Logpoints", dòng ~400): "Console Ninja Logpoints allow you to log the value of any
  expression in your code, without modifying your code, by simply placing a VS Code breakpoint...
  When Console Ninja is running (and the VS Code debugger is not), the breakpoint will not stop your
  code, but will act as a logpoint." Đây xác nhận Console Ninja **có tích hợp với tầng breakpoint/
  debugger của VS Code** cho tính năng riêng này (khác với console.log capture mặc định).

### Suy luận (không có câu chữ gốc xác nhận trực tiếp)

- Việc set breakpoint không dừng chương trình mà chỉ "log rồi resume" là hành vi kinh điển của
  **debugger/inspector protocol** (đặt breakpoint có điều kiện qua `Debugger.setBreakpoint` rồi tại
  `Debugger.paused` tự động `Debugger.resume` sau khi đọc giá trị scope) — khớp với cách Node Inspector
  Protocol / CDP hoạt động (xem mục 4), nhưng README không nói rõ "V8 Inspector Protocol" hay
  "CDP" cho tính năng Logpoints. Đây là suy luận có cơ sở kỹ thuật, không phải xác nhận.
- Không tìm thấy tài liệu chính thức nào nói Console Ninja có dùng **source map** để ánh xạ vị trí
  runtime → file gốc khi code qua bundler (TS/JSX compile). Về mặt kỹ thuật đây gần như bắt buộc
  (nếu không patch sẽ log sai dòng sau khi Babel/esbuild/tsc biến đổi code), nhưng README không đề
  cập rõ ràng — chỉ suy ra từ việc tool hỗ trợ TS/JSX ngay ("out of the box" cho Vite/Next.js/Angular).
- **Cách render inline**: README không mô tả API cụ thể ("decoration API" hay khác). Vì đây là
  extension VS Code (không phải LSP server riêng theo tài liệu công khai), khả năng cao nhất về mặt
  kỹ thuật là VS Code `TextEditorDecorationType` / `editor.setDecorations` (xem mục 6) — **đây là suy
  luận dựa trên API duy nhất VS Code cung cấp cho việc vẽ text ảo cạnh dòng code**, không phải điều
  Console Ninja tự công bố.

---

## 2. Giới hạn LSP Inlay Hints (spec 3.17)

Lấy trực tiếp từ spec chính thức
[`microsoft/language-server-protocol` — `_specifications/lsp/3.17/language/inlayHint.md`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/inlayHint.md)
(bản render: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_inlayHint).

- **`textDocument/inlayHint` là pull-based, theo [textDocument, range]:** "The inlay hints request is
  sent from the client to the server to compute inlay hints for a given [text document, range] tuple
  that may be rendered in the editor in place with other text." Client chủ động hỏi, server trả
  `InlayHint[] | null` — không có cơ chế server tự đẩy giá trị mới cho một hint cụ thể.
- **`workspace/inlayHint/refresh` chỉ là tín hiệu invalidate toàn cục, không mang dữ liệu:** request
  không có `params` ("_Request_: method: `workspace/inlayHint/refresh`, params: none"), response chỉ
  là `void`. Spec nói thẳng: "Note that this event is global and will force the client to refresh all
  inlay hints currently shown. **It should be used with absolute care** and is useful for situation
  where a server for example detects a project wide change that requires such a calculation." — tức
  là thiết kế cho "cấu hình đổi, tính lại toàn bộ", không cho "một giá trị vừa đổi, cập nhật ngay".
  Spec cũng nói client "still has the freedom to delay the re-calculation... if for example an editor
  is currently not visible" — client được phép trễ, không đảm bảo độ trễ thấp.
- **Không có cơ chế theo dòng/theo hint** — refresh là all-or-nothing ở mức workspace, không có
  `textDocument/inlayHint/refreshOne` hay tương tự. Muốn cập nhật 1 giá trị log mới, client phải gọi
  lại toàn bộ `textDocument/inlayHint` cho range đó và server phải tính lại hint cho cả range.
- **Feature gần hơn về mặt ý tưởng nhưng còn tệ hơn cho use-case log stream: `textDocument/inlineValue`**
  (spec 3.17, [`language/inlineValue.md`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/inlineValue.md)).
  Đây là feature LSP *được thiết kế cho runtime value*, nhưng params bắt buộc có
  `InlineValueContext { frameId: integer /* DAP stack frame id */, stoppedLocation: Range }` —
  nghĩa là nó **chỉ hoạt động trong một phiên Debug Adapter Protocol đang dừng tại breakpoint**, không
  áp dụng cho console.log chạy tự do không qua debugger. Vậy `inlineValue` không giải quyết được bài
  toán log freerun, và vẫn là pull request/response (client hỏi theo range khi debugger dừng).
- **Kết luận từ spec:** cả `inlayHint` lẫn `inlineValue` đều là **mô hình pull/request-response**,
  không có push liên tục, không hợp cho luồng cập nhật nhiều lần/giây của console.log đang chạy.

### Ví dụ thực tế dùng inlay hint cho dữ liệu tĩnh (đối chứng)

- **rust-analyzer** — tài liệu chính thức
  [rust-analyzer Book, mục Inlay Hints](https://rust-analyzer.github.io/book/features.html): hiển thị
  kiểu biến local, tên tham số, kiểu closure... — toàn bộ là **static analysis kết quả từ type
  inference**, cập nhật khi document thay đổi (edit), không có khái niệm "giá trị runtime thay đổi
  theo thời gian". Đây đúng là loại dữ liệu inlay hint được thiết kế cho: ổn định giữa hai lần edit,
  không đổi 10 lần/giây.
- Không tìm thấy LSP server chính thống nào công khai dùng `textDocument/inlayHint` để hiển thị giá
  trị runtime động (log/console output) — mọi use case tài liệu hoá đều là dữ liệu tĩnh suy ra từ
  phân tích code (type, param name, closure capture).

---

## 3. LSP4IJ có hỗ trợ inlay hint không, tới đâu

Nguồn: [`redhat-developer/lsp4ij` — `docs/LSPSupport.md`](https://github.com/redhat-developer/lsp4ij/blob/main/docs/LSPSupport.md)
(dòng 41-43) và source code
[`LSPInlayHintsProvider.java`](https://github.com/redhat-developer/lsp4ij/blob/main/src/main/java/com/redhat/devtools/lsp4ij/features/inlayhint/LSPInlayHintsProvider.java),
[`LanguageClientImpl.java`](https://github.com/redhat-developer/lsp4ij/blob/main/src/main/java/com/redhat/devtools/lsp4ij/client/LanguageClientImpl.java).

- **Có hỗ trợ, và khá đầy đủ so với spec:**
  - ✅ `textDocument/inlayHint` — LSPSupport.md dòng 41.
  - ✅ `workspace/inlayHint/refresh` — dòng 43.
  - ❌ `inlayHint/resolve` — dòng 42, **chưa hỗ trợ** (lazy-resolve tooltip/location/command trên
    từng hint không hoạt động; server phải trả đủ thông tin ngay trong response đầu).
  - Cơ chế đăng ký: "`textDocument/inlayHint` is implemented with the `codeInsight.inlayProvider`
    extension point. LSP4IJ registers `LSPInlayHintProvider` for all languages associated with a
    language server with `LSPInlayHintProvidersFactory`, so it works out-of-the-box"
    (LSPSupport.md dòng 296-298).
- **Khoảng trống quan trọng cho use-case near-real-time — nằm ngay trong comment của chính source
  code LSP4IJ**, `LSPInlayHintsProvider.java`, hàm `getViewPortRange`:
  > "LSP textDocument/inlayHint request parameter expects to fill the visible view port range. As
  > IntelliJ inlay hint provider is refreshed just only when editor is opened or editor content
  > changed and **not when editor is scrolling**, the view port range must be created with full text
  > document offsets."

  Nói cách khác: **IntelliJ chỉ gọi lại provider (nên chỉ gọi lại `textDocument/inlayHint`) khi mở
  file hoặc khi nội dung file thay đổi** — không có timer, không có polling định kỳ, không refresh
  khi cuộn màn hình. Đây là giới hạn của framework Declarative Inlay Hints của IntelliJ, không phải
  của LSP4IJ riêng.
- **`workspace/inlayHint/refresh` khi tới, hành vi là invalidate toàn bộ file đang mở**, không phải
  push giá trị: `LanguageClientImpl.java`
  (`refreshInlayHints()` → `refreshInlayHintsForAllOpenedFiles()` → với mỗi file gọi
  `efm.refreshEditorFeature(file, EditorFeatureType.DECLARATIVE_INLAY_HINT, true, ...)`, dòng
  174-187) — khớp đúng bản chất "global, dùng cẩn thận" mà spec 3.17 đã cảnh báo (mục 2). Gọi refresh
  liên tục (nhiều lần/giây) sẽ ép LSP4IJ tính lại inlay hint cho **mọi file đang mở**, không chỉ file
  vừa có log mới — chi phí không tỉ lệ với tần suất log mong muốn.
- **Không có gap về mặt "trâm implement chuẩn 3.17"** — LSP4IJ theo kịp phần lõi. Gap là ở tầng
  framework IntelliJ bên dưới (refresh trigger thưa, không có cơ chế polling/push tần suất cao), và
  đây là giới hạn kiến trúc, không phải bug có thể vá bằng version LSP4IJ mới hơn.

---

## 4. Đọc log runtime từ Node/Express local hoặc Docker container

So sánh 3 đường, tập trung vào việc **có kèm vị trí source (file/line) hay không**.

| Đường | Nguồn sơ cấp | Có vị trí source? | Ghi chú |
|---|---|---|---|
| `child_process.spawn(...).stdout` pipe | [Node.js `child_process` docs](https://nodejs.org/api/child_process.html) | **Không** | Chỉ là stream text thô từ stdout/stderr; `console.log("x", obj)` in ra text đã format, không có file/line đính kèm trừ khi code tự in `new Error().stack`. |
| Node Inspector/Debugger Protocol (`node --inspect`, `Runtime.consoleAPICalled`) | [Node.js Debugger docs](https://nodejs.org/api/debugger.html) + [Node.js `inspector` module docs](https://nodejs.org/api/inspector.html) + [CDP `js_protocol.json`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json) | **Có** | Xem chi tiết dưới. |
| `docker logs --follow` / `docker attach` | [Docker CLI reference — `docker container logs`](https://docs.docker.com/reference/cli/docker/container/logs/) | **Không** | Thuần stream stdout/stderr của container, giống child_process nhưng qua container runtime. |

### Node Inspector/Debugger Protocol — chi tiết, đây là đường duy nhất có location

- `node --inspect` mở V8 Inspector, in ra `Debugger listening on ws://127.0.0.1:9229/...` (Node.js
  Debugger docs). Có 3 biến thể: `--inspect` (chạy ngay, debugger gắn sau), `--inspect-wait` (chờ
  debugger gắn vào rồi mới chạy), `--inspect-brk` (dừng ngay dòng đầu tiên chờ debugger) — theo
  [nodejs.org/api/debugger.html](https://nodejs.org/api/debugger.html).
- Module `node:inspector` cho phép mở `Session` **trong cùng tiến trình** hoặc kết nối ngoài qua
  WebSocket, và tài liệu chính thức nói rõ tương thích giao thức:
  > "Node.js inspector supports all the Chrome DevTools Protocol domains declared by V8."
  > ([nodejs.org/api/inspector.html](https://nodejs.org/api/inspector.html))
  Tức là **CDP và Node Inspector Protocol là cùng một giao thức dây (wire protocol)** — code viết
  cho CDP `Runtime` domain áp dụng y hệt cho Node.
- Sự kiện `Runtime.consoleAPICalled` — định nghĩa gốc trong
  [`ChromeDevTools/devtools-protocol` — `json/js_protocol.json`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json),
  domain `Runtime`, sự kiện `consoleAPICalled`:
  - `type`: một trong `log | debug | info | error | warning | dir | ... | trace | ...` — khớp trực
    tiếp `console.log/warn/error`.
  - `args`: mảng `RemoteObject` — giá trị đã log, dạng object reference (giữ nguyên object/array
    thật, không phải string đã `JSON.stringify`).
  - `stackTrace` (optional, nhưng **tự động có với `error`/`warning`/`trace`/`assert`**): kiểu
    `StackTrace { callFrames: CallFrame[] }`, và mỗi `CallFrame` có:
    ```
    functionName, scriptId, url, lineNumber (0-based), columnNumber (0-based)
    ```
    — đây chính là **file/line/column** cần để map log về đúng dòng code. Với `console.log` thường
    (`type: "log"`), `stackTrace` là optional — client phải tự đảm bảo bật capture stack trace (V8
    vẫn có thể cung cấp qua cấu hình `Runtime.setAsyncCallStackDepth` hoặc do trace được bật ở
    runtime).
  - Nguồn: field definitions trích trực tiếp từ `js_protocol.json` (domain `Runtime`, event
    `consoleAPICalled`, types `StackTrace`/`CallFrame`).
- Vậy: muốn "biết log nào thuộc dòng nào" mà **không** parse text thủ công (regex trên stdout), chỉ
  có đường Inspector/CDP `Runtime.consoleAPICalled` cho location structured, sẵn sàng dùng ngay
  (lineNumber/columnNumber/url), khớp thẳng với hạ tầng span đã có ở Layer 2 của dự án (theo handoff
  mục (2)).

### `docker logs` / `docker attach`

- [Docker CLI reference](https://docs.docker.com/reference/cli/docker/container/logs/): "`docker
  logs --follow` will continue streaming the new output from the container's `STDOUT` and `STDERR`."
  Có thể kèm `--timestamps` (RFC3339Nano) và lọc theo `--since`, nhưng **không có** bất kỳ thông tin
  vị trí source nào — đơn thuần là ống dẫn text.
- Với container Node, muốn có location structured phải **expose cổng inspector của Node bên trong
  container ra ngoài** (`node --inspect=0.0.0.0:9229 app.js` + publish port `-p 9229:9229`) rồi nối
  CDP client tới đó — về bản chất quay lại đúng đường Inspector Protocol ở trên, `docker logs` chỉ
  còn vai trò fallback khi không mở được cổng inspector.

---

## 5. Bắt console log phía browser (AngularJS 1.x): CDP vs script injection

Nguồn: [CDP spec — domain `Runtime`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)
(qua `js_protocol.json`), và domain `Page` trong
[`browser_protocol.json`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json).

- **CDP `Runtime.consoleAPICalled`** (mục 4 ở trên) hoạt động y hệt trong context browser (Chrome
  DevTools Protocol gốc, Node Inspector chỉ là superset dùng lại cùng domain). Ưu điểm so với
  override `window.console.log`:
  - **`stackTrace.callFrames[].url/lineNumber/columnNumber`** cho vị trí gọi log ngay trong code
    nguồn (trước hoặc sau source-map tuỳ engine, cần tự map qua source map nếu AngularJS app được
    build/minify) — có sẵn, không cần code tự thu thập `new Error().stack` và parse tay.
  - **Không đụng vào code người dùng / không cần tiêm script sớm**: chỉ cần bật `Runtime.enable`
    trên một CDP session gắn vào tab/target, nhận event thụ động. Theo định nghĩa command
    `Runtime.enable`: "Enables reporting of execution contexts creation... When the reporting gets
    enabled the event will be sent immediately for each existing execution context."
  - **args là `RemoteObject`** — giữ nguyên object/array thật (có thể expand giống DevTools Console),
    không mất thông tin qua `toString()`.
- **Override `window.console.log`** (tiêm script qua `Page.addScriptToEvaluateOnNewDocument` —
  browser_protocol.json, domain `Page`: "Evaluates given script in every frame upon creation (before
  loading frame's scripts)" — hoặc đơn giản chèn `<script>` vào EJS template lúc render):
  - Không có stack trace structured sẵn — phải tự `new Error().stack` rồi tự parse chuỗi, dễ vỡ khi
    browser thay đổi định dạng stack, và **không phân biệt được `console.log` gọi từ đâu nếu code đã
    bị minify/transpile** trừ khi tự tích hợp source-map (`source-map` npm package) thủ công.
  - Ưu điểm: không cần mở cổng debug/CDP, hoạt động được cả khi không remote-debug được trình duyệt
    (ví dụ môi trường khoá CDP), và dễ chèn thêm field cấu trúc riêng (nhãn nguồn, id) do kiểm soát
    hoàn toàn code override.
  - Rủi ro: đây là **can thiệp runtime của trang** — nếu trang tự có logic dựa vào `console.log`
    gốc (hiếm nhưng có), hoặc nếu CSP chặn script tiêm, cách này gãy; CDP injection qua
    `Page.addScriptToEvaluateOnNewDocument` né được CSP vì chạy ở tầng DevTools protocol chứ không
    phải như một `<script>` tag thường.
- **Với AngularJS 1.x cụ thể**: không có API gì đặc thù của AngularJS liên quan đến console — đây là
  vấn đề JS runtime thuần tuý (browser console), không phải framework-specific. CDP tiếp cận ở tầng
  V8/DevTools nên **hoạt động độc lập với việc trang dùng AngularJS hay không**.
- **Kết luận nguồn sơ cấp:** CDP `Runtime.consoleAPICalled` ưu việt hơn override thủ công về mặt
  structured location + không phải tự parse — với điều kiện có thể mở kết nối CDP tới trình duyệt
  (`--remote-debugging-port`, hoặc qua trình duyệt do editor/launcher tự mở).

---

## 6. Client-side decoration — nguồn sơ cấp cho cả hai IDE

- **VS Code**: `window.createTextEditorDecorationType(options: DecorationRenderOptions):
  TextEditorDecorationType` và `TextEditor.setDecorations(decorationType, rangesOrOptions)` — định
  nghĩa chính thức trong
  [`microsoft/vscode` — `src/vscode-dts/vscode.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts)
  (`createTextEditorDecorationType` khai báo ở namespace `window`; `setDecorations` trên interface
  `TextEditor`; `ThemableDecorationAttachmentRenderOptions.contentText` — text hiển thị trong phần
  `before`/`after` gắn với decoration — cũng trong cùng file). Đây là **API của extension host, chạy
  hoàn toàn phía client, không đi qua LSP** — mỗi lần muốn đổi text hiển thị chỉ cần gọi lại
  `setDecorations` với range/text mới, không có round-trip request/response, không giới hạn tần suất
  theo spec nào — phù hợp tự nhiên với cập nhật nhiều lần/giây.
- **IntelliJ Platform**: theo tài liệu chính thức
  [JetBrains IntelliJ Platform SDK — "Inlay Hints"](https://plugins.jetbrains.com/docs/intellij/inlay-hints.html),
  nền tảng có **API Inlay Hints riêng của IDE, độc lập với LSP4IJ/language server**: "Declarative
  Inlay Hints Provider" (khuyến nghị từ 2023.1+, nhưng "has limited presentation customization
  possibilities due to its UI-independent design") và "Inlay Hints Provider" (API cũ, "supporting both
  inline and block inlay hints with custom presentation and behavior" — tự do hơn). Một plugin
  IntelliJ (không qua LSP4IJ) có thể tự vẽ inline text bất kỳ lúc nào, y hệt tinh thần
  `TextEditorDecorationType` bên VS Code.
- **Hệ quả kiến trúc**: cả hai IDE đều có đường "vẽ tay" độc lập LSP. Nhưng đây là 2 API hoàn toàn
  khác nhau (TypeScript/VS Code extension host vs Java/Kotlin IntelliJ plugin SDK) — dùng đường này
  **chắc chắn phá vỡ "một server, hai client mỏng"** vì logic hiển thị (không chỉ logic lấy dữ liệu)
  phải viết riêng hai lần.

---

## Khuyến nghị

### Bảng so sánh LSP Inlay Hint vs Client-side Decoration

| | LSP Inlay Hints (3.17) | Client-side Decoration |
|---|---|---|
| Mô hình cập nhật | Pull, theo range; refresh là invalidate toàn cục, "used with absolute care" (spec) | Push tuỳ ý, gọi hàm là cập nhật ngay, không giới hạn tần suất bởi spec nào |
| Hỗ trợ VS Code | Có (built-in LSP client) | Có (`TextEditorDecorationType`) |
| Hỗ trợ IntelliJ qua LSP4IJ | Có, nhưng refresh chỉ trigger khi mở file / đổi nội dung file (theo comment trong chính source LSP4IJ) — **không hợp** log tần suất cao | Có nhưng phải viết riêng bằng Inlay Hints Provider API của IntelliJ Platform, không qua LSP4IJ |
| Giữ "một server, hai client mỏng" | Có — toàn bộ logic ở server LSP, client chỉ render theo chuẩn | Không — logic hiển thị phải nhân đôi (TypeScript cho VS Code, Java/Kotlin cho IntelliJ) |
| Phù hợp với log runtime tần suất cao | Không — cả spec lẫn implementation LSP4IJ đều xác nhận đây là feature cho dữ liệu ổn định (kiểu rust-analyzer type hint), không phải stream | Có — đúng bản chất kỹ thuật, đây là cách Console Ninja tự làm bên VS Code |

**Quyết định:** ưu tiên **client-side decoration**, chấp nhận phá một phần nguyên tắc "một server, hai
client mỏng" ở **tầng hiển thị** — nhưng giữ nguyên nguyên tắc đó ở **tầng logic**: server LSP vẫn là
nơi duy nhất biết "log nào map vào span nào" (tái dùng hạ tầng span ở Layer 2), chỉ đẩy xuống client
một thông điệp gọn (vị trí + giá trị đã format) qua **custom LSP notification** (không chuẩn 3.17,
nhưng đúng tinh thần LSP: server gửi, client render — tương tự cách nhiều LSP server đã dùng
notification tuỳ biến ngoài spec cho tính năng riêng). Mỗi client (VS Code extension, IntelliJ
plugin) chỉ cần một lớp mỏng: nhận notification → gọi `setDecorations`
(VS Code) hoặc Inlay Hints Provider API (IntelliJ) tương ứng. Đây là cách duy nhất khớp với tần suất
cập nhật console.log thực tế, và LSP Inlay Hints (kể cả `inlineValue`) bị loại trừ theo đúng những gì
spec 3.17 và source code LSP4IJ tự nói: pull-based, refresh toàn cục, không có cơ chế push theo
từng giá trị.

**Nguồn log runtime — khuyến nghị theo thứ tự ưu tiên:**

1. **Node Inspector Protocol (`node --inspect` + `Runtime.consoleAPICalled`)** cho tiến trình
   Node/Express local — đây là lựa chọn duy nhất có `lineNumber`/`columnNumber`/`url` structured sẵn
   trong `stackTrace`, khớp thẳng với hạ tầng span đã có (Layer 2), không cần tự parse text hay tích
   hợp source-map thủ công cho phần "biết dòng nào" (vẫn cần source-map riêng nếu code qua
   TS/bundler, nhưng đó là bài toán tách biệt, không phải bài toán "lấy log kèm vị trí").
2. **CDP `Runtime.consoleAPICalled` qua remote-debugging port** cho phần browser (AngularJS 1.x) —
   cùng họ giao thức với (1), tái dùng được phần lớn code xử lý event, ưu tiên hơn tiêm
   `window.console.log` override vì có stack trace structured sẵn và né được CSP.
3. **`docker logs --follow`** chỉ nên là **fallback** khi không mở được cổng inspector trong
   container (ví dụ container hạn chế network) — chấp nhận mất thông tin vị trí, phải tự đoán dòng
   qua regex/heuristic trên text, chất lượng map kém hơn hẳn (1).
4. **`child_process.stdout` pipe thô** — không dùng làm nguồn chính cho tính năng này, vì không có
   gì để map log về span ngoài chính nội dung text log (không có location).

---

## Nguồn tham khảo (sơ cấp)

- Console Ninja README (chính thức): https://github.com/wallabyjs/console-ninja/blob/main/README.md
- Console Ninja trang chủ: https://console-ninja.com/
- LSP 3.17 spec — Inlay Hint: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_inlayHint
- LSP 3.17 spec — nguồn markdown gốc (Inlay Hint): https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/inlayHint.md
- LSP 3.17 spec — Inline Value: https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/inlineValue.md
- rust-analyzer Book — Inlay Hints: https://rust-analyzer.github.io/book/features.html
- LSP4IJ — LSP Support matrix: https://github.com/redhat-developer/lsp4ij/blob/main/docs/LSPSupport.md
- LSP4IJ — `LSPInlayHintsProvider.java`: https://github.com/redhat-developer/lsp4ij/blob/main/src/main/java/com/redhat/devtools/lsp4ij/features/inlayhint/LSPInlayHintsProvider.java
- LSP4IJ — `LanguageClientImpl.java`: https://github.com/redhat-developer/lsp4ij/blob/main/src/main/java/com/redhat/devtools/lsp4ij/client/LanguageClientImpl.java
- Node.js docs — Debugger: https://nodejs.org/api/debugger.html
- Node.js docs — Inspector module: https://nodejs.org/api/inspector.html
- Chrome DevTools Protocol — `Runtime` domain (rendered): https://chromedevtools.github.io/devtools-protocol/tot/Runtime/
- Chrome DevTools Protocol — `js_protocol.json` (nguồn spec gốc): https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json
- Chrome DevTools Protocol — `browser_protocol.json` (domain `Page`): https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json
- Docker CLI reference — `docker container logs`: https://docs.docker.com/reference/cli/docker/container/logs/
- VS Code API — `vscode.d.ts`: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts
- JetBrains IntelliJ Platform SDK — Inlay Hints: https://plugins.jetbrains.com/docs/intellij/inlay-hints.html
