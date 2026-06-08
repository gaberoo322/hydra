#!/usr/bin/env -S npx tsx
/**
 * Query Seam check — ADR-0022 closure ratchet (issue #1040, parent #1033).
 *
 * ADR-0022 §1 decided that an HTTP handler in `src/api/*.ts` never reads
 * `req.query.<field>` directly: every query-string read routes the WHOLE
 * `req.query` through a `src/schemas/<domain>.ts` zod `safeParse`/`parse`
 * (or, for the reflections proxy, `new URLSearchParams(req.query)`), then
 * reads typed fields off the PARSED result. This is the CI backstop that
 * freezes that Seam closed after the per-router migration slices #1035-1039.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950) — a pure, unit-testable predicate plus the
 * shared shrink-only baseline. Exactly like `schema-seam-check.ts`, the gate
 * lands in the SEPARATE `.github/workflows/schema-seam.yml` sibling workflow
 * (as a SECOND job alongside the schema-seam job), NOT as a step in `ci.yml`.
 * `ci.yml` is exact-match Verifier Core (Tier-4, ADR-0015); a sibling workflow
 * keeps this PR Tier-3 and auto-mergeable, mirroring the `coupling-check.yml`
 * precedent and ADR-0022 §4.
 *
 * Grammar (per-HANDLER, not per-file): split each file into segments at
 * `router.<method>(` boundaries; a segment that reads `req.query.<field>` (a
 * NAMED-field access, e.g. `req.query.count`) WITHOUT a `safeParse(req.query`
 * or `.parse(req.query` in that SAME segment is a violation. The predicate
 * keys on the named-field access (ADR-0022 §1), so a segment that passes the
 * whole `req.query` to `safeParse(req.query)` / `parse(req.query)` (the
 * inline-schema and aggregator routes) or to `new URLSearchParams(req.query)`
 * (the reflections whole-query proxy) reads no named field and is clean by
 * construction — and `safeParse(req.query).data?.count` reads `count` off the
 * PARSED result, not off `req.query`, so it never matches either (ADR-0022
 * §1/§4).
 *
 * Usage:
 *   npx tsx scripts/ci/query-seam-check.ts
 *   npm run query-seam-check
 *
 * Update flow when intentionally migrating a router:
 *   1. Rewire the handler(s) to read fields off `safeParse(req.query...)`.
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

/**
 * A NAMED-field read of `req.query` — `req.query.<field>` — anywhere in a
 * segment. This is the access ADR-0022 §1 forbids. A whole-query read
 * (`req.query` followed by `)`, `,`, whitespace, or end) does NOT match, so
 * `safeParse(req.query)` / `URLSearchParams(req.query)` are clean.
 */
const READS_NAMED_QUERY_FIELD = /\breq\s*\.\s*query\s*\.\s*[A-Za-z_$]/;

/**
 * A `safeParse(req.query...)` or `.parse(req.query...)` — the sanctioned
 * whole-query validation forms (ADR-0022 §1/§4). Either satisfies the rule.
 */
const VALIDATES_QUERY = /\.\s*(?:safeParse|parse)\s*\(\s*req\s*\.\s*query\b/;

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/query-seam-baseline.json");

/**
 * Pure predicate: does `body` (the contents of an `src/api/*.ts` file) contain
 * a handler segment that reads `req.query.<field>` (a named-field access)
 * without a `safeParse(req.query...)` / `.parse(req.query...)` in that same
 * segment? Exported so the regression test can pin the grammar without shelling
 * out to git.
 *
 * Per-handler, not per-file: we split at `router.<method>(` boundaries and
 * evaluate each segment independently, so a file where one handler validates
 * the whole query and a sibling reads a raw named field is still flagged.
 *
 * Keeps the `(body) => boolean` signature the test pins; the shared engine
 * standardizes on `predicate(relPath, body)`, so the Adapter passes a
 * `(_relPath, body) => fileViolatesQuerySeam(body)` wrapper below.
 */
export function fileViolatesQuerySeam(body: string): boolean {
  const boundaries: number[] = [];
  let match: RegExpExecArray | null;
  SEGMENT_BOUNDARY.lastIndex = 0;
  while ((match = SEGMENT_BOUNDARY.exec(body)) !== null) {
    boundaries.push(match.index);
  }

  // No router-method calls at all: treat the whole file as one segment. A file
  // that reads a named req.query field without a whole-query validation
  // anywhere is a violation.
  if (boundaries.length === 0) {
    return READS_NAMED_QUERY_FIELD.test(body) && !VALIDATES_QUERY.test(body);
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : body.length;
    const segment = body.slice(start, end);
    if (READS_NAMED_QUERY_FIELD.test(segment) && !VALIDATES_QUERY.test(segment)) {
      return true;
    }
  }
  return false;
}

const CONFIG = {
  name: "query-seam-check",
  // ADR-0022's Seam covers HTTP handler routers only — scan src/api/*.ts.
  globs: ["src/api/*.ts"],
  predicate: (_relPath: string, body: string) => fileViolatesQuerySeam(body),
  baselinePath: BASELINE_PATH,
  noteSuffix: "ADR-0022 closure ratchet: shrink only.",
  newViolationsHeadline: "NEW Query-seam violations (ADR-0022):",
  newViolationsHelp: [
    "These handlers read req.query.<field> without a safeParse(req.query...) in the same handler.",
    "Validate the WHOLE req.query through a src/schemas/<domain>.ts zod schema and read",
    "typed fields off the parsed result (see src/api/metrics.ts countQuerySchema usage).",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
