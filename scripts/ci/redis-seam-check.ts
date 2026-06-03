#!/usr/bin/env -S npx tsx
/**
 * Redis Seam check — ADR-0009 / ADR-0017 closure ratchet.
 *
 * Forbids new imports of the legacy Redis surface (`redis-keys`,
 * `redis-adapter`) and the internal seam primitives (`redis/keys`,
 * `redis/kv`) from anywhere outside `src/redis/` itself.
 *
 * ADR-0017 (Category B) additionally forbids a static `from '.../redis/
 * connection'` import (the raw `getRedisConnection` / `getRedisSubscriber`
 * surface) from anywhere outside `src/redis/*` AND the one sanctioned
 * non-family owner, `src/event-bus.ts` — the Event Bus IS the seam for the
 * stream (`x*`) ops that have no typed-hash accessor shape. The fix-path for a
 * flagged file is to route through B (Event Bus), A (a domain accessor), or C
 * (the shared `boundedJsonList` primitive) — never a linter-appeasing wrapper.
 * Scoped to STATIC `from` imports, consistent with the existing grammar;
 * dynamic `await import(...)` + getRedisConnection() call sites are a
 * documented follow-up, not flagged here.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950): it declares its policy (the forbidden-import
 * predicate, the baseline path, the wording) and the engine owns the git scan,
 * the shrink-only baseline diff, the `--write-baseline` path, and the CLI guard.
 *
 * Usage:
 *   node --no-warnings --experimental-strip-types scripts/ci/redis-seam-check.ts
 *   npm run redis-seam-check
 *
 * Update flow when intentionally migrating a caller:
 *   1. Remove the legacy import.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli } from "./seam-check-lib.ts";

const FORBIDDEN_PATTERNS = [
  /from\s+['"][^'"]*\/redis-keys(?:\.ts)?['"]/,
  /from\s+['"][^'"]*\/redis-adapter(?:\.ts)?['"]/,
  /from\s+['"][^'"]*\/redis\/keys(?:\.ts)?['"]/,
  /from\s+['"][^'"]*\/redis\/kv(?:\.ts)?['"]/,
];

/**
 * ADR-0017: static raw-connection import. Flagged everywhere outside
 * `src/redis/*` AND the sanctioned `src/event-bus.ts` owner (see
 * SANCTIONED_RAW_CONNECTION_OWNERS). Static `from` only — matching the
 * grammar of FORBIDDEN_PATTERNS above.
 */
const RAW_CONNECTION_PATTERN = /from\s+['"][^'"]*\/redis\/connection(?:\.ts)?['"]/;

/** The Redis Seam family prefix. Files inside `src/redis/` ARE the seam (exempt). */
const REDIS_DIR_PREFIX = "src/redis/";

/**
 * Files outside `src/redis/*` that may statically import `redis/connection`.
 * Only the Event Bus — it owns the stream (`x*`) ops that have no typed-hash
 * accessor and so legitimately holds the raw connection (ADR-0017 Category B).
 */
const SANCTIONED_RAW_CONNECTION_OWNERS = new Set<string>(["src/event-bus.ts"]);

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/redis-seam-baseline.json");

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * contain a forbidden seam import? Exported so the regression test can pin the
 * grammar without shelling out to git. `relPath` decides the sanctioned-owner
 * carve-out for the ADR-0017 raw-connection rule, and (issue #950) the
 * `src/redis/*` family carve-out folded in from the old loop-level dir-skip;
 * pass a `src/...` path.
 */
export function fileViolatesSeam(relPath: string, body: string): boolean {
  // The Redis Seam family itself is the seam — never a violation (folds in the
  // old loop-level isInsideRedisDir skip, issue #950).
  if (relPath.startsWith(REDIS_DIR_PREFIX)) return false;
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(body)) return true;
  }
  if (
    !SANCTIONED_RAW_CONNECTION_OWNERS.has(relPath) &&
    RAW_CONNECTION_PATTERN.test(body)
  ) {
    return true;
  }
  return false;
}

const CONFIG = {
  name: "redis-seam-check",
  globs: ["src/*.ts", "src/**/*.ts"],
  predicate: fileViolatesSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix: "ADR-0009 closure ratchet: shrink only.",
  newViolationsHeadline: "NEW Redis-seam violations (ADR-0009):",
  newViolationsHelp: [
    "These files import from redis-keys / redis-adapter / redis/keys / redis/kv.",
    "Move the access behind a typed accessor in src/redis/<domain>.ts.",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
