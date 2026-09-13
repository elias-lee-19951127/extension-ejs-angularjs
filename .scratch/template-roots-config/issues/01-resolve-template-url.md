# 01 — Resolve `templateUrl` động qua config `templateRoots`/`expressViewsDir`

**What to build:** `templateRoots` (`{urlPrefix, fsPath, extensions?}[]`) và `expressViewsDir` đã
khai ở `packages/core/src/types.ts:190-198` từ trước nhưng **không có dòng code nào trong
`packages/*/src` đọc tới** — seam khai báo dở. Ý định gốc đã ghi ở `docs/kien-truc.md:283-295`
(mục 5.1): `templateUrl: '/views/profile.html'` là URL runtime, không phải đường dẫn đĩa, cần map
qua config này để nối template↔controller đúng khi dùng EJS.

Lưu ý: mục này **không liên quan** tới feature `inline-runtime-log` — đã xác nhận rõ trong phiên
grill của feature đó (`.scratch/inline-runtime-log/spec.md` mục "Quan hệ với feature..."), tách
thành feature-slug riêng ở đây để không lẫn hai mối quan tâm khác nhau.

**Blocked by:** None — bắt đầu ngay.

**Status:** ready-for-agent

- [ ] Đọc config `templateRoots`/`expressViewsDir` trong resolver (Layer 4, chỗ nối
      template↔controller — xem thứ tự nguồn liên kết ở `docs/kien-truc.md` mục 5.1)
- [ ] `templateUrl: '/views/profile.html'` trong DDO / `$routeProvider` / `$stateProvider` /
      `.component()` map đúng sang file đĩa qua `templateRoots`, thử theo `extensions` khai báo
      nếu tên file không khớp đuôi trực tiếp
- [ ] `res.render('user/profile')` (trục A) map qua `expressViewsDir`
- [ ] `templateUrl` là biểu thức động (ví dụ `base + '/x.html'`) → không cố resolve, ghi nhận vào
      báo cáo "unresolved links" thay vì bỏ qua im lặng hoặc báo lỗi sai
- [ ] Test qua public API thật (`Workspace.*` hoặc CLI `sweep`) — đúng bất biến của dự án, không
      test private method
