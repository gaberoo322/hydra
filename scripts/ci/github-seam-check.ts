#!/usr/bin/env -S npx tsx
/**
 * GitHub-Seam check — GitHub CLI Adapter closure ratchet (issue #899).
 *
 * The **GitHub CLI Adapter** Seam (`src/github/*`, issues #896/#897) owns the
 * `gh`/`git` external-process boundary: one private spawn primitive
 * (`src/github/exec.ts`) concentrates the binary resolution, the timeout
 * discipline, and the four error modes, and the typed accessors
 * `ghExec`/`ghJson`/`gitExec` are its only callers. CONTEXT.md predicted —
 * exactly as ADR-0009 (Redis) and ADR-0011 (Schemas) did before it — that prose
 * discipline alone keeps the Seam from closing. This is the CI backstop that
 * freezes the drift: it forbids a raw `node:child_process` import from any file
 * outside `src/github/`.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950): a pure, unit-testable predicate plus the
 * shared shrink-only baseline. It lands in a SEPARATE workflow
 * (`.github/workflows/github-seam.yml`), NOT as a step in `ci.yml`. `ci.yml` is
 * exact-match Verifier Core (Tier-4); a sibling workflow keeps this PR Tier-3
 * and auto-mergeable, mirroring the `schema-seam.yml` / `coupling-check.yml`
 * precedent.
 *
 * Scope: `src/github/*` is exempt (it IS the seam — `exec.ts` owns the one
 * sanctioned `spawn`). `src/exec-with-timeout.ts` is ALSO exempt: it is a
 * separate process-group-aware primitive for test-runner subprocesses, NOT a
 * `gh`/`git` caller (CONTEXT.md GitHub CLI Adapter entry calls this out
 * explicitly).
 *
 * Usage:
 *   npx tsx scripts/ci/github-seam-check.ts
 *   npm run github-seam-check
 *
 * Update flow when intentionally migrating a caller:
 *   1. Remove the `node:child_process` import; route `gh`/`git` through the seam.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli } from "./seam-check-lib.ts";

/** Any import of `node:child_process` (static `from`, or a `require`/dynamic-import form). */
const CHILD_PROCESS_PATTERNS = [
  /from\s+['"]node:child_process['"]/,
  /from\s+['"]child_process['"]/,
  /require\(\s*['"]node:child_process['"]\s*\)/,
  /require\(\s*['"]child_process['"]\s*\)/,
  /import\(\s*['"]node:child_process['"]\s*\)/,
  /import\(\s*['"]child_process['"]\s*\)/,
];

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/github-seam-baseline.json");

/** The GitHub CLI Adapter family prefix. Files inside `src/github/` ARE the seam (exempt). */
const GITHUB_DIR_PREFIX = "src/github/";

/**
 * Files outside `src/github/*` that may still import `node:child_process`
 * because they spawn a binary OTHER than `gh`/`git` (so they are not part of
 * the GitHub boundary). They are NOT seam violations and so must never be
 * flagged or baselined:
 *   - src/exec-with-timeout.ts — process-group-aware test-runner subprocess
 *     primitive (CONTEXT.md GitHub CLI Adapter entry exempts it explicitly).
 *   - src/autopilot/log.ts     — spawns `journalctl`, not `gh`/`git`.
 *   - src/index.ts             — dynamic execFile import for a non-gh/git use.
 * Since issue #939, `src/api/health.ts`'s host-info probes (`df`/`free`/
 * `systemctl`) moved behind the **Host-Probe Adapter** (`src/host-probe/*`), so
 * `health.ts` no longer imports `node:child_process` and drops off the baseline
 * (which closes to zero). The Host-Probe Adapter family is itself carved out
 * here: it OWNS the host-info `node:child_process` spawn (its own sibling Seam,
 * NOT the gh/git boundary), policed instead by the dedicated
 * `host-probe-seam-check` ratchet. See {@link HOST_PROBE_DIR_PREFIX}.
 */
const NON_GITHUB_SPAWNERS = new Set<string>([
  "src/exec-with-timeout.ts",
  "src/autopilot/log.ts",
  "src/index.ts",
]);

/**
 * The Host-Probe Adapter family prefix. Files under `src/host-probe/` own the
 * host-info external-process boundary (`df`/`free`/`systemctl`) on their own
 * private spawn primitive — a sibling Seam to the GitHub CLI Adapter, NOT a
 * gh/git caller. They are exempt from THIS scan and policed by their own
 * `host-probe-seam-check` ratchet (issue #939). Trailing slash so it matches
 * the family directory, not an incidental `src/host-probe-foo.ts`.
 */
const HOST_PROBE_DIR_PREFIX = "src/host-probe/";

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * import `node:child_process`? Exported so the regression test can pin the
 * grammar without shelling out to git. `relPath` decides the
 * non-GitHub-spawner carve-out, the Host-Probe-family carve-out, and (issue
 * #950) the `src/github/*` family carve-out folded in from the old loop-level
 * dir-skip; pass a `src/...` path.
 */
export function fileViolatesGithubSeam(relPath: string, body: string): boolean {
  // The GitHub CLI Adapter family itself is the seam — never a violation
  // (folds in the old loop-level isInsideGithubDir skip, issue #950).
  if (relPath.startsWith(GITHUB_DIR_PREFIX)) return false;
  if (NON_GITHUB_SPAWNERS.has(relPath)) return false;
  // Issue #939: the Host-Probe Adapter family owns its own host-info spawn —
  // a sibling Seam, not a gh/git caller — so it is carved out of this scan.
  if (relPath.startsWith(HOST_PROBE_DIR_PREFIX)) return false;
  for (const re of CHILD_PROCESS_PATTERNS) {
    if (re.test(body)) return true;
  }
  return false;
}

const CONFIG = {
  name: "github-seam-check",
  globs: ["src/*.ts", "src/**/*.ts"],
  predicate: fileViolatesGithubSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix: "GitHub CLI Adapter closure ratchet (issue #899): shrink only.",
  newViolationsHeadline:
    "NEW GitHub-seam violations (GitHub CLI Adapter, issue #899):",
  newViolationsHelp: [
    "These files import node:child_process directly to shell out to gh/git.",
    "Route the call through the seam: ghExec/ghJson (src/github/gh.ts) or",
    "gitExec (src/github/git.ts), discriminating on the returned GhResult `code`.",
    "For a pre-existing execFileAsync-shaped caller, src/github/exec-file-compat.ts",
    "provides a drop-in default that keeps the deps.execFileAsync test seam.",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
