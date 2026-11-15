/**
 * scripts/ops-collect.ts — operator diagnostics collector CLI.
 *
 *   npx tsx scripts/ops-collect.ts --collectors a,b,c [--text] [--window-hours N] [--count N]
 *   npx tsx scripts/ops-collect.ts --help      # every collector and its output fields
 *
 * Prints `{generatedAt, target, collectors: {<name>: result}}` as JSON, or one
 * `name: ...` line per collector with --text. ALWAYS exits 0: a failing
 * collector degrades to its own `ok:false` result so the caller keeps
 * diagnosing. Collectors run in parallel, each under its own timeout.
 *
 * This file is the I/O shell: it reaches the host only through the sanctioned
 * adapters (HTTP /api/*, src/redis accessors, the GitHub CLI / Host-Probe /
 * Journal Adapters) and resolves the Target once, in-process. All parsing and
 * verdict rules live in ./ops-collect-logic.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitExec } from "../src/github/git.ts";
import { isGhFailure } from "../src/github/exec.ts";
import { isIssueReadFailure, listIssuesBySearch, listOpenIssues } from "../src/github/issues.ts";
import { isProbeFailure, readUnitEnabledState, readUserTimers } from "../src/host-probe/probe.ts";
import { runJournal } from "../src/journal/exec.ts";
import { isJournalSliceFailure, readJournalSlice } from "../src/journal/read.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";
import { getMemoryPatterns } from "../src/redis/agent-memory.ts";
import { redisDbSize, redisInfo } from "../src/redis/utility.ts";
import { collectTargetFacts } from "./target/print-target-facts.ts";
import { probeTargetCapabilities } from "./target/target-capabilities.ts";
import {
  REDIS_BACKUP_DIR,
  REDIS_BACKUP_STALE_HOURS,
  WIRING_GRACE_DAYS,
  WIRING_SLO_DAYS,
  collectAlerts,
  collectArchitecture,
  collectBoard,
  collectCostByClass,
  collectCycles,
  collectJournalErrors,
  collectKillChain,
  collectMemory,
  collectRedisBackup,
  collectRedisServer,
  collectReframeSaves,
  collectScheduler,
  collectTargetGit,
  collectTimers,
  collectToday,
  fail,
  learningAgents,
  renderTargetText,
  renderText,
  repoTimerUnits,
  skip,
  summariseTarget,
  type AgentMemoryRead,
  type ClosedIssuesRead,
  type CollectorResult,
  type LiveTimer,
  type TargetSummary,
} from "./ops-collect-logic.ts";

const BASE = process.env.HYDRA_API_URL ?? "http://localhost:4000";
const HERE = fileURLToPath(new URL(".", import.meta.url));
/** Unit whose journal the `journal-errors` collector reads. */
const ORCHESTRATOR_UNIT = "hydra-orchestrator.service";
/** Row limit of the board and closed-issue reads. */
const ISSUE_LIMIT = 200;
/** Ceiling for one collector; a slower one degrades to `timeout`. */
const COLLECTOR_TIMEOUT_MS = 12_000;
const ADAPTER_TIMEOUT_MS = 10_000;

type ReadFailure = { error: string };

/** Everything the collectors read from outside the process. Tests inject fakes. */
export interface Adapters {
  /** GET an orchestrator `/api/*` path. */
  getJson(path: string): Promise<CollectorResult<unknown>>;
  /** The Dispatch-Class Taxonomy document. May throw. */
  classesDoc(): unknown;
  /** One agent's consolidated `:patterns` string (null = key absent). May reject. */
  memoryPatterns(agent: string): Promise<string | null>;
  openIssues(limit: number): Promise<{ rows: unknown[] } | ReadFailure>;
  closedIssuesSince(iso: string, limit: number): Promise<{ rows: unknown[] } | ReadFailure>;
  /** Redis `INFO <section>` text. May reject. */
  redisInfo(section: string): Promise<string>;
  /** Redis DBSIZE. May reject. */
  redisDbSize(): Promise<number>;
  /** File names under `scripts/systemd/`. May throw. */
  systemdFiles(): string[];
  userTimers(): Promise<LiveTimer[] | ReadFailure>;
  /** `systemctl --user is-enabled` state word; null when the probe failed. */
  unitEnabledState(unit: string): Promise<string | null>;
  /** Name and mtime of each file in a directory. May throw. */
  dirFiles(dir: string): Array<{ name: string; mtimeMs: number }>;
  journal(unit: string, sinceIso: string): Promise<{ text: string; truncated: boolean; timedOut: boolean } | ReadFailure>;
  /** Target identity facts (`collectTargetFacts()` shape). May throw. */
  targetFacts(): unknown;
  /** Workspace-relative path per present Target capability. */
  targetCapabilities(workspace: string, appDir: string): Record<string, string | null>;
  git(args: string[], cwd: string): Promise<{ stdout: string } | ReadFailure>;
  /** Read a UTF-8 file. May throw. */
  readText(path: string): string;
  now(): number;
}

