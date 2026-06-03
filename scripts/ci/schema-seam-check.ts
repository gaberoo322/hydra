#!/usr/bin/env -S npx tsx
/**
 * Schema Seam check — ADR-0011 closure ratchet (issue #893).
 *
 * ADR-0011 decided that every HTTP `req.body` read in `src/api/*.ts` validates
 * through a `src/schemas/<domain>.ts` zod `safeParse` and returns the canonical
 * `400 {code:"schema-validation-failed", issues}` envelope on failure. The ADR
 * predicted (at :20-27) that prose discipline alone keeps the Seam from closing
 * — and as of 2026-06-02 the drift was growing (~17 files read `req.body`, only
 * ~10 validate). This is the CI backstop that freezes that drift.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950): a pure, unit-testable predicate plus the
 * shared shrink-only baseline. ONE divergence from the ADR-0011 §3/§5 framing:
 * the gate lands in a SEPARATE workflow (`.github/workflows/schema-seam.yml`),
 * NOT as a step in `ci.yml`. `ci.yml` is exact-match Verifier Core (Tier-4); a
 * sibling workflow keeps this PR Tier-3 and auto-mergeable, mirroring the
 * `coupling-check.yml` precedent. The ADR was amended to record the divergence.
 *
 * Grammar (per-HANDLER, not per-file): split each file into segments at
 * `router.<method>(` boundaries; a segment that reads `req.body` without a
 * `safeParse(req.body...)` in that SAME segment is a violation. A whole-file
 * check would coincidentally pass today but false-negative the instant a
 * per-router drain migrates one handler while a sibling still reads raw. The
 * check targets `req.body` ONLY — `now-page.ts` legitimately `safeParse`s
 * `req.query` and must not be flagged on that account (it also `safeParse`s
 * `req.body` in its POST handlers, so it is clean here).
 *
 * Usage:
 *   npx tsx scripts/ci/schema-seam-check.ts
 *   npm run schema-seam-check
 *
 * Update flow when intentionally migrating a router:
 *   1. Rewire the handler(s) to `safeParse(req.body...)`.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli } from "./seam-check-lib.ts";

/**
 * Splits a handler body into segments at express router-method boundaries.
 * `router.get(` / `router.post(` / `router.put(` / `router.patch(` /
 * `router.delete(` / `router.all(` / `router.use(`, tolerant of whitespace.
 * Global so we can walk every match.
 */
const SEGMENT_BOUNDARY = /router\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(/g;

/** A read of `req.body` anywhere in a segment. */
const READS_BODY = /\breq\s*\.\s*body\b/;

/** A `safeParse(req.body...)` — the sanctioned validation of the body. */
const SAFEPARSE_BODY = /\.\s*safeParse\s*\(\s*req\s*\.\s*body\b/;

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/schema-seam-baseline.json");

/**
 * Pure predicate: does `body` (the contents of an `src/api/*.ts` file) contain
 * a handler segment that reads `req.body` without a `safeParse(req.body...)` in
 * that same segment? Exported so the regression test can pin the grammar
 * without shelling out to git.
 *
 * Per-handler, not per-file: we split at `router.<method>(` boundaries and
 * evaluate each segment independently, so a file where one handler validates
 * and a sibling reads raw is still flagged.
 *
 * This keeps the historic `(body) => boolean` signature (the test pins it); the
 * shared engine standardizes on `predicate(relPath, body)`, so the Adapter
 * passes a `(_relPath, body) => fileViolatesSchemaSeam(body)` wrapper below.
 */
export function fileViolatesSchemaSeam(body: string): boolean {
  const boundaries: number[] = [];
  let match: RegExpExecArray | null;
  SEGMENT_BOUNDARY.lastIndex = 0;
  while ((match = SEGMENT_BOUNDARY.exec(body)) !== null) {
    boundaries.push(match.index);
  }

  // No router-method calls at all: treat the whole file as one segment. A file
  // that reads req.body without a safeParse of it anywhere is a violation.
  if (boundaries.length === 0) {
    return READS_BODY.test(body) && !SAFEPARSE_BODY.test(body);
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : body.length;
    const segment = body.slice(start, end);
    if (READS_BODY.test(segment) && !SAFEPARSE_BODY.test(segment)) {
      return true;
    }
  }
  return false;
}

const CONFIG = {
  name: "schema-seam-check",
  // ADR-0011's Seam covers HTTP handler routers only — scan src/api/*.ts.
  globs: ["src/api/*.ts"],
  predicate: (_relPath: string, body: string) => fileViolatesSchemaSeam(body),
  baselinePath: BASELINE_PATH,
  noteSuffix: "ADR-0011 closure ratchet: shrink only.",
  newViolationsHeadline: "NEW Schema-seam violations (ADR-0011):",
  newViolationsHelp: [
    "These handlers read req.body without a safeParse(req.body...) in the same handler.",
    "Validate the body through a src/schemas/<domain>.ts zod schema and return",
    '400 {code:"schema-validation-failed", issues} on failure (see src/api/holdback.ts).',
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
