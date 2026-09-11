# EJS + AngularJS Navigator

Track biến và hàm giữa template **EJS** và controller **AngularJS 1.x** (ES5) — go-to-definition
từ `{{ biểu thức }}` sang `$scope`, find-usages ngược lại từ controller ra template, và phát hiện
code chết.

Một language server (Node/TypeScript), hai client mỏng: **VSCode** và **IntelliJ**.

> Thiết kế đầy đủ và số liệu đo từ codebase thật: [docs/kien-truc.md](docs/kien-truc.md)

## Hiện đã làm được (M1)

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

Định vị bằng chuỗi thay vì đếm cột (dùng khi soi một biểu thức cụ thể):

```bash
node packages/cli/dist/probe.js <file> "section.enabled" --offset 8 --root /duong/dan/toi/repo
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
| `ejsng.diagnostics.enabled` | `false` | **Mặc định tắt** để tránh hàng nghìn cảnh báo giả trên code cũ |
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
  src/index/store.ts        Layer 3: SQLite
  src/resolve/linker.ts     Layer 4: nối liên file
  src/resolve/workspace.ts  Truy vấn: definition / references / completion
packages/server/          LSP server
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
