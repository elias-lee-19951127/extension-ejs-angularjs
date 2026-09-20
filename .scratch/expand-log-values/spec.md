# Spec: Log hiện rõ object/array, bấm để xem đầy đủ

**Ngày viết:** 2026-09-20 · **Trạng thái:** đã triển khai 2026-09-20 — ticket 01–04 done; còn verify tay trong VS Code thật
**Nối tiếp:** `.scratch/inline-runtime-log/spec.md` (log vẽ inline) và `.scratch/observed-types-r1/spec.md`
(đã có sẵn `digRuntimeValue` — đào giá trị bằng `Runtime.getProperties` theo tầng, có ngân sách).

## Vấn đề

`console.log('rows', $scope.rows)` với một mảng 150 object hiện inline thành:

```
rows [Object, Object, Object, Object, Object, Object, …]
```

Không một key nào. Object lồng cũng vậy: `{name: root, self: Object}`. Nguyên nhân đã đo
(`.scratch/observed-types-r1/spec.md`): preview của CDP chỉ có **một cấp** — object lồng và phần tử mảng
không kèm key nào, object thì cắt ở 5 key, mảng ở 100 phần tử.

## Số liệu đo (Node 20.20, 2026-09-20)

`digRuntimeValue` đào bằng `Runtime.getProperties`, các lệnh **cùng một tầng chạy song song**:

| Giới hạn | Số lệnh | Thời gian |
|---|---|---|
| sâu 2, 8 key, 3 phần tử mẫu (mức hover kiểu đang dùng) | 12 | 4.6 ms |
| sâu 4, 30 key, 5 phần tử mẫu | 36 | 4.3 ms |
| sâu 6, 50 key, 10 phần tử mẫu | 71 | 5.8 ms |

