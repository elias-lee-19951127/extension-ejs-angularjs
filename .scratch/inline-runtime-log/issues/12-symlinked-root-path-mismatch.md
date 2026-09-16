# 12 — Root-containment check sai khi workspace root nằm sau symlink

**What to build:** Phát hiện khi viết test end-to-end cho ticket 10 (2026-09-14): `workspace.toRelative(fsPath)`
dùng `path.resolve`, **không** resolve symlink. Nếu workspace root (hoặc bất kỳ phần nào của
đường dẫn tới nó) là một symlink, mà Node/CDP báo cáo đường dẫn **đã resolve** (thực tế xảy ra
với `os.tmpdir()` trên macOS: `/var/folders/...` là symlink tới `/private/var/folders/...`, và V8
báo lại đường REALPATH trong stack trace) — thì so sánh hai đường dẫn không khớp, log bị hiểu
nhầm là "ngoài workspace" và bị guard chặn im lặng dù thực chất là cùng một file.

Không chỉ ảnh hưởng test: bất kỳ người dùng nào mở workspace qua một đường dẫn có symlink ở giữa
(phổ biến: thư mục trong `/tmp`, một số setup qua `nvm`/`asdf`, thư mục mount qua symlink) đều gặp
đúng lỗi này — mọi log runtime từ file trong workspace của họ sẽ bị bỏ qua im lặng, không có cách
nào biết vì sao.

**Blocked by:** None — độc lập, sửa được ngay.

**Status:** ready-for-agent

- [ ] Resolve symlink ở **cả hai phía** trước khi so sánh: `workspace.config.root` (một lần, lúc
      khởi tạo hoặc cache lại) và `fsPath` từ CDP event (mỗi lần, vì đây là input từ ngoài) — dùng
      `fs.realpathSync` thay vì chỉ `path.resolve`
- [ ] Không phá vỡ hành vi hiện có khi không có symlink nào (đường dẫn thường vẫn resolve y hệt
      như cũ)
- [ ] `realpathSync` throw nếu file không tồn tại (ví dụ CDP báo đường dẫn ảo, script eval) — bọc
      an toàn, coi như "không resolve được" → vẫn áp guard chặn như hiện tại, không throw ra ngoài
- [ ] Test: file thật trong workspace, truy cập qua một symlink trỏ tới workspace root → resolve
      đúng, không bị chặn nhầm (tái hiện đúng kịch bản đã gặp ở macOS `tmpdir()`)
- [ ] Cân nhắc: sửa ở `isWithinRoot`/chỗ gọi nó trong `packages/server/src/index.ts`, hay sửa sâu
      hơn trong `Workspace.toRelative` (packages/core) — vì `refreshFiles` cũng dùng chung logic
      này và có thể gặp đúng lỗi tương tự với file thay đổi ngoài editor qua đường dẫn symlink

## Comments

2026-09-16: cuốn vào ticket `.scratch/runtime-remote-env/issues/02-probe-an-toan-va-trang-thai-that.md`
(gộp với sửa header `Host`, viết lại ws URL, và báo trạng thái kết nối thật). Làm ở đó, không làm
riêng ở đây.
