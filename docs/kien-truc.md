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

**Đã hiện thực** (`.scratch/template-roots-config/issues/01-resolve-template-url.md`), nguồn 2–5,
ở `packages/core/src/resolve/template-links.ts`:
- Extractor ghi `JsFacts.templateLinks` (vẫn là fact thuần, chưa map ra file). Layer 4 map URL qua
  `templateRoots` (prefix dài nhất trước; thử tên y nguyên, rồi đổi/thêm từng `extensions`), cuối
  cùng thử URL như đường dẫn từ gốc workspace.
- Controller được nối **lúc query**: `Workspace.facts()` chèn một frame controller ngay trong frame
  root của mọi scope chain — `ng-controller` bên trong template vẫn gần hơn nên vẫn thắng. Nhờ
  đi qua `facts()`, go-to-definition, completion, hover và rename đều thấy cùng một liên kết.
- Một template bị gán **nhiều controller khác nhau** → không gán cái nào, báo `ambiguous-controller`
  (đoán sẽ làm nửa số biểu thức resolve sai). URL không khớp file nào → `no-file`; biểu thức → `dynamic`.
  Báo cáo: `Workspace.templateLinkIssues()` và cuối output `ejsng sweep`.
- `expressViewsDir` (mặc định `views`, như Express) cho `res.render('user/profile')`: Ctrl+click vào
  tên view mở file view; Ctrl+click vào `<%= user %>` nhảy tới key `user` của các `res.render()` render view đó.
- Chưa làm: heuristic dự phòng (nguồn 6), và `$uibModal.open`/`$mdDialog.show({templateUrl})`.

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

#### 5.3.1 Kiểu đã thấy (Observed Type) — hover và inline "có thể rỗng" (2026-09-19)

Shape ở trên phục vụ **completion và go-to-definition**, nên chỉ lấy **lần gán đầu** (`scopeMembers`
— "chỗ khai báo"). Để dev **thấy hình dạng dữ liệu** khi viết template mà không mở controller, bản 1
thêm một fact riêng và một lớp gộp. Spec đầy đủ: `.scratch/observed-types/spec.md`.

**Gộp mọi lần gán, không chỉ lần đầu.** Đo trên `smart-city` (32 member dữ liệu, 581 lượt dùng
trong template): lần gán đầu cho kiểu có ích ở **78.8%** lượt dùng, gộp mọi lần gán lên **96.0%**. Lý
do chính: 5 member được gán `null` trước rồi mới gán giá trị thật. Extractor giờ ghi **mọi** lần gán
`$scope.x = …` / `this.x = …` (kể cả qua `var vm = this`) vào fact mới `JsFacts.scopeWrites`, mỗi lần
gán kèm: shape của từng nhánh (`a ? b : c`, `a || b`), cờ `nullable` (có nhánh tường minh
`null`/`undefined`/`void 0`), cờ `inCallback`, và vế phải rút gọn để giải thích khi không suy ra được.
Primitive giờ có kiểu (`string`/`number`/`boolean`). `scopeMembers` **giữ nguyên** lần gán đầu — nhét
mọi lần gán vào đó sẽ làm go-to-definition ra nhiều đích và đổi hành vi rename.

Luật gộp (`packages/core/src/resolve/observed-type.ts`): cùng loại → gộp một, key không có ở mọi
lần gán thành optional `id?`; khác loại hẳn → union `A | B`; `unknown` cạnh cái đã biết thì bỏ, đánh
dấu `partial`. Cú pháp TypeScript, `T[]`. Hover cắt ở 2 cấp lồng, 8 key/cấp, phần cắt ghi `…+N`. Chỉ
gộp từ **bản controller gần file nhất** khi controller khai báo trùng ở nhiều file (như
`preferNearest`, phụ lục K) — đo thấy `lastSearchMs` có 8 lần gán vì bị khai báo 2 lần.

**Gán lồng.** `$scope.state.loading = true` bổ sung key `loading` (optional) vào shape của `state`.
Không có bước này thì hover `{{ state.loading }}` báo sai "`state` không có `loading`" — sai còn tệ
hơn im lặng.

**Vì sao không inline mọi biểu thức.** Chú thích kiểu sau mọi biểu thức làm dòng template dài gấp
đôi, người dùng sẽ tắt ngay (cùng lý do `ejsng.diagnostics.enabled` mặc định tắt). Inline phải hiếm
mới được tin: chỉ **`may be empty`**, style nhạt, sau biến có **ít nhất một lần gán tường minh**
`null`/`undefined`. Không gọi là lỗi: biểu thức Angular không ném lỗi khi gặp null (`{{ a.b }}` ra
rỗng). Member **chỉ gán trong callback** không được inline — tính cả trường hợp đó thì gần như mọi
dữ liệu tải async bị gắn cờ; chỉ ghi trong hover. File JS và EJS local: không inline. Trên
`smart-city`: 9 template → 127 hint, đều ứng với `= null` thật; 62ms cả 9 file.

**Mô hình dữ liệu cho nguồn runtime.** Kiểu của một biến = tập **Bằng chứng kiểu (Type Evidence)**
`{ source: 'static' | 'runtime', shape, site | connection, count, lastSeen }`. Bản 1 chỉ có `static`
(mỗi `ScopeWrite` là một bằng chứng) — runtime cắm vào sau không phải đổi hiển thị. Bằng chứng
runtime **chỉ ở RAM, theo kết nối, không ghi cache**: giá trị cũ nhanh và có thể chứa dữ liệu cá nhân.

**Lộ trình nguồn runtime.**

| Bản | Nguồn | Ghi chú |
|---|---|---|
| 2 | **R1** — giá trị `console.log`/logpoint mà pipeline Runtime Log đã nhận (`type/subtype/preview` của CDP `RemoteObject`) | **Đã làm** (2026-09-20, xem dưới). Không miễn phí như tưởng: preview quá nông, phải gọi thêm `Runtime.getProperties`. |
| 2 | **R4** — breakpoint điều kiện luôn `false` tại mỗi `res.render(...)`, ghi shape của locals qua `Runtime.addBinding` | Giải đúng lỗi 500 của EJS (`<%= user.name %>` với `user` undefined) — thứ tĩnh gần như không biết vì kiểu đến từ `req`/DB. |
| 3 | **R3** — lúc hover, `Runtime.evaluate` `angular.element(el).scope()…` trên tab đã kết nối, `throwOnSideEffect: true` | Giá trị hiện tại thật. Khó: tìm phần tử DOM ứng với template. Không chạy nếu app build với `debugInfoEnabled(false)`. |

**Bỏ R2** (probe tự động sau mỗi lần gán): probe chạy ở mọi lần dòng đó chạy — cả vòng lặp nóng —
và để lại hàng trăm breakpoint ngầm khó gỡ lỗi. R1 + R3 phủ đủ nhu cầu mà không có hai cái giá đó.

#### 5.3.2 R1 — kiểu từ giá trị đã log (2026-09-20)

Spec: `.scratch/observed-types-r1/spec.md`. Khi Runtime Log vẽ một log mà đối số là biến scope —
một phần `{vm.rows}` của logpoint, hoặc đối số của `console.<method>(…)` **trực tiếp** — kiểu của giá trị
thành một **Bằng chứng kiểu** `source: 'runtime'` và gộp vào hover.

**Đo trước khi làm (Node 20.20 và Chrome 153 cho kết quả giống hệt):**

| | |
|---|---|
| Preview của object trong `consoleAPICalled` | tối đa **5 key** (`overflow: true`) |
| Preview của mảng | tối đa **100 phần tử** |
| Object lồng / phần tử mảng trong preview | **không có key nào** — chỉ `{type: "object", value: "Object"}` |
| Getter | `type: "accessor"`, **không bao giờ chạy** (cả preview lẫn `getProperties`) |
| `Runtime.getProperties({ownProperties, generatePreview})` | 0.2–0.4 ms object nhỏ; 2–4 ms mảng 150 phần tử, mỗi phần tử kèm preview 5 key |

