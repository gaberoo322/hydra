#!/usr/bin/env -S npx tsx
/**
 * OpenViking-Seam check — OpenViking Request Adapter closure ratchet (issue #954).
 *
 * The **OpenViking Request Adapter** Seam (`src/knowledge-base/ov-request.ts`)
 * owns the OpenViking HTTP request boundary: the base-URL resolution (from
 * `OPENVIKING_URL` via `ov-config.ts`), the auth headers, the `AbortSignal`
 * timeout discipline, the four external-request error modes (service-down,
 * non-2xx, malformed-JSON, timeout), and the JSON/text/raw unwrap — all behind
 * one private `fetch` primitive returning a discriminated never-throw
 * `OvResult<T>`. The typed readers (`trackedOvSearch` + the upload/skill helpers
 * + the work-queue dedup + the `/health` probes) are its only callers and layer
 * their own metrics/fallback on top. It is the FOURTH boundary Seam, a SIBLING
 * to the **GitHub CLI Adapter** (`src/github/*`, gh/git) and the **Host-Probe
 * Adapter** (`src/host-probe/*`, df/free/systemctl) — but over `fetch()`, not
 * `node:child_process`. Each boundary Seam owns its own transport primitive
 * (CONTEXT.md, OpenViking Request Adapter).
 *
 * This is the CI backstop that freezes the drift, exactly as
 * `host-probe-seam-check.ts` (issue #939) / `github-seam-check.ts` (issue #899)
 * / `redis-seam-check.ts` (ADR-0009) do for their boundaries: it forbids a raw
 * OpenViking `fetch(...)` from any file outside `src/knowledge-base/ov-request.ts`,
 * enforced via a shrink-only baseline ratchet. With it in place, every
 * OpenViking HTTP request in `src/` is owned by the one adapter primitive.
 *
 * An "OpenViking fetch" is detected as a `fetch(...)` whose target text carries
 * an unambiguous OV signal — an OpenViking API path (`/api/v1/...`) or one of the
 * OV base-URL identifiers (`OPENVIKING_URL`, `OV_URL`, `OV_DEDUP_URL`,
 * `ovBaseUrl(`). This intentionally does NOT flag the two non-OV health probes
 * in `src/api/health.ts` (vikingdb on `localhost:5000`, the generic `probe(url)`
 * helper) — those are not an OpenViking boundary.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950) and lives in its OWN workflow file
 * (`.github/workflows/openviking-seam.yml`), NOT inside `ci.yml`: `ci.yml` is
 * exact-match Verifier Core (Tier-4); a sibling workflow keeps this PR Tier-3
 * and auto-mergeable, mirroring the `host-probe-seam.yml` / `github-seam.yml`
 * precedent.
 *
 * It deliberately scans `src/**\/*.ts` only — the standalone `bin/*.mjs` OV
 * scripts are outside the type-checked orchestrator surface (and carry a stale
 * wrong key default); fixing them is a separate hygiene issue, matching the
 * host-probe precedent's `src/**\/*.ts`-only scan.
 *
 * Usage:
 *   npx tsx scripts/ci/openviking-seam-check.ts
 *   npm run openviking-seam-check
 *
 * Update flow when intentionally migrating a caller behind the adapter:
 *   1. Remove the raw OV `fetch(...)`; route it through the
 *      src/knowledge-base/ov-request.ts accessors (ovPostJson / ovPostForm /
 *      ovHealthGet / ovRequest), discriminating on the returned OvResult `code`.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli } from "./seam-check-lib.ts";

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/openviking-seam-baseline.json");

/** The OpenViking Request Adapter Module itself — IS the seam (exempt). */
const OV_REQUEST_MODULE = "src/knowledge-base/ov-request.ts";

/**
 * Unambiguous "this fetch targets OpenViking" signals. A `fetch(` whose nearby
 * text contains any of these is an OV request. Kept narrow on purpose so the
 * vikingdb / generic health probes (localhost:5000, the `probe(url)` helper) do
 * NOT trip the ratchet — they are not an OpenViking boundary.
 */
const OV_TARGET_SIGNALS = [
  "/api/v1/", // any OpenViking API path
  "OPENVIKING_URL",
  "OV_URL",
  "OV_DEDUP_URL",
  "ovBaseUrl(",
];

/** Matches a `fetch(` call (whitespace-tolerant). */
const FETCH_CALL = /\bfetch\s*\(/;

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * contain a raw OpenViking `fetch(...)` in violation of the OpenViking Request
 * Adapter Seam? Exported so the regression test can pin the grammar without
 * shelling out to git. `relPath` decides the carve-out; pass a `src/...` path.
 *
 * The adapter Module itself (`src/knowledge-base/ov-request.ts`) is the Seam
 * (exempt — its `fetch` IS the one owned call). A file violates when it both
 * calls `fetch(` AND carries an OV target signal on the same line.
 */
export function fileViolatesOpenVikingSeam(relPath: string, body: string): boolean {
  if (relPath === OV_REQUEST_MODULE) return false;
  for (const line of body.split("\n")) {
    if (!FETCH_CALL.test(line)) continue;
    if (OV_TARGET_SIGNALS.some((sig) => line.includes(sig))) return true;
  }
  return false;
}

const CONFIG = {
  name: "openviking-seam-check",
  globs: ["src/*.ts", "src/**/*.ts"],
  predicate: fileViolatesOpenVikingSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix:
    "OpenViking Request Adapter closure ratchet (issue #954): shrink only.",
  newViolationsHeadline:
    "NEW openviking-seam violations (OpenViking Request Adapter, issue #954):",
  newViolationsHelp: [
    "These files call fetch() against an OpenViking endpoint outside the",
    "OpenViking Request Adapter. Route the request through the seam:",
    "ovPostJson / ovPostForm / ovHealthGet / ovRequest",
    "(src/knowledge-base/ov-request.ts), discriminating on the returned",
    "OvResult `code` (ov-service-down / ov-non-2xx / ov-malformed-json / ov-timeout).",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
