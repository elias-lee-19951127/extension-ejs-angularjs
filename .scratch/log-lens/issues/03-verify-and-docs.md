# 03 — Verify + tài liệu

**What to build:** Kiểm trong VS Code thật, rồi ghi vào tài liệu (bản Việt chính, bản Anh đi kèm).

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Test e2e VS Code thật: `executeCodeLensProvider` trên fixture có lens đúng dòng, bấm → có logpoint đúng vị trí,
      bấm lại → mất; đổi setting sang `off` → không lens; `all` → nhiều lens hơn
- [ ] `examples/log-at-runtime/README.md`: thêm bước dùng CodeLens (một click, không gõ)
- [ ] `README.md` + `README.en.md`: dòng setting `ejsng.logLens` + một câu trong phần "Log at runtime"
- [ ] `docs/kien-truc.md` + `docs/architecture.md`: mục mới — vì sao CodeLens (VS Code không cho điền sẵn ô Add Logpoint),
      bảng đo số lens, vì sao mặc định chỉ lấy lần gán không suy ra được kiểu
- [ ] Cập nhật "Trạng thái" trong `spec.md`
