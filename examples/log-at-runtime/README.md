# Demo: "Log at runtime"

Chạy được hoàn toàn trên Node, không cần trình duyệt hay app Angular thật. Spec:
`.scratch/log-variable/spec.md`; kiến trúc: `docs/kien-truc.md` mục 5.3.3.

## Chạy

1. **Mở Extension Development Host:** trong repo này bấm `F5` (cấu hình "Run Extension" ở `.vscode/launch.json`).
   Một cửa sổ VS Code thứ hai mở ra đã cài sẵn extension.
2. Trong cửa sổ đó: **File → Open Folder…** → chọn chính thư mục này (`examples/log-at-runtime`).
3. Mở terminal trong thư mục này và chạy:

```bash
node --inspect list.controller.js
```

Node in ra `Debugger listening on ws://127.0.0.1:9229/...` — cổng 9229 là mặc định.

## Kiểm

1. Mở `list.html`, **hover** vào `rows` trong `ng-repeat="row in rows"`.
   Hover ghi `unknown[]` và `Could not be inferred — assigned from res.data.rows`, kèm link **Log at runtime**.
2. **Bấm link.** `list.controller.js` có thêm một logpoint ở lề, ngay sau `$scope.rows = res.data.rows;`.
   Thông báo hiện ra với nút **Connect Runtime** và **Show**.
3. Bấm **Connect Runtime** (hoặc lệnh `EJS/NG: Connect to Runtime`, nhập `127.0.0.1:9229`).
4. Đợi một giây rồi **hover lại vào `rows`**. Giờ hover có:
   - kiểu thật: `{ id: number, title: string, owner: { id: number, name: string }, tags: unknown[] }[]`
     (`tags` ra `unknown[]` chứ không phải `string[]`: nó nằm ở cấp lồng thứ ba, ngoài giới hạn đào
     2 cấp — đúng như hover hiển thị được, xem `docs/kien-truc.md` mục 5.3.2)
   - dòng `Seen at runtime: N× — last HH:MM:SS via …, logged at list.controller.js:…`
   - dòng `Not inferred statically (res.data.rows) — shape from runtime`
   Thanh trạng thái dưới đáy hiện `… · N types seen`.
5. Hover `row.owner.name` trong template → `string` (đi qua phần tử `ng-repeat`, hai cấp lồng).
6. Làm tương tự với `selected` (`{{ selected.label }}`): cứ 3 giây nó là `null` một lần, nên hover sẽ ghi
   `{ id: number, label: string } | null`, `Only assigned in a callback` (chưa có giá trị ở lần render đầu)
   và `Seen null/undefined at runtime` — **nhưng không** có chú thích inline `may be empty`, vì không lần gán
   nào trong code gán `null`. Trong demo này template không có chú thích inline nào cả.
7. Bấm link **Log at runtime** lần nữa: không sinh logpoint thứ hai, chỉ báo "is already logged".

## Đã chạy thử

Toàn bộ các bước trên đã được chạy tự động một lần (không qua giao diện) trước khi bàn giao: hover trước/sau,
đặt logpoint đúng bằng tham số mà link mang, nối `node --inspect`, 8 log được vẽ, 4 bằng chứng kiểu, và hover
ra đúng các dòng nêu trên. Phần duy nhất chỉ bạn kiểm được là **bấm chuột vào link** và các nút của thông báo.

## Xem giá trị log đầy đủ

`list.controller.js` có sẵn một `console.log('rows', $scope.rows)`. Khi đang nối runtime:

8. Mở `list.controller.js`. Cạnh dòng `console.log` có giá trị vẽ inline — là object thật, không phải `[Object]`:
   `rows [{id: 1, title: 'Sensor A', owner: {…}, tags: […]}, …]`.
9. **Hover** vào dòng đó: giá trị trải ra nhiều dòng, kèm link **Show full value**.
10. Bấm link → mở một tab JSON chỉ đọc với **toàn bộ** giá trị (sâu hơn bản inline). Tab này gập/mở từng nhánh,
    tìm kiếm và copy được — đều là sẵn có của VS Code.

Tắt bằng setting `ejsng.runtimeLog.expandValues` nếu không muốn extension hỏi app về giá trị.

## Dọn

Xoá logpoint trong Breakpoints view của VS Code, tắt tiến trình Node.
