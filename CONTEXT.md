# CONTEXT

Glossary thuat ngu domain cho repo `extension-ejs-angularjs` (language server EJS + AngularJS 1.x).
Xem `docs/agents/domain.md` de biet cach cac skill agent doc file nay.

## Definition Resolution

Logic go-to-definition thuan tuy: tim dinh nghia cua mot dinh danh tai mot vi tri trong file
`.js` hoac `.ejs` da duoc danh index — KHONG bao gom buoc loc "ban gan nhat" khi mot ten bi
khai bao trung o nhieu file (xem `preferNearest` trong `Workspace`, van con o
`packages/core/src/resolve/workspace.ts`).

- File: `packages/core/src/resolve/definition.ts`
- Entry point: `resolveDefinition(deps: FactSource, relPath, offset): DefinitionResult`
- Tach ra tu `Workspace` (phu luc kien truc: xem `docs/kien-truc.md` muc M) vi day la module
  deep — xoa no khoi `Workspace` thi do phuc tap bien mat han, khong don sang cho khac.

## Shape Walking

Logic di theo duong dan property tren mot `ValueShape` da suy luan tu Layer 2 (vi du:
`$scope.sections = [...]` roi hoi `section.icon` trong template) — dung chung boi ca
**Definition Resolution** lan completion (`Workspace.memberCompletions`).

- File: `packages/core/src/resolve/shape.ts`
- Ham chinh: `walkShape`, `shapeOf`, `shapeAtPath`
- Tach rieng khoi Definition Resolution du hai module co lien quan gan, vi day la phu thuoc
  CHUNG giua definition va completion — nhet vao mot trong hai se tao phu thuoc cheo khong
  can thiet.

## FactSource

Interface hep ma **Definition Resolution** va **Shape Walking** dung de doc du lieu tu
`Workspace`, thay vi cam ca class. Dinh nghia o `packages/core/src/resolve/shape.ts`:
`facts()`, `source()`, `findSymbols()`, `moduleAliases`. `Workspace implements FactSource` va
tu truyen `this` vao khi goi hai module tren.

## Rename Orchestration

Dong bo doi ten mot property tren `$scope` qua ca file `.js` lan moi template dung no —
kiem xung dot, tim ban sao controller trung ten, ghi canh bao cho cho template khong hieu
duoc la bieu thuc Angular. KHONG bao gom cac ham thuan (`nearestFiles`, `renameScope`,
`scopeAccessesByDecl`…) — nhung cai do van o `packages/core/src/resolve/rename.ts`.

- File: `packages/core/src/resolve/rename-orchestrator.ts`
- Entry point: `renameAt(deps: RenameSource, relPath, offset, newName): RenameResult`,
  `prepareRenameAt(deps: RenameSource, relPath, offset): PrepareRenameResult`
- Tach ra tu `Workspace` (xem `docs/kien-truc.md` muc M) — khac voi Definition Resolution,
  deletion test cho thay module nay **can that** state rieng cua `Workspace` (Linker, danh
  sach file dang mo trong editor), nen seam la mot interface RONG hon `FactSource`
  (`RenameSource`), khong phai tach thanh ham hoan toan doc lap.

## RenameSource

Interface `packages/core/src/resolve/rename-orchestrator.ts` dung de Rename Orchestration doc
Workspace: gom moi thu cua `FactSource` cong them `templatePaths()`, `openTemplatePaths()` (thay
cho doc thang `overlays` — Map rieng cua Workspace), va `resolveScopeRefs()` (boc `Linker`, giau
hoan toan su ton tai cua Linker khoi orchestrator).

## Runtime Log

**Runtime Target**:
Mot tien trinh Node hoac mot tab trinh duyet dang chay ma extension gan vao qua giao thuc debug
de doc `console.*`.
_Avoid_: runtime, inspector, debug port (debug port chi la noi reach duoc target)

**Runtime Path**:
Duong dan file hoac URL ma Runtime Target bao cho mot dong log — nhin tu ben trong target
(duong dan trong container, URL `http://` cua trinh duyet), chua chac ton tai tren may dang mo
workspace.
_Avoid_: remote path, container path

**Path Mapping**:
Quy tac doi mot tien to Runtime Path sang tien to duong dan tren may dang mo workspace. Nguon
theo thu tu uu tien: nguoi dung tu khai > suy tu mount Docker (mount dai nhat thang) > khop duoi
(chi cho URL trinh duyet).
_Avoid_: remote/local mapping, path rewrite

**Shadowed File**:
File trong workspace ma Runtime Target khong bao gio chay, vi mot mount Docker cu the hon da de
len duong dan cua no ben trong container — sua file nay khong anh huong gi toi runtime.

**Stale File**:
File tren dia co noi dung khac voi ban Runtime Target dang chay (da sua nhung runtime chua nap
lai). Log tu Stale File khong duoc ve inline vi so dong khong con dung.
_Avoid_: outdated file, dirty file

**Logpoint**:
Breakpoint cua VS Code co `logMessage` (`x = {x}`) ma extension tu dat len Runtime Target qua
kenh debug cua chinh no, voi dieu kien luon tra `false` — ghi log roi chay tiep, khong bao gio dung
runtime. Log cua no di chung duong ve inline voi `console.*`. Xem
`.scratch/inline-logpoints/spec.md` va `docs/adr/0001-runtime-log-sets-logpoints.md`.
_Avoid_: breakpoint (breakpoint thuong thi dung chuong trinh — extension khong bao gio dat loai do), tracepoint
