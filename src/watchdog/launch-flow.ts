/**
 * watchdog/launch-flow.ts — the LAUNCH FLOW check (issue #5097, epic #5094,
 * slice 3/5; ADR-0040 Decision 2 shape: one pure decide + one run over
 * injected ports).
 *
 * Ported from scripts/hydra-watchdog.sh `run_launch_flow` (epics #3844 /
 * #3848 / #3868). Each ~2-min tick reads the pace-gate last-tick hash ONCE and
 * asks, per signal, "has this condition been SUSTAINED past its threshold?" by
 * running the shared episode tracker (`./episode.ts`) over the signal's
 * `{since, fired}` key pair:
 *
 *   fail-safe / meter-dark / quota / pause  <- the pace-gate `reason`
 *                                              (`classifyLaunchSignal`)
 *   latency                                 <- `latency_ms` over budget
 *   glm-sterile                             <- fresh drainer heartbeat AND a
 *                                              fresh pick verdict that ADMITTED
 *                                              an issue AND zero drainer PRs
 *                                              in the trailing window
 *
 * Surface routing at the fire edge (#3848 taxonomy): fail-safe / meter-dark go
 * out-of-band (Operator Channel page only; the Orchestrator is unproven);
 * quota / latency / pause / glm-sterile publish the enveloped event onto the
 * notifications stream through `EventBus.publish()` PLUS one page with
 * dedupKey == kind. Pages go through the Operator Channel module in-process
 * (ADR-0045 D2). Everything is best-effort and never throws.
 */

import {
  GLM_DRAINER_HEARTBEAT_TTL_SECONDS,
  type GlmDrainerLastPick,
  type GlmDrainerLiveness,
} from "../redis/autopilot.ts";
import {
  classifyLaunchSignal,
  launchFlowEpisodeKeys,
  type LaunchFlowEpisodeSignal,
  type PaceGateLastTick,
} from "../redis/launch-flow.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../event-bus-vocabulary.ts";
import { STREAMS } from "../event-bus-stream-keys.ts";
import type { EventBus } from "../event-bus.ts";
import type { ChannelResult, OperatorChannel } from "../operator-channel/channel.ts";
import type { OperatorMessage } from "../operator-channel/message.ts";
import { runEpisode, type EpisodeStore } from "./episode.ts";
import type { WatchdogGithub } from "./ports.ts";

export const LAUNCH_FLOW_LOG_PREFIX = "hydra-launch-flow-watchdog:";

/** Defaults — names and values unchanged from the bash block (INV-12). */
export const DEFAULT_LAUNCH_FAILSAFE_S = 7200;
export const DEFAULT_LAUNCH_METER_DARK_S = 7200;
export const DEFAULT_LAUNCH_QUOTA_S = 14400;
export const DEFAULT_LAUNCH_PAUSE_S = 86400;
export const DEFAULT_LAUNCH_LATENCY_BUDGET_MS = 1000;
export const DEFAULT_LAUNCH_LATENCY_BREACH_S = 3600;
export const DEFAULT_LAUNCH_GLM_STERILE_S = 3600;
export const DEFAULT_LAUNCH_GLM_STERILE_WINDOW_HOURS = 6;

export interface LaunchFlowConfig {
  failSafeS: number;
  meterDarkS: number;
  quotaS: number;
  pauseS: number;
  latencyBudgetMs: number;
  latencyBreachS: number;
  glmSterileS: number;
  glmSterileWindowHours: number;
  /** Injected `now` (epoch-ms) for deterministic tests; `null` = the clock port. */
  nowMs: number | null;
}

export const DEFAULT_LAUNCH_FLOW_CONFIG: LaunchFlowConfig = {
  failSafeS: DEFAULT_LAUNCH_FAILSAFE_S,
  meterDarkS: DEFAULT_LAUNCH_METER_DARK_S,
  quotaS: DEFAULT_LAUNCH_QUOTA_S,
  pauseS: DEFAULT_LAUNCH_PAUSE_S,
  latencyBudgetMs: DEFAULT_LAUNCH_LATENCY_BUDGET_MS,
  latencyBreachS: DEFAULT_LAUNCH_LATENCY_BREACH_S,
  glmSterileS: DEFAULT_LAUNCH_GLM_STERILE_S,
  glmSterileWindowHours: DEFAULT_LAUNCH_GLM_STERILE_WINDOW_HOURS,
  nowMs: null,
};