Tức là với ca chính `console.log($scope.rows)` — mảng object — preview không cho biết phần tử có key
gì. Nên server **đào** bằng `getProperties`: theo tầng (các lệnh cùng tầng chạy song song, tầng nông
trước), tới đúng giới hạn hover (2 cấp, 8 key), mảng lấy mẫu 3 phần tử (đầu/giữa/cuối), **≤ 12 lệnh
mỗi log**. Cùng chỗ log, cùng kiểu preview trong 30 giây → chỉ đếm, không đào lại. Việc đào chạy **sau**
khi log đã vẽ và ngoài hàng đợi vẽ, nên không làm chậm log.

**Object mở.** Phần không đào được giữ preview và bị đánh dấu `open`: gộp thì key nó có được thêm,
key nó thiếu **không** thành optional (nếu không, mọi key thứ 6 trở đi của một preview sẽ thành `id?` —
sai có hệ thống). Hover kết thúc object mở bằng `…`.

**Nối log với biến.** Làm lúc đánh index, không lúc nhận log: fact `JsFacts.consoleCalls` ghi mỗi lời
gọi `console.*` trực tiếp trong một khai báo Angular kèm biến scope của từng đối số (cùng luật với
`scopeWrites`: `$scope`, `this`, `var vm = this`). Tra bằng vị trí **tên method** — đo được V8 đặt
frame của lời gọi console đúng ở đó (kể cả `console . log (` xuống dòng). Logpoint: biểu thức resolve
một lần lúc `ejsng/setLogpoints`. Log qua wrapper, log biến cục bộ, `a[0]` → không nối (ghép sai còn
tệ hơn không ghép).

**Giữ gì, bao lâu.** Chỉ **kiểu**, không bao giờ giá trị. Object từ điển (> 50 key, hoặc key không phải
định danh — vd email) thành `Record<string, T>` vì key của nó là dữ liệu. `$$hashKey` bị bỏ. Kho gắn
vào chính kết nối: nối lại, ngắt, hay runtime chết là mất. Tối đa 20 kiểu mỗi biến, 2000 tổng. Bằng
chứng runtime mang thẳng `ObservedType` chứ không mở rộng `ValueShape` — `ValueShape` là định dạng ghi
cache và là đầu vào của completion, không biểu diễn được union phần tử mà giá trị thật hay có.

**Inline hint không đổi.** Runtime thấy `null` → hover ghi "Seen `null`/`undefined` at runtime", nhưng
`nullable` (và chú thích `may be empty`) vẫn chỉ tính từ lần gán tĩnh: log chạy ở thời điểm bất kỳ,
không phải lúc render, và hint không được hiện/mất theo việc đang nối runtime hay không.

**Thực tế trên `smart-city` (đo 2026-09-20):** 288 lời gọi `console.*`, 8 cái nằm trong controller,
**không cái nào log biến scope** — đều log chuỗi hoặc biến cục bộ (`error`, `event`). Nên trên code thật,
R1 không tự có tác dụng nhờ log sẵn có; nó có tác dụng khi dev **chủ động đặt logpoint** `{vm.rows}`.
Hướng tiếp theo đáng cân nhắc: một lệnh "log biến này" từ hover để đặt logpoint đó hộ dev — **đã làm**, xem 5.3.3.

#### 5.3.3 "Log at runtime" — đặt logpoint từ hover (2026-09-20)

Spec: `.scratch/log-variable/spec.md`. Cạnh mỗi lần gán mà hover ghi "không suy ra được" có link **Log at
runtime**; bấm → một `vscode.SourceBreakpoint` bình thường, `logMessage` = `$scope.rows = {$scope.rows}`, đặt
**ngay sau câu gán**. Giá trị nó log đi đường R1 (5.3.2) thành kiểu trong hover.

**Vì sao đặt theo cột, không theo dòng** (đo trên `node --inspect`):

| Dạng code | Theo cột, ngay sau `;` | Theo dòng (cột 0 dòng kế) |
|---|---|---|
| Câu gán, câu lệnh khác ở dòng sau | chạy sau câu gán | được |
| Câu gán cuối, `}` ở dòng sau | được | được |
| Hàm một dòng `function (res) { $scope.b = res.data; }` | được | **không** — dòng kế nằm ngoài hàm |
| `if` một dòng `if (res) { $scope.d = res.data; } return 1;` | được | **không** |

Nên pipeline logpoint giờ mang **cột**: client gửi `character`, server gửi `columnNumber` cho
`setBreakpointByUrl` và resolve biểu thức tại cột đó — đầu dòng của hàm một dòng nằm *ngoài* callback, resolve
ở đó thì `this`/`vm` sai chỗ. Logpoint đặt ở lề có cột 0, hành vi như cũ. `setBreakpointByUrl` trả
`locations: []` khi hàm chưa compile (V8 compile lười) — không phải lỗi, breakpoint bind khi hàm chạy.

Index ghi sẵn cho mỗi lần gán **là cả một câu lệnh** vị trí ngay sau nó (`ScopeWrite.after`, qua cả chuỗi
`a = b = x;`) và vế trái như viết (`lhsText`). Gán nằm trong biểu thức khác (`return $scope.x = y`, thân arrow
rút gọn) → không có link: không có "ngay sau" để đặt.

**Chỉ ở chỗ tĩnh bó tay**, như inline hint: biến có kiểu tĩnh đầy đủ không có link. **Không phải code action:**
link nằm đúng dòng dev đọc ra vấn đề, còn code action sẽ hiện cả ở IntelliJ — nơi chưa có Runtime Log.
**Chỉ client khai báo chạy được lệnh** (`initializationOptions.commands`) mới có link, và markdown của hover chỉ
được tin cậy cho đúng lệnh đó (`markdown.isTrusted: { enabledCommands: ['ejsng.logVariable'] }` của
`vscode-languageclient`) — không mở toàn quyền `command:` cho hover.

**Không tự gỡ logpoint.** Nó là breakpoint bình thường: hiện ở lề, trong Breakpoints view, còn qua reload, dev
xoá bằng UI sẵn có. Tự gỡ thứ dev nhìn thấy là bất ngờ, và bỏ lỡ lúc kiểu đổi về sau (object rồi `null`).
Bấm lại không sinh cái thứ hai (đúng `(file, dòng, cột)`; đang tắt thì bật lại).

Có test e2e trong VS Code thật: link lấy từ hover, markdown được tin cậy, logpoint ở đúng cột, `columnNumber`
tới runtime.

#### 5.3.5 CodeLens đặt logpoint bằng một click (2026-09-20)

Spec: `.scratch/log-lens/spec.md`. **VS Code không có API điền sẵn ô *Add Logpoint…* của nó**, nên muốn dev khỏi
gõ tay thì extension phải tự tạo logpoint. Chỗ bấm là một CodeLens ngay trên dòng gán vào scope; nội dung
(`rows = {$scope.rows}`) và vị trí (ngay sau câu lệnh, xem 5.3.3) đều lấy từ index.

**Mặc định hiện ở đâu — đo trên `smart-city`:**

| Lens đặt ở | `product2/…/index.js` (1568 dòng) | `new-version-2/new-index.js` (845 dòng) | Toàn repo |
|---|---|---|---|
| mọi lần gán vào scope | 240 (15%) | 143 (17%) | 587 |
| chỉ lần gán **không suy ra được kiểu** | 46 (2.9%) | 26 (3.1%) | 105 |

Mỗi CodeLens chiếm một dòng hiển thị, nên "mọi lần gán" làm file dài thêm ~15% — quá rối. Mặc định
`ejsng.logLens = "unknown"`: chỉ những lần gán index bó tay, tức đúng chỗ log dạy được điều gì đó. `all` và
`off` vẫn có cho ai muốn.

**Lens dựng ở client**, vị trí lấy từ server qua `ejsng/logTargets`. Lý do: chỉ client biết breakpoint nào đang
có (để đổi nhãn thành *Logging rows — click to remove* và bấm là gỡ) và setting hiện tại (đổi setting không cần
reload). Server vẫn là nơi duy nhất biết "ngay sau câu lệnh" nằm ở đâu.

Nội dung logpoint của lens và của link trong hover được **thống nhất** (`rows = {$scope.rows}`) — trước đó hover
dùng `$scope.rows = {…}`, hai chỗ sinh hai logpoint khác nhau ở cùng một vị trí.

#### 5.3.4 Log hiện rõ object/array (2026-09-20)

