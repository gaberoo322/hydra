/**
 * turn-snapshot/py-compat.ts — the Python-parity leaf the Turn Snapshot's
 * strangled collectors share while the `kv` wire format is still byte-identical
 * to the bash/python it replaces (ADR-0043 Decision 4).
 *
 * The collectors moved out of `collect-state.sh` embedded inline Python, so
 * their stderr notes quote Python exception text (`Expecting value: line 1
 * column 1 (char 0)`, `could not convert string to float: 'abc'`) and their
 * classifiers lean on Python truthiness and `strptime`. The golden files pin
 * that text, so the reproductions live here — ONE place — instead of being
 * re-derived in every collector. Pure: no I/O, no env, never throws.
 *
 * This leaf is transitional: slice 6 (the JSON switch) deletes the kv wire and
 * with it every reason to mimic Python; delete whatever is then unused.
 */

/** Python truthiness of a JSON-decoded value (`[]`, `{}`, `""`, `0`, `null` are falsy). */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  if (typeof v === "number") return !Number.isNaN(v);
  return true;
}

/** `str(v)` of a JSON-decoded value, for the handful of note formats that interpolate one. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/** `repr(s)` of a Python str (quote selection + the common escapes). */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

const PY_JSON_WS = /^[ \t\n\r]*/;

/**
 * `json.loads(text)` with Python's error text on failure. Returns
 * `{ ok: true, value }` or `{ ok: false, error }` where `error` is the exact
 * `JSONDecodeError` string for the "Expecting value" class (empty input, or a
 * first token that cannot start a JSON value — the shapes a failed or garbled
 * `gh` read produces); any other malformation falls back to the JS parser's
 * message (no golden fixture pins those).
 */
export function pyJsonLoads(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const idx = (PY_JSON_WS.exec(text)?.[0] ?? "").length;
    const rest = text.slice(idx);
    const startsValue =
      /^[{["\-0-9]/.test(rest) || rest.startsWith("null") || rest.startsWith("true") || rest.startsWith("false");
    if (!startsValue) return { ok: false, error: `Expecting value: ${pyLineCol(text, idx)}` };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Python's `JSONDecodeError` position suffix: `line L column C (char N)`. */
function pyLineCol(text: string, pos: number): string {
  const before = text.slice(0, pos);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const col = pos - before.lastIndexOf("\n");
  return `line ${line} column ${col} (char ${pos})`;
}

const PY_FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*\.|inf(?:inity)?|nan)$/i;

/**
 * `float(os.environ.get(name) or fallback)` with the Python failure text.
 * Unset/empty → the fallback silently (the `or` arm); unparsable → the
 * fallback plus `could not convert string to float: '<raw>'`.
 */
export function pyFloatOr(raw: string | undefined, fallback: number): { value: number; error: string | null } {
  if (raw === undefined || raw === "") return { value: fallback, error: null };
  const s = raw.trim();
  if (!PY_FLOAT_RE.test(s)) return { value: fallback, error: `could not convert string to float: ${pyRepr(raw)}` };
  const lower = s.toLowerCase().replace(/^[+]/, "");
  if (/^-?inf(inity)?$/.test(lower)) return { value: lower.startsWith("-") ? -Infinity : Infinity, error: null };
  if (/^[-]?nan$/.test(lower)) return { value: Number.NaN, error: null };
  return { value: Number(s.replace(/_/g, "")), error: null };
}

/**
 * `datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")` as epoch seconds, or `null`
 * when unreadable — the `epoch()` helper every PR-gate window keys on. Mirrors
 * CPython's `_strptime` field regexes (one- or two-digit month/day/time
 * fields) and its calendar validation.
 */
export function pyEpochSeconds(ts: unknown): number | null {
  if (typeof ts !== "string" || ts === "") return null;
  const m = /^(\d{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])T(2[0-3]|[0-1]\d|\d):([0-5]\d|\d):(6[0-1]|[0-5]\d|\d)Z$/.exec(ts);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x.trim()));
  if (y < 1 || s > 59) return null;
  const at = new Date(0);
  at.setUTCFullYear(y, mo - 1, d);
  at.setUTCHours(h, mi, s, 0);
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return at.getTime() / 1000;
}
