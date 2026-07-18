/**
 * Daily-heartbeat async fan-out assembler (issue #2215; weekly summary split
 * out into `src/digest-weekly.ts` in #3394).
 *
 * `buildDailyHeartbeat` is the side-effecting sibling of the pure grammar in
 * `src/digest-format.ts`. It is a mini fan-out orchestrator: it reads from
 * several independent sub-sources (Redis run index, the usage tracker, the
 * builder-health scorecard, the alert ring …), assembles
 * the on-wire Telegram string, and degrades each section best-effort (a failing
 * reader → an `n/a` line, never a thrown error) so the heartbeat ALWAYS ships.
 *
 * It was lifted out of `digest-format.ts` so that file's documented contract —
 * pure assembly grammar, no timers, no Telegram calls, no dynamic imports, no
 * Redis / usage-tracker / GitHub I/O — becomes literally true. This module is
 * named after its body (the async fan-out), mirroring the `notify.ts` /
 * `notify-format.ts` split (issue #1512) and the health `fan-out.ts` precedent
 * (issues #2039 / #2089). The once-a-week weekly summary — which shared no
 * helpers, types, or callers with the daily heartbeat — now lives in the
 * sibling `src/digest-weekly.ts` leaf (issue #3394).
 *
 * Each reader is injectable via `deps` (defaulting to the real import), the same
 * pattern as `src/aggregators/builder-health.ts`, so the assembler stays
 * unit-testable without Redis, the usage tracker, or GitHub. The on-wire output
 * is byte-identical to the pre-extraction `digest-format.ts` — this is a
 * boundary realignment, not a format change.
 */

import { getBuilderHealthScorecard } from "./aggregators/builder-health.ts";
import {
  type StagnationPanel,
  type StagnationSignalName,
  type Realm,
} from "./aggregators/builder-health-stagnation-panel.ts";
import {
  listRecentAutopilotRunIds as defaultListRecentAutopilotRunIds,
  getAutopilotRun as defaultGetAutopilotRun,
} from "./redis/autopilot-runs.ts";
import { getUsage as defaultGetUsage } from "./cost/index.ts";
import { readRecentAlerts as defaultReadRecentAlerts } from "./redis/alerts.ts";

/**
 * Injectable readers for `buildDailyHeartbeat`. Each defaults to the real
 * module import, so the production wrapper calls `buildDailyHeartbeat()` with
 * no args; tests pass stubs to exercise the grammar without Redis, the usage
 * tracker, or GitHub. Mirrors the `deps` pattern in
 * `src/aggregators/builder-health.ts`.
 */
export interface DailyHeartbeatDeps {
  listRecentAutopilotRunIds?: (n: number) => Promise<string[]>;
  getAutopilotRun?: (id: string) => Promise<any>;
  getUsage?: () => Promise<any>;
  getBuilderHealthScorecard?: () => Promise<any>;
  readRecentAlerts?: (n: number) => Promise<string[]>;
  now?: () => number;
}

/**
 * Build the daily heartbeat message (always returns a string — never null).
 *
 * Each section is best-effort: a failing reader degrades that one line to a
 * "n/a" marker rather than throwing, so the heartbeat ALWAYS ships even when
 * Redis / the usage tracker hiccups. Sections, in operator-priority order:
 *   - Liveness   — most recent autopilot run + its age (a wedged loop shows up)
 *   - Usage      — 5h % and weekly since-reset %, against the 90% hard-stops
 *   - Throughput — autonomous merge rate over the builder-health window
 *   - Alerts     — count of alert events recorded in the last 24h
 *
 * Readers are injectable via `deps` (defaulting to the real imports) so the
 * grammar is testable without side effects.
 */
