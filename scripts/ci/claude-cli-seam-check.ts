#!/usr/bin/env -S npx tsx
/**
 * Claude-CLI-Seam check — Claude CLI Adapter closure ratchet (issue #3703).
 *
 * The **Claude CLI Adapter** Seam (`src/claude-cli/*`) owns the `claude` CLI
 * external-process boundary: one private spawn primitive
 * (`src/claude-cli/exec.ts`) concentrates the promise-wrapping spawn body, the
 * SIGKILL timeout discipline, and the reject/resolve error modes, and the typed
 * `runClaudeCli` accessor plus the `defaultClaudeSpawn` production default are
 * its only exports. It is a SIBLING to the **GitHub CLI Adapter**
 * (`src/github/*`, gh/git), the **Host-Probe Adapter** (`src/host-probe/*`,
 * df/free/systemctl) and the **Journal Adapter** (`src/journal/*`, journalctl) —
 * each process Seam owns its own `node:child_process` import, deliberately not
 * collapsed onto one primitive.
 *
 * Why this ratchet exists
 * -----------------------
 * `github-seam-check` and `host-probe-seam-check` match the `node:child_process`
 * **import**, not the spawned binary. A file that shells out to the `claude` CLI
 * was therefore flagged by BOTH with no correct adapter to migrate to — it is
 * neither a gh/git call nor a host probe — so `advisory-checks` went red on
 * every master commit and the surface stopped carrying signal. The fix was to
 * open a proper Seam rather than baseline the three offenders (which would have
 * laundered a structural gap into an allowlist, and the NEXT claude spawn site
 * would have re-reddened both checks). This ratchet is what keeps the new
 * boundary shut: with the `src/claude-cli/*` carve-out added to the github and
 * host-probe scans, neither can catch a NEW claude spawn that lands outside the
 * family. This one can.
 *
 * Seeded at ZERO, matching the host-probe precedent — a new Seam is never seeded
 * with its own violations.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts`, and it runs as one `if: always()` step in the
 * `advisory-checks.yml` fleet, NOT in `ci.yml`. `ci.yml` is exact-match Verifier
 * Core (Tier-4); a sibling workflow keeps this PR Tier-3 and auto-mergeable.
 *
 * Usage:
 *   npx tsx scripts/ci/claude-cli-seam-check.ts
 *   npm run claude-cli-seam-check
 *
 * Update flow when intentionally migrating a caller behind the adapter:
 *   1. Remove the `node:child_process` import; route the `claude` spawn through
 *      src/claude-cli/exec.ts (`runClaudeCli` / `defaultClaudeSpawn`).
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

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/claude-cli-seam-baseline.json");

/** The Claude CLI Adapter family prefix. Files inside `src/claude-cli/` ARE the seam (exempt). */
const CLAUDE_CLI_DIR_PREFIX = "src/claude-cli/";

/** The GitHub CLI Adapter family prefix — owns the gh/git spawn, a separate Seam. */
const GITHUB_DIR_PREFIX = "src/github/";

/** The Host-Probe Adapter family prefix — owns the df/free/systemctl spawn, a separate Seam. */
const HOST_PROBE_DIR_PREFIX = "src/host-probe/";

/** The Journal Adapter family prefix — owns the journalctl spawn, a separate Seam. */
const JOURNAL_DIR_PREFIX = "src/journal/";

/**
 * Files outside `src/claude-cli/*` whose `node:child_process` import is OWNED by
 * a different exec concern and so is NOT a claude-cli-seam violation:
 *   - src/exec-with-timeout.ts — process-group-aware test-runner subprocess
 *     primitive, spawns the test runner, never the `claude` binary.
 * The three sibling Adapter families are carved out by prefix above. The point
 * of the scanners together: every `node:child_process` import in `src/` is owned
 * by exactly one Seam, or by this single acknowledged exception.
 */
const NON_CLAUDE_CLI_SPAWNERS = new Set<string>([
  "src/exec-with-timeout.ts",
]);

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * import `node:child_process` in violation of the Claude CLI Adapter Seam?
 * Exported so the regression test can pin the grammar without shelling out to
 * git. `relPath` decides the carve-outs; pass a `src/...` path.
 */
export function fileViolatesClaudeCliSeam(relPath: string, body: string): boolean {
  if (relPath.startsWith(CLAUDE_CLI_DIR_PREFIX)) return false;
  if (relPath.startsWith(GITHUB_DIR_PREFIX)) return false;
  if (relPath.startsWith(HOST_PROBE_DIR_PREFIX)) return false;
  if (relPath.startsWith(JOURNAL_DIR_PREFIX)) return false;
  if (NON_CLAUDE_CLI_SPAWNERS.has(relPath)) return false;
  for (const re of CHILD_PROCESS_PATTERNS) {
    if (re.test(body)) return true;
  }
  return false;
}

const CONFIG = {
  name: "claude-cli-seam-check",
  globs: ["src/*.ts", "src/**/*.ts"],
  predicate: fileViolatesClaudeCliSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix: "Claude CLI Adapter closure ratchet (issue #3703): shrink only.",
  newViolationsHeadline:
    "NEW claude-cli-seam violations (Claude CLI Adapter, issue #3703):",
  newViolationsHelp: [
    "These files import node:child_process directly to shell out to the `claude`",
    "CLI outside the Claude CLI Adapter.",
    "Route the call through the seam: runClaudeCli (src/claude-cli/exec.ts), and",
    "default any injectable spawnImpl to defaultClaudeSpawn from the same module.",
    "Do NOT add the file to this baseline — the seam exists so claude spawn sites",
    "have a correct destination instead of an allowlist entry.",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