async function liveGetJson(path: string): Promise<CollectorResult<unknown>> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return fail("http-error", `${path} -> ${res.status}`);
    return { ok: true, data: await res.json() };
  } catch (err) {
    /* intentional: error is returned as the collector result, not swallowed */
    return fail("unreachable", `${path}: ${(err as Error).message}`);
  }
}

/** The live adapters: the only place this CLI touches the host. */
export const liveAdapters: Adapters = {
  getJson: liveGetJson,
  classesDoc: () => JSON.parse(readFileSync(join(HERE, "autopilot", "classes.json"), "utf8")),
  memoryPatterns: (agent) => getMemoryPatterns(agent),
  openIssues: async (limit) => {
    const r = await listOpenIssues({ limit, fields: "number,title,labels", timeout: ADAPTER_TIMEOUT_MS });
    return isIssueReadFailure(r) ? { error: r.code } : { rows: r.rows };
  },
  closedIssuesSince: async (iso, limit) => {
    const r = await listIssuesBySearch(`closed:>=${iso}`, {
      state: "closed",
      limit,
      fields: "number,title,labels",
      timeout: ADAPTER_TIMEOUT_MS,
    });
    return isIssueReadFailure(r) ? { error: r.code } : { rows: r.rows };
  },
  redisInfo: (section) => redisInfo(section),
  redisDbSize: () => redisDbSize(),
  systemdFiles: () => readdirSync(join(HERE, "systemd")),
  userTimers: async () => {
    const r = await readUserTimers({ timeout: ADAPTER_TIMEOUT_MS });
    return isProbeFailure(r) ? { error: r.code } : r.data;
  },
  unitEnabledState: async (unit) => {
    const r = await readUnitEnabledState(unit, { timeout: ADAPTER_TIMEOUT_MS });
    return isProbeFailure(r) ? null : r.data;
  },
  dirFiles: (dir) => readdirSync(dir).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs })),
  journal: async (unit, sinceIso) => {
    const r = await readJournalSlice(
      { row: { started: sinceIso } },
      { runJournal: (_unit, since, until, opts) => runJournal(unit, since, until, { ...opts, timeoutMs: ADAPTER_TIMEOUT_MS }) },
    );
    return isJournalSliceFailure(r) ? { error: r.code } : r.data;
  },
  targetFacts: () => collectTargetFacts(),
  targetCapabilities: (workspace, appDir) => {
    const out: Record<string, string | null> = {};
    for (const [key, cap] of Object.entries(probeTargetCapabilities({ workspace, appDir }))) {
      out[key] = cap.ok === true ? cap.value : null;
    }
    return out;
  },
  git: async (args, cwd) => {
    const r = await gitExec(args, { cwd, timeout: ADAPTER_TIMEOUT_MS });
    return isGhFailure(r) ? { error: r.code } : { stdout: r.data.stdout };
  },
  readText: (path) => readFileSync(path, "utf8"),
  now: () => Date.now(),
};

/** The Target as resolved once per run. */
interface ResolvedTarget {
  summary: TargetSummary;
  workspace: string | null;
  appDir: string | null;
}

function resolveTarget(a: Adapters): ResolvedTarget {
  let facts: any;
  try {
    facts = a.targetFacts();
  } catch (err) {
    /* intentional: an unreadable Target config is reported as an unresolved Target */
    return {
      summary: { resolved: false, name: null, note: `Target unresolved (${(err as Error).message})` },
      workspace: null,
      appDir: null,
    };
  }
  const summary = summariseTarget(facts);
  if (!summary.resolved) return { summary, workspace: null, appDir: null };
  const sub = facts.manifest?.ok === true ? String(facts.manifest.appSubdir ?? "") : "";
  return { summary, workspace: facts.workspace, appDir: sub ? join(facts.workspace, sub) : facts.workspace };
}

interface Ctx {
  a: Adapters;
  target: ResolvedTarget;
  /** Cycle sample size (`--count`). */
  count: number;
  /** `--window-hours`, or undefined to use each collector's default. */
  windowHours: number | undefined;
}

interface Collector {
  /** `--help` text: what it reads, its output fields, its default window. */
  help: string;
  run(ctx: Ctx): Promise<CollectorResult<unknown>>;
}

