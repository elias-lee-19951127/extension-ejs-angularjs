# Spec: Logpoint của VS Code hiện inline

**Ngày chốt:** 2026-09-19 · **Trạng thái:** đã triển khai (ticket 01–04), còn verify tay với js-debug — xem ticket 03
**Nguồn:** hội thoại 2026-09-19 — người dùng chọn phương án B.1 (server tự đặt logpoint qua CDP
của chính nó), không ăn theo phiên debug của VS Code.

## Mục tiêu

Người dùng đặt một **logpoint** trong VS Code (chuột phải lề trái → *Add Logpoint…*, ví dụ
`user = {user.name}, n = {items.length}`). Khi dòng đó chạy trong **Runtime Target** đang kết
nối, giá trị hiện inline cạnh dòng đó — y như một `console.log` bình thường của tính năng
Runtime Log, nhưng **không phải sửa code, không restart app, không dừng chương trình**.

Chạy được với mọi Runtime Target mà Runtime Log đã hỗ trợ: `node --inspect` local, Node trong
Docker, tab trình duyệt — không cần người dùng đang debug bằng VS Code.

## Kết quả thực nghiệm (Node v20.20.0, 2026-09-19)

Đã chạy thử trên `node --inspect` thật trước khi chốt thiết kế:

| Câu hỏi | Kết quả |
|---|---|
| `Debugger.setBreakpointByUrl` với `condition` = `(console.log(...), false)` có dừng app không? | **Không.** Điều kiện trả `false` nên V8 không bao giờ pause. |
| Đặt trước khi module được `require` (nạp muộn) có ăn không? | **Có** với `urlRegex` — breakpoint tự bind khi script được parse. |
| Stack trace của log đó ra sao? | `callFrames[0]` là đoạn điều kiện, `url` = đúng `//# sourceURL=` ta gắn (`ejsng-logpoint-1`); `callFrames[1]` là dòng thật đặt logpoint. |
| Điều kiện đọc được biến local không, kể cả trong arrow function lồng? | **Có.** |
| Biểu thức ném lỗi? | Bọc từng `{expr}` trong `try/catch` → hiện `<nope is not defined>`, không hỏng cả logpoint. Điều kiện ném lỗi → V8 coi như `false`, không pause. |
| `console.log` trong điều kiện có in ra stdout của app không? | **Có** — tác dụng phụ xấu (làm bẩn log của app/Docker). Dùng `process.getBuiltinModule('node:inspector').console` thì **chỉ** gửi qua inspector, không in stdout, và vẫn tới đủ mọi client. |
| Hai client CDP cùng gắn một target Node? | **Được** — cả hai đều nhận `consoleAPICalled`. |

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | **Server tự đặt logpoint** qua kết nối CDP của Runtime Log (B.1), không đi qua `vscode-js-debug`. | Giữ nguyên quyết định #3 của spec `inline-runtime-log`: kịch bản chính là app chạy độc lập (Docker/terminal), không có phiên debug nào của VS Code. |
| 2 | Nguồn logpoint = `vscode.debug.breakpoints`: chỉ lấy `SourceBreakpoint` **đang bật**, có `logMessage`, file `file:`. Breakpoint thường (không có `logMessage`) **bị bỏ qua** — server không bao giờ pause runtime. | Cam kết "runtime không bao giờ bị dừng" của Runtime Log vẫn giữ. Dùng đúng UI logpoint sẵn có của VS Code, không phát minh UI mới. |
| 3 | Client gửi **toàn bộ danh sách** qua notification `ejsng/setLogpoints` mỗi khi breakpoint đổi (`onDidChangeBreakpoints`) và lúc khởi động. Server thay toàn bộ, không diff. | Danh sách nhỏ; gửi nguyên cục thì không có trạng thái lệch giữa client và server. |
| 4 | Mỗi logpoint thành một `Debugger.setBreakpointByUrl` có `condition` = `(<cond>) ? (<console>.log(<args>), false) : false` + `//# sourceURL=ejsng-logpoint-<id>`. `<console>` = `globalThis.process?.getBuiltinModule?.("node:inspector")?.console ?? console`. | Xem bảng thực nghiệm. Trên trình duyệt, hoặc Node < 20.16 (không có `getBuiltinModule`), rơi về `console` thường — vẫn đúng, chỉ là Node cũ sẽ in thêm ra stdout. |
| 5 | Cú pháp `logMessage` giống VS Code/js-debug: văn bản thường + `{biểu thức}`, đếm ngoặc lồng (`{ {a: 1}.a }` hợp lệ). Mỗi biểu thức bọc `try/catch`, lỗi hiện `<message>`. Hỗ trợ `condition`. **Không** hỗ trợ `hitCondition` ở v1 (bỏ qua). | Khớp kỳ vọng người dùng VS Code. `hitCondition` cần bộ đếm trạng thái trong runtime — để sau. |
| 6 | Log của logpoint đi **chung pipeline** Runtime Log: core nhận ra frame `ejsng-logpoint-<id>`, bỏ frame đó, nối các đối số **không chèn dấu cách** (văn bản của người dùng tự quyết khoảng trắng). Phần còn lại — chọn frame, Path Mapping, kiểm nội dung (Stale/Shadowed File), vẽ inline, lịch sử — dùng lại nguyên. | Không có đường vẽ thứ hai. Stale File vẫn được chặn: logpoint đặt theo dòng trên đĩa, nếu runtime chạy bản khác thì log bị bỏ với lý do `stale-file` thay vì vẽ sai dòng. |
| 7 | Tìm URL runtime cho một file local bằng **hai đường**: (a) **ánh xạ ngược** đường dẫn local qua Path Mapping (người dùng khai + suy từ mount + khớp đuôi URL đã học) và chính đường dẫn gốc → `urlRegex` `^(file://)?<path>$`, đặt ngay cả khi script chưa nạp; (b) khi có `Debugger.scriptParsed` mà URL **ánh xạ xuôi** ra đúng file có logpoint nhưng chưa regex nào ở (a) phủ → đặt thêm bằng `url` chính xác. | (a) bắt được module nạp muộn trong Node/Docker. (b) bắt được trường hợp chỉ ánh xạ xuôi mới biết — URL trình duyệt khớp theo đuôi. Không trùng: (b) chỉ chạy khi (a) chưa phủ URL đó. |
| 8 | Setting `ejsng.runtimeLog.logpoints` (boolean, mặc định `true`) để tắt hẳn. | Lối thoát khi người dùng **cũng** đang debug cùng target bằng js-debug: cả hai cùng đặt logpoint → Debug Console hiện trùng (inline thì không trùng vì chỉ giữ giá trị mới nhất mỗi dòng). |

