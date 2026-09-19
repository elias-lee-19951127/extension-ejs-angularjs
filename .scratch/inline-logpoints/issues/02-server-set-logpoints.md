# 02 — Server đặt / gỡ logpoint trên mọi kết nối Runtime Log

**What to build:** Notification `ejsng/setLogpoints` `{ logpoints: [{ uri, line, logMessage, condition? }] }`
(thay toàn bộ). Với mỗi kết nối CDP: gỡ breakpoint cũ của mình, đặt mới — lúc kết nối mở, khi danh
sách đổi, và khi `Debugger.scriptParsed` báo một URL chỉ ánh xạ xuôi mới ra file có logpoint. Xem spec,
quyết định #1, #3, #4, #7.

**Blocked by:** 01

**Status:** done

- [x] `connectRuntimeLog` có `request(method, params, timeoutMs)` tổng quát; `getScriptSource` dùng lại nó.
- [x] JSDoc bỏ cam kết "no breakpoint is ever set", thay bằng "chỉ đặt breakpoint có điều kiện luôn `false` — runtime không bao giờ pause".
- [x] Đặt lại an toàn khi danh sách đổi liên tục: breakpoint trả về cho một lượt cũ thì gỡ ngay.
- [x] (b) của #7: không đặt trùng khi regex ở (a) đã phủ URL đó.
- [x] Test LSP end-to-end với **`node --inspect` thật**: logpoint hiện inline đúng dòng, app không bị pause, không in ra stdout của app, gỡ logpoint thì hết log.
- [x] Test với fake runtime: URL trình duyệt chỉ khớp được bằng ánh xạ xuôi → đặt bằng `url` chính xác.
