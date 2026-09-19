# Spec: Kiểu đã thấy từ runtime — R1 (giá trị của `console.log` / logpoint)

**Ngày viết:** 2026-09-19 · **Trạng thái:** đã chốt 2026-09-19 (người dùng đồng ý mọi đề xuất) — ticket 01–05, chưa triển khai
**Nối tiếp:** `.scratch/observed-types/spec.md` (bản 1, nguồn tĩnh — xong). Đây là nguồn **R1** trong
"Lộ trình nguồn runtime" của spec đó, cắm vào mô hình **Bằng chứng kiểu (Type Evidence)** (quyết định #8).

## Mục tiêu

Chỗ bản 1 bó tay là dữ liệu tải async: `$scope.rows = res.data` → hover ghi "Could not be inferred —
assigned from `res.data`". Trên repo gọi `$http` nhiều, đó là phần lớn biến đáng hỏi.

R1: khi dev đã **tự log** giá trị đó — `console.log($scope.rows)` trong code, hoặc logpoint
`{vm.rows}` — và pipeline Runtime Log đã nhận log ấy, thì **hình dạng** của giá trị trở thành một
bằng chứng `source: 'runtime'` cho `rows`. Hover trên `vm.rows` trong template lúc đó có kiểu thật:
`{ id: number, name: string, owner: {…} }[]`, kèm "thấy lúc chạy".

Không làm dev phải làm gì mới: không setting, không lệnh. Chỉ log đã được vẽ inline mới được dùng.

## Số liệu đo (V8 của Node 20.20, 2026-09-19)

Đo bằng `node:inspector` trong tiến trình (script ở scratchpad, không vào repo). Chrome dùng cùng
V8 inspector nên kỳ vọng giống — **ticket verify phải đo lại trên Chrome thật**.

| | |
|---|---|
| Preview của object trong `consoleAPICalled` | tối đa **5 key**, còn lại `overflow: true` |
| Preview của mảng | tối đa **100 phần tử**, `overflow: true`; `description: "Array(150)"` |
| Object lồng trong preview (key object, phần tử mảng) | **không có `valuePreview`** — chỉ `{type: "object", value: "Object"}` |
| Getter trong preview / `getProperties` | hiện `type: "accessor"`, **không chạy getter** (đếm: 0 lần) |
| `Runtime.getProperties({ownProperties, generatePreview})` | object 4 key: **0.2 ms**; mảng 150 object: **2.1 ms**, mỗi phần tử có preview 5 key |
| `objectId` trên mỗi arg | có — gọi `getProperties` sau khi nhận log được |

**Hệ quả:** preview không đủ. Với ca chính — `console.log($scope.rows)`, mảng object — preview
**không cho biết key nào của phần tử**. Roadmap cũ ghi R1 "gần như miễn phí"; thực tế phải gọi thêm
`Runtime.getProperties`, có ngân sách (quyết định #3).

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | **Chỉ hai loại log thành bằng chứng:** (a) logpoint, mỗi phần `{expr}` của `logMessage`; (b) lời gọi **trực tiếp** `console.<method>(…)` ở frame đã chọn, mỗi đối số. Wrapper (`logger.debug(x)`, frame đã bị skip pattern bỏ qua) → **không** lấy. | Logpoint: biết chính xác biểu thức và thứ tự arg (mỗi phần của message là một arg). `console.*` trực tiếp: đối số thứ i trong source ứng với `args[i]` của CDP. Wrapper có thể thêm/bớt arg — ghép sai còn tệ hơn không ghép. |
| 2 | **Chỉ đối số là chuỗi property thuần** gốc ở `$scope` / `this` / bí danh `var vm = this` / bí danh tham số `$scope`, trong thân một khai báo Angular có scope: `$scope.rows`, `vm.form.owner`. Truy cập `[i]`, biến cục bộ (`res.data`, `row` trong `forEach`), lời gọi hàm → bỏ. Đích = `(owner, path)` như `ScopeWrite`. | Cùng luật nhận diện với extractor (`thisAliasTest`, `resolveBinding`) → không có hai định nghĩa "đây là scope" lệch nhau. Nối `res.data` → `$scope.rows` qua luồng dữ liệu là suy luận xuyên câu lệnh — ngoài phạm vi. |
| 3 | **Shape đọc từ preview, đào sâu bằng `Runtime.getProperties`** tới đúng giới hạn hover (2 cấp, 8 key/cấp — quyết định #4 bản 1), mảng lấy mẫu **3 phần tử** (đầu, giữa, cuối). **Ngân sách: ≤ 12 lệnh CDP mỗi log**; cùng `(kết nối, chỗ log, arg)` đã đào trong **30 giây** gần nhất → chỉ `count++`, không đào lại. | Số đo: preview không có key phần tử. 2 cấp × 8 key là cái hover hiện được — đào sâu hơn là phí. Mỗi lệnh ~0.2–2 ms phía runtime; log trong vòng lặp nóng không được biến thành hàng nghìn lệnh. |
| 4 | Phần bị cắt (preview `overflow`, hết ngân sách, không đào) → object **"mở"** (`open: true`): key nó có được gộp vào, nhưng key nó **thiếu không bị coi là optional**. Object từ `getProperties` đầy đủ → "đóng", gộp như bản 1. | Luật gộp bản 1 ("key không có ở mọi lần gán → `id?`") sẽ biến mọi key thứ 6 trở đi thành optional nếu coi preview 5 key là đầy đủ — sai có hệ thống. |
| 5 | Luật đổi giá trị → shape: `string`/`number`/`boolean` → primitive có kiểu; `null`, `undefined` → cờ `nullable` của bằng chứng; `function` → function (tham số từ `description` nếu parse được); subtype `date`/`regexp`/`map`/`set`/`promise`/`error` → kiểu có tên (`Date`, `Map`…), không đào; `accessor` → bỏ key (không bao giờ chạy getter); key bắt đầu `$$` (`$$hashKey` do `ng-repeat` gắn) → bỏ. Object **> 50 key hoặc key không phải định danh** → `Record<string, T>` (gộp giá trị làm `T`), không liệt kê key. | Object dạng từ điển (`{ "a@b.com": … }`) có key là **dữ liệu** — liệt kê ra vừa rác vừa lộ dữ liệu cá nhân. `$$hashKey` là rác Angular, không phải dữ liệu của dev. |
| 6 | **Chỉ lưu shape, không bao giờ lưu giá trị** (kể cả chuỗi/số mẫu). Bằng chứng ở RAM của server, theo kết nối: ngắt/nối lại → xoá hết bằng chứng của kết nối đó. Giới hạn: mỗi `(owner, path)` tối đa **20 shape khác nhau** (trùng chữ ký → `count++`, cập nhật `lastSeen`), tổng **2000**; vượt → bỏ cái `lastSeen` cũ nhất. Không ghi cache index. | Quyết định #8 bản 1. Shape đủ cho mục tiêu; giá trị mẫu là thứ dễ rò rỉ nhất. |
| 7 | **Gộp chung với bằng chứng tĩnh** bằng đúng `typeFromEvidence` / `mergeTypes` (một kiểu duy nhất trong hover), lọc **bản controller gần nhất** theo file của chỗ log như bằng chứng tĩnh (quyết định #5 bản 1). Member chỉ có bằng chứng runtime (vd `angular.extend($scope, data)`) vẫn có hover. | Quyết định #8 bản 1: runtime cắm vào không đổi hiển thị. Một kiểu gộp dễ đọc hơn hai kiểu đặt cạnh nhau. |
| 8 | Hover thêm **một dòng nguồn**: "Seen at runtime: 12× — last 14:03:22 via `<nhãn kết nối>`, logged at (link)". Khi có bằng chứng runtime cho path đó, dòng "Could not be inferred — assigned from `res.data`" đổi thành "Not inferred statically (`res.data`) — shape from runtime". Nội dung hover tiếng Anh (CLAUDE.md). | Dev cần biết phần nào là thấy thật, lúc nào, từ kết nối nào (hai container chạy cùng code — lý do `source` đã có trong Runtime Log). |
| 9 | **Inlay hint "may be empty" không đổi:** runtime thấy `null` → hover ghi "seen `null` at runtime", **không** sinh inline hint. | Log chạy ở thời điểm tuỳ ý (trước khi tải xong), không phải lúc render. Hint phải ổn định — không được hiện/mất theo việc đang nối runtime hay không. Cũng khỏi phải đẩy `inlayHint/refresh`. |
| 10 | **Nối log → đích được tính trước, không lúc nhận log:** extractor ghi fact `consoleCalls` (span lời gọi + đích `(owner, path) \| null` của từng đối số; tăng `PARSER_VERSION`); logpoint resolve biểu thức lúc `ejsng/setLogpoints` (biết file + dòng). Lúc nhận log chỉ tra theo `(file, offset)` và chỉ số arg. | Không parse lại file mỗi log. Log chỉ đến server sau khi đã qua chọn frame + kiểm nội dung (Stale File → bị bỏ), nên offset tra được là đúng code đang chạy. |
| 11 | Trong `ejsng/runtimeStatus` / panel checklist: thêm số **bằng chứng kiểu đã thu** mỗi kết nối. Không setting mới. | Để dev biết tính năng đang chạy mà không phải đoán vì sao hover chưa có kiểu. Chi phí chỉ phát sinh khi dev tự log biến scope — đã là opt-in. |

## Loại khỏi phạm vi

- Log qua wrapper/logger; log biến cục bộ rồi mới gán vào scope (`console.log(res.data)`).
- Truy cập chỉ số (`$scope.rows[0]`), biểu thức tính toán trong logpoint (`{rows.length}`, `{a || b}`).
- Log phía Node (Express) — không có `$scope`; EJS local là việc của **R4**.
- Inline hint từ bằng chứng runtime (quyết định #9); hiển thị giá trị mẫu (quyết định #6).
- IntelliJ: hover đi qua LSP nên có sẵn, nhưng Runtime Log chưa có client IntelliJ (`inline-runtime-log/03`) → thực tế chỉ VS Code.

## Rủi ro / chưa biết

- **Chrome có đúng như Node không** (5 key, không `valuePreview` lồng) — đo lại ở ticket verify. Nếu Chrome có preview lồng, ngân sách `getProperties` dùng ít hơn, thiết kế không đổi.
- **Vòng đời `objectId`:** arg của `consoleAPICalled` nằm trong object group `console`, sống tới khi console bị xoá / trang điều hướng. `getProperties` phải chạy ngay khi nhận log; lỗi "Could not find object" → bằng chứng giữ phần preview, đánh dấu `open`.
- Object bị sửa giữa lúc log và lúc `getProperties` (vài ms) — chấp nhận: vẫn là shape thật của cùng object.
- Chữ ký shape để khử trùng (#6) phải rẻ và ổn định (thứ tự key) — chi tiết ở ticket.

## Điểm neo trong code

- `packages/core/src/runtime-log.ts` — `parseConsoleApiCalled`: hiện gộp args thành chuỗi `value`, **bỏ mất `RemoteObject`** → phải giữ lại `args` (type/subtype/preview/objectId/description) trong `ParsedConsoleLog`.
- `packages/core/src/logpoint.ts` — `parseLogMessage` (biểu thức của logpoint), `logpointIdFromUrl`.
- `packages/core/src/extract/js.ts` — `thisAliasTest`, luật owner của `scopeWrites`; nơi thêm fact `consoleCalls`.
- `packages/core/src/types.ts` — `ValueShape` cần `open?` và kiểu có tên (`Date`…); `JsFacts.consoleCalls`.
- `packages/core/src/resolve/observed-type.ts` — `TypeEvidence` đã có `source/connection/count/lastSeen`; `mergeTypes` cần luật object "mở"; `observedTypeOf` nhận thêm bằng chứng runtime (qua `ObservedTypeSource`).
- `packages/server/src/index.ts` — `handleRuntimeLog` (điểm nhận log đã chọn frame + đã kiểm nội dung), `RuntimeLogConnectionInfo.request` (gửi `Runtime.getProperties`), `ejsng/setLogpoints`, `ejsng/disconnectRuntime` / đóng kết nối (xoá bằng chứng), `observedTypeLines` (hover).
- Test: fake CDP trong `packages/server/test/runtime-log-*.test.js`; fixture `RemoteObject` nên chép từ V8 thật (script đo ở trên) thay vì tự bịa.

## Ticket

1. [01-remote-object-to-shape.md](issues/01-remote-object-to-shape.md) — **core — RemoteObject → shape:** hàm thuần từ arg + kết quả `getProperties` ra `ValueShape` (quyết định #4, #5), object "mở" trong `mergeTypes`. Fixture từ V8 thật.
2. [02-link-log-to-scope.md](issues/02-link-log-to-scope.md) — **core — nối log với biến scope:** fact `consoleCalls` (+`PARSER_VERSION`), resolve biểu thức logpoint (#1, #2, #10).
3. [03-collect-runtime-evidence.md](issues/03-collect-runtime-evidence.md) — **server — thu bằng chứng:** giữ `args` trong `ParsedConsoleLog`, đào `getProperties` có ngân sách (#3), kho theo kết nối + giới hạn + xoá khi ngắt (#6), đếm trong `runtimeStatus` (#11). Test fake CDP.
4. [04-hover-runtime-evidence.md](issues/04-hover-runtime-evidence.md) — **server — hover:** gộp vào `observedTypeOf`, dòng nguồn runtime, đổi dòng "could not be inferred" (#7, #8); hint không đổi (#9).
5. [05-verify-and-docs.md](issues/05-verify-and-docs.md) — **verify + docs:** đo lại preview trên Chrome thật với app Angular (`smart-city`), hover thật trong VS Code; CONTEXT (Bằng chứng kiểu runtime), README, kiến trúc 5.3.1 (sửa câu "gần như miễn phí").

Thứ tự: 1 và 2 song song được; 3 cần 1 + 2; 4 cần 3; 5 cuối.