Spec: `.scratch/expand-log-values/spec.md`. `console.log('rows', $scope.rows)` với một mảng 150 object trước đây
vẽ inline thành `rows [Object, Object, …]` — 100 chữ "Object", vô dụng. Cùng nguyên nhân với 5.3.2: preview của CDP
chỉ có một cấp.

**Ba mức hiển thị, một lần đào.**

| Ở đâu | Sâu | Giới hạn |
|---|---|---|
| Inline cạnh code | 2 cấp | một dòng, 200 ký tự, chuỗi 40 ký tự |
| Hover | 3 cấp | nhiều dòng, 30 key/cấp, 10 phần tử, 8 KB |
| Tab JSON (bấm **Show full value**) | 6 cấp | 50 key, 200 phần tử, chuỗi 10 000 ký tự, 2 MB |

Hai mức đầu đào **lúc log được vẽ**, mức thứ ba chỉ đào **khi bấm**, từ `objectId` server còn giữ (200 log gần
nhất mỗi kết nối). Việc đào chạy **sau** khi log đã gửi đi và ngoài hàng đợi vẽ; kết quả về sau vài ms dưới dạng
notification thứ hai `ejsng/runtimeLogExpanded` cho cùng `logId`, và client thay chữ của đúng dòng đó. Chờ đào xong
rồi mới vẽ sẽ làm chậm mọi log — qua Docker/Chrome mỗi tầng là một lượt đi-về.

**Chặn tần suất: 1 lần đào mỗi (file, dòng) mỗi 300 ms.** Đo trên Chrome 153 thật (trang log mảng 150 object mỗi
30 ms, 5 giây): app chạy **33.4 vòng/giây khi bật, y hệt khi tắt**; server vẽ đủ 167 log và chỉ đào 16 lần. Tức là
việc đào không làm app chậm đi ở mức đo được, và log không bao giờ bị bỏ.

**Tab JSON thay vì cây tự viết.** Bấm link mở một `TextDocumentContentProvider` chỉ đọc (`ejsng-log:`) chứa JSON
hợp lệ, nên gập/mở từng nhánh, tìm kiếm, copy, so sánh đều là của VS Code. Thứ JSON không biểu diễn được thành
chuỗi: `"[Function: load]"`, `"[getter]"`, `"undefined"`, `"[not expanded]"` (nhánh ngoài ngân sách — không giả vờ
là rỗng). Giá trị runtime đã bị thả (trang điều hướng, console bị xoá) → trả về phần còn giữ được, ngôn ngữ `jsonc`
và một dòng `//` nói rõ.

**Không nhận ra vòng lặp tham chiếu được** (xem 5.3.2): độ sâu là thứ chặn. **Getter không bao giờ chạy.** Chuỗi ở
mức đối số in như văn bản (`rows [...]`), chuỗi bên trong giá trị vẫn có nháy — đúng như console thật.

**V8 phát lại console entry đệm trước khi client kết nối, và bản phát lại không có preview** (thấy khi test): vài
log đầu sau khi Connect hiện `Array(150)`; chúng vẫn được đào và trải ra ngay sau đó.

Setting `ejsng.runtimeLog.expandValues` (mặc định bật) tắt hẳn: không lệnh nào gửi cho app, inline về như cũ.

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
  **Đã làm rename và completion theo shape, không cần virtual-TS — phụ lục I.**

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

---

# PHỤ LỤC I — Rename, completion theo shape, và hai lỗ hổng lộ ra khi làm (2026-09-11)

## I.1 Rename: đổi `$scope.foo` đồng bộ ra mọi template

Seam test do người dùng chọn: **Workspace API** (`prepareRenameAt`, `renameAt`) **và LSP qua
stdio** (`packages/server/test/lsp.test.js` khởi động server thật, nói JSON-RPC như IDE).

| Nơi được đổi | Cách tìm |
|---|---|
| JS — mọi lượt `s.foo`, **cả đọc lẫn ghi** | Quét AST lúc rename. `scopeMembers` chỉ giữ lượt gán đầu tiên: `index.js` có 169 lượt `$scope.x` nhưng chỉ 66 lượt gán |
| Template — gốc biểu thức | Trích lại fact từ nội dung hiện tại, lọc theo controller bao quanh |
| Template — giá trị thuộc tính do Linker phân giải | Đi qua chính `linker.resolveCandidates` (`pick-file="onPick($file)"`, `data="form"`) |

Nguyên tắc: **có bất kỳ xung đột nào thì từ chối cả lượt** — đổi tên dở dang tệ hơn không đổi.
Từ chối luôn kèm lý do, và server trả `ResponseError` chứ không trả `null`, để IDE hiện được lý do:

- tên mới không phải định danh, là từ khoá, bắt đầu bằng `$`, hoặc trùng tên cũ
- tên mới đã có trên scope (JS đã truy cập `s.<tên mới>`, hoặc template đang dùng)
- tên mới **bị biến `ng-repeat` che** tại một chỗ dùng (`busy` → `row` trong `<li ng-repeat="row in rows">`)
- property chỉ **đọc** mà không gán trong controller — có thể kế thừa từ scope cha
- biến cục bộ của template, thành phần dựng sẵn (`$on`, `$event`), controllerAs, property lồng nhau
- span không trỏ đúng tên cũ (tức bug ở Layer 2) — từ chối thay vì sửa hỏng

Che bóng phía JS: `s` trong `helper(function (s) {…})` là biến khác, không bị đổi — kiểm bằng
`resolveBinding`, đúng quy tắc phạm vi của phụ lục H.

**Edit tính trên nội dung hiện tại, không dùng fact trong index.** Index có thể cũ hơn file, mà
rename lệch một ký tự là sửa hỏng code người dùng.

### Controller khai báo trùng tên ở nhiều file

`smart-city` có `cityos-demo-dha-management-view-controller` ở cả `product/…/index.js` lẫn
`new-version/fe-be/index.js`, mỗi bản đi với một template riêng. Go-to-definition trả về cả hai
là vô hại; rename thì ghi vào file. **Người dùng chọn: ghép theo thư mục gần nhất.**

`renameScope()` ghép mỗi template với file `.js` có thư mục chung sâu nhất, rồi chỉ đổi **nhóm**
chứa điểm bắt đầu. Template hoà khoảng cách giữa hai bản kéo cả hai bản vào nhóm — đổi một bên thì
template đó hỏng với bên kia — lan dần tới khi ổn định; kéo hết thì đổi hết và báo.

Đo trên `smart-city`, khớp số đếm độc lập bằng grep:

| Bắt đầu từ | Sửa | Giữ nguyên |
|---|---|---|
| `product/…/index.js` | 44 JS + 25 template = 69 | `new-version/fe-be/index.js` |
| `new-version/fe-be/index.js` | 28 JS + 8 template = 36, **kèm cảnh báo 8 chỗ** (mục I.3) | `product/…/index.js` |

Test khứ hồi: áp 69 edit vào overlay rồi nối lại index — mọi gốc biểu thức trong template vẫn resolve.

## I.2 Bug lộ ra khi làm rename: mọi span trong giá trị thuộc tính lệch một ký tự

Rename cần span **chính xác tuyệt đối**, và đó là lúc bug lộ ra. `valueSpan` của
`angular-html-parser` bắt đầu **từ dấu nháy** (`x="v"` → trỏ vào `"`); không có nháy thì bắt đầu
từ chính giá trị. Code lấy thẳng `valueSpan.start.offset` làm gốc offset.

| | Biểu thức lệch |
|---|---|
| `smart-city` | 146/211 — mọi biểu thức trong thuộc tính; `{{ }}` trong text node thì đúng |
| fixture | 4/7 |

Vì sao điều hướng không phát hiện được suốt tám phụ lục trước:

- `inSpan` tính **cả hai đầu mút**, nên con trỏ đặt ở ký tự nào của tên cũng "trúng" span lệch.
- `sweep` dò tại chính `root.span.start` — lệch cùng chiều với span nên vẫn resolve được.

Bị ảnh hưởng: tên `ng-controller`, giá trị thuộc tính giao cho Linker, `{{ }}` nằm trong thuộc
tính, và vị trí find-references hiển thị cho người dùng (tô sáng lệch vào dấu nháy).

