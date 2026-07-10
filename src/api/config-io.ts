/**
 * Config I/O primitives for the env-var routes (issue #3056).
 *
 * Extracted from `src/api/config.ts` so the `.env` parsing contract, the
 * secret-masking policy, and the Bearer-auth guard have a focused, one-home
 * leaf. This leaf grows when the parse/mask/auth semantics change; the route
 * factory in `config.ts` grows when Express request/response wiring changes —
 * two independent axes, two files.
 *
 * Design contract:
 * - **Downward import edge**: `config.ts` imports from this leaf; this leaf
 *   never imports from `config.ts` (same shape as `ov-upload.ts` ← `indexer.ts`).
 * - `parseEnvFile` and `maskValue` are **pure**: no filesystem, no network, no
 *   clock — a `string` in, a value out. Directly unit-testable.
 * - `makeEnvAuthGuard` is a small factory: it takes the resolved `CRON_SECRET`
 *   and returns an Express middleware. The captured secret keeps the guard a
 *   pure function of `(secret, req)` — a test can build a guard with a known
 *   secret and drive the 401 path without mounting the router.
 */
import type { RequestHandler } from "express";

/** One parsed `.env` line: the trimmed key, the unquoted value, and the raw line. */
export interface EnvVar {
  key: string;
  value: string;
  line: string;
}

/**
 * Parse raw `.env` text into `{ key, value, line }` records.
 *
 * Skips blank lines, comment lines (`#…`), and any line without an `=`. The
 * value is everything after the FIRST `=` (so embedded `=` signs in the value
 * are preserved), trimmed, with a single layer of matching surrounding single
 * or double quotes stripped.
 */
export function parseEnvFile(raw: string): EnvVar[] {
  return raw.split("\n").filter(l => l && !l.startsWith("#") && l.includes("=")).map(line => {
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return { key, value, line };
  });
}

/**
 * Mask a secret value for display.
 *
 * Contract: values of length ≤ 6 render as all-bullets (`••••••`); longer
 * values render as the 3-char prefix + bullets + 3-char suffix, with the bullet
 * run capped at 20 so a very long secret does not bloat the response.
 */
export function maskValue(v: string): string {
  if (v.length <= 6) return "••••••";
  return v.slice(0, 3) + "•".repeat(Math.min(v.length - 6, 20)) + v.slice(-3);
}

/**
 * Build an Express middleware that requires `Authorization: Bearer <secret>`.
 *
 * Returns 401 when the configured `secret` is empty (no secret set ⇒ deny) or
 * when the presented Bearer token does not match. Capturing the secret at build
 * time keeps the guard a pure function of `(secret, req)` and makes the 401 path
 * testable without the route factory.
 */
export function makeEnvAuthGuard(secret: string): RequestHandler {
  return function requireEnvAuth(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!secret || token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