## Loại khỏi phạm vi v1

- `hitCondition`.
- Breakpoint thường (pause) — server không bao giờ dừng runtime.
- Logpoint trong file `.ejs`: EJS biên dịch template thành function **không có source map**, nên
  dòng trong `.ejs` không có dòng runtime tương ứng. Cần một spec riêng (sinh source map cho EJS).
- Tự nhận biết phiên js-debug đang gắn cùng target để tránh trùng Debug Console (dùng setting #8).
- File đang sửa chưa lưu: VS Code dời dòng logpoint theo buffer, server đặt theo số dòng đó còn
  runtime chạy bản trên đĩa. Kiểm nội dung (#6) chặn được khi runtime khác đĩa; khi đĩa khớp runtime
  nhưng buffer đã lệch, logpoint có thể lệch dòng — chấp nhận ở v1.
- Client IntelliJ.
- Báo trạng thái "logpoint đã bind / chưa bind" trên panel — xem "Việc để lại".

## Điểm neo trong code

- `packages/core/src/runtime-log.ts` — `parseConsoleApiCalled`: nhận ra frame logpoint.
- `packages/core/src/logpoint.ts` (mới) — thuần: phân tích `logMessage`, dựng `condition`, ánh xạ
  ngược đường dẫn, dựng `urlRegex`.
- `packages/server/src/runtime-log.ts` — `connectRuntimeLog`: thêm `request()` tổng quát (để
  `setBreakpointByUrl`/`removeBreakpoint`), sửa JSDoc cam kết "no breakpoint is ever set".
- `packages/server/src/index.ts` — `ejsng/setLogpoints`, áp logpoint cho từng kết nối lúc mở / khi
  danh sách đổi / khi có `scriptParsed`.
- `packages/vscode-client/src/extension.ts` + `package.json` — gửi breakpoint, setting mới.

## Ticket

1. [01-core-logpoint.md](issues/01-core-logpoint.md) — phần thuần ở core.
2. [02-server-set-logpoints.md](issues/02-server-set-logpoints.md) — server đặt/gỡ logpoint.
3. [03-vscode-client.md](issues/03-vscode-client.md) — client gửi breakpoint + setting.
4. [04-docs.md](issues/04-docs.md) — CONTEXT, README, ADR.

## Việc để lại cho phase sau

1. Panel hiện từng logpoint: đã bind ở target nào, hay "không tìm thấy script" (thường do thiếu Path Mapping).
2. `hitCondition`.
3. Logpoint trong `.ejs` (cần source map EJS).
4. IntelliJ: cùng notification `ejsng/setLogpoints`, chỉ còn phần đọc breakpoint phía IDE.
