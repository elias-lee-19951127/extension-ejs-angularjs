# 04 — Server: bằng chứng runtime trong hover

**What to build:** Kiểu đã thấy trong hover gộp cả bằng chứng runtime (ticket 03) với bằng chứng tĩnh
thành một kiểu, kèm dòng nguồn runtime (spec #7, #8). Inline hint không đổi (spec #9).

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] `ObservedTypeSource` cung cấp bằng chứng runtime; `observedTypeOf` gộp chung bằng `typeFromEvidence` / `mergeTypes`,
      lọc bản controller gần nhất theo file của chỗ log như bằng chứng tĩnh
- [ ] Member chỉ có bằng chứng runtime (không có lần gán tĩnh nào) vẫn có hover
- [ ] Dòng "Seen at runtime: N× — last HH:MM:SS via `<nhãn kết nối>`, logged at (link)"; nhiều kết nối → mỗi kết nối một dòng, tối đa 3
- [ ] Có bằng chứng runtime cho path → dòng "Could not be inferred — assigned from `…`" thành
      "Not inferred statically (`…`) — shape from runtime"
- [ ] Runtime thấy `null`/`undefined` → hover ghi "seen `null` at runtime"; **`nullableHints` không đổi** (test khẳng định)
- [ ] Nội dung hover tiếng Anh (CLAUDE.md)
- [ ] Test LSP stdio + fake CDP: hover `vm.rows` trong template trước và sau khi có log; ngắt kết nối → hover về như bản 1
