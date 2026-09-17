# 06 — Kiểm tra nội dung: Stale File và Shadowed File

**What to build:** Khớp đường dẫn không đảm bảo khớp nội dung. Ba ca thật: file đã sửa mà runtime
chưa nạp lại (**Stale File**), file trong workspace bị mount khác che nên runtime chạy bản khác
(**Shadowed File**), và mapping tự khai trỏ nhầm. Cả ba đều khiến log vẽ **sai dòng mà trông như
đúng** — tệ hơn không vẽ. Ticket này bắt vẽ inline phải có điều kiện: nội dung khớp.

**Blocked by:** 05 — cần mapping ra file trên đĩa trước khi so nội dung.

**Status:** in-progress

- [x] Bắt đầu bằng thí nghiệm với Node thật: metadata script V8 báo về (độ dài, dòng cuối) có khớp
      file trên đĩa không, kể cả với CommonJS. Kết quả quyết định cách so sánh; **ghi vào ticket**
      trước khi viết tiếp — xem "Kết quả thí nghiệm" bên dưới
- [ ] Bật domain `Debugger` chỉ để nhận sự kiện: không đặt breakpoint, không pause runtime
- [ ] Nội dung khớp → vẽ inline như hiện tại
- [ ] Lệch và file trên đĩa mới hơn lúc runtime nạp → không vẽ, báo **Stale File** kèm gợi ý restart
- [ ] Lệch kiểu khác → không vẽ, báo nghi **Shadowed File** hoặc mapping sai; nếu biết mount thì
      chỉ ra đường dẫn bản runtime đang chạy
- [ ] Mọi trường hợp không vẽ đều vào bộ đếm lý do của ticket 02
- [ ] Chi phí bật `Debugger` với dự án vài nghìn file được đo và ghi lại; nếu nặng thì giới hạn
      phạm vi script quan tâm

## Kết quả thí nghiệm (item 1)

**2026-09-17, agent.** Chạy `node --inspect` thật (Node v20.20.0, macOS), bật domain `Debugger`,
thu `Debugger.scriptParsed` rồi đối chiếu từng field với file trên đĩa. Script thí nghiệm dựng
trong scratchpad, không commit vào repo (code vứt đi, giống ticket 01).

Fixture cố tình lệch nhau về hình dạng: có/không newline cuối, CRLF, BOM, shebang, CommonJS được
`require()`, và một file ESM.

| File | `endLine` | `endColumn` | `length` | Dòng cuối trên đĩa (index / độ dài) | Độ dài trên đĩa | `getScriptSource` === đĩa |
| --- | --- | --- | --- | --- | --- | --- |
| `entry.js` (CJS, entry) | 7 | 0 | 193 | 7 / 0 | 193 | có |
| `plain.js` (CJS, require) | 2 | 0 | 38 | 2 / 0 | 38 | có |
| `no-trailing-newline.js` | 0 | 35 | 35 | 0 / 35 | 35 | có |
| `crlf.js` | 2 | 0 | 39 | 2 / 0 | 39 | có |
| `bom.js` | 1 | 0 | 21 | 1 / 0 | 21 | có |
| `shebang.js` | 2 | 0 | 44 | 2 / 0 | 44 | có |
| `esm.mjs` | 2 | 0 | 40 | 2 / 0 | 40 | có |

**Ba kết luận quyết định cách so sánh:**

1. **Không có wrapper CommonJS nào lọt vào.** Đây là điều đáng lo nhất trước khi đo: Node cũ bọc
   module trong `(function (exports, require, module, __filename, __dirname) { … })`, nếu wrapper
   đó tính vào `length`/`endColumn` thì mọi so sánh đều lệch một lượng cố định và phải trừ bù theo
   phiên bản Node. Node hiện đại biên dịch CJS bằng `compileFunction`, nên `getScriptSource` trả về
   **đúng từng byte** nội dung file, và `length` bằng đúng độ dài file. Không cần trừ bù gì cả.
2. **`length` + `endLine` + `endColumn` là đủ cho phép so sánh rẻ.** Cả ba khớp chính xác với
   `source.length`, `split('\n').length - 1`, và độ dài dòng cuối — kể cả với BOM (tính vào độ
   dài), CRLF (`\r` tính vào cột của dòng trước), shebang (không bị cắt), và file không có newline
   cuối. Nghĩa là **không cần round-trip nào** để kiểm tra ca thường: metadata đã có sẵn trong
   `scriptParsed`, so với file mà `selectRuntimeLogFrame` dù sao cũng đã đọc rồi.
3. **`Debugger.getScriptSource` là oracle chính xác, để dành cho ca lệch.** Chỉ gọi khi metadata đã
   lệch — lúc đó mới cần biết runtime *đang thật sự chạy nội dung gì* để phân biệt Shadowed File
   với Stale File. Không dùng `hash`: V8 tự tính theo thuật toán riêng, tái hiện phía client là
   phụ thuộc phiên bản một cách không cần thiết khi đã có ba field trên.

**Chi phí bật `Debugger` (item 7)** — dự án sinh tự động, mỗi module ~40 dòng, bật domain SAU khi
app đã nạp xong (đúng hình dạng thật: người dùng bấm Connect vào app đang chạy):

| Số module | `Debugger.enable` trả về | Backlog `scriptParsed` chảy hết | Số sự kiện | Kích thước |
| --- | --- | --- | --- | --- |
| 3.000 | 112 ms | 112 ms | 3.092 | 1,8 MB |
| 10.000 | 246 ms | 246 ms | 10.091 | 5,9 MB |

Tuyến tính, một lần duy nhất lúc Connect, và ở mức 10.000 module vẫn dưới 1/4 giây. **Không cần
giới hạn phạm vi script quan tâm** — mục 7 của checklist đóng ở đây, chỉ cần giữ metadata (không
giữ source) để bộ nhớ không phình theo kích thước code.

**Ghi nhận phụ, không thuộc ticket này:** Node 20 quảng cáo `webSocketDebuggerUrl` là
`ws://localhost/<id>` — **không có port**. Nối thẳng vào chuỗi đó là ra port 80. Đây đúng là ca
ticket 02 đã viết `rewriteWebSocketUrl` để xử lý; thí nghiệm này xác nhận nó không phải phòng xa
mà là đường đi bắt buộc trên Node hiện tại.