Sửa: `valueStartOf()` chỉ `+1` khi ký tự đầu là dấu nháy. **`PARSER_VERSION` 10 → 11.** Thêm bất
biến thứ năm, có test riêng (`spans.test.js`: 405 vi phạm trước khi sửa → 0):

> **Mọi span trong fact template phải trỏ đúng vào chữ nó đại diện**: `source.slice(span) === text`.

`sweep` sau khi sửa không đổi (99.2%, 136 chỗ sót như phụ lục H) — sửa không làm thụt lùi.

## I.3 Điểm mù của `sweep`: nó chỉ đếm những gì extractor tìm thấy

"Template 100%" ở phụ lục G là 100% **của các biểu thức đã trích được**. Biểu thức bị extractor bỏ
sót không bao giờ vào mẫu số.

Rename làm lộ ra điều này: `new-version/fe-be/content.ejs` có 16 lượt `busy` nhưng chỉ 8 được
trích. Đếm theo dòng: **21/88** dòng có `data-ng-*` hoặc `{{` không sinh ra biểu thức nào.

Nguyên nhân: file thụt lề bằng **U+2003 (EM SPACE)**. Header của bản `product/view/content.ejs`
có ghi việc này, kèm nhận định "HTML coi nó là whitespace nên vẫn chạy". Nhận định đó **sai** —
đã kiểm cả hai phía:

- **Trình duyệt:** `DOMParser` của Chrome trả về thuộc tính tên là `"  data-ng-disabled"` — U+2003
  nằm **trong tên**. Theo đặc tả tokenizer HTML, trong thẻ chỉ tab/LF/FF/space là khoảng trắng,
  nên AngularJS không chuẩn hoá được tên đó thành `ngDisabled`.
- **AngularJS 1.8.3:** `Lexer.isWhitespace` chỉ nhận space, `\r`, `\t`, `\n`, `\v`, `\u00A0`.
  `{{` có chứa U+2003 ném lỗi lexer lúc chạy.

Tức là 21 dòng đó ở bản new-version **chưa bao giờ chạy như directive**. Extractor hành xử đúng
như runtime — đây không phải bug của extension, và không nên "sửa" để nó trích được.

Rename không đoán mà **báo**: `unparsedOccurrences()` quét các vùng trông giống Angular (giá trị
của thuộc tính có `ng-`, bên trong `{{ }}`), liệt kê chỗ còn chứa tên cũ mà không được đổi, kèm
gợi ý U+2003 nếu dòng đó có ký tự này.

**Bài học:** độ phủ đo trên đầu ra của chính công cụ có mẫu số do chính công cụ quyết định. Muốn
biết cái bị bỏ sót, phải đếm bằng một nguồn **độc lập** — ở đây là grep.

## I.4 Completion theo shape

Gõ `{{ busy.` thì biểu thức **không parse được**, và extractor bỏ hẳn nó: mất chuỗi scope, không
biết người dùng đang gõ sau cái gì. Cách làm: chèn một định danh giả (`__ejsngCursor__`) vào đúng
con trỏ rồi trích lại riêng file đó. Biểu thức thành hợp lệ, `ng-repeat` bao quanh vẫn nguyên:

- đoạn cuối chuỗi property chứa định danh giả → đang gõ sau dấu chấm → đi theo shape
- gốc là biến `ng-repeat` → đi vào **phần tử** của collection (`section.` → khoá của `sections[i]`)
- còn lại → gợi ý định danh gốc theo đúng chuỗi scope tại chỗ
- đang gõ trong chuỗi ký tự → không gợi ý

Trên `smart-city`: `busy.` → đúng 9 khoá của object literal ở `index.js` dòng 53; `section.` →
`id`, `label`, `icon`, `enabled`. `shapeOf()` được tách ra để điều hướng và completion tra shape
theo cùng một cách.

## I.5 Sai lầm tự gây ra: `String.prototype.replace` và `$'`

Script sửa code dùng `s.replace(from, to)` với `to` chứa `startsWith('$')`. Trong chuỗi thay thế,
`$'` là mẫu đặc biệt nghĩa là "chèn phần còn lại của chuỗi gốc" — `workspace.ts` bị chèn lặp nguyên
phần đuôi (11.655 ký tự). Code đó chưa được commit nên git không cứu được; phải dựng lại bằng phép
tính độ dài (file hỏng = phần trước + đầu chuỗi thay thế + đuôi + cuối chuỗi thay thế + đuôi) và
kiểm chéo từng đoạn trước khi ghi.

Từ đó mọi lệnh thay thế đều dùng hàm: `s.replace(from, () => to)`.

## I.6 Giới hạn đã biết

- **controllerAs:** rename từ chối (repo thật có 0 chỗ dùng); `this.foo` phía JS chưa được quét.
- **Khoá trong `angular.extend($scope, {…})`** và bí danh gán lại sau khai báo (`vm = $scope`):
  không được đổi. Bí danh khai báo thẳng (`var vm = $scope`) và `$scope['busy']` thì có (I.7).
- **Đổi tên khoá lồng nhau** (`busy.search`): chưa làm — phải đổi khoá trong object literal và mọi
  đường dẫn tới nó, rất dễ nhầm với object khác có khoá cùng tên.
- **Chuỗi trong `$watch('busy.search', …)`:** không được đổi. `smart-city` chỉ dùng dạng hàm.
- **Completion trong file `.js`** (`$scope.busy.`): chưa làm.
- **Completion vẫn gộp mọi bản** của controller trùng tên. Go-to-definition đã dùng nhóm gần nhất
  như rename — xem phụ lục K.
- **VSCode với file `.js`:** TypeScript server có sẵn cũng cung cấp rename, và VSCode có thể hỏi
  provider đó trước. Chưa kiểm trong IDE thật — test stdio chỉ xác nhận server trả đúng.
- ~~**Server bỏ qua `workspace/didChangeWatchedFiles`**~~ — **đã sửa, xem phụ lục J.** File đổi
  ngoài editor (git pull, checkout) nay vào index ngay khi client báo, cả VSCode lẫn IntelliJ.

## I.7 Review trước khi commit: bốn lỗi, đã sửa kèm test hồi quy

Chạy `/code-review` (built-in) trên toàn bộ thay đổi của phiên, như bàn giao đề nghị. Cả bốn đều
là lỗi thật trong code của chính phiên này; mỗi lỗi có một test tái hiện, đỏ trước khi sửa.

| Lỗi | Hậu quả | Sửa |
|---|---|---|
| Rename phía JS chỉ nhận `s.foo` | `var vm = $scope; vm.busy` và `$scope['busy']` bị bỏ sót, không cảnh báo — JS vẫn ghi tên cũ trong khi template đã đọc tên mới | Nhận cả bí danh khai báo thẳng từ `$scope` và truy cập bằng chuỗi viết thẳng |
| Cảnh báo "chỗ còn sót" chỉ trừ các chỗ được đổi | Báo nhầm `busy` của controller khác, biến `ng-repeat`, khoá trong `ng-class` là "không hiểu được" — xúi người dùng sửa tay chỗ không được đụng | Trừ mọi vùng extractor đã parse: biểu thức, chỗ khai báo biến cục bộ, giá trị thuộc tính Linker hiểu |
| Điều kiện "phải có lượt gán" kiểm trên mọi bản sao | Bản gần nhất chỉ đọc `foo` (kế thừa), bản kia gán — template bản gần nhất vẫn bị đổi | Kiểm trên đúng các file sẽ bị sửa |
| Luôn gửi `renameProvider: { prepareProvider: true }` | Sai LSP 3.17 với client không khai báo `prepareSupport` | Chỉ gửi khi client khai báo; ngược lại gửi `true` |

---

# PHỤ LỤC J — File đổi ngoài editor: `workspace/didChangeWatchedFiles` (2026-09-11)

## J.1 Triệu chứng

Server không có handler cho `workspace/didChangeWatchedFiles`. File đổi ngoài editor (git pull,
checkout, tool khác) chỉ vào index khi chạy lại lệnh reindex — go-to-definition, references,
completion dùng fact cũ. Rename không bị ảnh hưởng vì luôn trích lại từ nội dung hiện tại (I.1).

