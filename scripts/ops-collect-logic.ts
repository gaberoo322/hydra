/**
 * scripts/ops-collect-logic.ts — pure collectors behind the operator
 * diagnostics CLI (`scripts/ops-collect.ts`). The doctor, digest and architect
 * playbooks call the CLI instead of parsing JSON inline.
 *
 * Every collector is pure over already-fetched raw data and never throws: it
 * returns one {@link CollectorResult}. I/O (HTTP, Redis, gh, systemctl,
 * journalctl, git, fs) lives in the CLI shell, which feeds raw values in here.
 */
import {
  DEFAULT_REDIS_BACKUP_DIR,
  DEFAULT_REDIS_BACKUP_STALE_HOURS,
  decideRedisBackup,
} from "../src/watchdog/redis-backup.ts";

/** A failed or skipped collector. `skipped` marks "not applicable here", not an error. */
export interface CollectorFailure {
  ok: false;
  code: string;
  reason: string;
  skipped?: true;
}

export type CollectorResult<T> = { ok: true; data: T } | CollectorFailure;

/** A collector that ran and failed. */
export function fail(code: string, reason: string): CollectorFailure {
  return { ok: false, code, reason };
}

/** A collector that does not apply (unresolved Target, missing Target capability). */
export function skip(code: string, reason: string): CollectorFailure {
  return { ok: false, skipped: true, code, reason };
}

/** Days a module may sit wire-or-retire before it counts as past grace. */
export const WIRING_GRACE_DAYS = 45;
/** Soft SLO: days past grace a wire-or-retire module may wait for a verdict. */
export const WIRING_SLO_DAYS = 30;
/** Hours after which the newest Redis backup is stale. */
export const REDIS_BACKUP_STALE_HOURS = DEFAULT_REDIS_BACKUP_STALE_HOURS;
/** Directory the Redis backup timer writes into. */
export const REDIS_BACKUP_DIR = DEFAULT_REDIS_BACKUP_DIR;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function objects(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v.map(obj).filter((x) => x !== null) as Array<Record<string, unknown>>) : [];
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

export interface TargetSummary {
  resolved: boolean;
  name: string | null;
  note: string;
}

/** Summarise the Target identity facts; unresolved when name or workspace is empty. */
export function summariseTarget(facts: unknown): TargetSummary {
  const f = obj(facts);
  const name = str(f?.name);
  const workspace = str(f?.workspace);
  if (!name || !workspace) {
    return { resolved: false, name: name || null, note: "Target unresolved (config/target.json name or workspace missing)" };
  }
  const manifest = obj(f?.manifest);
  const manifestNote = manifest?.ok === false ? `; manifest invalid: ${strings(manifest.errors).join("; ")}` : "";
  return {
    resolved: true,
    name,
    note: `name=${name} ws=${workspace} service=${str(f?.serviceName) || "<unresolved>"}${manifestNote}`,
  };
}

// ---------------------------------------------------------------------------
// cycles
// ---------------------------------------------------------------------------

export interface CycleSummary {
  cycles: number;
  merged: number;
  failed: number;
  abandoned: number;
  mergeRatePct: number;
  fixes: number;
  features: number;
  avgDurationSec: number | null;
  medianDurationSec: number | null;
  maxDurationSec: number | null;
  avgCostUsd: number | null;
  totalCostUsd: number | null;
  testsFirst: number;
  testsLast: number;
  testsDelta: number;
  anchors: Record<string, number>;
  repeatedTasks: Array<{ title: string; count: number }>;
  recent: Array<{ status: "merged" | "failed" | "abandoned"; title: string }>;
  coverage: { recordedClasses: string[]; classesNotRecorded: string[] } | null;
}

const FIX_ANCHORS = new Set(["prior-failure", "failing-test"]);

