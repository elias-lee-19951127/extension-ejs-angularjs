# Kiến trúc: Extension track biến/hàm cho codebase EJS + AngularJS 1.x

## 0. Vấn đề thực sự là gì

"Track biến từ HTML sang JavaScript như React" — trong stack EJS + Angular 1 đây thực chất là
**hai trục hoàn toàn khác nhau**, chạy ở hai thời điểm khác nhau. Phải tách bạch từ đầu, nếu
gộp làm một sẽ sai model dữ liệu.

### Trục A — server-side (EJS)
```
Express: res.render('user/profile', { user, orders })
  └─> views/user/profile.ejs:  <%= user.name %>
        └─> <%- include('partials/order-row', { row: o }) %>
              └─> partials/order-row.ejs:  <%= row.total %>
```
Biến `user` là **locals** của template, chỉ tồn tại lúc render trên server. Nguồn khai báo là
lời gọi `res.render()` / `app.locals` / `res.locals` / middleware.

### Trục B — client-side (Angular 1)
```
angular.module('app').controller('ProfileCtrl', function($scope, UserSvc) {
  this.orders = [];          // controllerAs
  $scope.total = 0;          // scope property
})
  └─> <div ng-controller="ProfileCtrl as vm">
        {{ vm.orders.length }}          <-- resolve về `this.orders`
        <li ng-repeat="o in vm.orders"> <-- `o` là biến scope mới, kiểu = element của vm.orders
          {{ o.total | currency }}      <-- `currency` resolve về .filter('currency', ...)
```

### Giao điểm (chỗ hay bug nhất, và là điểm bán hàng của extension)
```html
<!-- EJS bơm dữ liệu server vào Angular -->
<script>window.BOOT = <%- JSON.stringify(bootstrapData) %>;</script>
<div ng-init="ctx = <%- JSON.stringify(ctx) %>">
```
Không tool nào hiện có nối được hai đầu này. Đây là chỗ extension tạo giá trị rõ rệt nhất so
với WebStorm/VSCode built-in.

**Kết luận model:** một file `.ejs` chứa **ba ngôn ngữ lồng nhau** (EJS-JS server, HTML,
Angular-expression client) và tham chiếu ra **hai đồ thị symbol tách rời**. Index phải phản ánh
đúng chuyện đó.

---

## 1. Kiến trúc tổng thể: 1 language server, 2 client mỏng

```
┌──────────────────┐   ┌──────────────────┐
│ VSCode extension │   │ IntelliJ plugin  │
│ (TS, ~300 LOC)   │   │ (Kotlin, ~200)   │
│ vscode-languagecl│   │ LSP4IJ           │
└────────┬─────────┘   └────────┬─────────┘
         └──── stdio / JSON-RPC ─┘
                    │
        ┌───────────▼─────────────────────────────┐
        │  ejs-ng-language-server  (Node 20, TS)  │
        │  ┌────────────────────────────────────┐ │
        │  │ Layer 1  Scanner/Parser            │ │
        │  │ Layer 2  Fact extractor (per-file) │ │  <- pure, cache được
        │  │ Layer 3  Index store (SQLite)      │ │
        │  │ Layer 4  Linker + Resolver         │ │  <- in-memory, dựng từ L3
        │  │ Layer 5  LSP feature handlers      │ │
        │  └────────────────────────────────────┘ │
        └─────────────────────────────────────────┘
```

**Vì sao LSP chứ không viết 2 plugin native:** logic resolve Angular scope là phần khó và
chiếm ~85% công sức. Viết 2 lần (TS cho VSCode, Kotlin/PSI cho IntelliJ) là tự sát. LSP cho
phép viết 1 lần, 2 client chỉ còn là adapter.

**Giá phải trả:** IntelliJ qua LSP không hòa vào PSI native → refactor rename kiểu IntelliJ,
structure view, inspection tùy biến sẽ hạn chế hơn. Chấp nhận được ở v1.

### IntelliJ: chọn cầu nối nào
| Cách | Chạy trên | Đánh giá |
|---|---|---|
| **LSP4IJ** (Red Hat, open-source) | Community + Ultimate + WebStorm | **Chọn cái này.** Hỗ trợ definition/references/hover/completion/rename/diagnostics. Không khóa theo license IDE. |
| `com.intellij.platform.lsp` (API sẵn của JetBrains, từ 2023.2) | **chỉ IDE trả phí** | Loại — team dùng Community sẽ không cài được. |
| Plugin native Kotlin + `FileBasedIndex` + PSI | mọi IDE | Chất lượng UX cao nhất nhưng gấp ~3 lần công. Để dành v2 nếu LSP4IJ không đủ. |

Đóng gói: bundle luôn Node runtime hoặc yêu cầu Node >= 18 trên máy dev (team đã có sẵn Node).

---

## 2. Layer 1 — Parser

### 2.1 EJS scanner (tự viết, ~250 LOC)
EJS không phải HTML hợp lệ, không parser HTML nào nuốt được thẳng. Cách làm:

1. Quét tuyến tính tìm delimiter: `<%` `<%=` `<%-` `<%#` `<%_` … `%>` `-%>` `_%>`, xử lý
   `<%%` (escape literal). Delimiter phải **đọc từ config** (`ejs.delimiter`, nhiều team đổi
   sang `<? ?>`).
2. Kết quả: danh sách region `{kind: 'html'|'script'|'output'|'comment', range}`.
3. Tạo **virtual HTML document**: thay mỗi region EJS bằng đúng số ký tự khoảng trắng
   → offset giữ nguyên 1:1, không cần source map cho tầng HTML. Đây là mẹo quan trọng, tiết
   kiệm rất nhiều bug off-by-one.
4. Tạo **virtual JS document** cho trục A: nối các region script/output lại, lần này *có*
   source map (offset không còn 1:1). Wrap trong `function(locals){ with(locals){ ... } }`
   để mô phỏng đúng scope EJS.

Cạm bẫy: EJS cho phép cắt HTML giữa chừng —
`<% if (x) { %><div><% } %>` → virtual HTML có `<div>` không đóng thẻ. Parser HTML **bắt buộc
phải error-tolerant**, và khi build cây DOM phải chấp nhận cây rách.

### 2.2 HTML parser
Dùng **`angular-html-parser`** (fork parser của Angular team, Prettier đang dùng): error
tolerant, giữ đầy đủ vị trí cho cả tên lẫn giá trị attribute — thứ `parse5` không cho tiện bằng.
Cần vị trí *bên trong* giá trị attribute vì `ng-click="vm.save(item)"` phải map được từng
identifier.

### 2.3 Angular expression parser
**Đừng dùng acorn cho biểu thức Angular.** Angular expression là một ngôn ngữ riêng, khác JS:
- có filter pipe `a | date:'short'`
- có one-time binding `::expr`
- không có `new`, `function`, `;`, không truy cập được `window`
- `ng-repeat` có microsyntax riêng: `item in items | filter:q as results track by item.id`

Cách rẻ và đúng nhất: **port thẳng Lexer + AST builder từ `angular.js/src/ng/parse.js`** (MIT),
bỏ phần compile-to-function, chỉ giữ AST, thêm trường `start`/`end` cho từng node. Khoảng 600
LOC copy về. Tự viết Pratt parser cũng được nhưng sẽ mất vài tuần đuổi theo các case lẻ.

Mỗi directive cần một **parse strategy** riêng, khai báo bằng bảng:
```ts
const DIRECTIVE_SYNTAX: Record<string, ExprKind> = {
  'ng-repeat':   'repeat-microsyntax',
  'ng-options':  'options-microsyntax',
  'ng-if':       'expression',
  'ng-click':    'statement',      // cho phép nhiều câu ngăn bởi ';'
  'ng-model':    'assignable',     // phải là LHS gán được
  'ng-class':    'expression',
  // ...
};
```
Bảng này phải **mở rộng được qua config** để khai báo directive tự viết của công ty.

