# Spec: Runtime log tự tìm đường trong môi trường remote/Docker

**Ngày chốt:** 2026-09-16 · **Status:** ready-for-agent
**Nguồn:** phiên `/mattpocock-skills:grill-with-docs` ngày 2026-09-15→16, dựa trên
[proposal.md](./proposal.md) và [decisions.md](./decisions.md) (decisions.md thắng khi hai file
lệch nhau). Thuật ngữ dùng trong spec này định nghĩa ở `CONTEXT.md` mục Runtime Log:
**Runtime Target**, **Runtime Path**, **Path Mapping**, **Shadowed File**, **Stale File**.

Spec này nối tiếp `.scratch/inline-runtime-log/spec.md` (v1, log server-side qua CDP) và **thay
thế** quyết định #4 của v1 ("kết nối bằng cấu hình tay").

## Problem Statement

Người dùng mở dự án bằng VS Code Remote-WSL, app Node chạy trong Docker, Chrome chạy trên
Windows. Họ bấm Connect, panel báo **"1 connected"**, và rồi **không có gì hiện ra** — không
decoration, không cảnh báo, không lỗi. Không có cách nào biết chuyện gì đang sai.

Trong phiên grill, đúng tình huống đó được mổ ra và có **năm** nguyên nhân chồng lên nhau, chỉ một
nguyên nhân liên quan tới WSL:

1. Đường dẫn container (`/home/cityos/aocs-cityos/aocs/...`) không tồn tại trên máy chạy extension;
   mount lại **lồng nhau**, nên đoán theo tên thư mục sẽ ra **nhầm repo**.
2. Log đi qua log4js vendored, nên vị trí runtime luôn trỏ vào file appender của log4js, không bao
   giờ trỏ vào code người dùng.
3. Code platform đã bị obfuscate, không source map — không có dòng nào có nghĩa để vẽ.
4. File người dùng sửa bị một mount khác che (**Shadowed File**), nên sửa xong chạy mãi không thấy.
5. Chrome nằm ở phía Windows, extension nằm trong WSL mạng NAT, nên không thể với tới debug port.

Người dùng còn phải tự biết port debug là gì, tự tìm Chrome, tự khai `pathMappings`. Ba trong năm
nguyên nhân trên xảy ra **ở mọi môi trường**, kể cả chạy local.

## Solution

Bấm **Connect**, extension tự đi hết chuỗi: nhận diện môi trường → tìm Runtime Target qua Docker →
suy Path Mapping từ mount → lọc frame thư viện → kiểm tra nội dung file → vẽ log inline.

Điều quan trọng không kém: **khi không làm được, nó nói ra**. Panel có một danh sách kiểm tra từng
bước; mỗi bước hỏng đều có lý do cụ thể và, nếu sửa được, một nút sửa ngay tại đó. Log bị bỏ được
đếm theo từng lý do, không bao giờ biến mất im lặng.

Người dùng không phải gõ port debug, không phải tìm Chrome, không phải khai mapping cho Docker.
Cái duy nhất còn phải làm tay là những thứ nằm ngoài tầm extension — đổi `networkingMode` của WSL,
sửa compose để publish port inspector — và extension chỉ ra chính xác phải sửa gì.

## User Stories

1. Là người dùng Remote-WSL, tôi muốn bấm Connect mà không phải gõ `host:port`, để không phải nhớ
   port debug là gì.
2. Là người dùng, tôi muốn extension tự biết nó đang chạy trong WSL / SSH / container / local, để
   nó tự chọn cách kết nối phù hợp.
3. Là người dùng Docker, tôi muốn extension tự tìm container nào có inspector, để không phải đọc
   `docker ps` mỗi lần.
4. Là người dùng có nhiều container Node, tôi muốn chọn target theo **tên container và port app**
   (`cityos-web: 5000`), để chọn theo cách tôi vẫn nhớ service.
5. Là người dùng có container publish inspector ra port lạ (`9228->9229`), tôi muốn extension vẫn
   tìm ra, để không bị bỏ sót vì nó chỉ quét vài port cố định.
6. Là người dùng, tôi muốn gõ port app (5000) cũng kết nối được, để không cần phân biệt port app
   với port debug.
7. Là người dùng Docker, tôi muốn Path Mapping được suy từ mount của container, để không phải khai
   tay `pathMappings`.
8. Là người dùng có mount lồng nhau, tôi muốn mount cụ thể nhất được áp dụng, để log về đúng repo
   chứ không về repo bị che.
