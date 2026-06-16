#!/usr/bin/env -S npx tsx
/**
 * Journal-Seam check — Journal Adapter closure ratchet (issue #1958).
 *
 * The **Journal Adapter** Seam (`src/journal/*`) owns the `journalctl`
 * external-process boundary: the binary behind one private spawn primitive
 * (`src/journal/exec.ts`) that concentrates the binary resolution (the
 * `HYDRA_AUTOPILOT_JOURNAL_CMD` override), the `setTimeout` + `SIGTERM` timeout
 * discipline, the 1 MB output cap with backpressure-SIGTERM, and the spawn error
 * modes; the typed accessor (`src/journal/read.ts` — `readJournalSlice`) is its
 * only caller. It is the FOURTH process Seam, sibling to the **GitHub CLI
 * Adapter** (`src/github/*`, gh/git) and the **Host-Probe Adapter**
 * (`src/host-probe/*`, df/free/systemctl) — each process Seam owns its own
 * `node:child_process` import, deliberately not collapsed onto one primitive.
 *
 * Why a journalctl-targeted scanner (vs. another raw child_process scan)?
 * Before this seam, `src/autopilot/log.ts`'s inline `journalctl` spawn was the
 * one remaining open process boundary in `src/` — carved out as an acknowledged
 * exception in BOTH `github-seam-check.ts` and `host-probe-seam-check.ts`. Those
 * two scanners forbid a *generic* `node:child_process` import outside their
 * families, so with the journal spawn behind `src/journal/*` (and that family
 * carved out of both) a NEW `journalctl` caller that did its own spawn would be
 * caught by them only if it imported child_process directly. This ratchet pins
 * the journalctl boundary closed specifically: it forbids the `journalctl`
 * binary token appearing alongside a process-spawn outside the family — the same
 * targeted closure mechanic `openviking-seam-check.ts` (#954) uses for the OV
 * `fetch()` boundary. With it in place, every `journalctl` spawn in `src/` is
 * owned by exactly one Seam.
 *
 * This is a thin Adapter over the shared baseline-ratchet engine in
 * `seam-check-lib.ts` (issue #950) and runs as a step in the consolidated
 * `.github/workflows/seam-checks.yml`, NOT inside `ci.yml`: `ci.yml` is
 * exact-match Verifier Core (Tier-4); a sibling workflow keeps this PR Tier-3
 * and auto-mergeable, mirroring the host-probe / github / openviking precedent.
 *
 * Usage:
 *   npx tsx scripts/ci/journal-seam-check.ts
 *   npm run journal-seam-check
 *
 * Update flow when intentionally migrating a caller behind the adapter:
 *   1. Remove the inline `journalctl` spawn; route it through the seam:
 *      readJournalSlice (src/journal/read.ts), discriminating on the returned
 *      JournalResult `code`.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { join } from "node:path";
import { REPO_ROOT, isCliEntrypoint, runAsCli } from "./seam-check-lib.ts";

const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/journal-seam-baseline.json");

/** The Journal Adapter family prefix. Files inside `src/journal/` ARE the seam (exempt). */
const JOURNAL_DIR_PREFIX = "src/journal/";

/**
 * Sibling process-Seam family prefixes. The **GitHub CLI Adapter**
 * (`src/github/*`) and the **Host-Probe Adapter** (`src/host-probe/*`) each own
 * their OWN `node:child_process` import and may name `journalctl` in their
 * doc-prose (e.g. `exec-file-compat.ts` lists it as an example of a non-gh
 * binary). They spawn gh/git and df/free/systemctl respectively, never the
 * journal — they are NOT journal-seam violations and are policed by their own
 * ratchets. Carved out here exactly as `github-seam-check.ts` carves out the
 * Host-Probe family. Trailing slashes match the family directories.
 */
const SIBLING_SEAM_PREFIXES = ["src/github/", "src/host-probe/"];

/** The `journalctl` binary token — the unambiguous "this targets the journal boundary" signal. */
const JOURNALCTL_TOKEN = /\bjournalctl\b/;

/**
 * Any import of `node:child_process` (static `from`, or a `require`/dynamic-import
 * form) — the spawn capability a journalctl caller would need.
 */
const CHILD_PROCESS_PATTERNS = [
  /from\s+['"]node:child_process['"]/,
  /from\s+['"]child_process['"]/,
  /require\(\s*['"]node:child_process['"]\s*\)/,
  /require\(\s*['"]child_process['"]\s*\)/,
  /import\(\s*['"]node:child_process['"]\s*\)/,
  /import\(\s*['"]child_process['"]\s*\)/,
];

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * spawn `journalctl` outside the Journal Adapter Seam? Exported so the
 * regression test can pin the grammar without shelling out to git. `relPath`
 * decides the carve-out; pass a `src/...` path.
 *
 * A file violates when it BOTH names the `journalctl` binary AND imports
 * `node:child_process` — the shape of an inline journal spawn. The Journal
 * Adapter family itself is exempt (it IS the seam — `exec.ts` owns the one
 * sanctioned spawn). Naming `journalctl` in prose/comments alone (without a
 * child_process import) is not a violation, so a doc reference does not trip the
 * gate.
 */
export function fileViolatesJournalSeam(relPath: string, body: string): boolean {
  if (relPath.startsWith(JOURNAL_DIR_PREFIX)) return false;
  if (SIBLING_SEAM_PREFIXES.some((p) => relPath.startsWith(p))) return false;
  if (!JOURNALCTL_TOKEN.test(body)) return false;
  return CHILD_PROCESS_PATTERNS.some((re) => re.test(body));
}

const CONFIG = {
  name: "journal-seam-check",
  globs: ["src/*.ts", "src/**/*.ts"],
  predicate: fileViolatesJournalSeam,
  baselinePath: BASELINE_PATH,
  noteSuffix: "Journal Adapter closure ratchet (issue #1958): shrink only.",
  newViolationsHeadline:
    "NEW journal-seam violations (Journal Adapter, issue #1958):",
  newViolationsHelp: [
    "These files spawn journalctl directly (a node:child_process import plus a",
    "journalctl binary reference) outside the Journal Adapter.",
    "Route the call through the seam: readJournalSlice (src/journal/read.ts),",
    "discriminating on the returned JournalResult `code`.",
  ],
};

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (isCliEntrypoint(import.meta.url)) {
  runAsCli(CONFIG);
}
