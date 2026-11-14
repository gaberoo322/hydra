/**
 * scripts/ops-collect-logic.ts — pure collectors behind the operator
 * diagnostics CLI (`scripts/ops-collect.ts`). Playbooks (hydra-architect today,
 * doctor/digest later) call the CLI instead of parsing JSON inline.
 *
 * Every collector is pure over already-fetched raw data and never throws: it
 * returns `{ ok: true, data } | { ok: false, code, reason }`. I/O (HTTP, Redis,
 * gh) lives in the CLI shell, which feeds raw values in here.
 */

export type CollectorResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; reason: string };

function fail<T>(code: string, reason: string): CollectorResult<T> {
  return { ok: false, code, reason };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface CycleSummary {
  cycles: number;
  merged: number;
  failed: number;
  abandoned: number;
  mergeRatePct: number;
  avgDurationSec: number | null;
  medianDurationSec: number | null;
  testsFirst: number;
  testsLast: number;
  testsDelta: number;
  anchors: Record<string, number>;
  repeatedTasks: Array<{ title: string; count: number }>;
  coverage: { recordedClasses: string[]; classesNotRecorded: string[] } | null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Summarise a `/api/metrics` response (newest cycle first in `trend`). */
export function collectCycles(raw: unknown): CollectorResult<CycleSummary> {
  if (raw === null || typeof raw !== "object") {
    return fail("bad-input", "metrics response is not an object");
  }
  const body = raw as Record<string, unknown>;
  const trend = Array.isArray(body.trend)
    ? (body.trend as Array<Record<string, unknown>>)
    : Array.isArray(body.metrics)
      ? (body.metrics as Array<Record<string, unknown>>)
      : null;
  if (trend === null) return fail("bad-input", "metrics response has no trend array");
  if (trend.length === 0) return fail("no-data", "no cycle metrics recorded");

  const count = (key: string) => trend.filter((m) => num(m[key]) > 0).length;
  const durations = trend
    .map((m) => num(m.totalDurationMs))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const anchors: Record<string, number> = {};
  const titles = new Map<string, number>();
  for (const m of trend) {
    const a = typeof m.anchorType === "string" && m.anchorType ? m.anchorType : "unknown";
    anchors[a] = (anchors[a] ?? 0) + 1;
    const t = typeof m.taskTitle === "string" ? m.taskTitle : "";
    if (t) titles.set(t, (titles.get(t) ?? 0) + 1);
  }
  const merged = count("tasksMerged");
  const testsLast = num(trend[0].testsAfter);
  const testsFirst = num(trend[trend.length - 1].testsAfter);
  const cov = body.coverage as Record<string, unknown> | undefined;
  return {
    ok: true,
    data: {
      cycles: trend.length,
      merged,
      failed: count("tasksFailed"),
      abandoned: count("tasksAbandoned"),
      mergeRatePct: Math.floor((100 * merged) / trend.length),
      avgDurationSec: durations.length
        ? Math.floor(durations.reduce((a, b) => a + b, 0) / durations.length / 1000)
        : null,
      medianDurationSec: durations.length ? Math.floor(durations[Math.floor(durations.length / 2)] / 1000) : null,
      testsFirst,
      testsLast,
      testsDelta: testsLast - testsFirst,
      anchors,
      repeatedTasks: [...titles].filter(([, c]) => c > 1).map(([title, c]) => ({ title, count: c })),
      coverage: cov
        ? { recordedClasses: strings(cov.recordedClasses), classesNotRecorded: strings(cov.classesNotRecorded) }
        : null,
    },
  };
}

export interface MemorySummary {
  agent: string;
  patterns: number;
  totalHits: number;
}

/** Summarise one agent's consolidated `:patterns` JSON string (null = key absent). */
export function collectAgentMemory(agent: string, raw: string | null): CollectorResult<MemorySummary> {
  if (raw === null || raw === "") return { ok: true, data: { agent, patterns: 0, totalHits: 0 } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail("parse-error", `${agent}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) return fail("parse-error", `${agent}: patterns value is not an array`);
  const totalHits = parsed.reduce(
    (s: number, p: unknown) => s + num((p as Record<string, unknown> | null)?.hitCount),
    0,
  );
  return { ok: true, data: { agent, patterns: parsed.length, totalHits } };
}

/** Distinct non-null `learningAgent` values of a classes.json document. */
export function learningAgents(classesDoc: unknown): string[] {
  const rows = (classesDoc as { classes?: unknown } | null)?.classes;
  if (!Array.isArray(rows)) return [];
  const out = new Set<string>();
  for (const r of rows) {
    const a = (r as Record<string, unknown> | null)?.learningAgent;
    if (typeof a === "string" && a) out.add(a);
  }
  return [...out].sort();
}

/** Count open issues per label from `gh issue list --json labels`. */
export function collectBoard(raw: unknown): CollectorResult<{ open: number; byLabel: Record<string, number> }> {
  if (!Array.isArray(raw)) return fail("bad-input", "issue list is not an array");
  const byLabel: Record<string, number> = {};
  for (const issue of raw) {
    const labels = (issue as { labels?: unknown } | null)?.labels;
    if (!Array.isArray(labels)) continue;
    for (const l of labels) {
      const name = typeof l === "string" ? l : (l as { name?: unknown } | null)?.name;
      if (typeof name === "string") byLabel[name] = (byLabel[name] ?? 0) + 1;
    }
  }
  return { ok: true, data: { open: raw.length, byLabel } };
}

export interface SchedulerSummary {
  running: boolean;
  cyclesRun: number;
  consecutiveErrors: number;
}

/** Summarise `/api/scheduler/status`. */
export function collectScheduler(raw: unknown): CollectorResult<SchedulerSummary> {
  if (raw === null || typeof raw !== "object") return fail("bad-input", "scheduler status is not an object");
  const s = raw as Record<string, unknown>;
  return {
    ok: true,
    data: { running: s.running === true, cyclesRun: num(s.cyclesRun), consecutiveErrors: num(s.consecutiveErrors) },
  };
}

/** Render one collector result as a single text line. */
export function renderText(name: string, result: CollectorResult<unknown>): string {
  if (!result.ok) return `${name}: ${result.code} (${result.reason})`;
  return `${name}: ${JSON.stringify(result.data)}`;
}
