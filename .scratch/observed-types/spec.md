# Spec: Kiểu đã thấy (Observed Type) của biến trong template

**Ngày chốt:** 2026-09-19 · **Trạng thái:** bản 1 xong — ticket 01–05 done (2026-09-19); còn verify tay inlay hint trong VS Code / IntelliJ (ticket 04). Nguồn runtime (R1/R4/R3) chưa có ticket
**Nguồn:** phiên phản biện 2026-09-19 (7 câu, người dùng đồng ý mọi đề xuất), sau khi đo trên
`smart-city` (script đo nằm ngoài repo — số liệu chép ở dưới).

## Mục tiêu

Khi viết hoặc sửa template AngularJS, dev **thấy được hình dạng dữ liệu** của một biến scope mà
không phải mở controller: `vm.rows` là mảng object có những key nào, `vm.user` có lúc là `null`
không. Hai tình huống được phục vụ (câu 1):

- **(a) Viết template** — hover cho kiểu đầy đủ + các chỗ gán.
- **(b) Tránh render rỗng** — chú thích inline **hiếm**: chỉ khi biến chắc chắn có lúc là `null`/`undefined`.

Không phục vụ "(c) lướt đọc code lạ" bằng inline ở mọi biểu thức — dòng template dài gấp đôi,
người dùng sẽ tắt (cùng lý do `ejsng.diagnostics.enabled` mặc định tắt).

