/**
 * The Morning Brief (ADR-0045 Decision 7, issue #5047).
 *
 * One daily message, sent even when every section is empty, carrying:
 *   1. Overnight — orchestrator merges and QA verdicts since the last brief;
 *   2. Waiting on you — attention-feed items with their registry-resolved
 *      recommended action (ADR-0034 §8) and link;
 *   3. Autopilot & quota — pause state, latest run, 5h / weekly usage;
 *   4. Builder health — one autonomy + stagnation line;
 *   5. Events since last brief — brief-severity items grouped by kind through
 *      the exhaustive `BRIEF_LINE_RENDERERS` map;
 *   6. Pages — currently-bad dedup keys with their suppressed counts;
 *   7. (Monday only) the weekly summary.
 *
 * `composeBrief` is PURE over already-read {@link BriefSources}; the readers
 * live in `brief-sources.ts`, the HTML in `brief-render.ts`, the 07:30 timing
 * in `brief-scheduler.ts`. {@link sendMorningBrief} is the one send path: it
 * never drains or mutates the brief-item list (a send-now and the scheduled
 * send are idempotent reads of the same evidence, filtered by `at >
 * lastSentAt`), and it reports the transport outcome so the scheduler stamps
 * last-sent only after a delivered send. {@link morningBriefScheduler} is the
 * process-wide scheduler bound to this send path.
 */

import { sendHtmlToTelegram, type TelegramTransportFn } from "../notify.ts";
import { appendLog as defaultAppendLog, type DeliveryLogEntry, type DeliveryOutcome } from "../redis/operator-channel.ts";
import { logger } from "../logger.ts";
import { renderBriefLine } from "./brief-lines.ts";
import { renderBrief, type BriefModel, type BriefSection } from "./brief-render.ts";
import {
  readBriefSources,
  sectionError,
  sectionValue,
  type BriefSources,
  type BriefSourcesDeps,
  type StagnationLike,
} from "./brief-sources.ts";
import { BriefScheduler, localParts } from "./brief-scheduler.ts";

export const BRIEF_DEDUP_KEY = "morning-brief";
/** Items window when no last-sent key exists yet (first brief ever). */
export const BRIEF_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WAITING = 12;
const MAX_MERGES = 15;
const MAX_EVENT_LINES = 20;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ageLabel(fromEpochSec: number, nowMs: number): string {
  if (!(fromEpochSec > 0)) return "?";
  const min = Math.max(0, Math.round((nowMs / 1000 - fromEpochSec) / 60));
  if (min < 60) return `${min}m ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (24 * 60))}d ago`;
}

const naLine = (label: string, reason: string) => `${label}: n/a (${reason})`;

function overnightSection(s: BriefSources): BriefSection {
  const lines: string[] = [];
  const links: NonNullable<BriefSection["links"]> = [];
  const mergesErr = sectionError(s.merges);
  if (mergesErr !== null) lines.push(naLine("Merges", mergesErr));
  else {
    const merges = sectionValue(s.merges);
    lines.push(`Merges: ${merges.length}`);
    for (const m of merges.slice(0, MAX_MERGES)) links.push({ label: `#${m.prNumber} ${m.title}`, url: m.url });
    if (merges.length > MAX_MERGES) lines.push(`… +${merges.length - MAX_MERGES} more merges`);
  }
  const qaErr = sectionError(s.qa);
  if (qaErr !== null) lines.push(naLine("QA", qaErr));
  else {
    const entries = Object.entries(sectionValue(s.qa)).sort(([a], [b]) => a.localeCompare(b));
    lines.push(entries.length === 0 ? "QA: no verdicts" : `QA: ${entries.map(([k, n]) => `${n} ${k}`).join(", ")}`);
  }
  return { heading: "Overnight", lines, links };
}

function waitingSection(s: BriefSources): BriefSection {
  const err = sectionError(s.waiting);
  if (err !== null) return { heading: "Waiting on you", lines: [naLine("Items", err)] };
  const items = sectionValue(s.waiting);
  const lines: string[] = [];
  const links: NonNullable<BriefSection["links"]> = [];
  for (const w of items.slice(0, MAX_WAITING)) {
    lines.push(`${w.title} → ${w.action}`);
    links.push({ label: w.title, url: w.url });
  }
  if (items.length > MAX_WAITING) lines.push(`… +${items.length - MAX_WAITING} more`);
  return { heading: `Waiting on you (${items.length})`, lines, links };
}

