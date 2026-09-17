# 09 — Panel: danh sách kiểm tra, nút sửa tại chỗ, Copy báo cáo

**What to build:** Thay panel hiện tại (ô host:port + vài nút) bằng một nút Connect lớn và một danh
sách kiểm tra từng bước, mỗi bước ✔/✖ kèm lý do, dòng nào sửa được thì có nút sửa ngay tại đó.
Không làm wizard riêng: wizard sẽ là bản thứ hai của cùng luồng Connect.

**Blocked by:** 02, 03, 04, 05, 06 — panel hiển thị kết quả của tất cả các bước đó.

**Status:** done

- [x] Nút Connect chạy trọn chuỗi: nhận diện môi trường → Docker → target → mapping → kết nối
- [x] Danh sách kiểm tra gồm: môi trường (kèm chế độ mạng khi là WSL), Docker/container, kết nối
      Node, trình duyệt, Path Mapping, và số `nhận / vẽ / bỏ`; bấm vào số bỏ xem lý do theo nhóm
- [x] Nút sửa tại chỗ cho các ca sửa được: lưu mapping, bỏ qua frame, thêm thư mục vào workspace,
      copy đoạn compose mẫu khi container thiếu inspector, mở hướng dẫn chuyển WSL sang mirrored
- [x] Nhận diện môi trường qua `remoteName` phía client, gửi cho server qua `initializationOptions`
- [x] WSL NAT: báo thẳng log trình duyệt cần `networkingMode=mirrored` kèm các bước; extension
      không tự sửa `.wslconfig`
- [x] Ô `host:port` cũ chuyển xuống mục "Nâng cao", vẫn hoạt động y như trước
- [x] Nút **Copy báo cáo**: markdown gồm OS, loại remote, Docker, endpoint, trình duyệt, kết quả
      từng bước và lý do bỏ log; thay home bằng `~`; chỉ copy vào clipboard, không gửi đi đâu
- [x] Mở workspace **không** tự kết nối
- [x] Lưu cấu hình đúng chỗ: `skipFrames` và mapping đã bấm lưu vào workspace settings; port app đã
      chọn, trình duyệt tìm được, target lần trước vào `workspaceState`

## Comments

**2026-09-17, agent:** Xong cả 9 mục. Những điểm đáng ghi lại:

