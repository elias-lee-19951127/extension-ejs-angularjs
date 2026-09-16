# Runbook — đo prototype extension phụ (ticket 01)

Việc này phải chạy trên máy Remote-WSL thật (xem `user-real-runtime-setup` trong memory: Windows
→ Remote-WSL AlmaLinux, Chrome chạy trên Windows). Không chạy được trong sandbox macOS đang dùng để
viết code này — không có Extension Host thật, không có WSL, không có Chrome Windows.

Toàn bộ thư mục `prototype-companion/` là code vứt đi. Sau khi có kết quả và đã ghi vào
`../prototype-companion.md`, xoá cả thư mục này (`git rm -r` hoặc xoá tay) trước khi đóng ticket 01.

## 1. Chuẩn bị Chrome (phía Windows)

Đóng hết Chrome đang chạy, rồi mở lại với debug port và **profile riêng** (không dùng profile thật —
xem cảnh báo bảo mật ở story #33 trong spec, dù đây chỉ là đo, vẫn nên tập thói quen đúng):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\temp\proto-chrome-profile"
```

Trong cửa sổ Chrome đó, mở file `gen-log-page.html` (đường dẫn UNC từ Windows tới file trong WSL,
ví dụ `\\wsl.localhost\AlmaLinux-9\home\phulh11\...\prototype-companion\gen-log-page.html`, hoặc copy
file sang máy Windows). **Đừng bấm Start ngay** — phải attach CDP trước.

## 2. Mở VS Code với cả hai extension dev-host

Từ cửa sổ VS Code đang mở workspace này qua Remote-WSL, mở Command Palette →
**Developer: Reload Window with Extensions Disabled**? Không cần — chỉ cần thêm hai cờ
`--extensionDevelopmentPath` khi khởi động. Cách đơn giản nhất: đóng cửa sổ, mở lại từ terminal
Windows/WSL:

```bash
code --remote wsl+AlmaLinux-9 /home/phulh11/projects/aocs \
  --extensionDevelopmentPath=/home/phulh11/projects/aocs/.scratch/runtime-remote-env/prototype-companion/workspace-ext \
  --extensionDevelopmentPath=/home/phulh11/projects/aocs/.scratch/runtime-remote-env/prototype-companion/ui-ext
```

(Sửa lại đường dẫn workspace và tên distro WSL cho đúng máy thật — đây chỉ là ví dụ theo
`user-real-runtime-setup`.) Cả hai extension dev-host chạy trong **cùng một cửa sổ**; VS Code tự đặt
`workspace-ext` vào extension host phía WSL (không khai `extensionKind`, mặc định `workspace`) và
`proto-ui-companion` vào extension host phía Windows (khai `extensionKind: ["ui"]`).

Mở **Output panel**, chọn kênh **"Proto Workspace Host"** để xem log phía WSL, và **"Proto UI
Companion"** cho phía Windows — hai kênh riêng biệt tự xác nhận đúng là hai extension host khác
nhau (nếu là cùng một host, `vscode.env.remoteName` ở workspace-ext sẽ khác None trong khi ở ui-ext
sẽ khác None nếu chạy sai host — output đã in dòng này lúc activate, đọc trước khi đo).

## 3. Chạy cơ chế 1 — `vscode.commands`

1. Command Palette → **Proto: Attach via vscode.commands** (`protoUi.runCommandsMechanism`).
2. Nhập port debug đã mở (`9222`).
3. Đợi Output "Proto UI Companion" báo `attached via "commands" mechanism ... Runtime.enable sent`.
4. Chuyển sang cửa sổ Chrome, đưa tab `gen-log-page.html` lên **foreground**, bấm **Start**.
5. Đợi 30s + vài giây đệm cho tới khi trang báo `done: 3000` và Output phía UI báo
   `page reports generator done; captured 3000 events total` (nếu số này lệch xa 3000 ngay từ bước
   capture, nghẽn đã xảy ra ở tầng CDP chứ không phải ở cơ chế đang đo — ghi chú lại).
6. Ở terminal WSL:
   ```bash
   node .scratch/runtime-remote-env/prototype-companion/analyze.js \
     .scratch/runtime-remote-env/prototype-companion/results/run-commands.ndjson
   ```
7. Ghi lại output đầy đủ (đặc biệt `dropped`, `latency median`, `latency max`, dòng `PASS`).

## 4. Reset rồi chạy cơ chế 2 — forwarded port

1. Command Palette → **Proto: Clear recorded results** (`protoWorkspace.reset`) để xoá
   `results/*.ndjson` và đóng server TCP cũ.
2. Reload trang `gen-log-page.html` trong Chrome (F5) — lấy lại trạng thái `idle`, **đừng bấm
   Start**.
3. Command Palette → **Proto: Attach via forwarded port** (`protoUi.runPortMechanism`), nhập lại
   port `9222`.
4. Kiểm Output "Proto Workspace Host" có dòng `TCP server on 127.0.0.1:PORT, forwarded as ...` —
   copy giá trị forwarded URI, đây chính là bằng chứng cơ chế forward của VS Code đã hoạt động trên
   Remote-WSL thật (đúng thứ ticket cần xác nhận).
5. Bấm **Start** trên trang, đợi xong như bước 3 ở trên.
6. Chạy `node analyze.js results/run-port.ndjson`, ghi lại output.

## 5. Nếu một cơ chế không chạy được

Ghi rõ **lỗi thật** (thông báo lỗi, Output log liên quan), không đoán. Ví dụ cần theo dõi theo đúng
mối lo trong spec:

- `vscode.commands.executeCommand` gọi cross-host có báo lỗi "command not found" không (registerCommand
  ở workspace-ext có chạy trước khi ui-ext gọi không — nếu race, thử gọi lại sau khi thấy Output
  "ready" của workspace-ext).
- `vscode.env.asExternalUri` có ném lỗi hoặc trả về URI không kết nối được không (một số kiểu remote
  yêu cầu người dùng xác nhận port forward qua notification — kiểm tra có popup nào bị bỏ lỡ).

## 6. Ghi kết quả

Điền số đo thật vào `../prototype-companion.md` (mục "Kết quả đo"), đánh dấu đạt/không đạt theo
đúng tiêu chí ticket (không mất log **và** trễ dưới 200ms — thiếu một trong hai là không đạt), rồi
xoá thư mục `prototype-companion/` này.
