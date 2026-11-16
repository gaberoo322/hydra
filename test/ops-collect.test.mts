import { spawnSync } from "node:child_process";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDIS_BACKUP_STALE_HOURS,
  WIRING_GRACE_DAYS,
  WIRING_SLO_DAYS,
  collectAgentMemory,
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
  daysPastGrace,
  fail,
  learningAgents,
  renderText,
  repoTimerUnits,
  skip,
  summariseTarget,
  targetPaths,
  targetTimerPattern,
  type CollectorResult,
} from "../scripts/ops-collect-logic.ts";
import { COLLECTORS, helpText, listDirFiles, run, type Adapters } from "../scripts/ops-collect.ts";
import { decideRedisBackup } from "../src/watchdog/redis-backup.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-06-15T12:00:00Z");

/** Unwrap a successful result; fails the test on a failure arm. */
function data<T>(r: CollectorResult<T>): T {
  assert.equal(r.ok, true, `expected ok result, got ${JSON.stringify(r)}`);
  return (r as { ok: true; data: T }).data;
}

/** Unwrap a failure arm; fails the test on success. */
function failure(r: CollectorResult<unknown>): { code: string; reason: string; skipped?: true } {
  assert.equal(r.ok, false, `expected failed result, got ${JSON.stringify(r)}`);
  return r as { ok: false; code: string; reason: string; skipped?: true };
}

/** ISO date `days` before NOW. */
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

