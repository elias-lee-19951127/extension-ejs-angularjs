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

**Status:** done

- [x] Đọc config `templateRoots`/`expressViewsDir` trong resolver (Layer 4, chỗ nối
      template↔controller — xem thứ tự nguồn liên kết ở `docs/kien-truc.md` mục 5.1)
- [x] `templateUrl: '/views/profile.html'` trong DDO / `$routeProvider` / `$stateProvider` /
      `.component()` map đúng sang file đĩa qua `templateRoots`, thử theo `extensions` khai báo
      nếu tên file không khớp đuôi trực tiếp
- [x] `res.render('user/profile')` (trục A) map qua `expressViewsDir`
- [x] `templateUrl` là biểu thức động (ví dụ `base + '/x.html'`) → không cố resolve, ghi nhận vào
      báo cáo "unresolved links" thay vì bỏ qua im lặng hoặc báo lỗi sai
- [x] Test qua public API thật (`Workspace.*` hoặc CLI `sweep`) — đúng bất biến của dự án, không
      test private method

## Comments

**2026-09-19 — done.** Hiện thực ở `packages/core/src/resolve/template-links.ts`; tóm tắt thiết kế ghi
ở `docs/kien-truc.md` mục 5.1 (và `docs/architecture.md`).

- Extractor: `JsFacts.templateLinks` từ DDO directive, `.component()` (alias mặc định `$ctrl`),
  `$routeProvider.when`, `$stateProvider.state` (cả dạng `.state({name})` và named `views`);
  hiểu cả `controller: 'X as vm'`. `renderCalls` thêm `viewSpan` + span từng key. `PARSER_VERSION` 11 → 12.
- Layer 4 (`link()`): map URL qua `templateRoots` (prefix dài nhất trước, thử `extensions`), rồi
  thử URL như đường dẫn từ gốc workspace. Controller được nối LÚC QUERY qua `Workspace.facts()` —
  definition, completion, hover, rename đều thấy. Rename cần thêm 2 hook ở `RenameSource`
  (`linkedController`, `bindTemplate`) vì nó tự trích lại template.
- Quyết định thêm, ngoài ticket: một template bị gán NHIỀU controller khác nhau → không gán, báo
  `ambiguous-controller`. `expressViewsDir` mặc định `views` (giống Express).
- Biểu thức động: báo `dynamic` trong `Workspace.templateLinkIssues()` + cuối `ejsng sweep`, KHÔNG
  chặn Ctrl+click trên biến trong biểu thức (`base` vẫn nhảy tới khai báo — lỗi này bắt được khi
  chạy thử sweep).
- Setting VS Code `ejsng.templateRoots`/`ejsng.expressViewsDir`; CLI `--template-root`, `--views-dir`.
- Test: `packages/core/test/template-links.test.js` (12 test qua `Workspace`). Sweep smart-city
  trùng từng dòng với trước (98.9%) — nhưng repo đó không dùng `templateUrl`/`res.render` nào, nên
  CHƯA đo được hiệu quả trên repo thật.
- Chưa làm (ngoài phạm vi): heuristic nguồn 6, `$uibModal.open`/`$mdDialog.show({templateUrl})`,
  completion sau alias (`vm.`) và rename `this.x` — hai cái sau là giới hạn có sẵn, không riêng ticket này.
