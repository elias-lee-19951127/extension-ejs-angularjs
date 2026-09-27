/**
 * Runtime Type Evidence (.scratch/observed-types-r1/spec.md decisions #3 and #6): digging a logged
 * value just deep enough for the hover, and keeping what was learned — its type, never the value —
 * for as long as the connection it came from. The CDP request is passed in, so no IO lives here.
 */
import type { RemoteObject } from './runtime-log';
import type { ScopeTarget, Span } from './types';
import type { ObservedType, TypeEvidence } from './resolve/observed-type';
import { runtimeProperties, typeSignature, type RuntimeValue } from './runtime-shape';

export interface DigLimits {
  /** Levels of object keys to learn — the hover's nesting depth. */
  depth: number;
  /** Keys per object whose values are dug further — the hover's keys per level. */
  keys: number;
  /** Elements of an array dug into: first, middle, last. */
  samples: number;
  /** `Runtime.getProperties` calls per logged value, at most. */
  requests: number;
  /**
   * Dig an array's FIRST `samples` elements rather than first/middle/last — for a value that is
   * going to be shown, whose rendering lists the first elements (expand-log-values).
   */
  leading?: boolean;
}

/** Decision #3: the hover's 2 levels × 8 keys, 3 sampled elements, 12 requests. */
export const DIG_LIMITS: DigLimits = { depth: 2, keys: 8, samples: 3, requests: 12 };

/** `Runtime.getProperties` for one object: the CDP `result`, or `null` when the runtime didn't answer. */
export type GetProperties = (objectId: string) => Promise<unknown>;

function diggable(o: RemoteObject): o is RemoteObject & { objectId: string } {
  return o.type === 'object' && typeof o.objectId === 'string' && (o.subtype === undefined || o.subtype === 'array');
}

/** First, middle and last — spread over the array rather than bunched at its start. */
function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.round((i * (items.length - 1)) / (n - 1)));
  return [...picked].map((i) => items[i]!);
}

/**
 * Dig a logged value with `Runtime.getProperties`, a level at a time — the calls of one level in
 * parallel, shallow levels before deep ones, so a budget running out costs the least visible part.
 * An array's elements count as the array's own level (the hover shows `{ … }[]` at one level). What
 * isn't dug keeps the preview it arrived with, and reads as incomplete (`open`). Never throws: a
 * runtime that doesn't answer just leaves less known.
 */
export async function digRuntimeValue(
  object: RemoteObject,
  getProperties: GetProperties,
  limits: DigLimits = DIG_LIMITS,
): Promise<{ value: RuntimeValue; requests: number }> {
  const root: RuntimeValue = { object };
  let frontier: Array<{ node: RuntimeValue; level: number }> = [{ node: root, level: 1 }];
  let requests = 0;
  // `a.self = a` is ordinary code: without this, a cycle would spend the whole budget going round.
  const dug = new Set<string>();
  while (frontier.length && requests < limits.requests) {
    const batch = frontier
      .filter((f) => f.level <= limits.depth && diggable(f.node.object) && !dug.has(f.node.object.objectId!))
      .slice(0, limits.requests - requests);
    for (const { node } of batch) dug.add((node.object as { objectId: string }).objectId);
    requests += batch.length;
    const next: typeof frontier = [];
    await Promise.all(
      batch.map(async ({ node, level }) => {
        let result: unknown = null;
        try {
          result = await getProperties((node.object as { objectId: string }).objectId);
        } catch {
          return;
        }
        const descriptors = typeof result === 'object' && result !== null ? (result as { result?: unknown }).result : null;
        if (!Array.isArray(descriptors)) return;
        node.properties = runtimeProperties(descriptors);
        if (node.object.subtype === 'array') {
          const elements = node.properties.filter((p) => /^\d+$/.test(p.name) && p.value);
          for (const p of limits.leading ? elements.slice(0, limits.samples) : sample(elements, limits.samples)) next.push({ node: p.value!, level });
        } else {
          const shown = node.properties.filter((p) => p.enumerable !== false && !p.accessor && !p.name.startsWith('$$'));
          for (const p of shown.slice(0, limits.keys)) if (p.value) next.push({ node: p.value, level: level + 1 });
        }
      }),
    );
    frontier = next;
  }
  return { value: root, requests };
}

export interface EvidenceLimits {
  /** Distinct types kept per scope variable. */
  perVariable: number;
  /** Pieces of evidence kept in all. */
  total: number;
  /** A place logging again within this many ms is counted, not dug again. */
  redigAfterMs: number;
}