Bản 1 **chỉ dùng nguồn tĩnh** (index). Nguồn runtime cắm vào ở bản 2–3 trên cùng mô hình dữ liệu (#8).

## Số liệu đo (smart-city, 2026-09-19)

| | |
|---|---|
| Scope member | 125, trong đó **93 là method**, **32 là dữ liệu** (581 lượt dùng trong template) |
| Kiểu có ích từ **lần gán đầu** (index hiện chỉ giữ lần này) | 27/32 member · **78.8%** lượt dùng |
| Kiểu có ích khi **gộp mọi lần gán** | 29/32 member · **96.0%** lượt dùng |
| Gán `null` trước rồi mới gán giá trị thật | 5 member |
| Lần gán ra `unknown` | 34/328 — chủ yếu `a \|\| b`, `a ? b : c`, biểu thức chuỗi/số; gần như không có `res.data` |

"Có ích" = không phải hàm, không phải `null`/`undefined`. Mẫu nhỏ (9 template) — repo gọi `$http`
nhiều sẽ thấp hơn; đó là lúc nguồn runtime (#8) đáng làm.

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | **Hover luôn có kiểu đầy đủ** + tối đa 5 chỗ gán. **Inline chỉ cho "có thể rỗng"**. | Câu 1. Inline phải hiếm mới được tin. |
| 2 | Inline chỉ ở **biểu thức Angular trong template**, với chữ **"có thể rỗng khi render"**, style nhạt — không gọi là lỗi. EJS local: ticket riêng ở bản 2 (cần runtime). JS controller: chỉ hover. | Câu 2. Biểu thức Angular **không ném lỗi** khi gặp null (`{{ a.b }}` ra rỗng) — gọi là lỗi là báo động giả. EJS `<%= user.name %>` với `user` undefined mới làm hỏng cả trang (500), nhưng kiểu của nó đến từ `req`/DB nên tĩnh gần như không biết. |
| 3 | "Có thể rỗng" = có **ít nhất một lần gán tường minh** `null`/`undefined`/`void 0`, kể cả trong nhánh `a ? b : null` và vế phải `a \|\| null`. Member **chỉ được gán trong callback/hàm lồng** (chưa có giá trị ở lần render đầu) → **chỉ ghi trong hover**, không inline. | Câu 3. Tính luôn trường hợp callback thì gần như mọi dữ liệu tải async đều bị gắn cờ → ồn như (c). |
| 4 | Gộp các lần gán: cùng **loại** (object/array/primitive cùng kiểu) → **gộp một**, key không có ở mọi lần gán thành **optional** `id?`. Khác loại hẳn → union `A \| B`. Cú pháp kiểu TypeScript, `T[]` thay `Array<T>`. Hover: tối đa **2 cấp lồng**, **8 key/cấp**, phần cắt ghi `…+N`. | Câu 4. Union nguyên văn khó đọc; lấy "lần đầy đủ nhất" che mất khác biệt. Optional key chính là thông tin cần khi viết `{{ form.id }}`. |
| 5 | Chỉ gộp lần gán từ **bản controller gần file nhất** khi một controller được khai báo ở nhiều file (như `preferNearest`). | Đo thấy `lastSearchMs` 8 lần gán vì controller bị khai báo 2 lần ở 2 file — gộp lẫn sẽ sai. |
| 6 | Phạm vi bản 1: **member** (`vm.rows`, `rows`), **key lồng** (`vm.form.name`, đi theo shape như Shape Walking), **phần tử `ng-repeat`** (`row`), và **gán lồng** `$scope.form.extra = …` / `$scope.state.loading = true` bổ sung key (optional) vào shape. `ng-init`: để sau. | Câu 5. Không có gán lồng thì `{{ state.loading }}` hiện sai "`state` không có `loading`" — sai còn tệ hơn im lặng. |
| 7 | Không suy ra được → **không inline gì**, hover ghi **lý do + nguồn**: "không suy ra được — gán từ `res.data` (list.controller.js:30)". Không bao giờ ghi `unknown` trơn. | Câu 5. |
| 8 | Mô hình dữ liệu chung từ bản 1: kiểu của một biến = tập **Bằng chứng kiểu (Type Evidence)** `{ source: 'static' \| 'runtime', shape, site \| connection, count, lastSeen }`. Bản 1 chỉ có `static`. Bằng chứng runtime **chỉ ở RAM, theo kết nối, không ghi cache**. | Câu 6. Runtime cắm vào sau không phải đổi hiển thị. Giá trị runtime cũ nhanh và có thể chứa dữ liệu cá nhân — không để nằm trong repo. |
| 9 | Fact mới **tách riêng** khỏi `scopeMembers`: `scopeMembers` vẫn chỉ giữ lần gán ĐẦU (là "chỗ khai báo" mà go-to-definition và rename dựa vào); mọi lần gán (kể cả lồng) ghi vào fact mới. Tăng `PARSER_VERSION`. | Đưa mọi lần gán vào `scopeMembers` sẽ làm go-to-definition ra nhiều đích và đổi hành vi rename. |
| 10 | Hiển thị qua LSP chuẩn: `textDocument/hover` (nối thêm vào hover hiện có) và `textDocument/inlayHint`. Setting `ejsng.typeHints.nullable` (mặc định `true`) cho inline; hover không có setting. IntelliJ không làm riêng — kỳ vọng chạy qua LSP4IJ, verify tay. | Câu 7. |

## Loại khỏi phạm vi bản 1

- Mọi nguồn runtime (xem "Lộ trình").
- EJS local (`<%= user %>`) — cần runtime (R4).
- Inline ở file JS; inline cho member chỉ gán trong callback.
- `ng-init`, biến của directive có isolate scope (`scope: {x: '='}`), giá trị do service mutate từ ngoài controller.
- Suy luận xuyên hàm (giá trị trả về của service, tham số callback) — đó là việc của runtime.

## Lộ trình nguồn runtime (không nằm trong ticket bản 1)

| Bản | Nguồn | Ghi chú |
|---|---|---|
| 2 | **R1** — giá trị của `console.log`/logpoint mà pipeline Runtime Log đã nhận (`type/subtype/preview` của CDP `RemoteObject`) | Gần như miễn phí; chỉ có ở biểu thức được log. **Đo 2026-09-19: không miễn phí** — preview V8 không có key của object lồng, phải gọi `Runtime.getProperties`. Spec: [`../observed-types-r1/spec.md`](../observed-types-r1/spec.md). |
| 2 | **R4** — một breakpoint điều kiện luôn `false` tại mỗi `res.render(...)`, ghi shape của object locals qua `Runtime.addBinding` (không đi qua `console`) | Giải đúng lỗi 500 của EJS (#2). Mỗi request thêm một lần đánh giá điều kiện. |
| 3 | **R3** — lúc hover, `Runtime.evaluate` `angular.element(el).scope()…` trên tab trình duyệt đã kết nối, với `throwOnSideEffect: true` | Giá trị hiện tại thật. Khó: tìm phần tử DOM ứng với template. **Không chạy nếu app build với `debugInfoEnabled(false)`** — chưa kiểm được trên app thật: code nền AOCS nằm ở repo trong WSL (`~/projects/aocs-cityos-lusail`, `~/projects/aocs`), không có trên máy dev Mac. Kiểm bằng DevTools: `angular.element(document.querySelector('[ng-controller]')).scope()` ra `undefined` = đã tắt. |
| — | ~~R2~~ probe tự động sau mỗi lần gán | **Không làm**: chạy ở mọi lần dòng đó chạy (vòng lặp nóng), hàng trăm breakpoint ngầm khó gỡ lỗi. R1 + R3 phủ đủ. |

## Điểm neo trong code

- `packages/core/src/extract/js.ts` — `extractScopeMembers` (hiện dừng ở lần gán đầu: `seen`), `inferShape` (hiện `Literal` → `primitive` không phân loại).
- `packages/core/src/types.ts` — `ValueShape`, `JsFacts`.
- `packages/core/src/resolve/shape.ts` — Shape Walking (`walkShape`, `shapeOf`, `shapeAtPath`).
- `packages/core/src/resolve/rename.ts` — `preferNearest`/`nearestRows` cho #5.
- `packages/core/src/resolve/workspace.ts` — API truy vấn mới; `facts()` đã nối controller qua `templateUrl` (template-roots-config/01), nên template gắn qua route/directive cũng có kiểu.
- `packages/server/src/index.ts` — `connection.onHover` (dòng ~434), thêm `onInlayHint`.
- `packages/vscode-client/package.json` + `src/extension.ts` — setting mới.

## Ticket

1. [01-extract-all-writes.md](issues/01-extract-all-writes.md) — extractor: mọi lần gán, gán lồng, primitive có kiểu, cờ rỗng / callback.
2. [02-type-evidence-query.md](issues/02-type-evidence-query.md) — core: Type Evidence, gộp, API truy vấn tại một vị trí.
3. [03-hover.md](issues/03-hover.md) — server: kiểu trong hover.
4. [04-nullable-inlay-hint.md](issues/04-nullable-inlay-hint.md) — server + client: inlay hint "có thể rỗng" + setting.
5. [05-docs.md](issues/05-docs.md) — CONTEXT, README, kiến trúc.