### 2.4 JavaScript ES5
`acorn` với `ecmaVersion: 5` (nới lên 2018 nếu có file đã dùng ES6 lẫn lộn), fallback
`acorn-loose` khi file đang gõ dở. Cần `locations: true` + `ranges: true`.

---

## 3. Layer 2 — Fact extractor (phần quyết định chất lượng cache)

**Nguyên tắc bất di bất dịch: fact của một file phải là hàm thuần của nội dung file đó.**
Không được nhìn sang file khác. Vi phạm điều này là cache sai, và bug cache sai cực khó tìm.
Mọi thứ cần thông tin liên file dồn hết xuống Layer 4.

Fact trích ra từ file `.js`:
```ts
type JsFacts = {
  ngDeclarations: Array<{           // .controller/.service/.factory/.directive/.filter/.component/.value/.constant/.provider
    kind, name, nameRange, bodyRange,
    deps: string[],                  // DI: cả array-annotation lẫn $inject lẫn implicit
    depsRanges: Range[],
  }>;
  // với controller/directive-controller:
  scopeWrites: Array<{ path: 'this.foo' | '$scope.foo', name, range, valueKind }>;
  scopeReads:  Array<{ path, name, range }>;
  routeBindings: Array<{            // $routeProvider / $stateProvider / component router
    templateUrl?: string, template?: string,
    controller?: string, controllerAs?: string, ranges
  }>;
  ddo: Array<{                      // directive definition object
    selector, restrict, templateUrl?, scope?: Record<attr, '='|'@'|'&'|'<'>,
    bindToController?, controllerAs?, transclude?
  }>;
  // trục A:
  renderCalls: Array<{ viewPath: string, localsKeys: string[], ranges }>;  // res.render(...)
};
```

Fact trích ra từ file `.ejs`:
```ts
type EjsFacts = {
  localsUsed:  Array<{ name, path: string[], range }>;   // trục A
  includes:    Array<{ viewPath, passedKeys, range }>;   // trục A
  ngContexts:  Array<{                                    // trục B
    elementRange,
    ngController?: { name, alias, range },
    ngRepeat?:     { itemVar, indexVars, listExpr, range },
    ngInit?:       { assignedVars },
    directiveTags: string[],       // để nối với DDO
  }>;
  ngExpressions: Array<{ ast, range, contextChain: ElementPath }>;
  bridges: Array<{ jsVarName, ejsExpr, range }>;          // giao điểm A×B
};
```

Kỹ thuật cần lưu ý:
- **DI resolution** phải bắt được cả 3 dạng: `function(a, b)`, `['a','b', function(a,b){}]`,
  `Foo.$inject = ['a','b']`. Dạng 1 sẽ vỡ khi minify nhưng vẫn phổ biến trong code cũ.
- **`.controller('X', fn)` với `fn` khai báo nơi khác** — lưu tên, để Layer 4 nối.
- `$scope.$watch('someExpr', ...)` và `$emit/$on/$broadcast('event')` cũng nên index: đây là
  loại "biến/hàm dạng chuỗi" mà không IDE nào track được, giá trị rất cao khi refactor.

---

## 4. Layer 3 — Chiến lược đánh index

Đây là câu hỏi chính của bạn. So sánh các phương án:

> ⚠️ **Mục này đã SAI và đã được sửa. Xem phụ lục D.** Khuyến nghị SQLite dưới đây bỏ sót
> ràng buộc quyết định nhất: native module không dùng được trong IDE extension.

| Phương án | Cold start | Warm start | RAM | Truy vấn ngược | Nhận xét |
|---|---|---|---|---|---|
| In-memory Map thuần | chậm mỗi lần mở | = cold | cao | tự build | Chỉ hợp repo < 500 file |
| **NDJSON + index in-memory** | nhanh | **nhanh** | vừa | tự build | **Đây mới là lựa chọn đúng — phụ lục D** |
| ~~SQLite (better-sqlite3)~~ | chậm 1 lần | nhanh | thấp | SQL index lo | ❌ **Native module — vỡ trong IDE** |
| LMDB / RocksDB | tương tự | nhanh | thấp | tự build | ❌ Cũng là native module, cùng vấn đề |
| sql.js (SQLite WASM) | chậm hơn | chậm hơn | cao | SQL lo | Thuần JS nhưng nạp cả DB vào RAM; thừa ở quy mô này |
| Tantivy/Lucene | — | — | — | — | Overkill, đây là symbol index không phải full-text search |

### Schema đề xuất
```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE, mtime INT, size INT,
  hash TEXT,              -- xxhash64 nội dung
  facts BLOB,             -- JSON đã nén, output Layer 2
  parser_version INT      -- bump khi đổi logic extractor => tự invalidate toàn bộ
);
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY, file_id INT, kind TEXT, name TEXT,
  container TEXT,         -- 'ProfileCtrl' cho scope property
  line INT, col INT, end_line INT, end_col INT
);
CREATE INDEX idx_sym_name ON symbols(name);
CREATE INDEX idx_sym_container_name ON symbols(container, name);

CREATE TABLE refs (
  id INTEGER PRIMARY KEY, file_id INT, symbol_name TEXT, container TEXT,
  axis TEXT,              -- 'ejs-locals' | 'ng-scope' | 'ng-di' | 'event' | 'bridge'
  line INT, col INT, end_line INT, end_col INT,
  resolved_symbol_id INT  -- NULL = chưa resolve được (dùng để báo diagnostic)
);
CREATE INDEX idx_ref_name ON refs(symbol_name, container);

CREATE VIRTUAL TABLE symbols_fts USING fts5(name, content=symbols);
```

### Quy trình index
1. **Discovery**: `fast-glob` quét theo `include`/`exclude` từ config, bỏ `node_modules`,
   `bower_components`, `dist`, `*.min.js`.
2. **Cold index song song**: `worker_threads`, pool = `os.cpus().length - 1`. Mỗi worker nhận
   một batch path, trả về `JsFacts`/`EjsFacts`. Ghi SQLite theo transaction batch 500 file
   (ghi từng file một sẽ chậm gấp 50 lần).
3. **Warm start**: đọc `files(path, mtime, hash)`, `stat` toàn bộ file, chỉ re-parse file lệch.
   Với repo 5.000 file mục tiêu < 1s.
4. **Incremental khi gõ**: debounce 150ms → parse lại **chỉ file đang mở** từ nội dung trong
   buffer (không đọc đĩa) → cập nhật fact in-memory overlay, chưa ghi SQLite. Ghi khi save.
   Mục tiêu < 20ms/file.
5. **Invalidate liên file**: giữ một `dependency graph` in-memory (Layer 4). Sửa
   `ProfileCtrl.js` **không** cần re-parse `profile.ejs`, chỉ cần dựng lại binding của các
   template trỏ tới nó. Đây chính là lý do phải tách Layer 2 / Layer 4.
6. **File watcher**: `chokidar` cho thay đổi ngoài IDE (git checkout, pull). Khi phát hiện
   > 20% file đổi (dấu hiệu đổi branch) → re-index nền toàn bộ thay vì từng file.

### Mục tiêu hiệu năng (repo ~5.000 file, ~1.5M LOC)
| Thao tác | Mục tiêu |
|---|---|
| Cold index (8 core) | < 30s, có progress bar, IDE dùng được ngay ở chế độ suy giảm |
| Warm start | < 1s |
| Re-index 1 file khi gõ | < 20ms |
| Go-to-definition | < 30ms |
| Find-all-references toàn repo | < 200ms |
| RAM thường trú | < 300MB |

---

## 5. Layer 4 — Linker & Resolver (phần khó nhất)

