/**
 * Morning Brief readers (ADR-0045 Decision 7, issue #5047).
 *
 * The shallow fan-out that fetches each section's evidence. Every reader is
 * injectable (the `deps` pattern of `src/aggregators/builder-health.ts`) and
 * every section is BEST-EFFORT: a failing reader becomes `{ ok: false, reason }`
 * for that one section and never blocks the send — the retired heartbeat's
 * contract, kept. The pure composition over these reads lives in `brief.ts`.
 *
 * The four readers the retired `src/digest-fanout.ts` daily heartbeat used
 * (autopilot run index, usage tracker, builder-health scorecard) moved here.
 */

import { getRecentMerges as defaultGetRecentMerges, type MergeItem } from "../aggregators/recent-merges.ts";
import {
  listDispatchOutcomes as defaultListDispatchOutcomes,
  type DispatchOutcomeListResult,
} from "../redis/dispatch-outcomes.ts";
import { getAttentionFeed as defaultGetAttentionFeed, type AttentionFeedResult } from "../attention.ts";
import { getAutopilotPaused as defaultGetAutopilotPaused, type AutopilotPauseState } from "../redis/autopilot-pause.ts";
import {
  listRecentAutopilotRunIds as defaultListRecentAutopilotRunIds,
  getAutopilotRun as defaultGetAutopilotRun,
} from "../redis/autopilot-runs.ts";
import { getUsage as defaultGetUsage } from "../cost/index.ts";
import { getBuilderHealthScorecard as defaultGetBuilderHealthScorecard } from "../aggregators/builder-health.ts";
import {
  readBriefItems as defaultReadBriefItems,
  listDedupStates as defaultListDedupStates,
  type DedupStateRow,
} from "../redis/operator-channel.ts";
import { buildWeeklySummary as defaultBuildWeeklySummary, type WeeklySummary } from "./weekly-summary.ts";
import { logger } from "../logger.ts";
import { briefItemFromStored, type BriefItem } from "./brief-lines.ts";

/** The subset of the usage snapshot the brief reads. */
export interface UsageLike {
  calibrated?: boolean;
  percentLast5h?: number;
  percentSinceReset?: number;
  emergencyStop?: boolean;
  weeklyEmergencyStop?: boolean;
}

/** The subset of the ADR-0028 stagnation panel the brief's one-liner reads. */
export interface StagnationLike {
  signals?: Record<string, Record<string, { state?: string } | null | undefined> | null | undefined> | null;
  windowContext?: { cycles?: number } | null;
}

/** The subset of the builder-health scorecard the brief reads. */
export interface BuilderHealthLike {
  autonomyRate?: { autonomous: number; total: number; window: number } | null;
  stagnation?: StagnationLike | null;
}

export interface BriefSourcesDeps {
  getRecentMerges?: (limit: number) => Promise<MergeItem[]>;
  listDispatchOutcomes?: (opts: { sinceMs: number }) => Promise<DispatchOutcomeListResult>;
  getAttentionFeed?: () => Promise<AttentionFeedResult>;
  getAutopilotPaused?: () => Promise<AutopilotPauseState>;
  listRecentAutopilotRunIds?: (n: number) => Promise<string[]>;
  getAutopilotRun?: (id: string) => Promise<Record<string, string>>;
  getUsage?: () => Promise<UsageLike>;
  getBuilderHealthScorecard?: () => Promise<BuilderHealthLike | null>;
  readBriefItems?: (limit: number) => Promise<unknown[]>;
  listDedupStates?: () => Promise<DedupStateRow[]>;
  buildWeeklySummary?: () => Promise<WeeklySummary | null>;
}

export type SectionRead<T> = { ok: true; value: T } | { ok: false; reason: string };

// (tsconfig is non-strict, so `ok` does not narrow the union; read via these.)
/** The failure reason, or null when the section read succeeded. */
export function sectionError<T>(read: SectionRead<T>): string | null {
  return read.ok ? null : (read as { reason: string }).reason;
}
/** The read value; only meaningful when {@link sectionError} is null. */
export function sectionValue<T>(read: SectionRead<T>): T {
  return (read as { value: T }).value;
}

export interface AutopilotRead {
  paused: AutopilotPauseState;
  latestRun: { id: string; status: string; startedEpoch: number } | null;
}

export interface WaitingItem {
  title: string;
  url: string;
  bucket: string;
  /** The registry-resolved recommended command / route / label. */
  action: string;
}

export interface BriefSources {
  sinceMs: number;
  merges: SectionRead<MergeItem[]>;
  qa: SectionRead<Record<string, number>>;
  waiting: SectionRead<WaitingItem[]>;
  autopilot: SectionRead<AutopilotRead>;
  usage: SectionRead<UsageLike>;
  builderHealth: SectionRead<BuilderHealthLike | null>;
  items: SectionRead<BriefItem[]>;
  pages: SectionRead<DedupStateRow[]>;
  /** Absent when the brief is not a Monday brief. */
  weekly: SectionRead<WeeklySummary | null> | null;
}

