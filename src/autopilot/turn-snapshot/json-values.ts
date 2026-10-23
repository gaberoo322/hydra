/**
 * Shared decoded-JSON value helpers for the turn-snapshot classifiers
 * (leaf module: no imports). One definition each, so the classifiers cannot
 * drift apart on how they walk or number-coerce a decoded value.
 */

/** `.[]` — an array's elements or an object's values; `null` for anything else (the walk cannot run). */
export function eachValue(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === "object") return Object.values(v as Record<string, unknown>);
  return null;
}

/**
 * An integer from a decoded JSON value as decimal text, or `null` where the
 * conversion is undefined (non-finite number, non-numeric text, list, ...).
 * Booleans are 0/1, floats truncate, text may carry a sign, spaces and `_`
 * digit groups. Text keeps full precision (BigInt).
 */
export function integerText(x: unknown): string | null {
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return Number.isFinite(x) ? BigInt(Math.trunc(x)).toString() : null;
  if (typeof x === "string") {
    const s = x.trim();
    if (!/^[+-]?\d+(?:_\d+)*$/.test(s)) return null;
    return BigInt(s.replaceAll("_", "")).toString();
  }
  return null;
}

/** {@link integerText} as a JS number (precision beyond 2^53 is lost); `null` where undefined. */
export function toInteger(v: unknown): number | null {
  const text = integerText(v);
  return text === null ? null : Number(text);
}
