# 07 — Khớp đuôi URL cho log trình duyệt

**What to build:** Log từ Chrome mang URL (`http://localhost:5000/javascripts/index.js`), không phải
đường dẫn file, và không có mount nào nói nó là file nào. Ticket này khớp phần đuôi đường dẫn với
file đã index — nhưng **chỉ cho URL**, không bao giờ cho đường dẫn file của Node, vì với mount lồng
nhau kiểu khớp này sai một cách thuyết phục.

**Blocked by:** 05, 06 — khớp đuôi là nguồn cuối cùng sau mapping, và kết quả của nó phải qua kiểm
tra nội dung mới được vẽ.

**Status:** done

- [x] Chỉ áp dụng cho Runtime Path dạng `http(s)://`; đường dẫn file không bao giờ đi qua đường này
- [x] Chọn file có đuôi trùng **dài nhất và duy nhất**
- [x] Khớp nhiều file → **không vẽ**, đếm đúng lý do, panel nói ra các ứng viên
- [x] Mapping suy ra chỉ sống trong phiên kết nối; panel có nút lưu, chỉ ghi settings khi người
      dùng bấm (ghi theo quy ước của ticket 05: `${workspaceFolder}`, không thì User settings)
- [x] Kiểm tra nội dung của ticket 06 vẫn là điều kiện bắt buộc — bắt được ca URL khớp bản đọc được
      trong khi server trả bản obfuscate

## Comments

**2026-09-17, agent:** Xong cả 5 mục. Các quyết định đáng ghi lại:

- **Khớp đuôi sinh ra một MAPPING THƯ MỤC, không phải vị trí của một file.**
  `http://localhost:5000/javascripts/index.js` khớp `public/javascripts/index.js` (2 segment) →
  `{remote: 'http://localhost:5000', local: '<root>/public'}`. Hai cái lợi: mọi script khác cùng
  thư mục đi thẳng qua `mapContainerPath`, **không quét index lần nào nữa**; và đó cũng chính là
  thứ panel đưa ra để lưu (mục 4) — lưu một mapping thư mục thì hữu dụng, lưu vị trí một file thì
  không. Có test cho cả vòng tròn: mapping suy ra phải giải lại đúng URL gốc về đúng file gốc.
- **"Dài nhất VÀ duy nhất"** (mục 2): đếm số segment ĐUÔI trùng nhau, lấy max; hoà thì
  `'ambiguous'` — không có tiebreak nào cả. Cố ý: cả ticket này tồn tại để tránh một câu trả lời
  sai một cách tự tin, nên thà không vẽ. Có test cho ca "một khớp dài hơn thắng một cặp hoà ở mức
  ngắn hơn".
- **Chỉ cho URL** (mục 1) được bảo đảm ở HAI chỗ, và cần nói rõ chỗ nào là chỗ thật: `isHttpUrl` ở
  chỗ gọi là để **không quét index cho mọi frame Node** (hiệu năng và ý định), còn bảo đảm đúng đắn
  thật sự nằm trong `urlSuffixMapping` — nó đòi có `://` và trả `null` nếu không. Đã kiểm chứng
  bằng mutation: bỏ `isHttpUrl` đi thì test đường-dẫn-file **vẫn xanh**, vì cơ chế thứ hai chặn.
  Ghi lại để người sau đừng tưởng test đó đang canh cái guard ở chỗ gọi.
- **Query string và fragment bị cắt** trước khi khớp (`normalizeRuntimePath`), nếu không thì
  `…/app.js?v=3` sẽ map thành `<root>/public/js/app.js?v=3`. Chỉ cắt cho URL http(s): `?` và `#`
  là ký tự hợp lệ trong đường dẫn file.
- **Thứ tự nguồn**: `[...user, ...mount (ticket 05), ...url (ticket này)]`. Khớp đuôi là nguồn cuối
  cùng, đúng như ticket yêu cầu — có test khẳng định mapping người dùng khai cho URL thì thắng và
  **không** có lần quét index nào xảy ra.
- **Mapping chỉ sống trong phiên** (mục 4): nằm trên `RuntimeLogConnectionInfo`, mất theo kết nối.
  Panel hiện thẻ "Matched … for this session" kèm nút Save; chỉ khi bấm mới ghi settings, theo đúng
  quy ước ticket 05 — `local` trong workspace thì ghi `${workspaceFolder}/…` vào Workspace settings
  (commit được vào repo), không có workspace folder nào thì ghi đường dẫn tuyệt đối vào User
  settings.
- **Kiểm tra nội dung của ticket 06 vẫn là điều kiện bắt buộc** (mục 5): có test cho đúng ca ticket
  mô tả — URL khớp một file nguồn đọc được trong workspace, trong khi server đang phục vụ bản
  bundle; metadata lệch nên **không vẽ**, đếm `content-mismatch`.
- **Cache theo URL**, không theo log: `urlResolutions` giữ kết quả (kể cả `'none'` và `'ambiguous'`)
  nên mỗi URL chỉ quét index đúng một lần, dù nó bắn bao nhiêu log.
- **Thêm `Workspace.indexedPaths()`** (và `IndexStore.indexedPaths()`) — trước đó không có cách nào
  lấy danh sách file đã index; `loadFileStamps()` có làm được nhưng dựng cả một Map mỗi lần gọi.
- **Test**: 12 ca thuần trong `packages/core/test/runtime-log.test.js` và file mới
  `packages/server/test/runtime-log-url-match.test.js` (8 ca LSP end-to-end, chạy trên index THẬT).
  Mutation check: bỏ nhánh `'ambiguous'` đi thì test hoà-điểm đỏ ngay.
- `npm test` ở gốc repo: 300 test, 294 pass — 5 fail còn lại là fixture `smart-city` có sẵn từ trước.
