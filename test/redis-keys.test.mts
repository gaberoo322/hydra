/**
 * Redis key generator tests.
 *
 * Regression: hardcoded Redis key strings were scattered across 12+ modules,
 * causing silent bugs when key patterns diverged. This test ensures every
 * generator follows the hydra:{domain}:* naming convention and that no two
 * generators produce the same key for different semantic inputs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redisKeys } from "../src/redis/keys.ts";

// ---------------------------------------------------------------------------
// Snapshot: every generator matches hydra:{domain}:* pattern
// ---------------------------------------------------------------------------

describe("redisKeys naming convention", () => {
  // Generators with no arguments (static keys)
  const staticGenerators: [string, () => string][] = [
    ["cycleActive", redisKeys.cycleActive],
    ["cycleLast", redisKeys.cycleLast],
    ["depsCompleted", redisKeys.depsCompleted],
    ["depsIndex", redisKeys.depsIndex],
    ["anchorWorkQueue", redisKeys.anchorWorkQueue],
    ["anchorProcessing", redisKeys.anchorProcessing],
    ["anchorPriorFailures", redisKeys.anchorPriorFailures],
    ["anchorReframeQueue", redisKeys.anchorReframeQueue],
    ["metricsIndex", redisKeys.metricsIndex],
    ["realityReportIndex", redisKeys.realityReportIndex],
    ["researchReportIndex", redisKeys.researchReportIndex],
    ["memoryLastConsolidation", redisKeys.memoryLastConsolidation],
    ["reflectionPrefix", redisKeys.reflectionPrefix],
    ["backlogItems", redisKeys.backlogItems],
    ["backlogCounter", redisKeys.backlogCounter],
    ["schedulerState", redisKeys.schedulerState],
    ["mergeLock", redisKeys.mergeLock],
    ["workspaceLock", redisKeys.workspaceLock],
    ["planCachePrefix", redisKeys.planCachePrefix],
    ["adversarialTracking", redisKeys.adversarialTracking],
    ["adversarialStats", redisKeys.adversarialStats],
    ["alerts", redisKeys.alerts],
    ["patternDetectorCooldowns", redisKeys.patternDetectorCooldowns],
    ["blockedLastEscalation", redisKeys.blockedLastEscalation],
    ["digestLastWeekly", redisKeys.digestLastWeekly],
    ["regressionHuntLast", redisKeys.regressionHuntLast],
    ["streamCycle", redisKeys.streamCycle],
    ["streamTasks", redisKeys.streamTasks],
    ["streamMeta", redisKeys.streamMeta],
    ["streamNotifications", redisKeys.streamNotifications],
    ["streamDlq", redisKeys.streamDlq],
    ["streamAgentStream", redisKeys.streamAgentStream],
  ];

  for (const [name, fn] of staticGenerators) {
    test(`${name}() starts with "hydra:"`, () => {
      const key = fn();
      assert.ok(key.startsWith("hydra:"), `${name}() = "${key}" — must start with "hydra:"`);
    });
  }

  // Generators with arguments (dynamic keys)
  const dynamicGenerators: [string, string][] = [
    ["cycle", redisKeys.cycle("test-id")],
    ["cycleTasks", redisKeys.cycleTasks("test-id")],
    ["cycleAgents", redisKeys.cycleAgents("test-id")],
    ["cycleCosts", redisKeys.cycleCosts("test-id")],
    ["cycleActiveSource", redisKeys.cycleActiveSource("codex")],
    ["task", redisKeys.task("task-1")],
    ["taskEvidence", redisKeys.taskEvidence("task-1", "merged")],
    ["depsHeld", redisKeys.depsHeld("dep-1")],
    ["anchorAbandonmentCount", redisKeys.anchorAbandonmentCount("ref-1")],
    ["anchorPermSkip", redisKeys.anchorPermSkip("ref-1")],
    ["metrics", redisKeys.metrics("cycle-1")],
    ["realityReport", redisKeys.realityReport("cycle-1")],
    ["summaryReport", redisKeys.summaryReport("manual-planner-abc")],
    ["researchReport", redisKeys.researchReport("res-1")],
    ["memoryPatterns", redisKeys.memoryPatterns("planner")],
    ["memoryRules", redisKeys.memoryRules("executor")],
    ["reflection", redisKeys.reflection("some-anchor-ref")],
    ["backlogLane", redisKeys.backlogLane("queued")],
    ["planCache", redisKeys.planCache("abc123")],
    ["stream", redisKeys.stream("notifications")],
  ];

  for (const [name, key] of dynamicGenerators) {
    test(`${name}() starts with "hydra:"`, () => {
      assert.ok(key.startsWith("hydra:"), `${name}() = "${key}" — must start with "hydra:"`);
    });
  }
});

// ---------------------------------------------------------------------------
// Uniqueness: no two static generators produce the same key
// ---------------------------------------------------------------------------

describe("redisKeys uniqueness", () => {
  test("no two static generators return the same key", () => {
    const seen = new Map<string, string>();
    const staticKeys: [string, string][] = [
      ["cycleActive", redisKeys.cycleActive()],
      ["cycleLast", redisKeys.cycleLast()],
      ["depsCompleted", redisKeys.depsCompleted()],
      ["depsIndex", redisKeys.depsIndex()],
      ["anchorWorkQueue", redisKeys.anchorWorkQueue()],
      ["anchorProcessing", redisKeys.anchorProcessing()],
      ["anchorPriorFailures", redisKeys.anchorPriorFailures()],
      ["anchorReframeQueue", redisKeys.anchorReframeQueue()],
      ["metricsIndex", redisKeys.metricsIndex()],
      ["realityReportIndex", redisKeys.realityReportIndex()],
      ["researchReportIndex", redisKeys.researchReportIndex()],
      ["memoryLastConsolidation", redisKeys.memoryLastConsolidation()],
      ["backlogItems", redisKeys.backlogItems()],
      ["backlogCounter", redisKeys.backlogCounter()],
      ["schedulerState", redisKeys.schedulerState()],
      ["mergeLock", redisKeys.mergeLock()],
      ["workspaceLock", redisKeys.workspaceLock()],
      ["adversarialTracking", redisKeys.adversarialTracking()],
      ["adversarialStats", redisKeys.adversarialStats()],
      ["alerts", redisKeys.alerts()],
      ["patternDetectorCooldowns", redisKeys.patternDetectorCooldowns()],
      ["blockedLastEscalation", redisKeys.blockedLastEscalation()],
      ["digestLastWeekly", redisKeys.digestLastWeekly()],
      ["regressionHuntLast", redisKeys.regressionHuntLast()],
    ];

    for (const [name, key] of staticKeys) {
      if (seen.has(key)) {
        assert.fail(`${name}() and ${seen.get(key)}() both produce "${key}"`);
      }
      seen.set(key, name);
    }
  });

  test("dynamic generators produce different keys for different inputs", () => {
    // Verify that the same generator with different inputs produces different keys
    assert.notEqual(redisKeys.cycle("a"), redisKeys.cycle("b"));
    assert.notEqual(redisKeys.task("a"), redisKeys.task("b"));
    assert.notEqual(redisKeys.memoryPatterns("planner"), redisKeys.memoryPatterns("executor"));
    assert.notEqual(redisKeys.backlogLane("queued"), redisKeys.backlogLane("done"));

    // Verify that different generators with the same input produce different keys
    assert.notEqual(redisKeys.cycle("x"), redisKeys.task("x"));
    assert.notEqual(redisKeys.cycle("x"), redisKeys.metrics("x"));
    assert.notEqual(redisKeys.realityReport("x"), redisKeys.researchReport("x"));
    assert.notEqual(redisKeys.memoryPatterns("x"), redisKeys.memoryRules("x"));
  });
});

// ---------------------------------------------------------------------------
// Snapshot: verify exact key values haven't drifted
// ---------------------------------------------------------------------------

describe("redisKeys snapshot", () => {
  test("static keys match expected values", () => {
    assert.equal(redisKeys.cycleActive(), "hydra:cycle:active");
    assert.equal(redisKeys.cycleLast(), "hydra:cycle:last");
    assert.equal(redisKeys.anchorWorkQueue(), "hydra:anchors:work-queue");
    assert.equal(redisKeys.anchorProcessing(), "hydra:anchors:processing");
    assert.equal(redisKeys.anchorPriorFailures(), "hydra:anchors:prior-failures");
    assert.equal(redisKeys.anchorReframeQueue(), "hydra:anchors:reframe-queue");
    assert.equal(redisKeys.metricsIndex(), "hydra:metrics:index");
    assert.equal(redisKeys.realityReportIndex(), "hydra:reports:reality:index");
    assert.equal(redisKeys.researchReportIndex(), "hydra:reports:research:index");
    assert.equal(redisKeys.backlogItems(), "hydra:backlog:items");
    assert.equal(redisKeys.backlogCounter(), "hydra:backlog:counter");
    assert.equal(redisKeys.schedulerState(), "hydra:scheduler:state");
    assert.equal(redisKeys.mergeLock(), "hydra:merge:lock");
    assert.equal(redisKeys.workspaceLock(), "hydra:workspace:lock");
    assert.equal(redisKeys.alerts(), "hydra:alerts");
    assert.equal(redisKeys.streamNotifications(), "hydra:notifications");
  });

  test("dynamic keys match expected patterns", () => {
    assert.equal(redisKeys.cycle("cycle-2026-04-30"), "hydra:cycle:cycle-2026-04-30");
    assert.equal(redisKeys.cycleTasks("c1"), "hydra:cycle:c1:tasks");
    assert.equal(redisKeys.cycleAgents("c1"), "hydra:cycle:c1:agents");
    assert.equal(redisKeys.cycleCosts("c1"), "hydra:cycle:c1:costs");
    assert.equal(redisKeys.cycleActiveSource("claude"), "hydra:cycle:active:claude");
    assert.equal(redisKeys.task("task-1"), "hydra:task:task-1");
    assert.equal(redisKeys.taskEvidence("t1", "merged"), "hydra:task:t1:evidence:merged");
    assert.equal(redisKeys.metrics("c1"), "hydra:metrics:c1");
    assert.equal(redisKeys.realityReport("c1"), "hydra:reports:reality:c1");
    assert.equal(redisKeys.summaryReport("manual-planner-abc"), "hydra:reports:summary:manual-planner-abc");
    assert.equal(redisKeys.researchReport("r1"), "hydra:reports:research:r1");
    assert.equal(redisKeys.memoryPatterns("planner"), "hydra:memory:planner:patterns");
    assert.equal(redisKeys.memoryRules("executor"), "hydra:memory:executor:rules");
    assert.equal(redisKeys.reflection("test-ref"), "hydra:reflections:test-ref");
    assert.equal(redisKeys.backlogLane("queued"), "hydra:backlog:lane:queued");
    assert.equal(redisKeys.planCache("abc"), "hydra:plans:cache:abc");
    assert.equal(redisKeys.anchorAbandonmentCount("ref"), "hydra:anchors:abandonment-count:ref");
    assert.equal(redisKeys.anchorPermSkip("ref"), "hydra:anchors:perm-skip:ref");
    assert.equal(redisKeys.stream("notifications"), "hydra:notifications");
  });
});
