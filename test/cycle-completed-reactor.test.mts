/**
 * test/cycle-completed-reactor.test.mts — covers the `cycle:completed` domain
 * reaction extracted from src/notification-consumer.ts into its own focused
 * Seam at src/notification/cycle-completed-reactor.ts (issue #1983).
 *
 * The whole point of the extraction is testability: the reaction can be
 * exercised with a plain event-payload object and injected stubs for the
 * capacity-floor + metrics writers, without constructing a notification-bus
 * fixture or driving handleNotificationEvent (which also runs the digest and
 * alert-routing arms). These tests pin:
 *   1. A merged cycle classifies the merged files and records that side.
 *   2. A rolled-back (or non-merged) cycle records the "idle" side.
 *   3. The orchestrator-share metric is published on every reaction.
 *   4. filesChanged is sanitised to strings and capped at 50 entries.
 *   5. The cycleId falls back through correlationId then a synthesised id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  reactToCycleCompleted,
  type CycleCompletedEvent,
  type CycleCompletedReactorDeps,
} from "../src/notification/cycle-completed-reactor.ts";
import { type CycleSide } from "../src/capacity-floor.ts";

/** Build a deps stub that records every call for assertion. */
function makeDeps(classifyReturn: CycleSide = "target") {
  const calls = {
    classifySide: [] as Array<{ files: unknown; opts: unknown }>,
    recordCycleSide: [] as Array<{ cycleId: string; side: CycleSide; opts: any }>,
    publishCount: 0,
  };
  const deps: CycleCompletedReactorDeps = {
    classifySide: (files: any, opts: any) => {
      calls.classifySide.push({ files, opts });
      return classifyReturn;
    },
    recordCycleSide: async (cycleId: string, side: CycleSide, opts: any = {}) => {
      calls.recordCycleSide.push({ cycleId, side, opts });
    },
    publishOrchestratorShareMetric: async () => {
      calls.publishCount++;
      return { ok: true, value: 0, windowCount: 0, path: "/tmp/x" };
    },
  };
  return { deps, calls };
}

test("merged cycle classifies the merged files and records that side", async () => {
  const { deps, calls } = makeDeps("orchestrator");
  const event: CycleCompletedEvent = {
    type: "cycle:completed",
    payload: {
      cycleId: "cyc-1",
      task: { finalState: "merged" },
      filesChanged: ["src/tier-classifier.ts"],
      commitSha: "abc123",
    },
  };

  await reactToCycleCompleted(event, deps);

  assert.equal(calls.classifySide.length, 1, "classifySide should run for a merged cycle");
  assert.deepEqual(calls.classifySide[0].files, ["src/tier-classifier.ts"]);
  assert.deepEqual(calls.classifySide[0].opts, { workspaceHint: "target" });

  assert.equal(calls.recordCycleSide.length, 1);
  assert.equal(calls.recordCycleSide[0].cycleId, "cyc-1");
  assert.equal(calls.recordCycleSide[0].side, "orchestrator");
  assert.equal(calls.recordCycleSide[0].opts.commitSha, "abc123");
  assert.deepEqual(calls.recordCycleSide[0].opts.filesChanged, ["src/tier-classifier.ts"]);
  assert.equal(calls.recordCycleSide[0].opts.source, "cycle-completed-listener");
});

test("rolled-back cycle records the 'idle' side and skips classification", async () => {
  const { deps, calls } = makeDeps("orchestrator");
  const event: CycleCompletedEvent = {
    type: "cycle:completed",
    payload: {
      cycleId: "cyc-2",
      task: { finalState: "merged" },
      filesChanged: ["src/foo.ts"],
      rolledBack: true,
    },
  };

  await reactToCycleCompleted(event, deps);

  assert.equal(calls.classifySide.length, 0, "a rolled-back cycle is idle — no classification");
  assert.equal(calls.recordCycleSide.length, 1);
  assert.equal(calls.recordCycleSide[0].side, "idle");
});

test("non-merged final state records the 'idle' side", async () => {
  const { deps, calls } = makeDeps("target");
  const event: CycleCompletedEvent = {
    type: "cycle:completed",
    payload: { cycleId: "cyc-3", task: { finalState: "failed" }, filesChanged: ["src/foo.ts"] },
  };

  await reactToCycleCompleted(event, deps);

  assert.equal(calls.classifySide.length, 0);
  assert.equal(calls.recordCycleSide[0].side, "idle");
});