/** Decisions #3 and #6. */
export const EVIDENCE_LIMITS: EvidenceLimits = { perVariable: 20, total: 2000, redigAfterMs: 30_000 };

interface Entry {
  owner: string;
  evidence: TypeEvidence;
  signature: string;
}

/**
 * The runtime Type Evidence one connection has gathered. One piece per distinct type of a scope
 * variable: the same type seen again only bumps `count` / `lastSeen`. Only types are kept, never a
 * value, and nothing is written anywhere — drop the store and it's gone (decision #6).
 */
export class RuntimeEvidenceStore {
  private readonly byVariable = new Map<string, Map<string, Entry>>();
  /** Per logging place (file, offset, argument): when it was last dug, and what that produced. */
  private readonly recent = new Map<string, { at: number; entry: Entry | null; pending: number }>();
  private count = 0;

  constructor(
    /** The connection's label — the `connection` of every piece of evidence. */
    readonly connection: string,
    private readonly limits: EvidenceLimits = EVIDENCE_LIMITS,
  ) {}

  get size(): number {
    return this.count;
  }

  /**
   * Should the value logged at `place` be dug? `false` when the same place was dug within
   * `redigAfterMs` — its evidence is counted once more instead, even if the dig is still running.
   */
  claim(place: string, now: number): boolean {
    const r = this.recent.get(place);
    if (r && now - r.at < this.limits.redigAfterMs) {
      if (r.entry && this.has(r.entry)) {
        r.entry.evidence.count++;
        r.entry.evidence.lastSeen = now;
      } else {
        r.pending++;
      }
      return false;
    }
    if (this.recent.size >= this.limits.total) {
      for (const [k, v] of this.recent) if (now - v.at >= this.limits.redigAfterMs) this.recent.delete(k);
    }
    this.recent.set(place, { at: now, entry: null, pending: 0 });
    return true;
  }

  /** Record what the value logged at `place` turned out to be, for the scope variable `target`. */
  record(place: string, target: ScopeTarget, type: ObservedType, site: { path: string; span: Span }, now: number): void {
    const r = this.recent.get(place);
    const seen = 1 + (r?.pending ?? 0);
    const key = `${target.owner}\u0000${target.path.join('.')}`;
    let variants = this.byVariable.get(key);
    if (!variants) this.byVariable.set(key, (variants = new Map()));
    const signature = typeSignature(type);
    let entry = variants.get(signature);
    if (entry) {
      entry.evidence.count += seen;
      entry.evidence.lastSeen = now;
      entry.evidence.site = site;
    } else {
      if (variants.size >= this.limits.perVariable) this.evict(variants);
      if (this.count >= this.limits.total) this.evictOldest();
      entry = {
        owner: target.owner,
        signature,
        evidence: {
          source: 'runtime',
          path: target.path,
          shapes: [],
          nullable: type.nullable,
          type,
          site,
          connection: this.connection,
          count: seen,
          lastSeen: now,
        },
      };
      variants.set(signature, entry);
      this.count++;
    }
    if (r) {
      r.entry = entry;
      r.pending = 0;
    }
  }

  /** Every piece of evidence about `member` on `owner`'s scope — the member itself and keys inside it. */
  forMember(owner: string, member: string): TypeEvidence[] {
    const out: TypeEvidence[] = [];
    for (const variants of this.byVariable.values()) {
      for (const e of variants.values()) if (e.owner === owner && e.evidence.path[0] === member) out.push(e.evidence);
    }
    return out;
  }

  clear(): void {
    this.byVariable.clear();
    this.recent.clear();
    this.count = 0;
  }

  private has(entry: Entry): boolean {
    const variants = this.byVariable.get(`${entry.owner}\u0000${entry.evidence.path.join('.')}`);
    return variants?.get(entry.signature) === entry;
  }

  private evict(variants: Map<string, Entry>): void {
    let oldest: Entry | null = null;
    for (const e of variants.values()) if (!oldest || e.evidence.lastSeen! < oldest.evidence.lastSeen!) oldest = e;
    if (oldest) {
      variants.delete(oldest.signature);
      this.count--;
    }
  }

  private evictOldest(): void {
    let oldest: { variants: Map<string, Entry>; entry: Entry } | null = null;
    for (const variants of this.byVariable.values()) {
      for (const e of variants.values()) {
        if (!oldest || e.evidence.lastSeen! < oldest.entry.evidence.lastSeen!) oldest = { variants, entry: e };
      }
    }
    if (oldest) {
      oldest.variants.delete(oldest.entry.signature);
      this.count--;
    }
  }
}