Đo trong tiến trình (độ trễ ~0). Qua Docker/WSL/Chrome, chi phí là **số tầng** (mỗi tầng một lượt đi-về),
không phải số lệnh — sâu 6 là 6 lượt.

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | **Inline hiện 2 cấp, một dòng, cắt ở 200 ký tự**: `rows [{id: 0, title: 'Sensor 0', owner: {…}, …+2}, …+149]`. Chuỗi trong đó cắt ở 40 ký tự. Không bao giờ hiện `Object` trơn. | Đúng thứ người dùng phàn nàn. Một dòng vì decoration của VS Code không xuống dòng được; 200 ký tự là mức còn đọc được cạnh code. |
| 2 | **Hover hiện bản trải ra nhiều dòng** (khối ```json), sâu 3 cấp, 30 key/cấp, 10 phần tử/mảng, chuỗi 200 ký tự, tối đa ~8 KB. Dưới nó là link **Show full value**. | Hover là chỗ đã hiện "giá trị đầy đủ" hôm nay; chỉ là nay nó có nội dung thật. |
| 3 | **Bấm _Show full value_ → mở một tab JSON chỉ đọc** (`ejsng-log:` virtual document, ngôn ngữ `json`), đào **sâu tối đa** lúc bấm: sâu 6, 50 key, mọi phần tử mảng tới 200, chuỗi 10.000 ký tự, tổng ≤ 2 MB. | Tab JSON có sẵn mũi tên gập/mở từng nhánh, tìm kiếm, copy, so sánh — không phải tự viết giao diện cây (người dùng chọn). |
| 4 | **Đào sẵn ở mức #1–#2 lúc log được vẽ**, nhưng **≤ 1 lần đào mỗi (file, dòng) mỗi 300 ms**; log bị chặn vẫn vẽ, chỉ dùng preview như cũ. Đào chạy **sau** khi đã gửi log đi, ngoài hàng đợi vẽ. | Log trong vòng lặp nóng không được biến thành hàng trăm lệnh mỗi giây vào app đang chạy. Vẽ không bao giờ bị chậm vì đào. |
| 5 | Đào sâu (#3) **chỉ khi bấm**, dùng `objectId` đã giữ của đúng lần log đó. `objectId` không còn (app đã điều hướng, console đã xoá) → mở tab với bản đã đào sẵn + một dòng ghi rõ "the runtime no longer holds this value". | Giá trị cũ vẫn hơn không có gì, nhưng phải nói thật là nó không được đào lại. |
| 6 | **Vòng lặp tham chiếu**: chặn bằng **giới hạn độ sâu**, hiện `{…}` ở mức cuối — *không* hứa `[Circular]`. Getter không bao giờ chạy (`accessor` → `"[getter]"`). Hàm → `"[Function: name]"`, `Date`/`RegExp`/`Map`/`Set` → chuỗi mô tả của runtime. | **Sửa khi làm ticket 01, sau khi đo:** V8 cấp `objectId` **mới cho mỗi lần tham chiếu** cùng một object (`…1.1`, `…1.2`, `…1.3`), nên không nhận ra được `a.self = a` bằng danh tính; muốn biết phải gọi thêm `Runtime.callFunctionOn` so sánh với từng tổ tiên — mỗi nút vài lệnh nữa vào app đang chạy, không đáng. Độ sâu đã chặn đủ: `a.self.self.self` dừng ở `{…}`. |
| 7 | **Giữ trong RAM, theo kết nối, không ghi đĩa**: bản đã đào nằm cùng lịch sử log ở client (≤ 10 mục mỗi dòng như hiện nay), `objectId` nằm ở server theo kết nối. Ngắt kết nối → mất. Tab JSON đã mở là văn bản tĩnh, người dùng tự đóng. | Giá trị runtime là dữ liệu thật của người dùng (có thể là dữ liệu cá nhân) — cùng luật với Bằng chứng kiểu. |
| 8 | Hình thức: **JSON hợp lệ** cho tab (#3) — thứ không biểu diễn được thành chuỗi `"[Function: f]"`, `"[Circular]"`, `"[getter]"`, `"undefined"`. Inline và hover dùng dạng gọn kiểu JS (key không ngoặc kép, chuỗi nháy đơn). | JSON hợp lệ thì tab gập/mở, tô màu, tìm kiếm đều chạy. Dạng gọn đọc nhanh hơn cạnh code. |
| 9 | Notification `ejsng/runtimeLog` thêm **trường mới** `inline?`, `expanded?`, `logId?` — `value` giữ nguyên nghĩa cũ. Request mới `ejsng/expandRuntimeLog { logId }`. | Client IntelliJ (chưa có) và mọi thứ đang chạy không được vỡ; cùng lối cộng thêm mà các ticket Runtime Log vẫn dùng. |
| 10 | Setting `ejsng.runtimeLog.expandValues` (mặc định `true`) tắt hẳn việc đào: inline/hover quay về preview như hôm nay. | Lối thoát nếu app quá nhạy với lệnh CDP, hoặc dev không muốn giá trị trải ra trong editor. |

## Loại khỏi phạm vi

- Cây gập/mở tự viết trong panel Runtime (đã cân nhắc, người dùng chọn tab JSON).
- Sửa giá trị / gửi lại vào runtime; xem `Map`/`Set` theo từng phần tử (chỉ hiện mô tả).
- Log của EJS phía Node ngoài phạm vi Runtime Log hiện có — không đổi gì.
- IntelliJ (không có client Runtime Log).

## Điểm neo trong code

- `packages/core/src/runtime-log.ts` — `formatPreview` / `formatArg` (chỗ sinh `[Object]` hôm nay), `ParsedConsoleLog.args`.
- `packages/core/src/runtime-evidence.ts` — `digRuntimeValue`, `DigLimits` (dùng lại; cần thêm chống vòng lặp theo `objectId`).
- `packages/core/src/runtime-shape.ts` — `RuntimeValue`, `runtimeProperties` (đầu vào của bộ định dạng mới).
- `packages/server/src/index.ts` — `handleRuntimeLog` (đào + chặn tần suất), `collectTypeEvidence` (đã có mẫu "đào sau khi vẽ"), notification `ejsng/runtimeLog`, request mới.
- `packages/vscode-client/src/runtime-log-state.ts` — `RuntimeLogEntry`, `formatRuntimeLogInline`.
- `packages/vscode-client/src/extension.ts` — `runtimeLogHover`, đăng ký `TextDocumentContentProvider` cho `ejsng-log:`, lệnh `ejsng.showLogValue`.
- Test: `packages/core/test/runtime-evidence.test.js` (V8 thật), `packages/server/test/runtime-log-type-evidence.test.js` (`node --inspect` thật), e2e `packages/vscode-client/test-e2e/`.

## Ticket

1. [01-format-values.md](issues/01-format-values.md) — core: bộ định dạng một dòng / nhiều dòng / JSON từ `RuntimeValue`; vòng lặp, getter, cắt chuỗi (#1, #2, #6, #8).
2. [02-dig-on-draw.md](issues/02-dig-on-draw.md) — server: đào lúc vẽ có chặn tần suất, giữ `objectId`, trường mới trong notification, setting (#4, #7, #9, #10).
3. [03-expand-on-click.md](issues/03-expand-on-click.md) — server + client: request `ejsng/expandRuntimeLog`, link trong hover, tab JSON chỉ đọc (#3, #5).
4. [04-verify-and-docs.md](issues/04-verify-and-docs.md) — demo `examples/log-at-runtime`, e2e VS Code thật, README + kiến trúc.

Thứ tự: 1 → 2 → 3 → 4 (2 cần 1; 3 cần 2).
