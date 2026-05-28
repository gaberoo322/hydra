/**
 * test/now-pixel-battle-card.test.mts — covers the pure derivation that
 * drives BattleCardRow + BattleCard + PokedexModal.
 *
 * Slice D of /now-observability (epic #667, issue #672). The visual
 * components are presenters with no business logic; everything testable
 * lives in dashboard/src/pages/now-pixel/battle-card-state.ts:
 *
 *   - classifyToolCall — category + tool → counter bucket
 *   - applySlotEvent — folds WS frames into per-task accumulator
 *   - deriveBattleCardRows — combines dispatches + runtime state into rows
 *   - derivePokedexEntries — chronological timeline for one task
 *   - reapStalePermissionWaits — drops yellow-dot state past TTL
 *
 * Acceptance criteria from #672 mapped to tests below:
 *
 *   AC: tool-call counters accumulated from the WS stream
 *     → counters.* increment correctly on subagent_tool_call frames
 *   AC: permission-wait flag is a pulsing yellow dot when slot_waiting_permission
 *       is open AND not yet resolved
 *     → permissionWait set on slot_waiting_permission, cleared on next tool call
 *   AC: card click opens a Pokedex modal listing chronological milestones
 *     → derivePokedexEntries returns entries newest-applied last, with kind/ts
 *   AC: hover-link with HabitatGrid is preserved
 *     → row.id matches dispatch.id so NowPixel's shared hoveredSubagentId works
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySlotEvent,
  classifyToolCall,
  deriveBattleCardRows,
  derivePokedexEntries,
  makeInitialTaskState,
  reapStalePermissionWaits,
  MAX_WAIT_AGE_SEC,
} from "../dashboard/src/pages/now-pixel/battle-card-state.ts";

// ---------------------------------------------------------------------------
// classifyToolCall
// ---------------------------------------------------------------------------

test("classifyToolCall: Write/Edit/MultiEdit/NotebookEdit count as writes", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(classifyToolCall("milestone", tool), "writes", tool);
  }
});

test("classifyToolCall: milestone category that isn't a write counts as milestone", () => {
  // git commit / npm test / npm run build / etc. — categorised by the hook
  // as milestone but the tool is Bash. The strip surfaces these in the
  // milestones counter so they're visible alongside writes.
  assert.equal(classifyToolCall("milestone", "Bash"), "milestones");
});

test("classifyToolCall: background category counts as reads (Read/Grep/Glob)", () => {
  assert.equal(classifyToolCall("background", "Read"), "reads");
  assert.equal(classifyToolCall("background", "Grep"), "reads");
  assert.equal(classifyToolCall("background", "Glob"), "reads");
});

test("classifyToolCall: io category is intentionally uncounted (returns null)", () => {
  // IO calls (Bash that isn't a milestone, WebFetch) are surfaced via the
  // current-activity string but don't increment a counter — the spec lists
  // exactly three counters.
  assert.equal(classifyToolCall("io", "Bash"), null);
  assert.equal(classifyToolCall("io", "WebFetch"), null);
});

test("classifyToolCall: unknown category + non-write tool returns null", () => {
  assert.equal(classifyToolCall("totally-made-up", "Bash"), null);
  assert.equal(classifyToolCall(undefined, undefined), null);
});

// ---------------------------------------------------------------------------
// applySlotEvent — counter accumulation
// ---------------------------------------------------------------------------

function toolCallFrame(taskId: string, category: string, tool: string, opts: any = {}) {
  return {
    type: "slot-event",
    payload: {
      event: "subagent_tool_call",
      slot: opts.slot ?? "dev_orch",
      task_id: taskId,
      tool,
      category,
      target: opts.target ?? "",
      ts_epoch: opts.ts ?? 1700000000,
    },
  };
}

test("applySlotEvent: accumulates counters across multiple tool calls on the same task", () => {
  let s: Record<string, any> = {};
  s = applySlotEvent(s, toolCallFrame("task-1", "milestone", "Write"));
  s = applySlotEvent(s, toolCallFrame("task-1", "milestone", "Edit"));
  s = applySlotEvent(s, toolCallFrame("task-1", "milestone", "Bash", { target: "git commit" }));
  s = applySlotEvent(s, toolCallFrame("task-1", "background", "Read"));
  s = applySlotEvent(s, toolCallFrame("task-1", "background", "Grep"));
  s = applySlotEvent(s, toolCallFrame("task-1", "background", "Glob"));
  s = applySlotEvent(s, toolCallFrame("task-1", "io", "Bash", { target: "ls" }));

  assert.deepEqual(s["task-1"].counters, { writes: 2, milestones: 1, reads: 3 });
});

test("applySlotEvent: tracks each task independently", () => {
  let s: Record<string, any> = {};
  s = applySlotEvent(s, toolCallFrame("task-a", "milestone", "Write"));
  s = applySlotEvent(s, toolCallFrame("task-b", "background", "Read"));
  assert.equal(s["task-a"].counters.writes, 1);
  assert.equal(s["task-b"].counters.reads, 1);
  assert.equal(s["task-a"].counters.reads, 0);
  assert.equal(s["task-b"].counters.writes, 0);
});

test("applySlotEvent: ignores frames lacking task_id (no orphan rows)", () => {
  const frame = {
    type: "slot-event",
    payload: { event: "subagent_tool_call", slot: "dev_orch", tool: "Write", category: "milestone" },
  };
  const s = applySlotEvent({}, frame);
  // Empty task_id → no entry created. The strip relies on task identity
  // for the per-card row; without it we cannot attribute.
  assert.equal(Object.keys(s).length, 0);
});

test("applySlotEvent: ignores frames whose type is not slot-event", () => {
  const s = applySlotEvent({}, { type: "connected", payload: {} });
  assert.equal(Object.keys(s).length, 0);
});

test("applySlotEvent: returns a NEW reference on update (immutable for React)", () => {
  const initial = {};
  const next = applySlotEvent(initial, toolCallFrame("t1", "milestone", "Write"));
  assert.notEqual(initial, next);
});

// ---------------------------------------------------------------------------
// applySlotEvent — permission-wait open/close
// ---------------------------------------------------------------------------

function waitFrame(taskId: string, opts: any = {}) {
  return {
    type: "slot-event",
    payload: {
      event: "slot_waiting_permission",
      slot: opts.slot ?? "dev_orch",
      task_id: taskId,
      tool: opts.tool ?? "Bash",
      ts_epoch: opts.ts ?? 1700000100,
    },
  };
}

test("applySlotEvent: slot_waiting_permission opens the wait state", () => {
  const s = applySlotEvent({}, waitFrame("task-1", { tool: "Bash", ts: 1700000100 }));
  assert.ok(s["task-1"].permissionWait, "wait should be open");
  assert.equal(s["task-1"].permissionWait.openedAt, 1700000100);
  assert.equal(s["task-1"].permissionWait.tool, "Bash");
});

test("applySlotEvent: subsequent subagent_tool_call clears the open permission-wait", () => {
  let s: Record<string, any> = {};
  s = applySlotEvent(s, waitFrame("task-1"));
  assert.ok(s["task-1"].permissionWait, "precondition: wait open");
  s = applySlotEvent(s, toolCallFrame("task-1", "io", "Bash"));
  assert.equal(s["task-1"].permissionWait, null, "wait should resolve on next tool call");
});

test("applySlotEvent: subagent_stop clears the open permission-wait", () => {
  let s: Record<string, any> = {};
  s = applySlotEvent(s, waitFrame("task-1"));
  s = applySlotEvent(s, {
    type: "slot-event",
    payload: {
      event: "subagent_stop",
      slot: "dev_orch",
      task_id: "task-1",
      status: "success",
      ts_epoch: 1700000200,
    },
  });
  assert.equal(s["task-1"].permissionWait, null);
});

// ---------------------------------------------------------------------------
// applySlotEvent — current activity + PR ref
// ---------------------------------------------------------------------------

test("applySlotEvent: current activity reflects the most recent tool call", () => {
  let s: Record<string, any> = {};
  s = applySlotEvent(s, toolCallFrame("task-1", "milestone", "Write", { target: "src/foo.ts" }));
  assert.match(s["task-1"].currentActivity, /Write/);
  assert.match(s["task-1"].currentActivity, /src\/foo\.ts/);
  s = applySlotEvent(s, toolCallFrame("task-1", "background", "Read", { target: "src/bar.ts" }));
  assert.match(s["task-1"].currentActivity, /Read/);
  assert.match(s["task-1"].currentActivity, /src\/bar\.ts/);
});

test("applySlotEvent: pr_opened sets prRef on the matching task", () => {
  let s: Record<string, any> = {};
  s = applySlotEvent(s, {
    type: "slot-event",
    payload: {
      event: "pr_opened",
      slot: "dev_orch",
      task_id: "task-1",
      pr_ref: "gaberoo322/hydra#672",
      ts_epoch: 1700000300,
    },
  });
  assert.equal(s["task-1"].prRef, "gaberoo322/hydra#672");
});

// ---------------------------------------------------------------------------
// deriveBattleCardRows
// ---------------------------------------------------------------------------

const sampleDispatches = {
  generatedAt: "2026-05-28T00:00:00Z",
  items: [
    {
      id: "task-a",
      classLabel: "dev_orch",
      source: "autopilot" as const,
      startedAt: "2026-05-28T00:00:00Z",
      currentStep: "implementing #672",
      issueRef: "#672",
    },
    {
      id: "task-b",
      classLabel: "qa_orch",
      source: "operator" as const,
      startedAt: "2026-05-28T00:00:00Z",
    },
  ],
};

test("deriveBattleCardRows: empty payload → empty=true", () => {
  const s = deriveBattleCardRows({ items: [], generatedAt: "x" }, {});
  assert.equal(s.empty, true);
  assert.equal(s.rows.length, 0);
});

test("deriveBattleCardRows: null payload is safe (no NPE)", () => {
  const s = deriveBattleCardRows(null, {});
  assert.equal(s.empty, true);
});

test("deriveBattleCardRows: row id mirrors dispatch.id (hover-link contract)", () => {
  const s = deriveBattleCardRows(sampleDispatches, {});
  // NowPixel's shared hoveredSubagentId compares to row.id; HabitatGrid
  // compares to slot subagent.task_id. The strip's contract is that
  // these two ids align. Pin the alignment here.
  assert.deepEqual(
    s.rows.map((r) => r.id),
    ["task-a", "task-b"],
  );
});

test("deriveBattleCardRows: counters and currentActivity come from runtime state when present", () => {
  let runtime: Record<string, any> = {};
  runtime = applySlotEvent(runtime, toolCallFrame("task-a", "milestone", "Write"));
  runtime = applySlotEvent(runtime, toolCallFrame("task-a", "background", "Read"));
  const s = deriveBattleCardRows(sampleDispatches, runtime);
  const a = s.rows.find((r) => r.id === "task-a")!;
  assert.equal(a.counters.writes, 1);
  assert.equal(a.counters.reads, 1);
  assert.match(a.currentActivity, /Read/);
});

test("deriveBattleCardRows: falls back to dispatch.currentStep when no runtime activity yet", () => {
  const s = deriveBattleCardRows(sampleDispatches, {});
  const a = s.rows.find((r) => r.id === "task-a")!;
  assert.equal(a.currentActivity, "implementing #672");
});

test("deriveBattleCardRows: permission-wait flag exposed as boolean for the dot", () => {
  let runtime: Record<string, any> = {};
  runtime = applySlotEvent(runtime, waitFrame("task-a"));
  const s = deriveBattleCardRows(sampleDispatches, runtime);
  const a = s.rows.find((r) => r.id === "task-a")!;
  const b = s.rows.find((r) => r.id === "task-b")!;
  assert.equal(a.permissionWaitOpen, true);
  assert.equal(b.permissionWaitOpen, false);
});

test("deriveBattleCardRows: prRef from a pr_opened event takes precedence over dispatch.prRef", () => {
  let runtime: Record<string, any> = {};
  runtime = applySlotEvent(runtime, {
    type: "slot-event",
    payload: {
      event: "pr_opened",
      slot: "dev_orch",
      task_id: "task-a",
      pr_ref: "owner/repo#1",
      ts_epoch: 1700000300,
    },
  });
  const dispatches = {
    ...sampleDispatches,
    items: sampleDispatches.items.map((d) =>
      d.id === "task-a" ? { ...d, prRef: "owner/repo#stale" } : d,
    ),
  };
  const s = deriveBattleCardRows(dispatches as any, runtime);
  const a = s.rows.find((r) => r.id === "task-a")!;
  assert.equal(a.prRef, "owner/repo#1");
});

test("deriveBattleCardRows: unknown class label falls through to the placeholder sprite", () => {
  const s = deriveBattleCardRows(
    {
      items: [
        {
          id: "task-x",
          classLabel: "totally-made-up",
          source: "autopilot" as const,
          startedAt: "2026-05-28T00:00:00Z",
        },
      ],
      generatedAt: "x",
    },
    {},
  );
  // Placeholder is 025-pikachu.png — same convention the legacy strip used.
  assert.match(s.rows[0].spriteFile, /pikachu/);
});

// ---------------------------------------------------------------------------
// derivePokedexEntries
// ---------------------------------------------------------------------------

test("derivePokedexEntries: returns chronological events for a task (kind + message)", () => {
  let s: Record<string, any> = {};
  s = applySlotEvent(s, toolCallFrame("task-1", "milestone", "Write", { target: "src/foo.ts", ts: 1 }));
  s = applySlotEvent(s, waitFrame("task-1", { ts: 2 }));
  s = applySlotEvent(s, toolCallFrame("task-1", "background", "Read", { target: "src/bar.ts", ts: 3 }));
  s = applySlotEvent(s, {
    type: "slot-event",
    payload: {
      event: "subagent_stop",
      slot: "dev_orch",
      task_id: "task-1",
      status: "success",
      ts_epoch: 4,
    },
  });
  const entries = derivePokedexEntries(s, "task-1");
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["subagent_tool_call", "slot_waiting_permission", "subagent_tool_call", "subagent_stop"],
  );
  // category strings used for color coding in the modal
  assert.deepEqual(
    entries.map((e) => e.category),
    ["milestone", "wait", "background", "stop"],
  );
});

test("derivePokedexEntries: unknown task → empty list (no NPE)", () => {
  const entries = derivePokedexEntries({}, "task-doesnt-exist");
  assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------------------
// reapStalePermissionWaits
// ---------------------------------------------------------------------------

test("reapStalePermissionWaits: drops a permission-wait older than MAX_WAIT_AGE_SEC", () => {
  const initial = {
    "task-1": {
      ...makeInitialTaskState("task-1"),
      permissionWait: { openedAt: 1000, tool: "Bash" },
    },
  };
  const reaped = reapStalePermissionWaits(initial, 1000 + MAX_WAIT_AGE_SEC + 1);
  assert.equal(reaped["task-1"].permissionWait, null);
});

test("reapStalePermissionWaits: keeps a fresh permission-wait untouched", () => {
  const initial = {
    "task-1": {
      ...makeInitialTaskState("task-1"),
      permissionWait: { openedAt: 1000, tool: "Bash" },
    },
  };
  const reaped = reapStalePermissionWaits(initial, 1000 + 10);
  assert.ok(reaped["task-1"].permissionWait, "wait should still be open");
});

test("reapStalePermissionWaits: returns same reference when nothing to drop (no churn)", () => {
  const initial = {
    "task-1": {
      ...makeInitialTaskState("task-1"),
      permissionWait: { openedAt: 1000, tool: "Bash" },
    },
  };
  const reaped = reapStalePermissionWaits(initial, 1000 + 10);
  assert.equal(reaped, initial, "no-op reap should not allocate a new object");
});
