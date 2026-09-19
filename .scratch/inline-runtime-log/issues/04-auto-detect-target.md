# 04 — Auto-detect tiến trình Node trên máy host (không Docker)

**What to build:** Bấm Connect mà không gõ gì, khi **không có Docker target** và **chưa từng kết
nối** ở workspace này, hiện tại chỉ hiện cảnh báo "enter host:port under Advanced". Ticket này làm
cho trường hợp đó tự tìm được tiến trình Node đang bật inspector trên chính máy host — người dùng
không phải biết port debug là gì.

Phạm vi đã thu hẹp (2026-09-19): phần Docker và phần "nhiều kết quả thì cho chọn" đã xong ở ticket
khác — xem Comments. Chỉ còn phía host.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Trong chuỗi Connect (`runConnectChain` ở vscode-client), sau Docker và sau "target lần
      trước", thử tìm inspector trên host trước khi rơi về cảnh báo nhập tay
- [ ] Tối thiểu: dò port debug mặc định `127.0.0.1:9229` bằng `discoverTargets` (chỉ một HTTP GET
      `/json/list` có `Host: localhost`, không đụng tiến trình nào)
- [ ] Tốt hơn nếu làm được rẻ và an toàn: liệt kê tiến trình `node` đang LISTEN (vd. `lsof -iTCP
      -sTCP:LISTEN -a -c node` trên POSIX) và thử `/json/list` trên các port đó, để bắt cả
      `--inspect=<port khác>`. Không có công cụ (Windows, thiếu `lsof`) → bỏ qua im lặng, không lỗi
- [ ] Chỉ dò, không bao giờ tự bật inspector ở bước này — gửi `SIGUSR1` vẫn chỉ xảy ra khi người
      dùng gõ port app (ticket 10)
- [ ] Nhiều hơn một target tìm được → dùng lại Quick Pick `choose` sẵn có, không tự đoán
- [ ] Không tìm được gì → giữ nguyên cảnh báo hiện tại, và checklist ở panel ghi rõ đã dò những gì
- [ ] Test LSP/unit: có inspector ở port mặc định → kết nối; nhiều target → `choose`; không có gì
      → rơi về hành vi cũ, không throw

## Comments

**2026-09-19 — viết lại, thu hẹp phạm vi.** Đối chiếu bản gốc với code hiện tại:

- *Tự phát hiện container Docker có cổng debug* → **xong** qua
  `.scratch/runtime-remote-env/issues/04-tim-runtime-target-qua-docker.md`
  (`ejsng/discoverRuntimeTargets`), cộng thêm inspector chưa publish qua IP container (ticket 14 bên đó).
- *Nhiều tiến trình/container khớp thì cho chọn* → **xong**: `choose` / `choose-container` + Quick Pick.
- *Setting `ejsng.runtimeLog.inspectorUrl` vẫn chạy như cũ* → **không còn áp dụng**: setting này đã
  bị bỏ từ 02a, thay bằng nhập host:port.
- *Tự phát hiện tiến trình Node `--inspect` trên host* → **chưa làm** — là toàn bộ phạm vi còn lại ở
  trên. Ticket 10 (gõ port app → `SIGUSR1`) gần nhưng khác: vẫn cần người dùng gõ port.

Ưu tiên thấp với setup thật hiện tại của người dùng (Docker trong WSL — đã được Docker discovery phủ).