### 5.1 Nối template ↔ controller
Nguồn liên kết, xếp theo độ tin cậy giảm dần:
1. `ng-controller="Foo as vm"` ngay trong markup — chắc chắn nhất.
2. DDO của directive: `templateUrl` + `controller` + `controllerAs` + `scope`/`bindToController`.
3. `$routeProvider.when(..., {templateUrl, controller, controllerAs})`.
4. `$stateProvider.state(..., {views: {...}})` (ui-router — chú ý named views).
5. `.component('foo', {templateUrl, controller, bindings})`.
6. **Heuristic dự phòng**: trùng tên file (`profile.ejs` ↔ `profile.controller.js`) hoặc cùng
   thư mục. Chỉ dùng khi 1–5 thất bại, và phải đánh dấu `confidence: 'low'` để UI hiển thị khác.

**Vấn đề đặc thù EJS:** `templateUrl: '/views/profile.html'` là URL runtime, không phải đường
dẫn đĩa, và file thật có thể là `.ejs`. Cần config map:
```jsonc
{
  "templateRoots": [
    { "urlPrefix": "/views/",     "fsPath": "src/views",     "extensions": [".ejs", ".html"] },
    { "urlPrefix": "/templates/", "fsPath": "public/tpl" }
  ],
  "expressViewsDir": "src/views"   // cho trục A: res.render('user/profile')
}
```
Nếu `templateUrl` là biểu thức động (`templateUrl: base + '/x.html'`) → bỏ qua, ghi nhận vào
báo cáo "unresolved links" để người dùng biết mà khai báo tay.

### 5.2 Scope chain resolver
Với mỗi element trong virtual DOM, dựng **scope chain** đi từ node lên root:
```
<body ng-controller="AppCtrl as app">        scope0: {app: AppCtrl}
  <div ng-controller="ProfileCtrl as vm">    scope1: parent=scope0, {vm: ProfileCtrl}
    <li ng-repeat="o in vm.orders">          scope2: parent=scope1, {o, $index, $first,
                                                      $last, $middle, $even, $odd, $id}
      {{ o.total }}                          resolve `o` -> scope2 -> element của vm.orders
```
Quy tắc:
- Directive có `scope: {...}` → **isolate scope**, cắt chain (trừ `$parent`). Các key trong
  object scope trở thành biến, và ánh xạ ngược ra attribute trên thẻ gọi.
- `bindToController: true` → binding gắn vào `this` chứ không phải `$scope`.
- `transclude` → nội dung transclude dùng scope của **chỗ gọi**, không phải của directive.
  Đây là case hay resolve sai nhất.
- `ng-init`, `ng-repeat ... as x`, `ng-if` (tạo child scope!), `ng-switch`, `ng-include`
  (tạo child scope), form/`ng-form` (đưa tên form vào scope, `myForm.$valid`...).
- Danh sách biến dựng sẵn: `$event` trong `ng-click`, `$index`... trong `ng-repeat`.

Kết quả resolve có 3 mức: `resolved` / `ambiguous` (nhiều controller khớp) / `unresolved`.
UI phải phân biệt được — báo "unresolved" như lỗi trong codebase legacy sẽ tạo hàng nghìn
false positive và người dùng tắt extension ngay.

### 5.3 Suy luận kiểu (mức vừa đủ)
Không cần type system đầy đủ. Cần đúng một thứ: **shape của object** để completion `vm.user.`
gợi ý được `name`, `email`. Cách rẻ:
- Lần theo `this.user = {...}` literal → lấy key.
- `this.users = []` + `this.users.push({...})` → element shape.
- `UserSvc.get().then(function(r){ this.user = r.data })` → bó tay, trả `any`.

Nếu muốn hơn mức này → xem mục 6.

---

## 6. Ngã rẽ lớn: tự viết resolver vs. virtual-TS (kiểu Volar)

### Hướng 1 — Tự viết resolver (mục 5)
Toàn quyền kiểm soát, không phụ thuộc tsserver, nhanh, RAM thấp. Nhưng: type inference yếu,
rename phải tự cài đặt, completion chỉ tốt ở mức property đã khai báo tường minh.

### Hướng 2 — Sinh virtual TypeScript + source map, giao cho tsserver
Đây là cách Vue (Volar) và Angular Language Service đang làm. Với template:
```html
<li ng-repeat="o in vm.orders">{{ o.total | currency }}</li>
```
sinh ra file ảo `profile.ejs.__ng.ts`:
```ts
import { ProfileCtrl } from './profile.controller';
function __tpl(vm: ProfileCtrl) {
  for (const o of vm.orders) {
    __filter_currency(o.total);
  }
}
```
kèm source map từng token về range trong `.ejs`. Sau đó **gọi thẳng tsserver** cho
definition / completion / rename / hover / diagnostics và map ngược kết quả.

| | Tự viết resolver | Virtual TS |
|---|---|---|
| Công sức tầng resolve | cao | thấp (tsserver lo) |
| Công sức tầng codegen + sourcemap | không có | **cao, và là chỗ sinh bug** |
| Type inference | yếu | mạnh (`allowJs` + JSDoc, suy được cả qua service) |
| Rename an toàn | tự làm, dễ sót | gần như miễn phí |
| Hiệu năng trên repo ES5 1.5M LOC | tốt | **rủi ro** — tsserver ăn RAM và chậm với JS không type |
| Phụ thuộc | không | tsserver (API bán chính thức, đổi giữa các bản TS) |

**Khuyến nghị: đi Hướng 1 trước, thiết kế Layer 4 sau một interface `Resolver`** để có thể cắm
Hướng 2 vào sau cho các feature cần inference sâu (completion, rename), giữ Hướng 1 cho
definition/references (nhanh, luôn hoạt động). Kiến trúc lai này là điểm cân bằng tốt nhất:
80% giá trị đến từ go-to-definition và find-references, hai thứ Hướng 1 làm tốt và rẻ.

**Không khuyến nghị Tree-sitter** ở đây: lợi thế của nó là incremental parse cho file khổng lồ,
nhưng file Angular 1 thường nhỏ, còn acorn đã đủ nhanh và cho AST dễ làm việc hơn nhiều.

---

## 7. Danh sách feature, xếp theo tỉ lệ giá trị/công sức

| # | Feature | Trục | Giá trị | Công |
|---|---|---|---|---|
| 1 | Go-to-definition: `{{vm.foo}}` → `this.foo` trong controller | B | ★★★★★ | vừa |
| 2 | Find-all-references: `this.foo` → mọi chỗ dùng trong template | B | ★★★★★ | vừa |
| 3 | Go-to-definition: `<%= user.name %>` → `res.render(..., {user})` | A | ★★★★☆ | thấp |
| 4 | Hover: hiện signature/khai báo + đường dẫn nguồn | A+B | ★★★☆☆ | thấp |
| 5 | Completion trong template (`vm.` → danh sách property) | B | ★★★★☆ | cao |
| 6 | Diagnostic: dùng biến không tồn tại trên scope | B | ★★★★☆ | vừa |
| 7 | Diagnostic: dead code — controller/filter/service không ai dùng | A+B | ★★★★☆ | thấp |
| 8 | Go-to-definition cho DI (`function(UserSvc)` → `.service('UserSvc')`) | B | ★★★★☆ | thấp |
| 9 | Rename đồng bộ JS ↔ template | B | ★★★☆☆ | cao |
| 10 | Track `$emit`/`$on`/`$broadcast` theo tên event | B | ★★★☆☆ | thấp |
| 11 | Track `include()` chain của EJS | A | ★★★☆☆ | thấp |
| 12 | CodeLens "3 usages in templates" trên controller property | B | ★★☆☆☆ | thấp |

#8, #7, #10, #11 là các món **rẻ mà rất được việc** — nên nhét sớm, không đợi.

---

## 8. Lộ trình

**Spike 1 tuần — trả lời câu hỏi sinh tử:** viết script Node đọc repo thật của công ty, đếm:
tỉ lệ template nối được với controller bằng mỗi cách trong 5.1; số `templateUrl` động; số
directive tự viết; số file EJS cắt HTML giữa chừng. **Không thiết kế tiếp trước khi có số này** —
nếu chỉ 40% template nối được thì phải đầu tư mạnh vào cơ chế mapping thủ công qua config.

