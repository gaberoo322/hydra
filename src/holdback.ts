/**
 * Tier-2 outcome-holdback watcher + auto-revert (issue #244, ADR-0004 work-order step 4).
 *
 * When Hydra merges a Tier-2 self-modification (per `tier-classifier.ts`),
 * a baseline snapshot of every **leading** Target Outcome is captured. Each
 * subsequent cycle, the watcher compares current outcome values to baseline.
 * Any leading outcome that has regressed unfavorably beyond `noise_epsilon`
 * AND sustained the regression for ≥2 readings triggers an **auto-revert**:
 * `git revert <commitSha>` on the orchestrator's master, pushed via the
 * existing merge lock.
 *
 * After 5 cycles clean (no regression) the holdback is marked `passed` and
 * removed from the active set. This is the mechanism by which Hydra learns
 * from outcomes about its own changes — the alternative is the operator
 * being the only feedback signal on every self-modification, which the
 * ADR-0004 vision rejects.
 *
 * Per CLAUDE.md conventions:
 *   - Never throws. All error paths log `[holdback]` and return.
 *   - Inline Redis access via `getRedisConnection()` — `redis-adapter.ts`
 *     is Tier 0 (frozen), so we follow the stuckness/digest pattern.
 *   - Kill-switch first: `hydra:tier2:disabled` short-circuits BOTH the
 *     snapshot and the eval path before any other work. Step 5 of the
 *     ADR-0004 work order layers a UI/CLI on top — this flag check makes
 *     that step purely additive.
 *
 * The watcher only considers **leading** outcomes; terminal outcomes are
 * declared in `outcomes.yaml` but excluded here because a 5-cycle window
 * is too short for them per ADR-0004 vision.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { loadOutcomes, getOutcomeValue, type Outcome } from "./outcomes.ts";
import { getRedisConnection } from "./redis-adapter.ts";
import { STREAMS } from "./event-bus.ts";
import { classifyChange } from "./tier-classifier.ts";
// Tier-0 gate facade (ADR-0001 #249 / #267) — merge-lock and rollback paths
// must route through gate.ts so they remain Tier-0 protected. holdback.ts is
// itself Tier 0, but using the gate facade keeps the call surface for revert
// behaviour consistent with post-merge rollback.
import {
  gateAcquireMergeLock,
  gateReleaseMergeLock,
} from "./gate.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum cycles to watch a holdback before declaring it passed. */
export const HOLDBACK_WINDOW_CYCLES = 5;

/**
 * Number of consecutive cycle readings a regression must persist for before
 * triggering revert. Reuses the stuckness "sustained" semantics from #242 —
 * a single noisy reading does not flip a holdback.
 */
export const SUSTAINED_REGRESSION_CYCLES = 2;

/** Per-day cap on auto-reverts. Runaway revert loops are far more expensive
 *  than missing a single regression revert — see issue #244 implementation
 *  notes. Excess events emit `holdback.cap-reached` for digest visibility. */
export const MAX_REVERTS_PER_DAY = 3;

/** Redis TTL for holdback records: 14 days. Long enough that operators can
 *  inspect recent reverts; short enough not to bloat Redis. */
const HOLDBACK_RECORD_TTL_S = 60 * 60 * 24 * 14;

/** Kill-switch flag (work-order step 5 layers UI on top — this is read-only). */
const KILL_FLAG_KEY = "hydra:tier2:disabled";

/** Orchestrator repo root — where `git revert` runs. Tier-2 self-mods modify
 *  this repo, not the target project. */
const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "", "hydra");

// ---------------------------------------------------------------------------
// Redis key generators (kept inline per the stuckness.ts precedent — see
// CLAUDE.md note about redis-adapter.ts being frozen Tier 0).
// ---------------------------------------------------------------------------