describe("collectCycles", () => {
  const sample = {
    trend: [
      { tasksMerged: 1, totalDurationMs: 4000, anchorType: "prior-failure", taskTitle: "t1", testsAfter: 110 },
      { tasksFailed: 1, totalDurationMs: 2000, anchorType: "a", taskTitle: "t1", testsAfter: 105 },
      { tasksAbandoned: 1, anchorType: "b", testsAfter: 100 },
      { tasksMerged: 1, totalDurationMs: 9000, anchorType: "b", taskTitle: "t2", testsAfter: 100 },
    ],
    coverage: { recordedClasses: ["dev_orch"], classesNotRecorded: ["research_orch"] },
  };

  test("summarises merge rate, durations, anchors, fix/feature split and repeated tasks", () => {
    const d = data(collectCycles(sample));
    assert.equal(d.cycles, 4);
    assert.equal(d.merged, 2);
    assert.equal(d.failed, 1);
    assert.equal(d.abandoned, 1);
    assert.equal(d.mergeRatePct, 50);
    assert.equal(d.fixes, 1);
    assert.equal(d.features, 1);
    assert.equal(d.avgDurationSec, 5);
    assert.equal(d.maxDurationSec, 9);
    assert.deepEqual(d.anchors, { "prior-failure": 1, a: 1, b: 2 });
    assert.deepEqual(d.repeatedTasks, [{ title: "t1", count: 2 }]);
    assert.equal(d.testsFirst, 100);
    assert.equal(d.testsLast, 110);
    assert.equal(d.testsDelta, 10);
    assert.equal(d.avgCostUsd, null);
    assert.equal(d.totalCostUsd, null);
    assert.deepEqual(d.recent.map((r) => r.status), ["merged", "failed", "abandoned", "merged"]);
  });

  test("a class the metrics do not record is listed as not recorded, never as a zero count", () => {
    const result = collectCycles(sample);
    const d = data(result);
    assert.deepEqual(d.coverage, { recordedClasses: ["dev_orch"], classesNotRecorded: ["research_orch"] });
    for (const counts of [d.anchors, d as unknown as Record<string, unknown>]) {
      assert.equal(Object.hasOwn(counts, "research_orch"), false);
    }
    const text = renderText("cycles", result);
    assert.match(text, /classes not recorded: research_orch/);
    assert.doesNotMatch(text, /research_orch"?\s*[:=]\s*0/);
    assert.equal(data(collectCycles({ trend: [{}] })).coverage, null);
  });

  test("degrades to a coded failure instead of throwing", () => {
    assert.deepEqual(collectCycles(null), fail("bad-input", "metrics response is not an object"));
    assert.equal(failure(collectCycles({ trend: [] })).code, "no-data");
    assert.equal(failure(collectCycles({})).code, "bad-input");
  });

  test("reports avg and total cost over the cycles that recorded cost", () => {
    const d = data(collectCycles({ trend: [{ costUsd: 1.5 }, { costUsd: 0.5 }, {}] }));
    assert.equal(d.avgCostUsd, 1);
    assert.equal(d.totalCostUsd, 2);
  });

  test("null trend entries are skipped instead of throwing", () => {
    assert.equal(data(collectCycles({ trend: [null, { tasksMerged: 1 }] })).cycles, 1);
    assert.equal(failure(collectCycles({ trend: [null] })).code, "no-data");
  });
});

describe("memory collectors", () => {
  const patterns = JSON.stringify([
    { hitCount: 2, category: "a", lastSeen: "2026-06-01" },
    { hitCount: 5, category: "b", lastSeen: "2026-06-10" },
    { category: "a" },
  ]);

  test("one agent: counts patterns, hits, size, last-seen and top categories", () => {
    assert.deepEqual(data(collectAgentMemory("planner", patterns)), {
      agent: "planner",
      patterns: 3,
      totalHits: 7,
      bytes: patterns.length,
      lastSeen: "2026-06-10",
      topCategories: [
        { category: "b", hits: 5 },
        { category: "a", hits: 2 },
      ],
    });
  });

  test("one agent: an absent key is zero patterns; bad JSON and non-arrays are coded failures", () => {
    assert.equal(data(collectAgentMemory("executor", null)).patterns, 0);
    assert.equal(failure(collectAgentMemory("x", "{nope")).code, "parse-error");
    assert.equal(failure(collectAgentMemory("x", "{}")).code, "parse-error");
  });

  test("all agents: one result that keeps the readable agents and lists the failed ones", () => {
    const d = data(
      collectMemory([
        { agent: "planner", raw: patterns },
        { agent: "executor", error: "ECONNREFUSED" },
        { agent: "skeptic", raw: "{nope" },
      ]),
    );
    assert.deepEqual(d.agents.map((a) => a.agent), ["planner"]);
    assert.deepEqual(d.failed.map((f) => [f.agent, f.code]), [
      ["executor", "redis-error"],
      ["skeptic", "parse-error"],
    ]);
  });

  test("all agents: fails as a whole when no agent could be read, or none is named", () => {
    const f = failure(collectMemory([{ agent: "planner", error: "down" }, { agent: "executor", error: "down" }]));
    assert.equal(f.code, "memory-unavailable");
    assert.match(f.reason, /planner: down; executor: down/);
    assert.equal(failure(collectMemory([])).code, "no-agents");
  });

  test("learningAgents returns the distinct non-null agents of the class table", () => {
    assert.deepEqual(
      learningAgents({ classes: [{ learningAgent: "executor" }, { learningAgent: null }, { learningAgent: "planner" }, { learningAgent: "executor" }] }),
      ["executor", "planner"],
    );
    assert.deepEqual(learningAgents(null), []);
  });
});

describe("board, scheduler, alerts, redis-server", () => {
  test("board counts labels, samples three issues per label, and reports truncation at the read limit", () => {
    const rows = [1, 2, 3, 4].map((n) => ({ number: n, title: `t${n}`, labels: n === 1 ? ["a", "b"] : ["a"] }));
    const d = data(collectBoard(rows, 200));
    assert.equal(d.open, 4);
    assert.equal(d.truncated, false);
    assert.deepEqual(d.byLabel, { a: 4, b: 1 });
    assert.deepEqual(d.samples.a.map((s) => s.number), [1, 2, 3]);
    assert.equal(data(collectBoard(rows, 4)).truncated, true);
    assert.deepEqual(data(collectBoard([{ labels: [{ name: "x" }] }])).byLabel, { x: 1 });
    assert.equal(failure(collectBoard("x")).code, "bad-input");
  });

  test("scheduler summarises status and rejects non-objects", () => {
    assert.deepEqual(data(collectScheduler({ running: true, cyclesRun: 9, consecutiveErrors: 1 })), {
      running: true,
      cyclesRun: 9,
      consecutiveErrors: 1,
    });
    assert.equal(failure(collectScheduler(null)).code, "bad-input");
  });

  test("alerts counts only undismissed alerts, by severity", () => {
    const d = data(
      collectAlerts({
        alerts: [
          { severity: "critical", message: "m1", timestamp: "2026-06-15T10:00:00Z", type: "x" },
          { severity: "warning", message: "m2", dismissed: true },
          { message: "m3" },
        ],
      }),
    );
    assert.equal(d.scanned, 3);
    assert.equal(d.active, 2);
    assert.deepEqual(d.bySeverity, { critical: 1, unknown: 1 });
    assert.deepEqual(d.recent.map((a) => a.message), ["m1", "m3"]);
    assert.equal(failure(collectAlerts({})).code, "bad-input");
    assert.match(renderText("alerts", collectAlerts({ alerts: [] })), /^alerts: no active alerts/);
  });

  test("redis-server reads the memory fields and the key count", () => {
    const info = "# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\nmaxmemory_human:768.00M\r\n";
    assert.deepEqual(data(collectRedisServer(info, 42)), {
      usedMemoryBytes: 1048576,
      usedMemoryHuman: "1.00M",
      maxMemoryHuman: "768.00M",
      keys: 42,
    });
    assert.equal(data(collectRedisServer(info, undefined)).keys, null);
    assert.equal(failure(collectRedisServer("# Memory\r\n", 1)).code, "bad-input");
    assert.equal(failure(collectRedisServer(null, 1)).code, "bad-input");
  });
});

describe("timers collector", () => {
  const us = (iso: string) => Date.parse(iso) * 1000;
  const files = ["hydra-a.timer", "hydra-a.service", "hydra-b.timer", "README.md"];
  const live = [
    { unit: "hydra-a.timer", last: us("2026-06-15T11:00:00Z"), next: us("2026-06-15T13:00:00Z") },
    { unit: "hydra-b.timer", last: 0, next: 0 },
    { unit: "acme-sync.timer", last: us("2026-06-15T10:00:00Z"), next: us("2026-06-15T14:00:00Z") },
    { unit: "acme-other.service", last: 0, next: 0 },
    { unit: "unrelated.timer", last: 0, next: 0 },
  ];

  test("the repo timer set is every *.timer file of the systemd directory, so a new file is covered", () => {
    assert.deepEqual(repoTimerUnits(files), ["hydra-a.timer", "hydra-b.timer"]);
    const d = data(
      collectTimers({
        systemdFiles: [...files, "hydra-new.timer"],
        enabledStates: { "hydra-a.timer": "enabled", "hydra-b.timer": "enabled", "hydra-new.timer": "enabled" },
        live,
        targetName: "acme",
      }),
    );
    assert.deepEqual(d.repo.map((r) => r.unit), ["hydra-a.timer", "hydra-b.timer", "hydra-new.timer"]);
  });

  test("flags a timer that is not enabled, never fired, or has no next run; a healthy one is not flagged", () => {
    const d = data(
      collectTimers({
        systemdFiles: [...files, "hydra-c.timer"],
        enabledStates: { "hydra-a.timer": "enabled", "hydra-b.timer": "enabled", "hydra-c.timer": "disabled" },
        live,
        targetName: "acme",
      }),
    );
    assert.deepEqual(d.findings, [
      "TIMER NEVER FIRED: hydra-b.timer",
      "TIMER NOT SCHEDULED: hydra-b.timer",
      "TIMER NOT ENABLED: hydra-c.timer (disabled)",
    ]);
    assert.equal(d.repo[0].last, "2026-06-15T11:00:00.000Z");
    assert.match(
      renderText("timers", { ok: true, data: d }),
      /^timers: TIMER NEVER FIRED: hydra-b\.timer; TIMER NOT SCHEDULED: hydra-b\.timer; TIMER NOT ENABLED: hydra-c\.timer \(disabled\)/,
    );
  });

  test("the Target's timers are the live units matching the resolved name's glob", () => {
    const input = { systemdFiles: files, enabledStates: { "hydra-a.timer": "enabled", "hydra-b.timer": "enabled" }, live };
    const acme = data(collectTimers({ ...input, targetName: "acme" })).target;
    assert.deepEqual(acme, {
      status: "ok",
      pattern: targetTimerPattern("acme"),
      timers: [{ unit: "acme-sync.timer", enabled: null, loaded: true, last: "2026-06-15T10:00:00.000Z", next: "2026-06-15T14:00:00.000Z" }],
    });
    assert.deepEqual(data(collectTimers({ ...input, targetName: "zeta" })).target, {
      status: "none",
      pattern: targetTimerPattern("zeta"),
    });
  });

  test("an unresolved Target skips only the Target part", () => {
    const d = data(
      collectTimers({ systemdFiles: files, enabledStates: { "hydra-a.timer": "enabled", "hydra-b.timer": "enabled" }, live, targetName: null }),
    );
    assert.equal(d.target.status, "skipped");
    assert.equal(d.repo.length, 2);
    assert.match(renderText("timers", { ok: true, data: d }), /target timers: skipped \(Target unresolved\)/);
  });

  test("an unreadable live state does not invent never-fired findings; total probe loss is a failure", () => {
    const enabledStates = { "hydra-a.timer": "enabled", "hydra-b.timer": "enabled" };
    const d = data(collectTimers({ systemdFiles: files, enabledStates, live: { error: "host-probe-timeout" }, targetName: "acme" }));
    assert.deepEqual(d.findings, []);
    assert.equal(d.liveReadError, "host-probe-timeout");
    const lost = collectTimers({ systemdFiles: files, enabledStates: {}, live: { error: "host-probe-enoent" }, targetName: null });
    assert.equal(failure(lost).code, "host-probe-failed");
    assert.equal(failure(collectTimers({ systemdFiles: ["x.service"], enabledStates: {}, live: [], targetName: null })).code, "no-timers");
  });

  test("a lost is-enabled probe is unknown state, not a NOT ENABLED finding", () => {
    const d = data(
      collectTimers({ systemdFiles: files, enabledStates: { "hydra-a.timer": "enabled", "hydra-b.timer": null }, live, targetName: null }),
    );
    assert.deepEqual(d.findings, []);
    assert.equal(d.repo[1].enabled, null);
    const text = renderText("timers", { ok: true, data: d });
    assert.match(text, /hydra-b\.timer: enabled=unknown/);
    assert.doesNotMatch(text, /NOT ENABLED/);
  });

  test("an enabled timer that never fired and has no next run reports both findings", () => {
    const d = data(
      collectTimers({ systemdFiles: files, enabledStates: { "hydra-a.timer": "enabled", "hydra-b.timer": "enabled" }, live, targetName: null }),
    );
    assert.deepEqual(d.findings, ["TIMER NEVER FIRED: hydra-b.timer", "TIMER NOT SCHEDULED: hydra-b.timer"]);
    const scheduledOnly = data(
      collectTimers({
        systemdFiles: files,
        enabledStates: { "hydra-a.timer": "enabled", "hydra-b.timer": "enabled" },
        live: [live[0], { unit: "hydra-b.timer", last: us("2026-06-15T09:00:00Z"), next: 0 }],
        targetName: null,
      }),
    );
    assert.deepEqual(scheduledOnly.findings, ["TIMER NOT SCHEDULED: hydra-b.timer"]);
  });
});

describe("redis-backup, journal-errors, target-git", () => {
  test("redis-backup reports the newest dump and goes stale AT the threshold, as the watchdog does", () => {
    const justUnder = NOW - REDIS_BACKUP_STALE_HOURS * HOUR + 1000;
    const fresh = data(
      collectRedisBackup(
        [
          { name: "hydra-redis-old.rdb.gz", mtimeMs: NOW - 50 * HOUR },
          { name: "hydra-redis-new.rdb.gz", mtimeMs: justUnder },
          { name: "notes.txt", mtimeMs: NOW },
        ],
        NOW,
      ),
    );
    assert.equal(fresh.newest, "hydra-redis-new.rdb.gz");
    assert.equal(fresh.ageHours, REDIS_BACKUP_STALE_HOURS - 1);
    assert.equal(fresh.stale, false);
    const atThreshold = NOW - REDIS_BACKUP_STALE_HOURS * HOUR;
    const stale = data(collectRedisBackup([{ name: "hydra-redis-x.rdb.gz", mtimeMs: atThreshold }], NOW));
    assert.equal(stale.ageHours, REDIS_BACKUP_STALE_HOURS);
    assert.equal(stale.stale, true);
    for (const mtimeMs of [justUnder, atThreshold]) {
      const watchdog = decideRedisBackup({ name: "x", mtimeS: Math.floor(mtimeMs / 1000) }, Math.floor(NOW / 1000), REDIS_BACKUP_STALE_HOURS);
      assert.equal(data(collectRedisBackup([{ name: "hydra-redis-x.rdb.gz", mtimeMs }], NOW)).stale, watchdog.stale);
    }
  });

  test("a missing backup directory lists as empty, so the collector reports NONE FOUND instead of failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-collect-backup-"));
    try {
      const listed = listDirFiles(join(dir, "absent"));
      assert.deepEqual(listed, []);
      const none = collectRedisBackup(listed, NOW);
      assert.equal(data(none).stale, true);
      assert.match(renderText("redis-backup", none), /^redis-backup: NONE FOUND/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that cannot be stat-ed is left out of the listing; the rest are kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-collect-backup-"));
    try {
      writeFileSync(join(dir, "hydra-redis-kept.rdb.gz"), "x");
      symlinkSync(join(dir, "gone"), join(dir, "hydra-redis-vanished.rdb.gz"));
      const listed = listDirFiles(dir);
      assert.deepEqual(listed.map((f) => f.name), ["hydra-redis-kept.rdb.gz"]);
      assert.equal(data(collectRedisBackup(listed, Date.now())).newest, "hydra-redis-kept.rdb.gz");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("redis-backup with no dump is a stale finding, not a failure", () => {
    const none = collectRedisBackup([{ name: "notes.txt", mtimeMs: NOW }], NOW);
    assert.equal(data(none).newest, null);
    assert.equal(data(none).stale, true);
    assert.match(renderText("redis-backup", none), /^redis-backup: NONE FOUND/);
  });

  test("journal-errors keeps the last ten error-shaped lines and drops deprecation noise", () => {
    const noise = "node: (node:1) DeprecationWarning: failed thing";
    const text = [...Array.from({ length: 12 }, (_, i) => `line ${i} Error: boom`), "all fine", noise, "request Rejected"].join("\n");
    const d = data(collectJournalErrors({ text, truncated: true }, "u.service", 1));
    assert.equal(d.matched, 13);
    assert.equal(d.lines.length, 10);
    assert.equal(d.lines.at(-1), "request Rejected");
    assert.equal(d.lines.includes(noise), false);
    assert.equal(d.truncated, true);
    assert.equal(d.timedOut, false);
    assert.equal(data(collectJournalErrors({ text: "" }, "u.service", 1)).matched, 0);
  });

  test("target-git counts dirty files and commits in the window", () => {
    const d = data(collectTargetGit(" M a.ts\n?? b.ts\n", "abc one\ndef two\nghi three\n", 6));
    assert.equal(d.dirtyFiles, 2);
    assert.equal(d.commits, 3);
    assert.deepEqual(d.commitSample, ["abc one", "def two", "ghi three"]);
    assert.deepEqual(data(collectTargetGit("", "", 6)), { windowHours: 6, dirtyFiles: 0, dirtySample: [], commits: 0, commitSample: [] });
  });
});

describe("kill-chain collector", () => {
  const row = (path: string, status: string, touched: string) => `| \`${path}\` | ${status} | reason | ${touched} |`;
  const breachAge = WIRING_GRACE_DAYS + WIRING_SLO_DAYS + 1;

  test("flags a wire-or-retire module past the soft SLO and ranks breaches oldest first", () => {
    const ledger = [
      "| Module | Status | Reason | Last touched |",
      "|---|---|---|---|",
      row("src/old.ts", "wire-or-retire", daysAgo(breachAge + 10)),
      row("src/older.ts", "wire-or-retire", daysAgo(breachAge + 20)),
      row("src/young.ts", "wire-or-retire", daysAgo(WIRING_GRACE_DAYS + WIRING_SLO_DAYS)),
      row("src/wait.ts", "awaiting-wiring", daysAgo(400)),
      row("src/prov.ts", "protected-provider", daysAgo(400)),
    ].join("\n");
    const result = collectKillChain(ledger, JSON.stringify({ unusedExports: 3, orphanModules: 1 }), NOW);
    const d = data(result);
    assert.equal(d.verdict, "FLAG");
    assert.equal(d.ledger?.modules, 5);
    assert.equal(d.ledger?.wireOrRetire, 3);
    assert.equal(d.ledger?.awaitingWiring, 1);
    assert.equal(d.ledger?.protectedProvider, 1);
    assert.deepEqual(d.ledger?.breaches.map((b) => b.path), ["src/older.ts", "src/old.ts"]);
    assert.equal(d.ledger?.oldestPastGrace?.daysPastGrace, WIRING_SLO_DAYS + 21);
    assert.deepEqual(d.baseline, { unusedExports: 3, unreachableProductionFiles: null, testOnlyModules: null, orphanModules: 1 });
    assert.match(renderText("kill-chain", result), /^kill-chain: FLAG/);
  });

  test("a row whose last-touched date cannot be parsed is never flagged", () => {
    const ledger = [row("src/a.ts", "wire-or-retire", "unknown"), row("src/b.ts", "wire-or-retire", "2026-13-45")].join("\n");
    const result = collectKillChain(ledger, null, NOW);
    const d = data(result);
    assert.equal(d.ledger?.wireOrRetire, 2);
    assert.equal(d.ledger?.breachCount, 0);
    assert.equal(d.ledger?.oldestPastGrace, null);
    assert.equal(d.verdict, "quiet");
    assert.match(renderText("kill-chain", result), /^kill-chain: quiet/);
    assert.equal(daysPastGrace("not-a-date", NOW), null);
    assert.equal(daysPastGrace(daysAgo(WIRING_GRACE_DAYS + 7), NOW), 7);
  });

  test("an absent ledger or an unparseable baseline is reported in a note, not thrown", () => {
    const d = data(collectKillChain(null, "{nope", NOW));
    assert.equal(d.verdict, "quiet");
    assert.equal(d.ledger, null);
    assert.equal(d.ledgerNote, "ledger absent");
    assert.equal(d.baseline, null);
    assert.match(d.baselineNote ?? "", /^baseline unparseable/);
  });
});

describe("reframe-saves, cost-by-class, today, architecture", () => {
  test("reframe-saves windows on the ISO timestamp and excludes an undated event", () => {
    const save = (timestamp: unknown, anchorRef: string) => ({ type: "target:reframe-save", timestamp, payload: { anchorRef, reason: "r" } });
    const d = data(
      collectReframeSaves(
        [
          save(new Date(NOW - 2 * HOUR).toISOString(), "in-window"),
          save(new Date(NOW - 30 * HOUR).toISOString(), "too-old"),
          save(undefined, "undated"),
          save("not a date", "garbled"),
          { type: "other:event", timestamp: new Date(NOW).toISOString() },
        ],
        NOW,
        24,
      ),
    );
    assert.equal(d.count, 1);
    assert.equal(d.undateable, 2);
    assert.equal(d.scanned, 5);
    assert.deepEqual(d.sample.map((s) => s.anchorRef), ["in-window"]);
    assert.equal(failure(collectReframeSaves({}, NOW, 24)).code, "bad-input");
  });

  test("cost-by-class ranks classes by tokens and keeps the source", () => {
    const d = data(
      collectCostByClass({
        date: "2026-06-15",
        source: "transcript-24h",
        totalTokens: 300,
        byClass: {
          small: { tokens: 100, fraction: 0.3333, skills: [{ skill: "s1", tokens: 1 }] },
          big: { tokens: 200, fraction: 0.6667, quotaWeight: 2, skills: [{ skill: "lo", tokens: 1 }, { skill: "hi", tokens: 9 }] },
        },
      }),
    );
    assert.deepEqual(d.classes.map((c) => c.class), ["big", "small"]);
    assert.equal(d.classes[0].sharePct, 66.7);
    assert.deepEqual(d.classes[0].topSkills, ["hi", "lo"]);
    assert.equal(d.classes[1].quotaWeight, null);
    assert.equal(d.source, "transcript-24h");
    assert.equal(failure(collectCostByClass({})).code, "bad-input");
  });

  test("today keeps the merges inside the window and carries the closed-issue count", () => {
    const summary = { mergeCount: 2, runCount: 5, costSpent: 0, headroom: "green", issuesOpened: 4 };
    const merges = {
      items: [
        { prNumber: 2, title: "new", mergedAt: new Date(NOW - HOUR).toISOString() },
        { prNumber: 1, title: "old", mergedAt: new Date(NOW - 30 * HOUR).toISOString() },
        { prNumber: 0, title: "undated" },
      ],
      limit: 50,
    };
    const d = data(collectToday(summary, merges, { count: 3, truncated: false }, NOW, 24));
    assert.deepEqual(d.merges.map((m) => m.prNumber), [2]);
    assert.equal(d.issuesOpened, 4);
    assert.equal(d.issuesClosed, 3);
    assert.equal(d.issuesClosedNote, null);
    assert.equal(d.mergesUnavailable, false);
    assert.equal(d.mergesTruncated, false);
    assert.equal(d.mergesNote, null);
  });

  test("today reports an unknown closed count as null, never as zero", () => {
    const d = data(collectToday({ mergeCount: 0 }, { error: "http-error" }, { error: "gh-timeout" }, NOW, 24));
    assert.equal(d.issuesClosed, null);
    assert.match(d.issuesClosedNote ?? "", /gh-timeout/);
    assert.deepEqual(d.merges, []);
    const ok = { items: [], limit: 50 };
    assert.match(data(collectToday({}, ok, { count: 200, truncated: true }, NOW, 24)).issuesClosedNote ?? "", /floor/);
    assert.equal(failure(collectToday(null, ok, { count: 0, truncated: false }, NOW, 24)).code, "bad-input");
  });

  test("today tells a failed merges read from an empty one", () => {
    const failed = data(collectToday({}, { error: "http-error" }, { count: 0, truncated: false }, NOW, 24));
    assert.deepEqual(failed.merges, []);
    assert.equal(failed.mergesUnavailable, true);
    assert.equal(failed.mergesTruncated, false);
    assert.match(failed.mergesNote ?? "", /http-error/);
    const empty = data(collectToday({}, { items: [], limit: 50 }, { count: 0, truncated: false }, NOW, 24));
    assert.equal(empty.mergesUnavailable, false);
    assert.equal(empty.mergesNote, null);
  });

  test("today flags a truncated merge list only while the oldest fetched merge is still inside the window", () => {
    const at = (hoursAgo: number, n: number) => ({ prNumber: n, mergedAt: new Date(NOW - hoursAgo * HOUR).toISOString() });
    const inside = data(collectToday({}, { items: [at(1, 1), at(20, 2)], limit: 2 }, { count: 0, truncated: false }, NOW, 24));
    assert.equal(inside.mergesTruncated, true);
    assert.match(inside.mergesNote ?? "", /floor/);
    // Order-independent: the oldest item is found wherever it sits.
    const reversed = data(collectToday({}, { items: [at(20, 2), at(1, 1)], limit: 2 }, { count: 0, truncated: false }, NOW, 24));
    assert.equal(reversed.mergesTruncated, true);
    // The limit was hit but the oldest merge predates the window: the window is fully covered.
    const covered = data(collectToday({}, { items: [at(1, 1), at(30, 2)], limit: 2 }, { count: 0, truncated: false }, NOW, 24));
    assert.equal(covered.mergesTruncated, false);
    assert.equal(covered.mergesNote, null);
    const short = data(collectToday({}, { items: [at(1, 1)], limit: 2 }, { count: 0, truncated: false }, NOW, 24));
    assert.equal(short.mergesTruncated, false);
  });

  test("architecture keeps the ten most-tangled modules", () => {
    const tangledModules = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, group: "g", fanIn: i, fanOut: 1, fanTotal: i + 1, cycleSize: 2 }));
    const d = data(collectArchitecture({ moduleCount: 40, edgeCount: 90, scannedAt: "2026-06-15T00:00:00Z", tangledModules }));
    assert.equal(d.moduleCount, 40);
    assert.equal(d.tangled.length, 10);
    assert.equal(d.tangled[0].id, "m0");
    assert.equal(failure(collectArchitecture({ moduleCount: 1 })).code, "bad-input");
  });
});