Test tái hiện: thêm `s.moi = 1;` vào controller **trên đĩa**, client báo đổi, definition từ
`{{ moi }}` trong template vẫn trả `null`.

## J.2 LSP4IJ không tự gửi — server phải đăng ký động

`LSPSupport.md` của LSP4IJ chỉ đánh ✅ cho `workspace/didChangeWatchedFiles`, không nói cơ chế.
Đọc mã nguồn thẻ `0.21.0`:

| Chỗ | Thấy gì |
|---|---|
| `ClientCapabilitiesFactory.java:77` | Khai báo `didChangeWatchedFiles: { dynamicRegistration: true }` — **không** khai báo `relativePatternSupport` |
| `LanguageServerWrapper.registerCapability` | Nhận `client/registerCapability` cho `workspace/didChangeWatchedFiles`, nạp `watchers` vào `FileSystemWatcherManager` |
| `AbstractLSPFileListener.isMatchFilePatterns` | `if (uri == null \|\| !hasFilePatterns()) return false;` — **chưa đăng ký thì không gửi sự kiện nào** |
| `AbstractLSPFileListener.after()` → `LSPFileListener.onFileCreateAfter` / `onFileDeleteAfter` | Mỗi sự kiện tạo/xoá của VFS được so khớp theo **chính URI của nó**, không duyệt vào bên trong |

⇒ Với IntelliJ, server **bắt buộc** đăng ký qua `client/registerCapability`, và chỉ đăng ký khi
client khai báo `workspace.didChangeWatchedFiles.dynamicRegistration` (LSP 3.17). VSCode vốn đã gửi
nhờ `synchronize.fileEvents` trong `extension.ts`; `vscode-languageclient` 9 cũng khai báo
`dynamicRegistration` + `relativePatternSupport` nên nhận thêm watcher của server.

Dòng cuối của bảng là cái bẫy: khi VFS báo tạo/xoá **ở cấp thư mục** (git checkout thêm hay bớt
nguyên một thư mục, `rm -rf`), URI là của thư mục — không khớp `**/*.js`, nên không có sự kiện nào.
Vì vậy server đăng ký hai loại watcher:

| Watcher | `kind` | Vì sao |
|---|---|---|
| Mỗi glob trong `include` | Change | Chỉ file được index mới cần |
| `**/*` | Create \| Delete | Bắt được sự kiện ở cấp thư mục |

Dạng glob: `RelativePattern` neo vào gốc workspace khi client khai báo `relativePatternSupport`
(VSCode); chuỗi khi không (LSP4IJ — `PathPatternMatcher` tự neo glob tương đối vào thư mục project).

## J.3 Thiết kế: `Workspace.refreshFiles(paths)`

- **Index là lớp "đĩa", overlay không bị đụng tới.** Buffer đang mở vẫn là nguồn cho chính file đó
  (`facts()`/`source()` đọc overlay trước). Nhưng index **vẫn** cập nhật theo đĩa cho file đang mở.
  Phương án "bỏ qua file đang mở" đã cân nhắc và loại: VSCode tự nạp lại buffer chưa sửa khi git
  pull đổi file — overlay mới, index cũ, và template khác không thấy property mới của controller
  đó cho tới khi người dùng lưu (mà buffer không bẩn thì chẳng ai lưu).
- **Không tin loại sự kiện** (Created/Changed/Deleted) — `stat` lấy trạng thái thật. Sự kiện có thể
  bị gộp, lặp, đến sai thứ tự; VSCode còn gửi trùng từ watcher tĩnh lẫn watcher động.
- **So hash, không so mtime** — khác `index()`. File được báo là đổi thì đằng nào cũng phải đọc,
  còn mtime có thể giữ nguyên (`rsync -t`, `tar`, `cp -p`; HFS+ phân giải 1 giây). Đây cũng là lý
  do không gọi thẳng `index()` cho mỗi sự kiện: nó bỏ qua file khi mtime khớp.
- **File mới → `index()`**, vì chỉ glob của `index()` quyết `include`/`exclude` đúng. Trước đó lọc
  `exclude` bằng **chính fast-glob** trên riêng đường dẫn đó — file: đường dẫn tĩnh; thư mục: chỉ
  duyệt cây con `dir/**` — nên sự kiện trong `node_modules`, `dist`… không kéo theo quét lại. Không
  tự viết lại luật glob, không thêm dependency. (Kiểm tra tĩnh cho *thư mục* của fast-glob trả `[]`
  với tên có `(` hoặc `[`, như bị exclude — duyệt `dir/**` thì đúng.)
- **Xoá:** file trong index → gỡ; đường dẫn không phải file trong index → coi là thư mục, gỡ mọi
  file có tiền tố `dir/`.
- Cuối cùng `link()` một lần, và chỉ khi có gì đổi.

Không đổi extractor ⇒ **`PARSER_VERSION` giữ nguyên 11**; fact Layer 2 vẫn là hàm thuần của nội
dung một file.

## J.4 Đo trên `smart-city`

Store `:memory:`. Các phép đo có sửa file chạy trên **bản chép** trong thư mục tạm (không có
`node_modules`, `.git`) — repo thật chỉ đọc.

| Thao tác | Trung vị |
|---|---|
| `index()` ấm, repo thật (147 file) | 7.1ms |
| `index()` ấm, bản chép | 3.3ms |
| `refreshFiles`: 1 file đổi (`index.js`, 511 định danh) | 4.8ms |
| `refreshFiles`: báo đổi nhưng nội dung y nguyên | 0.09ms |
| `refreshFiles`: 1 file mới (→ `index()`) | 4.0ms |
| `refreshFiles`: file + thư mục mới trong `node_modules` | 0.24ms, không quét lại |

Ở 147 file hai cách ngang nhau. Khác nhau ở độ tăng: `index()` tỉ lệ với **tổng số file** (glob +
`stat` từng file), `refreshFiles` tỉ lệ với **số file đổi**. Và `index()` so mtime nên sai với
trường hợp mtime giữ nguyên.

`sweep`: 99.2%, 136 chỗ sót — không đổi. Toàn bộ output của `sweep` trùng từng dòng với bản trước
khi sửa (so trên bản chép).

## J.5 Test

Stdio (`packages/server/test/lsp.test.js`) và core (`packages/core/test/refresh.test.js`). Cả bảy
test đều đỏ khi chạy trên bản build **trước** khi sửa, xanh sau khi sửa.

| Test | Kiểm |
|---|---|
| `.js` đổi trên đĩa + báo → definition tới `moi` | Yêu cầu gốc; kèm đối chứng: trước khi báo vẫn `null` |
| File bị xoá | Hover không còn trỏ vào file đã xoá; `stats.files` giảm 1 |
| Cả thư mục tạo/xoá, một sự kiện | Kiểu LSP4IJ; thư mục mới trong `dist/` bị exclude |
| File đang mở đổi trên đĩa | Buffer thắng: offset trong buffer vẫn trỏ đúng `moi`, không rơi vào `total` |
| Đăng ký watcher | Kiểu LSP4IJ → chuỗi glob; kiểu VSCode → `RelativePattern`; không khai báo → không đăng ký |
| (core) mtime giữ nguyên | Hash bắt được thay đổi |
| (core) file mới bị exclude | Không quét lại toàn bộ |

**Race trong test, đã sửa:** server index đồng bộ lúc nhận `initialized`, còn test sửa file ngay sau
khi gửi `initialized` — có thể chạy **trước** index, và index đọc luôn bản mới. Chính lỗi này làm
test "buffer thắng" xanh giả trên bản chưa sửa ở lần chạy đầu. `startServer` nay chờ một request
sau `initialized`: server xử lý tuần tự, nên khi có phản hồi thì index ban đầu đã xong.

## J.6 Giới hạn đã biết

- **VSCode nhận sự kiện trùng** từ watcher tĩnh (`synchronize.fileEvents`) và watcher động của
  server. `refreshFiles` idempotent nên vô hại — lúc chạy thật, mỗi lần đổi file chỉ sinh một dòng
  `1 file doc lai` (J.7), trùng thì cũng bị gộp trong cùng một batch. Vẫn có thể bỏ watcher tĩnh.
