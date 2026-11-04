/**
 * watchdog/skill-mirror.ts — the SKILL MIRROR DRIFT check (issue #5098, epic
 * #5094, slice 4/5; ADR-0040 Decision 2 shape). Ported from
 * `run_skill_mirror_drift` in scripts/hydra-watchdog.sh (#3828).
 *
 * Regenerates every skill with scripts/sync-skills.sh into a fresh scratch
 * CLAUDE_SKILLS_DIR (a read of $HYDRA_ROOT's checked-out playbooks) and
 * compares each `<name>/SKILL.md` byte-for-byte against the live mirror. A
 * missing live file reports as `<name>(missing-live)`. Advisory by default; the
 * opt-in auto-resync (HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX=1) uses the shared
 * grace/deliberate-stop gate and clears its marker BEFORE running.
 */

import {
  decideAutoAction,
  driftAgeSeconds,
  parseMarkerSeconds,
  type DriftMarkerPort,
  type SchedulerStopPort,
} from "./drift-gate.ts";

export const SKILL_MIRROR_LOG_PREFIX = "hydra-skill-mirror-drift-watchdog:";

/** Wrapper bound: covers two sync-skills.sh runs on the opt-in path (INV-14, >= 300s). */
export const SKILL_MIRROR_TIMEOUT_S = 300;

/** Marker file name under HYDRA_WATCHDOG_DRIFT_STATE_DIR (default /tmp). */
export const SKILL_MIRROR_MARKER_NAME = "hydra-watchdog-skill-mirror-drift-since";

export const DEFAULT_SKILL_MIRROR_GRACE_S = 600;

export interface SkillMirrorConfig {
  root: string;
  liveDir: string;
  autoFix: boolean;
  graceS: number;
}

/** Outcome of a sync-skills.sh run: `ran:false` = could not be spawned/timed out. */
export type SyncRun = { ran: false } | { ran: true; exitCode: number; stderrTail: string };

export interface SkillMirrorDeps {
  files: {
    syncScriptExists(root: string): boolean;
    /** A fresh scratch dir, or `null` when one cannot be created. */
    makeScratch(): string | null;
    /** Remove the scratch dir (called on every path). */
    removeScratch(dir: string): void;
    /** Sorted subdirectory names of the regenerated skills dir (empty when it does not exist). */
    listSkills(dir: string): string[];
    /** Exact bytes (latin1 string) of `<dir>/<name>/SKILL.md`, or `null` when absent. */
    readSkill(dir: string, name: string): string | null;
  };
  host: {
    /** Regenerate every skill into `skillsDir` (CLAUDE_SKILLS_DIR override). */
    regenerate(root: string, skillsDir: string): Promise<SyncRun>;
    /** Re-run against the DEFAULT live mirror — the one caller allowed to reconcile it. */
    resync(root: string): Promise<SyncRun>;
  };
  marker: DriftMarkerPort;
  scheduler: SchedulerStopPort;
  clock: { nowMs(): number };
  log: (line: string) => void;
}

/** Pure: which regenerated skills differ from the live mirror (`name` or `name(missing-live)`). */
export function diffSkillMirror(
  names: readonly string[],
  scratch: (name: string) => string | null,
  live: (name: string) => string | null,
): string[] {
  const diverged: string[] = [];
  for (const name of names) {
    const fresh = scratch(name);
    if (fresh === null) continue;
    const current = live(name);
    if (current === null) diverged.push(`${name}(missing-live)`);
    else if (current !== fresh) diverged.push(name);
  }
  return diverged;
}

/** One watchdog tick of the skill-mirror check. Never throws. */
export async function runSkillMirror(deps: SkillMirrorDeps, config: SkillMirrorConfig): Promise<void> {
  const say = (line: string): void => deps.log(`${SKILL_MIRROR_LOG_PREFIX} ${line}`);
  let scratch: string | null = null;
  try {
    if (!deps.files.syncScriptExists(config.root)) {
      say(`WARN sync-skills.sh not found at ${config.root}; skipping skill-mirror drift check`);
      return;
    }
    scratch = deps.files.makeScratch();
    if (scratch === null) {
      say("WARN could not create a scratch dir; skipping skill-mirror drift check");
      return;
    }
    const scratchClaude = `${scratch}/claude`;
    const regen = await deps.host.regenerate(config.root, scratchClaude);
    if (!regen.ran || regen.exitCode !== 0) {
      const detail = regen.ran ? `exit ${regen.exitCode}): ${regen.stderrTail}` : "could not run): ";
      say(`WARN scratch regeneration of ${config.root}'s skills failed (${detail}; skipping skill-mirror drift check`);
      return;
    }

    const diverged = diffSkillMirror(
      deps.files.listSkills(scratchClaude),
      (name) => deps.files.readSkill(scratchClaude, name),
      (name) => deps.files.readSkill(config.liveDir, name),
    );
    // Free the scratch before any opt-in action runs.
    deps.files.removeScratch(scratch);
    scratch = null;

    if (diverged.length === 0) {
      deps.marker.clear();
      say(`in sync (live mirror matches ${config.root}'s checked-out docs/operator-playbooks/)`);
      return;
    }

    const nowS = Math.floor(deps.clock.nowMs() / 1000);
    const raw = deps.marker.read();
    const firstSeenS = parseMarkerSeconds(raw, nowS);
    if (raw === null) deps.marker.write(nowS);
    const driftAgeS = driftAgeSeconds(firstSeenS, nowS);
    say(
      `WARNING DRIFT — ${diverged.length} skill(s) diverge from ${config.root}: ${diverged.join(" ")} (drift first seen ${driftAgeS}s ago). The live mirror may carry unmerged/uncommitted playbook content — regenerate from a throwaway origin/master worktree to converge.`,
    );

    const preGate = decideAutoAction({ enabled: config.autoFix, driftAgeS, graceS: config.graceS, stopReason: null });
    if (preGate === "advisory") {
      say("auto-fix disabled (HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX != 1); advisory only — run scripts/sync-skills.sh to converge");
      return;
    }
    if (preGate === "within-grace") {
      say(`auto-fix armed but within grace window (drift ${driftAgeS}s < ${config.graceS}s); waiting for next tick`);
      return;
    }
    const verdict = decideAutoAction({
      enabled: config.autoFix,
      driftAgeS,
      graceS: config.graceS,
      stopReason: await deps.scheduler.stopReason(),
    });
    if (verdict === "deliberate-stop") {
      say("drift sustained but scheduler stopped deliberately (stopReason=deliberate); NOT auto-fixing — operator paused the system on purpose");
      return;
    }

    say(`AUTO-FIX — drift sustained ${driftAgeS}s >= grace ${config.graceS}s; running scripts/sync-skills.sh to converge the live mirror to ${config.root}`);
    deps.marker.clear();
    const fix = await deps.host.resync(config.root);
    if (fix.ran && fix.exitCode === 0) say("auto-fix completed");
    else say("WARN auto-fix (scripts/sync-skills.sh) returned non-zero; operator intervention may be needed");
  } catch (err) {
    say(`WARN skill-mirror tick failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (scratch !== null) {
      try {
        deps.files.removeScratch(scratch);
      } catch (err) {
        say(`WARN could not remove scratch dir ${scratch}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