- **M1 (2–3 tuần)** — Monorepo, EJS scanner, HTML parser, acorn extractor, SQLite index,
  LSP server chạy được. Feature #1 + #2 + #8. Client VSCode.
- **M2 (2 tuần)** — Scope chain resolver đầy đủ (ng-repeat, isolate scope, transclude).
  Feature #4, #6, #10, #12. Client IntelliJ qua LSP4IJ.
- **M3 (2 tuần)** — Trục A: `res.render` + include chain (#3, #11), bridge A×B. Feature #7.
- **M4 (3 tuần)** — Completion (#5) và rename (#9), cân nhắc cắm virtual-TS ở bước này.

## 9. Cấu trúc repo

```
packages/
  core/            # parser, extractor, index, resolver — không dính LSP, test được độc lập
  server/          # LSP wrapper quanh core
  vscode-client/   # extension VSCode
  intellij-client/ # plugin Gradle + Kotlin, LSP4IJ
  cli/             # index/query từ terminal — cực kỳ quan trọng để debug và benchmark
fixtures/          # repo Angular 1 + EJS thu nhỏ, dùng cho snapshot test
```
`packages/cli` không phải thứ phụ: nó cho phép chạy `ejsng refs vm.orders` trong terminal, so
sánh output trước/sau, và benchmark mà không cần mở IDE. Có nó thì tốc độ phát triển khác hẳn.

## 10. Rủi ro đã nhận diện

| Rủi ro | Giảm thiểu |
|---|---|
| Nối template↔controller tỉ lệ thấp → extension vô dụng | Spike 1 tuần đo trước; có cơ chế khai báo mapping tay trong config |
| `templateUrl` động, string concat | Chấp nhận bỏ, xuất báo cáo "unresolved" cho người dùng khai báo tay |
| False positive diagnostic tràn lan trên code legacy | Mặc định TẮT diagnostic; bật dần theo thư mục; luôn có mức `confidence` |
| Directive tự viết của công ty không hiểu được | Bảng directive mở rộng qua config từ ngày đầu, không hardcode |
| EJS đổi delimiter | Đọc từ config, không hardcode `<% %>` |
| IntelliJ qua LSP thiếu tính năng native | Đo mức chấp nhận với team ở M2; dự phòng plugin native ở v2 |

---

# PHỤ LỤC A — Số liệu đo thật từ repo `smart-city` (2026-09-10)

Đo trên `/Volumes/mac-dev/project/smart-city` (143 file `.js`, 3 file `.ejs`). Repo này là bản
demo/patch nên nhỏ, nhưng **phong cách code là đại diện** và nó lật ngược vài giả định ở trên.

## A.1 Kết quả đếm

| Tín hiệu | files | occurrences | Ý nghĩa |
|---|---|---|---|
| `$scope` | 6 | **365** | Toàn bộ theo kiểu `$scope`, không phải `controllerAs` |
| `controllerAs` | 0 | **0** | **Không dùng controllerAs** |
| `templateUrl` | 0 | **0** | **Không có template rời** |
| `$routeProvider` / `$stateProvider` | 0 | **0** | **Không có client-side routing** |
| `ng-controller` (mọi biến thể) | 3 | 3 | **Nguồn link duy nhất, và là nguồn tin cậy nhất** |
| `data-ng-*` | — | ~155 | **Gần như 100% dùng tiền tố `data-`** |
| `ng-*` trần | — | 4 | thiểu số |
| `{{ }}` | 27 | 170 | |
| `$scope.<name>` duy nhất | — | 76 | Quy mô symbol table nhỏ, dễ xử lý |
| `.filter(` | 26 | 54 | **0/54 là Angular filter** — tất cả là `Array.prototype.filter` |

## A.2 Năm điều chỉnh thiết kế bắt buộc

**1. Tỉ lệ link template↔controller ≈ 100%, không phải rủi ro.**
Rủi ro lớn nhất mình nêu ở mục 10 **không tồn tại trong repo này**. Không có `templateUrl` động,
không routing — mọi template khai báo controller ngay trong markup bằng `data-ng-controller`.
Đây là nguồn tin cậy nhất (mục 5.1 #1). ⇒ **Bỏ toàn bộ phần resolve `$routeProvider`/
`$stateProvider`/`templateUrl` khỏi M1.** Tiết kiệm khoảng 1 tuần.

**2. Mục tiêu resolve là `$scope.X`, KHÔNG phải `this.X`.**
Trong template, tên trần `{{ stats.total }}` / `data-ng-click="selectSection(section)"` phải
resolve về `$scope.stats` / `$scope.selectSection` trong controller. `controllerAs` vẫn phải hỗ
trợ (code mới có thể dùng) nhưng xếp sau.

**3. BẮT BUỘC chuẩn hoá tên directive.** Repo dùng `data-ng-*` gần như tuyệt đối:
```
data-ng-click 39 · data-ng-if 31 · data-ng-model 23 · data-ng-disabled 19
data-ng-class 14 · data-ng-repeat 11 · data-ng-controller 2 · data-ng-init 1
data-ng-attr-accept 1
```
Nếu chỉ khớp `ng-repeat` thì **miss 11/12 ng-repeat**. Phải cài đúng thuật toán chuẩn hoá của
Angular: bỏ tiền tố `x-` / `data-`, rồi đổi `:` `-` `_` sang camelCase.
Chú ý `data-ng-attr-accept` → `ngAttrAccept`, một họ directive riêng.

**4. Object-literal shape inference đủ dùng — chưa cần virtual-TS.**
Pattern gán thực tế rất "ngoan":
```js
$scope.busy       = { search:false, ingest:false, maintain:false, stats:false, ... };
$scope.uploadForm = { fileName:'', contentBase64:'', byteSize:0, title:'', docType:'custom' };
$scope.documents  = [];
```
Chỉ cần đọc object literal là completion cho `busy.` / `uploadForm.` chạy tốt.
⇒ **Củng cố quyết định đi Hướng 1 (tự viết resolver), hoãn virtual-TS vô thời hạn.**

**5. Regex là không dùng được — phải AST.** 54/54 lần `.filter(` trong repo là
`Array.prototype.filter`, **không có một Angular filter nào**. Extractor dựa regex sẽ cho
100% false positive ở đây. Bắt buộc: đi qua AST và xác thực chuỗi module
(`angular.module(...)` hoặc biến giữ module) trước khi coi `.filter(`/`.service(` là khai báo.

## A.3 Hai điều đã dự đoán đúng, nay được xác nhận

**EJS cắt HTML giữa chừng — có thật, và ở mức cực đoan:** cả file bọc trong một `if`
```html
<% if (checkViewACL("cityos-demo-dha-management-view")) { %>
  <div data-ng-controller="..."> ... </div>
<% } else { %> ... <% } %>
```
Parser HTML bắt buộc error-tolerant, và mẹo "thay region EJS bằng khoảng trắng cùng độ dài" là
điều kiện đủ để cây DOM không vỡ. Cả hai nhánh `if`/`else` phải cùng nằm trong một cây.

**Trục A có thật:** `checkViewACL(...)` là helper server bơm vào EJS locals — đúng dạng symbol
mà trục A cần track.

## A.4 Phát sinh mới, chưa có trong thiết kế gốc

**a) Tên controller là chuỗi có dấu gạch ngang, không phải identifier:**
`'cityos-demo-dha-management-view-controller'`. Symbol name phải là chuỗi tự do, không được
validate theo luật identifier JS.

**b) Module tham chiếu qua biến, có biến khai báo ở file khác:**
```js
const appModule = angular.module("cityosDemo", []);   // web/js/app.js  — trong file
appModule.controller("MainController", [...]);
myApp.controller('cityos-demo-...', [...]);           // product/... — `myApp` KHÔNG khai báo trong file
```
`myApp` là global do platform cấp. ⇒ Extractor cần: (1) lần theo biến giữ `angular.module()`
trong cùng file; (2) khi biến chưa biết, vẫn **chấp nhận** `<ident>.controller('name', ...)`
như một khai báo với `confidence: 'medium'`; (3) config `moduleAliases: ["myApp"]` để nâng lên
`high`. Bắt buộc phải làm — nếu không sẽ mất luôn controller chính của repo.

**c) Convention thư mục:** `product/view/content.ejs` ↔ `product/view/public/javascripts/index.js`.
Là heuristic dự phòng tốt khi `ng-controller` vắng mặt.

