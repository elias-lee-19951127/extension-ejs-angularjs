# 08 — Log từ file ngoài workspace

**What to build:** Với mount lồng nhau, file runtime thật sự chạy có thể nằm ở một repo khác chưa
mở trong workspace. Hiện các log đó bị bỏ im lặng. Ticket này vẫn vẽ chúng khi người dùng mở file,
trong giới hạn an toàn: Runtime Path do một tiến trình mạng gửi tới, không đáng tin.

**Blocked by:** 06 — chỉ vẽ sau khi nội dung đã được kiểm.

**Status:** done

- [x] Server chỉ đọc file nằm **dưới phía host của một Path Mapping** (mount hoặc tự khai), hoặc
      trong workspace; ngoài phạm vi đó thì bỏ và đếm
- [x] File chỉ được đọc để tính vị trí dòng; nội dung hiển thị vẫn là giá trị log
- [x] Mở file đó trong editor thì decoration hiện đúng dòng, kể cả file ngoài workspace
- [x] Panel có nút gợi ý thêm thư mục liên quan vào workspace; extension **không** tự thêm
- [x] Test qua LSP: log trỏ tới file ngoài mọi mapping phải bị từ chối đọc

## Comments

**2026-09-17, agent:** Xong cả 5 mục. Các quyết định đáng ghi lại:

- **Ranh giới đọc là một hàm thuần duy nhất**, `isUnderMappingLocal` (`packages/core`): file được đọc
  khi nằm trong workspace, **hoặc** dưới phía host của một Path Mapping (mount suy ra từ ticket 05,
  hoặc người dùng tự khai). Khớp theo **nguyên segment** như `mapContainerPath`, nên
  `<dir>-old/x.js` không tính là nằm dưới `<dir>`. Có cặp test đối chứng cho đúng chỗ này: cùng một
  hình dạng, lệch nhau đúng một ranh giới segment — cái trong thì vẽ, cái ngoài thì từ chối.
- **Hai điều kiện, và phải theo thứ tự này.** Path đã khớp mapping thì đương nhiên nằm dưới phía
  host của mapping đó; điều kiện `isUnderMappingLocal` còn nhận thêm ca path **không** khớp mapping
  nào nhưng vốn đã là đường dẫn host thật nằm dưới một mapping — bind mount có container path trùng
  host path, hoặc tiến trình chạy ngoài Docker trên thư mục người dùng đã khai.
- **Sửa một hồi quy do chính ticket 05 gây ra**, do test của ticket này lòi ra: ticket 05 bỏ log
  ngay khi "không mapping nào phủ" *trước cả* khi xét workspace. Hệ quả là chỉ cần có **bất kỳ**
  mapping nào được cấu hình, một `node --inspect` chạy local báo đường dẫn vốn đã đúng trong
  workspace cũng bị bỏ với lý do `no-path-mapping`. Giờ `no-path-mapping` chỉ còn là **cách gọi tên**
  cho ca đã bị từ chối bởi ranh giới trên (khi có mapping mà không cái nào phủ), thay vì là một cửa
  chặn riêng đứng trước. Đã thêm test hồi quy cho đúng ca này.
- **File ngoài workspace được địa chỉ hoá bằng đường dẫn tuyệt đối**, không qua workspace root (nó
  không có dạng tương đối nào với root cả). File trong workspace vẫn đi qua root như cũ — đó là thứ
  giữ cho URI khớp với editor khi root nằm sau symlink (bản sửa của ticket 02). Decoration phía
  client vốn khớp theo URI nên hiện đúng dòng ngay khi người dùng mở file, không cần sửa gì thêm.
- **File chỉ được đọc để tính vị trí dòng** (mục 2): giá trị hiển thị vẫn là giá trị log. Có test
  khẳng định đúng điều này thay vì chỉ ngầm hiểu.
- **Gợi ý thêm thư mục, không bao giờ tự thêm** (mục 4): server gom thư mục của các file ngoài
  workspace **đã thật sự vẽ được** vào `outsideWorkspaceDirs` (Set, chặn trên 5 — một mount có thể
  chứa cả repo) và báo qua `ejsng/runtimeStatus`. Panel hiện mỗi thư mục một thẻ kèm nút "Add to
  workspace"; `vscode.workspace.updateWorkspaceFolders` chỉ chạy khi người dùng bấm — thêm folder
  làm khởi động lại extension host, nên phải là quyết định của họ.
- **Test**: file mới `packages/server/test/runtime-log-outside-workspace.test.js` (6 ca, LSP
  end-to-end) và 2 ca mới trong `packages/vscode-client/test/runtime-log-state.test.js` cho việc gộp
  thư mục giữa nhiều kết nối. Ca "từ chối" dùng **file thật, đọc được** nằm ngoài mọi mapping — để
  test chứng minh là ranh giới chặn, không phải file tình cờ không tồn tại.
- `npm test` ở gốc repo: 277 test, 272 pass — 5 fail còn lại là fixture `smart-city` có sẵn từ trước.
