# Spec: CodeLens "Log at runtime" — đặt logpoint bằng một click

**Ngày viết:** 2026-09-20 · **Trạng thái:** đã chốt 2026-09-20 (người dùng chọn CodeLens)
**Nối tiếp:** `.scratch/log-variable/spec.md` (link *Log at runtime* trong hover, đã làm) và
`.scratch/expand-log-values/spec.md` (log hiện rõ object, đã làm).

## Vấn đề

Muốn xem giá trị một biến lúc chạy, dev phải: chuột phải ở lề → *Add Logpoint…* → **gõ tay** biểu thức →
Enter. Gõ tay là chỗ sai nhiều nhất: sai tên biến, đặt nhầm dòng (logpoint chạy **trước** dòng nó đứng nên
thấy giá trị cũ), hoặc `this` trong callback không còn là controller.

Extension đã biết mọi thứ cần thiết: dòng nào gán vào scope, vế trái viết thế nào, và vị trí "ngay sau câu
lệnh" để logpoint chạy **sau** lần gán. Link *Log at runtime* trong hover đã dùng đúng dữ liệu đó, nhưng chỉ
hiện ở lần gán không suy ra được kiểu, và phải hover trúng chữ.

VS Code **không cho** điền sẵn vào ô *Add Logpoint…* của nó (không có API). Nên cách duy nhất để khỏi gõ là
extension tự tạo logpoint — CodeLens là chỗ bấm.

## Số liệu đo (`smart-city`, 2026-09-20)

Số CodeLens sẽ hiện nếu đặt ở mỗi **dòng** có gán vào scope (chỉ tính lần gán là cả một câu lệnh):

| File | Dòng | Lens nếu lấy **mọi** lần gán | Lens nếu chỉ lấy lần gán **không suy ra được kiểu** |
|---|---|---|---|
| `product2/view/public/javascripts/index.js` | 1568 | 240 (15%) | 46 (2.9%) |
| `new-version-2/new-index.js` | 845 | 143 (17%) | 26 (3.1%) |
| `product/view/public/javascripts/index.js` | 645 | 119 (18%) | 21 (3.3%) |
| Toàn repo | | 587 | 105 |

Mỗi CodeLens chiếm một dòng hiển thị, nên "mọi lần gán" làm file dài thêm ~15% — quá rối để bật mặc định.

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | CodeLens **trên dòng có câu gán vào scope**, nhãn `Log rows at runtime`. Bấm → tạo logpoint `rows = {$scope.rows}` **ngay sau câu lệnh** (dùng `ScopeWrite.after` + `lhsText` đã có). Không hộp thoại, không gõ. | Đúng yêu cầu "một click". Vị trí sau câu lệnh là thứ dev hay đặt sai nhất. |
| 2 | **Setting `ejsng.logLens`: `unknown` (mặc định) \| `all` \| `off`.** `unknown` = chỉ lần gán index không suy ra được kiểu. | Số đo: `all` là 15–18% số dòng (rối), `unknown` là ~3% và đúng chỗ log có ích nhất. |
| 3 | Lens **bật/tắt**: dòng đã có logpoint của extension → nhãn thành `Logging rows — click to remove`, bấm thì gỡ. | Đặt nhầm thì gỡ ngay tại chỗ, không phải mở Breakpoints view. |
| 4 | Lens dựng ở **client**, lấy vị trí từ server qua request mới `ejsng/logTargets`. Server trả **mọi** đích kèm cờ `inferred`; client lọc theo setting và tự vẽ lại khi breakpoint đổi (`onDidChangeBreakpoints`) hay setting đổi. | Chỉ client biết breakpoint hiện có (#3) và setting hiện tại — đổi setting không cần reload. Server vẫn là nơi duy nhất biết vị trí. |
| 5 | Chỉ file `.js` trong workspace; không lens trong template. | Logpoint đặt trên code chạy được; biểu thức Angular trong template không phải chỗ V8 dừng. |
| 6 | Lens **không** bao giờ đặt ở lần gán không có "ngay sau câu lệnh" (`return $scope.x = y`, thân arrow rút gọn) — như link trong hover. | Không có chỗ để logpoint chạy sau lần gán. |
| 7 | Bấm lens khi `ejsng.runtimeLog.logpoints` đang tắt, hoặc chưa nối runtime: vẫn tạo logpoint, báo đúng như link trong hover (nút **Connect Runtime** / **Open Setting**). | Một đường phản hồi duy nhất cho cả hai chỗ bấm. |
| 8 | Lệnh dùng lại `ejsng.logVariable`, thêm tham số `toggle: true` cho lens. Link trong hover giữ nguyên (bấm lại chỉ báo "đã log rồi"). | Một lệnh, một chỗ xử lý; hover là "thêm", lens là "bật/tắt" vì nó ở ngay trên dòng. |

## Loại khỏi phạm vi

- Lens cho **biến được đọc** trên dòng (`if (row.id === n)`): cần trích thêm "chỗ đọc biến scope trong JS" mà
  index chưa có, và làm số lens tăng mạnh. Để sau, nếu dùng thật thấy thiếu.
- Lens trong template, trong `.ejs`.
- Sửa nội dung logpoint từ lens (muốn khác thì sửa trong Breakpoints view của VS Code).
- IntelliJ (không có Runtime Log).

## Điểm neo trong code

- `packages/core/src/extract/js.ts` — `ScopeWrite.after` / `lhsText` (đã có, log-variable ticket 01).
- `packages/core/src/resolve/workspace.ts` — thêm truy vấn "mọi đích log trong một file".
- `packages/server/src/index.ts` — request `ejsng/logTargets`; `logVariableLink` đã dựng cùng loại tham số.
- `packages/vscode-client/src/log-variable.ts` — `planLogVariable` (đã có), thêm phần dựng lens.
- `packages/vscode-client/src/extension.ts` — `registerCodeLensProvider`, `onDidChangeBreakpoints`, setting.
- Test: `packages/vscode-client/test-e2e/` (VS Code thật, `executeCodeLensProvider`).

## Ticket

1. [01-log-targets.md](issues/01-log-targets.md) — core + server: liệt kê đích log của một file (`ejsng/logTargets`).
2. [02-code-lens.md](issues/02-code-lens.md) — client: CodeLens, setting `ejsng.logLens`, bật/tắt.
3. [03-verify-and-docs.md](issues/03-verify-and-docs.md) — e2e VS Code thật, demo, README, kiến trúc.

Thứ tự: 1 → 2 → 3.
