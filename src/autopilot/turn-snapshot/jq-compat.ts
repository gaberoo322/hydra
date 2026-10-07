/**
 * turn-snapshot/jq-compat.ts — the jq-parity leaf for the collectors whose
 * bash filtered `gh` output through `--jq` (ADR-0043 slice 5B, #4933).
 *
 * The strangled collectors passed jq programs to `gh … --jq`; a jq runtime
 * error made `gh` exit non-zero with empty stdout, which the bash read as a
 * FAILED read. The TS collectors now fetch the raw `--json` payload and fold
 * it in TS, so the handful of jq semantics those programs leaned on live here
 * — iteration over arrays AND objects, `.field` on null, `length`, truthiness,
 * equality, the cross-type `sort`/comparison order, and value-to-text output —
 * in ONE place. Anything jq would have raised on throws {@link JqError}; each
 * fold catches it at its boundary and reports the read as failed (exactly the
 * empty-stdout arm the bash saw). Pure, no I/O. Transitional like py-compat.ts:
 * slice 6's JSON wire is the point at which the folds can stop mimicking jq.
 */

/** A jq runtime error (`Cannot iterate over null`, `Cannot index number with "x"`, …). */
export class JqError extends Error {
  readonly code = "jq-runtime-error";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `.[]` — an array's items or an object's values; anything else raises. */
export function jqIter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.values(v);
  throw new JqError(`Cannot iterate over ${jqType(v)}`);
}

/** Whether `.[]?` would yield anything rather than be suppressed. */
export function jqIterable(v: unknown): boolean {
  return Array.isArray(v) || isObject(v);
}

/** `.key` — null on null or a missing key; raises on any non-object. */
export function jqField(v: unknown, key: string): unknown {
  if (v === null || v === undefined) return null;
  if (isObject(v)) return Object.prototype.hasOwnProperty.call(v, key) ? v[key] : null;
  throw new JqError(`Cannot index ${jqType(v)} with "${key}"`);
}

/** `length` — null 0, number |n|, string code points, array/object size; booleans raise. */
export function jqLength(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Math.abs(v);
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (isObject(v)) return Object.keys(v).length;
  throw new JqError(`${jqType(v)} has no length`);
}

/** jq truthiness: everything except `null` and `false`. */
export function jqTruthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

function jqType(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "boolean") return "boolean";
  return typeof v === "object" ? "object" : typeof v;
}

const RANK: Record<string, number> = { null: 0, false: 1, true: 2, number: 3, string: 4, array: 5, object: 6 };
const rank = (v: unknown): number => (typeof v === "boolean" ? RANK[String(v)] : RANK[jqType(v)]) as number;

/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
export function jqCompare(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") {
    // jq orders strings by their UTF-8 bytes == code point order.
    const ca = Array.from(a, (c) => c.codePointAt(0) as number);
    const cb = Array.from(b, (c) => c.codePointAt(0) as number);
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) if (ca[i] !== cb[i]) return (ca[i] as number) - (cb[i] as number);
    return ca.length - cb.length;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = jqCompare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (isObject(a) && isObject(b)) {
    const c = jqCompare(Object.keys(a).sort(), Object.keys(b).sort());
    if (c !== 0) return c;
    for (const k of Object.keys(a).sort()) {
      const d = jqCompare(a[k], b[k]);
      if (d !== 0) return d;
    }
  }
  return 0;
}

export const jqEquals = (a: unknown, b: unknown): boolean => jqCompare(a, b) === 0;

/** `sort` (stable, jq order). */
export function jqSort(xs: readonly unknown[]): unknown[] {
  return [...xs].sort(jqCompare);
}

/** How `gh --jq` prints a value / how `"\(x)"` interpolates it: strings raw, everything else as compact JSON. */
export function jqText(v: unknown): string {
  if (v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "1.7976931348623157e+308" : "-1.7976931348623157e+308";
  return JSON.stringify(v);
}
