# 14 — Kết nối inspector chưa publish qua IP của container

**What to build:** Container chạy `--inspect=0.0.0.0:9229` nhưng không publish port đó (thường vì hai
container cùng dùng 9229 bên trong) từng chỉ được báo "unreachable" kèm snippet compose. Với Docker
Engine chạy trong WSL/Linux, IP nội bộ của container (172.x) route được từ host — nên thử
`<ip>:<port trong container>` trước khi bỏ cuộc. Không đụng vào container (không `docker exec`, không
sửa compose): chỉ một GET `/json/list`, timeout 1 giây. Giữ nguyên quyết định #3 của `decisions.md`.

**Blocked by:** None

**Status:** done — verify trên WSL thật còn lại

- [x] `parseDockerInspect` đọc `NetworkSettings.Networks.*.IPAddress` (+ trường cũ `IPAddress`) → `containerIps`.
- [x] Server `reachDockerCandidates`: port đã publish như cũ; chưa publish → thử từng IP; trả lời được thì
      coi là connectable, mount-inferred mapping gắn theo endpoint `ip:port`.
- [x] Quick Pick ghi rõ "(inspector at container IP …)"; checklist Docker ghi chú cách đã với tới; report ghi
      "container IP".
- [x] Test: LSP với `docker` giả (IP = 127.0.0.1) — kết nối được và log vẽ qua mapping từ mount; không ai trả
      lời thì vẫn báo unreachable như cũ. Core: đọc IP, checklist.

## Comments

Ghi chú 2026-09-19: `decisions.md` ghi `cityos-app` publish inspector ra host 9228, và panel thật của người
dùng không báo container nào unreachable — nên với máy đó tính năng này nhiều khả năng không phải thứ còn
thiếu. Chặn thật sự ở `cityos-app` là `LOGGING_APPENDERS=file` (log4js không gọi `console`) — logpoint
chạy được bất kể appender.