9. Là người dùng, tôi muốn `pathMappings` tôi tự khai luôn thắng mọi suy đoán, để giữ quyền kiểm
   soát khi tự động đoán sai.
10. Là người dùng xem log trình duyệt, tôi muốn URL `http://localhost:5000/js/app.js` tự tìm ra
    file trên đĩa, để không phải khai mapping cho từng thư mục tĩnh.
11. Là người dùng, tôi muốn khi một URL khớp nhiều file thì extension **không vẽ** và nói ra, để
    không bao giờ đọc một con số log gắn sai chỗ.
12. Là người dùng dùng logger (log4js), tôi muốn log gắn vào dòng code của tôi, không phải dòng
    trong thư viện logger.
13. Là người dùng có wrapper log riêng, tôi muốn extension nhận ra "một file gom quá nhiều log" và
    đề nghị bỏ qua nó, để chỉ bấm một lần là xong.
14. Là người dùng, tôi muốn tự khai thêm pattern frame cần bỏ qua, để hợp với quy ước log của team.
15. Là người dùng, tôi muốn thấy stack đã chọn và các frame đã bỏ của vài log gần nhất, để biết
    phải khai thêm pattern nào.
16. Là người dùng có code obfuscate/minify không source map, tôi muốn extension tự bỏ qua các file
    đó, để log rơi về file đọc được gần nhất thay vì vẽ lên "dòng 1".
17. Là người dùng, tôi muốn log không bao giờ vẽ lên file có nội dung khác bản runtime đang chạy,
    để không đọc phải con số gắn sai dòng.
18. Là người dùng vừa sửa file mà quên restart, tôi muốn được báo **Stale File** kèm gợi ý restart,
    để không ngồi đoán vì sao log không đổi.
19. Là người dùng có file bị mount khác che, tôi muốn được báo **Shadowed File** kèm đường dẫn bản
    thật container đang chạy, để biết mình đang sửa nhầm bản sao.
20. Là người dùng, tôi muốn log từ file nằm ngoài workspace vẫn vẽ được khi tôi mở file đó, để
    không phải gộp mọi repo vào một workspace.
21. Là người dùng, tôi muốn được gợi ý thêm thư mục liên quan vào workspace, nhưng extension không
    tự thêm, để giữ quyền quyết định layout workspace.
22. Là người quan tâm bảo mật, tôi muốn extension chỉ đọc file nằm dưới phía host của một Path
    Mapping, để một target độc hại không khiến nó đọc file tùy ý.
23. Là người dùng, tôi muốn giá trị log bị lọc mã màu ANSI, để decoration không đầy ký tự rác.
24. Là người dùng, tôi muốn panel hiển thị danh sách kiểm tra từng bước, để biết chuỗi kết nối
    dừng ở đâu.
25. Là người dùng, tôi muốn thấy số log **nhận / vẽ / bỏ**, để biết pipeline có sống không.
26. Là người dùng, tôi muốn bấm vào số log bị bỏ để xem lý do theo nhóm, để biết sửa gì trước.
27. Là người dùng, tôi muốn mỗi dòng hỏng có nút sửa ngay tại đó (lưu mapping, bỏ qua frame, thêm
    thư mục, copy đoạn compose, mở hướng dẫn mirrored), để không phải lục Settings.
28. Là người dùng WSL NAT, tôi muốn được nói thẳng rằng log trình duyệt cần `networkingMode=mirrored`
    kèm các bước làm, để không mất buổi chiều dò IP Windows.
29. Là người dùng có container không publish port inspector, tôi muốn thấy đoạn compose mẫu để
    copy, để sửa một lần rồi thôi.
30. Là người dùng, tôi muốn bấm Launch là trình duyệt phía Windows mở lên kèm debug port, để không
    phải tự gõ dòng lệnh Chrome.
31. Là người dùng, tôi muốn trình duyệt được tìm tự động (Chrome → Edge → Brave), để không phải khai
    đường dẫn executable.
32. Là người dùng, tôi muốn profile debug được giữ lâu dài, để chỉ phải đăng nhập Keycloak một lần.
33. Là người quan tâm bảo mật, tôi muốn debug port không bao giờ mở trên profile Chrome thật của
    tôi, để không ai chạy được tiến trình local mà vào được mọi phiên đã đăng nhập.
34. Là người dùng, tôi muốn trình duyệt tự mở đúng URL app và tự kết nối khi tab load xong, để bấm
    một nút là xong.
35. Là người dùng, tôi muốn panel chỉ báo "connected" khi WebSocket thật sự mở, để danh sách kiểm
    tra không nói dối ngay dòng đầu (ticket 06).
