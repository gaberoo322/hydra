/**
 * Regression test for issue #3828 — the ## SKILL MIRROR DRIFT block in
 * scripts/hydra-watchdog.sh.
 *
 * Background: `scripts/sync-skills.sh` writes the LIVE, host-shared skill
 * mirror ($HOME/.claude/skills) every subsequent agent dispatch loads its
 * prompts from. sync-skills.sh itself now refuses that default-path write
 * when docs/operator-playbooks/ differs from origin/master (its own
 * default-mirror content guard), but that guard only protects
 * sync-skills.sh's OWN invocations — it does nothing about a mirror that is
 * ALREADY diverged (a hand-edit, a pre-guard write, an operator --force).
 * This watchdog block is the read-only detector: it regenerates every
 * hydra-* skill into a scratch dir from $HYDRA_ROOT's checked-out
 * docs/operator-playbooks/ and diffs the result against the live mirror.
 *
 * Hard invariants pinned here (from the gate-approved design-concept for
 * issue-3828, mirroring the ## DEPLOY DRIFT block's contract for issue #734):
 *
 *   1. Advisory by default — drift logs a WARNING only; it does NOT rewrite
 *      the live mirror unless HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX=1.
 *   2. Grace-windowed — even with auto-fix enabled, drift must persist past
 *      HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_GRACE_SECONDS before it fires.
 *   3. Respects deliberate operator stops — never auto-fixes when the
 *      scheduler reports stopReason="deliberate".
 *   4. Read-only / fail-safe — a missing sync-skills.sh or a failed scratch
 *      regeneration skips with a WARN and the script still exits 0.
 *
 * The genuinely-mutating (non-dry-run) auto-fix branch is intentionally NEVER
 * exercised here — same convention as test/watchdog-deploy-drift.test.mts —
 * so a test run can never write to a real $HOME/.claude/skills.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");
const SYNC_SKILLS = join(REPO_ROOT, "scripts", "sync-skills.sh");

/**
 * A minimal throwaway "orchestrator repo" with exactly the layout
 * sync-skills.sh expects: scripts/sync-skills.sh (the real one, copied) with
 * REPO_ROOT resolved as its parent, and docs/operator-playbooks/<name>.md.
 * No `.git` needed — the watchdog's scratch regeneration always overrides
 * CLAUDE_SKILLS_DIR/CODEX_SKILLS_DIR, which exempts it from sync-skills.sh's
 * git-backed default-mirror content guard entirely.
 */
function makeFixtureRepo(): { dir: string; playbooks: string } {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-fixture-"));
  const scripts = join(dir, "scripts");
  const playbooks = join(dir, "docs", "operator-playbooks");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(playbooks, { recursive: true });
  copyFileSync(SYNC_SKILLS, join(scripts, "sync-skills.sh"));
  writeFileSync(
    join(playbooks, "demo.md"),
    "---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nbody v1\n",
  );
  return { dir, playbooks };
}

