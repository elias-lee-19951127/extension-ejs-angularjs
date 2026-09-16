# 04 — Tìm Runtime Target qua Docker

**What to build:** Bấm Connect mà không gõ gì, extension tự liệt kê container Node có inspector và
hiện chúng theo cách người dùng vẫn nhớ service: **tên container + port app** (`cityos-web: 5000`),
không phải port debug. Gõ port app cũng ra đúng container đó.

Quét port cố định không đủ: một container có thể publish inspector ra port bất kỳ (thực tế:
`9228->9229`), và hai container cùng có inspector thì port thôi không phân biệt được.

**Blocked by:** 02 — cần probe an toàn và ws URL viết lại đúng.

**Status:** done

- [x] Liệt kê container qua CLI `docker`; không có `docker` thì im lặng rơi về luồng cũ (host:port,
      `lsof` + `SIGUSR1`, quét port phổ biến), không lỗi
- [x] Mỗi container đọc ra: các cặp port publish, port inspector bên trong (từ `--inspect`,
      `--inspect-brk`, hoặc `NODE_OPTIONS`), và danh sách mount
- [x] Suy port inspector **trên host** bằng cách khớp phía container của cặp port — bắt được cả
      `9228->9229`
- [x] Gõ port app (5000) → chọn container publish port đó, kết nối inspector của nó
- [x] Đúng một ứng viên thì kết nối luôn; nhiều thì Quick Pick ghi tên container + port app
- [x] Container có Node nhưng không publish port inspector: báo đúng container đó, không tự
      `docker exec` hay can thiệp gì vào container
- [x] Test qua LSP với một `docker` giả đặt trong `PATH` tạm, fixture lấy từ máy thật (mount lồng
      nhau, `9228->9229`)

## Comments

**2026-09-16, agent:** Xong toàn bộ checklist. Vài quyết định đáng ghi lại:

- **LSP mới, không đụng `ejsng/connectRuntime`**: thêm request `ejsng/discoverRuntimeTargets`
  (params `{appPort?: number}`) — chạy TRƯỚC khi người dùng gõ gì, trả về `'connected'`
  (đúng 1 ứng viên, đã tự kết nối luôn), `'choose-container'` (nhiều ứng viên — Quick Pick
  `<tên container>: <port app>`), `'choose'` (ca hiếm: 1 container nhưng CDP có nhiều target —
  tái dùng nguyên `ejsng/connectRuntimeTarget` cũ), `'no-docker-target'` (không có docker HOẶC
  không khớp gì — client rơi về luồng cũ, không báo lỗi), `'unreachable-containers'` (container
  Node có `--inspect` nhưng không publish port — báo tên, ticket 04 mục 6), hoặc `'error'`.
  Client (`packages/vscode-client/src/extension.ts`, hàm `discoverDockerRuntime`) gọi request
  này trước, chỉ rơi về ô nhập `host:port` cũ khi `'no-docker-target'`.
- **Chỗ đặt code**: hàm thuần (`parseDockerInspect`, `extractInspectorContainerPort`,
  `resolveDockerCandidates`, `partitionDockerCandidates`, `filterDockerCandidatesByAppPort`,
  `formatDockerCandidateLabel`) ở file MỚI `packages/core/src/runtime-log-docker.ts` (không gộp
  vào `runtime-log.ts` cũ, đúng ghi chú phối hợp với agent ticket 03 chạy song song cùng base
  commit — tránh đụng file). Adapter IO (`execFile('docker', …)`) ở file mới
  `packages/server/src/docker.ts`.
- **Khớp cổng inspector**: đọc `--inspect[-brk][=host:port]` từ CẢ `Config.Cmd` LẪN
  `Config.Entrypoint` (Docker chạy `entrypoint + cmd` nối liền — Dockerfile hay đặt `--inspect`
  trên `ENTRYPOINT` riêng), và từ `NODE_OPTIONS` trong `Config.Env` khi hai chỗ trên không có.
  Suy port host bằng cách khớp `containerPort` của `NetworkSettings.Ports` với port inspector đã
  tìm được — không giả định host == container, bắt đúng ca `9228->9229`.
- **`unreachable` không chỉ xuất hiện khi không có ứng viên nào kết nối được**: lúc đầu chỉ trả
  `'unreachable-containers'` khi KHÔNG có ứng viên nào connectable; code review tự làm phát hiện
  ca `cityos-web` (kết nối được) + `cityos-worker` (không publish port) cùng lúc sẽ làm
  `cityos-worker` biến mất im lặng. Sửa: mọi status `'connected'`/`'choose'`/`'choose-container'`
  đều mang thêm field `unreachable: string[]` — client luôn báo warning cho các container này bất
  kể có kết nối được container khác hay không.
- **`docker inspect` bị lỗi một phần không được xoá sạch kết quả**: `docker inspect id1 id2` với
  `id2` đã dừng giữa lúc `ps -q` và `inspect` chạy vẫn in JSON cho `id1` ra `stdout` trước khi
  thoát mã khác 0 cho `id2` — code review tự làm phát hiện bản đầu coi bất kỳ lỗi nào từ
  `execFile` là "docker hỏng hoàn toàn", vứt luôn `stdout` đã có. Sửa: `execFileCapture` không
  bao giờ reject, luôn trả `{stdout, error}`; bước `inspect` parse `stdout` bất kể `error` có hay
  không, chỉ coi là thất bại khi JSON thật sự không đọc được.
- **Test seam 1 (LSP)**: `packages/server/test/docker-fixture.js` — script `docker` giả (Node,
  đọc `process.argv`) viết vào thư mục tạm, prepend vào `PATH` của server con qua `spawn(...,
  {env})`. Export cả fixture 3 container mẫu (`cityos-web`, `cityos-app` map `9228->9229` qua
  `NODE_OPTIONS`, `cityos-worker` không publish) mô phỏng theo `decisions.md`, và tham số
  `vanishedIds` để mô phỏng ca container biến mất giữa `ps`/`inspect`. File này ticket 05 (path
  mapping từ mount) sẽ dùng lại nguyên — không đổi shape.
- **Test seam 2 (hàm thuần)**: `packages/core/test/runtime-log-docker.test.js`, viết trước khi
  viết `packages/core/src/runtime-log-docker.ts` (TDD).
- Không đụng `.scratch/runtime-remote-env/prototype-companion/`, không đụng luồng chọn frame
  (`onLog`/`startRuntimeLogConnection`'s log-forwarding path) — đúng như ghi chú phối hợp với
  agent ticket 03.
- `npm test` ở gốc repo: 197 test, 192 pass, 5 fail — đúng 5 ca `smart-city` đã biết trước (không
  liên quan runtime-log), không thêm fail mới.
