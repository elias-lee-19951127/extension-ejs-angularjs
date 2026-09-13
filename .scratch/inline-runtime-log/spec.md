# Spec: Inline runtime log (kiểu Console Ninja)

**Ngày chốt:** 2026-09-13 · **Trạng thái:** đã grill xong, sẵn sàng cho `mattpocock-skills:tdd`
**Nguồn:** phiên `/mattpocock-skills:grill-me` ngày 2026-09-13, dựa trên
[`docs/research/console-ninja-inline-log.md`](../../docs/research/console-ninja-inline-log.md) và
handoff `/private/tmp/ejsng-handoff-2026-09-13.md` mục "(2) Inline log kiểu Console Ninja".

## Mục tiêu

Hiện giá trị `console.log`/`warn`/`error` runtime ngay trong editor, cạnh dòng code đã sinh ra log
đó — giống trải nghiệm extension **Console Ninja** trên VSCode.

## Quan hệ với feature "config trỏ tới dự án đang chạy"

Handoff trước coi đây là bước (2), phụ thuộc vào bước (1) "config trỏ tới dự án đang chạy
(localhost/Docker)", vì cho rằng cả hai cùng cần "biết được tiến trình đang chạy ở đâu".

**Đã bác bỏ ở phiên grill này.** `templateRoots`/`expressViewsDir`
([types.ts:190-198](../../packages/core/src/types.ts:190),
ý định gốc ở [docs/kien-truc.md:283-295](../../docs/kien-truc.md:283)) là **config tĩnh, khai tay
một lần**, dùng để ánh xạ chuỗi URL runtime viết trong source (`templateUrl: '/views/x.html'`)
sang đường dẫn đĩa — phục vụ resolver template↔controller, **không cần tiến trình nào đang sống**.
Đây là seam hoàn toàn khác với "kết nối tới một tiến trình đang chạy để đọc log", vốn không cần
URL-prefix mapping gì cả (Inspector Protocol tự trả về absolute file path trong stack trace).

→ Feature này **độc lập**, không chờ `templateRoots`/`expressViewsDir` hoàn thiện.

## Phạm vi v1 (đã chốt qua grilling)

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | Chỉ bắt log **server-side** (Node/Express) qua **Node Inspector Protocol**. Bỏ browser-side (AngularJS/CDP) khỏi v1. | CDP đòi hỏi biết trình duyệt/tab, xử lý reload mất kết nối — độ phức tạp vận hành cao hơn hẳn. Chứng minh pipeline với 1 nguồn trước khi nhân đôi. |
| 2 | Chỉ ship **VSCode client**. IntelliJ port để phase riêng sau. | Hiển thị buộc phải là client-side decoration (không qua LSP chuẩn) — viết 2 lần ngay từ đầu cộng dồn rủi ro thiết kế + rủi ro tích hợp Kotlin/Gradle. |
| 3 | Server LSP **tự làm CDP/Inspector client**, tự mở WebSocket ra ngoài tới debug port của target (Option A). Không ăn theo debug session sẵn có của VSCode (`vscode-js-debug`, Option B). | Option B chỉ bắt được log khi người dùng debug qua chính VSCode — bỏ mất kịch bản chính: app chạy độc lập trong Docker/terminal ngoài. |
| 4 | Kết nối bằng **cấu hình tay**: setting `ejsng.runtimeLog.inspectorUrl` (mặc định rỗng = tắt tính năng). Người dùng tự chạy `node --inspect=9229`, tự forward port nếu dùng Docker. | Không auto-detect tiến trình/container — đó là một tính năng riêng có thể thêm sau, không chặn v1. |
| 5 | Transport server→client: **custom LSP notification** (kiểu `$/ejsng/runtimeLog`), mang span + giá trị mới nhất. | Đúng quy ước mở rộng LSP. "Một server, hai client mỏng" chưa thực sự bị phá ở v1 (chỉ 1 client) — chỉ phải đối mặt lại khi port sang IntelliJ. |
| 6 | Server chỉ giữ **giá trị mới nhất theo mỗi dòng** (không lịch sử, không đếm số lần). Reset khi target restart hoặc dòng dịch chuyển do sửa file. | Hành vi tối thiểu để chứng minh pipeline; lịch sử/đếm để lại làm cải tiến sau nếu thấy thiếu. |
| 7 | Kích hoạt bằng **lệnh thủ công** `EJSNG: Connect to Runtime` (command palette). Không tự động connect/retry; có status bar phản ánh trạng thái kết nối. | Khớp tinh thần "cấu hình tay" — người dùng đã chủ động set up thì chủ động bấm connect, tránh lỗi âm thầm mỗi lần mở workspace. |

## Loại khỏi phạm vi v1 (rõ ràng)

- Browser-side / AngularJS / CDP.
- Client IntelliJ.
- Auto-detect tiến trình Node hoặc container Docker đang chạy.
- Lịch sử log / đếm số lần trên một dòng.
- Logpoints kiểu biểu thức tuỳ ý (chỉ `console.log`/`warn`/`error`, không phải "log bất kỳ expression nào" như Console Ninja).

## Điểm neo trong code

- `packages/server/src/index.ts:57-63` — danh sách capability LSP hiện có; feature này thêm một
  custom notification, không phải capability chuẩn.
- `packages/core/test/spans.test.js` — bất biến span cho mọi biểu thức, layer 2 đã có sẵn; phần cần
  xây là "biết log nào thuộc dòng nào" (map vị trí runtime → span), không phải phần span bản thân.
- `packages/vscode-client/package.json` — nơi khai setting mới `ejsng.runtimeLog.inspectorUrl` và
  đăng ký command `EJSNG: Connect to Runtime`.
- Test qua public API thật, không test private method — bất biến đã lập tiền lệ từ đợt deepening
  `workspace.ts` (phụ lục M, `docs/kien-truc.md`): LSP qua stdio trong
  `packages/server/test/lsp.test.js`.

## Việc để lại cho phase sau (không làm bây giờ)

1. Browser-side qua CDP (khi v1 server-side đã chứng minh pipeline ổn).
2. Port hiển thị sang IntelliJ (`packages/intellij-client`) — lúc đó chỉ còn việc vẽ decoration,
   logic map log→span đã có sẵn ở server.
3. Auto-detect tiến trình/container thay vì cấu hình tay.
4. Lịch sử/đếm log theo dòng.
5. `templateRoots`/`expressViewsDir` (seam cũ, tĩnh) vẫn còn treo riêng — không liên quan đến spec
   này, xem lại ý định gốc ở `docs/kien-truc.md` nếu có phiên nào định làm tiếp.

## Bước tiếp theo

Chạy **`mattpocock-skills:tdd`** trên spec này — bắt đầu từ điểm neo trong code ở trên, test qua
public API (`Workspace.*` hoặc LSP qua stdio), không test private method.