- **Watcher `**/*` (Create \| Delete) báo cả file không liên quan** (`.git/index.lock`…): mỗi sự
  kiện tốn một `stat` rồi bị bỏ.
- **File khớp đuôi nhưng không khớp `include`** (vd `.eslintrc.js` — `dot: false`) kéo theo một lần
  `index()` mỗi khi đổi. Không cache "ngoài phạm vi" theo đường dẫn: file bị tạo/xoá xen kẽ trong
  lúc quét làm cache đó sai, và sai thì file bị bỏ qua tới khi khởi động lại.
- **`index()` chạy đồng bộ:** checkout đổi hàng nghìn file sẽ chặn server trong lúc quét, như lúc
  khởi động.
- ~~Server LSP không bao giờ gọi `workspace.close()`, nên cache NDJSON chỉ do CLI ghi.~~ **Đã sửa
  2026-09-19:** server ghi cache khi nhận `shutdown` của LSP, lần mở IDE sau là khởi động ấm (server
  bị kill thì lần sau vẫn lạnh); `.ejsng-cache/` tự chứa `.gitignore` (`*`) nên không lọt vào
  `git status` của người dùng. Vẫn còn: `didChangeConfiguration` vẫn được đăng ký động mà không kiểm capability của client, cùng loại lỗi
  với `prepareSupport` ở I.7.

## J.7 Chạy thật trong hai IDE (2026-09-12)

Cùng một cách đo ở cả hai: mở `smart-city`, sửa `dha.controller.js` (60KB, **không** mở trong editor)
từ bên ngoài, rồi theo dõi tiến trình server.

### IntelliJ — sandbox `runIde`, LSP4IJ 0.21.0

| Mốc | CPU tiến trình server |
|---|---|
| nghỉ 12 giây, không đụng gì | 0:01.12 |
| nghỉ thêm 12 giây | 0:01.12 |
| 12 giây sau khi file đổi trên đĩa | **0:01.19** |
| nghỉ tiếp 12 giây | 0:01.19 |
| sau khi khôi phục 2 file và **xoá** 1 file | **0:01.28** |

Nằm im 24 giây liền, tiêu 70ms ngay sau khi file đổi, rồi lại nằm im — không có gì khác đánh thức
nó. Chuỗi VFS → LSP4IJ → `didChangeWatchedFiles` → `refreshFiles` chạy thật, đúng như đọc từ mã
nguồn. Nhánh xoá cũng tới nơi.

Không đối chiếu được **số file** ngay trong IntelliJ: `window/logMessage` chỉ đi vào cửa sổ console
của LSP4IJ (`ServerMessageHandler.logMessage` → `LSPConsoleToolWindowPanel`), không vào `idea.log`,
nên script không đọc được — phải mở tool window **Language Servers** mà nhìn.

### VSCode — Extension Development Host, 1.136.2

VSCode ghi nội dung Output channel ra đĩa, nên đọc thẳng được dòng log của server ở
`~/Library/Application Support/Code/logs/<phiên>/window<N>/exthost/output_logging_*/`:

```
EJS/NG: bat dau danh index...
EJS/NG: xong — 0 file moi, 147 khong doi, 4 ref noi them, 158ms
EJS/NG: file doi ngoai editor — 1 file doc lai, 0 file go, 31ms
EJS/NG: file doi ngoai editor — 1 file doc lai, 0 file go, 22ms
```

Hai dòng cuối là hai lần sửa từ ngoài editor (đổi, rồi trả lại): mỗi lần đọc lại **đúng một** file,
31ms và 22ms — khớp với việc đã làm. CPU cùng hình dạng như bên IntelliJ: 0:00.22 phẳng suốt 24 giây
nghỉ, +70ms sau lần đổi, +40ms sau lần trả lại.

Dòng thứ hai đáng chú ý vì lý do khác: đây là khởi động **ấm** — 147 file không đổi, 158ms — nhờ
cache NDJSON mà `ejsng sweep` của CLI ghi ra trước đó. Lúc đó server tự nó chưa ghi cache (J.6), nên
trong IDE chỉ ấm được khi có ai đó chạy CLI trước — nay đã sửa, server ghi cache khi `shutdown`.

Và một điều phụ lục D đã đổi giá để học: server chạy bằng **Electron của VSCode** (`Code Helper
(Plugin)`) và bằng **Node v24.13.1** trong IntelliJ — hai ABI khác hẳn nhau, cùng một bundle, không
phải build riêng bản nào.

---

# PHỤ LỤC K — Go-to-definition: một đích thay vì danh sách chọn, và `confidence` nói đúng nghĩa (2026-09-12)

## K.1 Câu hỏi của người dùng

"Trong plugin thấy có confidence và nhiều option; nhiều option thì navigate được không? Sao
extension lại nhảy thẳng — hay VSCode track tốt hơn?"

Không phải VSCode tốt hơn: **hai IDE dùng chung một server**, cùng `definitionAt`. Khác nhau ở hai
chỗ. Một là UI của client — một đích thì cả hai nhảy thẳng, nhiều đích thì IntelliJ bật popup chọn
còn VSCode mở peek. Hai là trong file `.js`, VSCode còn có TypeScript built-in trả lời song song và
gộp kết quả mọi provider; IntelliJ Community không có plugin JavaScript nên server này là nguồn duy
nhất cho cả `.js` lẫn `.ejs`.

## K.2 Đo trước khi sửa (template của `smart-city`)

| | |
|---|---|
| Vị trí resolve được | 244 |
| Trả về **2 đích** | 168 (68.9%) |
| `confidence` đếm trên từng đích: `medium` / `high` | 358 / 54 |

Cả 168 chỗ chung một nguyên nhân: controller `cityos-demo-dha-management-view-controller` được khai
báo ở cả `product/…/index.js` lẫn `new-version/fe-be/index.js` (I.1 đã gặp khi làm rename). Không
chỗ nào trộn nhiều `kind`.

## K.3 Ưu tiên bản ở thư mục gần nhất

`preferNearest()` dùng lại `nearestFiles()` của rename, nên **definition và rename ghép theo cùng một
cách** — người dùng không phải nhớ hai luật.

Hai rào chắn, mỗi cái một test:

- **Chỉ gộp khi mọi đích cùng `kind`.** `jsDefinition` cố ý trả về cả khai báo Angular lẫn tham số
  hàm cùng tên (H.3); hai thứ khác loại, bỏ bản nào cũng sai.
- **Hoà thì giữ nguyên cả hai.** Template nằm cách đều hai bản thì không phân định được, và không
  phân định được thì không đoán.

Bản bị loại không biến mất: `DefinitionResult.otherFiles` mang chúng ra hover và CLI.

**Kết quả: 244/244 vị trí còn đúng một đích** — hết popup chọn ở cả hai IDE.

## K.4 `confidence` đang nói sai

```ts
confidence: walked.span ? m.confidence : ('medium' as const),
```

Dòng này hạ độ tin cậy xuống `medium` mỗi khi **không đi sâu vào shape** — kể cả `{{ total }}`, thứ
vốn chẳng có đường dẫn property nào để đi. Symbol thật là `high` (`rows.ts`). Vì vậy 358/412 đích
hiện "do tin cay: medium" trong hover — đúng thứ người dùng nhìn thấy trong IntelliJ, và nó nói sai
về sản phẩm: người đọc tưởng công cụ không chắc, trong khi nó rất chắc.

Sửa thành `walked.partial ? 'medium' : m.confidence`. Nay `medium` chỉ còn một nghĩa: **không lần
được tới khoá đang hỏi, mới nhảy tới chỗ gần đúng** — ví dụ `$scope.stats = fetchStats()` rồi hỏi
`stats.total`. Sau khi sửa, 244/244 đích là `high`.

## K.5 Kiểm chứng (a) và (d)

- `npm test`: 92/92.
- Hai test hành vi mới **đỏ** trên bản trước khi sửa (kể cả test trên repo thật). Hai test còn lại
  là rào chắn (hoà thì giữ cả hai; DI khác loại thì không gộp) nên **xanh ở cả hai bản** — đúng vai
  trò của chúng: chúng canh cho lần sửa này không phá thứ đang đúng.