const MERGE_LIMIT = 50;
const BRIEF_ITEM_LIMIT = 500;
const QA_CLASSES: ReadonlySet<string> = new Set(["qa_orch", "qa_target"]);
const WAITING_BUCKETS: ReadonlySet<string> = new Set(["waiting-on-you", "target-items"]);

async function settle<T>(section: string, read: () => Promise<T>): Promise<SectionRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err: any) {
    const reason = String(err?.message ?? err);
    logger.error({ section, err }, "[MorningBrief] section reader failed — degrading to n/a");
    return { ok: false, reason };
  }
}

function actionCommand(action: AttentionFeedResult["items"][number]["action"]): string {
  const a = action.recommended;
  if (a.kind === "terminal-skill") return a.command;
  if (a.kind === "in-dashboard") return `${a.method} ${a.route}`;
  return a.label;
}

/**
 * Read every section's evidence since `sinceMs`. Sections are read in
 * parallel and degrade independently. `includeWeekly` adds the Monday weekly
 * summary (null when no metrics were recorded in the last 7 days).
 */
export async function readBriefSources(opts: {
  sinceMs: number;
  includeWeekly: boolean;
  deps?: BriefSourcesDeps;
}): Promise<BriefSources> {
  const d = opts.deps ?? {};
  const sinceMs = opts.sinceMs;
  const getRecentMerges = d.getRecentMerges ?? ((n) => defaultGetRecentMerges(n));
  const listDispatchOutcomes = d.listDispatchOutcomes ?? defaultListDispatchOutcomes;
  const getAttentionFeed = d.getAttentionFeed ?? (() => defaultGetAttentionFeed());
  const getAutopilotPaused = d.getAutopilotPaused ?? defaultGetAutopilotPaused;
  const listRecentAutopilotRunIds = d.listRecentAutopilotRunIds ?? defaultListRecentAutopilotRunIds;
  const getAutopilotRun = d.getAutopilotRun ?? defaultGetAutopilotRun;
  const getUsage = d.getUsage ?? (() => defaultGetUsage());
  // The brief reads a loose subset of the scorecard (autonomy + the stagnation
  // panel's `state` cells), typed structurally so a test stub needs no full
  // scorecard; the real reader is widened at this one boundary.
  const getBuilderHealthScorecard =
    d.getBuilderHealthScorecard ??
    (async () => (await defaultGetBuilderHealthScorecard()) as unknown as BuilderHealthLike);
  const readBriefItems = d.readBriefItems ?? defaultReadBriefItems;
  const listDedupStates = d.listDedupStates ?? defaultListDedupStates;
  const buildWeeklySummary = d.buildWeeklySummary ?? (() => defaultBuildWeeklySummary());

  const [merges, qa, waiting, autopilot, usage, builderHealth, items, pages, weekly] = await Promise.all([
    settle("merges", async () =>
      (await getRecentMerges(MERGE_LIMIT)).filter((m) => (Date.parse(m.mergedAt) || 0) > sinceMs),
    ),
    settle("qa", async () => {
      const res = (await listDispatchOutcomes({ sinceMs })) as {
        ok: boolean;
        error?: string;
        records?: Array<{ className: string | null; outcome: string }>;
      };
      if (!res.ok) throw new Error(res.error ?? "listDispatchOutcomes failed");
      const counts: Record<string, number> = {};
      for (const rec of res.records ?? []) {
        if (!rec.className || !QA_CLASSES.has(rec.className)) continue;
        const key = rec.outcome || "unknown";
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    }),
    settle("waiting", async () => {
      const feed = await getAttentionFeed();
      return feed.items
        .filter((i) => WAITING_BUCKETS.has(i.bucket) && !i.dismissed)
        .map((i) => ({ title: i.title, url: i.url, bucket: i.bucket, action: actionCommand(i.action) }));
    }),
    settle("autopilot", async () => {
      const paused = await getAutopilotPaused();
      const [latestId] = await listRecentAutopilotRunIds(1);
      if (!latestId) return { paused, latestRun: null };
      const run = await getAutopilotRun(latestId);
      const status = run.status || (run.ended ? "ended" : "running");
      return { paused, latestRun: { id: latestId, status, startedEpoch: Number(run.started_epoch || 0) } };
    }),
    settle("usage", () => getUsage()),
    settle("builderHealth", () => getBuilderHealthScorecard()),
    settle("items", async () => {
      const raw = await readBriefItems(BRIEF_ITEM_LIMIT);
      const out: BriefItem[] = [];
      for (const r of raw) {
        const item = briefItemFromStored(r);
        if (item && item.at > sinceMs) out.push(item);
      }
      return out;
    }),
    settle("pages", () => listDedupStates()),
    opts.includeWeekly ? settle("weekly", () => buildWeeklySummary()) : Promise.resolve(null),
  ]);

  return { sinceMs, merges, qa, waiting, autopilot, usage, builderHealth, items, pages, weekly };
}
