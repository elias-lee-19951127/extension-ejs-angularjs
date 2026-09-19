# 05 — Tài liệu

**What to build:** Ghi tính năng vào tài liệu dự án, bản Việt là chính và bản Anh đi kèm (theo
`CLAUDE.md`).

**Blocked by:** 03, 04

**Status:** done

- [x] `CONTEXT.md` + `CONTEXT.en.md`: thuật ngữ **Kiểu đã thấy (Observed Type)** và **Bằng chứng kiểu (Type Evidence)**
- [x] `README.md` + `README.en.md`: dòng setting `ejsng.typeHints.nullable`; một đoạn ngắn hover cho biết gì, khi nào có inline
- [x] `docs/kien-truc.md` + `docs/architecture.md` mục 5.3 (suy luận kiểu): gộp mọi lần gán, gán lồng, vì sao
      không inline mọi biểu thức, lộ trình R1/R4/R3 và lý do bỏ R2
- [x] Cập nhật "Trạng thái" trong `spec.md` của feature này

## Comments

**2026-09-19 — done.** `CONTEXT.md`/`CONTEXT.en.md`: mục mới **Observed Type** với hai thuật ngữ,
kèm chỗ khác Shape Walking (lần gán đầu vs mọi lần gán). `README.md`/`README.en.md`: dòng trong bảng
tính năng, mục ngắn "Kiểu đã thấy trong hover và inline", dòng setting `ejsng.typeHints.nullable`.
`docs/kien-truc.md`/`docs/architecture.md`: mục con **5.3.1** (không viết lại 5.3 gốc — shape lần gán
đầu vẫn là thứ completion/go-to-definition dùng). Nhãn trong docs khớp chuỗi thật ở
`packages/server/src/index.ts` (`may be empty`, *Can be empty when rendered*, …).