describe("--text renderers for cycles, board and memory", () => {
  /** One unindented summary line, then only two-space-indented rows. */
  function assertShape(name: string, out: string) {
    const lines = out.split("\n");
    assert.match(lines[0], new RegExp(`^${name}: \\S`), out);
    for (const l of lines.slice(1)) assert.match(l, /^ {2}\S/, `detail row of ${name}: ${l}`);
    assert.doesNotMatch(out, /[{[]"/, "no raw JSON reaches --text");
  }

  test("cycles: one summary line, then anchors, repeated tasks, recent cycles and unrecorded classes", () => {
    const metrics = collectCycles({
      trend: [
        { tasksMerged: 1, anchorType: "feature", taskTitle: "t1", totalDurationMs: 60000, costUsd: 2, testsAfter: 110 },
        { tasksFailed: 1, anchorType: "feature", taskTitle: "t1", testsAfter: 100 },
      ],
      coverage: { recordedClasses: ["dev_orch"], classesNotRecorded: ["qa_orch"] },
    });
    const out = renderText("cycles", metrics);
    assertShape("cycles", out);
    const lines = out.split("\n");
    assert.match(lines[0], /2 cycles, 1 merged \(50%\), 1 failed, 0 abandoned/);
    assert.deepEqual(
      lines.slice(1).map((l) => l.trim().split(":")[0].split(" ")[0]),
      ["anchors", "repeated", "recent", "recent", "classes"],
    );
    assert.match(out, /classes not recorded: qa_orch/);
  });

  test("cycles: null durations and cost render as n/a, and a missing coverage block adds no row", () => {
    const out = renderText("cycles", collectCycles({ trend: [{ tasksMerged: 1, taskTitle: "x" }] }));
    assertShape("cycles", out);
    assert.match(out, /n\/a/);
    assert.doesNotMatch(out, /classes not recorded/);
  });

  test("board: one summary line, labels by count descending then name, a floor marker when truncated", () => {
    const rows = [
      { number: 1, title: "a", labels: ["zeta", "alpha"] },
      { number: 2, title: "b", labels: ["alpha"] },
      { number: 3, title: "c", labels: ["beta"] },
    ];
    const out = renderText("board", collectBoard(rows, 3));
    assertShape("board", out);
    const lines = out.split("\n");
    assert.match(lines[0], /3 open/);
    assert.match(lines[0], /at least/);
    assert.deepEqual(
      lines.slice(1).map((l) => l.trim().split(":")[0]),
      ["alpha", "beta", "zeta"],
    );
    assert.doesNotMatch(renderText("board", collectBoard(rows, 200)), /at least/);
  });

  test("board: an empty board is one line with no detail rows", () => {
    const out = renderText("board", collectBoard([], 200));
    assertShape("board", out);
    assert.equal(out.split("\n").length, 1);
  });

  test("memory: agents in read order, then FAILED rows, and null last-seen renders as n/a", () => {
    const reads = [
      { agent: "planner", raw: JSON.stringify([{ hitCount: 2, category: "a", lastSeen: "2026-06-01" }]) },
      { agent: "coder", raw: JSON.stringify([{ category: "b" }]) },
      { agent: "broken", error: "ECONNREFUSED" },
    ];
    const out = renderText("memory", collectMemory(reads));
    assertShape("memory", out);
    const lines = out.split("\n");
    assert.match(lines[0], /2 agents read, 1 failed/);
    assert.match(lines[1], /^ {2}planner:/);
    assert.match(lines[2], /^ {2}coder: .*n\/a/);
    assert.match(lines[3], /^ {2}FAILED broken: redis-error \(ECONNREFUSED\)/);
  });

  test("a renderer is total: a summary with null fields never throws", () => {
    const board = { open: 0, truncated: false, byLabel: { x: 1 }, samples: {} };
    assert.doesNotThrow(() => renderText("board", { ok: true, data: board }));
    const cycles = { cycles: 0, merged: 0, failed: 0, abandoned: 0, mergeRatePct: 0, fixes: 0, features: 0, avgDurationSec: null, medianDurationSec: null, maxDurationSec: null, avgCostUsd: null, totalCostUsd: null, testsFirst: 0, testsLast: 0, testsDelta: 0, anchors: {}, repeatedTasks: [], recent: [], coverage: null };
    assert.doesNotThrow(() => renderText("cycles", { ok: true, data: cycles }));
  });
});

describe("targetPaths", () => {
  test("reads workspace and app dir from Target facts, and returns null for anything unusable", () => {
    assert.deepEqual(targetPaths({ workspace: "/w", manifest: { ok: true, appSubdir: "web" } }), { workspace: "/w", appDir: "/w/web" });
    assert.deepEqual(targetPaths({ workspace: "/w", manifest: { ok: false } }), { workspace: "/w", appDir: "/w" });
    assert.deepEqual(targetPaths({ workspace: "/w" }), { workspace: "/w", appDir: "/w" });
    assert.equal(targetPaths({}), null);
    assert.equal(targetPaths(null), null);
    assert.equal(targetPaths("x"), null);
  });
});

describe("result rendering and Target summary", () => {
  test("a failure renders as code (reason); a skip renders as skipped (reason)", () => {
    assert.equal(renderText("cycles", fail("unreachable", "down")), "cycles: unreachable (down)");
    assert.equal(renderText("kill-chain", skip("target-unresolved", "Target unresolved")), "kill-chain: skipped (Target unresolved)");
    assert.deepEqual(skip("c", "r"), { ok: false, skipped: true, code: "c", reason: "r" });
  });

  test("the Target is unresolved without a name or a workspace", () => {
    assert.equal(summariseTarget({ name: "acme", workspace: "/w", serviceName: "acme.service" }).resolved, true);
    assert.equal(summariseTarget({ name: "acme", workspace: "" }).resolved, false);
    assert.equal(summariseTarget(null).resolved, false);
    assert.match(
      summariseTarget({ name: "acme", workspace: "/w", manifest: { ok: false, errors: ["bad manifest"] } }).note,
      /manifest invalid: bad manifest/,
    );
  });
});

/** Adapters that fail every read unless overridden, so a test names exactly what it uses. */
function fakeAdapters(over: Partial<Adapters> = {}): Adapters {
  const down = async () => {
    throw new Error("adapter not stubbed");
  };
  return {
    getJson: async (path) => fail("unreachable", path),
    classesDoc: () => ({ classes: [{ learningAgent: "planner" }] }),
    memoryPatterns: down,
    openIssues: async () => ({ error: "gh-failed" }),
    closedIssuesSince: async () => ({ error: "gh-failed" }),
    redisInfo: down,
    redisDbSize: down,
    systemdFiles: () => ["hydra-a.timer"],
    userTimers: async () => ({ error: "host-probe-enoent" }),
    unitEnabledState: async () => null,
    dirFiles: () => {
      throw new Error("ENOENT");
    },
    journal: async () => ({ error: "journal-enoent" }),
    targetFacts: () => ({ name: "acme", workspace: "/ws/acme", serviceName: "acme.service", manifest: { ok: true, appSubdir: "web" } }),
    targetCapabilities: () => ({}),
    git: async () => ({ error: "git-failed" }),
    readText: () => {
      throw new Error("ENOENT");
    },
    now: () => NOW,
    ...over,
  };
}

async function runJson(argv: string[], over: Partial<Adapters> = {}, timeoutMs?: number) {
  return JSON.parse(await run(argv, fakeAdapters(over), timeoutMs));
}

describe("ops-collect CLI, in process", () => {
  test("prints the envelope: generatedAt, the resolved Target, one result per requested collector", async () => {
    const out = await runJson(["--collectors", "scheduler,bogus"], {
      getJson: async () => ({ ok: true, data: { running: true, cyclesRun: 3, consecutiveErrors: 0 } }),
    });
    assert.equal(out.generatedAt, new Date(NOW).toISOString());
    assert.equal(out.target.resolved, true);
    assert.equal(out.target.name, "acme");
    assert.deepEqual(Object.keys(out.collectors), ["scheduler", "bogus"]);
    assert.deepEqual(out.collectors.scheduler, { ok: true, data: { running: true, cyclesRun: 3, consecutiveErrors: 0 } });
    assert.equal(out.collectors.bogus.code, "unknown-collector");
  });

  test("with every adapter down, every collector still reports its own failure", async () => {
    const out = await runJson([]);
    assert.deepEqual(Object.keys(out.collectors), Object.keys(COLLECTORS));
    for (const [name, result] of Object.entries(out.collectors) as Array<[string, { ok: boolean; code?: string }]>) {
      assert.equal(result.ok, false, `${name} should have failed`);
      assert.ok(result.code, `${name} carries a code`);
    }
  });

  test("a trailing --collectors with no value runs the default set", async () => {
    const out = await runJson(["--collectors"]);
    assert.deepEqual(Object.keys(out.collectors), Object.keys(COLLECTORS));
  });

  test("an absent flag takes its default instead of reading the first argument", async () => {
    const paths: string[] = [];
    const getJson: Adapters["getJson"] = async (path) => {
      paths.push(path);
      return fail("unreachable", path);
    };
    await run(["7", "--collectors", "cycles,today"], fakeAdapters({ getJson }));
    assert.ok(paths.includes("/api/metrics?count=50"), paths.join(" "));
    assert.ok(paths.includes("/api/today/summary?windowHours=24"), paths.join(" "));
    paths.length = 0;
    await run(["--collectors", "cycles,today", "--count", "9", "--window-hours", "48"], fakeAdapters({ getJson }));
    assert.ok(paths.includes("/api/metrics?count=9"), paths.join(" "));
    assert.ok(paths.includes("/api/today/summary?windowHours=48"), paths.join(" "));
  });

  test("an unresolved Target skips the Target collectors and keeps the rest running", async () => {
    const out = await runJson(["--collectors", "target-git,kill-chain,timers"], {
      targetFacts: () => ({ name: "", workspace: "" }),
      userTimers: async () => [],
      unitEnabledState: async () => "enabled",
    });
    assert.equal(out.target.resolved, false);
    assert.equal(out.target.name, null);
    for (const name of ["target-git", "kill-chain"]) {
      assert.deepEqual(out.collectors[name], skip("target-unresolved", "Target unresolved"));
    }
    assert.equal(out.collectors.timers.ok, true);
    assert.equal(out.collectors.timers.data.target.status, "skipped");
  });

  test("a Target config that cannot be read is an unresolved Target, not a crash", async () => {
    const out = await runJson(["--collectors", "target-git"], {
      targetFacts: () => {
        throw new Error("target.json unreadable");
      },
    });
    assert.equal(out.target.resolved, false);
    assert.match(out.target.note, /target\.json unreadable/);
    assert.equal(out.collectors["target-git"].skipped, true);
  });

  test("kill-chain is skipped when the Target carries neither file, and reads them from the Target workspace when it does", async () => {
    const absent = await runJson(["--collectors", "kill-chain"]);
    assert.equal(absent.collectors["kill-chain"].skipped, true);
    assert.equal(absent.collectors["kill-chain"].code, "capability-absent");

    const read: string[] = [];
    const probed: string[][] = [];
    const present = await runJson(["--collectors", "kill-chain"], {
      targetCapabilities: (workspace, appDir) => {
        probed.push([workspace, appDir]);
        return { wiringLedger: "docs/ledger.md", deadcodeBaseline: null };
      },
      readText: (path) => {
        read.push(path);
        return `| \`src/x.ts\` | wire-or-retire | r | ${daysAgo(WIRING_GRACE_DAYS + WIRING_SLO_DAYS + 5)} |`;
      },
    });
    assert.deepEqual(probed, [["/ws/acme", "/ws/acme/web"]]);
    assert.deepEqual(read, ["/ws/acme/docs/ledger.md"]);
    assert.equal(present.collectors["kill-chain"].data.verdict, "FLAG");
    assert.equal(present.collectors["kill-chain"].data.baselineNote, "baseline absent");
  });

  test("target-git runs git in the resolved Target workspace over the requested window", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const out = await runJson(["--collectors", "target-git", "--window-hours", "12"], {
      git: async (args, cwd) => {
        calls.push({ args, cwd });
        return { stdout: args[0] === "status" ? " M a\n" : "abc one\n" };
      },
    });
    assert.deepEqual(calls.map((c) => c.cwd), ["/ws/acme", "/ws/acme"]);
    assert.ok(calls.some((c) => c.args.includes("--since=12 hours ago")));
    assert.deepEqual(out.collectors["target-git"].data, { windowHours: 12, dirtyFiles: 1, dirtySample: [" M a"], commits: 1, commitSample: ["abc one"] });
  });

  test("timers asks systemd about exactly the repo's timer files and the resolved Target's glob", async () => {
    const asked: string[] = [];
    const out = await runJson(["--collectors", "timers"], {
      systemdFiles: () => ["hydra-a.timer", "hydra-a.service", "hydra-b.timer"],
      unitEnabledState: async (unit) => {
        asked.push(unit);
        return unit === "hydra-b.timer" ? "disabled" : "enabled";
      },
      userTimers: async () => [
        { unit: "hydra-a.timer", last: 1, next: 1 },
        { unit: "acme-job.timer", last: 1, next: 1 },
      ],
    });
    assert.deepEqual(asked.sort(), ["hydra-a.timer", "hydra-b.timer"]);
    const d = out.collectors.timers.data;
    assert.deepEqual(d.findings, ["TIMER NOT ENABLED: hydra-b.timer (disabled)"]);
    assert.equal(d.target.pattern, targetTimerPattern("acme"));
    assert.deepEqual(d.target.timers.map((t: { unit: string }) => t.unit), ["acme-job.timer"]);
  });

  test("memory reads every taxonomy agent and survives one failing read", async () => {
    const out = await runJson(["--collectors", "memory"], {
      classesDoc: () => ({ classes: [{ learningAgent: "planner" }, { learningAgent: "executor" }] }),
      memoryPatterns: async (agent) => {
        if (agent === "executor") throw new Error("ECONNREFUSED");
        return JSON.stringify([{ hitCount: 4, category: "c" }]);
      },
    });
    const d = out.collectors.memory.data;
    assert.deepEqual(d.agents.map((a: { agent: string }) => a.agent), ["planner"]);
    assert.deepEqual(d.failed, [{ agent: "executor", code: "redis-error", reason: "ECONNREFUSED" }]);
  });

  test("memory fails as one result when Redis is down or the taxonomy is unreadable", async () => {
    const down = await runJson(["--collectors", "memory"]);
    assert.equal(down.collectors.memory.code, "memory-unavailable");
    const noDoc = await runJson(["--collectors", "memory"], {
      classesDoc: () => {
        throw new Error("classes.json missing");
      },
    });
    assert.equal(noDoc.collectors.memory.code, "classes-unreadable");
  });

  test("board reports the adapter's failure code; today survives a failed merges and closed-issue read", async () => {
    const out = await runJson(["--collectors", "board,today"], {
      getJson: async (path) => (path.startsWith("/api/today/summary") ? { ok: true, data: { mergeCount: 1, issuesOpened: 2 } } : fail("http-error", path)),
    });
    assert.equal(out.collectors.board.code, "gh-failed");
    assert.equal(out.collectors.today.data.mergeCount, 1);
    assert.equal(out.collectors.today.data.issuesClosed, null);
    assert.equal(out.collectors.today.data.mergesUnavailable, true);
    assert.match(out.collectors.today.data.mergesNote, /http-error/);
  });

  test("today flags a merge list that hit the request limit inside the window", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ prNumber: i, mergedAt: new Date(NOW - (i + 1) * 60_000).toISOString() }));
    const out = await runJson(["--collectors", "today"], {
      getJson: async (path) => (path.startsWith("/api/today/merges") ? { ok: true, data: { items } } : { ok: true, data: { mergeCount: 50 } }),
    });
    assert.equal(out.collectors.today.data.mergesTruncated, true);
    assert.equal(out.collectors.today.data.mergesUnavailable, false);
  });

  test("a collector that never answers degrades to a timeout without holding up the others", async () => {
    const out = await runJson(
      ["--collectors", "redis-server,scheduler"],
      {
        redisInfo: () => new Promise<string>(() => {}),
        redisDbSize: async () => 1,
        getJson: async () => ({ ok: true, data: { running: false } }),
      },
      30,
    );
    assert.equal(out.collectors["redis-server"].code, "timeout");
    assert.equal(out.collectors.scheduler.ok, true);
  });

  test("a collector whose adapter throws synchronously degrades to its own failure", async () => {
    const out = await runJson(["--collectors", "kill-chain,scheduler"], {
      targetCapabilities: () => {
        throw new Error("probe exploded");
      },
      getJson: async () => ({ ok: true, data: {} }),
    });
    assert.deepEqual(out.collectors["kill-chain"], fail("collector-threw", "probe exploded"));
    assert.equal(out.collectors.scheduler.ok, true);
  });

  test("--text leads with the Target line and prints one line per collector", async () => {
    const text = await run(["--collectors", "bogus,target-git", "--text"], fakeAdapters({ targetFacts: () => ({}) }));
    const lines = text.split("\n");
    assert.match(lines[0], /^target: <unresolved>/);
    assert.match(lines[1], /^bogus: unknown-collector/);
    assert.equal(lines[2], "target-git: skipped (Target unresolved)");
  });

  test("--help documents every collector and every flag", () => {
    const help = helpText();
    for (const name of Object.keys(COLLECTORS)) assert.ok(help.includes(`\n  ${name}\n`), `--help names ${name}`);
    for (const field of ["mergesUnavailable", "mergesTruncated", "mergesNote"]) assert.ok(COLLECTORS.today.help.includes(field), field);
    for (const flag of ["--collectors", "--text", "--window-hours", "--count", "--help"]) assert.ok(help.includes(flag), flag);
  });
});