- **Checklist dựng ở `packages/core`, không ở client.** `buildRuntimeChecklist` và
  `buildRuntimeReport` (`packages/core/src/runtime-log-checklist.ts`) nhận một snapshot (môi
  trường, container Docker đã thấy, các kết nối, mapping đã khai) và quyết định mọi thứ: bước nào
  ✔/⚠/✖/…/–, lý do, nút sửa nào. Server chỉ gom snapshot và trả qua hai request mới
  `ejsng/runtimeChecklist` và `ejsng/runtimeReport`; client chỉ vẽ. Client IntelliJ sau này dùng
  lại nguyên vẹn (quyết định #15).
- **Sáu bước theo đúng thứ tự chuỗi Connect:** Environment → Docker / container → Node connection →
  Browser connection → Path Mapping → Logs. Trước khi bấm Connect, mọi bước là "pending" — panel
  không tự dò gì khi mở.
- **Nhận diện môi trường:** client gửi `remoteName` và nền tảng phía UI qua
  `initializationOptions.runtimeLog.environment` (chỉ chắc khi local, và `win32` khi là WSL). Server
  **chỉ dò khi nhận `ejsng/detectRuntimeEnvironment`** — tức khi người dùng bấm Connect: `docker
  version` (không có CLI → `skipped`, có CLI mà không tới daemon → `warn` kèm thông báo), và với WSL
  thì đọc `%UserProfile%\.wslconfig` qua `cmd.exe` + `wslpath`, dự phòng bằng `ip -o addr`
  (`loopback0` → mirrored, `eth0` trên 172.16/12 → NAT). Không chắc thì là `unknown`, không đoán.
- **WSL NAT:** bước Environment `warn` kèm các bước chuyển mirrored; bước Browser `fail`; cả hai có
  nút mở hướng dẫn của Microsoft. Không có code nào đụng tới `.wslconfig`.
- **Nút sửa tại chỗ** (mỗi nút chỉ chạy khi bấm): lưu mapping, bỏ qua frame (gợi ý wrapper của
  ticket 03), thêm thư mục vào workspace (ticket 08), copy đoạn compose cho container có `--inspect`
  mà chưa publish port (bind `0.0.0.0` + publish, dùng đúng port inspector trong container — thêm
  field `inspectorContainerPort` vào `DockerRuntimeCandidate`), mở hướng dẫn mirrored, mở settings
  khi có log bị bỏ vì thiếu mapping. Client kiểm lại fix nhận từ webview (`isRuntimeChecklistFix`)
  trước khi làm gì — kind lạ hoặc URL không phải https thì bỏ qua.
- **Chỉ đề nghị lưu mapping đã thật sự được dùng.** Container thường có thêm mount config/log/file
  lẻ; đề nghị lưu tất cả sẽ chôn mất cái quan trọng. Server ghi lại mount nào đã chở một log **đã
  vẽ** (`usedMountMappings`) và chỉ đề nghị những cái đó, cộng với mapping khớp đuôi URL. Mapping đã
  có trong settings (kể cả viết dạng `${workspaceFolder}/…`) thì không đề nghị lại.
- **Số `nhận / vẽ / bỏ`:** bấm vào "dropped N" để mở danh sách lý do theo nhóm, nhóm lớn nhất lên
  đầu; trạng thái mở giữ nguyên qua các lần panel vẽ lại.
- **Copy báo cáo:** markdown gồm version, OS, môi trường, Docker, container, endpoint, trình duyệt,
  từng bước kèm lý do, bảng log bị bỏ theo lý do. **Không chứa giá trị log.** Home thay bằng `~`
  theo nguyên tiền tố đường dẫn (`/home/me` khớp, `/home/meg` không; đường dẫn container như
  `/home/cityos` giữ nguyên). Chỉ `vscode.env.clipboard.writeText`.
- **`workspaceState`:** port app chọn ở Quick Pick (lần sau container đó lên đầu, ghi "last used"),
  trình duyệt Launch đã chạy được (chỉ ghi khi tiến trình thật sự `spawn`), target kết nối lần trước
  (dùng làm đường lùi khi Connect không tìm được container Docker). Mapping và `skipFrames` →
  settings như trước (`mappingForSettings`, tách ra từ `saveUrlMapping` để test được).
- **Ô `host:port` cũ** nằm trong mục "Advanced" cùng Launch Chrome debug và link Settings, dùng
  nguyên callback `connect` cũ. Lệnh Command Palette `EJS/NG: Connect to Runtime` không đổi.
- **Sửa một thông báo sai có sẵn:** sau khi lưu `skipFrames`, thông báo cũ bảo "Reconnect (or
  reload)", nhưng server chỉ đọc setting này lúc `initialize` — reconnect không có tác dụng. Giờ
  thông báo (cả khi lưu mapping) nói rõ phải reload window. Hệ quả: nút lưu vẫn hiện trên checklist
  cho tới khi reload.
- **Test:** `packages/core/test/runtime-log-checklist.test.js` (25 ca thuần: nhận diện
  remoteName/WSL, từng bước, gom lý do, đoạn compose, thay home, báo cáo);
  `packages/server/test/runtime-log-checklist-lsp.test.js` (5 ca LSP end-to-end với docker giả —
  fixture thêm lệnh `docker version`: chưa Connect thì mọi bước pending, môi trường client báo đi
  vào đúng, không có docker thì `skipped`, cả chuỗi container → kết nối → mount đã dùng (mount config
  không được đề nghị lưu) → lý do bỏ, và báo cáo với `HOME` giả thay bằng `~`); 5 ca mới trong
  `packages/vscode-client/test/runtime-log-state.test.js`. `npm test`: 335 test, 330 pass — 5 fail
  còn lại là fixture `smart-city` có sẵn từ trước.

**Chưa verify, cần làm tay** (ticket 11 sẽ chuyển phần panel sang `@vscode/test-electron`):

- [ ] Panel trong VS Code thật: đã dựng HTML của webview trong trình duyệt với state mẫu (WSL NAT,
      container thiếu publish, log bị bỏ) — bố cục, mở danh sách lý do và các nút gửi đúng message;
      **chưa** chạy trong Extension Host thật.
- [ ] Máy người dùng (Remote-WSL): bước Environment báo đúng `networking: nat` / `mirrored` — phần
      `cmd.exe` + `wslpath` + `ip -o addr` chưa chạy trên WSL thật.
- [ ] Nút Copy compose / Open guide / Add to workspace / Save mapping trong VS Code thật; báo cáo dán
      ra đúng markdown và không lộ đường dẫn home.