function autopilotSection(s: BriefSources, nowMs: number): BriefSection {
  const lines: string[] = [];
  const apErr = sectionError(s.autopilot);
  if (apErr !== null) lines.push(naLine("Autopilot", apErr));
  else {
    const a = sectionValue(s.autopilot);
    const pause = a.paused.paused
      ? `PAUSED${a.paused.since ? ` since ${new Date(a.paused.since).toISOString()}` : ""}`
      : "running";
    const run = a.latestRun
      ? `last run ${a.latestRun.status} — started ${ageLabel(a.latestRun.startedEpoch, nowMs)}`
      : "⚠️ no recent run indexed";
    lines.push(`Autopilot: ${pause}; ${run}`);
  }
  const uErr = sectionError(s.usage);
  if (uErr !== null) lines.push(naLine("Usage", uErr));
  else {
    const u = sectionValue(s.usage);
    if (!u.calibrated) lines.push("Usage: uncalibrated (quota env vars unset)");
    else {
      const stop5h = u.emergencyStop ? " 🛑" : "";
      const stopWk = u.weeklyEmergencyStop ? " 🛑" : "";
      lines.push(
        `Usage: 5h ${(u.percentLast5h ?? 0).toFixed(0)}%${stop5h} · weekly ${(u.percentSinceReset ?? 0).toFixed(0)}%${stopWk} (caps at 90%)`,
      );
    }
  }
  return { heading: "Autopilot & quota", lines };
}

/** One-line stagnation glance: breached/instrumented, warming, window cycles. */
export function stagnationLine(panel: StagnationLike | null | undefined): string {
  if (!panel || !panel.signals) return "no instrumented stagnation signals";
  let breached = 0;
  let warming = 0;
  let instrumented = 0;
  for (const realms of Object.values(panel.signals)) {
    if (!realms) continue;
    for (const r of Object.values(realms)) {
      if (!r) continue;
      instrumented++;
      if (r.state === "breach") breached++;
      else if (r.state === "warming") warming++;
    }
  }
  if (instrumented === 0) return "no instrumented stagnation signals";
  const cycles = Number.isFinite(panel.windowContext?.cycles) ? panel.windowContext!.cycles : 0;
  return `stagnation ${breached}/${instrumented} breached${breached > 0 ? " ⚠️" : ""}, ${warming} warming (${cycles} cycles)`;
}

function builderHealthSection(s: BriefSources): BriefSection {
  const err = sectionError(s.builderHealth);
  if (err !== null) return { heading: "Builder health", lines: [naLine("Scorecard", err)] };
  const bh = sectionValue(s.builderHealth);
  const auto = bh?.autonomyRate;
  const autonomy = auto && auto.total > 0
    ? `autonomy ${auto.autonomous}/${auto.total} auto-merged (last ${auto.window})`
    : "no merges in window";
  return { heading: "Builder health", lines: [`${autonomy}; ${stagnationLine(bh?.stagnation)}`] };
}

function eventsSection(s: BriefSources): BriefSection {
  const err = sectionError(s.items);
  if (err !== null) return { heading: "Events since last brief", lines: [naLine("Events", err)] };
  const items = sectionValue(s.items);
  const byKind = new Map<string, number>();
  for (const it of items) byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
  const lines: string[] = [];
  // Newest-first list; render the newest N with a per-kind count prefix.
  for (const it of items.slice(0, MAX_EVENT_LINES)) {
    const n = byKind.get(it.kind) ?? 1;
    lines.push(`${n > 1 ? `[${n}× ${it.kind}] ` : ""}${renderBriefLine(it)}`);
  }
  if (items.length > MAX_EVENT_LINES) lines.push(`… +${items.length - MAX_EVENT_LINES} more events`);
  return { heading: `Events since last brief (${items.length})`, lines };
}