test("the orchestrator-share metric is published on every reaction", async () => {
  const { deps, calls } = makeDeps();
  await reactToCycleCompleted(
    { type: "cycle:completed", payload: { cycleId: "cyc-4", task: { finalState: "merged" }, filesChanged: [] } },
    deps,
  );
  assert.equal(calls.publishCount, 1, "publishOrchestratorShareMetric should run once per reaction");
});

test("filesChanged is sanitised to strings and capped at 50 entries", async () => {
  const { deps, calls } = makeDeps("target");
  const many = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
  // Interleave a couple of non-string entries that must be dropped.
  const dirty: unknown[] = [...many.slice(0, 5), 42, null, ...many.slice(5)];
  const event: CycleCompletedEvent = {
    type: "cycle:completed",
    payload: { cycleId: "cyc-5", task: { finalState: "merged" }, filesChanged: dirty as any },
  };

  await reactToCycleCompleted(event, deps);

  // classifySide receives only the string paths (non-strings dropped).
  assert.equal((calls.classifySide[0].files as string[]).length, 60);
  assert.ok((calls.classifySide[0].files as string[]).every((f) => typeof f === "string"));
  // recordCycleSide caps the stored list at 50.
  assert.equal(calls.recordCycleSide[0].opts.filesChanged.length, 50);
});

test("cycleId falls back through correlationId then a synthesised id", async () => {
  // No cycleId -> use correlationId.
  {
    const { deps, calls } = makeDeps("idle");
    await reactToCycleCompleted(
      { type: "cycle:completed", correlationId: "corr-9", payload: { task: { finalState: "failed" } } },
      deps,
    );
    assert.equal(calls.recordCycleSide[0].cycleId, "corr-9");
  }
  // Neither -> synthesised `evt-<ts>`.
  {
    const { deps, calls } = makeDeps("idle");
    await reactToCycleCompleted({ type: "cycle:completed", payload: {} }, deps);
    assert.match(calls.recordCycleSide[0].cycleId, /^evt-\d+$/);
  }
});

test("default deps wire to the real writers (no-arg call does not throw on a minimal event)", async () => {
  // Smoke: the production path (no injected deps) reaches the real capacity-
  // floor + metrics writers, which are best-effort and swallow their own
  // errors, so a minimal event must resolve without throwing.
  await assert.doesNotReject(
    reactToCycleCompleted({ type: "cycle:completed", payload: { task: { finalState: "failed" } } }),
  );
});

test("wire-format merged:true at top level classifies side correctly (issue #3200)", async () => {
  // The actual wire payload uses `merged: true` at the top level, NOT
  // `task.finalState === "merged"`. This is the primary production code path.
  const { deps, calls } = makeDeps("orchestrator");
  const event: CycleCompletedEvent = {
    type: "cycle:completed",
    payload: {
      cycleId: "cyc-wire-1",
      merged: true,
      filesChanged: ["src/notification/cycle-completed-reactor.ts"],
      commitSha: "d1afe3fb",
    },
  };

  await reactToCycleCompleted(event, deps);

  assert.equal(calls.classifySide.length, 1, "classifySide must run for merged:true wire payload");
  assert.deepEqual(calls.classifySide[0].files, ["src/notification/cycle-completed-reactor.ts"]);
  assert.equal(calls.recordCycleSide[0].side, "orchestrator");
  assert.equal(calls.recordCycleSide[0].cycleId, "cyc-wire-1");
});

test("wire-format merged:true with rolledBack:true is still idle (issue #3200)", async () => {
  const { deps, calls } = makeDeps("orchestrator");
  const event: CycleCompletedEvent = {
    type: "cycle:completed",
    payload: {
      cycleId: "cyc-wire-2",
      merged: true,
      rolledBack: true,
      filesChanged: ["src/foo.ts"],
    },
  };

  await reactToCycleCompleted(event, deps);

  assert.equal(calls.classifySide.length, 0, "rolledBack overrides merged:true → idle");
  assert.equal(calls.recordCycleSide[0].side, "idle");
});

test("wire-format merged:false records idle side (issue #3200)", async () => {
  const { deps, calls } = makeDeps("target");
  const event: CycleCompletedEvent = {
    type: "cycle:completed",
    payload: {
      cycleId: "cyc-wire-3",
      merged: false,
      filesChanged: ["src/foo.ts"],
    },
  };

  await reactToCycleCompleted(event, deps);

  assert.equal(calls.classifySide.length, 0, "merged:false is idle");
  assert.equal(calls.recordCycleSide[0].side, "idle");
});
