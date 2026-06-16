/**
 * Unit tests for the pure Notification Formatter (`src/notify-format.ts`,
 * issue #1512) — the formatting grammar lifted out of `src/notify.ts`.
 *
 * These exercise every arm of the `formatMessage` switch (30+ event types,
 * the dual-shape `cycle:completed` payload, the `reescalation` branch in
 * `cycle:operator_blocked`, and the two `default` fallbacks) with **no
 * network, no env vars, and no `fetch` stub** — the testability win the
 * extraction exists to deliver. The formatter is imported directly from
 * `notify-format.ts` to prove it stands alone, independent of the transport.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { formatMessage } from "../src/notify-format.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";

describe("formatMessage — cycle lifecycle", () => {
  test("cycle:start renders the cycle id", () => {
    const msg = formatMessage({ type: E.CYCLE_START, payload: { cycleId: "c-1" } });
    assert.ok(msg.includes("Cycle Started"));
    assert.ok(msg.includes("c-1"));
  });

  test("cycle:completed (task shape, merged) renders icon, task, tests, commit, files, duration", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: {
        cycleId: "c-2",
        task: { finalState: "merged", title: "Add X" },
        grounding: { before: { passed: 10 }, after: { passed: 12 } },
        commitSha: "abcdef1234567890",
        filesChanged: ["a.ts", "b.ts"],
        durationMs: 4200,
      },
    });
    assert.ok(msg.includes("✅"));
    assert.ok(msg.includes("Cycle Complete — merged"));
    assert.ok(msg.includes("Task: Add X"));
    assert.ok(msg.includes("10 → 12 passing"));
    assert.ok(msg.includes("abcdef1")); // 7-char short sha
    assert.ok(msg.includes("Files: 2 changed"));
    assert.ok(msg.includes("Duration: 4s"));
  });

  test("cycle:completed (task shape, rolled-back) shows the rollback icon + regression + risk", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: {
        cycleId: "c-3",
        task: { finalState: "rolled-back", title: "Risky" },
        rolledBack: true,
        rollbackRisk: "high",
      },
    });
    assert.ok(msg.includes("⏪"));
    assert.ok(msg.includes("auto-reverted"));
    assert.ok(msg.includes("Risk: HIGH"));
    assert.ok(msg.includes("Duration: ?")); // no durationMs -> "?"
  });

  test("cycle:completed (task shape, other final state) uses the default icon", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: { cycleId: "c-3b", task: { finalState: "failed", title: "Nope" } },
    });
    assert.ok(msg.includes("📋"));
    assert.ok(msg.includes("Cycle Complete — failed"));
  });

  test("cycle:completed (count-only fallback shape) renders the succeeded/failed counts", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: { total: 5, completed: 4, failed: 1 },
    });
    assert.ok(msg.includes("Cycle Complete"));
    assert.ok(msg.includes("4/5 tasks succeeded"));
    assert.ok(msg.includes("1 failed"));
  });

  test("cycle:completed (count-only, zero failed) omits the failed clause", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: { total: 3, completed: 3 },
    });
    assert.ok(msg.includes("3/3 tasks succeeded"));
    assert.ok(!msg.includes("failed"));
  });

  test("cycle:stalled renders elapsed + in-progress", () => {
    const msg = formatMessage({
      type: E.CYCLE_STALLED,
      payload: { cycleId: "c-4", elapsed: "2h", inProgress: 3 },
    });
    assert.ok(msg.includes("Cycle Stalled"));
    assert.ok(msg.includes("Elapsed: 2h"));
    assert.ok(msg.includes("3 tasks still active"));
  });

  test("cycle:failed renders the error", () => {
    const msg = formatMessage({ type: E.CYCLE_FAILED, payload: { cycleId: "c-5", error: "boom" } });
    assert.ok(msg.includes("Cycle Failed"));
    assert.ok(msg.includes("Error: boom"));
  });

  test("cycle:auto_killed renders TTL detail", () => {
    const msg = formatMessage({
      type: E.CYCLE_AUTO_KILLED,
      payload: { cycleId: "c-6", elapsed: "9h", ttl: "8h", tasksTimedOut: 2 },
    });
    assert.ok(msg.includes("Auto-Killed"));
    assert.ok(msg.includes("9h > 8h"));
    assert.ok(msg.includes("2 tasks timed out"));
  });

  test("cycle:stale_priorities renders the message", () => {
    const msg = formatMessage({ type: E.CYCLE_STALE_PRIORITIES, payload: { message: "update me" } });
    assert.ok(msg.includes("Stale Priorities"));
    assert.ok(msg.includes("update me"));
  });
});

describe("formatMessage — task events", () => {
  test("task:rejected renders id, title, reason", () => {
    const msg = formatMessage({
      type: E.TASK_REJECTED,
      payload: { taskId: "t-1", title: "Bad idea", reason: "out of scope" },
    });
    assert.ok(msg.includes("Rejected by Skeptic"));
    assert.ok(msg.includes("t-1"));
    assert.ok(msg.includes("Bad idea"));
    assert.ok(msg.includes("out of scope"));
  });

  test("task:verification_failed joins failed steps", () => {
    const msg = formatMessage({
      type: E.TASK_VERIFICATION_FAILED,
      payload: { taskId: "t-2", title: "Flaky", failedSteps: ["typecheck", "test"] },
    });
    assert.ok(msg.includes("Verification Failed"));
    assert.ok(msg.includes("typecheck, test"));
  });

  test("task:drift_detected uses the drift reason", () => {
    const msg = formatMessage({
      type: E.TASK_DRIFT_DETECTED,
      payload: { taskId: "t-3", title: "Dup", drift: { reason: "same as #100" } },
    });
    assert.ok(msg.includes("Drift Detected"));
    assert.ok(msg.includes("same as #100"));
  });

  test("task:drift_detected falls back when no drift reason", () => {
    const msg = formatMessage({
      type: E.TASK_DRIFT_DETECTED,
      payload: { taskId: "t-3b", title: "Dup" },
    });
    assert.ok(msg.includes("Duplicate of recent work"));
  });

  test("task:merge_failed renders the error", () => {
    const msg = formatMessage({
      type: E.TASK_MERGE_FAILED,
      payload: { taskId: "t-4", title: "Conflict", error: "merge conflict" },
    });
    assert.ok(msg.includes("Merge Failed"));
    assert.ok(msg.includes("merge conflict"));
  });

  test("task:shelved renders the reason", () => {
    const msg = formatMessage({ type: E.TASK_SHELVED, payload: { taskId: "t-5", reason: "deferred" } });
    assert.ok(msg.includes("Task Shelved"));
    assert.ok(msg.includes("deferred"));
  });
});

describe("formatMessage — rollback", () => {
  test("cycle:rollback renders reverted commit + tests", () => {
    const msg = formatMessage({
      type: E.CYCLE_ROLLBACK,
      payload: { cycleId: "c-7", title: "T", revertedCommit: "deadbeefcafe", testsBefore: 5, testsAfter: 3 },
    });
    assert.ok(msg.includes("Auto-Rollback"));
    assert.ok(msg.includes("deadbee")); // 7-char short sha
    assert.ok(msg.includes("5 → 3 passing"));
  });

  test("cycle:rollback_failed renders commit + error", () => {
    const msg = formatMessage({
      type: E.CYCLE_ROLLBACK_FAILED,
      payload: { cycleId: "c-8", title: "T", commitSha: "feedface0000", error: "no parent", testsBefore: 5, testsAfter: 0 },
    });
    assert.ok(msg.includes("Rollback FAILED"));
    assert.ok(msg.includes("feedfac"));
    assert.ok(msg.includes("no parent"));
    assert.ok(msg.includes("5 → 0"));
  });
});

describe("formatMessage — scheduler", () => {
  test("scheduler:stopped renders reason + cycles run", () => {
    const msg = formatMessage({ type: E.SCHEDULER_STOPPED, payload: { reason: "operator", cyclesRun: 7 } });
    assert.ok(msg.includes("Scheduler Stopped"));
    assert.ok(msg.includes("operator"));
    assert.ok(msg.includes("7"));
  });

  test("scheduler:backlog_empty renders message + suggestion", () => {
    const msg = formatMessage({
      type: E.SCHEDULER_BACKLOG_EMPTY,
      payload: { message: "no work", suggestion: "run research" },
    });
    assert.ok(msg.includes("Backlog Empty"));
    assert.ok(msg.includes("no work"));
    assert.ok(msg.includes("run research"));
  });

  test("scheduler:paused_repetition lists recent titles (truncated)", () => {
    const longTitle = "x".repeat(100);
    const msg = formatMessage({
      type: E.SCHEDULER_PAUSED_REPETITION,
      payload: { reason: "loop", recentTitles: [longTitle, "short one"], suggestion: "diversify" },
    });
    assert.ok(msg.includes("Repetitive Work Detected"));
    assert.ok(msg.includes("loop"));
    assert.ok(msg.includes("short one"));
    assert.ok(msg.includes("diversify"));
    // titles are truncated to 70 chars
    assert.ok(msg.includes("• " + "x".repeat(70)));
    assert.ok(!msg.includes("x".repeat(71)));
  });
});

describe("formatMessage — research", () => {
  test("research:completed renders project, counts, and top opportunities + summary", () => {
    const msg = formatMessage({
      type: E.RESEARCH_COMPLETED,
      payload: {
        projectName: "hydra",
        opportunityCount: 4,
        autoQueued: 2,
        duration: "10m",
        cost: "$1",
        topOpportunities: ["faster CI", "fewer flakes"],
        summary: "good run",
      },
    });
    assert.ok(msg.includes("Research Complete"));
    assert.ok(msg.includes("Project: hydra"));
    assert.ok(msg.includes("4 opportunities found, 2 auto-queued"));
    assert.ok(msg.includes("10m | Cost: $1"));
    assert.ok(msg.includes("• faster CI"));
    assert.ok(msg.includes("good run"));
  });

  test("research:completed omits top picks + summary when absent", () => {
    const msg = formatMessage({
      type: E.RESEARCH_COMPLETED,
      payload: { projectName: "hydra", opportunityCount: 0, autoQueued: 0, duration: "1m", cost: "$0" },
    });
    assert.ok(msg.includes("Research Complete"));
    assert.ok(!msg.includes("Top picks:"));
  });

  test("architect:review_completed renders the review counts", () => {
    const msg = formatMessage({
      type: E.ARCHITECT_REVIEW_COMPLETED,
      payload: { researchCyclesReviewed: 3, executionCyclesReviewed: 5, updatesApplied: 2, calibration: "ok" },
    });
    assert.ok(msg.includes("Architect Review"));
    assert.ok(msg.includes("3 research + 5 execution"));
    assert.ok(msg.includes("2 methodology updates"));
    assert.ok(msg.includes("Calibration: ok"));
  });
});

describe("formatMessage — deploy + DLQ", () => {
  test("deploy:completed renders the task id", () => {
    const msg = formatMessage({ type: E.DEPLOY_COMPLETED, payload: { taskId: "d-1" } });
    assert.ok(msg.includes("Deployed"));
    assert.ok(msg.includes("d-1"));
  });

  test("deploy:failed renders the reason (and defaults to unknown)", () => {
    const withReason = formatMessage({ type: E.DEPLOY_FAILED, payload: { taskId: "d-2", reason: "ci red" } });
    assert.ok(withReason.includes("Deploy Failed"));
    assert.ok(withReason.includes("ci red"));
    const noReason = formatMessage({ type: E.DEPLOY_FAILED, payload: { taskId: "d-3" } });
    assert.ok(noReason.includes("unknown"));
  });

  test("dlq:alert renders stream/event/error/attempts", () => {
    const msg = formatMessage({
      type: E.DLQ_ALERT,
      payload: { originalStream: "hydra:x", eventType: "task:foo", error: "bad", deliveryCount: 3 },
    });
    assert.ok(msg.includes("Dead Letter"));
    assert.ok(msg.includes("hydra:x"));
    assert.ok(msg.includes("task:foo"));
    assert.ok(msg.includes("Attempts: 3"));
  });
});

describe("formatMessage — review pickup", () => {
  test("review:pickup_ready renders count (plural), command, first item + link", () => {
    const msg = formatMessage({
      type: E.REVIEW_PICKUP_READY,
      payload: { count: 3, firstTitle: "Decide tier", firstUrl: "https://x/710" },
    });
    assert.ok(msg.includes("3 items"));
    assert.ok(msg.includes("/hydra-review"));
    assert.ok(msg.includes("First: Decide tier — https://x/710"));
  });

  test("review:pickup_ready singular wording for one item, omits link when no url", () => {
    const msg = formatMessage({
      type: E.REVIEW_PICKUP_READY,
      payload: { count: 1, firstTitle: "Only one" },
    });
    assert.ok(msg.includes("1 item need"));
    assert.ok(!msg.includes("1 items"));
    assert.ok(msg.includes("First: Only one"));
  });

  test("review:pickup_ready omits the first-item line when no title", () => {
    const msg = formatMessage({ type: E.REVIEW_PICKUP_READY, payload: { count: 0 } });
    assert.ok(msg.includes("0 items"));
    assert.ok(!msg.includes("First:"));
  });
});

describe("formatMessage — operator blocked", () => {
  test("cycle:operator_blocked renders title, reason, and unblock commands", () => {
    const msg = formatMessage({
      type: E.CYCLE_OPERATOR_BLOCKED,
      payload: { title: "Need creds", blockedReason: "missing secret", unblockCommands: ["export X=1", "restart"] },
    });
    assert.ok(msg.includes("BLOCKED — Operator Action Required"));
    assert.ok(msg.includes('Task: "Need creds"'));
    assert.ok(msg.includes("Reason: missing secret"));
    assert.ok(msg.includes("To unblock, run:"));
    assert.ok(msg.includes("export X=1"));
    assert.ok(msg.includes("restart"));
    assert.ok(!msg.includes("Re-alert"));
  });

  test("cycle:operator_blocked with reescalation appends the re-alert line", () => {
    const msg = formatMessage({
      type: E.CYCLE_OPERATOR_BLOCKED,
      payload: { title: "Stuck", reescalation: true, blockedDays: 4 },
    });
    assert.ok(msg.includes("Re-alert — blocked for 4+ days"));
  });

  test("cycle:operator_blocked omits the unblock block when no commands", () => {
    const msg = formatMessage({
      type: E.CYCLE_OPERATOR_BLOCKED,
      payload: { title: "Stuck", blockedReason: "x" },
    });
    assert.ok(!msg.includes("To unblock, run:"));
    assert.ok(msg.includes("Reason: x"));
  });
});

describe("formatMessage — default arms", () => {
  test("unknown type containing 'failed' uses the warning fallback", () => {
    const msg = formatMessage({ type: "widget:failed", payload: { reason: "kaput" } });
    assert.ok(msg.includes("widget:failed"));
    assert.ok(msg.includes("kaput"));
    assert.ok(msg.startsWith("⚠️"));
  });

  test("unknown non-failed type uses the clipboard fallback (summary/title)", () => {
    const msg = formatMessage({ type: "widget:happened", payload: { title: "hello" } });
    assert.ok(msg.includes("widget:happened"));
    assert.ok(msg.includes("hello"));
    assert.ok(msg.startsWith("📋"));
  });

  test("missing type defaults to 'unknown' and serializes payload", () => {
    const msg = formatMessage({ payload: { foo: "bar" } });
    assert.ok(msg.includes("unknown"));
    assert.ok(msg.includes("bar"));
  });

  test("empty event is handled without throwing", () => {
    const msg = formatMessage({});
    assert.ok(msg.includes("unknown"));
  });
});