describe("ops-collect CLI, spawned", () => {
  const cli = new URL("../scripts/ops-collect.ts", import.meta.url).pathname;
  const spawn = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, HYDRA_API_URL: "http://127.0.0.1:1" },
      timeout: 30000,
    });

  test("an unreachable API yields failed results on stdout and exit 0", () => {
    const r = spawn(["--collectors", "cycles,scheduler"]);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.collectors.cycles.ok, false);
    assert.equal(out.collectors.cycles.code, "unreachable");
    assert.equal(out.collectors.scheduler.ok, false);
    assert.equal(typeof out.target.resolved, "boolean");
  });

  test("--help exits 0 and prints the collector list", () => {
    const r = spawn(["--help"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), helpText());
  });

  test("stderr is empty on a normal run and on an API-unreachable run, so a playbook can keep it visible", () => {
    assert.equal(spawn(["--help"]).stderr, "");
    const down = spawn(["--collectors", "cycles,scheduler,today"]);
    assert.equal(down.status, 0);
    assert.equal(down.stderr, "");
  });
});

/** Bodies of every fenced block of a markdown document. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
}

describe("operator playbooks that read through ops-collect", () => {
  const playbooks = ["hydra-architect.md", "hydra-doctor.md"];

  test("the doctor and digest command lines keep stderr visible and keep the unavailable fallback", () => {
    for (const name of ["hydra-doctor.md", "hydra-digest.md"]) {
      const body = readFileSync(new URL(`../docs/operator-playbooks/${name}`, import.meta.url), "utf8");
      const cmds = body.split("\n").filter((l) => l.includes("scripts/ops-collect.ts") && l.startsWith("cd ~/hydra"));
      assert.ok(cmds.length > 0, name);
      for (const c of cmds) {
        assert.doesNotMatch(c, /2>\s*\/dev\/null/, `${name} discards stderr`);
        assert.ok(c.endsWith('|| echo "ops-collect unavailable"'), `${name} keeps the fallback token`);
      }
    }
  });

  for (const name of playbooks) {
    const body = readFileSync(new URL(`../docs/operator-playbooks/${name}`, import.meta.url), "utf8");

    test(`${name} holds no inline parsing and no direct Redis shell-out`, () => {
      assert.doesNotMatch(body, /python3\s+-/);
      assert.doesNotMatch(body, /\bjq\b/);
      assert.doesNotMatch(body, /redis-cli/);
    });

    test(`${name} requests only collectors the CLI ships`, () => {
      const requested = [...body.matchAll(/ops-collect\.ts[^\n]*--collectors ([a-z,-]+)/g)].flatMap((m) => m[1].split(","));
      assert.ok(requested.length > 0, "calls the ops-collect CLI");
      for (const collector of requested) assert.ok(Object.hasOwn(COLLECTORS, collector), collector);
    });
  }

  test("hydra-doctor.md fenced blocks hold raw-output commands only: no variables, loops, branches or text reshaping", () => {
    const doctor = readFileSync(new URL("../docs/operator-playbooks/hydra-doctor.md", import.meta.url), "utf8");
    const blocks = fencedBlocks(doctor);
    assert.ok(blocks.length > 0);
    for (const block of blocks) {
      assert.doesNotMatch(block, /\$\(|`/, `command substitution in:\n${block}`);
      assert.doesNotMatch(block, /^\s*(for|while|if|case)\b/m, `control flow in:\n${block}`);
      assert.doesNotMatch(block, /^\s*[A-Za-z_]+=/m, `variable assignment in:\n${block}`);
      assert.doesNotMatch(block, /\b(awk|sed|cut|xargs)\b/, `text reshaping in:\n${block}`);
    }
  });
});