36. Là người dùng, tôi muốn có nút Copy báo cáo gồm môi trường, Docker, endpoint, trình duyệt, kết
    quả từng bước và lý do bỏ log, để dán vào issue khi cần nhờ hỗ trợ.
37. Là người dùng, tôi muốn báo cáo đó thay đường dẫn home bằng `~` và không tự gửi đi đâu, để
    không lộ thông tin máy mình.
38. Là người dùng, tôi muốn extension **không** tự kết nối khi mở workspace, để không có tiến trình
    nền lặng lẽ dò mạng.
39. Là người dùng, tôi muốn lựa chọn dùng chung được (skipFrames, mapping đã lưu) nằm trong
    workspace settings, để commit cho cả team.
40. Là người dùng, tôi muốn mapping lưu ra dùng `${workspaceFolder}`, để file settings dùng chung
    không chứa đường dẫn riêng máy tôi.
41. Là người dùng, tôi muốn lựa chọn riêng máy (port app đã chọn, trình duyệt, target lần trước)
    không lọt vào repo.
42. Là người dùng, tôi muốn mapping suy từ mount **không** được lưu lại, để đổi compose là tự đúng
    theo, không bị cấu hình cũ làm sai.
43. Là người dùng đang dùng `ejsng.runtimeLog.pathMappings`/`chromeExecutablePath`/`chromeDebugPort`
    và ô `host:port`, tôi muốn mọi thứ vẫn chạy như cũ, để không phải cấu hình lại sau khi cập nhật.
44. Là người dùng macOS hoặc Linux chạy local, tôi muốn mọi thứ đang chạy được ở v0.2.3 vẫn chạy.
45. Là người dùng Remote SSH hoặc Dev Container, tôi muốn log Node chạy được như local, để không bị
    chặn chỉ vì phần trình duyệt chưa xong.
46. Là maintainer, tôi muốn hành vi UI (decoration, status bar, panel) có test tự động, để không
    tích thêm nợ verify tay mỗi lần publish (ticket 09).
47. Là maintainer, tôi muốn logic nhận diện nằm ở server và core, để client IntelliJ sau này dùng
    lại nguyên vẹn (ticket 03).

## Implementation Decisions

### Chia tầng

- **`packages/core`** giữ mọi hàm thuần: phân tích output `docker ps`/`docker inspect`, chọn mount
  khớp dài nhất, xếp hạng Runtime Target, lọc frame theo pattern, nhận diện file minify/obfuscate,
  khớp đuôi cho URL trình duyệt, so sánh nội dung, dựng báo cáo markdown, lọc ANSI.
- **`packages/server`** giữ adapter IO: gọi CLI `docker`, probe HTTP, mở WebSocket CDP, đọc file
  trên đĩa để kiểm tra nội dung, `lsof`/`SIGUSR1` (giữ từ ticket 10).
- **`packages/vscode-client`** giữ phần chỉ của giao diện: webview panel, decoration, mở trình
  duyệt, đọc `vscode.env.remoteName`, ghi settings và `workspaceState`.
- Client gửi `remoteName` và nền tảng cho server qua `initializationOptions`, cạnh `pathMappings`
  đã có. Server không tự đoán nó đang chạy ở đâu.

### Nhận diện môi trường

`RuntimeEnvironment` gồm loại môi trường (local/wsl/ssh/container/codespace), OS phía workspace,
với WSL thì thêm chế độ mạng (nat/mirrored/unknown), và trạng thái Docker CLI. Chế độ mạng WSL suy
từ `ip route`/cấu hình WSL; nếu không chắc thì để `unknown` và dựa vào kết quả probe thật, không
đoán bừa.

### Tìm Runtime Target

Thứ tự: liệt kê container qua CLI `docker` → với mỗi container đọc port publish, lệnh chạy (tìm
`--inspect[-brk][=host:port]`, cả trong `NODE_OPTIONS`) và danh sách mount → suy port inspector
**trên host** bằng cách khớp phía container của cặp port. Không có Docker thì giữ nguyên luồng cũ
(thử `host:port`, `lsof` + `SIGUSR1`, quét port phổ biến). Nhiều ứng viên thì client hiện Quick
Pick ghi tên container + port app; đúng một thì kết nối luôn.

### Path Mapping

Ba nguồn, xét theo thứ tự, dừng ở nguồn đầu tiên cho kết quả:

1. `ejsng.runtimeLog.pathMappings` do người dùng khai (giữ nguyên định dạng ticket 11, **thêm** hỗ
   trợ `${workspaceFolder}` ở phía `local`).