- `sweep`: 99.2%, 136 chỗ sót, output trùng từng dòng với trước khi sửa. Lọc bớt đích không đổi việc
  một vị trí có resolve được hay không.

## K.6 Completion cũng chỉ lấy bản gần nhất

`membersOf(controller, from)` và `memberCompletions()` dùng chung `nearestRows()` với definition.

Đo trên `smart-city`, cùng một controller khai báo ở hai nhánh:

| Template | Trước | Sau |
|---|---|---|
| `new-version/fe-be/content.ejs` | 43 tên | **31 tên** |
| `product/view/content.ejs` | 43 tên | 43 tên — bản này là tập cha |

12 tên biến mất ở nhánh `new-version` — `uploadForm`, `documents`, `docStorage`, `onFilePicked`,
`loadDocuments`, `uploadDocument`… — là property **chỉ có trong bản `product`**. Trước đây chúng vẫn
được gợi ý khi gõ trong template của `new-version`: chọn phải là viết ra biểu thức không bao giờ có
giá trị, mà không gì báo. Đây là loại sai tệ hơn "thiếu gợi ý", vì nó trông như đã được xác nhận.

## K.7 Hover: đường dẫn thành link bấm được — đã xác nhận trong IntelliJ

Sau khi definition lọc bớt, hover là chỗ **duy nhất** còn chỉ ra bản ở thư mục xa — nên nó phải bấm
tới được. Hover thật trên `smart-city`, lấy bằng cách nói JSON-RPC thẳng với server:

```
**sections**
- scope-member 'sections' cua cityos-demo-dha-management-view-controller — [product/view/public/javascripts/index.js:32](file:///…/index.js#L32)
- _con 1 ban o thu muc xa hon:_ [new-version/fe-be/index.js](file:///…/new-version/fe-be/index.js)
```

Ba mảnh trong mã nguồn LSP4IJ 0.21.0 khớp với dạng link này:

| Chỗ | Nội dung |
|---|---|
| `LSPDocumentationLinkHandler` | Bắt `url.startsWith("file://")` rồi gọi `LSPIJUtils.openInEditor` — mở trong **editor của IDE**, không văng ra trình duyệt |
| `openInEditor` javadoc | Cú pháp hỗ trợ: `file:///…/foo.txt#L1:5` |
| `LSPIJUtils.toPosition` | `int line = toInt(0, positions) - 1; // Line numbers should be 1-based` |

Dòng cuối là chỗ đáng lo nhất, và hoá ra không phải lo: LSP4IJ đếm dòng **từ 1**. Phía VSCode,
`extractSelection` trong `workbench.desktop.main.js` đọc fragment bằng
`/^L?(\d+)(?:,(\d+))?(-L?(\d+)(?:,(\d+))?)?/` — cùng quy ước. Một chuỗi link chạy đúng ở cả hai IDE,
không lệch dòng.

**Chạy thật (2026-09-12):** `./gradlew buildPlugin` (9 giây, phần lớn từ cache) rồi `runIde`, với
`EJSNG_SERVER_PATH` trỏ vào bản server của worktree. Log sandbox:

```
Loaded custom plugins: LSP4IJ (0.21.0), EJS + AngularJS Navigator (0.1.0)
EJSNG: startup activity chay cho project 'smart-city'
pid 44893  …/node/v24.13.1/bin/node  …/packages/server/dist/index.js --stdio
```

Người dùng bấm thử trong IDE: **link mở đúng file, đúng dòng** — kể cả link tới bản ở thư mục xa,
thứ mà go-to-definition đã lọc khỏi danh sách nhảy. Vòng lặp khép kín: lọc bớt cho gọn, nhưng không
mất đường tới bản kia.

Server vẫn chạy bằng Node v24.13.1 — đúng bản ABI 137 từng làm vỡ `better-sqlite3` ở phụ lục D.

## K.8 Kiểm chứng và phần còn treo

- `npm test`: 95/95. Ba test mới (hai cho completion, một cho hover qua stdio) đều **đỏ** trên bản
  trước khi sửa; 13 test còn lại xanh ở cả hai bản.
- `sweep` không đổi — completion và hover không nằm trong đường đo độ phủ.
- **IntelliJ: đã bấm thử trong IDE thật** — link mở đúng file, đúng dòng (K.7). **VSCode: đã bấm
  thử trong Extension Development Host (2026-09-12)** — hover tại `sections` dòng 13 của
  `new-version/fe-be/content.ejs`, bấm link `product/view/public/javascripts/index.js:32` nhảy
  đúng file đúng dòng. Cả hai IDE đã xác nhận bằng tay — không còn phần treo của phụ lục K.

---

# PHỤ LỤC L — Soát lại trước khi bàn giao: bốn lỗi, đã sửa kèm test (2026-09-12)

Chạy `/code-review` (built-in) trên diff của cả phiên, như I.7 đã làm trước khi commit. Bốn phát
hiện, đều là lỗi thật trong code của chính phiên này; mỗi lỗi có một test đỏ trước khi sửa.

| Lỗi | Hậu quả | Sửa |
|---|---|---|
| `catch` quanh `statSync` coi **mọi** errno là "file đã xoá" | Repo nằm trên volume gắn ngoài (`/Volumes/…`): một lần EACCES hay EIO là file đang tồn tại bị gỡ khỏi index — im lặng, tới tận lần reindex sau | Chỉ `ENOENT`/`ENOTDIR` mới là đã xoá; errno khác nghĩa là *không biết*, bỏ qua path |
| `fast-glob` mặc định **ném** lỗi (`suppressErrors: false`) | Một thư mục không đọc được làm `refreshFiles` ném **trước** `upsertBatch` → mất sạch cả lô thay đổi hợp lệ trong cùng thông báo | `suppressErrors: true` ở `hasCandidates` **và** ở `index()` — cùng một lỗ hổng |
| `detail` in cả đường dẫn **đã hỏi** trong khi shape chỉ lần được nửa chừng | Hover nói `row.a.b — phan tu cua rows` nhưng nhảy vào `a`: người đọc tưởng khoá `b` có thật | `detail` gọi tên đoạn **thực sự tới được**, khớp với `confidence` vừa hạ xuống `medium` |
| Quét tiền tố toàn bộ index cho **mỗi** đường dẫn xoá lạ | Watcher `**/*` báo cả file không index; `rm -rf` gửi hàng nghìn sự kiện → O(số path × số file index) chặn server ngay sau khi checkout | Gom thư mục bị xoá, duyệt `stamps` **một lần** cho cả lô |

Hai lỗi đầu chung một gốc: **xử lý lỗi hệ thống tập tin như thể chỉ có một nguyên nhân duy nhất là
"file biến mất"**. Trong một tính năng mà đầu vào toàn là sự kiện từ đĩa, đó là giả định sai người.
Cả hai kiểm được bằng `chmod 000` trong thư mục tạm — `statSync`, `fg.sync` dạng file tĩnh lẫn
`dir/**` đều ném `EACCES`, đã thử tay trước khi viết test.

Sửa lỗi thứ tư kéo theo một cải thiện không nằm trong bản soát: sự kiện báo về một thư mục **đang
tồn tại** (client tạo lại, hoặc đổi tên tới) trước đây gỡ sạch mọi file dưới nó rồi để `index()` thêm
lại từ đầu. Nay thư mục còn thì chỉ quét lại, không gỡ gì — hết cảnh parse lại cả cây con và hết con
số `removed` sai trong log.

Và một cáo buộc **bị bác bỏ lúc sửa**: bản soát nói cả hai chỗ gán `confidence` đều in nhãn dối. Đọc
kỹ thì nhánh property trên `$scope` vốn đã dùng `fullPath.slice(0, walked.depth + 1)` — nó gọi đúng
tên đoạn đường đi tới từ đầu. Chỉ nhánh biến `ng-repeat` mới in cả đường dẫn đã hỏi, nên chỉ sửa một
chỗ. Soát kỹ thì cũng phải soát lại chính bản soát.

---

# PHỤ LỤC M — Tách definition resolution khỏi Workspace (2026-09-13)

## M.1 Vì sao

