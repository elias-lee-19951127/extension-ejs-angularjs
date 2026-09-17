# 05 — Path Mapping suy từ mount Docker

**What to build:** Log từ container báo Runtime Path kiểu `/home/cityos/aocs-cityos/aocs/...`,
không tồn tại trên máy chạy extension. Mount của chính container biết chính xác nó là thư mục nào,
kể cả khi mount lồng nhau — trường hợp mà đoán theo tên thư mục sẽ ra nhầm repo.

**Blocked by:** 04 — phải biết đang kết nối container nào mới đọc được mount của nó.

**Status:** done

- [x] Mapping suy từ mount của container đang kết nối, áp dụng **mount có đích dài nhất trước**
- [x] `ejsng.runtimeLog.pathMappings` do người dùng khai vẫn **thắng** mọi mapping suy ra
- [x] Phía `local` của mapping hỗ trợ `${workspaceFolder}`; đường dẫn tuyệt đối cũ vẫn chạy y như
      trước (tương thích ngược)
- [x] Mapping suy từ mount **không** ghi vào settings — tính lại mỗi lần Connect
- [x] Không mapping nào bao phủ thì log bị bỏ và đếm đúng lý do (không im lặng)
- [x] Test qua LSP với fixture mount lồng nhau thật: log từ thư mục bị che phải về repo đang thật
      sự chạy, không về repo bị che

## Comments

**2026-09-17, agent:** Xong cả 6 mục. Các quyết định đáng ghi lại:

- **Mapping suy từ mount** (`mappingsFromMounts`, `packages/core/src/runtime-log-docker.ts`):
  mỗi mount thành `{remote: Destination, local: Source}`, sắp xếp theo độ dài phía container
  GIẢM DẦN. `mapContainerPath` là first-match-wins, nên sắp dài-trước chính là cách mount lồng
  nhau ra đúng: `docker inspect` liệt kê mount ngoài (`/home/cityos/aocs-cityos`) TRƯỚC mount trong
  (`/home/cityos/aocs-cityos/aocs`), giữ nguyên thứ tự đó thì mọi log của repo `aocs` sẽ rơi vào
  thư mục bị che của repo `aocs-cityos-lusail`. Đặt ở `runtime-log-docker.ts` (cạnh `DockerMount`)
  chứ không phải `runtime-log.ts`, đúng kiểu tách file ticket 04 đã dựng.
- **Đổi shape `mapContainerPath`**: trả về `{path, matched}` thay vì `string`. Cần `matched` để
  phân biệt hai ca trước đây giống hệt nhau về kết quả: "đường dẫn này không cần mapping" (ca
  local, không Docker — đi tiếp như cũ) và "không mapping nào bao phủ đường dẫn này" (mục 5 —
  phải đếm và nói ra). Đã sửa test cũ trong `packages/core/test/runtime-log.test.js` theo shape
  mới; không giữ wrapper string cũ vì server là caller duy nhất.
- **Lý do bỏ mới `no-path-mapping`**: chỉ kích hoạt khi CÓ mapping (người dùng khai hoặc suy ra)
  mà không cái nào khớp. Không mapping nào cả thì giữ nguyên hành vi cũ (đi tiếp, hỏng thì rơi vào
  `outside-workspace`) — test cũ của ticket 11 ("without a matching mapping … still dropped as
  outside the workspace") vẫn xanh không đổi. Tách khỏi `outside-workspace` vì cách sửa khác nhau:
  một bên là thêm mapping/mount, bên kia là mở thêm thư mục vào workspace (ticket 08). Frame bị bỏ
  vì lý do này vẫn ĐI TIẾP sang frame kế, đúng vòng lặp ticket 03 dựng.
- **Mapping là per-connection, không phải global**: `RuntimeLogConnectionInfo` có thêm
  `inferredPathMappings` — hai kết nối sống cùng lúc có thể là hai container với mount hoàn toàn
  khác nhau, nên không thể để một biến module dùng chung. Lúc chọn frame, danh sách hiệu lực là
  `[...user, ...inferred]` — user trước, và vì first-match-wins nên đó chính là cách mục 2
  (user thắng) được bảo đảm, không cần code so sánh riêng.
- **Mount tới được cả 3 đường Connect**: `ejsng/discoverRuntimeTargets` ghi mount của mọi container
  connectable vào `dockerMountsByEndpoint` (key `host:port`), `clear()` trước mỗi lần discovery.
  Cần vậy vì hai đường follow-up sau Quick Pick — `ejsng/connectRuntime` (sau
  `'choose-container'`) và `ejsng/connectRuntimeTarget` (sau `'choose'`) — chỉ mang host:port,
  không mang danh tính container nào cả; nếu chỉ truyền mount ở nhánh "đúng một container" thì
  người dùng có 2 container sẽ mất mapping mà không hiểu vì sao. `clear()` mỗi lần cũng chính là
  mục 4: container build lại với mount khác được nhận ngay, và không entry cũ nào sống sót.
- **`${workspaceFolder}`** (`resolvePathMappings`, `packages/core`): giãn MỘT LẦN trong
  `onInitialize`, nơi biết root — không giãn ở lúc khớp từng log. `local` không chứa biến thì trả
  về nguyên si, nên mọi cấu hình đường dẫn tuyệt đối cũ chạy y hệt. Chỉ giãn phía `local`; `remote`
  là đường dẫn trong container, biến workspace không có nghĩa ở đó.
- **Panel**: `formatSkipReason` (`packages/vscode-client/src/runtime-log-state.ts`) có thêm nhánh
  cho `no-path-mapping`; `droppedByReason` vốn là map mở nên số đếm hiện lên không cần sửa gì.
  Mô tả setting `ejsng.runtimeLog.pathMappings` viết lại: giờ thường KHÔNG cần khai tay nữa, khai
  là để ghi đè, và `local` dùng được `${workspaceFolder}`.
- **Test**: `packages/core/test/runtime-log-docker.test.js` (thứ tự mount lồng nhau, ráp với
  `mapContainerPath`), `packages/core/test/runtime-log.test.js` (`matched`, `resolvePathMappings`),
  và file mới `packages/server/test/runtime-log-mount-mapping.test.js` (LSP end-to-end qua fake
  `docker` CLI của ticket 04). Fixture mount lồng nhau dựng THƯ MỤC THẬT cho cả hai khả năng —
  `<root>/aocs/utility/log.js` (repo đang chạy) và `<root>/lusail/aocs/utility/log.js` (bản bị
  che) — để test phân biệt được "chọn đúng" với "chọn sai nhưng file kia tình cờ không đọc được".
  Đã kiểm chứng bằng cách đảo chiều sort: 2 test mount lồng nhau đỏ ngay, phần còn lại xanh.
- `npm test` ở gốc repo: 251 test, 246 pass — 5 fail còn lại là fixture `smart-city` có sẵn từ
  trước (đã xác nhận bằng cách stash toàn bộ thay đổi và chạy lại trên HEAD sạch: y hệt 5 cái đó).