function pagesSection(s: BriefSources): BriefSection {
  const err = sectionError(s.pages);
  if (err !== null) return { heading: "Pages", lines: [naLine("Open pages", err)] };
  const pages = sectionValue(s.pages);
  const lines = pages.map(
    (p) => `${p.dedupKey}: still bad since ${new Date(p.firstAt).toISOString()}, ${p.suppressed} suppressed`,
  );
  return { heading: `Pages (${pages.length} open)`, lines: lines.length > 0 ? lines : ["no open pages"] };
}

function weeklySection(s: BriefSources): BriefSection | null {
  if (!s.weekly) return null;
  const err = sectionError(s.weekly);
  if (err !== null) return { heading: "Weekly summary", lines: [naLine("Weekly", err)] };
  const weekly = sectionValue(s.weekly);
  return {
    heading: "Weekly summary",
    lines: weekly ? weekly.lines : ["no metrics recorded in the last 7 days"],
  };
}

/** Pure composition of the already-read sources into the plain-text model. */
export function composeBrief(sources: BriefSources, ctx: { now: number; lastSentAt: number | null }): BriefModel {
  const parts = localParts(ctx.now);
  const sinceLabel = ctx.lastSentAt === null ? "the last 24h" : `last brief ${new Date(ctx.lastSentAt).toISOString()}`;
  const sections: BriefSection[] = [
    overnightSection(sources),
    waitingSection(sources),
    autopilotSection(sources, ctx.now),
    builderHealthSection(sources),
    eventsSection(sources),
    pagesSection(sources),
  ];
  const weekly = weeklySection(sources);
  if (weekly) sections.push(weekly);
  return { dateLabel: `${WEEKDAYS[parts.weekday]} ${parts.dateKey}`, sinceLabel, sections };
}

export interface SendBriefDeps {
  now?: () => number;
  transport?: TelegramTransportFn;
  appendLog?: (entry: DeliveryLogEntry) => Promise<void>;
  sources?: BriefSourcesDeps;
}

export interface SendBriefResult {
  ok: boolean;
  outcome: DeliveryOutcome;
  at: number;
  text: string;
}

/**
 * Build, render and send the brief. `lastSentAt === null` reads a 24h window.
 * Monday (local weekday 1) appends the weekly summary. Every send is logged
 * with kind `brief` in the delivery log; the log write is best-effort.
 * Never throws for transport or Redis failure.
 */
export async function sendMorningBrief(opts: { lastSentAt: number | null; deps?: SendBriefDeps }): Promise<SendBriefResult> {
  const d = opts.deps ?? {};
  const now = d.now ?? (() => Date.now());
  const transport = d.transport ?? sendHtmlToTelegram;
  const appendLog = d.appendLog ?? defaultAppendLog;
  const at = now();
  const parts = localParts(at);
  const sinceMs = opts.lastSentAt ?? at - BRIEF_DEFAULT_WINDOW_MS;

  const sources = await readBriefSources({ sinceMs, includeWeekly: parts.weekday === 1, deps: d.sources });
  const text = renderBrief(composeBrief(sources, { now: at, lastSentAt: opts.lastSentAt }));

  const result = await transport(text);
  // (tsconfig is non-strict, so `ok` does not narrow the union: read via a view.)
  const view = result as { ok: boolean; mode?: string; reason?: string; status?: number };
  let outcome: DeliveryOutcome;
  if (view.ok) outcome = view.mode === "plain" ? "sent-plain" : "sent-html";
  else if (view.reason === "no-credentials") outcome = "skipped-no-credentials";
  else outcome = "failed";

  const entry: DeliveryLogEntry = {
    at,
    kind: "brief",
    dedupKey: BRIEF_DEDUP_KEY,
    title: `Morning Brief ${parts.dateKey}`,
    outcome,
    ...(outcome === "failed" ? { status: view.status } : {}),
  };
  try {
    await appendLog(entry);
  } catch (err) {
    logger.error({ err }, "[MorningBrief] delivery-log append failed — brief result unaffected");
  }
  if (!view.ok) logger.error({ outcome, status: view.status }, "[MorningBrief] send not delivered");
  else logger.info({ outcome, chars: text.length }, "[MorningBrief] sent");
  return { ok: view.ok, outcome, at, text };
}

/** The process-wide scheduler the heartbeat ticks and the send-now route drives. */
export const morningBriefScheduler = new BriefScheduler({ send: (opts) => sendMorningBrief(opts) });
