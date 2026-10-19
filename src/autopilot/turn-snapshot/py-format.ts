/**
 * turn-snapshot/py-format.ts — Python value formatting for the passthrough
 * collectors' `kv` lines (ADR-0043 slice 5, #4933).
 *
 * The strangled heredocs printed JSON-decoded values through f-strings, so the
 * wire carries Python's `str()` / `repr()` of those values (`True`, `None`,
 * `{'a': 1}`, `1e-07`) and its `format(x, '.Nf')` rounding (exact
 * round-half-even: `0.125 → '0.12'`, where JS `toFixed` gives `'0.13'`). The
 * golden files pin that text; this leaf reproduces it in ONE place. Pure, no
 * I/O, never throws. A sibling of py-compat.ts (kept separate so parallel
 * slices never edit the same leaf); slice 6's JSON switch deletes both.
 */

import { pyRepr } from "./py-compat.ts";

/** A JSON object (Python `dict`) — not an array, not null. */
export function isPyDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `len(v)` of a JSON-decoded value, or `null` where Python raises `TypeError`. */
export function pyLen(v: unknown): number | null {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (isPyDict(v)) return Object.keys(v).length;
  return null;
}

/**
 * `repr(x)` of a Python number decoded from JSON. Integral values below 1e21
 * arrive as JSON integers (JS `JSON.stringify` never writes `20.0`), so Python
 * holds them as `int` and prints plain digits; everything else is a float.
 */
export function pyNumberRepr(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  const [mantissa, expText] = Math.abs(n).toExponential().split("e");
  const digits = (mantissa as string).replace(".", "");
  const exp = Number(expText);
  const decpt = exp + 1;
  const sign = n < 0 ? "-" : "";
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const e = Math.abs(exp).toString().padStart(2, "0");
  return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
}

/** `repr(v)` of a JSON-decoded value (the form nested values take inside `str()` of a container). */
export function pyReprValue(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return pyNumberRepr(v);
  if (typeof v === "string") return pyRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyReprValue).join(", ")}]`;
  if (isPyDict(v)) return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyReprValue(x)}`).join(", ")}}`;
  return String(v);
}

/** `str(v)` / f-string `{v}` of a JSON-decoded value. */
export function pyStrValue(v: unknown): string {
  return typeof v === "string" ? v : pyReprValue(v);
}

/**
 * `format(x, f'.{digits}f')` — the exact decimal value of the double, rounded
 * half-to-even (CPython's `float.__format__`). `-0.0` and tiny negatives keep
 * their sign (`'-0.00'`).
 */
export function pyFormatFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const negative = x < 0 || Object.is(x, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let exp: number;
  if (biased === 0) exp = -1074;
  else {
    mant |= 1n << 52n;
    exp = biased - 1075;
  }
  let num = mant * 10n ** BigInt(digits);
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);
  let q = num / den;
  const twiceRem = 2n * (num % den);
  if (twiceRem > den || (twiceRem === den && (q & 1n) === 1n)) q += 1n;
  const s = q.toString().padStart(digits + 1, "0");
  const body = digits > 0 ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s;
  return `${negative ? "-" : ""}${body}`;
}