async function viaJson(
  ctx: Ctx,
  path: string,
  summarise: (raw: unknown) => CollectorResult<unknown>,
): Promise<CollectorResult<unknown>> {
  const r = await ctx.a.getJson(path);
  return r.ok === true ? summarise(r.data) : r;
}

const TARGET_UNRESOLVED = () => skip("target-unresolved", "Target unresolved");

/** Every collector, by name. The one registry: dispatch, `--help` and the default set read it. */
export const COLLECTORS: Record<string, Collector> = {
  cycles: {
    help: "/api/metrics over the last --count cycles (default 50). Fields: cycles, merged, failed, abandoned, mergeRatePct, fixes, features, avg/median/maxDurationSec, avg/totalCostUsd, testsFirst, testsLast, testsDelta, anchors, repeatedTasks, recent[5], coverage{recordedClasses, classesNotRecorded} (a class in classesNotRecorded has no cycle rows by design: read it as not-recorded, never as zero).",
    run: (ctx) => viaJson(ctx, `/api/metrics?count=${ctx.count}`, collectCycles),
  },
  scheduler: {
    help: "/api/scheduler/status. Fields: running, cyclesRun, consecutiveErrors.",
    run: (ctx) => viaJson(ctx, "/api/scheduler/status", collectScheduler),
  },
  board: {
    help: `Open issues of the orchestrator repo (first ${ISSUE_LIMIT}). Fields: open, truncated (counts are a floor when true), byLabel{label: count}, samples{label: up to 3 {number, title}}.`,
    run: async (ctx) => {
      const r = await ctx.a.openIssues(ISSUE_LIMIT);
      return "error" in r ? fail(r.error, "open-issue read failed") : collectBoard(r.rows, ISSUE_LIMIT);
    },
  },
  memory: {
    help: "Pattern Memory of every learningAgent in scripts/autopilot/classes.json. Fields: agents[{agent, patterns, totalHits, bytes, lastSeen, topCategories[3]}], failed[{agent, code, reason}]. Fails as a whole only when no agent could be read.",
    run: async (ctx) => {
      let agents: string[];
      try {
        agents = learningAgents(ctx.a.classesDoc());
      } catch (err) {
        /* intentional: error is returned as the collector result, not swallowed */
        return fail("classes-unreadable", (err as Error).message);
      }
      const reads = await Promise.all(
        agents.map(async (agent): Promise<AgentMemoryRead> => {
          try {
            return { agent, raw: await ctx.a.memoryPatterns(agent) };
          } catch (err) {
            /* intentional: the per-agent error is carried into the collector result */
            return { agent, error: (err as Error).message };
          }
        }),
      );
      return collectMemory(reads);
    },
  },
  alerts: {
    help: "/api/alerts. Fields: scanned, active (not dismissed), bySeverity, recent[10]{severity, timestamp, type, message}.",
    run: (ctx) => viaJson(ctx, "/api/alerts?limit=200", collectAlerts),
  },
  "redis-server": {
    help: "Redis INFO memory + DBSIZE through src/redis/utility.ts. Fields: usedMemoryBytes, usedMemoryHuman, maxMemoryHuman, keys.",
    run: async (ctx) => {
      try {
        const [info, keys] = await Promise.all([ctx.a.redisInfo("memory"), ctx.a.redisDbSize()]);
        return collectRedisServer(info, keys);
      } catch (err) {
        /* intentional: error is returned as the collector result, not swallowed */
        return fail("redis-error", (err as Error).message);
      }
    },
  },
  timers: {
    help: "Repo-owned timers (every scripts/systemd/*.timer) and the Target's timers (<target name>-*.timer) against live systemd state. Fields: repo[{unit, enabled, loaded, last, next}], findings[] (TIMER NOT ENABLED / TIMER NEVER FIRED / TIMER NOT SCHEDULED), target{status: ok|none|skipped, pattern, timers}, liveReadError.",
    run: async (ctx) => {
      let systemdFiles: string[];
      try {
        systemdFiles = ctx.a.systemdFiles();
      } catch (err) {
        /* intentional: error is returned as the collector result, not swallowed */
        return fail("systemd-dir-unreadable", (err as Error).message);
      }
      const units = repoTimerUnits(systemdFiles);
      const [live, states] = await Promise.all([
        ctx.a.userTimers(),
        Promise.all(units.map(async (u) => [u, await ctx.a.unitEnabledState(u)] as const)),
      ]);
      return collectTimers({
        systemdFiles,
        enabledStates: Object.fromEntries(states),
        live: Array.isArray(live) ? live : { error: live.error },
        targetName: ctx.target.summary.resolved ? ctx.target.summary.name : null,
      });
    },
  },
  "redis-backup": {
    help: `Newest hydra-redis-*.rdb.gz under ${REDIS_BACKUP_DIR}. Fields: dir, newest, ageHours, staleAfterHours (${REDIS_BACKUP_STALE_HOURS}), stale (true when older than that or when none exists).`,
    run: async (ctx) => {
      try {
        return collectRedisBackup(ctx.a.dirFiles(REDIS_BACKUP_DIR), ctx.a.now());
      } catch (err) {
        /* intentional: error is returned as the collector result, not swallowed */
        return fail("backup-dir-unreadable", (err as Error).message);
      }
    },
  },
  "journal-errors": {
    help: `Error-shaped lines of ${ORCHESTRATOR_UNIT} (window default 1h). Fields: unit, windowHours, matched, lines[last 10], truncated, timedOut.`,
    run: async (ctx) => {
      const hours = ctx.windowHours ?? 1;
      const r = await ctx.a.journal(ORCHESTRATOR_UNIT, new Date(ctx.a.now() - hours * 3_600_000).toISOString());
      return "error" in r ? fail(r.error, "journal read failed") : collectJournalErrors(r, ORCHESTRATOR_UNIT, hours);
    },
  },
  "target-git": {
    help: "Working tree and recent commits of the Target checkout (window default 6h). Fields: windowHours, dirtyFiles, dirtySample[10], commits, commitSample[10]. Skipped when the Target is unresolved.",
    run: async (ctx) => {
      const ws = ctx.target.workspace;
      if (!ws) return TARGET_UNRESOLVED();
      const hours = ctx.windowHours ?? 6;
      const [status, log] = await Promise.all([
        ctx.a.git(["status", "--short"], ws),
        ctx.a.git(["log", "--oneline", `--since=${hours} hours ago`], ws),
      ]);
      if ("error" in status) return fail(status.error, "git status failed in the Target checkout");
      if ("error" in log) return fail(log.error, "git log failed in the Target checkout");
      return collectTargetGit(status.stdout, log.stdout, hours);
    },
  },
  "kill-chain": {
    help: `The Target's wiring ledger and dead-code baseline. Fields: verdict (quiet | FLAG), ledger{modules, wireOrRetire, awaitingWiring, protectedProvider, oldestPastGrace, breachCount, breaches[5]}, baseline{unusedExports, unreachableProductionFiles, testOnlyModules, orphanModules}, ledgerNote, baselineNote. FLAG = a wire-or-retire module more than ${WIRING_SLO_DAYS} days past the ${WIRING_GRACE_DAYS}-day grace window; a row with an unparseable date is never flagged. Skipped when the Target is unresolved or carries neither file.`,
    run: async (ctx) => {
      const { workspace, appDir } = ctx.target;
      if (!workspace || !appDir) return TARGET_UNRESOLVED();
      const caps = ctx.a.targetCapabilities(workspace, appDir);
      const read = (rel: string | null | undefined): string | null => {
        if (!rel) return null;
        try {
          return ctx.a.readText(join(workspace, rel));
        } catch {
          /* intentional: an unreadable capability file is reported as absent in the collector note */
          return null;
        }
      };
      const ledger = read(caps.wiringLedger);
      const baseline = read(caps.deadcodeBaseline);
      if (ledger === null && baseline === null) {
        return skip("capability-absent", "Target carries no wiring ledger and no dead-code baseline");
      }
      return collectKillChain(ledger, baseline, ctx.a.now());
    },
  },
  "reframe-saves": {
    help: "target:reframe-save events of /api/events/notifications (window default 24h, by ISO timestamp). Fields: windowHours, count, undateable (events with no usable timestamp, excluded from count), scanned, sample[5]{timestamp, anchorRef, reason}.",
    run: (ctx) =>
      viaJson(ctx, "/api/events/notifications?count=500", (raw) =>
        collectReframeSaves(raw, ctx.a.now(), ctx.windowHours ?? 24),
      ),
  },
  "cost-by-class": {
    help: "/api/metrics/cost-by-class. Fields: date, window, source, totalTokens, classes[{class, tokens, sharePct, quotaWeight, topSkills[3]}] ranked by tokens.",
    run: (ctx) => viaJson(ctx, "/api/metrics/cost-by-class", collectCostByClass),
  },
  today: {
    help: "/api/today/summary + /api/today/merges + closed issues (window default 24h, 1-168). Fields: windowHours, mergeCount, runCount, costSpent, headroom, issuesOpened, issuesClosed (null when the read failed), issuesClosedNote, merges[{prNumber, title, tier, classLabel, mergedAt}].",
    run: async (ctx) => {
      const hours = Math.min(168, Math.max(1, Math.round(ctx.windowHours ?? 24)));
      const now = ctx.a.now();
      const [summary, merges, closed] = await Promise.all([
        ctx.a.getJson(`/api/today/summary?windowHours=${hours}`),
        ctx.a.getJson("/api/today/merges?limit=50"),
        ctx.a.closedIssuesSince(new Date(now - hours * 3_600_000).toISOString(), ISSUE_LIMIT),
      ]);
      if (summary.ok !== true) return summary;
      const closedRead: ClosedIssuesRead =
        "error" in closed ? { error: closed.error } : { count: closed.rows.length, truncated: closed.rows.length >= ISSUE_LIMIT };
      return collectToday(summary.data, merges.ok === true ? merges.data : null, closedRead, now, hours);
    },
  },
  architecture: {
    help: "/api/architecture. Fields: scannedAt, moduleCount, edgeCount, tangled[10]{id, group, fanIn, fanOut, fanTotal, cycleSize}.",
    run: (ctx) => viaJson(ctx, "/api/architecture", collectArchitecture),
  },
};

