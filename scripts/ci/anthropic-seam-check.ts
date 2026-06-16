#!/usr/bin/env -S npx tsx
/**
 * Anthropic-Seam check — Anthropic Request Adapter closure ratchet (issue #1959).
 *
 * The **Anthropic Request Adapter** Seam (`src/anthropic/request.ts`) owns the
 * Anthropic Messages API request boundary: the base URL
 * (`https://api.anthropic.com/v1/messages`), the `anthropic-version` header, the
 * API-key resolution (from `ANTHROPIC_API_KEY`), the `AbortSignal` timeout
 * discipline (the gap the old inline `defaultLlmClient` had), the three
 * external-request error modes (non-2xx, malformed-JSON, network/timeout), and
 * the token-usage + USD cost derivation — all behind one private `fetch`
 * primitive returning a discriminated never-throw `AnthropicResult`. The
 * recommendation engine's `defaultLlmClient` is its only caller and layers the
 * prompt-build + response-parse on top. It is the SIXTH boundary Seam, a SIBLING
 * to the **OpenViking Request Adapter** (`src/knowledge-base/ov-request.ts`) and
 * the **OAuth Usage Adapter** (`src/cost/oauth-usage.ts`) — all over `fetch()`.
 *
 * This is the CI backstop that freezes the drift, exactly as
 * `openviking-seam-check.ts` (issue #954) / `host-probe-seam-check.ts` (#939) /
 * `github-seam-check.ts` (#899) / `redis-seam-check.ts` (ADR-0009) do for their
 * boundaries: it forbids a raw Anthropic `fetch(...)` from any file outside
 * `src/anthropic/request.ts`, enforced via a shrink-only baseline ratchet. With
 * it in place, every Anthropic Messages request in `src/` is owned by the one
 * adapter primitive.
 *
 * An "Anthropic fetch" is detected as a `fetch(...)` whose target text carries
 * an unambiguous Anthropic signal — the Anthropic API host (`api.anthropic.com`)
 * or one of the adapter base-URL identifiers (`ANTHROPIC_MESSAGES_URL`).
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950) and runs as a sequential step in the
 * consolidated `.github/workflows/seam-checks.yml` (issue #1654), NOT inside
 * `ci.yml`: `ci.yml` is exact-match Verifier Core (Tier-4); a sibling workflow
 * keeps this PR Tier-3 and auto-mergeable, mirroring the openviking-seam
 * precedent.
 *
 * It deliberately scans `src/**\/*.ts` only — matching the openviking/host-probe
 * precedent's `src/**\/*.ts`-only scan.
 *
 * Usage:
 *   npx tsx scripts/ci/anthropic-seam-check.ts
 *   npm run anthropic-seam-check
 *
 * Update flow when intentionally migrating a caller behind the adapter:
 *   1. Remove the raw Anthropic `fetch(...)`; route it through
 *      src/anthropic/request.ts (anthropicMessages), discriminating on the
 *      returned AnthropicResult `code`.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli } from "./seam-check-lib.ts";

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/anthropic-seam-baseline.json");

/** The Anthropic Request Adapter Module itself — IS the seam (exempt). */
const ANTHROPIC_REQUEST_MODULE = "src/anthropic/request.ts";

/**
 * Unambiguous "this fetch targets the Anthropic API" signals. A `fetch(` whose
 * line contains any of these is an Anthropic request. Kept narrow on purpose so
 * unrelated `fetch` calls (OpenViking, OAuth-usage, health probes) do NOT trip
 * the ratchet — they are not the Anthropic Messages boundary.
 */
const ANTHROPIC_TARGET_SIGNALS = [
  "api.anthropic.com", // the Anthropic API host
  "ANTHROPIC_MESSAGES_URL", // the adapter base-URL identifier
];

/** Matches a `fetch(` call (whitespace-tolerant). */
const FETCH_CALL = /\bfetch\s*\(/;

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * contain a raw Anthropic `fetch(...)` in violation of the Anthropic Request
 * Adapter Seam? Exported so the regression test can pin the grammar without
 * shelling out to git. `relPath` decides the carve-out; pass a `src/...` path.
 *
 * The adapter Module itself (`src/anthropic/request.ts`) is the Seam (exempt —
 * its `fetch` IS the one owned call). A file violates when it both calls
 * `fetch(` AND carries an Anthropic target signal on the same line.
 */
export function fileViolatesAnthropicSeam(relPath: string, body: string): boolean {
  if (relPath === ANTHROPIC_REQUEST_MODULE) return false;
  for (const line of body.split("\n")) {
    if (!FETCH_CALL.test(line)) continue;
    if (ANTHROPIC_TARGET_SIGNALS.some((sig) => line.includes(sig))) return true;
  }
  return false;
}

const CONFIG = {
  name: "anthropic-seam-check",
  globs: ["src/*.ts", "src/**/*.ts"],
  predicate: fileViolatesAnthropicSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix:
    "Anthropic Request Adapter closure ratchet (issue #1959): shrink only.",
  newViolationsHeadline:
    "NEW anthropic-seam violations (Anthropic Request Adapter, issue #1959):",
  newViolationsHelp: [
    "These files call fetch() against the Anthropic Messages API outside the",
    "Anthropic Request Adapter. Route the request through the seam:",
    "anthropicMessages (src/anthropic/request.ts), discriminating on the",
    "returned AnthropicResult `code` (anthropic-no-api-key / anthropic-non-2xx /",
    "anthropic-malformed-json / anthropic-timeout / anthropic-network-error).",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
