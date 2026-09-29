# Spec: Completion hiểu AngularJS — template và JS

**Ngày viết:** 2026-09-29 · **Trạng thái:** đã triển khai 2026-09-29 — ticket 01–06 done

## Vấn đề

Completion trong template đã có (`Workspace.completionAt`) nhưng chỉ đúng với `$scope` phẳng của **một**
controller. Đo trên fixture + workspace thử (2026-09-29):

| Gõ | Có | Đúng ra |
|---|---|---|
| `{{ vm. }}`, `{{ vm.model. }}` (`FormCtrl as vm`) | không gì | `model`, `submit` / `email`, `age` |
| `{{ x }}` dưới `as vm` | `vm, model, submit` | `vm` (member `this.` không có trên scope) |
| `{{ user. }}` trong controller con, `user` ở controller cha | không gì (definition cũng "not found") | `name`, `roles` |
| `{{ $ctrl. }}` trong template của component | không gì | `expanded`, `toggle`, binding `user`, `onSelect` |
| `{{ total \| ` | biến scope | filter |
| `<my-`, `<input pick` , `<my-widget ` | biến scope | component/directive, binding |
| JS: `$scope.`, `vm.`, `UserService.` | không gì (TS thấy `any`) | member đã gán / key service trả về |

Index đã có đủ dữ liệu; chỉ completion chưa dùng.

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | Chuỗi scope được đọc **từ trong ra ngoài** qua mọi frame controller, dừng ở frame `isolate`. Frame gần hơn thắng khi trùng tên. | Đúng cách AngularJS kế thừa prototype của scope. Isolate scope thì không kế thừa. |
| 2 | Alias (`vm`, `$ctrl`, `outer`) được khớp với **frame có alias đó**, không chỉ alias đầu tiên. | `outer.x` trong `InnerCtrl as vm` lồng trong `OuterCtrl as outer` phải về `OuterCtrl`. |
| 3 | Dưới controller có alias, gốc chỉ gợi ý alias + member gán qua `$scope`; member `this.` chỉ hiện sau `alias.`. Không có alias thì giữ như cũ (gợi ý tất cả). | Member `this.` không nằm trên scope. Không có alias mà vẫn có `this.` thường là do không đọc được alias → an toàn hơn khi vẫn gợi ý. |
| 4 | `alias.` của component/directive gợi ý thêm các binding (`bindings`/`scope`/`bindToController`). | `$ctrl.user` là binding, không phải phép gán trong controller. |
| 5 | Kế thừa scope (#1, #2) áp dụng cho **go-to-definition** (và hover dựa trên nó), không chỉ completion. | Một tên gợi ý được mà Ctrl+Click báo "not found" là mâu thuẫn. |
| 6 | Sau `\|` (không phải `\|\|`) chỉ gợi ý filter: filter của workspace + filter built-in. | |
| 7 | Tên tag: component + directive có `restrict` chứa `E` (mặc định `EA`), dạng kebab-case. Tên attribute trong thẻ: directive `restrict` chứa `A`, cộng binding của component/directive ở tag đó, chèn `name="…"`, bỏ attribute đã có. | Như AngularJS normalize tên. |
| 8 | Ngoài biểu thức Angular (văn bản thường, attribute HTML thường) **không** gợi ý biến scope nữa. Chỉ gợi ý trong `{{ … }}` (kể cả chưa đóng) và giá trị attribute là biểu thức. | Trước đây gõ văn bản bất kỳ trong HTML cũng bật ra biến scope — nhiễu. |
| 9 | JS: sau `$scope.`/`this.`/`vm.` (alias `= this`) trong controller, directive, component → member của owner theo đúng `via`, cộng key của phép gán lồng (`$scope.form.extra = …`) và binding (#4) cho `this.`. | TS server không biết DI của AngularJS. |
| 10 | JS: sau tên service được inject (`UserService.`, kể cả tham số bị đổi tên theo mảng DI) → key của object factory trả về (`return {…}` hoặc `var svc = {…}; svc.x = …; return svc`), member `this.` của `.service`, shape của `.value`/`.constant`. Tính lúc truy vấn, không đổi facts. | Không phải bump `PARSER_VERSION` / reindex. |
| 11 | Hàm gợi ý dạng Method, chèn `name()` (con trỏ trong ngoặc nếu có tham số); `detail` ghi nguồn (`on the $scope of X`, `inherited from X`, `binding '<' of userCard`). Scope gần xếp trước. | |

## Không làm

- Kiểu tĩnh kiểu TS/JSX: vẫn chỉ là "những gì code gán" + shape suy từ object literal.
- `$parent.`, `$root.`, provider `$get`, service trả về từ hàm khác file.
- Refs/rename theo kế thừa scope (`rows.ts` vẫn gắn ref vào controller gần nhất).