2. Mount của chính container đang kết nối; khi nhiều mount cùng khớp thì mount có `Destination`
   **dài nhất** thắng.
3. Khớp đuôi đường dẫn với file đã index — **chỉ áp dụng cho Runtime Path dạng URL `http(s)://`**.
   Khớp nhiều file thì coi như không khớp.

Mapping suy ra không được ghi vào settings trừ khi người dùng bấm lưu.

### Chọn frame

Bỏ frame theo danh sách pattern: mặc định `node:internal/**`, `**/node_modules/**` và các thư mục
logger phổ biến, cộng với `ejsng.runtimeLog.skipFrames` của người dùng. Bỏ thêm mọi frame thuộc
file được nhận diện là minify/obfuscate không source map (heuristic: gần như không có ký tự xuống
dòng so với kích thước file). Chọn frame đầu tiên còn lại. Không còn frame nào thì log chỉ vào
panel, không vẽ inline.

### Kiểm tra nội dung (bắt buộc trước khi vẽ)

Server bật thêm domain `Debugger` **chỉ để nhận sự kiện** (không đặt breakpoint, không pause) và
dùng metadata script (độ dài, dòng cuối) để so với file trên đĩa sau khi mapping. Khớp thì vẽ;
lệch mà file trên đĩa mới hơn thì báo **Stale File**; lệch kiểu khác thì báo nghi **Shadowed File**
hoặc mapping sai. Cách so sánh chính xác (độ dài thô hay số dòng kèm sai số cho CommonJS wrapper)
phải được xác định bằng thí nghiệm với Node thật **trước** khi viết phần còn lại.

### Trạng thái, đếm và báo cáo

Server giữ, cho mỗi kết nối: trạng thái thật (`connecting` → `connected` khi WebSocket mở, gộp
ticket 06), số log nhận, số log vẽ, và số log bỏ **theo từng lý do** (ngoài mapping, Shadowed File,
Stale File, frame bị bỏ hết, URL khớp nhiều file, file không đọc được). Client hỏi trạng thái này
để vẽ danh sách kiểm tra và dựng báo cáo copy được. Báo cáo là markdown, thay home bằng `~`, chỉ
copy vào clipboard.

### Hợp đồng LSP

Giữ nguyên `ejsng/connectRuntime` (`{host, port}`), `ejsng/connectRuntimeTarget`,
`ejsng/disconnectRuntime`, và notification `ejsng/runtimeLog`, để client IntelliJ và ô nhập
"Nâng cao" không bị phá. Thêm request mới cho: dò môi trường + Runtime Target, đọc trạng thái và
số đếm, xin mapping gợi ý, và dựng báo cáo. `ejsng/connectRuntime` nhận thêm field tùy chọn để
kết nối theo target đã dò được thay vì host:port.

### Giao diện

Panel Activity Bar (đã có từ ticket 13) đổi thành: nút Connect lớn, danh sách kiểm tra từng bước
có nút sửa tại chỗ, khu vực "Nâng cao" chứa ô `host:port` cũ, nút Launch browser, nút Copy báo cáo.
Không tự kết nối khi mở workspace. Nút Launch tìm trình duyệt phía UI (Chrome → Edge → Brave, hỏi
registry trước khi dò đường dẫn cố định), dùng profile debug riêng **giữ lâu dài**, mở đúng URL app
và tự kết nối khi tab đã load.

### Lưu cấu hình

`skipFrames` và mapping người dùng bấm lưu → workspace settings (phía `local` viết theo
`${workspaceFolder}` khi quy được, không thì User settings). Port app đã chọn, trình duyệt tìm
được, target lần trước → `workspaceState`. Mapping từ mount → không lưu.

### Việc phải làm trước

Prototype extension phụ phía UI (`extensionKind: ["ui"]`) trả lời: cơ chế nối nào chạy được trên
Remote-WSL, có mất log và trễ bao nhiêu ở 100 log/giây (đạt: không mất log, dưới 200 ms), đóng gói
thế nào. Không đạt thì Remote SSH và Dev Container chỉ hỗ trợ log Node, và WSL NAT vẫn phải chuyển
mirrored. Code prototype vứt đi; ADR viết sau khi có kết quả.

## Testing Decisions

Test tốt ở repo này là test **hành vi ngoài**: gửi một request LSP thật rồi khẳng định notification
nhận về, hoặc gọi một hàm thuần và khẳng định kết quả. Không test private method, không khẳng định
lên cấu trúc dữ liệu nội bộ — tiền lệ từ đợt deepening `workspace.ts` (`docs/kien-truc.md` mục M).