## A.5 Ưu tiên M1 sau khi đo lại

| Bỏ khỏi M1 | Thêm vào M1 |
|---|---|
| Resolve `$routeProvider` / `$stateProvider` | Chuẩn hoá `data-ng-*` / `x-ng-*` / `ng:` / `ng_` |
| Resolve `templateUrl` → đường dẫn đĩa | Xác thực chuỗi module trước khi nhận khai báo |
| Ưu tiên `controllerAs` | Ưu tiên `$scope.X`; shape từ object literal |

---

# PHỤ LỤC B — Chuyện license của IntelliJ (kiểm chứng 2026-09-10)

## B.1 Viết plugin có tốn tiền không?

**Không.** IntelliJ Platform SDK, `intellij-platform-gradle-plugin`, và việc publish lên
JetBrains Marketplace đều miễn phí (SDK là Apache 2.0). Không có phí API cho người viết plugin.

Tiền nằm ở chỗ khác: **IDE mà người dùng cuối chạy**. Chọn API sai thì plugin chỉ cài được trên
IDE trả phí — không phải bạn trả, mà là cả team phải trả.

## B.2 Ba tầng, chỉ một tầng dính license

| Thành phần | Miễn phí? | Ghi chú |
|---|---|---|
| IntelliJ Platform SDK, Gradle plugin, Marketplace | ✅ | Apache 2.0 |
| **`com.intellij.platform.lsp`** (API LSP sẵn của JetBrains) | ❌ | **Chỉ IDE thương mại** |
| **LSP4IJ** (Red Hat) | ✅ | EPL, không phụ thuộc tier |
| Node runtime chạy language server | ✅ | |

Tài liệu JetBrains nói rõ về API LSP của họ: tích hợp LSP được làm như một phần mở rộng cho các
IDE thương mại, nên plugin dùng nó **không hoạt động trên bản open-source của IntelliJ IDEA và
trên Android Studio**.

⇒ Quyết định chọn **LSP4IJ** ở mục 1 được giữ nguyên, và nay có thêm một lý do mạnh hơn: bề mặt
license của JetBrains đang thay đổi (xem B.3), còn LSP4IJ thì miễn nhiễm với chuyện đó.

## B.3 Bối cảnh đã đổi từ 2026-03, và phần không đổi

IntelliJ IDEA 2026.1 đưa **core JS/TS/HTML/CSS thành miễn phí**: syntax highlighting đầy đủ,
code completion, quản lý import, refactor cơ bản, tích hợp Prettier/ESLint, và React cơ bản.

Nhưng phần **vẫn thuộc Ultimate** mới là phần quan trọng với dự án này:

> debugger riêng, test runner, **hỗ trợ mọi framework frontend bao gồm Angular, Vue**,
> refactoring nâng cao

Nghĩa là: **JetBrains sẽ không cho team bạn Angular support ở tier miễn phí.** Và kể cả trả tiền
Ultimate, nó cũng không hiểu template `.ejs` — nơi mà toàn bộ markup của repo `smart-city` nằm.

⇒ Điều này làm plugin **có giá trị hơn**, không kém: nó là con đường duy nhất để có navigation
Angular trên tier miễn phí, và là con đường duy nhất — kể cả trên Ultimate — để hiểu `data-ng-*`
bên trong file `.ejs` bị cắt bởi `<% if %>`.

## B.4 Điểm chưa chắc chắn, và cách né

Tài liệu nói API LSP không có trên "IntelliJ IDEA open source builds". JetBrains đã hợp nhất
IntelliJ IDEA thành một bản phân phối có tier miễn phí, nên **không rõ tier miễn phí của bản hợp
nhất có tính là "open source build" hay không** (với PyCharm thì họ đã mở cho bản không Pro từ
2025.1). Chưa kiểm chứng được điểm này.

Không cần trả lời câu đó: dùng LSP4IJ thì câu hỏi không phát sinh.

## B.5 Bug đã sửa nhờ rà lại phần này

`plugin.xml` ban đầu khai báo:

```xml
<languageMapping language="JavaScript" serverId="ejsng"/>
```

Language ID `JavaScript` **chỉ tồn tại khi plugin JavaScript có mặt**. Trên IDE thiếu nó
(IDEA Community trước 2026.1, Android Studio), mapping này im lặng không làm gì — plugin cài
được, khởi động được, nhưng không phản hồi trong file `.js`, trông y như hỏng mà không có
thông báo lỗi nào.

Đã đổi sang khớp theo tên file, chạy ở mọi bản:

```xml
<fileNamePatternMapping patterns="*.js" serverId="ejsng" languageId="javascript"/>
```

Đây là lý do `packages/cli` tồn tại: kiểm chứng được toàn bộ tầng core mà không phụ thuộc bất kỳ
license IDE nào.

---

# PHỤ LỤC C — Build plugin IntelliJ: những gì đo được khi làm thật (2026-09-10)

Đã cài JDK và build thật. Mọi phiên bản mình phỏng đoán ban đầu đều sai, ghi lại để không
phải dò lại.

## C.1 Phiên bản đúng

| Thành phần | Đoán ban đầu | **Thực tế** | Vì sao |
|---|---|---|---|
| `intellij-platform-gradle-plugin` | 2.1.0 | **2.18.1** | 2.1.0 cũ 17 bản |
| Gradle | 8.14 | **9.7.1** | Plugin 2.18.1 **yêu cầu Gradle ≥ 9.0.0** — ngược hẳn với dự đoán "hạ Gradle cho an toàn" |
| Kotlin JVM plugin | 1.9.25 | **2.4.20** | Kotlin < 2.2 không chạy được trên Gradle 9 |
| JDK cho toolchain | 17 | **21** | IntelliJ Platform 2024.2 yêu cầu Java 21, không phải 17 |
| LSP4IJ | 0.7.0 | **0.21.0** | 0.7.0 không tồn tại ở dạng dùng được; bản hiện tại là 0.21.0, `since-build 242` |
| `instrumentationTools()` | có | **bỏ** | Đã bị loại khỏi plugin 2.x |
| foojay resolver | 0.9.0 | **1.0.0** | 0.9.0 vỡ trên Gradle 9 với lỗi `IBM_SEMERU` |

JDK để **chạy** Gradle và JDK để **biên dịch** là hai thứ khác nhau: Gradle chạy trên 17,
`jvmToolchain(21)` lo phần biên dịch, và foojay tự tải JDK 21 về. Nhờ vậy teammate chỉ cần một
JDK bất kỳ.

## C.2 Ba lỗi verifier bắt được

`verifyPluginProjectConfiguration` + `verifyPluginStructure` chạy trong 12 giây và bắt:

1. `sourceCompatibility` 17 trong khi platform 2024.2 cần 21
2. Plugin ID chứa từ `intellij` — JetBrains Marketplace từ chối. Đổi thành
   `com.ejsng.ejs-angularjs-navigator`
3. `.intellijPlatform/` chưa nằm trong `.gitignore`

**Luôn chạy hai task này trước khi mất công build.** Chúng không cần tải IDE.

## C.3 Kết quả xác minh

