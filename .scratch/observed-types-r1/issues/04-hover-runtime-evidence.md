# 04 — Server: bằng chứng runtime trong hover

**What to build:** Kiểu đã thấy trong hover gộp cả bằng chứng runtime (ticket 03) với bằng chứng tĩnh
thành một kiểu, kèm dòng nguồn runtime (spec #7, #8). Inline hint không đổi (spec #9).

**Blocked by:** 03

**Status:** done

- [x] `ObservedTypeSource` cung cấp bằng chứng runtime; `observedTypeOf` gộp chung bằng `typeFromEvidence` / `mergeTypes`,
      lọc bản controller gần nhất theo file của chỗ log như bằng chứng tĩnh
- [x] Member chỉ có bằng chứng runtime (không có lần gán tĩnh nào) vẫn có hover
- [x] Dòng "Seen at runtime: N× — last HH:MM:SS via `<nhãn kết nối>`, logged at (link)"; nhiều kết nối → mỗi kết nối một dòng, tối đa 3
- [x] Có bằng chứng runtime cho path → dòng "Could not be inferred — assigned from `…`" thành
      "Not inferred statically (`…`) — shape from runtime"
- [x] Runtime thấy `null`/`undefined` → hover ghi "seen `null` at runtime"; **`nullableHints` không đổi** (test khẳng định)
- [x] Nội dung hover tiếng Anh (CLAUDE.md)
- [x] Test LSP stdio + fake CDP: hover `vm.rows` trong template trước và sau khi có log; ngắt kết nối → hover về như bản 1

## Comments

**2026-09-19 — done.** Core: `ObservedTypeSource.runtimeEvidence?(owner, member)`; `Workspace.setRuntimeEvidence(provider)`
(Workspace không giữ gì — server bơm vào từ các kết nối đang sống). `observedTypeOf` gộp bằng chứng runtime
cùng lọc `nearestRows` như bằng chứng tĩnh (site của log nằm trong thân controller nên biết là bản nào).
`ObservedTypeResult` thêm `runtime: RuntimeSighting[]` (theo kết nối, mới nhất trước, ≤3) và `seenNullAtRuntime`.
**`nullable` giờ chỉ tính từ bằng chứng tĩnh** — `nullableHints` dựa vào nó nên inline hint không đổi;
còn `text` thì gộp cả runtime (vd `{ title: string } | null`). "Assigned at" chỉ liệt kê lần gán; log của
một key bên trong (`vm.form.owner`) vẫn tính là "thấy" `vm.form`.

Server: `observedTypeLines` — dòng "_Seen at runtime:_ N× — last HH:MM:SS via `nhãn`, logged at (link)";
có bằng chứng runtime + lần gán không suy ra được → "_Not inferred statically_ (`load(n)` link) _— shape from runtime_";
`seenNullAtRuntime` → "_Seen `null`/`undefined` at runtime_ — no assignment sets it, so it gets no inline hint."

**Lỗi tìm ra khi test, đã sửa (spec #3 cập nhật):** khoá khử trùng 30 giây ban đầu là `(chỗ log, arg)` →
`console.log($scope.sel)` log object trước rồi `null` thì `null` không bao giờ được ghi. Giờ khoá thêm
chữ ký kiểu của **preview** (có sẵn trong log, không tốn lệnh CDP): cùng hình dạng → chỉ đếm; khác → đào lại.

Test: `packages/core/test/observed-type.test.js` (+4: runtime lấp chỗ `res.data`, qua phần tử `ng-repeat`;
null thấy lúc chạy → hover có, hint không; member chỉ runtime biết + 2 kết nối; bản controller xa bị loại),
`packages/server/test/runtime-log-type-evidence.test.js` (+1, `node --inspect` thật: hover trước/sau khi nối,
dòng nguồn có link đúng dòng, inlay hint y nguyên, runtime chết → hover về đúng như trước).
Toàn bộ: 463/468, 5 lỗi smart-city có sẵn.