**Seam 1 — LSP qua stdio (đã có, là seam chính).** Prior art:
`packages/server/test/runtime-log-connections-lsp.test.js` (CDP WebSocket giả),
`runtime-log-discovery.test.js` (HTTP discovery giả), `runtime-log-path-mapping.test.js`,
`runtime-log-auto-enable.test.js` (tiến trình Node thật). Bổ sung một fake nữa: một script `docker`
đặt trong `PATH` tạm, in ra fixture `docker ps`/`docker inspect` lấy từ máy thật của người dùng
(mount lồng nhau, `9228->9229`). Mọi hành vi mới kiểm ở đây: chọn đúng container, suy đúng mapping,
bỏ đúng frame, từ chối vẽ khi nội dung lệch, và số đếm lý do bỏ log.

**Seam 2 — hàm thuần `packages/core` (đã có).** Prior art: `spans.test.js`, `core.test.js`. Bắt
buộc có test thuần trước khi viết adapter cho: phân tích `docker inspect`, chọn mount dài nhất,
xếp hạng target, lọc frame, nhận diện obfuscate, khớp đuôi URL (gồm ca khớp nhiều file), so nội
dung, dựng báo cáo, lọc ANSI.

**Seam 3 — mới: `@vscode/test-electron` cho `packages/vscode-client`.** Chạy VS Code thật, gọi
lệnh connect với server giả, khẳng định decoration, status bar và trạng thái panel. Đây là cách
trả nợ ticket 09 bằng test thay vì bấm tay. Chạy trên CI macOS và Linux.

**Không tạo seam:** mở trình duyệt và interop WSL (checklist tay, cần máy Windows thật);
prototype extension phụ (code vứt đi); cách so sánh nội dung script (là thí nghiệm với Node thật,
kết quả của nó mới trở thành test).

**Kịch bản nghiệm thu tay** (rút gọn, chạy trên máy người dùng sau khi có build): WSL mirrored +
`cityos-web` → bấm Connect không gõ gì → log Node hiện đúng dòng trong code đọc được; bấm Launch →
Chrome Windows mở `localhost:5000`, tự kết nối, log AngularJS hiện đúng dòng; sửa file mà chưa
restart → báo Stale File; mở file bị mount che → báo Shadowed File.

## Out of Scope

- Tự vượt mạng WSL NAT bằng portproxy hay mở debug port ra LAN.
- Tự sửa `.wslconfig`, tự sửa compose, tự cài `socat` hay can thiệp vào container đang chạy.
- Hỗ trợ source map (kể cả để nối ngược code obfuscate về source).
- Wizard riêng tách khỏi luồng Connect.
- Firefox hoặc trình duyệt không dùng CDP.
- Tự kết nối khi mở workspace.
- Port sang IntelliJ (ticket 03) — spec này chỉ giữ chỗ đặt code sao cho port sau không phải viết
  lại logic.
- Lịch sử log và đếm số lần trên một dòng (vẫn để lại từ v1).
- Windows + Docker Desktop: chuẩn hóa `C:\` và `/run/desktop/mnt/host/...` để phase sau.

## Further Notes

- Mức hỗ trợ cam kết: **nghiệm thu** = WSL mirrored (máy người dùng) + Remote SSH + Dev Container
  (đồng nghiệp verify sau khi có build); **không được hỏng** = macOS/Linux local, có test tự động;
  **chỉ cần báo rõ** = WSL NAT cho phần trình duyệt, Windows + Docker Desktop.
- Yêu cầu gốc có ba điểm sai kỹ thuật đã bác trong phiên grill, đừng làm lại: `nameserver` trong
  `/etc/resolv.conf` không đáng tin là IP Windows (DNS tunneling trả `10.255.255.254`); có đúng IP
  vẫn không tới được vì Chrome headful chỉ bind loopback; và `host.docker.internal` bị từ chối vì
  Chrome lẫn Node inspector kiểm tra header `Host` (chống DNS rebinding) — mọi probe phải gửi
  `Host: localhost`, và ws URL trả về phải được viết lại theo host:port thật đã dùng để tới.
- Quét port cố định (9222/9229/9230/9333) chỉ là đường lùi khi không có Docker; nó bỏ sót
  `9228->9229` của `cityos-app`.
- Môi trường thật dùng làm kịch bản nghiệm thu được ghi trong memory của agent và trong
  [decisions.md](./decisions.md).
