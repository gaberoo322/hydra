/**
 * Typed expected values for the test/fixtures/turn-snapshot goldens
 * (ADR-0043 slice 6b, #4934).
 *
 * The goldens were recorded against the retired kv wire and still carry its
 * `expected.stdout` / `expected.exports` fields, which the harness tests no
 * longer assert. Their typed values live in a per-directory sidecar,
 * test/fixtures/turn-snapshot-values/<dir>.json, so the 6b contract PR stays
 * under GitHub's 300-file diff cap. Follow-up PRs fold each value into its
 * golden as `expected.values` and strip the kv fields; a golden that already
 * carries `expected.values` wins over the sidecar.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SIDECAR_DIR = resolve(import.meta.dirname, "..", "fixtures", "turn-snapshot-values");
const cache = new Map<string, Record<string, unknown>>();

function sidecar(dir: string): Record<string, unknown> {
  let v = cache.get(dir);
  if (v === undefined) {
    const path = join(SIDECAR_DIR, `${dir}.json`);
    v = existsSync(path) ? ((JSON.parse(readFileSync(path, "utf-8")) as { values: Record<string, unknown> }).values) : {};
    cache.set(dir, v);
  }
  return v;
}

/**
 * `golden` with `expected.values` resolved: its own, else the sidecar entry
 * for `file` in `dir` (`root` for test/fixtures/turn-snapshot itself). Throws
 * when neither exists, so a golden can never be compared against nothing.
 */
export function withGoldenValues<T extends { expected: object }>(dir: string, file: string, golden: T): T {
  const expected = golden.expected as { values?: unknown };
  if (expected.values !== undefined) return golden;
  const v = sidecar(dir)[file];
  if (v === undefined) throw new Error(`turn-snapshot golden ${dir}/${file} has no expected.values and no sidecar entry`);
  return { ...golden, expected: { ...golden.expected, values: v } };
}