```
Plugin com.ejsng.ejs-angularjs-navigator:0.1.0 against IC-242.20224.300: Compatible
Dynamic Plugin Eligibility: Plugin can probably be enabled or disabled without IDE restart
```

Và trong IDE sandbox thật:

```
Loaded custom plugins: LSP4IJ (0.21.0), EJS + AngularJS Navigator (0.1.0)
```

## C.4 Bug nghiêm trọng phát hiện lúc chạy thật: không tìm thấy Node

`findNode()` bản đầu chỉ quét `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`. Trên chính máy
này `node` nằm ở `~/.nvm/versions/node/v20.20.0/bin/node` — **không khớp đường nào**.

Đây không phải trường hợp hiếm: **đội ngũ JavaScript hầu như đều dùng nvm/fnm/volta/asdf**, và
IDE khởi động từ Dock/Finder **không kế thừa PATH của shell đăng nhập**, nên kể cả `which node`
trong terminal có ra kết quả thì IDE vẫn không thấy. Plugin sẽ cài được, load được, rồi im lặng
không làm gì.

Đã tách ra `NodeLocator.kt` quét theo thứ tự: `EJSNG_NODE` → volta/asdf shim → nvm/fnm/nodenv
(chọn bản cao nhất, so sánh theo số chứ không theo chuỗi) → đường dẫn hệ thống → hỏi shell đăng
nhập bằng `$SHELL -l -c "command -v node"`.

## C.5 Nhiễu không phải lỗi của plugin

IDE ghi vài dòng `SEVERE` dạng `IllegalArgumentException: "26.0.2.1"` khi quét JDK trên máy:
IDEA 2024.2 (ra năm 2024) không parse được chuỗi phiên bản của Java 26 do Homebrew kéo về làm
dependency của Gradle. Không liên quan tới plugin.

## C.6 Lệnh đã chạy được

```bash
cd packages/intellij-client
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew verifyPluginProjectConfiguration verifyPluginStructure   # 12s, không cần tải IDE
./gradlew buildPlugin                                               # ~3 phút lần đầu
./gradlew verifyPlugin                                              # IntelliJ Plugin Verifier
./gradlew runIde                                                    # mở IDE sandbox
```

Log của IDE sandbox nằm ở `.intellijPlatform/sandbox/ejsng-intellij/IC-2024.2/log/idea.log`
(**không** phải `build/idea-sandbox/` như tài liệu cũ của plugin 1.x).

---

# PHỤ LỤC D — Sai lầm kiến trúc lớn nhất: chọn SQLite

## D.1 Chuyện đã xảy ra

Mục 4 khuyến nghị `better-sqlite3` và mình đã cài đúng như vậy. Nó chạy hoàn hảo:
CLI index 147 file trong 174ms, mọi test pass, LSP server chạy sạch qua stdio.

Rồi khi LSP4IJ khởi động chính server đó **bên trong IntelliJ**:

```
CannotStartServerException: Error while starting language server 'ejsng'
Caused by: Request initialize failed with message:
  The module '.../better-sqlite3/build/Release/better_sqlite3.node'
  was compiled against a different Node.js version using NODE_MODULE_VERSION 115.
  This version of Node.js requires NODE_MODULE_VERSION 137.
```

`npm install` chạy dưới Node v20.20.0 (ABI 115). `NodeLocator` chọn bản cao nhất trong nvm —
v24.13.1 (ABI 137). Máy thử nghiệm có **5 bản Node** cài song song.

## D.2 Vì sao đây là lỗi kiến trúc chứ không phải lỗi cấu hình

Native module phải khớp **chính xác** ABI của runtime Node nạp nó. Extension **không kiểm soát
được runtime đó**:

- **IntelliJ** chạy bằng bất kỳ Node nào tìm thấy trên máy. Lập trình viên JS thường có nhiều
  bản qua nvm/fnm, và bản họ dùng hôm nay không nhất thiết là bản lúc cài extension.
- **VSCode** chạy extension trong Electron, ABI khác hẳn Node thường. Muốn dùng native module
  phải `electron-rebuild` theo từng bản VSCode.
- Người dùng nâng Node lên một bản minor → extension chết, không một dòng lỗi trong UI.

Đây chính là lý do phần lớn extension VSCode tránh native module. Mình biết điều đó nhưng vẫn
chọn SQLite, vì lúc thiết kế chỉ nghĩ tới hiệu năng truy vấn mà không nghĩ tới đường phát hành.

## D.3 Sửa: NDJSON + index in-memory

Bỏ hẳn `better-sqlite3`. Kho mới:

- **Trên đĩa:** chỉ lưu FACT theo từng file, NDJSON, mỗi dòng một file.
- **Không lưu symbols/refs:** chúng là hàm thuần của fact (`factsToRows`), nên dựng lại lúc nạp
  còn rẻ hơn đọc từ đĩa.
- **Trong bộ nhớ:** bảng tra ngược theo tên / theo container+tên / theo kind / theo file.
- Ghi file tạm rồi `rename` để không bao giờ để lại file dang dở.

## D.4 Mất gì, được gì

| | SQLite | NDJSON |
|---|---|---|
| Cold index 147 file | 174ms | **209ms** |
| Warm start | 14ms | **14ms** |
| Cache trên đĩa | ~250KB | **184KB** |
| Chạy trên Node v20 | ✅ | ✅ |
| Chạy trên Node v24 | ❌ vỡ | ✅ |
| Cache ghi bởi v20, đọc bởi v24 | ❌ | ✅ |
| Số native module | 1 | **0** |
| Số dependency runtime | 6 | **5** |

Chậm hơn 35ms trên toàn bộ vòng index lạnh. Đổi lại là extension thực sự chạy được.

Ngoại suy quy mô: 147 file → 184KB. Repo 5.000 file → ~6MB NDJSON, parse khoảng 60ms. Vẫn
thừa sức. **SQLite là tối ưu hoá sớm cho một quy mô không tồn tại.**

## D.5 Bài học rút ra cho phần còn lại của dự án

Với extension IDE, **đường phát hành là ràng buộc thiết kế, không phải việc làm sau**. Trước khi
chọn bất kỳ dependency nào, hỏi: *thứ này sẽ nạp bằng runtime nào trên máy người dùng, và mình
có kiểm soát được runtime đó không?* Nếu không — không dùng native module.

Điều này cũng khoá lại lựa chọn ở mục 6: hướng **virtual-TS** cần `typescript` làm dependency,
nhưng đó là gói thuần JS nên vẫn an toàn. Ngược lại, mọi ý định dùng tree-sitter (native binding)
cho tầng parser giờ bị loại thẳng vì đúng lý do trên.

---

# PHỤ LỤC E — Xác nhận cuối: plugin chạy thật trong IntelliJ (2026-09-10 23:43)

Sau khi bỏ `better-sqlite3` (phụ lục D), language server khởi động thành công bên trong
IntelliJ IDEA Community 2024.2:

```
EJSNG: startup activity chay cho project 'smart-city'
EJSNG: da yeu cau start 'ejsng'

pid 80501: /Users/…/.nvm/versions/node/v24.13.1/bin/node …/packages/server/dist/index.js --stdio
```

Không còn `CannotStartServerException`, không còn `NODE_MODULE_VERSION`.

Điểm đắt giá: server đang chạy bằng **Node v24.13.1** — đúng bản ABI 137 đã làm vỡ
`better-sqlite3` trước đó. Bản sửa được xác nhận trong chính môi trường đã gây lỗi, chứ không
phải bằng cách né sang bản Node khác.

## E.1 Hai điều chỉnh phát sinh khi chạy thật

**`EjsNgStartupActivity`** — LSP4IJ mặc định khởi động server kiểu lười: chỉ chạy khi có file
khớp được mở. Với server phải index cả workspace trước khi trả lời được, kiểu đó bắt lần
Ctrl+Click đầu tiên phải chờ cả vòng index. Đã thêm `postStartupActivity` gọi
`LanguageServerManager.start(id, StartOptions().setForceStart(true).setWillEnable(true))`
để việc index xảy ra lúc IDE còn đang bận index của chính nó.