export async function buildDailyHeartbeat(deps: DailyHeartbeatDeps = {}): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  const lines = ["💓 *Hydra Daily Heartbeat*", ""];

  // --- Liveness: latest autopilot run + age ---
  try {
    const listRecentAutopilotRunIds =
      deps.listRecentAutopilotRunIds ?? defaultListRecentAutopilotRunIds;
    const getAutopilotRun = deps.getAutopilotRun ?? defaultGetAutopilotRun;
    const [latestId] = await listRecentAutopilotRunIds(1);
    if (latestId) {
      const run = await getAutopilotRun(latestId);
      const startedEpoch = Number(run.started_epoch || 0);
      const ageMin = startedEpoch > 0 ? Math.round((now() / 1000 - startedEpoch) / 60) : null;
      const status = run.status || run.ended ? run.status || "ended" : "running";
      const ageStr = ageMin === null ? "?" : ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
      lines.push(`*Autopilot:* last run ${status} — started ${ageStr}`);
    } else {
      lines.push(`*Autopilot:* ⚠️ no recent run indexed`);
    }
  } catch (err: any) {
    lines.push(`*Autopilot:* n/a (${err?.message || err})`);
  }

  // --- Usage: 5h + weekly since-reset, with the 90% hard-stops in view ---
  try {
    const getUsage = deps.getUsage ?? defaultGetUsage;
    const u = await getUsage();
    if (!u.calibrated) {
      lines.push(`*Usage:* uncalibrated (quota env vars unset)`);
    } else {
      const stop5h = u.emergencyStop ? " 🛑" : "";
      const stopWk = u.weeklyEmergencyStop ? " 🛑" : "";
      lines.push(
        `*Usage:* 5h ${u.percentLast5h.toFixed(0)}%${stop5h} · weekly ${u.percentSinceReset.toFixed(0)}%${stopWk} (caps at 90%)`,
      );
    }
  } catch (err: any) {
    lines.push(`*Usage:* n/a (${err?.message || err})`);
  }

  // --- Builder-health scorecard: ONE shared read for both sections below ---
  // The Throughput and Stagnation sections both derive from the same scorecard,
  // whose read itself fans out across Redis, `gh pr list`, and metrics. Reading
  // it once (via `allSettled`, so a rejection never propagates) removes the
  // duplicate I/O AND the subtle correctness hazard of the two sections
  // observing different snapshots — while preserving the per-section
  // independent-degradation invariant: on a failed read each section still
  // emits its OWN `n/a` line, byte-identical to the pre-share behaviour.
  const scorecardReader = deps.getBuilderHealthScorecard ?? getBuilderHealthScorecard;
  const [scorecardResult] = await Promise.allSettled([scorecardReader()]);

  // --- Throughput: autonomous merge rate over the builder-health window ---
  // The `try/catch` guards the FULFILLED-branch processing (not just the shared
  // read above): a throw while reading scorecard fields still degrades THIS line
  // to n/a rather than propagating, preserving the never-throws invariant.
  if (scorecardResult.status === "fulfilled") {
    try {
      const health = scorecardResult.value;
      const autonomy = health?.autonomyRate;
      if (autonomy && autonomy.total > 0) {
        lines.push(
          `*Throughput:* ${autonomy.autonomous}/${autonomy.total} PRs auto-merged (last ${autonomy.window})`,
        );
      } else {
        lines.push(`*Throughput:* no merges in window`);
      }
    } catch (err: any) {
      lines.push(`*Throughput:* n/a (${err?.message || err})`);
    }
  } else {
    const err: any = scorecardResult.reason;
    lines.push(`*Throughput:* n/a (${err?.message || err})`);
  }

  // --- Stagnation: per-realm builder-health glance (ADR-0028, epic #3285) ---
  // Best-effort: a failing scorecard read degrades THIS line to n/a and never
  // throws, so the heartbeat still ships. Shares the single scorecard read
  // above with Throughput; each section still degrades independently so one
  // section's failure can't silently blank the other.
  if (scorecardResult.status === "fulfilled") {
    try {
      const health = scorecardResult.value;
      lines.push(formatStagnationHeartbeatLine(health?.stagnation ?? null));
    } catch (err: any) {
      lines.push(`*Stagnation:* n/a (${err?.message || err})`);
    }
  } else {
    const err: any = scorecardResult.reason;
    lines.push(`*Stagnation:* n/a (${err?.message || err})`);
  }

  // (The Redis "Target backlog" lane-depth line was retired with the Redis
  // backlog subsystem — ADR-0031 contract phase, issue #3439. The Target now
  // tracks work as GitHub Issues; a GitHub-board digest line is a follow-on.)

  // --- Alerts: count recorded in the last 24h ---
  try {
    const readRecentAlerts = deps.readRecentAlerts ?? defaultReadRecentAlerts;
    const raw = await readRecentAlerts(100);
    const since = now() - 24 * 60 * 60 * 1000;
    let count = 0;
    for (const a of raw) {
      try {
        const ts = JSON.parse(a)?.timestamp;
        if (!ts || new Date(ts).getTime() >= since) count++;
      } catch {
        /* intentional: unparseable alert → count it rather than hide it */
        count++;
      }
    }
    lines.push(`*Alerts (24h):* ${count}${count > 0 ? " — see the 4h alert digest" : ""}`);
  } catch (err: any) {
    lines.push(`*Alerts (24h):* n/a (${err?.message || err})`);
  }

  return lines.filter(Boolean).join("\n");
}

/**
 * Compact per-realm stagnation glance for the daily heartbeat (ADR-0028, epic
 * #3285). Pure — reads only the already-computed `StagnationPanel` and never
 * throws. Renders a single `*Stagnation:*` line: the count of breached
 * signal×realm cells (with a ⚠ when any breached), the count still warming, and
 * the window cycle count. A `null` panel (scorecard degraded or no instrumented
 * realm yet) reads `no instrumented signals`. The full per-cell breakdown lives
 * in the `formatBuilderHealthLines` panel (`digest-format.ts`); this line is the
 * heartbeat's at-a-glance summary of it.
 */
function formatStagnationHeartbeatLine(panel: StagnationPanel | null): string {
  if (!panel || !panel.signals) return "*Stagnation:* no instrumented signals";
  const signalOrder: readonly StagnationSignalName[] = ["cycleYield", "reworkRate", "mutationKillRate"];
  const realmOrder: readonly Realm[] = ["orch", "target"];
  let breached = 0;
  let warming = 0;
  let instrumented = 0;
  for (const name of signalOrder) {
    const realms = panel.signals[name];
    if (!realms) continue;
    for (const realm of realmOrder) {
      const r = realms[realm];
      if (!r) continue; // dark / un-instrumented realm signal
      instrumented++;
      if (r.state === "breach") breached++;
      else if (r.state === "warming") warming++;
    }
  }
  if (instrumented === 0) return "*Stagnation:* no instrumented signals";
  const cycles = Number.isFinite(panel.windowContext?.cycles) ? panel.windowContext.cycles : 0;
  const flag = breached > 0 ? " ⚠️" : "";
  return `*Stagnation:* ${breached}/${instrumented} signals breached${flag}, ${warming} warming (${cycles} cycles)`;
}