function holdbackKey(commitSha: string): string {
  return `hydra:holdback:${commitSha}`;
}
function activeSetKey(): string {
  return "hydra:holdback:active";
}
function recentListKey(): string {
  return "hydra:holdback:recent";
}
function revertsPerDayKey(date: string): string {
  return `hydra:holdback:reverts:${date}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HoldbackStatus = "watching" | "passed" | "reverted" | "cap-reached";

export interface HoldbackRecord {
  commitSha: string;
  prNumber: number | null;
  mergedAt: string;
  cyclesElapsed: number;
  status: HoldbackStatus;
  /** Snapshot of leading-outcome values at merge time, keyed by outcome name. */
  baseline: Record<string, number>;
  /** Most recent observed values, refreshed per cycle. */
  current: Record<string, number>;
  /** Per-outcome count of sustained-unfavorable readings since baseline. */
  regressionCounts: Record<string, number>;
  /** Reason text when status becomes `reverted` or `cap-reached`. */
  reason?: string;
  /** Outcome names that drove a revert (when status === `reverted`). */
  regressedOutcomes?: string[];
  /** When status moved to a terminal value (`passed`/`reverted`/`cap-reached`). */
  completedAt?: string;
}

export interface SnapshotResult {
  snapshotted: boolean;
  /** Reason snapshotted was skipped (only present when snapshotted === false). */
  reason?: string;
  record?: HoldbackRecord;
}

export interface EvaluateResult {
  evaluated: number;
  reverted: string[];
  passed: string[];
  capReached: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without Redis)
// ---------------------------------------------------------------------------

/**
 * Decide whether a single outcome reading regressed against its baseline.
 * Regression = moved against the declared `direction` by more than
 * `noise_epsilon`. Treats missing/non-finite reads as no-data (returns false)
 * so adapter outages can never trigger a revert.
 */
export function isOutcomeRegression(
  outcome: Pick<Outcome, "direction" | "noise_epsilon">,
  baseline: number,
  current: number | null | undefined,
): boolean {
  if (current === null || current === undefined) return false;
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return false;
  const eps = Number.isFinite(outcome.noise_epsilon) ? Math.abs(outcome.noise_epsilon) : 0;
  const delta = current - baseline;
  if (Math.abs(delta) <= eps) return false;
  // For `up` outcomes, regression = went down. For `down`, regression = went up.
  if (outcome.direction === "up") return delta < 0;
  return delta > 0;
}

/**
 * Decide whether a holdback record should trigger a revert. Pure on the
 * record + outcome metadata so unit tests don't need Redis or git.
 *
 * Trigger condition: at least one leading outcome's regressionCounts entry
 * has reached SUSTAINED_REGRESSION_CYCLES.
 */
export function shouldRevert(
  record: HoldbackRecord,
  leadingOutcomes: Outcome[],
): { revert: boolean; outcomes: string[] } {
  const triggered: string[] = [];
  for (const o of leadingOutcomes) {
    const count = record.regressionCounts[o.name] || 0;
    if (count >= SUSTAINED_REGRESSION_CYCLES) {
      triggered.push(o.name);
    }
  }
  return { revert: triggered.length > 0, outcomes: triggered };
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * Returns true when the Tier-2 watcher should be paused. Both
 * `snapshotForHoldback` and `evaluateAllHoldbacks` short-circuit on true.
 *
 * Step 5 of the ADR-0004 work order layers a UI on this flag; making the
 * read here defensive ensures that step is purely additive.
 */
export async function isTier2Disabled(): Promise<boolean> {
  try {
    const r = getRedisConnection();
    const v = await r.get(KILL_FLAG_KEY);
    return v === "1" || v === "true";
  } catch (err: any) {
    /* intentional: if Redis is unreachable we err on the side of "watcher off"
       — the alternative (assuming enabled while we can't read state) risks
       reverting commits based on stale data. */
    console.error(`[holdback] kill-flag read failed (treating as disabled): ${err?.message || String(err)}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Snapshot — called from runPostMerge after a successful merge
// ---------------------------------------------------------------------------

/**
 * If `filesChanged` classifies as Tier 2 (per #243), capture a baseline of
 * every **leading** outcome's current value and record it in Redis. Returns
 * the record on success; `{ snapshotted: false, reason }` otherwise.
 *
 * Reasons we skip:
 *   - Kill flag set (`hydra:tier2:disabled`)
 *   - Files don't classify as Tier 2
 *   - No leading outcomes declared (nothing to watch)
 *   - Outcome polling returned null for every leading outcome (no signal)
 *
 * Never throws.
 */
export async function snapshotForHoldback(
  commitSha: string,
  prNumber: number | null,
  filesChanged: string[],
): Promise<SnapshotResult> {
  try {
    if (!commitSha || typeof commitSha !== "string") {
      return { snapshotted: false, reason: "invalid commitSha" };
    }

    if (await isTier2Disabled()) {
      return { snapshotted: false, reason: "tier2 disabled by kill flag" };
    }

    const tier = classifyChange(filesChanged || []);
    if (tier.tier !== 2) {
      return { snapshotted: false, reason: `tier=${tier.tier} (not tier 2)` };
    }

    const loaded = await loadOutcomes();
    if (loaded.ok === false) {
      console.error(`[holdback] snapshot: loadOutcomes failed: ${loaded.errors.join("; ")}`);
      return { snapshotted: false, reason: "outcomes load failed" };
    }
    const leading = loaded.outcomes.filter((o) => o.kind === "leading");
    if (leading.length === 0) {
      return { snapshotted: false, reason: "no leading outcomes declared" };
    }

    const baseline: Record<string, number> = {};
    for (const o of leading) {
      let reading: { value: number; ts: string } | null = null;
      try {
        reading = await getOutcomeValue(o);
      } catch (err: any) {
        console.error(`[holdback] snapshot: getOutcomeValue('${o.name}') threw: ${err?.message || String(err)}`);
      }
      if (reading && Number.isFinite(reading.value)) {
        baseline[o.name] = reading.value;
      }
    }

    if (Object.keys(baseline).length === 0) {
      // No outcome adapter returned data — recording a holdback with zero
      // baseline values would mean every future regression is unknowable.
      // Treat this as "no signal" and skip.
      return { snapshotted: false, reason: "all leading outcome adapters returned no data" };
    }

    const record: HoldbackRecord = {
      commitSha,
      prNumber,
      mergedAt: new Date().toISOString(),
      cyclesElapsed: 0,
      status: "watching",
      baseline,
      current: { ...baseline },
      regressionCounts: {},
    };

    const r = getRedisConnection();
    try {
      await r.set(holdbackKey(commitSha), JSON.stringify(record), "EX", HOLDBACK_RECORD_TTL_S);
      await r.zadd(activeSetKey(), Date.now(), commitSha);
    } catch (err: any) {
      console.error(`[holdback] snapshot: redis write failed for ${commitSha}: ${err?.message || String(err)}`);
      return { snapshotted: false, reason: "redis write failed" };
    }

    console.log(`[holdback] snapshot recorded for ${commitSha.slice(0, 7)} (pr #${prNumber ?? "?"}): ${Object.keys(baseline).length} leading outcome(s) tracked`);
    return { snapshotted: true, record };
  } catch (err: any) {
    console.error(`[holdback] snapshot top-level error: ${err?.message || String(err)}`);
    return { snapshotted: false, reason: `unexpected error: ${err?.message || String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Evaluate — called once per cycle after groundProject
// ---------------------------------------------------------------------------

/**
 * Read every active holdback, refresh its `current` outcome values,
 * update sustained-regression counts, trigger revert if any leading outcome
 * has been regressed for SUSTAINED_REGRESSION_CYCLES consecutive readings,
 * and mark `passed` when `cyclesElapsed` reaches HOLDBACK_WINDOW_CYCLES with
 * no regression.
 *
 * Per-day revert cap: when the day's revert counter is at MAX_REVERTS_PER_DAY,
 * further reverts are suppressed and the record is marked `cap-reached` —
 * the operator sees this via `holdback.cap-reached` in the digest.
 *
 * Never throws.
 */
export async function evaluateAllHoldbacks(
  cycleId: string,
  eventBus?: { publish: (stream: string, event: any) => Promise<any> } | null,
): Promise<EvaluateResult> {
  const result: EvaluateResult = { evaluated: 0, reverted: [], passed: [], capReached: false };

  try {
    if (await isTier2Disabled()) {
      // Don't evaluate while disabled — but also don't drop the active set,
      // so re-enabling resumes where we left off.
      return result;
    }

    const r = getRedisConnection();
    let activeShas: string[] = [];
    try {
      activeShas = await r.zrange(activeSetKey(), 0, -1);
    } catch (err: any) {
      console.error(`[holdback] evaluate: zrange failed: ${err?.message || String(err)}`);
      return result;
    }
    if (!Array.isArray(activeShas) || activeShas.length === 0) {
      return result;
    }

    const loaded = await loadOutcomes();
    if (loaded.ok === false) {
      console.error(`[holdback] evaluate: loadOutcomes failed: ${loaded.errors.join("; ")}`);
      return result;
    }
    const leading = loaded.outcomes.filter((o) => o.kind === "leading");
    if (leading.length === 0) {
      // No leading outcomes — nothing to evaluate. Don't clear active set;
      // operator may add outcomes later and existing records remain valid.
      return result;
    }

    for (const sha of activeShas) {
      result.evaluated += 1;
      let record: HoldbackRecord | null = null;
      try {
        const raw = await r.get(holdbackKey(sha));
        if (raw) record = JSON.parse(raw);
      } catch (err: any) {
        console.error(`[holdback] evaluate: failed to read record ${sha}: ${err?.message || String(err)}`);
      }
      if (!record || record.status !== "watching") {
        // Stale entry — drop from active set so we don't keep re-evaluating.
        try { await r.zrem(activeSetKey(), sha); } catch { /* intentional: cleanup best-effort */ }
        continue;
      }

      record.cyclesElapsed += 1;

      // Refresh current values; update per-outcome sustained-regression counter.
      const current: Record<string, number> = {};
      const regressionCounts = { ...record.regressionCounts };
      for (const o of leading) {
        if (!(o.name in record.baseline)) continue;
        let reading: { value: number; ts: string } | null = null;
        try {
          reading = await getOutcomeValue(o);
        } catch (err: any) {
          console.error(`[holdback] evaluate: getOutcomeValue('${o.name}') threw: ${err?.message || String(err)}`);
        }
        if (!reading || !Number.isFinite(reading.value)) {
          // No data this cycle — DO NOT count as a regression (matches the
          // contract in #242 + outcomes.ts). Hold the counter at its prior
          // value so a transient adapter outage doesn't reset progress.
          continue;
        }
        current[o.name] = reading.value;
        if (isOutcomeRegression(o, record.baseline[o.name], reading.value)) {
          regressionCounts[o.name] = (regressionCounts[o.name] || 0) + 1;
        } else {
          // Recovery cancels the streak.
          regressionCounts[o.name] = 0;
        }
      }
      record.current = { ...record.current, ...current };
      record.regressionCounts = regressionCounts;

      const { revert, outcomes: regressedOutcomes } = shouldRevert(record, leading);

      if (revert) {
        // Check per-day cap before attempting revert.
        const today = new Date().toISOString().slice(0, 10);
        let revertsToday = 0;
        try {
          const raw = await r.get(revertsPerDayKey(today));
          revertsToday = raw ? parseInt(raw, 10) || 0 : 0;
        } catch (err: any) {
          console.error(`[holdback] evaluate: failed to read per-day counter: ${err?.message || String(err)}`);
        }

        if (revertsToday >= MAX_REVERTS_PER_DAY) {
          record.status = "cap-reached";
          record.reason = `per-day revert cap reached (${MAX_REVERTS_PER_DAY}/day); regressed outcomes: ${regressedOutcomes.join(", ")}`;
          record.regressedOutcomes = regressedOutcomes;
          record.completedAt = new Date().toISOString();
          result.capReached = true;
          console.error(`[holdback] CAP REACHED for ${sha.slice(0, 7)}: ${record.reason}`);
          if (eventBus) {
            try {
              await eventBus.publish(STREAMS.NOTIFICATIONS, {
                type: "holdback.cap-reached",
                source: "holdback",
                correlationId: cycleId,
                payload: {
                  commitSha: sha,
                  prNumber: record.prNumber,
                  regressedOutcomes,
                  baseline: record.baseline,
                  current: record.current,
                  reason: record.reason,
                },
              });
            } catch (err: any) {
              console.error(`[holdback] cap-reached publish failed: ${err?.message || String(err)}`);
            }
          }
          await finalizeRecord(r, sha, record);
          continue;
        }

        // Attempt the revert.
        const revertReason = `Auto-revert: leading outcome regression sustained ${SUSTAINED_REGRESSION_CYCLES} cycles in [${regressedOutcomes.join(", ")}] (baseline → current: ${regressedOutcomes
          .map((n) => `${n} ${record!.baseline[n]} → ${record!.current[n]}`)
          .join("; ")})`;
        const reverted = await revertHoldback(sha, revertReason);
        if (reverted.ok) {
          record.status = "reverted";
          record.reason = revertReason;
          record.regressedOutcomes = regressedOutcomes;
          record.completedAt = new Date().toISOString();
          result.reverted.push(sha);
          // Bump per-day counter.
          try {
            await r.incr(revertsPerDayKey(today));
            // Set TTL on first increment of the day (24h * 2 for grace).
            await r.expire(revertsPerDayKey(today), 60 * 60 * 48);
          } catch (err: any) {
            console.error(`[holdback] per-day counter incr failed: ${err?.message || String(err)}`);
          }
          if (eventBus) {
            try {
              await eventBus.publish(STREAMS.NOTIFICATIONS, {
                type: "holdback.reverted",
                source: "holdback",
                correlationId: cycleId,
                payload: {
                  commitSha: sha,
                  prNumber: record.prNumber,
                  regressedOutcomes,
                  baseline: record.baseline,
                  current: record.current,
                  reason: revertReason,
                },
              });
            } catch (err: any) {
              console.error(`[holdback] reverted publish failed: ${err?.message || String(err)}`);
            }
          }
          console.log(`[holdback] REVERTED ${sha.slice(0, 7)}: ${revertReason}`);
          await finalizeRecord(r, sha, record);
          continue;
        } else {
          // Revert failed — leave status as `watching` so we try again next
          // cycle; surface via the event bus and log.
          console.error(`[holdback] revert FAILED for ${sha.slice(0, 7)}: ${reverted.error}`);
          if (eventBus) {
            try {
              await eventBus.publish(STREAMS.NOTIFICATIONS, {
                type: "holdback.revert_failed",
                source: "holdback",
                correlationId: cycleId,
                payload: {
                  commitSha: sha,
                  prNumber: record.prNumber,
                  regressedOutcomes,
                  error: reverted.error,
                },
              });
            } catch (err: any) {
              console.error(`[holdback] revert_failed publish failed: ${err?.message || String(err)}`);
            }
          }
        }
      } else if (record.cyclesElapsed >= HOLDBACK_WINDOW_CYCLES) {
        record.status = "passed";
        record.completedAt = new Date().toISOString();
        result.passed.push(sha);
        console.log(`[holdback] passed: ${sha.slice(0, 7)} clean for ${record.cyclesElapsed} cycle(s)`);
        if (eventBus) {
          try {
            await eventBus.publish(STREAMS.NOTIFICATIONS, {
              type: "holdback.passed",
              source: "holdback",
              correlationId: cycleId,
              payload: {
                commitSha: sha,
                prNumber: record.prNumber,
                cyclesElapsed: record.cyclesElapsed,
              },
            });
          } catch (err: any) {
            console.error(`[holdback] passed publish failed: ${err?.message || String(err)}`);
          }
        }
        await finalizeRecord(r, sha, record);
        continue;
      }

      // Persist updated record (still watching).
      try {
        await r.set(holdbackKey(sha), JSON.stringify(record), "EX", HOLDBACK_RECORD_TTL_S);
      } catch (err: any) {
        console.error(`[holdback] evaluate: persist updated record failed for ${sha}: ${err?.message || String(err)}`);
      }
    }
  } catch (err: any) {
    /* intentional: top-level safety net so a single bug here cannot crash
       the cycle. The control loop calls this once per cycle. */
    console.error(`[holdback] evaluate top-level error: ${err?.message || String(err)}`);
  }

  return result;
}

async function finalizeRecord(redis: any, sha: string, record: HoldbackRecord): Promise<void> {
  try {
    await redis.set(holdbackKey(sha), JSON.stringify(record), "EX", HOLDBACK_RECORD_TTL_S);
    await redis.zrem(activeSetKey(), sha);
    // Push to recent list (newest-first); cap at 50.
    await redis.lpush(recentListKey(), sha);
    await redis.ltrim(recentListKey(), 0, 49);
  } catch (err: any) {
    console.error(`[holdback] finalize failed for ${sha}: ${err?.message || String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Revert — git operations under the merge lock
// ---------------------------------------------------------------------------

interface RevertResult {
  ok: boolean;
  error?: string;
  revertCommitSha?: string;
}

/**
 * Perform `git revert --no-edit <commitSha>` on the orchestrator's master
 * branch and push to origin. Acquires `hydra:merge:lock` (60s TTL) before
 * touching git so concurrent control-loop merges cannot race the revert.
 *
 * Returns `{ ok: false, error }` on any failure — never throws. The caller
 * decides whether to retry next cycle.
 *
 * Tier-2 modifications target the orchestrator repo (`HYDRA_ROOT`), not the
 * target project. Per ADR-0004, all Tier-2 paths (`dashboard/`,
 * `.claude/skills/`, `src/anchor-selection.ts`) live in `gaberoo322/hydra`.
 */
export async function revertHoldback(commitSha: string, reason: string): Promise<RevertResult> {
  if (!commitSha || typeof commitSha !== "string") {
    return { ok: false, error: "invalid commitSha" };
  }
  // Acquire merge lock via the Tier-0 gate facade — same key/TTL the control
  // loop uses. Routing through the gate (rather than raw redis.set) keeps the
  // serialization contract for merges and reverts in a single place (#244,
  // ADR-0001 #267).
  let lockAcquired = false;
  try {
    lockAcquired = await gateAcquireMergeLock(`holdback-revert-${commitSha.slice(0, 7)}`, 60);
  } catch (err: any) {
    return { ok: false, error: `merge lock acquire failed: ${err?.message || String(err)}` };
  }
  if (!lockAcquired) {
    return { ok: false, error: "merge lock held by another cycle (will retry next cycle)" };
  }

  try {
    // Step 1: fetch + ensure master is current.
    try {
      await execFileAsync("git", ["fetch", "origin", "master"], { cwd: HYDRA_ROOT, timeout: 30_000 });
    } catch (err: any) {
      return { ok: false, error: `git fetch failed: ${err?.message || String(err)}` };
    }

    // Step 2: confirm the commit exists on master before attempting revert.
    try {
      await execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", commitSha, "origin/master"],
        { cwd: HYDRA_ROOT, timeout: 10_000 },
      );
    } catch (err: any) {
      return { ok: false, error: `commit ${commitSha} is not an ancestor of origin/master: ${err?.message || String(err)}` };
    }

    // Step 3: `git revert --no-edit -m 1`. `-m 1` is harmless for non-merge
    // commits and required for merge commits.
    const revertMessage = `Revert ${commitSha.slice(0, 7)} — ${reason}`;
    try {
      await execFileAsync(
        "git",
        ["revert", "--no-edit", "-m", "1", commitSha],
        { cwd: HYDRA_ROOT, timeout: 30_000, env: { ...process.env, GIT_EDITOR: "true" } },
      );
    } catch (err: any) {
      // Try to clean up if revert was started but failed mid-way.
      try {
        await execFileAsync("git", ["revert", "--abort"], { cwd: HYDRA_ROOT, timeout: 10_000 });
      } catch { /* intentional: abort is best-effort cleanup */ }
      return { ok: false, error: `git revert failed: ${err?.message || String(err)}` };
    }

    // Step 4: amend the revert commit message so the operator sees the reason
    // in the log (the default --no-edit message is just "Revert ..."). We
    // only override the body; the subject stays as git's default for tooling
    // that parses `Revert "..."` titles.
    try {
      const subject = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: HYDRA_ROOT, timeout: 5_000 });
      const subj = (subject.stdout || "").trim();
      await execFileAsync(
        "git",
        ["commit", "--amend", "-m", subj, "-m", revertMessage],
        { cwd: HYDRA_ROOT, timeout: 10_000, env: { ...process.env, GIT_EDITOR: "true" } },
      );
    } catch (err: any) {
      /* intentional: amend is informational; don't abort the revert because
         we couldn't decorate the message. The revert commit itself stands. */
      console.error(`[holdback] revert message amend failed (non-fatal): ${err?.message || String(err)}`);
    }

    // Step 5: capture the new HEAD sha.
    let revertCommitSha = "";
    try {
      const out = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: HYDRA_ROOT, timeout: 5_000 });
      revertCommitSha = (out.stdout || "").trim();
    } catch (err: any) {
      console.error(`[holdback] failed to capture revert HEAD sha: ${err?.message || String(err)}`);
    }

    // Step 6: push.
    try {
      await execFileAsync("git", ["push", "origin", "HEAD:master"], { cwd: HYDRA_ROOT, timeout: 30_000 });
    } catch (err: any) {
      return { ok: false, error: `git push failed: ${err?.message || String(err)}`, revertCommitSha };
    }

    return { ok: true, revertCommitSha };
  } finally {
    try {
      await gateReleaseMergeLock();
    } catch (err: any) {
      console.error(`[holdback] merge lock release failed: ${err?.message || String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Read API — for /api/holdback and digest
// ---------------------------------------------------------------------------

export async function getActiveHoldbacks(): Promise<HoldbackRecord[]> {
  try {
    const r = getRedisConnection();
    const shas = await r.zrange(activeSetKey(), 0, -1);
    if (!Array.isArray(shas) || shas.length === 0) return [];
    const records: HoldbackRecord[] = [];
    for (const sha of shas) {
      try {
        const raw = await r.get(holdbackKey(sha));
        if (raw) records.push(JSON.parse(raw));
      } catch (err: any) {
        console.error(`[holdback] getActive: parse failed for ${sha}: ${err?.message || String(err)}`);
      }
    }
    return records;
  } catch (err: any) {
    console.error(`[holdback] getActive failed: ${err?.message || String(err)}`);
    return [];
  }
}

export async function getRecentHoldbacks(limit = 20): Promise<HoldbackRecord[]> {
  try {
    const r = getRedisConnection();
    const shas = await r.lrange(recentListKey(), 0, limit - 1);
    if (!Array.isArray(shas) || shas.length === 0) return [];
    const records: HoldbackRecord[] = [];
    for (const sha of shas) {
      try {
        const raw = await r.get(holdbackKey(sha));
        if (raw) records.push(JSON.parse(raw));
      } catch (err: any) {
        console.error(`[holdback] getRecent: parse failed for ${sha}: ${err?.message || String(err)}`);
      }
    }
    return records;
  } catch (err: any) {
    console.error(`[holdback] getRecent failed: ${err?.message || String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal exports for tests
// ---------------------------------------------------------------------------

export const _internal = {
  holdbackKey,
  activeSetKey,
  recentListKey,
  revertsPerDayKey,
  KILL_FLAG_KEY,
  HYDRA_ROOT,
  finalizeRecord,
};