**Hộp thoại "Trust Project"** — IDE sandbox dừng ở hộp thoại này trước khi mở project, nên
startup activity không chạy và log đứng im. Không phải lỗi plugin, nhưng cần biết khi chạy
`runIde` trên một project mới.

## E.2 Trạng thái xác minh từng tầng

| Tầng | Mức xác minh |
|---|---|
| Core (parser, extractor, index, resolver) | 13/13 test, chạy trên repo thật |
| CLI | index 147 file: 209ms lạnh, 15ms ấm |
| LSP server (stdio) | definition + hover đúng, chạy trên cả Node v20 và v24 |
| Plugin IntelliJ — build | `BUILD SUCCESSFUL` |
| Plugin IntelliJ — Plugin Verifier | `Compatible` với IC-242.20224.300 |
| Plugin IntelliJ — load vào IDE | `Loaded custom plugins: … (0.1.0)` |
| Plugin IntelliJ — server chạy trong IDE | ✅ pid 80501, không lỗi |
| **Client VSCode** | ❌ **chưa chạy thử** — mới build TypeScript sạch |

---

# PHỤ LỤC F — Kiểm thử toàn bộ chức năng, và bug người dùng phát hiện (2026-09-11)

## F.1 Bug: property của biến ng-repeat không điều hướng được

Người dùng báo: trong `product/view/content.ejs`, `section.id` và `section.enabled` không nhảy
được trong IntelliJ. Tái hiện đúng:

```
'section'            → ✓ product/view/content.ejs:26 [repeat-var]
'id' trong section.id → ✗ Khong tim thay 'section' tren scope cua '…-view-controller'
```

**Nguyên nhân.** Trong `templateDefinition`, nhánh xử lý biến cục bộ chỉ chạy khi con trỏ nằm
trên **chính** định danh gốc (`onRoot`). Khi con trỏ nằm trên property phía sau, code rơi
xuống nhánh "property trên controller" và đi tìm `section` như một `$scope.section` — thứ không
tồn tại, vì `section` là biến vòng lặp.

**Mức nghiêm trọng: cao.** `{{ item.field }}` là dạng biểu thức phổ biến nhất trong template
AngularJS. Riêng `content.ejs` đã có `section.id`, `section.icon`, `section.label`,
`section.enabled`, `row.docType`, `row.count`… Coi như hỏng một nửa giá trị của extension.

**Cách sửa.** Biến phần tử của `ng-repeat` nay mang theo tham chiếu tới biểu thức collection:

```ts
locals: Array<{
  name: string;
  span: Span;
  collection?: { root: string; path: string[] };   // ← thêm
}>
```

Khi con trỏ nằm trên property của biến cục bộ, resolver đi: `section` → collection `sections`
→ `$scope.sections` → shape mảng → shape phần tử → tra khoá. Kết quả nhảy đúng vào từng khoá
trong object literal:

```
'id'      → index.js:33:7   { id: 'knowledge-base', label: …
'label'   → index.js:33:29
'icon'    → index.js:33:54
'enabled' → index.js:33:76
```

Mảng rỗng (`$scope.emptyRows = []`) không suy được shape phần tử — trả về thông báo rõ ràng
thay vì im lặng, và có test riêng cho trường hợp đó.

## F.2 Lỗ hổng thứ hai, phát hiện khi viết ma trận kiểm thử

Go-to-definition trên **tên filter** (`{{ total | money }}`) chưa bao giờ hoạt động: tên filter
nằm trong span của biểu thức nên resolver coi nó như property trên scope. Đã thêm nhánh xử lý
riêng, chạy trước khi phân giải scope, và phân biệt filter dựng sẵn của Angular (`currency`,
`date`, `orderBy`…) với filter tự viết.

Lỗ hổng này tồn tại từ đầu mà không test nào bắt được — vì bộ test cũ chỉ kiểm những đường đi
mình đã nghĩ tới khi viết code.

## F.3 Bài học về kiểm thử: định vị bằng chuỗi, không bằng số cột

Trong quá trình làm, đã **bốn lần** kết luận sai về sản phẩm chỉ vì đếm cột sai khi kiểm thử
bằng tay: trỏ nhầm vào `id="kbm-file-input"` thay vì thuộc tính `kbm-file`, trỏ vào giữa
`data-ng-class=` thay vì vào biểu thức, và hai lần lệch cột với `stats` / `searchForm`.

Đã thêm `packages/cli/src/probe.ts`: định vị bằng **chuỗi** kèm `--nth` và `--offset`, và in ra
đúng ký tự đang trỏ vào để đọc kết quả không phải đoán.

```bash
ejsng-probe views/page.ejs "section.enabled" --offset 8 --root <repo>
```

Bộ test `features.test.js` dùng cùng cách định vị đó.

## F.4 Ma trận kiểm thử

`packages/core/test/features.test.js` — 41/41 pass (tính cả `core.test.js`).

| Chức năng | Fixture | Repo thật |
|---|---|---|
| `ng-controller` → khai báo controller | ✓ | ✓ (`data-ng-controller`) |
| `ng-click` → hàm trên `$scope` | ✓ | ✓ |
| Biến `ng-repeat` | ✓ | ✓ |
| **Property của biến `ng-repeat`** | ✓ | ✓ (`section.id/.icon/.label/.enabled`) |
| Mảng rỗng → fallback tử tế | ✓ | — |
| Property lồng nhau trên `$scope` | ✓ | ✓ (`busy.stats`, `searchForm.query`) |
| `ng-model` → property của form | ✓ | ✓ |
| **Filter tự viết** | ✓ | — (repo không có filter Angular nào) |
| Thẻ custom → component | ✓ | — |
| Isolate binding trên thẻ custom | ✓ | — |
| Directive dạng thuộc tính + biểu thức bên trong | ✓ | ✓ (`kbm-file`) |
| DI trong JS → khai báo factory | ✓ | — |
| Find-references JS → template | ✓ | ✓ (33 chỗ) |
| Chuỗi scope cho hover | ✓ | — |
| Completion | ✓ | — |
| EJS locals (trục A) | ✓ | — |
| Dead code, không báo nhầm | ✓ | ✓ |
| Không nhận nhầm `.filter(Boolean)` | — | ✓ |
| Template bị `<% if %>` cắt vẫn parse sạch | ✓ | ✓ |

## F.5 VSCode: đóng gói và xác minh

`extension.ts` ban đầu trỏ tới `../server/dist/index.js` qua `asAbsolutePath`. Chạy được trong
monorepo nhưng **đường dẫn đó nằm ngoài thư mục extension**, nên khi đóng gói `.vsix` sẽ không
được đưa vào — extension cài từ Marketplace sẽ không tìm thấy server.

Đã thêm `build.js` dùng esbuild, bundle server + `@ejsng/core` + toàn bộ dependency thành
`dist/server.js` (1.2MB) nằm trong extension. Bundle được là nhờ đã bỏ `better-sqlite3`
(phụ lục D) — native module không thể bundle, và ABI của Electron khác hẳn Node thường.

Xác minh trong Extension Development Host trên repo thật:

```
didOpen  → uri: …/product/view/content.ejs, languageId: "ejs"
documentSymbol → server tra loi trong 98ms:
   "ng-controller cityos-demo-dha-management-view-controller" (dong 16)
window/logMessage → "EJS/NG: xong — 147 file, 24ms"
```

Server chạy bằng chính runtime Electron của VSCode (`Code Helper (Plugin)`) — đúng trường hợp
ABI thứ hai mà `better-sqlite3` sẽ làm vỡ.

---

# PHỤ LỤC G — Bug thứ hai người dùng phát hiện: `sections` không điều hướng