`/mattpocock-skills:improve-codebase-architecture` quét kiến trúc, thấy `workspace.ts` phình tới
1465 dòng — gấp 3 file lớn thứ nhì (`template.ts`/`js.ts`, ~490 dòng mỗi cái). Subagent Explore áp
**deletion test** cho từng khối trong file: xoá `walkShape`/`shapeOf`/`candidateDefinition` (khi đó
670-883) khỏi `workspace.ts` thì độ phức tạp **biến mất hẳn** — không dồn sang đâu, vì khối này chỉ
đọc qua `this.facts()`/`this.store`, không đụng overlay/watcher. Ngược lại, rename orchestration
(962-1204) xoá đi thì độ phức tạp **kẹt lại**, không tự dồn về `rename.ts` — báo hiệu nó cần state
riêng của `Workspace`, chưa sẵn sàng tách (để dành cho một vòng sau).

## M.2 Thiết kế (chốt qua `/grilling`)

- **`packages/core/src/resolve/definition.ts`** (449 dòng) — `resolveDefinition(deps, relPath,
  offset)`: dispatch `templateDefinition`/`jsDefinition`, cùng `candidateDefinition`,
  `declarationAround`, `symbolTargets`. KHÔNG gồm `preferNearest`/`nearestRows` (lọc "bản gần
  nhất") — đó vẫn là việc của `Workspace.definitionAt`, gọi sau khi có kết quả thô.
- **`packages/core/src/resolve/shape.ts`** (65 dòng) — `walkShape`, `shapeOf`, `shapeAtPath`. Tách
  riêng khỏi definition vì **completion cũng dùng chung** (`Workspace.memberCompletions` gọi
  `shapeOf`) — nhét vào definition sẽ bắt completion phụ thuộc ngược.
- **`FactSource`** (định nghĩa trong `shape.ts`) — interface hẹp: `facts()`, `source()`,
  `findSymbols()`, `moduleAliases`. `Workspace implements FactSource`, tự truyền `this` vào hai
  module trên thay vì chúng cầm cả class.
- `inSpan`, `wordAt`, `ANGULAR_DECL_KINDS`, `expressionAt` **ở lại** `workspace.ts` (export) vì
  dùng chung với `referencesAt`/rename/`completionAt` — `definition.ts` import ngược lại. Đây là
  một circular import (CommonJS) nhưng an toàn: cả hai bên chỉ gọi nhau bên trong thân hàm, không
  ở top-level module, nên thứ tự khởi tạo không va nhau. `depthAt`, `isMemberOfScopeObject`,
  `quotedStringAt` chỉ `jsDefinition`/`templateDefinition` dùng — chuyển hẳn, không import ngược.

Ghi hai thuật ngữ **Definition Resolution** và **Shape Walking** vào `CONTEXT.md` (tạo mới, repo
trước đó chưa có glossary).

## M.3 Kết quả (candidate A)

`workspace.ts`: 1465 → 1003 dòng. Không đổi hành vi — mọi test cũ chỉ gọi qua `definitionAt`/
`membersOf` public, không đụng thẳng private method, nên không sửa test nào:

```
npm test                                                              # 99/99, khong doi
node packages/cli/dist/index.js sweep --root .../smart-city           # 99.2%, 136 sot, khong doi
```

Dọn thêm sau khi soát lại: `symbolTargets` bản cũ trong `workspace.ts` là code chết sót lại
(quên xoá khi tách sang `definition.ts` — không ai gọi nữa, `tsc` không báo vì nó là private
method trùng tên với hàm export ở file khác, không phải trùng identifier cùng scope).

## M.4 Candidate C — interface riêng cho "ưu tiên bản gần nhất"

`nearestRows`/`preferNearest` hoá ra **đã thuần từ đầu** (không đụng `this` dù khai báo là
private method) — chỉ cần chuyển hẳn sang `rename.ts`, cạnh `nearestFiles` mà chúng dùng
chung, không cần interface `FactSource`/`RenameSource` nào cả. Ký hiệu generic
(`<T extends { path: string }>`, `<R extends { targets: …; otherFiles?: string[] }>`) để không
kéo thêm phụ thuộc kiểu `SymbolRow`/`DefinitionResult` ngược vào `rename.ts`.

Thêm 2 test thuần trong `nearest.test.js` gọi thẳng `nearestRows`/`preferNearest` với mảng/object
giả — không `mkdtempSync`, không `Workspace.index()`. Đây là lợi ích "locality" mà candidate C
hứa: quy tắc thuần giờ kiểm được mà không trả phí I/O.

```
npm test    # 101/101 (99 cu + 2 test moi)
```

## M.5 Candidate D — core tự cung cấp watch pattern

`server/index.ts` từng tự đọc `ws.config.include` rồi lọc pattern `!` để suy luận glob cần
watch — domain-knowledge của core rò rỉ sang lớp dịch giao thức LSP. Thêm
`Workspace.changeWatchPatterns(): string[]` (một dòng, không cần module riêng), server chỉ gọi
hàm này. Đổi ngữ nghĩa include/exclude sau này chỉ sửa một chỗ.

## M.6 Candidate B — seam thật cho rename orchestration

Khác hẳn candidate A: deletion test cho thấy phần này **cần thật** state riêng của `Workspace`
(`Linker`, danh sách file đang mở trong editor) — không thể tách thành hàm hoàn toàn độc lập.
Giải pháp: một interface **rộng hơn** `FactSource`, gọi là `RenameSource`
(`packages/core/src/resolve/rename-orchestrator.ts`):

```ts
interface RenameSource {
  facts(relPath): FileFacts | null;
  source(relPath): string | null;
  config: Config;
  findSymbols(name, container): SymbolRow[];
  templatePaths(): string[];
  openTemplatePaths(): string[];        // thay vi doc thang Map `overlays` rieng cua Workspace
  resolveScopeRefs(candidates): RefInput[]; // boc Linker, giau hoan toan Linker khoi orchestrator
}
```

Hai method mới trên `Workspace` (`openTemplatePaths`, `resolveScopeRefs`) chỉ là lớp bọc một
dòng quanh state đã có — bản thân state (`overlays`, `linker`) vẫn `private`, orchestrator không
bao giờ chạm trực tiếp.

`renameAt`/`prepareRenameAt`/`renameTargetAt`/`templateRenameTarget`/`scopeTarget`/
`declarationFiles`/`jsRenameEdits`/`templatesUsing`/`templateRenameEdits` — cả cụm ~240 dòng —
chuyển nguyên sang `rename-orchestrator.ts`. `Workspace.renameAt`/`prepareRenameAt` co lại còn
2 dòng gọi thẳng hàm export, `Workspace implements FactSource, RenameSource`.

Dọn thêm: interface `RenameEdits` (bản khai báo riêng trong `workspace.ts`, không export) thành
dead code sau khi orchestration chuyển đi — xoá, bản dùng thật giờ ở `rename-orchestrator.ts`.

## M.7 Kết quả tổng (A+C+D+B)

`workspace.ts`: 1465 → 738 dòng (còn lại: index/watcher/overlay, `referencesAt`, `completionAt`/
`rootCompletions`/`memberCompletions`, và các method public mỏng gọi sang 3 module mới).

```
npx tsc --build --force                                               # sach, khong loi
npm test                                                              # 101/101
node packages/cli/dist/index.js sweep --root .../smart-city           # 99.2%, 136 sot, khong doi
```

Không sửa test nào có sẵn ở cả 4 candidate — toàn bộ đi qua public API
(`definitionAt`/`renameAt`/`prepareRenameAt`/`membersOf`/`completionAt`), đúng bất biến đã đặt ra
từ đầu vòng `/grilling`.

Ghi chú kỹ thuật lặp lại ở cả 2 lần tách (definition, rename): vài hàm/hằng dùng chung giữa module
mới và phần ở lại `workspace.ts` (`inSpan`, `wordAt`, `ANGULAR_DECL_KINDS`, `expressionAt`,
`TEMPLATE_EXT`, `JS_EXT`) — export từ `workspace.ts`, import ngược lại. Circular import kiểu
CommonJS nhưng an toàn vì hai bên chỉ gọi nhau trong thân hàm, không ở top-level; đã build + chạy
test thật (kể cả test LSP qua stdio) để xác nhận không vỡ ở runtime, không chỉ ở compile-time.
