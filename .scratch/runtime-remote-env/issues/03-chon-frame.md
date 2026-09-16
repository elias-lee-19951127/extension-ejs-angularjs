# 03 — Chọn frame: bỏ qua logger, file obfuscate, lọc ANSI

**What to build:** Log đi qua logger (log4js vendored trong `aocs/utility/`) hiện gắn vào dòng
`console.log` bên trong logger, không phải dòng code người dùng. Code platform lại bị obfuscate
không source map, nên dù chọn đúng frame cũng chỉ ra "dòng 1". Ticket này chọn frame đọc được đầu
tiên và làm sạch giá trị hiển thị.

**Blocked by:** 02 — cần bộ đếm lý do bỏ log để báo "bỏ hết frame".

**Status:** ready-for-agent

- [ ] Danh sách bỏ qua mặc định: `node:internal/**`, `**/node_modules/**`, và thư mục của các
      logger phổ biến — chọn frame đầu tiên không bị bỏ
- [ ] Setting `ejsng.runtimeLog.skipFrames` cho người dùng thêm pattern riêng (logger vendored,
      wrapper của team); mặc định rỗng và cộng vào danh sách mặc định, không thay thế
- [ ] Nhận diện file minify/obfuscate không source map (gần như không có ký tự xuống dòng so với
      kích thước) và bỏ qua frame thuộc file đó
- [ ] Bỏ hết frame thì log **không** vẽ inline, chỉ vào panel, và được đếm đúng lý do
- [ ] Mã màu ANSI bị lọc khỏi giá trị trước khi hiển thị; màu theo mức log giữ nguyên như hiện tại
- [ ] Panel xem được stack đã chọn và các frame đã bỏ của vài log gần nhất
- [ ] Một frame gom quá nhiều log khác nhau (dấu hiệu wrapper) thì panel gợi ý bỏ qua file đó; chỉ
      ghi vào settings khi người dùng bấm