/** Run the real sync-skills.sh against a fixture repo into an explicit output dir. */
function regenerateInto(fixtureDir: string, claudeDir: string, codexDir: string): void {
  const r = spawnSync("bash", [join(fixtureDir, "scripts", "sync-skills.sh")], {
    env: {
      ...process.env,
      CLAUDE_SKILLS_DIR: claudeDir,
      CODEX_SKILLS_DIR: codexDir,
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `fixture regeneration failed: ${r.stderr}`);
}

function runWatchdog(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(WATCHDOG, [], {
    // Force the autopilot-wedge block to early-exit so the test doesn't
    // depend on the autopilot service / heartbeat state on the host. The
    // service-liveness block may log whatever it likes; we only assert on
    // the `hydra-skill-mirror-drift-watchdog:` lines.
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE: "1",
      ...env,
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
    timeout: 20_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Extract only the skill-mirror-drift block's log lines for focused assertions. */
function driftLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-skill-mirror-drift-watchdog:"))
    .join("\n");
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-drift-test-"));
}

describe("scripts/hydra-watchdog.sh — ## SKILL MIRROR DRIFT block (issue #3828)", () => {
  test("in sync (live mirror matches a fresh regen from HYDRA_ROOT): logs 'in sync', no drift warning", () => {
    const fixture = makeFixtureRepo();
    const liveDir = mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-live-"));
    const stateDir = makeStateDir();
    try {
      regenerateInto(fixture.dir, liveDir, join(liveDir, "..", "codex-live"));
      const r = runWatchdog({
        HYDRA_ROOT: fixture.dir,
        HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR: liveDir,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: stateDir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /in sync/, `expected 'in sync', got: ${lines}`);
      assert.doesNotMatch(lines, /DRIFT|would-resync|AUTO-FIX/, `must not warn drift, got: ${lines}`);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(liveDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("drift (live mirror stale), auto-fix OFF (default): advisory WARNING only, live mirror untouched", () => {
    const fixture = makeFixtureRepo();
    const liveDir = mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-live-"));
    const stateDir = makeStateDir();
    try {
      // Seed the "live" mirror with STALE content (as if a prior sync ran
      // before the playbook was edited to v1).
      mkdirSync(join(liveDir, "demo"), { recursive: true });
      writeFileSync(join(liveDir, "demo", "SKILL.md"), "stale content from a prior sync\n");
      const staleBefore = readFileSync(join(liveDir, "demo", "SKILL.md"), "utf-8");

      const r = runWatchdog({
        HYDRA_ROOT: fixture.dir,
        HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR: liveDir,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: stateDir,
        // HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX unset -> advisory default
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /WARNING DRIFT/, `expected drift warning, got: ${lines}`);
      assert.match(lines, /demo/, `expected the diverged skill name in the log, got: ${lines}`);
      assert.match(lines, /auto-fix disabled/, `expected advisory-only log, got: ${lines}`);
      assert.doesNotMatch(lines, /would-resync|AUTO-FIX/, `must not fix when disabled, got: ${lines}`);
      assert.equal(
        readFileSync(join(liveDir, "demo", "SKILL.md"), "utf-8"),
        staleBefore,
        "advisory-only run must never rewrite the live mirror",
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(liveDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("drift, auto-fix ON but within grace window: waits, does not fix", () => {
    const fixture = makeFixtureRepo();
    const liveDir = mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-live-"));
    const stateDir = makeStateDir();
    try {
      mkdirSync(join(liveDir, "demo"), { recursive: true });
      writeFileSync(join(liveDir, "demo", "SKILL.md"), "stale content\n");

      const r = runWatchdog({
        HYDRA_ROOT: fixture.dir,
        HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR: liveDir,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: stateDir,
        HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX: "1",
        HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_GRACE_SECONDS: "600",
        HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_DRY_RUN: "1",
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /within grace window/, `expected grace-window log, got: ${lines}`);
      assert.doesNotMatch(lines, /would-resync|AUTO-FIX/, `must wait within grace, got: ${lines}`);
      assert.ok(
        existsSync(join(stateDir, "hydra-watchdog-skill-mirror-drift-since")),
        "expected drift marker file written",
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(liveDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("drift, auto-fix ON, grace elapsed: would-resync (dry-run), live mirror untouched", () => {
    const fixture = makeFixtureRepo();
    const liveDir = mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-live-"));
    const stateDir = makeStateDir();
    try {
      mkdirSync(join(liveDir, "demo"), { recursive: true });
      writeFileSync(join(liveDir, "demo", "SKILL.md"), "stale content\n");
      const staleBefore = readFileSync(join(liveDir, "demo", "SKILL.md"), "utf-8");

      // Pre-seed the marker far in the past so the grace window is already
      // satisfied on this single tick.
      const marker = join(stateDir, "hydra-watchdog-skill-mirror-drift-since");
      writeFileSync(marker, String(Math.floor(Date.now() / 1000) - 5000));

      const r = runWatchdog({
        HYDRA_ROOT: fixture.dir,
        HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR: liveDir,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: stateDir,
        HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX: "1",
        HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_GRACE_SECONDS: "600",
        HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_DRY_RUN: "1",
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      // Deliberate-stop guard reads /api/scheduler/status. On a host where the
      // orchestrator is stopped deliberately the block short-circuits there.
      // Accept either: would-resync (no deliberate stop) OR the deliberate-
      // stop guard line. Both prove grace elapsed + the gate was honored.
      assert.match(
        lines,
        /would-resync|stopped deliberately/,
        `expected would-resync or deliberate-stop guard, got: ${lines}`,
      );
      assert.doesNotMatch(lines, /AUTO-FIX — drift sustained/, `dry-run must not run a real fix, got: ${lines}`);
      assert.equal(
        readFileSync(join(liveDir, "demo", "SKILL.md"), "utf-8"),
        staleBefore,
        "dry-run must never rewrite the live mirror",
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(liveDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("fail-safe: missing sync-skills.sh at HYDRA_ROOT skips with WARN, exits 0", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-noroot-"));
    const stateDir = makeStateDir();
    try {
      const r = runWatchdog({
        HYDRA_ROOT: emptyRoot, // no scripts/sync-skills.sh here
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: stateDir,
      });
      assert.equal(r.status, 0, `expected exit 0 on missing script, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /sync-skills\.sh not found/, `expected fail-safe WARN, got: ${lines}`);
      assert.doesNotMatch(lines, /DRIFT|would-resync|AUTO-FIX/, `must not act on a resolution failure, got: ${lines}`);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("no-drift clears a stale grace marker", () => {
    const fixture = makeFixtureRepo();
    const liveDir = mkdtempSync(join(tmpdir(), "watchdog-skill-mirror-live-"));
    const stateDir = makeStateDir();
    try {
      regenerateInto(fixture.dir, liveDir, join(liveDir, "..", "codex-live"));
      const marker = join(stateDir, "hydra-watchdog-skill-mirror-drift-since");
      writeFileSync(marker, String(Math.floor(Date.now() / 1000) - 9999));
      assert.ok(existsSync(marker), "precondition: marker exists");

      const r = runWatchdog({
        HYDRA_ROOT: fixture.dir,
        HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR: liveDir, // now in sync
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: stateDir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.ok(!existsSync(marker), "expected stale marker cleared once back in sync");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(liveDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