/** Signals in the order the tracker applies them (the bash order). */
export const LAUNCH_FLOW_SIGNAL_ORDER: readonly LaunchFlowEpisodeSignal[] = [
  "fail-safe",
  "meter-dark",
  "quota",
  "pause",
  "latency",
  "glm-sterile",
];

export type LaunchFlowMembership = Record<Exclude<LaunchFlowEpisodeSignal, "glm-sterile">, boolean>;

/**
 * Pure membership: `reason` -> the four reason-keyed signals through
 * `classifyLaunchSignal` (never re-typed here), and `latency` from
 * `latency_ms` over budget (independent of `reason`; absent clears).
 */
export function decideLaunchFlow(input: {
  reason: string;
  latencyMs: number | null;
  latencyBudgetMs: number;
}): LaunchFlowMembership {
  const sig = classifyLaunchSignal(input.reason);
  return {
    "fail-safe": sig === "fail-safe",
    "meter-dark": sig === "meter-dark",
    quota: sig === "quota",
    pause: sig === "pause",
    latency: input.latencyMs !== null && input.latencyMs > input.latencyBudgetMs,
  };
}

/**
 * The bus event input per in-band signal. Written as `type: E.<MEMBER>` on
 * purpose: that is the producer shape test/event-bus-vocabulary.test.mts's
 * live-producer audit recognises, and a typo is a compile error.
 */
const IN_BAND_EVENT = {
  quota: { type: E.LAUNCH_QUOTA_STRETCH },
  latency: { type: E.LAUNCH_LATENCY_BREACH },
  pause: { type: E.LAUNCH_PAUSE_FORGOTTEN },
  "glm-sterile": { type: E.GLM_DRAINER_STERILE },
} as const;

/** The page kind (== dedupKey) for each signal. */
export const LAUNCH_FLOW_PAGE_KIND: Readonly<Record<LaunchFlowEpisodeSignal, string>> = {
  "fail-safe": "launch:fail_safe",
  "meter-dark": "launch:meter_dark",
  quota: IN_BAND_EVENT.quota.type,
  latency: IN_BAND_EVENT.latency.type,
  pause: IN_BAND_EVENT.pause.type,
  "glm-sterile": IN_BAND_EVENT["glm-sterile"].type,
};

/**
 * Hard ceiling on a launch-flow tick (the Operator Channel CLI force-exit
 * precedent). Must exceed GH_EXEC_TIMEOUT_MS plus one Operator Channel page so a
 * slow call after the fired marker is SET cannot be cut off and lose its page;
 * it stays under the bash wrapper's 90s `timeout`.
 */
export const LAUNCH_FLOW_FORCE_EXIT_MS = 60_000;

export interface LaunchFlowDeps {
  /** One typed HGETALL; `null` = absent. THROWS on a Redis failure. */
  lastTick(): Promise<PaceGateLastTick | null>;
  store: EpisodeStore;
  glm: {
    liveness(nowMs: number): Promise<GlmDrainerLiveness>;
    /** `null` = key absent; `"unreadable"` = Redis/parse failure (INV-4). */
    lastPick(): Promise<GlmDrainerLastPick | null | "unreadable">;
  };
  github: WatchdogGithub;
  channel: Pick<OperatorChannel, "page" | "resolve">;
  /** Constructed lazily by the production adapter (idle ticks open no bus connections). */
  bus: Pick<EventBus, "publish">;
  clock: { nowMs(): number };
  log: (line: string) => void;
}

export type GlmSterileRead = { known: true; member: boolean } | { known: false };

/**
 * GLM-sterile membership: the four-way AND, read cheap -> expensive.
 * (1) heartbeat fresh, (2) pick verdict present+fresh (<= the writer's TTL),
 * (3) `picked` a positive integer, (4) zero drainer PRs in the trailing
 * window. Only step 4 makes a gh call. A failed window query is `known:false`
 * (a failed measurement is not a measurement); a missing/stale verdict is a
 * measured `member:false`.
 */
