/**
 * Morning Brief data assembly (ADR-0045 Decision 7, issue #5047).
 *
 * `collectBriefSections` fans out to the brief's independent readers and returns
 * plain-text sections for `brief-render.ts` to escape and join. Every section is
 * best-effort: a failing reader degrades to that section's single
 * `n/a (<reason>)` line and never blocks the send (the retired heartbeat's
 * contract, kept). Readers are injected via {@link BriefSourcesDeps} (same
 * pattern as the retired `digest-fanout.ts`, whose usage / autopilot /
 * builder-health readers moved here) so the assembler is testable without Redis
 * or `gh`.
 *
 * Deliberately NOT re-exported from `./index.ts`: it imports the aggregators and
 * the attention composer, which the pure channel modules must not pull in.
 */

import { getRecentMerges as defaultGetRecentMerges, type MergeItem } from "../aggregators/recent-merges.ts";
import { getBuilderHealthScorecard as defaultGetBuilderHealthScorecard } from "../aggregators/builder-health.ts";
import type {
  StagnationPanel,
  StagnationSignalName,
  Realm,
} from "../aggregators/builder-health-stagnation-panel.ts";
import { getAttentionFeed as defaultGetAttentionFeed } from "../attention.ts";
import { getUsage as defaultGetUsage } from "../cost/index.ts";
import { buildWeeklySummary as defaultBuildWeeklySummary } from "../digest-weekly.ts";
import { getAutopilotPaused as defaultGetAutopilotPaused } from "../redis/autopilot-pause.ts";
import {
  listRecentAutopilotRunIds as defaultListRecentAutopilotRunIds,
  getAutopilotRun as defaultGetAutopilotRun,
} from "../redis/autopilot-runs.ts";
import { listDispatchOutcomes as defaultListDispatchOutcomes } from "../redis/dispatch-outcomes.ts";
import {
  readBriefItems as defaultReadBriefItems,
  listDedupStates as defaultListDedupStates,
} from "../redis/operator-channel.ts";
import { actionCommandText } from "./channel.ts";
import { renderBriefLine, type BriefItem } from "./brief-lines.ts";

/** Brief items are read for this long when no last-sent stamp exists. */
export const DEFAULT_BRIEF_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_MERGE_LINES = 8;
const MAX_WAITING_LINES = 8;
const MAX_EVENT_LINES = 12;

export interface BriefSection {
  title: string;
  /** Plain-text lines (escaped by the HTML renderer). */
  lines: string[];
  /** Optional per-line links, parallel to `lines` (undefined = no link). */
  urls?: Array<string | undefined>;
}

export interface BriefSourcesDeps {
  now?: () => number;
  readBriefItems?: () => Promise<Array<Record<string, unknown>>>;
  listDedupStates?: typeof defaultListDedupStates;
  getRecentMerges?: (limit: number) => Promise<MergeItem[]>;
  listDispatchOutcomes?: typeof defaultListDispatchOutcomes;
  getAttentionFeed?: typeof defaultGetAttentionFeed;
  getAutopilotPaused?: typeof defaultGetAutopilotPaused;
  listRecentAutopilotRunIds?: (n: number) => Promise<string[]>;
  getAutopilotRun?: (id: string) => Promise<any>;
  getUsage?: () => Promise<any>;
  getBuilderHealthScorecard?: () => Promise<any>;
  buildWeeklySummary?: typeof defaultBuildWeeklySummary;
}

function reasonOf(err: unknown): string {
  return (err as { message?: string })?.message || String(err);
}

/** Run one section reader; any failure degrades to a single n/a line. */
async function section(
  title: string,
  read: () => Promise<Omit<BriefSection, "title">>,
): Promise<BriefSection> {
  try {
    return { title, ...(await read()) };
  } catch (err) {
    console.error(`[OperatorChannel] morning brief section "${title}" failed:`, err);
    return { title, lines: [`n/a (${reasonOf(err)})`] };
  }
}

/**
 * Compact per-realm stagnation glance (ADR-0028, moved from the retired
 * `digest-fanout.ts`; plain text). Pure — reads only the computed panel.
 */