/** Run one collector under the timeout; a throw or an overrun becomes its result. */
export async function runCollector(name: string, ctx: Ctx, timeoutMs = COLLECTOR_TIMEOUT_MS): Promise<CollectorResult<unknown>> {
  const collector = Object.hasOwn(COLLECTORS, name) ? COLLECTORS[name] : undefined;
  if (!collector) return fail("unknown-collector", `${name} (known: ${Object.keys(COLLECTORS).join(",")})`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      collector.run(ctx),
      new Promise<CollectorResult<unknown>>((resolve) => {
        timer = setTimeout(() => resolve(fail("timeout", `no result within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    /* intentional: a collector that throws degrades to its own failed result */
    return fail("collector-threw", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** The `--help` text: usage, flags, and every collector with its output fields. */
export function helpText(): string {
  return [
    "usage: npx tsx scripts/ops-collect.ts --collectors <a,b,c> [--text] [--window-hours N] [--count N]",
    "",
    "Prints {generatedAt, target: {resolved, name, note}, collectors: {<name>: result}} as JSON.",
    "A result is {ok:true, data} or {ok:false, code, reason}; {ok:false, skipped:true, ...} means",
    "the collector does not apply here (unresolved Target, missing Target capability).",
    "Always exits 0: a failing collector degrades to its own result.",
    "",
    "flags:",
    "  --collectors a,b,c   collectors to run (default: all)",
    "  --text               a `target:` line, then one `name: ...` line per collector (detail rows indented)",
    "  --window-hours N     look-back window for the windowed collectors (each has its own default)",
    "  --count N            cycle sample size for `cycles` (default 50)",
    "  --help               this text",
    "",
    "collectors:",
    ...Object.entries(COLLECTORS).map(([name, c]) => `  ${name}\n      ${c.help}`),
  ].join("\n");
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

function positive(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Run the CLI against the given adapters and return what it prints. Never throws. */
export async function run(argv: string[], adapters: Adapters = liveAdapters, timeoutMs = COLLECTOR_TIMEOUT_MS): Promise<string> {
  if (argv.includes("--help")) return helpText();
  const names = [...new Set((flagValue(argv, "--collectors") ?? Object.keys(COLLECTORS).join(",")).split(",").filter(Boolean))];
  const target = resolveTarget(adapters);
  const ctx: Ctx = {
    a: adapters,
    target,
    count: Math.floor(positive(flagValue(argv, "--count")) ?? 50) || 50,
    windowHours: positive(flagValue(argv, "--window-hours")),
  };
  const results = await Promise.all(names.map((n) => runCollector(n, ctx, timeoutMs)));
  if (argv.includes("--text")) {
    return [renderTargetText(target.summary), ...names.map((n, i) => renderText(n, results[i]))].join("\n");
  }
  return JSON.stringify(
    {
      generatedAt: new Date(adapters.now()).toISOString(),
      target: target.summary,
      collectors: Object.fromEntries(names.map((n, i) => [n, results[i]])),
    },
    null,
    2,
  );
}

export async function main(argv: string[]): Promise<void> {
  try {
    console.log(await run(argv));
  } catch (err) {
    /* intentional: a fatal error is printed as a failed result so stdout is never empty; exit stays 0 */
    console.log(JSON.stringify({ ok: false, code: "fatal", reason: (err as Error)?.message ?? String(err) }));
  } finally {
    closeRedisConnections();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(() => process.exit(0));
}
