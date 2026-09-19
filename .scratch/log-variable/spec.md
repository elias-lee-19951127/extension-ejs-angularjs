# Spec: "Log biến này" — đặt logpoint từ hover

**Ngày viết:** 2026-09-20 · **Trạng thái:** đã triển khai 2026-09-20 — ticket 01–04 done; còn verify tay trong VS Code thật với `smart-city` (ticket 04)
**Nối tiếp:** `.scratch/observed-types-r1/spec.md` (R1 — kiểu từ giá trị đã log, đã làm) và
`.scratch/inline-logpoints/spec.md` (logpoint do server tự đặt qua CDP, đã làm).

## Vấn đề

R1 cho hover có kiểu thật khi một giá trị scope **đã được log**. Đo trên `smart-city` (2026-09-20):
288 lời gọi `console.*`, 8 trong controller, **0** log biến scope. Tức là R1 chỉ có tác dụng khi dev
tự đặt logpoint `{vm.rows}` — mà muốn vậy dev phải: mở controller, tìm đúng lần gán, chuột phải lề,
*Add Logpoint…*, gõ lại biểu thức. Đúng lúc dev đang đọc dòng hover "Could not be inferred — assigned
from `res.data`", họ đã có mọi thông tin đó — extension cũng có.

## Mục tiêu

Trong hover, cạnh mỗi lần gán không suy ra được kiểu, có một link **Log at runtime**. Bấm → extension
đặt một logpoint VS Code bình thường **ngay sau câu gán đó**, log đúng biến đó. Lần sau dòng đó chạy (khi
đang nối Runtime Log), hover có kiểu thật. Dev không rời template, không gõ gì.

## Số liệu đo (Node 20.20 `--inspect`, 2026-09-20)

Đặt `Debugger.setBreakpointByUrl` có `condition` ghi log, ở cột **ngay sau dấu `;`** kết thúc câu gán
(script đo ở scratchpad, không vào repo):

| Dạng code | Theo cột, ngay sau `;` | Theo dòng (cột 0 dòng kế — cách logpoint hiện nay) |
|---|---|---|
| Câu gán, câu lệnh khác ở dòng sau | chạy **sau** câu gán, log giá trị mới | được |
| Câu gán là câu cuối, `}` ở dòng sau | được | được |
| Hàm một dòng `function (res) { $scope.b = res.data; }` | được | **không làm được** — dòng kế nằm ngoài hàm |
| Trong `if` một dòng `if (res) { $scope.d = res.data; } return 1;` | được | **không làm được** |

`setBreakpointByUrl` trả `locations: []` khi hàm chưa được compile (V8 compile lười) — breakpoint vẫn
bind khi hàm chạy. Không được coi `locations` rỗng là thất bại.

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | **Chỗ bấm: link trong hover**, trên dòng "Could not be inferred — assigned from `res.data` (link)" / "Some assignments could not be inferred…" / "Not inferred statically…": mỗi nguồn không suy ra được (≤ 5, đã có sẵn) kèm `· [Log at runtime](command:…)`. Cả hover trong template lẫn trong file JS. **Không** làm code action. | Link nằm đúng chỗ dev đọc ra vấn đề. Code action cần range kích hoạt riêng trong template và sẽ hiện ở IntelliJ, nơi không có Runtime Log để dùng nó. |
| 2 | Chỉ đề nghị ở **lần gán không suy ra được kiểu** (`unknownFrom`). Biến có kiểu tĩnh đầy đủ → không có link. Biến không có lần gán nào (vd `angular.extend($scope, data)`) → không có link (không có chỗ để đặt). | Link phải hiếm mới có ích, giống inline hint. Chỗ tĩnh đã biết thì runtime chỉ xác nhận. |
| 3 | **Vị trí: logpoint theo cột, ngay sau câu lệnh chứa lần gán** (sau `;`, hoặc cuối câu nếu không có `;`). Chỉ khi lần gán **là cả một câu lệnh biểu thức** (`$scope.rows = res.data;`, kể cả `a = b = x;`). Gán nằm trong biểu thức khác (`return $scope.x = y`, `if ((x = y))`, thân arrow rút gọn `res => $scope.rows = res.data`) → không có link. | Số đo: theo cột chạy đúng cả 4 dạng; theo dòng hỏng với hàm một dòng. Thân arrow rút gọn chưa đo — không đoán. |
| 4 | **Nội dung:** `logMessage` = `<vế trái> = {<vế trái>}`, vế trái đúng như viết trong code (`$scope.rows`, `vm.rows`, `this.rows`). Không `condition`. | Vế trái hợp lệ tại chỗ đó theo định nghĩa (vừa gán qua nó), và `scopeTargetAt` resolve ra đúng `(owner, path)` của lần gán → thành bằng chứng R1. Nhãn `rows = ` làm log inline tự đọc được. |
| 5 | **Logpoint theo cột cho cả pipeline:** `ejsng/setLogpoints` thêm `character?` (client đọc `location.range.start.character`), server gửi `columnNumber` cho `setBreakpointByUrl` và resolve biểu thức logpoint tại **đúng cột đó** (thay vì ký tự không trắng đầu dòng). Logpoint dev tự đặt ở lề có `character` 0 → hành vi như cũ. | Cần cho #3. Resolve theo cột còn sửa một lỗi tiềm ẩn: với hàm một dòng, đầu dòng nằm **ngoài** callback nên `this`/`vm` bị resolve sai chỗ. |
| 6 | Logpoint là **`vscode.SourceBreakpoint` bình thường**, thêm bằng `vscode.debug.addBreakpoints`. Hiện ở lề, trong Breakpoints view, lưu qua reload như mọi breakpoint; dev xoá bằng UI sẵn có. **Không tự gỡ** sau khi đã thấy kiểu. | Không phát minh trạng thái riêng. Tự gỡ thứ dev nhìn thấy là bất ngờ, và làm mất trường hợp kiểu đổi về sau (object rồi `null`). Dòng "Seen at runtime … logged at (link)" chỉ đường tới nó. |
| 7 | **Không trùng:** đã có breakpoint ở đúng `(uri, dòng, cột)` → không thêm; bật lại nếu đang tắt và cùng `logMessage`, còn không thì báo. | Bấm hai lần không được sinh hai logpoint. |
| 8 | **Phản hồi sau khi bấm** (thông báo VS Code, tiếng Anh): "Logging `$scope.rows` after list.controller.js:31 — hover again once that line runs." Nút: **Connect Runtime** khi chưa có kết nối; **Show** mở file tại chỗ đặt. Setting `ejsng.runtimeLog.logpoints` đang tắt → báo thẳng + nút mở setting, **không** tự bật. | Dev ở lại template; cần biết logpoint nằm đâu và cần điều kiện gì để có kết quả. Đổi setting là việc của dev. |
| 9 | Link chỉ có khi **client khai báo hỗ trợ**: VS Code client gửi `initializationOptions.commands: ['ejsng.logVariable']` và bật `markdown.isTrusted: { enabledCommands: ['ejsng.logVariable'] }` (có sẵn ở `vscode-languageclient` 9.0.1). IntelliJ không khai → hover không có link. | Link `command:` mà client không chạy được là link chết. `enabledCommands` giới hạn đúng một lệnh — không mở toàn quyền cho markdown của hover. |
| 10 | Lệnh `ejsng.logVariable` ẩn khỏi Command Palette (`"when": "false"`): nó cần tham số từ hover. | Gọi từ palette không có biến nào để log. |