## G.1 Triệu chứng

`section.id` đã sửa được (phụ lục F), nhưng **vế phải** của `ng-repeat` thì không:

```
data-ng-repeat="section in sections"
                           ^^^^^^^^  → "Vi tri khong nam trong bieu thuc Angular"
```

Kỳ lạ ở chỗ mọi biến khác trong cùng file đều nhảy được.

## G.2 Nguyên nhân: lưu chuỗi không parse lại được

`TemplateExpression` lưu `text` + `span`, và resolver **parse lại** `text` để tìm node nằm
dưới con trỏ. Với `ng-repeat`, `text` được lưu là **cả chuỗi microsyntax**:

```
text = "section in sections"
```

`in` không phải toán tử của Angular expression, nên `tryParseExpression` trả về `null`,
`expressionAt` bỏ qua, và người dùng nhận thông báo "không nằm trong biểu thức Angular" —
đúng chỗ hay Ctrl+Click nhất.

Đây là hệ quả của một bất biến ngầm chưa được nêu ra: **`text` của một `TemplateExpression`
phải tự nó parse lại được**. `ng-repeat` vi phạm mà không ai để ý, vì các nhánh khác
(`interpolation`, `ngClick`, `ngClass`…) đều lưu đúng biểu thức.

## G.3 Sửa

`parseRepeat` / `parseOptions` nay trả về span cho từng thành phần, và extractor chỉ lưu
**biểu thức con** kèm span riêng của nó, không lưu cả microsyntax:

```ts
if (rep.collection) {
  pushExpression(rep.collection, sliceOf(value, base, rep.collectionSpan),
                 rep.collectionSpan.start, …);
}
```

Vế trái (`section`) là **chỗ khai báo**, nên trả về chính nó thay vì báo lỗi.

## G.4 Quét toàn bộ thay vì kiểm điểm lẻ

Hai bug liên tiếp đều lọt vì mình kiểm thử bằng cách chọn vài vị trí — mà toàn chọn trúng
những đường đi mình đã nghĩ tới lúc viết code. Đã thêm lệnh:

```bash
ejsng sweep --root <repo>
```

Nó thử resolve **mọi định danh gốc và mọi đoạn property** trong mọi biểu thức của mọi template,
rồi báo độ phủ. Kết quả trên `smart-city`:

```
Tong so vi tri thu : 405
Resolve duoc       : 397
Bien dung san      : 8   ($event, $index… — khong co dinh nghia, khong phai loi)
Con sot            : 0
Do phu             : 100.0%
```

Chính lệnh này phát hiện tiếp lỗi thứ ba dưới đây.

## G.5 Lỗi thứ ba, do sweep tìm ra: `$event`

8/405 vị trí báo "không tìm thấy trên scope" cho `$event` — biến Angular tự bơm vào mọi
directive dạng câu lệnh (`ng-click`, `ng-keydown`…). Không phải property trên scope, và
**không phải lỗi**.

Nếu bật diagnostics thì mọi handler có `$event` đều bị gạch đỏ — đúng loại false positive làm
người dùng tắt extension trong ngày đầu.

Đã thêm `NG_INJECTED_VARS` và cờ `builtin` trên `DefinitionResult`; diagnostics bỏ qua các
trường hợp này. Cờ áp dụng cho cả đường dẫn property: `$event.keyCode` cũng là dựng sẵn, không
chỉ riêng `$event` — đây là điểm mình sửa hụt ở lần đầu, và cũng do sweep bắt được.

---

# PHỤ LỤC H — Điều hướng JavaScript thuần (2026-09-11)

## H.1 Người dùng báo: không tìm thấy khai báo cho biến nào trong `index.js`, kể cả `window`

Đúng. `jsDefinition` ban đầu chỉ làm hai việc: tra tên khai báo Angular, và tra chuỗi trong dấu
nháy. **Không hề có phân giải biến JavaScript thuần** — `const SERVICE_ID` khai báo ngay dòng 16
mà Ctrl+Click ở dòng 88 cũng không ra.

## H.2 Vì sao đây không phải "để IDE tự lo"

Trong VSCode, TypeScript language server có sẵn sẽ lo phần JS. Nhưng **IntelliJ IDEA Community
không có plugin JavaScript** (phụ lục B) — trên bản đó, language server này là **nguồn duy nhất**
trả lời cho file `.js`. Không tự làm thì không ai làm.

## H.3 Đã thêm

**`extract/bindings.ts`** — trích khai báo kèm phạm vi, đúng ngữ nghĩa JavaScript:

| Loại | Phạm vi |
|---|---|
| `var`, `function` | hàm bao quanh (hoặc toàn file) |
| `let`, `const`, `class` | khối bao quanh |
| tham số hàm | chính hàm đó |
| tham số `catch` | khối catch |

Phân giải chọn **phạm vi hẹp nhất** bao quanh vị trí — đúng quy tắc che bóng của JavaScript.
Hỗ trợ cả destructuring (`{a, b: {c}}`, `[x, ...rest]`, giá trị mặc định).

**Thứ tự ưu tiên trong `jsDefinition`:**

1. `$scope.foo` / `this.foo` → property trên scope của controller bao quanh
2. Tên được inject (DI) → **khai báo Angular trước**, rồi mới tới tham số hàm
3. Khai báo Angular cùng tên
4. Khai báo JavaScript thuần theo phạm vi
5. Global liên file (kiểu `<script>` tag)
6. Biến toàn cục dựng sẵn → đánh dấu `builtin`, **không phải lỗi**
7. Chuỗi trong dấu nháy → tên controller / event / view

Điểm 2 là lựa chọn có chủ ý: về mặt từ vựng, `aocs` trong `function($scope, aocs)` là tham số
hàm — nhưng thứ người dùng muốn xem là `.factory('aocs')`. Trả về cả hai, Angular trước.

**Global liên file.** Codebase Angular 1 nạp bằng `<script>` tag thì khai báo ở phạm vi file là
global thật: `DHA_STATUS` khai báo trong `dha.const.js`, dùng ở `dha.controller.js`. Khai báo
phạm vi file nay được phát ra thành symbol `js-global`, nhìn thấy được từ file khác.

**Parse được ES module.** `dha.const.js` dùng `export const`. `parseJsTolerant` trước đây luôn
parse bằng `sourceType: 'script'` nên hỏng ngay ở `export`, rồi rơi xuống parser khoan dung và
cho ra binding rất kém. Nay tự nhận diện module.

## H.4 Đo bằng sweep, không đoán

`ejsng sweep` nay quét cả file `.js`, dùng AST để lấy **định danh ở vị trí tham chiếu**.

Lần đầu mình quét bằng regex và ra "49.4%" — con số đó **sai hoàn toàn**, vì regex đếm cả từ
khoá (`const`, `return`) và khoá object literal (`{ word: 1 }`) vào mẫu số. Đây đúng là loại lỗi
làm ta kết luận nhầm về sản phẩm; đã đổi sang đi AST.

| | Trước | Sau |
|---|---|---|
| Toàn repo | 97.3% | **99.2%** |
| `product/view/public/javascripts/index.js` | 5 sót / 511 | 5 sót / 511 |
| Template | 100% | 100% |

## H.5 136 chỗ còn sót — và vì sao KHÔNG nên đuổi tới 100%

Nhóm lớn nhất là `isNull` (41 lần). Tra khắp repo: **không có khai báo nào**. Đây là biến toàn
cục do nền tảng cấp lúc chạy, hoặc là lỗi thật trong codebase — chứ không phải tool sai.

Đó chính là thứ tính năng diagnostics sinh ra để phát hiện. Ép cho mọi định danh đều "resolve
được" sẽ giết mất giá trị đó. Phần còn lại là biến trong file nằm ngoài phạm vi index
(`web/js/old/utilities` không có đuôi `.js`) và vài global của thư viện bên thứ ba.
