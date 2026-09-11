import type { AttrCandidate, FileFacts, NgDeclaration } from '../types';
import { tryParseExpression } from '../ng/parser';
import { collectRoots } from '../ng/ast';
import { SCOPE_BUILTINS } from '../ng/normalize';
import type { RefInput } from './rows';

export interface DirectiveInfo {
  name: string;
  ddo: NgDeclaration['ddo'];
  kind: 'directive' | 'component';
}

/**
 * Layer 4 — Linker.
 *
 * Chay SAU khi moi file da co fact. Nhiem vu duy nhat: phan giai nhung thu ma
 * Layer 2 khong the biet vi phai nhin sang file khac.
 *
 * Vi sao tach ra (docs/kien-truc.md muc 3): fact per-file phai thuan de cache dung.
 * Doi lai, moi ket luan lien file phai dung o day. Nho vay sua mot controller
 * KHONG can parse lai template nao — chi can chay lai buoc noi nay.
 */
export class Linker {
  private directives = new Map<string, DirectiveInfo>();

  /** Nap bang directive/component tu fact cua cac file .js. */
  loadDirectives(all: Array<{ path: string; facts: FileFacts }>): void {
    this.directives.clear();
    for (const { facts } of all) {
      if (facts.kind !== 'js') continue;
      for (const d of facts.declarations) {
        if (d.kind !== 'directive' && d.kind !== 'component') continue;
        this.directives.set(d.name, { name: d.name, ddo: d.ddo, kind: d.kind });
      }
    }
  }

  get directiveCount(): number {
    return this.directives.size;
  }

  /**
   * Phan giai cac thuoc tinh chua biet cua mot template thanh tham chieu that.
   *
   * Ba truong hop duoc nhan:
   *  1. Ten thuoc tinh trung ten mot directive  -> `kbm-file="onFilePicked($file)"`
   *  2. The la mot directive/component, va ten thuoc tinh trung mot binding
   *     trong isolate scope cua no -> `<cityos-dha data="CTX">`
   *  3. The la directive/component da biet -> ghi nhan tham chieu toi chinh no
   *
   * Ngoai ba truong hop tren thi KHONG doan bua: mot `foo-bar="baz"` la khong
   * ro rang, va bao nham con te hon la bo sot.
   */
  resolveCandidates(candidates: AttrCandidate[]): RefInput[] {
    const refs: RefInput[] = [];

    for (const cand of candidates) {
      const asDirective = this.directives.get(cand.attr);
      const onDirective = this.directives.get(cand.tag);
      const isBinding =
        onDirective?.ddo?.scopeBindings && cand.attr in onDirective.ddo.scopeBindings;

      if (asDirective) {
        refs.push({
          name: cand.attr,
          container: null,
          axis: 'ng-directive',
          span: cand.attrSpan,
        });
      }

      if (!asDirective && !isBinding) continue;

      // Gia tri thuoc tinh la mot bieu thuc Angular — parse va ghi nhan cac goc.
      const program = tryParseExpression(cand.value, cand.valueSpan.start);
      if (!program) continue;

      for (const root of collectRoots(program)) {
        if (cand.locals.includes(root.name)) continue;
        if (SCOPE_BUILTINS.includes(root.name)) continue;
        // `$file`, `$event` la bien do directive tu dua vao, khong phai scope.
        if (root.name.startsWith('$')) continue;
        refs.push({
          name: root.name,
          container: cand.container,
          axis: 'ng-scope',
          span: root.span,
        });
      }
    }

    return refs;
  }

  /** Tham chieu toi directive qua the custom: `<cityos-dha>`. */
  resolveElement(tag: string): boolean {
    return this.directives.has(tag);
  }
}