## Loại khỏi phạm vi

- Code action / lệnh từ palette theo con trỏ.
- Đặt logpoint cho biến **không** có lần gán không suy ra được (#2), hoặc gán trong biểu thức / thân arrow rút gọn (#3).
- Tự gỡ logpoint; "log một lần" (one-shot).
- File `.ejs` (logpoint trong EJS chưa hỗ trợ — xem spec inline-logpoints).
- IntelliJ.
- File JS đang sửa chưa lưu: vị trí tính trên buffer (overlay) còn runtime chạy bản trên đĩa → log bị kiểm nội dung chặn (Stale File), như mọi logpoint hiện nay. Chấp nhận.

## Điểm neo trong code

- `packages/core/src/extract/js.ts` — `extractScopeWrites`: thêm vị trí "ngay sau câu lệnh" cho lần gán là cả một câu lệnh (`ScopeWrite.after?: number`); tăng `PARSER_VERSION`.
- `packages/core/src/resolve/observed-type.ts` — `unknownFrom` mang thêm `after` + vế trái để server dựng link.
- `packages/vscode-client/src/logpoints.ts` — `logpointsFrom`: thêm `character`.
- `packages/server/src/index.ts` — `ejsng/setLogpoints` (`character`), `setLogpointBreakpoint` (`columnNumber`), `logpointTargets` (resolve tại cột), `observedTypeLines` (link, chỉ khi client khai `commands`).
- `packages/vscode-client/src/extension.ts` + `package.json` — lệnh `ejsng.logVariable`, `markdown.isTrusted`, `initializationOptions.commands`, ẩn khỏi palette.
- Test: `packages/server/test/runtime-log-logpoints.test.js` đã chạy `node --inspect` thật — thêm ca logpoint theo cột trong hàm một dòng.

## Ticket

1. [01-where-to-log.md](issues/01-where-to-log.md) — **core — chỗ đặt:** `ScopeWrite.after` (#3), `unknownFrom` mang `after` + vế trái; `PARSER_VERSION`.
2. [02-column-logpoints.md](issues/02-column-logpoints.md) — **logpoint theo cột:** `character` qua `setLogpoints`, `columnNumber`, resolve biểu thức tại cột (#5). Test `node --inspect` thật: hàm một dòng log giá trị **sau** lần gán; logpoint ở lề (`character` 0) không đổi hành vi.
3. [03-hover-link-and-command.md](issues/03-hover-link-and-command.md) — **link + lệnh:** link trong hover khi client khai hỗ trợ (#1, #2, #9); lệnh `ejsng.logVariable` thêm `SourceBreakpoint`, không trùng, thông báo + nút (#6–#8, #10). Test LSP: có link khi khai `commands`, không khi không khai; test client cho phần thuần (dựng breakpoint, kiểm trùng).
4. [04-verify-and-docs.md](issues/04-verify-and-docs.md) — **verify + docs:** trên `smart-city` trong VS Code thật: bấm link ở hover `vm.x` gán từ `res.data` → logpoint xuất hiện đúng chỗ → nối runtime → hover có kiểu. README, kiến trúc (mục 5.3.2), CONTEXT nếu có thuật ngữ mới.

Thứ tự: 1 và 2 song song; 3 cần cả hai; 4 cuối.