/** Summarise a `/api/metrics` response (newest cycle first in `trend`). */
export function collectCycles(raw: unknown): CollectorResult<CycleSummary> {
  const body = obj(raw);
  if (!body) return fail("bad-input", "metrics response is not an object");
  const rawTrend = Array.isArray(body.trend) ? body.trend : Array.isArray(body.metrics) ? body.metrics : null;
  if (rawTrend === null) return fail("bad-input", "metrics response has no trend array");
  const trend = objects(rawTrend);
  if (trend.length === 0) return fail("no-data", "no cycle metrics recorded");

  const count = (key: string) => trend.filter((m) => num(m[key]) > 0).length;
  const durations = trend
    .map((m) => num(m.totalDurationMs))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const costs = trend.map((m) => num(m.costUsd)).filter((c) => c > 0);
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const anchors: Record<string, number> = {};
  const titles = new Map<string, number>();
  for (const m of trend) {
    const a = str(m.anchorType) || "unknown";
    anchors[a] = (anchors[a] ?? 0) + 1;
    const t = str(m.taskTitle);
    if (t) titles.set(t, (titles.get(t) ?? 0) + 1);
  }
  const merged = count("tasksMerged");
  const fixes = trend.filter((m) => num(m.tasksMerged) > 0 && FIX_ANCHORS.has(str(m.anchorType))).length;
  const testsLast = num(trend[0].testsAfter);
  const testsFirst = num(trend[trend.length - 1].testsAfter);
  const cov = obj(body.coverage);
  return {
    ok: true,
    data: {
      cycles: trend.length,
      merged,
      failed: count("tasksFailed"),
      abandoned: count("tasksAbandoned"),
      mergeRatePct: Math.floor((100 * merged) / trend.length),
      fixes,
      features: merged - fixes,
      avgDurationSec: durations.length
        ? Math.floor(durations.reduce((a, b) => a + b, 0) / durations.length / 1000)
        : null,
      medianDurationSec: durations.length ? Math.floor(durations[Math.floor(durations.length / 2)] / 1000) : null,
      maxDurationSec: durations.length ? Math.floor(durations[durations.length - 1] / 1000) : null,
      avgCostUsd: costs.length ? Math.round((totalCost / costs.length) * 100) / 100 : null,
      totalCostUsd: costs.length ? Math.round(totalCost * 100) / 100 : null,
      testsFirst,
      testsLast,
      testsDelta: testsLast - testsFirst,
      anchors,
      repeatedTasks: [...titles].filter(([, c]) => c > 1).map(([title, c]) => ({ title, count: c })),
      recent: trend.slice(0, 5).map((m) => ({
        status: num(m.tasksMerged) > 0 ? "merged" : num(m.tasksFailed) > 0 ? "failed" : "abandoned",
        title: (str(m.taskTitle) || "?").slice(0, 80),
      })),
      coverage: cov
        ? { recordedClasses: strings(cov.recordedClasses), classesNotRecorded: strings(cov.classesNotRecorded) }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

export interface MemorySummary {
  agent: string;
  patterns: number;
  totalHits: number;
  bytes: number;
  lastSeen: string | null;
  topCategories: Array<{ category: string; hits: number }>;
}

/** Summarise one agent's consolidated `:patterns` JSON string (null = key absent). */
export function collectAgentMemory(agent: string, raw: string | null): CollectorResult<MemorySummary> {
  if (raw === null || raw === "") {
    return { ok: true, data: { agent, patterns: 0, totalHits: 0, bytes: 0, lastSeen: null, topCategories: [] } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    /* intentional: error is returned as the collector result, not swallowed */
    return fail("parse-error", `${agent}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) return fail("parse-error", `${agent}: patterns value is not an array`);
  const rows = objects(parsed);
  const cats = new Map<string, number>();
  let lastSeen = "";
  for (const p of rows) {
    const c = str(p.category) || "?";
    cats.set(c, (cats.get(c) ?? 0) + num(p.hitCount));
    if (str(p.lastSeen) > lastSeen) lastSeen = str(p.lastSeen);
  }
  return {
    ok: true,
    data: {
      agent,
      patterns: parsed.length,
      totalHits: rows.reduce((s, p) => s + num(p.hitCount), 0),
      bytes: raw.length,
      lastSeen: lastSeen || null,
      topCategories: [...cats]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([category, hits]) => ({ category, hits })),
    },
  };
}

/** One agent's raw read: the `:patterns` string (null = key absent) or the read error. */
export type AgentMemoryRead = { agent: string; raw: string | null } | { agent: string; error: string };

export interface MemoryReport {
  agents: MemorySummary[];
  failed: Array<{ agent: string; code: string; reason: string }>;
}

/**
 * Summarise every learning agent's memory as ONE result: ok while at least one
 * agent was read, a single failure when none could be.
 */
export function collectMemory(reads: AgentMemoryRead[]): CollectorResult<MemoryReport> {
  if (reads.length === 0) return fail("no-agents", "the class taxonomy names no learning agent");
  const report: MemoryReport = { agents: [], failed: [] };
  for (const r of reads) {
    if ("error" in r) {
      report.failed.push({ agent: r.agent, code: "redis-error", reason: r.error });
      continue;
    }
    const one = collectAgentMemory(r.agent, r.raw);
    if (one.ok === false) report.failed.push({ agent: r.agent, code: one.code, reason: one.reason });
    else report.agents.push(one.data);
  }
  if (report.agents.length === 0) {
    return fail("memory-unavailable", report.failed.map((f) => `${f.agent}: ${f.reason}`).join("; "));
  }
  return { ok: true, data: report };
}

/** Distinct non-null `learningAgent` values of a classes.json document. */
export function learningAgents(classesDoc: unknown): string[] {
  const out = new Set<string>();
  for (const r of objects(obj(classesDoc)?.classes)) {
    const a = str(r.learningAgent);
    if (a) out.add(a);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

export interface BoardSummary {
  open: number;
  /** True when the read hit its row limit, so counts are a floor. */
  truncated: boolean;
  byLabel: Record<string, number>;
  /** Up to three issues per label, in read order. */
  samples: Record<string, Array<{ number: number; title: string }>>;
}

/** Count open issues per label. `limit` is the row limit the read was made with. */
export function collectBoard(raw: unknown, limit?: number): CollectorResult<BoardSummary> {
  if (!Array.isArray(raw)) return fail("bad-input", "issue list is not an array");
  const byLabel: Record<string, number> = {};
  const samples: BoardSummary["samples"] = {};
  for (const issue of objects(raw)) {
    if (!Array.isArray(issue.labels)) continue;
    for (const l of issue.labels) {
      const name = typeof l === "string" ? l : str(obj(l)?.name);
      if (!name) continue;
      byLabel[name] = (byLabel[name] ?? 0) + 1;
      const list = (samples[name] ??= []);
      if (list.length < 3 && issue.number !== undefined) {
        list.push({ number: num(issue.number), title: str(issue.title).slice(0, 80) });
      }
    }
  }
  return {
    ok: true,
    data: { open: raw.length, truncated: limit !== undefined && raw.length >= limit, byLabel, samples },
  };
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

export interface SchedulerSummary {
  running: boolean;
  cyclesRun: number;
  consecutiveErrors: number;
}

/** Summarise `/api/scheduler/status`. */
export function collectScheduler(raw: unknown): CollectorResult<SchedulerSummary> {
  const s = obj(raw);
  if (!s) return fail("bad-input", "scheduler status is not an object");
  return {
    ok: true,
    data: { running: s.running === true, cyclesRun: num(s.cyclesRun), consecutiveErrors: num(s.consecutiveErrors) },
  };
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

export interface AlertsSummary {
  scanned: number;
  active: number;
  bySeverity: Record<string, number>;
  recent: Array<{ severity: string; timestamp: string; type: string; message: string }>;
}

/** Summarise `/api/alerts`: undismissed alerts by severity, ten most recent. */
export function collectAlerts(raw: unknown): CollectorResult<AlertsSummary> {
  const list = Array.isArray(raw) ? raw : obj(raw)?.alerts;
  if (!Array.isArray(list)) return fail("bad-input", "alerts response has no alerts array");
  const active = objects(list).filter((a) => a.dismissed !== true);
  const bySeverity: Record<string, number> = {};
  for (const a of active) {
    const sev = str(a.severity) || "unknown";
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
  return {
    ok: true,
    data: {
      scanned: list.length,
      active: active.length,
      bySeverity,
      recent: active.slice(0, 10).map((a) => ({
        severity: str(a.severity) || "unknown",
        timestamp: str(a.timestamp),
        type: str(a.type),
        message: str(a.message).slice(0, 120),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// redis-server
// ---------------------------------------------------------------------------

export interface RedisServerSummary {
  usedMemoryBytes: number | null;
  usedMemoryHuman: string | null;
  maxMemoryHuman: string | null;
  keys: number | null;
}

/** Summarise a Redis `INFO memory` text and a DBSIZE reply. */
export function collectRedisServer(info: unknown, dbsize: unknown): CollectorResult<RedisServerSummary> {
  if (typeof info !== "string") return fail("bad-input", "INFO memory reply is not text");
  const field = (name: string): string | null => {
    const m = info.match(new RegExp(`^${name}:(.*)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const used = field("used_memory");
  if (used === null) return fail("bad-input", "INFO memory reply has no used_memory field");
  const keys = Number(dbsize);
  return {
    ok: true,
    data: {
      usedMemoryBytes: Number.isFinite(Number(used)) ? Number(used) : null,
      usedMemoryHuman: field("used_memory_human"),
      maxMemoryHuman: field("maxmemory_human"),
      keys: dbsize !== null && dbsize !== undefined && Number.isFinite(keys) ? keys : null,
    },
  };
}

// ---------------------------------------------------------------------------
// timers
// ---------------------------------------------------------------------------

/** One live timer as the Host-Probe Adapter reports it (epoch microseconds, 0 = none). */
export interface LiveTimer {
  unit: string;
  last: number;
  next: number;
}

export interface TimerRow {
  unit: string;
  /** `systemctl is-enabled` state word; null when it could not be read. */
  enabled: string | null;
  loaded: boolean;
  last: string | null;
  next: string | null;
}

export interface TimersSummary {
  repo: TimerRow[];
  findings: string[];
  target:
    | { status: "skipped"; reason: string }
    | { status: "none"; pattern: string }
    | { status: "ok"; pattern: string; timers: TimerRow[] };
  liveReadError: string | null;
}

/** Repo-owned timer units: every `*.timer` file name of `scripts/systemd/`. */
export function repoTimerUnits(fileNames: string[]): string[] {
  return fileNames.filter((f) => f.endsWith(".timer")).sort();
}

/** Glob the Target's timers are discovered by: units named after its slug. */
export function targetTimerPattern(targetName: string): string {
  return `${targetName}-*.timer`;
}

function usToIso(us: number): string | null {
  return us > 0 ? new Date(us / 1000).toISOString() : null;
}

export interface TimersInput {
  /** File names found in `scripts/systemd/`. */
  systemdFiles: string[];
  /** `is-enabled` state per repo timer unit; null when the probe failed. */
  enabledStates: Record<string, string | null>;
  /** Live timers, or the probe failure code. */
  live: LiveTimer[] | { error: string };
  /** Resolved Target name; null when the Target is unresolved. */
  targetName: string | null;
}

/**
 * Join the repo-owned timer set (the `scripts/systemd/*.timer` glob) and the
 * resolved Target's timers against the live systemd state. Every entry of
 * `findings` is a defect: a repo timer that is not enabled, or enabled and
 * never fired, and/or enabled with no next run (both are reported). A timer
 * whose is-enabled probe was lost has `enabled: null` and yields no finding.
 */
export function collectTimers(input: TimersInput): CollectorResult<TimersSummary> {
  const units = repoTimerUnits(input.systemdFiles);
  if (units.length === 0) return fail("no-timers", "scripts/systemd holds no *.timer file");
  const liveError = Array.isArray(input.live) ? null : input.live.error;
  const live = Array.isArray(input.live) ? input.live : [];
  if (liveError !== null && units.every((u) => (input.enabledStates[u] ?? null) === null)) {
    return fail("host-probe-failed", `systemd unreadable (${liveError})`);
  }
  const byUnit = new Map(live.map((t) => [t.unit, t] as const));
  const row = (unit: string, enabled: string | null): TimerRow => {
    const t = byUnit.get(unit);
    return { unit, enabled, loaded: t !== undefined, last: t ? usToIso(t.last) : null, next: t ? usToIso(t.next) : null };
  };
  const repo = units.map((u) => row(u, input.enabledStates[u] ?? null));
  const findings: string[] = [];
  for (const r of repo) {
    // A lost is-enabled probe (null) is unknown state, never a finding.
    if (r.enabled === null) continue;
    if (r.enabled !== "enabled") {
      findings.push(`TIMER NOT ENABLED: ${r.unit} (${r.enabled})`);
      continue;
    }
    if (liveError !== null) continue;
    if (r.last === null) findings.push(`TIMER NEVER FIRED: ${r.unit}`);
    if (r.next === null) findings.push(`TIMER NOT SCHEDULED: ${r.unit}`);
  }
  let target: TimersSummary["target"];
  if (!input.targetName) {
    target = { status: "skipped", reason: "Target unresolved" };
  } else {
    const prefix = `${input.targetName}-`;
    const mine = live.filter((t) => t.unit.startsWith(prefix) && t.unit.endsWith(".timer"));
    const pattern = targetTimerPattern(input.targetName);
    target = mine.length
      ? { status: "ok", pattern, timers: mine.map((t) => row(t.unit, null)).sort((a, b) => a.unit.localeCompare(b.unit)) }
      : { status: "none", pattern };
  }
  return { ok: true, data: { repo, findings, target, liveReadError: liveError } };
}

// ---------------------------------------------------------------------------
// redis-backup
// ---------------------------------------------------------------------------

export interface RedisBackupSummary {
  dir: string;
  newest: string | null;
  ageHours: number | null;
  staleAfterHours: number;
  stale: boolean;
}

const BACKUP_NAME = /^hydra-redis-.*\.rdb\.gz$/;

/** Age of the newest Redis backup; a missing backup counts as stale. */
export function collectRedisBackup(
  files: Array<{ name: string; mtimeMs: number }>,
  nowMs: number,
): CollectorResult<RedisBackupSummary> {
  const dumps = files.filter((f) => BACKUP_NAME.test(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const base = { dir: REDIS_BACKUP_DIR, staleAfterHours: REDIS_BACKUP_STALE_HOURS };
  if (dumps.length === 0) return { ok: true, data: { ...base, newest: null, ageHours: null, stale: true } };
  // Same verdict as the freshness watchdog: stale at or past the threshold.
  const verdict = decideRedisBackup(
    { name: dumps[0].name, mtimeS: Math.floor(dumps[0].mtimeMs / 1000) },
    Math.floor(nowMs / 1000),
    REDIS_BACKUP_STALE_HOURS,
  );
  return {
    ok: true,
    data: { ...base, newest: dumps[0].name, ageHours: Math.floor(verdict.ageS / 3600), stale: verdict.stale },
  };
}

// ---------------------------------------------------------------------------
// journal-errors
// ---------------------------------------------------------------------------

export interface JournalErrorsSummary {
  unit: string;
  windowHours: number;
  matched: number;
  lines: string[];
  truncated: boolean;
  timedOut: boolean;
}

const ERROR_LINE = /error|fail|reject|crash|fatal/i;

/** The last ten error-shaped lines of a journal slice. */
export function collectJournalErrors(
  slice: { text: string; truncated?: boolean; timedOut?: boolean },
  unit: string,
  windowHours: number,
): CollectorResult<JournalErrorsSummary> {
  if (typeof slice?.text !== "string") return fail("bad-input", "journal slice has no text");
  const hits = slice.text
    .split("\n")
    .filter((l) => ERROR_LINE.test(l) && !l.includes("DeprecationWarning"));
  return {
    ok: true,
    data: {
      unit,
      windowHours,
      matched: hits.length,
      lines: hits.slice(-10).map((l) => l.slice(0, 300)),
      truncated: slice.truncated === true,
      timedOut: slice.timedOut === true,
    },
  };
}

// ---------------------------------------------------------------------------
// target-git
// ---------------------------------------------------------------------------

export interface TargetGitSummary {
  windowHours: number;
  dirtyFiles: number;
  dirtySample: string[];
  commits: number;
  commitSample: string[];
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "");
}

/** Summarise `git status --short` and `git log --oneline --since` of the Target checkout. */
export function collectTargetGit(statusOut: string, logOut: string, windowHours: number): CollectorResult<TargetGitSummary> {
  const dirty = lines(statusOut);
  const commits = lines(logOut);
  return {
    ok: true,
    data: {
      windowHours,
      dirtyFiles: dirty.length,
      dirtySample: dirty.slice(0, 10),
      commits: commits.length,
      commitSample: commits.slice(0, 10),
    },
  };
}

// ---------------------------------------------------------------------------
// kill-chain
// ---------------------------------------------------------------------------

export interface LedgerRow {
  path: string;
  status: string;
  lastTouched: string;
}

const LEDGER_ROW = /^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$/;

/** Parse the wiring ledger's table rows (path, status, reason, last-touched). */
export function parseLedger(text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(LEDGER_ROW);
    if (m) rows.push({ path: m[1].trim(), status: m[2].trim(), lastTouched: m[4].trim() });
  }
  return rows;
}

/**
 * Days a module has sat past the grace window, or null when its last-touched
 * date is not a valid `YYYY-MM-DD` (age unknown, so never flagged).
 */
export function daysPastGrace(lastTouched: string, nowMs: number): number | null {
  const m = lastTouched.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const touched = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(touched).toISOString().slice(0, 10) !== lastTouched) return null;
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - touched) / DAY_MS) - WIRING_GRACE_DAYS;
}

export interface KillChainSummary {
  /** `FLAG` when a wire-or-retire module is past the soft SLO; else `quiet`. */
  verdict: "quiet" | "FLAG";
  ledger: {
    modules: number;
    wireOrRetire: number;
    awaitingWiring: number;
    protectedProvider: number;
    oldestPastGrace: { daysPastGrace: number; path: string } | null;
    breachCount: number;
    breaches: Array<{ daysPastGrace: number; path: string }>;
  } | null;
  ledgerNote: string | null;
  baseline: {
    unusedExports: number | null;
    unreachableProductionFiles: number | null;
    testOnlyModules: number | null;
    orphanModules: number | null;
  } | null;
  baselineNote: string | null;
}

function countOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Summarise the Target's committed wiring ledger and dead-code baseline. A
 * null text means the Target does not carry that file; the matching section is
 * null with a note. The caller skips the collector when both are absent.
 */
export function collectKillChain(
  ledgerText: string | null,
  baselineText: string | null,
  nowMs: number,
): CollectorResult<KillChainSummary> {
  const out: KillChainSummary = {
    verdict: "quiet",
    ledger: null,
    ledgerNote: ledgerText === null ? "ledger absent" : null,
    baseline: null,
    baselineNote: baselineText === null ? "baseline absent" : null,
  };
  if (baselineText !== null) {
    try {
      const b = obj(JSON.parse(baselineText)) ?? {};
      out.baseline = {
        unusedExports: countOrNull(b.unusedExports),
        unreachableProductionFiles: countOrNull(b.unreachableProductionFiles),
        testOnlyModules: countOrNull(b.testOnlyModules),
        orphanModules: countOrNull(b.orphanModules),
      };
    } catch (err) {
      /* intentional: an unparseable baseline is reported in the note, the ledger still renders */
      out.baselineNote = `baseline unparseable: ${(err as Error).message}`;
    }
  }
  if (ledgerText !== null) {
    const rows = parseLedger(ledgerText);
    const wor = rows.filter((r) => r.status === "wire-or-retire");
    const ages = wor
      .map((r) => ({ daysPastGrace: daysPastGrace(r.lastTouched, nowMs), path: r.path }))
      .filter((a): a is { daysPastGrace: number; path: string } => a.daysPastGrace !== null)
      .sort((a, b) => b.daysPastGrace - a.daysPastGrace);
    const breaches = ages.filter((a) => a.daysPastGrace > WIRING_SLO_DAYS);
    out.ledger = {
      modules: rows.length,
      wireOrRetire: wor.length,
      awaitingWiring: rows.filter((r) => r.status === "awaiting-wiring").length,
      protectedProvider: rows.filter((r) => r.status === "protected-provider").length,
      oldestPastGrace: ages[0] ?? null,
      breachCount: breaches.length,
      breaches: breaches.slice(0, 5),
    };
    if (breaches.length > 0) out.verdict = "FLAG";
  }
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// reframe-saves
// ---------------------------------------------------------------------------

export interface ReframeSavesSummary {
  windowHours: number;
  count: number;
  /** Reframe-save events with no usable timestamp; excluded from `count`. */
  undateable: number;
  scanned: number;
  sample: Array<{ timestamp: string; anchorRef: string; reason: string }>;
}

const REFRAME_SAVE_TYPE = "target:reframe-save";

/**
 * Count `target:reframe-save` events of a notifications read inside the window.
 * Windows on the envelope's ISO `timestamp`; an event without a parseable one
 * is excluded and counted as undateable.
 */
export function collectReframeSaves(raw: unknown, nowMs: number, windowHours: number): CollectorResult<ReframeSavesSummary> {
  if (!Array.isArray(raw)) return fail("bad-input", "notifications read is not an array");
  const sinceMs = nowMs - windowHours * HOUR_MS;
  const saves: Array<Record<string, unknown>> = [];
  let undateable = 0;
  for (const e of objects(raw)) {
    if (e.type !== REFRAME_SAVE_TYPE) continue;
    const ms = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ms)) undateable += 1;
    else if (ms >= sinceMs) saves.push(e);
  }
  return {
    ok: true,
    data: {
      windowHours,
      count: saves.length,
      undateable,
      scanned: raw.length,
      sample: saves.slice(0, 5).map((e) => {
        const p = obj(e.payload) ?? {};
        return { timestamp: str(e.timestamp), anchorRef: str(p.anchorRef), reason: str(p.reason).slice(0, 120) };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// cost-by-class
// ---------------------------------------------------------------------------

export interface CostByClassSummary {
  date: string;
  window: unknown;
  source: string;
  totalTokens: number;
  classes: Array<{ class: string; tokens: number; sharePct: number; quotaWeight: number | null; topSkills: string[] }>;
}

/** Summarise `/api/metrics/cost-by-class`, classes ranked by tokens. */
export function collectCostByClass(raw: unknown): CollectorResult<CostByClassSummary> {
  const body = obj(raw);
  const byClass = obj(body?.byClass);
  if (!body || !byClass) return fail("bad-input", "cost-by-class response has no byClass object");
  const classes = Object.entries(byClass)
    .map(([name, v]) => {
      const c = obj(v) ?? {};
      return {
        class: name,
        tokens: num(c.tokens),
        sharePct: Math.round(num(c.fraction) * 1000) / 10,
        quotaWeight: countOrNull(c.quotaWeight),
        topSkills: objects(c.skills)
          .sort((a, b) => num(b.tokens) - num(a.tokens))
          .slice(0, 3)
          .map((s) => str(s.skill)),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
  return {
    ok: true,
    data: {
      date: str(body.date),
      window: body.window ?? null,
      source: str(body.source) || "unknown",
      totalTokens: num(body.totalTokens),
      classes,
    },
  };
}

// ---------------------------------------------------------------------------
// today
// ---------------------------------------------------------------------------

export interface TodaySummary {
  windowHours: number;
  mergeCount: number;
  runCount: number;
  costSpent: unknown;
  headroom: unknown;
  issuesOpened: number;
  /** Issues closed in the window; null when the board read failed. */
  issuesClosed: number | null;
  issuesClosedNote: string | null;
  merges: Array<{ prNumber: number; title: string; tier: string; classLabel: string; mergedAt: string }>;
}

/** What the caller learned about issues closed in the window. */
export type ClosedIssuesRead = { count: number; truncated: boolean } | { error: string };

/**
 * Summarise `/api/today/summary` plus the merges of `/api/today/merges` that
 * fall inside the window, and the closed-issue count of the same window.
 */
export function collectToday(
  summaryRaw: unknown,
  mergesRaw: unknown,
  closed: ClosedIssuesRead,
  nowMs: number,
  windowHours: number,
): CollectorResult<TodaySummary> {
  const s = obj(summaryRaw);
  if (!s) return fail("bad-input", "today summary is not an object");
  const sinceMs = nowMs - windowHours * HOUR_MS;
  const merges = objects(obj(mergesRaw)?.items)
    .filter((m) => {
      const ms = Date.parse(str(m.mergedAt));
      return Number.isFinite(ms) && ms >= sinceMs;
    })
    .map((m) => ({
      prNumber: num(m.prNumber),
      title: str(m.title).slice(0, 100),
      tier: str(m.tier),
      classLabel: str(m.classLabel),
      mergedAt: str(m.mergedAt),
    }));
  return {
    ok: true,
    data: {
      windowHours,
      mergeCount: num(s.mergeCount),
      runCount: num(s.runCount),
      costSpent: s.costSpent ?? null,
      headroom: s.headroom ?? null,
      issuesOpened: num(s.issuesOpened),
      issuesClosed: "error" in closed ? null : closed.count,
      issuesClosedNote: "error" in closed ? `closed-issue read failed (${closed.error})` : closed.truncated ? "closed count is a floor (read limit hit)" : null,
      merges,
    },
  };
}

// ---------------------------------------------------------------------------
// architecture
// ---------------------------------------------------------------------------

export interface ArchitectureSummary {
  scannedAt: string;
  moduleCount: number;
  edgeCount: number;
  tangled: Array<{ id: string; group: string; fanIn: number; fanOut: number; fanTotal: number; cycleSize: number }>;
}

/** Summarise `/api/architecture`: graph size and the ten most-tangled modules. */
export function collectArchitecture(raw: unknown): CollectorResult<ArchitectureSummary> {
  const body = obj(raw);
  if (!body || !Array.isArray(body.tangledModules)) {
    return fail("bad-input", "architecture response has no tangledModules array");
  }
  return {
    ok: true,
    data: {
      scannedAt: str(body.scannedAt),
      moduleCount: num(body.moduleCount),
      edgeCount: num(body.edgeCount),
      tangled: objects(body.tangledModules)
        .slice(0, 10)
        .map((m) => ({
          id: str(m.id),
          group: str(m.group),
          fanIn: num(m.fanIn),
          fanOut: num(m.fanOut),
          fanTotal: num(m.fanTotal),
          cycleSize: num(m.cycleSize),
        })),
    },
  };
}

// ---------------------------------------------------------------------------
// text rendering
// ---------------------------------------------------------------------------

/** Per-collector `--text` renderers; a collector without one prints its data as JSON. */
const TEXT: Record<string, (data: any) => string> = {
  alerts: (d: AlertsSummary) =>
    d.active === 0
      ? `no active alerts (${d.scanned} scanned)`
      : [`${d.active} active ${JSON.stringify(d.bySeverity)}`, ...d.recent.map((a) => `  [${a.severity}] ${a.timestamp.slice(0, 16)} ${a.message}`)].join("\n"),
  "redis-server": (d: RedisServerSummary) =>
    `used_memory=${d.usedMemoryHuman ?? "?"} maxmemory=${d.maxMemoryHuman ?? "?"} keys=${d.keys ?? "?"}`,
  timers: (d: TimersSummary) => {
    const head = d.findings.length ? d.findings.join("; ") : `${d.repo.length} repo timers enabled and scheduled`;
    const live = d.liveReadError ? ` | live state unreadable (${d.liveReadError})` : "";
    const t = d.target;
    const target =
      t.status === "skipped"
        ? `target timers: skipped (${t.reason})`
        : t.status === "none"
          ? `target timers: none installed matching ${t.pattern}`
          : `target timers: ${t.timers.length} matching ${t.pattern}`;
    const rows = [...d.repo, ...(t.status === "ok" ? t.timers : [])].map(
      (r) => `  ${r.unit}: enabled=${r.enabled ?? "unknown"} last=${r.last ?? "never"} next=${r.next ?? "none"}`,
    );
    return [`${head}${live} | ${target}`, ...rows].join("\n");
  },
  "redis-backup": (d: RedisBackupSummary) =>
    d.newest === null
      ? `NONE FOUND under ${d.dir} (a finding)`
      : `newest=${d.newest} age=${d.ageHours}h ${d.stale ? `STALE (past ${d.staleAfterHours}h)` : `fresh (stale past ${d.staleAfterHours}h)`}`,
  "journal-errors": (d: JournalErrorsSummary) =>
    [
      `${d.matched} error line(s) in ${d.unit} over ${d.windowHours}h${d.truncated ? " (journal truncated)" : ""}${d.timedOut ? " (journal read timed out)" : ""}`,
      ...d.lines.map((l) => `  ${l}`),
    ].join("\n"),
  "target-git": (d: TargetGitSummary) =>
    [
      `${d.dirtyFiles} dirty file(s), ${d.commits} commit(s) in ${d.windowHours}h`,
      ...d.dirtySample.map((l) => `  dirty ${l}`),
      ...d.commitSample.map((l) => `  ${l}`),
    ].join("\n"),
  "kill-chain": (d: KillChainSummary) => {
    const l = d.ledger;
    const head =
      d.verdict === "FLAG"
        ? `FLAG — ${l.breachCount} wire-or-retire module(s) >${WIRING_SLO_DAYS}d past grace without a verdict`
        : `quiet (${l ? `no wire-or-retire module >${WIRING_SLO_DAYS}d past grace` : d.ledgerNote})`;
    const ledger = l
      ? `  ledger: ${l.modules} modules | wire-or-retire=${l.wireOrRetire} awaiting-wiring=${l.awaitingWiring} protected-provider=${l.protectedProvider} | oldest past grace: ${l.oldestPastGrace ? `${l.oldestPastGrace.daysPastGrace}d (${l.oldestPastGrace.path})` : "n/a"}`
      : `  ledger: n/a (${d.ledgerNote})`;
    const b = d.baseline;
    const baseline = b
      ? `  deadcode-baseline: unusedExports=${b.unusedExports ?? "?"} unreachableProductionFiles=${b.unreachableProductionFiles ?? "?"} testOnlyModules=${b.testOnlyModules ?? "?"} orphanModules=${b.orphanModules ?? "?"}`
      : `  deadcode-baseline: n/a (${d.baselineNote})`;
    return [head, ...(l ? l.breaches.map((x) => `  ${x.daysPastGrace}d past grace — ${x.path}`) : []), ledger, baseline].join("\n");
  },
  "reframe-saves": (d: ReframeSavesSummary) =>
    [
      `${d.count} in ${d.windowHours}h (${d.undateable} undateable excluded, ${d.scanned} events scanned)`,
      ...d.sample.map((s) => `  ${s.timestamp.slice(0, 16)} ${s.anchorRef} — ${s.reason}`),
    ].join("\n"),
};

/**
 * Render one collector result as text: a `name: ...` line, plus indented detail
 * lines for the collectors that carry rows.
 */
export function renderText(name: string, result: CollectorResult<unknown>): string {
  if (result.ok === false) {
    return `${name}: ${result.skipped ? "skipped" : result.code} (${result.reason})`;
  }
  const render = TEXT[name];
  return `${name}: ${render ? render(result.data) : JSON.stringify(result.data)}`;
}

/** Render the Target identity line that leads `--text` output. */
export function renderTargetText(target: TargetSummary): string {
  return `target: ${target.resolved ? target.note : `<unresolved> — ${target.note}`}`;
}