export function formatStagnationLine(panel: StagnationPanel | null | undefined): string {
  if (!panel || !panel.signals) return "Stagnation: no instrumented signals";
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
      if (!r) continue;
      instrumented++;
      if (r.state === "breach") breached++;
      else if (r.state === "warming") warming++;
    }
  }
  if (instrumented === 0) return "Stagnation: no instrumented signals";
  const cycles = Number.isFinite(panel.windowContext?.cycles) ? panel.windowContext.cycles : 0;
  const flag = breached > 0 ? " (!)" : "";
  return `Stagnation: ${breached}/${instrumented} signals breached${flag}, ${warming} warming (${cycles} cycles)`;
}

function ageText(minutes: number | null): string {
  if (minutes === null) return "?";
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function isBriefItem(raw: Record<string, unknown>): raw is Record<string, unknown> & BriefItem {
  return typeof raw.kind === "string" && typeof raw.at === "number";
}

/** The items the brief covers: stored items newer than `sinceMs`, oldest first. Never mutates the list. */
export async function readItemsSince(
  deps: BriefSourcesDeps,
  sinceMs: number,
): Promise<BriefItem[]> {
  const read = deps.readBriefItems ?? (() => defaultReadBriefItems());
  const raw = await read();
  return raw
    .filter(isBriefItem)
    .filter((i) => i.at > sinceMs)
    .map((i) => ({
      kind: i.kind,
      title: typeof i.title === "string" ? i.title : i.kind,
      facts: Array.isArray(i.facts) ? (i.facts as BriefItem["facts"]) : [],
      at: i.at,
    }))
    .sort((a, b) => a.at - b.at);
}

export interface CollectOptions {
  /** Epoch ms of the previous brief; null/undefined = the default 24h window. */
  lastSentAt: number | null;
  /** Append the weekly summary (Mondays). */
  includeWeekly: boolean;
}

export async function collectBriefSections(
  opts: CollectOptions,
  deps: BriefSourcesDeps = {},
): Promise<BriefSection[]> {
  const now = (deps.now ?? (() => Date.now()))();
  const sinceMs = opts.lastSentAt ?? now - DEFAULT_BRIEF_WINDOW_MS;

  // One shared scorecard read for the builder-health section.
  const scorecardReader = deps.getBuilderHealthScorecard ?? defaultGetBuilderHealthScorecard;

  const sections: BriefSection[] = await Promise.all([
    section("Overnight", async () => {
      const lines: string[] = [];
      const urls: Array<string | undefined> = [];
      const getRecentMerges = deps.getRecentMerges ?? ((n: number) => defaultGetRecentMerges(n));
      const merges = (await getRecentMerges(30)).filter((m) => new Date(m.mergedAt).getTime() > sinceMs);
      if (merges.length === 0) {
        lines.push("No orchestrator merges.");
        urls.push(undefined);
      } else {
        lines.push(`${merges.length} orchestrator merge(s):`);
        urls.push(undefined);
        for (const m of merges.slice(0, MAX_MERGE_LINES)) {
          lines.push(`#${m.prNumber} ${m.title}`);
          urls.push(m.url);
        }
        if (merges.length > MAX_MERGE_LINES) {
          lines.push(`… +${merges.length - MAX_MERGE_LINES} more`);
          urls.push(undefined);
        }
      }
      const listOutcomes = deps.listDispatchOutcomes ?? defaultListDispatchOutcomes;
      const outcomes = await listOutcomes({ sinceMs });
      if (!outcomes.ok) throw new Error((outcomes as { error: string }).error);
      const qa = outcomes.records.filter((r) => r.className === "qa_orch" || r.className === "qa_target");
      if (qa.length === 0) {
        lines.push("QA: no verdicts.");
      } else {
        const counts = new Map<string, number>();
        for (const r of qa) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
        lines.push(`QA: ${[...counts].map(([o, n]) => `${n} ${o}`).join(", ")}`);
      }
      urls.push(undefined);
      return { lines, urls };
    }),

    section("Waiting on you", async () => {
      const getFeed = deps.getAttentionFeed ?? defaultGetAttentionFeed;
      const feed = await getFeed();
      const items = feed.items.filter(
        (i) => !i.dismissed && (i.bucket === "waiting-on-you" || i.bucket === "target-items"),
      );
      if (items.length === 0) {
        return { lines: [feed.sourcesOk ? "Nothing waiting." : "n/a (some attention sources unavailable)"] };
      }
      const lines: string[] = [];
      const urls: Array<string | undefined> = [];
      for (const i of items.slice(0, MAX_WAITING_LINES)) {
        lines.push(`${i.title} — ${actionCommandText(i.action.recommended)}`);
        urls.push(i.url || undefined);
      }
      if (items.length > MAX_WAITING_LINES) {
        lines.push(`… +${items.length - MAX_WAITING_LINES} more`);
        urls.push(undefined);
      }
      return { lines, urls };
    }),

    section("Autopilot and quota", async () => {
      const lines: string[] = [];
      try {
        const paused = await (deps.getAutopilotPaused ?? defaultGetAutopilotPaused)();
        lines.push(paused.paused ? "Autopilot: PAUSED" : "Autopilot: running");
      } catch (err) {
        console.error("[OperatorChannel] brief: autopilot pause read failed:", err);
        lines.push(`Autopilot: n/a (${reasonOf(err)})`);
      }
      try {
        const listIds = deps.listRecentAutopilotRunIds ?? defaultListRecentAutopilotRunIds;
        const getRun = deps.getAutopilotRun ?? defaultGetAutopilotRun;
        const [latestId] = await listIds(1);
        if (latestId) {
          const run = await getRun(latestId);
          const startedEpoch = Number(run.started_epoch || 0);
          const ageMin = startedEpoch > 0 ? Math.round((now / 1000 - startedEpoch) / 60) : null;
          const state = run.status || (run.ended ? "ended" : "running");
          lines.push(`Last run ${state}, started ${ageText(ageMin)}`);
        } else {
          lines.push("Last run: none indexed (!)");
        }
      } catch (err) {
        console.error("[OperatorChannel] brief: autopilot run read failed:", err);
        lines.push(`Last run: n/a (${reasonOf(err)})`);
      }
      try {
        const u = await (deps.getUsage ?? defaultGetUsage)();
        if (!u.calibrated) {
          lines.push("Usage: uncalibrated (quota env vars unset)");
        } else {
          const stop5h = u.emergencyStop ? " [stopped]" : "";
          const stopWk = u.weeklyEmergencyStop ? " [stopped]" : "";
          lines.push(
            `Usage: 5h ${u.percentLast5h.toFixed(0)}%${stop5h}, weekly ${u.percentSinceReset.toFixed(0)}%${stopWk} (caps at 90%)`,
          );
        }
      } catch (err) {
        console.error("[OperatorChannel] brief: usage read failed:", err);
        lines.push(`Usage: n/a (${reasonOf(err)})`);
      }
      return { lines };
    }),

    section("Builder health", async () => {
      const health = await scorecardReader();
      const autonomy = health?.autonomyRate;
      const throughput =
        autonomy && autonomy.total > 0
          ? `Throughput: ${autonomy.autonomous}/${autonomy.total} PRs auto-merged (last ${autonomy.window})`
          : "Throughput: no merges in window";
      return { lines: [throughput, formatStagnationLine(health?.stagnation ?? null)] };
    }),

    section("Events since the last brief", async () => {
      const items = await readItemsSince(deps, sinceMs);
      if (items.length === 0) return { lines: ["No events."] };
      const grouped = new Map<string, { line: string; count: number }>();
      for (const item of items) {
        const line = renderBriefLine(item);
        const hit = grouped.get(line);
        if (hit) hit.count++;
        else grouped.set(line, { line, count: 1 });
      }
      const all = [...grouped.values()];
      const lines = all.slice(0, MAX_EVENT_LINES).map((g) => (g.count > 1 ? `${g.line} (x${g.count})` : g.line));
      if (all.length > MAX_EVENT_LINES) lines.push(`… +${all.length - MAX_EVENT_LINES} more`);
      return { lines };
    }),

    section("Pages", async () => {
      const states = await (deps.listDedupStates ?? defaultListDedupStates)();
      if (states.length === 0) return { lines: ["No page conditions currently failing."] };
      return {
        lines: states.map(
          (s) => `${s.dedupKey}: failing since ${new Date(s.firstAt).toISOString()}, ${s.suppressed} suppressed`,
        ),
      };
    }),
  ]);

  if (opts.includeWeekly) {
    sections.push(
      await section("Weekly summary", async () => {
        const summary = await (deps.buildWeeklySummary ?? defaultBuildWeeklySummary)({ now: () => now });
        return { lines: summary ? summary.lines : ["No metrics recorded in the last 7 days."] };
      }),
    );
  }
  return sections;
}
