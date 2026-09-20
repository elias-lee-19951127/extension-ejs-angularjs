# Spec: "Log this at runtime" — chuột phải và phím tắt

**Ngày viết:** 2026-09-20 · **Trạng thái:** đã chốt 2026-09-20 (người dùng: làm cả menu chuột phải lẫn phím tắt)
**Nối tiếp:** `.scratch/log-lens/spec.md` (CodeLens, đã làm) và `.scratch/log-variable/spec.md` (link trong hover, đã làm).

## Vấn đề

CodeLens chỉ mọc trên dòng **gán vào scope**. Nhưng lúc debug, thứ hay muốn nhìn nhất lại thường không phải
chỗ đó: `res.data` trong callback, tham số hàm, biến cục bộ, hay dòng `if (row.id === n)`. Ở những dòng ấy dev
lại quay về gõ tay trong ô *Add Logpoint…* của VS Code — chỗ sai nhiều nhất (sai tên biến, sai dòng, `this` trong
callback không phải controller).

## Mục tiêu

Đặt con trỏ (hoặc bôi đen) vào thứ muốn xem → **một phím tắt** hoặc **một mục trong menu chuột phải** → có ngay
logpoint với nội dung và vị trí đúng. Không hộp thoại, không gõ.

Ba chỗ bấm bù nhau, dùng chung một lệnh và một nội dung logpoint:

| | Dùng khi | Ưu / nhược |
|---|---|---|
| CodeLens (đã có) | dòng gán vào scope | 1 click, tự hiện, nhưng chỉ ở dòng gán |
| Menu chuột phải (mới) | mọi dòng, mọi biểu thức | 2 thao tác, nhưng ai cũng biết chuột phải |
| Phím tắt (mới) | như trên, khi đã quen tay | nhanh nhất, nhưng ẩn |

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | Lệnh `ejsng.logHere` — "EJS/NG: Log This at Runtime". Trong menu chuột phải của editor (nhóm `debug`, chỉ với file `.js`) và phím tắt **`Cmd+Alt+L`** (macOS) / **`Ctrl+Alt+L`** (Windows, Linux), chỉ khi con trỏ đang ở file `.js`. | Một lệnh cho cả hai chỗ bấm. Phím tắt không trùng phím mặc định nào của VS Code; ai trùng với extension khác thì đổi được. |
| 2 | **Chọn biểu thức theo thứ tự:** (a) phần đang **bôi đen**, nếu parse được thành một biểu thức; (b) chuỗi property dưới con trỏ (`res.data`, `vm.form.owner`, `row`); (c) không trúng gì → biến được **gán** trên dòng đó (đúng như CodeLens). | Bôi đen là ý định rõ nhất. (c) làm phím tắt vẫn dùng được khi con trỏ đứng bừa trên dòng. |
| 3 | **Vị trí:** biểu thức là vế trái của câu gán trên dòng đó → đặt **ngay sau câu lệnh** (thấy giá trị mới). Mọi trường hợp khác → đặt ở **đầu dòng** (thấy giá trị mà dòng sắp dùng). | Cùng luật với CodeLens cho vế trái. Với biến được đọc, giá trị trước khi dòng chạy mới là cái đang muốn biết. |
| 4 | **Từ chối, kèm lý do** (không tạo logpoint im lặng): biểu thức chứa **lời gọi hàm**; biểu thức bắt đầu bằng `this` trong hàm lồng non-arrow; không parse được; file không phải `.js`; dòng trống. | `{load()}` sẽ **gọi hàm thật** mỗi lần dòng chạy — tác dụng phụ lên app. `this` trong callback không còn là controller: log ra sẽ sai mà không ai biết. |
| 5 | Nội dung: `<tên ngắn> = {<biểu thức>}` — `data = {res.data}`, `rows = {$scope.rows}`. Giống hệt CodeLens và link trong hover. | Ba chỗ bấm cùng một vị trí phải ra **cùng một** logpoint, nếu không sẽ chồng nhau (bài học của log-lens). |
| 6 | **Bật/tắt:** đã có đúng logpoint đó ở đúng vị trí → gỡ. | Phím tắt bấm hai lần là bật/tắt, như lens. |
| 7 | Phân tích ở **server** (request `ejsng/logHere { uri, line, character, selection }` → `{ target }` hoặc `{ reason }`), client chỉ tạo logpoint và báo. | AST và facts nằm ở server; client không parse JS. |
| 8 | Phản hồi dùng lại đường của lens/hover: thông báo kèm **Connect Runtime** / **Show**, cảnh báo khi `ejsng.runtimeLog.logpoints` đang tắt. | Một đường phản hồi cho cả ba chỗ bấm. |

## Loại khỏi phạm vi

- Template `.html` / `.ejs` (logpoint đặt trên code V8 chạy, không phải biểu thức Angular).
- Sửa nội dung logpoint trước khi đặt (muốn khác thì sửa trong Breakpoints view).
- Log nhiều biến một lúc từ một lần bấm.
- IntelliJ.

## Điểm neo trong code

- `packages/core/src/extract/js.ts` — `statementEnd`, `scopePath`, `thisAliasTest`, `logTargetsIn` (dùng lại).
- `packages/core/src/extract/js-common.ts` — `parseJsTolerant`.
- `packages/server/src/index.ts` — request mới `ejsng/logHere`.
- `packages/vscode-client/src/extension.ts` + `package.json` — lệnh, `menus.editor/context`, `keybindings`.
- `packages/vscode-client/src/log-variable.ts` — `planLogVariable` (đã có), dùng cho bật/tắt.
- Test: core (chọn biểu thức + vị trí + lý do từ chối), LSP, e2e VS Code thật.

## Ticket

1. [01-log-here-query.md](issues/01-log-here-query.md) — core + server: chọn biểu thức, tính vị trí, lý do từ chối.
2. [02-command-menu-keybinding.md](issues/02-command-menu-keybinding.md) — client: lệnh, menu chuột phải, phím tắt, bật/tắt, thông báo.
3. [03-verify-and-docs.md](issues/03-verify-and-docs.md) — e2e VS Code thật, README, kiến trúc, demo.

Thứ tự: 1 → 2 → 3.
