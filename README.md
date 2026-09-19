# EJS + AngularJS Navigator

Track biến và hàm giữa template **EJS** và controller **AngularJS 1.x** (ES5) — go-to-definition
từ `{{ biểu thức }}` sang `$scope`, find-usages ngược lại từ controller ra template, và phát hiện
code chết.

Một language server (Node/TypeScript), hai client mỏng: **VSCode** và **IntelliJ**.

> Thiết kế đầy đủ và số liệu đo từ codebase thật: [docs/kien-truc.md](docs/kien-truc.md)

## Hiện đã làm được

| | Ví dụ |
|---|---|
| Template → JS | `data-ng-click="selectSection(section)"` → `$scope.selectSection` |
| Property của biến `ng-repeat` | `section.icon` → khoá `icon:` trong object literal của `$scope.sections` |
| Property lồng nhau | `busy.stats` → nhảy đúng vào khoá `stats:` trong object literal |
| Biến cục bộ | `section` trong `ng-repeat="section in sections"` → khai báo tại chỗ |
| `ng-controller` → khai báo | kể cả tên có gạch ngang: `cityos-demo-dha-management-view-controller` |
| JS → Template | `$scope.busy` → mọi chỗ dùng trong mọi template |
| Directive tự viết | `pick-file="onPick($file)"` → `.directive('pickFile', …)` |
| Isolate binding | `<my-widget data="form">` → `bindings: { data: '<' }` |
| Filter | `{{ x | money }}` → `.filter('money', …)` |
| DI | `function ($scope, Api)` → `.factory('Api', …)` (khai báo Angular trước, tham số sau) |
| Biến JS thuần | `const`/`let`/`var`/`function`/tham số, theo đúng phạm vi và che bóng |
| Global liên file | `DHA_STATUS` khai báo ở `dha.const.js` → dùng ở `dha.controller.js` |
| Biến toàn cục | `window`, `JSON`, `$event` → báo "dựng sẵn", không phải lỗi |
| Trục EJS | `<%= denyMessage %>` → locals của `res.render` |
| Dead code | controller / directive / filter / property không ai dùng |
| Rename | `$scope.busy` → đổi đồng bộ mọi lượt đọc/ghi trong JS và mọi template; từ chối kèm lý do khi xung đột |
| Completion theo shape | `busy.` → `search`, `ingest`…; `section.` → khoá của phần tử trong `sections` |
| File đổi ngoài editor | `git pull` / checkout / tool khác → index tự cập nhật (VSCode và IntelliJ), không cần đánh index lại |
| Kiểu đã thấy | hover `vm.rows` → `{ id: number, tags?: string[] }[]` + các chỗ gán; `vm.user` có lúc `= null` → chú thích nhạt `may be empty` |

### Kiểu đã thấy trong hover và inline

Hover trên một biến scope trong template (`vm.rows`, `vm.form.name`, phần tử `row` của `ng-repeat`) —
hoặc trên `$scope.x = …` / `this.x = …` trong file JS — có thêm mục **Observed type**: kiểu gộp từ
**mọi** lần gán trong controller (key không có ở mọi lần gán thành `id?`, khác loại thành `A | B`),
tối đa 5 chỗ gán dạng link, và hai dòng lưu ý khi có: *Can be empty when rendered* (có lần gán
`null`/`undefined`) và *Only assigned in a callback* (chưa có giá trị ở lần render đầu). Không suy
ra được thì ghi lý do và nguồn (`res.data` ở `list.controller.js:30`), không bao giờ ghi `unknown` trơn.

Chú thích **inline** thì cố ý hiếm: chỉ `may be empty` sau biến trong biểu thức Angular khi biến đó
có lần gán tường minh `null`/`undefined`/`void 0`. Không inline cho biến chỉ gán trong callback
(gần như mọi dữ liệu tải async), không inline ở file JS hay EJS local. Tắt bằng
`ejsng.typeHints.nullable`. Bản này chỉ dùng nguồn tĩnh (index); kiểu thấy lúc chạy sẽ đến sau —
xem `docs/kien-truc.md` mục 5.3.

## Bắt đầu

```bash
npm install && npm run build
```

CLI (chạy được ngay, không cần IDE):

```bash
node packages/cli/dist/index.js index --root /duong/dan/toi/repo
```

```bash
node packages/cli/dist/index.js def /duong/dan/view.ejs 41 38 --root /duong/dan/toi/repo
```

```bash
node packages/cli/dist/index.js refs /duong/dan/controller.js 53 11 --root /duong/dan/toi/repo
```

```bash
node packages/cli/dist/index.js unused --root /duong/dan/toi/repo
```

Quét độ phủ — thử resolve **mọi** định danh trong **mọi** template, báo chỗ còn sót:

```bash
node packages/cli/dist/index.js sweep --root /duong/dan/toi/repo
```

Cuối output là danh sách `templateUrl` chưa nối được (biểu thức động, không khớp file nào, hoặc một
template bị gán nhiều controller). Khai `templateRoots` qua CLI bằng
`--template-root /views/=src/views=.ejs,.html` (lặp lại được) và `--views-dir src/views`.

Định vị bằng chuỗi thay vì đếm cột (dùng khi soi một biểu thức cụ thể):

```bash
node packages/cli/dist/probe.js <file> "section.enabled" --offset 8 --root /duong/dan/toi/repo
```

