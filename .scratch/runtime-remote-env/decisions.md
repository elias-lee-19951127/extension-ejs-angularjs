# Chốt sau phiên grill (2026-09-15 → 16)

Nguồn: `/mattpocock-skills:grill-with-docs` trên [proposal.md](./proposal.md). Phần nào trong
proposal mâu thuẫn với file này thì **file này thắng** (đáng kể nhất: thứ tự nguồn Path Mapping,
vai trò của `docker inspect`, và việc bỏ wizard riêng).

Thuật ngữ đã vào glossary: **Runtime Target**, **Runtime Path**, **Path Mapping**, **Shadowed
File**, **Stale File** (xem `CONTEXT.md`).

## Sự thật đã xác lập trên máy người dùng

- Remote-WSL, AlmaLinux 9.7, WSL **NAT**, Chrome trên Windows. Docker **Engine trong WSL**.
- `cityos-web` publish `5000` (app, AngularJS) và `9229` (inspector, `--inspect=0.0.0.0:9229`).
  `cityos-app` publish inspector ra **9228** → quét port cố định sẽ bỏ sót.
- Mount **lồng nhau**: `~/projects/aocs-cityos-lusail → /home/cityos/aocs-cityos`,
  `~/projects/aocs → /home/cityos/aocs-cityos/aocs` (che `aocs/` của lusail).
- `~/projects/aocs` là bản **obfuscate không source map** (javascript-obfuscator, file 0 dòng).
- Log đi qua **log4js vendored** tại `aocs/utility/log4js` + wrapper `aocs-cats-utilities.js`
  → `callFrames[0]` luôn là file appender, không phải code người dùng. Giá trị log có mã ANSI.
- Triệu chứng gốc: v0.2.3 báo "1 connected" nhưng **không vẽ gì, không báo lỗi** — log bị bỏ im
  lặng ở `index.ts:417-423`.

## Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | Kịch bản nghiệm thu = setup thật ở trên (Node trong Docker + browser Windows) | Mọi giả định sai đều lộ ra ở đây |
| 2 | WSL NAT: phase 1 **không** tự vượt tường lửa. Hướng dẫn chuyển `networkingMode=mirrored`; extension không tự sửa `.wslconfig` | Chrome headful chỉ bind `127.0.0.1` của Windows; `--remote-debugging-address=0.0.0.0` chỉ có tác dụng ở headless; portproxy phải có quyền admin và mở port ra LAN |
| 3 | Node trong Docker: **không** tự `docker exec kill -USR1`. Phát hiện và hướng dẫn cấu hình compose (`--inspect=0.0.0.0` + publish port) | Inspector bật kiểu đó chỉ bind `127.0.0.1` trong container, vẫn không reach được; can thiệp container là quá tay |
| 4 | Thứ tự nguồn **Path Mapping**: người dùng tự khai → suy từ mount Docker (`Destination` dài nhất thắng) → khớp đuôi **chỉ cho URL trình duyệt** | Mount lồng nhau làm khớp đuôi sai một cách thuyết phục |
| 5 | Connect tìm Runtime Target qua `docker ps` + `docker inspect`: port app → container → port inspector trên host. Quick Pick ghi **tên container + port app**, không ghi port debug | `cityos-app` map 9228→9229; quét mù không thấy. Người dùng nhớ theo port app |
| 6 | Log từ file **ngoài workspace**: vẫn vẽ, nhưng chỉ đọc file nằm dưới phía host của một Path Mapping; kèm nút gợi ý thêm thư mục vào workspace; không mapping nào bao phủ thì bỏ và **đếm** | Runtime Path do peer mạng gửi, không đáng tin |
| 7 | Chọn frame: danh sách **bỏ qua** (`node:internal/**`, `node_modules`, logger phổ biến) + setting `ejsng.runtimeLog.skipFrames`. Diagnostics hiện stack đã chọn/đã bỏ; gợi ý bỏ qua wrapper khi một frame gom quá nhiều log | log4js vendored nằm trong workspace nên luật "ngoài workspace" không cứu được |
| 8 | File minify/obfuscate không source map → **tự coi là frame bỏ qua**. Source map để phase sau. Lọc ANSI trước khi hiển thị | Không có dòng nào có nghĩa để vẽ |
| 9 | **Bắt buộc kiểm tra nội dung** trước khi vẽ: so độ dài/số dòng từ `Debugger.scriptParsed` với file trên đĩa. Lệch + file mới hơn → báo **Stale File** ("restart đi"); lệch kiểu khác → báo nghi **Shadowed File** hoặc mapping sai | Khớp đường dẫn không đảm bảo khớp nội dung. Cần kiểm chứng sớm: độ dài V8 báo với CommonJS wrapper |
| 10 | Nút Launch mở trình duyệt **phía Windows** qua interop (Chrome → Edge → Brave, hỏi registry trước), profile debug riêng **giữ lâu dài** ở `%LOCALAPPDATA%\ejsng\browser-profile`, tự mở `http://localhost:5000` và tự connect khi tab load | Chrome 136+ bỏ qua debug port trên profile mặc định; giữ profile để chỉ phải đăng nhập Keycloak một lần |
| 11 | **Bỏ wizard riêng.** Panel = nút Connect + danh sách kiểm tra từng bước (có đếm log nhận/vẽ/bỏ kèm lý do) + nút sửa tại chỗ + nút **Copy báo cáo** (markdown, che `~`, không gửi đi đâu). Không tự connect khi mở workspace | Wizard sẽ là bản thứ hai của cùng luồng Connect |
| 12 | Lưu: `skipFrames` + mapping đã bấm lưu → **workspace settings**, đường dẫn viết theo `${workspaceFolder}` (không quy được thì User settings). Port/trình duyệt/target lần trước → **`workspaceState`**. Mapping từ mount Docker → **không lưu** | Tách cái chia sẻ được khỏi cái riêng máy |
| 13 | Mức hỗ trợ: **nghiệm thu** = WSL mirrored + Remote SSH + Dev Container (đồng nghiệp verify); **không được hỏng** = macOS/Linux local (test tự động); **báo rõ** = WSL NAT (browser), Windows + Docker Desktop | Không hứa cái không verify được, nhưng không bao giờ im lặng |
| 14 | **Prototype extension phụ (UI side) làm TRƯỚC phase 1.** Trả lời: cơ chế nối nào chạy, mất log/độ trễ ở 100 log/s (đạt: không mất log, < 200 ms), cách đóng gói. Không đạt → SSH/Dev Container chỉ hỗ trợ log Node | SSH và Dev Container không có đường nào khác cho log trình duyệt |
| 15 | Chỗ đặt code: hàm thuần → `packages/core`; adapter IO (docker, probe, ws, đọc file) → `packages/server`; UI (webview, decoration, mở browser, `remoteName`, ghi settings) → `packages/vscode-client`. Client gửi `remoteName`/platform qua `initializationOptions`. **Gộp ticket 06** (báo trạng thái kết nối thật) | Giữ "một server, hai client mỏng" cho ticket 03 (IntelliJ) |

## Nợ verify (ticket 09) — cách trả

1. Test UI tự động bằng `@vscode/test-electron` (decoration, status bar, panel state) chạy trên CI.
2. Script đầu-cuối gọi LSP qua stdio, chạy trong WSL của người dùng, in ra log nào vẽ/bỏ và vì sao.
3. Chỉ còn phần thật sự cần tay: nhìn decoration, bấm Launch browser, kiểm tra profile Chrome.

Agent **không** điều khiển được máy Windows/WSL của người dùng (phiên chạy trên máy Mac khác).

## Việc còn treo, chưa quyết

- ADR cho phương án extension phụ: viết **sau** khi có kết quả prototype (lúc đó mới là quyết định
  khó đảo ngược).
- Ma trận test trong `proposal.md` phải viết lại theo 3 mức của quyết định 13.