export async function readGlmSterile(
  deps: LaunchFlowDeps,
  nowMs: number,
  windowHours: number,
): Promise<GlmSterileRead> {
  const hb = await deps.glm.liveness(nowMs);
  // An unreadable heartbeat is a failed measurement, not a measured "drainer down" (INV-4).
  if (hb.reason === "unreadable") return { known: false };
  if (!hb.live || hb.heartbeatMs === null || hb.heartbeatMs > nowMs) return { known: true, member: false };

  const pick = await deps.glm.lastPick();
  // An unreadable verdict is a failed measurement, not an absent one (INV-4).
  if (pick === "unreadable") return { known: false };
  if (pick === null) return { known: true, member: false };
  const age = nowMs - pick.at;
  if (!(age >= 0 && age <= GLM_DRAINER_HEARTBEAT_TTL_SECONDS * 1000)) return { known: true, member: false };
  const picked = pick.picked;
  if (typeof picked !== "number" || !Number.isInteger(picked) || picked <= 0) return { known: true, member: false };

  const count = await deps.github.countDrainerPrsCreatedSince(nowMs - windowHours * 3_600_000);
  if (count === null) {
    deps.log(
      `${LAUNCH_FLOW_LOG_PREFIX} WARN glm-sterile PR-window query failed/unparseable — a failed query is not zero throughput; leaving the glm-sterile streak untouched this tick (#3868/#4691)`,
    );
    return { known: false };
  }
  return { known: true, member: count === 0 };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Drop everything outside the bash `tr -dc 'a-zA-Z0-9_.:-'` set. */
function sanitizeReason(reason: string): string {
  return reason.replace(/[^a-zA-Z0-9_.:-]/g, "");
}

function outcomeOf(res: ChannelResult): string {
  return res.sent ? "sent" : `not sent: ${(res as { reason?: string }).reason ?? "unknown"}`;
}

function pageMessage(kind: string, title: string, facts: Array<[string, string]>): OperatorMessage {
  return {
    severity: "page",
    kind,
    title,
    facts: facts.map(([label, value]) => ({ label, value })),
    links: [],
    dedupKey: kind,
  };
}

/** One best-effort channel page. Never throws. */
async function deliverPage(deps: LaunchFlowDeps, m: OperatorMessage): Promise<void> {
  const say = (line: string): void => deps.log(`${LAUNCH_FLOW_LOG_PREFIX} ${line}`);
  try {
    const res = await deps.channel.page(m);
    say(`operator-channel page ok for '${m.kind}' (${outcomeOf(res)})`);
  } catch (err) {
    say(`WARN operator-channel page FAILED for '${m.kind}' (best-effort — detection state is unchanged): ${msg(err)}`);
  }
}

async function deliverResolve(deps: LaunchFlowDeps, kind: string, title: string): Promise<void> {
  const say = (line: string): void => deps.log(`${LAUNCH_FLOW_LOG_PREFIX} ${line}`);
  try {
    const res = await deps.channel.resolve(kind, title);
    say(`operator-channel resolve ok for '${kind}' (${outcomeOf(res)})`);
  } catch (err) {
    say(`WARN operator-channel resolve FAILED for '${kind}' (best-effort — detection state is unchanged): ${msg(err)}`);
  }
}

/**
 * Surface routing at the fire edge (#3848 taxonomy). fail-safe / meter-dark:
 * one out-of-band page, no bus publish. Everything else: the enveloped event
 * via `EventBus.publish()` (source `watchdog-launch-flow`, correlationId
 * `launch-flow-<signal>`) plus one page with dedupKey == kind.
 */
async function deliverSignal(
  deps: LaunchFlowDeps,
  sig: LaunchFlowEpisodeSignal,
  reason: string,
  durMs: number,
  thrMs: number,
): Promise<void> {
  const kind = LAUNCH_FLOW_PAGE_KIND[sig];
  if (sig === "fail-safe" || sig === "meter-dark") {
    await deliverPage(
      deps,
      pageMessage(kind, `Launch flow '${sig}' sustained ${durMs}ms (>= ${thrMs}ms) — Orchestrator may be down`, [
        ["signal", sig],
        ["reason", reason || "n/a"],
        ["sustained_ms", String(durMs)],
        ["threshold_ms", String(thrMs)],
      ]),
    );
    return;
  }
  const reasonClean = sanitizeReason(reason);
  try {
    await deps.bus.publish(STREAMS.NOTIFICATIONS, {
      type: IN_BAND_EVENT[sig].type,
      source: "watchdog-launch-flow",
      correlationId: `launch-flow-${sig}`,
      payload: { signal: sig, reason: reasonClean, durationMs: durMs, thresholdMs: thrMs },
    });
    deps.log(`${LAUNCH_FLOW_LOG_PREFIX} in-band delivery published (best-effort) for '${sig}' (type=${kind} -> ${STREAMS.NOTIFICATIONS})`);
  } catch (err) {
    deps.log(`${LAUNCH_FLOW_LOG_PREFIX} WARN in-band delivery FAILED for '${sig}' (best-effort — detection state is unchanged): ${msg(err)}`);
  }
  // ADR-0045 D2: the page goes through the Operator Channel with dedupKey ==
  // kind, so the consumer's own page for the event above dedups against it.
  await deliverPage(
    deps,
    pageMessage(kind, `Launch flow '${sig}' sustained ${durMs}ms (>= ${thrMs}ms)`, [
      ["signal", sig],
      ["reason", reasonClean || "n/a"],
      ["sustained_ms", String(durMs)],
      ["threshold_ms", String(thrMs)],
    ]),
  );
}

/** One watchdog tick of the launch-flow check. Never throws. */
export async function runLaunchFlow(deps: LaunchFlowDeps, config: LaunchFlowConfig = DEFAULT_LAUNCH_FLOW_CONFIG): Promise<void> {
  const say = (line: string): void => deps.log(`${LAUNCH_FLOW_LOG_PREFIX} ${line}`);

  // --- The ONE upstream fact: the last-tick hash (INV-10) ---
  let tick: PaceGateLastTick | null = null;
  try {
    tick = await deps.lastTick();
  } catch (err) {
    say(`last-tick read threw: ${msg(err)}`);
    tick = null;
  }
  if (tick === null) {
    // Empty/absent last-tick OR redis unreadable. MUST NOT mutate any
    // anchor/fired — clearing on a read failure would falsely erase an
    // in-progress streak.
    say("WARN no pace-gate last-tick record (redis unreadable or key absent) — leaving all launch-flow anchors untouched, no alarm");
    return;
  }

  const nowMs = config.nowMs ?? deps.clock.nowMs();
  const { reason, latencyMs } = tick;
  const members: Record<LaunchFlowEpisodeSignal, boolean | null> = {
    ...decideLaunchFlow({ reason, latencyMs, latencyBudgetMs: config.latencyBudgetMs }),
    "glm-sterile": false,
  };

  // glm-sterile: a failed measurement skips the tracker entirely.
  try {
    const glm = await readGlmSterile(deps, nowMs, config.glmSterileWindowHours);
    members["glm-sterile"] = glm.known ? glm.member : null;
  } catch (err) {
    say(`WARN glm-sterile read failed (${msg(err)}) — leaving the glm-sterile streak untouched this tick`);
    members["glm-sterile"] = null;
  }

  const thresholdMs: Record<LaunchFlowEpisodeSignal, number> = {
    "fail-safe": config.failSafeS * 1000,
    "meter-dark": config.meterDarkS * 1000,
    quota: config.quotaS * 1000,
    pause: config.pauseS * 1000,
    latency: config.latencyBreachS * 1000,
    "glm-sterile": config.glmSterileS * 1000,
  };

  for (const sig of LAUNCH_FLOW_SIGNAL_ORDER) {
    const member = members[sig];
    if (member === null) continue;
    await runEpisode(
      deps.store,
      launchFlowEpisodeKeys(sig),
      { signal: sig, member, nowMs, thresholdMs: thresholdMs[sig] },
      {
        log: (line) => say(line),
        onBelowThreshold: (dur) => say(`launch-flow signal '${sig}' streak ${dur}ms (< ${thresholdMs[sig]}ms threshold); not firing`),
        onFire: async (dur) => {
          say(
            `WARNING LAUNCH FLOW — signal '${sig}' sustained ${dur}ms >= ${thresholdMs[sig]}ms threshold (reason=${reason || "n/a"}); see epic #3844`,
          );
          await deliverSignal(deps, sig, reason, dur, thresholdMs[sig]);
        },
        onRecover: () => deliverResolve(deps, LAUNCH_FLOW_PAGE_KIND[sig], `Launch flow '${sig}' recovered`),
      },
    );
  }

  say(`launch-flow tick processed (reason=${reason}, latency_ms=${latencyMs ?? "none"}, now_ms=${nowMs})`);
}