Xem trước rename — liệt kê mọi chỗ sẽ sửa, **không ghi file**:

```bash
node packages/cli/dist/probe.js <file> "\$scope.busy = " --offset 7 --rename isBusy --root /duong/dan/toi/repo
```

`ejsng scan <file>` in ra toàn bộ fact trích được từ một file — công cụ debug chính.

## Chạy thử trên VSCode

Mở thư mục này trong VSCode, F5 để chạy Extension Development Host, rồi mở repo AngularJS của bạn
trong cửa sổ mới.

## Chạy thử trên IntelliJ

`packages/intellij-client` là plugin Gradle dùng **LSP4IJ** (open-source, Red Hat) chứ không
dùng API LSP sẵn của JetBrains — API đó chỉ chạy trên IDE trả phí. Chi tiết license:
[docs/kien-truc.md phụ lục B](docs/kien-truc.md).

Cần một JDK bất kỳ ≥ 17 để chạy Gradle; JDK 21 dùng để biên dịch sẽ được foojay tự tải về.

```bash
cd packages/intellij-client && ./gradlew verifyPluginProjectConfiguration verifyPluginStructure
```

```bash
cd packages/intellij-client && ./gradlew buildPlugin verifyPlugin
```

```bash
cd packages/intellij-client && ./gradlew runIde
```

Artifact cài được: `packages/intellij-client/build/distributions/ejsng-intellij-0.1.0.zip`
(Settings → Plugins → ⚙ → Install Plugin from Disk).

**Node:** plugin tự tìm Node qua `NodeLocator` — hỗ trợ nvm, fnm, volta, asdf, nodenv, và
đường dẫn hệ thống. Cần thiết vì IDE khởi động từ Dock không kế thừa PATH của shell. Ép đường
dẫn cụ thể bằng biến môi trường `EJSNG_NODE`.

## Cấu hình

| Khoá | Mặc định | Ghi chú |
|---|---|---|
| `ejsng.moduleAliases` | `["myApp","app","appModule"]` | Biến giữ angular module nhưng khai báo ở file khác |
| `ejsng.ejsDelimiter` | `"%"` | Đổi thành `"?"` cho `<? ?>` |
| `ejsng.customDirectives` | `{}` | `{"myOn": "statement"}` — directive tự viết của công ty |
| `ejsng.templateRoots` | `[]` | Map `templateUrl` sang file: `[{"urlPrefix": "/views/", "fsPath": "src/views", "extensions": [".ejs", ".html"]}]` — template được nối với controller của directive/component/route/state dùng nó |
| `ejsng.expressViewsDir` | `"views"` | Thư mục view của Express cho `res.render('user/profile')` |
| `ejsng.diagnostics.enabled` | `false` | **Mặc định tắt** để tránh hàng nghìn cảnh báo giả trên code cũ |
| `ejsng.typeHints.nullable` | `true` | Chú thích inline `may be empty` sau biến có lần gán `null`/`undefined`. Hover không có setting. Đổi xong reload window |
| `ejsng.include` / `exclude` | | Glob quét file |

## Kiến trúc

```
packages/core/            Toàn bộ logic — không dính LSP, test độc lập được
  src/ejs/scanner.ts        Quét region EJS, dựng virtual HTML/JS
  src/ng/lexer,parser,ast   Parser biểu thức Angular (KHÔNG phải JS)
  src/ng/microsyntax.ts     ng-repeat / ng-options
  src/ng/normalize.ts       data-ng-* → ngX, bảng cú pháp directive
  src/extract/js.ts         Layer 2: fact từ .js (thuần theo file)
  src/extract/template.ts   Layer 2: fact từ .ejs (thuần theo file)
  src/index/store.ts        Layer 3: NDJSON + bảng tra trong bộ nhớ (phụ lục D)
  src/resolve/linker.ts     Layer 4: nối liên file
  src/resolve/workspace.ts  Truy vấn: definition / references / completion / rename
  src/resolve/rename.ts     Rename: quét $scope, phạm vi khi controller trùng tên
packages/server/          LSP server
  test/lsp.test.js          Test qua stdio: server thật, JSON-RPC như IDE
packages/cli/             CLI — debug và benchmark không cần IDE
packages/vscode-client/   Extension VSCode
packages/intellij-client/ Plugin IntelliJ (Kotlin + LSP4IJ)
fixtures/mini/            Repo thu nhỏ cho test
```

**Ràng buộc quan trọng nhất của codebase này:** fact ở Layer 2 phải là **hàm thuần của nội dung
một file** — không được đọc file khác, không được tra index. Đó là điều kiện để cache đúng.
Mọi kết luận cần thông tin liên file phải nằm ở Layer 4 (`linker.ts`). Khi đổi logic extractor,
**bắt buộc tăng `PARSER_VERSION`** trong `src/index/schema.ts`, nếu không index cũ sẽ bị dùng lại
và cho kết quả sai.

## Test

```bash
npm test
```

Chạy test core và test LSP qua stdio (khởi động server thật). Các test trên repo `smart-city` tự
bỏ qua nếu máy không có repo đó. `spans.test.js` giữ bất biến "mọi span trỏ đúng vào chữ nó đại
diện" — xem [phụ lục I](docs/kien-truc.md).
