/**
 * Assertion (c) + structural pins for the Today feed's per-kind action
 * affordance (issue #4628, ADR-0034 §8.3 Variant B; design-concept ff6f2e7a).
 *
 * The dashboard ships no JSX test runner and the worktree resolves no
 * `react`, so — exactly like test/dashboard-server-confirmed-write.test.mts —
 * the slice is pinned at the boundaries that ARE mechanically checkable:
 *
 *   1. assertion (c): every ActionKind enum value has a literal
 *      `case "<kind>":` in ActionAffordance.jsx's single switch. The kind
 *      list is DERIVED from the schema (`ActionSchema.options`), never a
 *      hand-copied list — a kind added to the schema reddens here until the
 *      component gains its case.
 *   2. the pure helper `missingKindCases` is driven against a synthetic
 *      source with one case removed and must return that kind — proving the
 *      assertion above reddens (a vacuous matcher would pass forever).
 *   3. every in-dashboard route anywhere in the REGISTRY (recommended AND
 *      both alternatives of every entry) has an IN_DASHBOARD_BODY key in
 *      ActionAffordance.jsx — a registry route with no defined request body
 *      would render a disabled affordance, so the map must keep pace with
 *      the table.
 *   4. every BUCKETS value has a BUCKET_WHY entry in AttentionFeed.jsx (the
 *      bucket header's why-it-ranks-here line is closed client-side).
 *   5. the typed dismiss body is the #4627 strict schema shape
 *      ({ reason, key }) — the legacy free-text { reason, signal } body is
 *      gone.
 *   6. OperatorDecisionQueue.jsx is deleted and Today.jsx no longer
 *      references it (ADR-0034 §8.1 superseded the overnight queue).
 *   7. the delayed-commit undo window (dashboard/src/lib/delayed-commit.ts)
 *      driven BEHAVIOURALLY under node:test fake timers: expiry fires once,
 *      Undo cancels, a second start() while pending is refused (the dismiss
 *      double-fire guard), unmount flush commits.
 *   8. the feed's bucket derivation (dashboard/src/lib/attention-buckets.ts)
 *      driven with partial-buckets payloads: synthetic UNKNOWN sections,
 *      proved-only count, orphaned items, malformed payloads.
 *
 * Lifecycle: top-level describes with no shared mutable state and no Redis
 * seam (per the CLAUDE.md shared-teardown authoring rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { OperatorActionEntry } from "../src/schemas/operator-actions.ts";
import { ActionSchema, BUCKETS } from "../src/schemas/operator-actions.ts";
import { REGISTRY } from "../src/operator-actions/registry.ts";
import type { PendingCommit, PendingWindow } from "../dashboard/src/lib/delayed-commit.ts";
import {
  UNDO_WINDOW_MS,
  createDelayedCommit,
  createInFlightTracker,
  createUndoWindowRegistry,
  runTracked,
  triggerDisabled,
  undoWindowSeconds,
} from "../dashboard/src/lib/delayed-commit.ts";
import type { BucketSummary } from "../dashboard/src/lib/attention-buckets.ts";
import { deriveFeedBuckets, recordDismissOutcome } from "../dashboard/src/lib/attention-buckets.ts";
import {
  PRECONDITION_GLYPH,
  anyFailed,
  resolveControlAction,
  resolvePreconditions,
} from "../dashboard/src/lib/preconditions.ts";
import {
  RELABEL_TARGETS,
  healthVerdicts,
  reopenVerdicts,
  rowVerdicts,
} from "../dashboard/src/lib/control-verdicts.ts";
import { createRereadWaiters } from "../dashboard/src/lib/reread.ts";

const AFFORDANCE = "../dashboard/src/components/ActionAffordance.jsx";
const FEED = "../dashboard/src/components/pages/today/AttentionFeed.jsx";
const TODAY = "../dashboard/src/pages/Today.jsx";
const DECISION_QUEUE = "../dashboard/src/components/pages/today/OperatorDecisionQueue.jsx";

async function readSource(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// Pure helpers — exported shapes the component source must keep
// ---------------------------------------------------------------------------

/**
 * The kinds with NO literal `case "<kind>":` in `src`. Pure string
 * containment over the switch's literal case labels — the same check the
 * schema-derived list drives, in the helper form the design concept names
 * (assertion (c)) so the reddens proof below exercises the real matcher.
 */
export function missingKindCases(src: string, kinds: readonly string[]): string[] {
  return kinds.filter((kind) => !src.includes(`case "${kind}":`));
}

/** The kind enum, derived from the schema — never a hand-copied list.
 * (zod's discriminated-union `.options` member type collapses to `unknown`
 * under tsc; the cast only re-declares the ZodObject shape each member is.) */
function schemaKinds(): string[] {
  return ActionSchema.options.map(
    (member) => (member as { shape: { kind: { value: string } } }).shape.kind.value,
  );
}

/**
 * One top-level `const NAME = { … };` object literal's quoted keys (used for
 * IN_DASHBOARD_BODY / BUCKET_WHY coverage). Slices from the declaration to
 * the first line that closes it so later objects cannot contaminate the set.
 */
function objectLiteralKeys(src: string, decl: string): string[] {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `declaration not found in source: ${decl}`);
  const rest = src.slice(start);
  const end = rest.indexOf("\n};");
  assert.ok(end > 0, `object literal starting at ${decl} has no closing line`);
  const body = rest.slice(0, end);
  return Array.from(body.matchAll(/"([^"]+)"\s*:/g), (m) => m[1]);
}

/**
 * Registry templates carry `{name}` placeholders (BUCKET_CONTEXT vocabulary);
 * the dashboard body map keys use `:param` segment patterns. Both spell "one
 * segment resolved server-side" — this normalises the former onto the latter
 * so coverage compares like with like. A segment CONTAINING a placeholder
 * (e.g. `issue-{number}`) resolves to exactly one concrete segment, so it
 * maps onto a single `:anchor` pattern segment.
 */
function asPattern(route: string): string {
  return route
    .split("/")
    .map((segment) => (/\{[^}]+\}/.test(segment) ? ":anchor" : segment))
    .join("/");
}

/** Every in-dashboard `${method} ${pattern}` the REGISTRY can serve. */
function registryInDashboardRoutes(
  entries: readonly OperatorActionEntry[] = REGISTRY,
): string[] {
  const routes: string[] = [];
  for (const entry of entries) {
    // Indexed, not spread: zod 4.4.3 infers the two-alternative z.tuple with
    // an `...unknown[]` rest, so spreading it widens the array to unknown[] —
    // while indexing a positional element keeps the Action union. The schema
    // pins exactly two alternatives, so the positions are total.
    for (const action of [entry.recommended, entry.alternatives[0], entry.alternatives[1]]) {
      if (action.kind === "in-dashboard") {
        routes.push(`${action.method} ${asPattern(action.route)}`);
      }
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// 1 + 2 — assertion (c): every schema kind has a case; the matcher reddens
// ---------------------------------------------------------------------------

describe("assertion (c) — ActionAffordance cases every schema kind", () => {
  test("kinds derive from ActionSchema.options, never a hand-copied list", () => {
    const kinds = schemaKinds();
    assert.equal(kinds.length, 6);
    assert.deepEqual([...kinds].sort(), [
      "config-env",
      "credential",
      "in-dashboard",
      "research-beyond-autonomy",
      "terminal-skill",
      "vision-decision",
    ]);
  });

  test("every schema kind has a literal case in ActionAffordance.jsx", async () => {
    const src = await readSource(AFFORDANCE);
    const missing = missingKindCases(src, schemaKinds());
    assert.deepEqual(missing, [], `ActionAffordance.jsx is missing case labels: ${missing.join(", ")}`);
  });

  test("missingKindCases reddens — a source missing one case returns that kind", () => {
    const kinds = schemaKinds();
    const victim = "config-env";
    const synthetic = [
      "export function ActionAffordance() {",
      "  switch (action.kind) {",
      ...kinds.filter((k) => k !== victim).map((k) => `    case "${k}": return null;`),
      "    default: return null;",
      "  }",
      "}",
    ].join("\n");
    assert.deepEqual(missingKindCases(synthetic, kinds), [victim]);
  });
});

// ---------------------------------------------------------------------------
// 3 — IN_DASHBOARD_BODY covers every registry in-dashboard route
// ---------------------------------------------------------------------------

describe("IN_DASHBOARD_BODY covers every registry in-dashboard route", () => {
  test("the registry serves at least the three shipped in-dashboard routes", () => {
    const routes = registryInDashboardRoutes();
    assert.ok(routes.length >= 3, `expected >= 3 in-dashboard routes, got ${routes.length}`);
  });

  test("every in-dashboard route (recommended + both alternatives, every entry) has a body key", async () => {
    // Keys spell a resolved segment `:<name>` (`:anchor`, `:id` — #4631);
    // asPattern spells every placeholder `:anchor`, so the key side is
    // normalised the same way — the param NAME never decides coverage.
    const keys = objectLiteralKeys(await readSource(AFFORDANCE), "const IN_DASHBOARD_BODY = {").map((key) =>
      key.replace(/\/:[A-Za-z_][A-Za-z0-9_]*/g, "/:anchor"),
    );
    const missing = registryInDashboardRoutes().filter((route) => !keys.includes(route));
    assert.deepEqual(
      missing,
      [],
      `IN_DASHBOARD_BODY in ActionAffordance.jsx is missing keys: ${missing.join(", ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 4 — BUCKET_WHY covers every bucket
// ---------------------------------------------------------------------------

describe("BUCKET_WHY covers every bucket", () => {
  test("every BUCKETS value has a BUCKET_WHY entry in AttentionFeed.jsx", async () => {
    const keys = objectLiteralKeys(await readSource(FEED), "const BUCKET_WHY = {");
    const missing = BUCKETS.filter((bucket) => !keys.includes(bucket));
    assert.deepEqual(missing, [], `BUCKET_WHY in AttentionFeed.jsx is missing entries: ${missing.join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// 4b — aggregate wells: sub-lines drive their OWN action blocks (INV-5)
// ---------------------------------------------------------------------------

describe("aggregate wells render each sub-line's own action (INV-5)", () => {
  test("aggregate sub-lines drive their own action blocks, not the parent's", async () => {
    const src = await readSource(FEED);
    // The subLines branch (from the map to the no-subLines fallback arm)
    // renders `sub.action` — the sub-line's own resolved registry entry — and
    // never the parent's `item.action`.
    const mapAt = src.indexOf("item.subLines.map");
    assert.ok(mapAt > 0, "AggregateWell must map over item.subLines");
    const fallbackAt = src.indexOf(": <ActionColumn entry={item.action}", mapAt);
    assert.ok(
      fallbackAt > mapAt,
      "the no-subLines fallback (single-line aggregates) renders the parent's action",
    );
    const branch = src.slice(mapAt, fallbackAt);
    assert.ok(
      branch.includes("<ActionColumn entry={sub.action}"),
      "each sub-line's action block must be driven by its own subLine.action",
    );
    assert.ok(
      !branch.includes("item.action"),
      "a sub-line's action block must not collapse to the parent's item.action",
    );
  });
});

// ---------------------------------------------------------------------------
// 5 — the typed dismiss body
// ---------------------------------------------------------------------------

describe("the dismiss body is the #4627 strict schema shape", () => {
  test("AttentionFeed POSTs { reason, key: item.key } — no legacy signal field", async () => {
    const src = await readSource(FEED);
    assert.ok(
      src.includes("JSON.stringify({ reason, key: item.key })"),
      "the dismiss body must be exactly the typed { reason, key } pair the strict schema accepts",
    );
    assert.ok(
      !src.includes("signal: item.signal"),
      "the legacy free-text { reason, signal } body is a 400 schema-validation-failed under #4627",
    );
  });
});

// ---------------------------------------------------------------------------
// 6 — OperatorDecisionQueue removal
// ---------------------------------------------------------------------------

describe("OperatorDecisionQueue is removed (ADR-0034 §8.1)", () => {
  test("OperatorDecisionQueue.jsx no longer exists", () => {
    assert.equal(
      existsSync(new URL(DECISION_QUEUE, import.meta.url)),
      false,
      "the overnight decision queue panel is superseded by the bucketed feed",
    );
  });

  test("Today.jsx neither imports nor renders it", async () => {
    const src = await readSource(TODAY);
    assert.ok(!src.includes("OperatorDecisionQueue"), "Today.jsx must not reference the removed panel");
  });
});

// ---------------------------------------------------------------------------
// 7 — the delayed-commit window, driven behaviourally (QA rounds 1–3, PR #4976)
// ---------------------------------------------------------------------------

/** A controller wired to a recording onPendingChange, plus a fire counter. */
function harness(delayMs = UNDO_WINDOW_MS) {
  const pendingLog: PendingCommit[] = [];
  const ctl = createDelayedCommit((p) => pendingLog.push(p), delayMs);
  const fired: string[] = [];
  const fire = (name: string) => () => {
    fired.push(name);
  };
  return { ctl, pendingLog, fired, fire };
}

describe("delayed commit — the undo window (INV-7 / INV-14)", () => {
  test("expiry fires the captured closure exactly once, not before the window closes", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { ctl, pendingLog, fired, fire } = harness();
    assert.equal(ctl.start("Firing X in 5s", fire("x")), true);
    assert.deepEqual(ctl.pending(), { label: "Firing X in 5s" });
    t.mock.timers.tick(UNDO_WINDOW_MS - 1);
    assert.deepEqual(fired, [], "nothing is sent inside the window");
    t.mock.timers.tick(1);
    assert.deepEqual(fired, ["x"]);
    assert.equal(ctl.pending(), null);
    assert.deepEqual(pendingLog, [{ label: "Firing X in 5s" }, null]);
    t.mock.timers.tick(UNDO_WINDOW_MS * 2);
    assert.deepEqual(fired, ["x"], "the commit never fires twice");
  });

  test("Undo cancels before anything is sent", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { ctl, fired, fire } = harness();
    ctl.start("Dismissing · Later", fire("dismiss"));
    t.mock.timers.tick(UNDO_WINDOW_MS - 1);
    ctl.undo();
    t.mock.timers.tick(UNDO_WINDOW_MS * 2);
    assert.deepEqual(fired, []);
    assert.equal(ctl.pending(), null);
  });

  test("a second start() while pending is REFUSED — it neither flushes nor replaces, so Undo still cancels the first (dismiss double-fire)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { ctl, fired, fire } = harness();
    assert.equal(ctl.start("Dismissing · Later", fire("first")), true);
    assert.equal(ctl.start("Dismissing · Later", fire("second")), false, "the second click is refused");
    assert.deepEqual(fired, [], "the first commit was NOT flushed by the second click");
    assert.deepEqual(ctl.pending(), { label: "Dismissing · Later" });
    ctl.undo();
    t.mock.timers.tick(UNDO_WINDOW_MS * 2);
    assert.deepEqual(fired, [], "Undo cancelled the first commit; the refused second never fires");
  });

  test("a refused second start() leaves the first commit on its original deadline", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { ctl, fired, fire } = harness();
    ctl.start("a", fire("first"));
    t.mock.timers.tick(3_000);
    ctl.start("b", fire("second"));
    t.mock.timers.tick(UNDO_WINDOW_MS - 3_000);
    assert.deepEqual(fired, ["first"]);
    assert.equal(ctl.start("c", fire("third")), true, "the window re-opens once the commit settles");
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.deepEqual(fired, ["first", "third"]);
  });

  test("flush (unmount) commits the pending action at once and cancels its timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { ctl, pendingLog, fired, fire } = harness();
    ctl.start("Firing X in 5s", fire("x"));
    ctl.flush();
    assert.deepEqual(fired, ["x"], "the operator's click is never silently dropped");
    assert.equal(ctl.pending(), null);
    t.mock.timers.tick(UNDO_WINDOW_MS * 2);
    assert.deepEqual(fired, ["x"], "the cancelled timer does not fire it again");
    assert.deepEqual(pendingLog, [{ label: "Firing X in 5s" }, null]);
  });

  test("flush and undo are no-ops when idle", () => {
    const { ctl, pendingLog, fired } = harness();
    ctl.flush();
    ctl.undo();
    assert.deepEqual(fired, []);
    assert.deepEqual(pendingLog, [], "an idle window emits no pending change");
  });
});

/** A feed-level registry wired to a recording onChange, plus a fire log. */
function registryHarness(delayMs = UNDO_WINDOW_MS) {
  const changes: PendingWindow[][] = [];
  const reg = createUndoWindowRegistry((w) => changes.push(w), delayMs);
  const fired: string[] = [];
  const fire = (name: string) => () => {
    fired.push(name);
  };
  return { reg, changes, fired, fire };
}

describe("feed-level undo-window registry — concurrent windows (QA round 4, PR #4976)", () => {
  test("two concurrent windows are BOTH listed and each is undoable on its own", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { reg, fired, fire } = registryHarness();
    assert.equal(reg.start("action:POST /scheduler/start", "Firing Start in 5s", fire("start")), true);
    t.mock.timers.tick(1_000);
    assert.equal(reg.start("dismiss:item-1", "Dismissing · Later", fire("dismiss")), true);
    assert.deepEqual(reg.pending(), [
      { id: "action:POST /scheduler/start", label: "Firing Start in 5s" },
      { id: "dismiss:item-1", label: "Dismissing · Later" },
    ], "the toast host renders BOTH windows — neither hides the other's Undo");
    reg.undo("dismiss:item-1");
    assert.deepEqual(reg.pending().map((w) => w.id), ["action:POST /scheduler/start"], "undo is per window");
    reg.undo("action:POST /scheduler/start");
    t.mock.timers.tick(UNDO_WINDOW_MS * 2);
    assert.deepEqual(fired, [], "both Undos cancelled before anything was sent");
    assert.deepEqual(reg.pending(), []);
  });

  test("undoing one window leaves the other on its own deadline", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { reg, fired, fire } = registryHarness();
    reg.start("a", "A", fire("a"));
    t.mock.timers.tick(2_000);
    reg.start("b", "B", fire("b"));
    reg.undo("a");
    t.mock.timers.tick(UNDO_WINDOW_MS - 1);
    assert.deepEqual(fired, []);
    t.mock.timers.tick(1);
    assert.deepEqual(fired, ["b"]);
    assert.deepEqual(reg.pending(), []);
  });

  test("a second start on the SAME id is refused; a different id is not", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { reg, fired, fire } = registryHarness();
    assert.equal(reg.start("dismiss:x", "Dismissing · Later", fire("x1")), true);
    assert.equal(reg.start("dismiss:x", "Dismissing · Later", fire("x2")), false);
    assert.equal(reg.start("dismiss:y", "Dismissing · Later", fire("y")), true);
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.deepEqual(fired.sort(), ["x1", "y"], "the refused second click never fires");
    assert.equal(reg.start("dismiss:x", "again", fire("x3")), true, "the id re-opens once settled");
  });

  test("a row unmounting does NOT commit its window early — only expiry or the HOST flush fires it", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { reg, fired, fire } = registryHarness();
    // A row arms its window, then a poll refresh removes the row: the row
    // holds no controller, so there is nothing for its unmount to flush.
    reg.start("action:POST /autopilot/paused", "Firing Resume in 5s", fire("resume"));
    const rowWindows = reg.pending();
    t.mock.timers.tick(UNDO_WINDOW_MS - 1);
    assert.deepEqual(fired, [], "nothing fired while the row is gone and the window is open");
    assert.deepEqual(reg.pending(), rowWindows, "the window (and its Undo) survives the row");
    reg.undo("action:POST /autopilot/paused");
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.deepEqual(fired, [], "Undo still cancels after the row left the feed");
  });

  test("flushAll (the HOST unmounting) commits every pending window once", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { reg, changes, fired, fire } = registryHarness();
    reg.start("a", "A", fire("a"));
    reg.start("b", "B", fire("b"));
    reg.flushAll();
    assert.deepEqual(fired, ["a", "b"], "the operator's clicks are never silently dropped");
    assert.deepEqual(reg.pending(), []);
    assert.deepEqual(changes.at(-1), []);
    t.mock.timers.tick(UNDO_WINDOW_MS * 2);
    assert.deepEqual(fired, ["a", "b"], "flushed windows never fire twice");
  });

  test("a window is removed from the list BEFORE its closure fires", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const changes: PendingWindow[][] = [];
    let listAtFire: PendingWindow[] | null = null;
    const reg = createUndoWindowRegistry((w) => changes.push(w));
    reg.start("a", "A", () => {
      listAtFire = reg.pending();
    });
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.deepEqual(listAtFire, [], "the toast is gone when the request goes out");
  });
});

describe("triggerDisabled — the pure trigger-state rule", () => {
  const windows: PendingWindow[] = [{ id: "dismiss:a", label: "Dismissing · Later" }];
  test("disabled while its own window is pending", () => {
    assert.equal(triggerDisabled(false, windows, "dismiss:a"), true);
  });
  test("another id's pending window does not disable it", () => {
    assert.equal(triggerDisabled(false, windows, "dismiss:b"), false);
  });
  test("disabled while its request is in flight", () => {
    assert.equal(triggerDisabled(true, [], "action:POST /scheduler/start"), true);
  });
  test("enabled when idle", () => {
    assert.equal(triggerDisabled(false, [], "dismiss:a"), false);
  });
});

describe("dismiss trigger stays disabled while the expired window's POST is in flight (QA round 5)", () => {
  /** The feed's dismiss wiring, framework-free: a registry window whose
   * closure marks the item in flight, awaits a controllable POST, and clears
   * the id in `finally` — exactly dismissItem's shape. */
  function dismissHarness() {
    let windows: PendingWindow[] = [];
    let inFlightIds: ReadonlySet<string> = new Set();
    const reg = createUndoWindowRegistry((w) => {
      windows = w;
    });
    const inFlight = createInFlightTracker((ids) => {
      inFlightIds = ids;
    });
    const posts: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    let settledCount = 0;
    // dismissItem's shape: the request runs through the REAL runTracked
    // under the item's window id (deleting begin/end in the lib reddens here).
    const dismissItem = (itemId: string) =>
      runTracked(inFlight, `dismiss:${itemId}`, async () => {
        try {
          await new Promise<void>((resolve, reject) => posts.push({ resolve, reject }));
        } catch {
          /* intentional: the harness only models the finally-clear */
        } finally {
          settledCount += 1;
        }
      });
    const start = (itemId: string) => reg.start(`dismiss:${itemId}`, "Dismissing · Later", () => dismissItem(itemId));
    const disabled = (itemId: string) =>
      triggerDisabled(inFlightIds.has(`dismiss:${itemId}`), windows, `dismiss:${itemId}`);
    return { start, disabled, posts, settled: () => settledCount, inFlight: () => inFlightIds };
  }

  test("after the window fires and while the POST is pending, the trigger stays disabled; it re-enables after settle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = dismissHarness();
    assert.equal(h.disabled("a"), false, "idle trigger is enabled");
    assert.equal(h.start("a"), true);
    assert.equal(h.disabled("a"), true, "disabled while the window is pending");
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.equal(h.posts.length, 1, "expiry fired exactly one POST");
    assert.equal(h.disabled("a"), true, "window gone but POST in flight — still disabled");
    assert.equal(h.disabled("b"), false, "another item stays dismissable");
    h.posts[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.settled(), 1);
    assert.equal(h.disabled("a"), false, "re-enabled once the POST settles");
    assert.equal(h.inFlight().size, 0);
  });

  test("a failed POST also clears the in-flight id", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = dismissHarness();
    h.start("a");
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.equal(h.disabled("a"), true);
    h.posts[0].reject(new Error("500"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.disabled("a"), false, "re-enabled after a failed settle");
  });

  test("the tracker emits a fresh Set per change and ignores no-op begin/end", () => {
    const seen: Array<ReadonlySet<string>> = [];
    const tr = createInFlightTracker((ids) => seen.push(ids));
    tr.begin("a");
    tr.begin("a");
    tr.end("b");
    tr.end("a");
    tr.end("a");
    assert.equal(seen.length, 2, "only real changes notify");
    assert.notEqual(seen[0], seen[1], "a new Set each time, so React re-renders");
    assert.deepEqual([...seen[0]], ["a"]);
    assert.deepEqual([...seen[1]], []);
  });

  test("the toast label derives its seconds from the delay", () => {
    assert.equal(undoWindowSeconds(UNDO_WINDOW_MS), "5s");
    assert.equal(undoWindowSeconds(3_000), "3s");
  });
});

describe("immediate-tier triggers share the HOST's in-flight state per window id (QA round 6)", () => {
  /** useUndoWindowHost + InDashboardAffordance, framework-free: ONE registry
   * and ONE in-flight tracker owned by the host; every row bound to a window
   * id reads its disabled state from host state only (no row-local busy), and
   * its fire runs through the REAL runTracked under that id. A "row" is just
   * a reader of host state, so a remount is a fresh reader of the same host. */
  function hostHarness() {
    let windows: PendingWindow[] = [];
    let inFlightIds: ReadonlySet<string> = new Set();
    const reg = createUndoWindowRegistry((w) => {
      windows = w;
    });
    const tracker = createInFlightTracker((ids) => {
      inFlightIds = ids;
    });
    const requests: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    let settled = 0;
    const fireRequest = () =>
      new Promise<void>((resolve, reject) => requests.push({ resolve, reject })).then(
        () => {
          settled += 1;
        },
        () => {
          /* intentional: the harness models the row's inline ✗ catch */
          settled += 1;
        },
      );
    const mountRow = (windowId: string) => ({
      disabled: () => triggerDisabled(inFlightIds.has(windowId), windows, windowId),
      click: () => reg.start(windowId, "Firing", () => runTracked(tracker, windowId, fireRequest)),
    });
    return { mountRow, requests, settled: () => settled, inFlight: () => inFlightIds };
  }
  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  };
  const WINDOW = "action:POST /scheduler/start";

  test("two rows sharing a window id: after the window fires, BOTH stay disabled until the POST settles", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = hostHarness();
    const rowA = h.mountRow(WINDOW);
    const rowB = h.mountRow(WINDOW);
    assert.equal(rowA.disabled(), false);
    assert.equal(rowB.disabled(), false);
    assert.equal(rowA.click(), true);
    assert.equal(rowB.disabled(), true, "the sibling is disabled while the window is pending");
    assert.equal(rowB.click(), false, "a sibling click on the pending window is refused");
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.equal(h.requests.length, 1, "expiry fired exactly one POST");
    assert.equal(rowA.disabled(), true, "window gone, POST in flight — firing row disabled");
    assert.equal(rowB.disabled(), true, "window gone, POST in flight — sibling row disabled too");
    assert.equal(h.mountRow("action:POST /autopilot/paused").disabled(), false, "another route stays enabled");
    h.requests[0].resolve();
    await flush();
    assert.equal(h.settled(), 1);
    assert.equal(rowA.disabled(), false, "re-enabled once the POST settles");
    assert.equal(rowB.disabled(), false, "sibling re-enabled once the POST settles");
    assert.equal(h.inFlight().size, 0);
  });

  test("a row remounted while the POST is in flight mounts disabled, and re-enables on settle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = hostHarness();
    h.mountRow(WINDOW).click();
    t.mock.timers.tick(UNDO_WINDOW_MS);
    // The original row unmounts on a poll refresh; a fresh row for the same
    // route mounts mid-request with no row-local state of its own.
    const remounted = h.mountRow(WINDOW);
    assert.equal(remounted.disabled(), true, "the remount reads the host's in-flight id");
    await flush();
    assert.equal(remounted.disabled(), true, "still disabled while the POST is pending");
    h.requests[0].resolve();
    await flush();
    assert.equal(remounted.disabled(), false, "re-enabled once the POST settles");
  });

  test("a rejected POST also clears the shared in-flight id", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = hostHarness();
    const row = h.mountRow(WINDOW);
    row.click();
    t.mock.timers.tick(UNDO_WINDOW_MS);
    assert.equal(row.disabled(), true);
    h.requests[0].reject(new Error("500"));
    await flush();
    assert.equal(row.disabled(), false);
  });

  test("runTracked marks the id for the request's whole lifetime and clears it on throw", async () => {
    let ids: ReadonlySet<string> = new Set();
    const tr = createInFlightTracker((next) => {
      ids = next;
    });
    let seenDuring = false;
    const value = await runTracked(tr, "w", async () => {
      seenDuring = ids.has("w");
      return 42;
    });
    assert.equal(seenDuring, true, "begin() runs before the request starts");
    assert.equal(value, 42, "the request's value passes through");
    assert.equal(ids.has("w"), false, "end() runs on resolve");
    await assert.rejects(
      runTracked(tr, "w", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(ids.has("w"), false, "end() runs on reject");
  });
});

describe("the dismiss + immediate triggers bind to the feed-level host", () => {
  test("the host wraps the tested registry and only the HOST flushes", async () => {
    const src = await readSource(AFFORDANCE);
    assert.ok(src.includes("createUndoWindowRegistry(setWindows, delayMs)"), "the hook wraps lib/delayed-commit.ts");
    assert.ok(src.includes("registry.current.flushAll()"), "host unmount commits through the registry");
    assert.ok(!src.includes("createDelayedCommit("), "no row-owned controller remains in the affordance");
    const feed = await readSource(FEED);
    assert.ok(feed.includes("useUndoWindowHost()"), "the feed hosts the windows");
    assert.ok(feed.includes("<UndoToastStack"), "one toast host renders every window");
    assert.ok(!feed.includes("DelayedCommitToast"), "no per-owner toast remains");
  });

  test("every trigger derives its disabled state from triggerDisabled", async () => {
    const aff = await readSource(AFFORDANCE);
    // Issue #4629 (INV-4): every trigger ALSO ORs in `blocked` (any ✗
    // precondition line) — the in-flight reads below are unchanged.
    assert.ok(
      aff.includes("disabled={blocked || triggerDisabled(undoHost.inFlight.has(windowId), undoHost.windows, windowId)}"),
      "immediate in-dashboard button reads the HOST's in-flight set (QA round 6)",
    );
    assert.ok(!aff.includes("triggerDisabled(busy,"), "no trigger reads a row-local busy flag (QA round 6)");
    assert.ok(!aff.includes("disabled={busy}"), "no confirm-first button reads ONLY its row-local busy flag (QA round 7)");
    assert.ok(aff.includes("disabled={busy || inFlight || blocked}"), "the confirm-first Confirm button reads the HOST's in-flight set (QA round 7)");
    assert.ok(aff.includes("onClick={() => setArmed(true)}\n            disabled={inFlight || blocked}"), "the confirm-first arm button reads the HOST's in-flight set (QA round 7)");
    assert.ok(aff.includes("track(windowId, fireRequest)"), "the immediate fire runs through the host tracker");
    assert.ok(aff.includes("runTracked(inFlightTracker, id, fn)"), "the host's track wraps the tested runTracked");
    assert.ok(aff.includes("createInFlightTracker(setInFlight)"), "the host owns the one in-flight tracker");
    const feed = await readSource(FEED);
    assert.ok(
      feed.includes("triggerDisabled(undoHost.inFlight.has(windowId), undoHost.windows, windowId)"),
      "each dismiss reason button reads the HOST's in-flight set",
    );
    assert.ok(!feed.includes("triggerDisabled(false,"), "no trigger hardcodes busy=false (QA round 5)");
    assert.ok(!feed.includes("createInFlightTracker("), "the feed hosts no second tracker — one per undo host");
    assert.ok(feed.includes("undoHost.track(dismissWindowId(item)"), "dismissItem runs through the host tracker");
  });
});

// ---------------------------------------------------------------------------
// 8 — bucket derivation, driven behaviourally (ADR-0034 §5.2)
// ---------------------------------------------------------------------------

function summary(bucket: string, over: Partial<BucketSummary> = {}): BucketSummary {
  return { bucket, rank: 1, count: 0, wired: true, sourcesOk: true, sourceErrors: [], ...over };
}

describe("deriveFeedBuckets — per-bucket trust", () => {
  const known = [...BUCKETS];

  test("a partial-buckets payload synthesises an UNKNOWN section for every missing bucket", () => {
    const data = { buckets: [summary("machine-stopped"), summary("prs-not-landing", { count: 1 })] };
    const { buckets, malformed } = deriveFeedBuckets(data, [], known);
    assert.equal(malformed, false);
    assert.deepEqual(
      buckets.map((b) => b.bucket),
      ["machine-stopped", "prs-not-landing", ...known.filter((k) => k !== "machine-stopped" && k !== "prs-not-landing")],
      "reported buckets keep server order; missing ones follow",
    );
    const synthetic = buckets.slice(2);
    assert.equal(synthetic.length, known.length - 2);
    for (const b of synthetic) {
      assert.equal(b.wired, false);
      assert.equal(b.sourcesOk, false, "a missing bucket is never an all-clear");
      assert.deepEqual(b.sourceErrors, ["no summary in payload"]);
    }
  });

  test("only items in proved buckets are counted; items with no section are orphaned, not dropped", () => {
    const data = {
      buckets: [
        summary("machine-stopped"),
        summary("prs-not-landing", { sourcesOk: false, sourceErrors: ["gh: rate limited"] }),
      ],
    };
    const items = [
      { id: "a", bucket: "machine-stopped" },
      { id: "b", bucket: "prs-not-landing" },
      { id: "c", bucket: "waiting-on-you" },
      { id: "d", bucket: "not-a-bucket" },
      { id: "e", bucket: "not-a-bucket" },
    ];
    const { rendered, orphaned } = deriveFeedBuckets(data, items, known);
    assert.deepEqual(rendered.map((i) => i.id), ["a"], "unproved + synthetic-UNKNOWN buckets hide their items from the count");
    assert.deepEqual(orphaned.map((i) => i.id), ["d", "e"], "an unknown bucket's items are surfaced with their count");
  });

  test("a present payload with no bucket summaries is malformed; an absent payload synthesises nothing", () => {
    const present = deriveFeedBuckets({ generatedAt: "2026-10-19T00:00:00Z" } as { buckets?: unknown }, [], known);
    assert.equal(present.malformed, true);
    assert.equal(present.buckets.length, known.length, "every bucket renders UNKNOWN");
    assert.ok(present.buckets.every((b) => !b.sourcesOk));

    const absent = deriveFeedBuckets(null, [], known);
    assert.equal(absent.malformed, false, "a failed whole payload keeps the Section unknown path");
    assert.deepEqual(absent.buckets, []);
  });

  test("a fully-proved payload synthesises nothing and counts every item", () => {
    const data = { buckets: known.map((k) => summary(k)) };
    const items = known.map((k, i) => ({ id: String(i), bucket: k }));
    const { buckets, rendered, orphaned, malformed } = deriveFeedBuckets(data, items, known);
    assert.equal(buckets.length, known.length);
    assert.equal(rendered.length, known.length);
    assert.deepEqual(orphaned, []);
    assert.equal(malformed, false);
  });

  test("AttentionFeed derives its sections from deriveFeedBuckets over the BUCKET_WHY keys", async () => {
    const src = await readSource(FEED);
    assert.ok(src.includes("deriveFeedBuckets("), "the feed uses the tested helper");
    assert.ok(src.includes("Object.keys(BUCKET_WHY)"), "the known buckets are the closed BUCKET_WHY keys");
    assert.ok(src.includes('{unproved ? "?" : summary.count}'), "an unproved header prints ? not a count");
  });
});

// ---------------------------------------------------------------------------
// 9 — re-read verdict, dismiss banner, scope fence
// ---------------------------------------------------------------------------

describe("the verified-result line does not overclaim a failed re-read", () => {
  test("onFired resolving false renders a re-read FAILED line, and the result is lifted", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes("reread === false"), "a false re-read must not render the plain ✓ line");
    // The noun is a prop defaulting to "feed" (#4629 review), so the feed's
    // line still reads "feed re-read FAILED — list may be stale".
    assert.ok(aff.includes('function resultFromResponse(action, res, reread, context, rereadNoun = "feed") {'));
    assert.ok(aff.includes('const staleNote = rereadNoun === "feed" ? "list may be stale" : "shown state may be stale";'));
    assert.ok(aff.includes("` · ${rereadNoun} re-read FAILED — ${staleNote}`"));
    const feed = await readSource(FEED);
    assert.ok(feed.includes("const refreshChecked = useCheckedRefresh({ loading, error, data, refresh });"), "the feed verifies the re-read through the shared core (#5162 INV-5)");
    assert.ok(!feed.includes("rereadWaiters"), "no hand-rolled waiter copy in the feed");
    assert.ok(feed.includes("onResult={setActionResult}"), "the result line is lifted above the rows");
    assert.ok(!feed.includes('apiFetch("/attention/feed")'), "no separate probe read");
  });
});

describe("dismiss banner — per-item outcomes (recordDismissOutcome)", () => {
  const a = { id: "a", title: "Item A" };
  const b = { id: "b", title: "Item B" };
  test("a failure is recorded under its own item id", () => {
    const out = recordDismissOutcome({}, a, { ok: false, error: new Error("boom") });
    assert.deepEqual(out, { a: "Item A: dismiss failed — boom" });
  });
  test("another item's attempt never wipes an earlier failure", () => {
    let out = recordDismissOutcome({}, a, { ok: false, error: new Error("boom") });
    out = recordDismissOutcome(out, b, { ok: true, reread: true });
    assert.deepEqual(out, { a: "Item A: dismiss failed — boom" });
    out = recordDismissOutcome(out, b, { ok: false, error: "nope" });
    assert.deepEqual(Object.keys(out).sort(), ["a", "b"]);
  });
  test("a success clears only that item's entry", () => {
    let out = recordDismissOutcome({}, a, { ok: false, error: new Error("boom") });
    out = recordDismissOutcome(out, a, { ok: true, reread: true });
    assert.deepEqual(out, {});
  });
  test("a success whose feed re-read FAILED is named, not silent", () => {
    const out = recordDismissOutcome({}, a, { ok: true, reread: false });
    assert.match(out.a, /feed re-read FAILED/);
  });
  test("the feed folds dismiss outcomes through the helper after a checked re-read", async () => {
    const src = await readSource(FEED);
    assert.ok(src.includes("const reread = await refreshChecked();"), "dismiss verifies its re-read");
    assert.ok(src.includes("recordDismissOutcome(prev, item,"), "outcomes fold through the tested helper");
    assert.ok(!src.includes("setDismissError(null)"), "no blanket clear on each attempt");
  });
});

// ---------------------------------------------------------------------------
// 9 — the live precondition checklist (issue #4629, design-concept 821e48ed
//     INV-4): lib/preconditions.ts driven behaviourally, plus the
//     affordance / page wiring pins (INV-7, INV-9, INV-10, INV-12)
// ---------------------------------------------------------------------------

const BOARD_STATE = "../dashboard/src/components/pages/work/BoardState.jsx";
const HEALTH = "../dashboard/src/pages/Health.jsx";

describe("resolvePreconditions / anyFailed — the tri-state checklist rule (issue #4629)", () => {
  test("a prose precondition renders unverified (☐) and never disables", () => {
    const lines = resolvePreconditions(["confirm the reason no longer applies"], {});
    assert.deepEqual(lines, [{ text: "confirm the reason no longer applies", state: "unverified" }]);
    assert.equal(anyFailed(lines), false);
    assert.equal(PRECONDITION_GLYPH[lines[0]!.state], "☐");
  });

  test("a {check} line is ok (✓) only when its verdict is literally true", () => {
    const lines = resolvePreconditions([{ text: "issue is open", check: "issue-open" }], { "issue-open": true });
    assert.deepEqual(lines, [{ text: "issue is open", check: "issue-open", state: "ok" }]);
    assert.equal(anyFailed(lines), false);
    assert.equal(PRECONDITION_GLYPH.ok, "✓");
  });

  test("a {check} line is fail (✗) when its verdict is false", () => {
    const lines = resolvePreconditions([{ text: "no blocker", check: "no-open-blocker" }], { "no-open-blocker": false });
    assert.equal(lines[0]!.state, "fail");
    assert.equal(anyFailed(lines), true);
    assert.equal(PRECONDITION_GLYPH.fail, "✗");
  });

  test("a {check} line with NO verdict fails closed — a forgotten evaluation can never enable the button", () => {
    assert.equal(resolvePreconditions([{ text: "t", check: "brake-off" }], {})[0]!.state, "fail");
    assert.equal(resolvePreconditions([{ text: "t", check: "brake-off" }], undefined)[0]!.state, "fail");
    assert.equal(resolvePreconditions([{ text: "t", check: "brake-off" }], null)[0]!.state, "fail");
  });

  test("a truthy non-boolean verdict and a prototype-inherited key both fail closed", () => {
    const loose: any = { "brake-off": 1 };
    assert.equal(resolvePreconditions([{ text: "t", check: "brake-off" }], loose)[0]!.state, "fail");
    assert.equal(resolvePreconditions([{ text: "t", check: "toString" }], {})[0]!.state, "fail");
  });

  test("a malformed line (object without a check) fails closed with its text, never dropped", () => {
    const lines = resolvePreconditions([{ text: "half-typed" } as any], {});
    assert.deepEqual(lines, [{ text: "half-typed", state: "fail" }]);
  });

  test("order is preserved and one ✗ among ✓/☐ lines disables the trigger", () => {
    const lines = resolvePreconditions(
      [
        { text: "a", check: "issue-open" },
        "prose",
        { text: "b", check: "has-scope-section" },
      ],
      { "issue-open": true, "has-scope-section": false },
    );
    assert.deepEqual(lines.map((l) => l.state), ["ok", "unverified", "fail"]);
    assert.equal(anyFailed(lines), true);
  });

  test("a verdict flipping to false on a refresh flips the same line to ✗ (an armed Confirm disables)", () => {
    const pre = [{ text: "the brake is off", check: "brake-off" }];
    assert.equal(anyFailed(resolvePreconditions(pre, { "brake-off": true })), false);
    assert.equal(anyFailed(resolvePreconditions(pre, { "brake-off": false })), true);
  });

  test("no preconditions → no lines, nothing disabled; a non-array is treated as empty", () => {
    assert.deepEqual(resolvePreconditions([], {}), []);
    assert.deepEqual(resolvePreconditions(undefined, {}), []);
    assert.equal(anyFailed([]), false);
  });
});

describe("ActionAffordance resolves the checklist and disables on any ✗ (issue #4629)", () => {
  test("the checklist is resolved through lib/preconditions.ts and gates every trigger", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes('from "../lib/preconditions.ts"'), "the rule lives in the tested leaf");
    assert.ok(aff.includes("const lines = resolvePreconditions(action.preconditions, verdicts);"));
    assert.ok(aff.includes("const blocked = anyFailed(lines);"));
    // Arm, Confirm and the immediate fire each OR in `blocked`.
    assert.equal((aff.match(/disabled=\{[^}]*\bblocked\b/g) ?? []).length, 3);
  });

  test("the live checklist + consequence render only for a page control (verdicts supplied)", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes("if (verdicts === undefined) return controls;"), "the feed keeps its own unchecked list");
    assert.ok(aff.includes('data-testid={tid("-preconditions")}'));
    assert.ok(aff.includes("data-state={line.state}"));
    assert.ok(aff.includes("{PRECONDITION_GLYPH[line.state]} {line.text}"));
    assert.ok(aff.includes('data-testid={tid("-consequence")}'));
    const feed = await readSource(FEED);
    assert.ok(!feed.includes("verdicts="), "the feed never hands the affordance a verdict table");
  });

  test("the affordance derives <testId>-arm / -confirm-yes / -confirm-no from its testId prop", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes("const tid = (suffix) => (testId ? `${testId}${suffix}` : undefined);"));
    for (const suffix of ["-arm", "-confirm-yes", "-confirm-no", "-result"]) {
      assert.ok(aff.includes(`data-testid={tid("${suffix}")}`), `derives ${suffix}`);
    }
    assert.ok(aff.includes('data-testid={tid("")}'), "the immediate button carries the bare testId");
  });

  test("a row's issue number joins the window id so two rows never share a window", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.match(aff, /const windowId = `action:\$\{action\.method\} \$\{action\.route\}\$\{\n?\s*context\?\.number/);
  });
});

describe("IN_DASHBOARD_BODY builders over the closed context (issue #4629 INV-7)", () => {
  test("values are static bodies or (context) => body builders, resolved by bodyFor(method, route, context)", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes("function bodyFor(method, route, context) {"));
    assert.ok(aff.includes('return typeof body === "function" ? body(context ?? {}) : body;'));
    const map = aff.slice(aff.indexOf("const IN_DASHBOARD_BODY = {"), aff.indexOf("\n};", aff.indexOf("const IN_DASHBOARD_BODY = {")));
    assert.ok(map.includes('"POST /autopilot/paused": (context) => ({ paused: context.paused ?? false }),'), "no context → the feed's {paused:false}");
    assert.ok(map.includes('"POST /autopilot/board/promote": (context) => ({ issue: context.number, confirm: true }),'));
    assert.ok(map.includes('"POST /autopilot/board/relabel": (context) => ({ issue: context.number, label: context.label }),'));
    assert.ok(map.includes('"POST /autopilot/board/close": (context) => ({ issue: context.number }),'));
    assert.ok(map.includes('"POST /autopilot/board/reopen": (context) => ({ issue: context.number }),'));
    assert.ok(map.includes('context.engaged ? { engaged: true, engagedBy: "health-page" } : { engaged: false },'));
    // The builders read only the closed context — no other field name.
    const fields = new Set(Array.from(map.matchAll(/context\.(\w+)/g), (m) => m[1]));
    // #5152 extends the closed context with the /now panel's read `runId`
    // and its picked `severity`.
    for (const f of fields) assert.ok(["number", "label", "paused", "engaged", "runId", "severity"].includes(f!), `context.${f} is outside the closed context`);
  });
});

describe("result objects are honoured — a refusal never renders ✓ (issue #4629 INV-9)", () => {
  test("ok === false renders ✗ <label> refused — <reason>: <detail>; verified renders the observed state", async () => {
    const aff = await readSource(AFFORDANCE);
    const fn = aff.slice(aff.indexOf("function resultFromResponse("), aff.indexOf("function InDashboardAffordance("));
    const refusedAt = fn.indexOf("if (res?.ok === false) {");
    const verifiedAt = fn.indexOf("if (res?.verified) {");
    assert.ok(refusedAt > 0 && verifiedAt > refusedAt, "the refusal check runs before any ✓ branch");
    const refusal = fn.slice(refusedAt, verifiedAt);
    assert.ok(refusal.includes("ok: false,"));
    assert.ok(refusal.includes("refused — "));
    assert.ok(!refusal.includes("✓"), "a refusal branch can never produce a ✓ line");
    assert.ok(fn.includes("state ${res.verified.state}, labels: ${labels || \"none\"}"));
    // The response is awaited, then the caller's re-read, then the result.
    const fire = aff.slice(aff.indexOf("const fireRequest = useCallback("), aff.indexOf("const track = undoHost?.track;"));
    const reqAt = fire.indexOf("const res = await apiFetch(");
    const rereadAt = fire.indexOf("const reread = await onFired?.();");
    const nextAt = fire.indexOf("resultFromResponse(action, res, reread, context, rereadNoun)");
    assert.ok(reqAt > 0 && rereadAt > reqAt && nextAt > rereadAt, "request → onFired re-read → result, in that order");
    assert.ok(fire.includes("onResult?.(next);"), "every outcome is lifted");
  });
});

describe("pages read the registry once and host their own undo windows (issue #4629 INV-8/INV-10/INV-12)", () => {
  test("useOperatorActions is one useApi('/operator-actions') read with no poll", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes('const { data, error, loading } = useApi("/operator-actions");'));
    assert.ok(!/useApi\("\/operator-actions",/.test(aff), "no poll option");
  });

  test("a not-ready registry or a missing key renders DISABLED with the literal reason, never a fallback label", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes('const REGISTRY_UNAVAILABLE = "operator-action registry unavailable";'));
    const wrapper = aff.slice(aff.indexOf("export function ControlAffordance("));
    assert.ok(wrapper.includes("const entry = registry.ready ? registry.byKey.get(controlKey) : undefined;"));
    assert.ok(wrapper.includes("disabled"));
    assert.ok(wrapper.includes("{REGISTRY_UNAVAILABLE}"));
    // Pages render only the recommended action — with its route resolved
    // first when the control passes resolveRoute (#4631 INV-9).
    assert.ok(wrapper.includes("const out = resolveControlAction(entry.recommended, resolveRoute);"), "the recommended action, resolved through the tested core");
    assert.ok(wrapper.includes("action={resolved.action}"));
  });

  for (const page of [BOARD_STATE, HEALTH]) {
    test(`${page} reads the registry once, hosts the undo windows, and renders ControlAffordance`, async () => {
      const src = await readSource(page);
      assert.equal((src.match(/useOperatorActions\(\)/g) ?? []).length, 1, "one registry read per page");
      assert.ok(src.includes("const undoHost = useUndoWindowHost();"));
      assert.ok(src.includes("<UndoWindowContext.Provider value={undoHost}>"));
      assert.ok(src.includes("<UndoToastStack windows={undoHost.windows} onUndo={undoHost.undo} />"));
      assert.ok(src.includes("<ControlAffordance"));
      assert.ok(!src.includes("apiFetch("), "no page-level write fetch survives");
    });
  }

  test("the relabel select is the picker only — it never fires on change; its value becomes context.label", async () => {
    const src = await readSource(BOARD_STATE);
    const select = src.slice(src.indexOf('data-testid="work-relabel-select"'), src.indexOf("</select>"));
    assert.ok(select.includes("setRelabelTargets("), "choosing only records the target");
    assert.ok(!select.includes("/autopilot/board/relabel"), "no write fires from the select");
    assert.ok(src.includes("context={{ number: row.number, label: relabelTargets[row.number] }}"));
    assert.ok(src.includes("verdicts={rowVerdicts(row, relabelTargets[row.number])}"));
    assert.ok(src.includes('controlKey="control:work/reopen"'));
    assert.ok(src.includes("verdicts={reopenVerdicts(reopenNumber)}"), "the reopen input feeds issue-number-entered");
    // relabel-target-chosen is ✗ until a closed target is picked (behaviour
    // pinned on the leaf below).
    assert.equal(rowVerdicts({}, undefined)["relabel-target-chosen"], false);
    assert.equal(rowVerdicts({}, "")["relabel-target-chosen"], false);
    assert.equal(rowVerdicts({}, "needs-info")["relabel-target-chosen"], true);
  });

  test("the promote verdicts read the server-computed row facts, never a client-side body parse", async () => {
    const src = await readSource(BOARD_STATE);
    assert.ok(!src.includes("Files in scope"), "no second scope parser in the dashboard");
    const leaf = await readSource("../dashboard/src/lib/control-verdicts.ts");
    assert.ok(!leaf.includes(".body") && !leaf.includes("Files in scope"), "the verdict leaf never reads an issue body");
  });
});

// ---------------------------------------------------------------------------
// 10 — PR #5155 review follow-ups: per-control remount, checked re-reads,
//      the page verdict tables driven behaviourally
// ---------------------------------------------------------------------------

describe("ControlAffordance remounts per control — no armed state survives a toggle (PR #5155 review)", () => {
  test("ControlAffordance keys the affordance by controlKey", async () => {
    const aff = await readSource(AFFORDANCE);
    const wrapper = aff.slice(aff.indexOf("export function ControlAffordance("));
    assert.ok(wrapper.includes("<ActionAffordance\n      key={controlKey}"), "a swapped control in the same slot remounts (armed/result/busy reset)");
  });

  test("/health swaps Pause⇄Resume and Engage⇄Release in one slot — both through ControlAffordance", async () => {
    const src = await readSource(HEALTH);
    assert.match(src, /isPaused \? \(\s*<ControlAffordance[\s\S]*?controlKey="control:health\/resume"[\s\S]*?\) : \(\s*<ControlAffordance[\s\S]*?controlKey="control:health\/pause"/);
    assert.match(src, /brakeEngaged \? \(\s*<ControlAffordance[\s\S]*?controlKey="control:health\/brake-release"[\s\S]*?\) : \(\s*<ControlAffordance[\s\S]*?controlKey="control:health\/brake-engage"/);
  });
});

describe("re-read waiters — a checked refresh resolves a real verdict (PR #5155 review)", () => {
  test("wait() queues BEFORE refresh() runs, and a settled read resolves it true", async () => {
    const w = createRereadWaiters();
    let pendingAtRefresh = -1;
    const p = w.wait(() => { pendingAtRefresh = w.pending(); });
    assert.equal(pendingAtRefresh, 1, "the waiter exists before the read starts");
    w.observe(true, true);
    w.observe(false, true);
    assert.equal(await p, true);
    assert.equal(w.pending(), 0);
  });

  test("a read that settles with an error resolves false — the re-read FAILED branch", async () => {
    const w = createRereadWaiters();
    const p = w.wait(() => {});
    w.observe(true, true);
    w.observe(false, false);
    assert.equal(await p, false);
  });

  test("a settle resolves every armed waiter once; a settle with none queued is a no-op", async () => {
    const w = createRereadWaiters();
    w.observe(false, true);
    const a = w.wait(() => {});
    const b = w.wait(() => {});
    w.observe(false, false);
    assert.deepEqual(await Promise.all([a, b]), [false, false]);
  });

  test("a waiter queued while a read is in flight does not resolve on that read, and resolves on the deferred one (#5162 INV-1/2)", async () => {
    const w = createRereadWaiters();
    let refreshes = 0;
    w.observe(true, true); // a 30 s poll is already in flight
    let resolved: boolean | undefined;
    const p = w.wait(() => { refreshes++; }).then((v) => { resolved = v; });
    assert.equal(refreshes, 0, "the refresh is DEFERRED while a read is in flight");
    assert.equal(w.pending(), 1);
    w.observe(false, true); // the OLD poll settles ok
    await Promise.resolve();
    assert.equal(refreshes, 1, "the deferred read starts once the old one settled");
    assert.equal(resolved, undefined, "the pre-write read never settles the waiter");
    w.observe(true, true); // the deferred read's rising edge
    w.observe(false, false); // its own verdict: failed
    await p;
    assert.equal(resolved, false, "the post-write read's verdict wins, not the older poll's");
  });

  test("two waiters deferred behind one in-flight read share ONE deferred refresh", async () => {
    const w = createRereadWaiters();
    let refreshes = 0;
    w.observe(true, true);
    const a = w.wait(() => { refreshes++; });
    const b = w.wait(() => { refreshes++; });
    w.observe(false, true);
    assert.equal(refreshes, 1);
    w.observe(true, true);
    w.observe(false, true);
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
  });

  test("close() (unmount) resolves armed AND deferred waiters false and later waits resolve false without reading (INV-4)", async () => {
    const w = createRereadWaiters();
    const armed = w.wait(() => {});
    w.observe(true, true);
    const deferredWait = w.wait(() => {});
    w.close();
    assert.equal(await armed, false);
    assert.equal(await deferredWait, false);
    let read = false;
    assert.equal(await w.wait(() => { read = true; }), false);
    assert.equal(read, false, "a closed host starts no read");
    w.open();
    const q = w.wait(() => {});
    w.observe(false, true);
    assert.equal(await q, true, "open() re-arms after a StrictMode remount");
  });

  test("a refresh that throws synchronously resolves false (fail loud, never a hang)", async (t) => {
    t.mock.method(console, "error", () => {});
    const w = createRereadWaiters();
    assert.equal(await w.wait(() => { throw new Error("boom"); }), false);
  });

  test("a DEFERRED refresh that throws resolves its waiters false, never a hang (INV-4)", async (t) => {
    t.mock.method(console, "error", () => {});
    const w = createRereadWaiters();
    w.observe(true, true);
    const p = w.wait(() => { throw new Error("boom"); });
    w.observe(false, true);
    assert.equal(await p, false);
  });

  test("the hook reports every render and both pages pass it as onFired", async () => {
    const aff = await readSource(AFFORDANCE);
    const hook = aff.slice(aff.indexOf("export function useCheckedRefresh("), aff.indexOf("export function ControlAffordance("));
    assert.ok(hook.includes("waiters.current.observe(loading, error == null);"), "every render is reported, loading=true included (INV-3)");
    assert.ok(!hook.includes("if (!loading)"));
    assert.ok(hook.includes("return () => waiters.current.close();"));
    assert.ok(hook.includes("waiters.current.wait(refresh)"));
    const board = await readSource(BOARD_STATE);
    assert.ok(board.includes("return boardOk && queueOk;"), "/work resolves false when either re-read failed");
    assert.equal((board.match(/rereadNoun="board"/g) ?? []).length, 4);
    const health = await readSource(HEALTH);
    assert.ok(health.includes("const refreshHealth = useCheckedRefresh(health);"));
    const useApi = await readSource("../dashboard/src/hooks/useApi.js");
    assert.ok(!useApi.includes("useCheckedRefresh"), "useApi.js stays fenced (INV-15)");
  });

  test("a new board action clears the previous outcome as its request starts", async () => {
    const aff = await readSource(AFFORDANCE);
    const fire = aff.slice(aff.indexOf("const fireRequest = useCallback("), aff.indexOf("const track = undoHost?.track;"));
    assert.ok(fire.indexOf("onStart?.();") < fire.indexOf("const res = await apiFetch("), "onStart runs before the request");
    const board = await readSource(BOARD_STATE);
    assert.ok(board.includes("const clearResult = useCallback(() => setActionResult(null), []);"));
    assert.equal((board.match(/onStart=\{clearResult\}/g) ?? []).length, 4);
  });
});

describe("page verdict tables — lib/control-verdicts.ts (PR #5155 review)", () => {
  const row = (over: any = {}) => ({ lane: "needs-triage", hasScopeSection: true, openBlockers: [], ...over });

  test("a clean non-ready row passes every promote check", () => {
    assert.deepEqual(rowVerdicts(row(), "blocked"), {
      "issue-open": true,
      "not-already-ready": true,
      "has-scope-section": true,
      "no-open-blocker": true,
      "relabel-target-chosen": true,
    });
  });

  test("a ready-for-agent row fails not-already-ready", () => {
    assert.equal(rowVerdicts(row({ lane: "ready-for-agent" }), undefined)["not-already-ready"], false);
  });

  test("an unscoped row fails has-scope-section; a missing fact fails closed too", () => {
    assert.equal(rowVerdicts(row({ hasScopeSection: false }), undefined)["has-scope-section"], false);
    assert.equal(rowVerdicts(row({ hasScopeSection: undefined }), undefined)["has-scope-section"], false);
  });

  test("an open blocker fails no-open-blocker; a missing blocker list fails closed", () => {
    assert.equal(rowVerdicts(row({ openBlockers: [9] }), undefined)["no-open-blocker"], false);
    assert.equal(rowVerdicts(row({ openBlockers: undefined }), undefined)["no-open-blocker"], false);
  });

  test("relabel-target-chosen accepts only the closed RELABEL_TARGETS", () => {
    for (const t of RELABEL_TARGETS) assert.equal(rowVerdicts(row(), t)["relabel-target-chosen"], true, t);
    assert.equal(rowVerdicts(row(), "ready-for-agent")["relabel-target-chosen"], false);
  });

  test("reopenVerdicts: only a positive integer counts as entered", () => {
    assert.equal(reopenVerdicts("12")["issue-number-entered"], true);
    for (const v of ["", "0", "-3", "1.5", "abc"]) assert.equal(reopenVerdicts(v)["issue-number-entered"], false, v);
  });

  test("healthVerdicts: running + brake off, verified", () => {
    const v = healthVerdicts({ autopilotPause: { paused: false, ok: true }, emergencyBrake: { engaged: false, ok: true } }, true);
    assert.deepEqual(v, {
      "pause-state-verified": true,
      "autopilot-running": true,
      "autopilot-paused": false,
      "brake-state-verified": true,
      "brake-off": true,
      "brake-engaged": false,
    });
  });

  test("healthVerdicts: paused + brake engaged flips the state checks", () => {
    const v = healthVerdicts({ autopilotPause: { paused: true }, emergencyBrake: { engaged: true } }, true);
    assert.equal(v["autopilot-running"], false);
    assert.equal(v["autopilot-paused"], true);
    assert.equal(v["brake-off"], false);
    assert.equal(v["brake-engaged"], true);
  });

  test("healthVerdicts: an untrusted read, a missing flag or ok:false verifies nothing", () => {
    const every = (v: Record<string, boolean>) => Object.values(v).every((x) => x === false);
    const good = { autopilotPause: { paused: false, ok: true }, emergencyBrake: { engaged: false, ok: true } };
    assert.ok(every(healthVerdicts(good, false)), "loading/UNKNOWN read");
    assert.ok(every(healthVerdicts(null, true)), "no payload");
    const pauseFailed = healthVerdicts({ ...good, autopilotPause: { paused: false, ok: false } }, true);
    assert.equal(pauseFailed["pause-state-verified"], false);
    assert.equal(pauseFailed["autopilot-running"], false, "never a confident RUNNING on a failed read");
    const brakeFailed = healthVerdicts({ ...good, emergencyBrake: { engaged: false, ok: false } }, true);
    assert.equal(brakeFailed["brake-off"], false, "never a confident OFF on a failed read");
    assert.equal(brakeFailed["pause-state-verified"], true, "the flags are verified independently");
  });
});

// ---------------------------------------------------------------------------
// 11 — /health alert, scheduler and housekeeping controls (issue #4631,
//      design-concept 5ae4b72c INV-7/8/9/10/11)
// ---------------------------------------------------------------------------

const ALERTS_PANEL = "../dashboard/src/components/pages/health/AlertsPanel.jsx";
const SERVICE_STRIP = "../dashboard/src/components/pages/health/ServiceStrip.jsx";

describe("the #4631 routes ride the closed body map, and the result lifts its body", () => {
  test("IN_DASHBOARD_BODY carries a static {} for the four new routes; /scheduler/start keeps its {}", async () => {
    const aff = await readSource(AFFORDANCE);
    const map = aff.slice(aff.indexOf("const IN_DASHBOARD_BODY = {"), aff.indexOf("\n};", aff.indexOf("const IN_DASHBOARD_BODY = {")));
    for (const key of ["POST /alerts/:id/dismiss", "POST /alerts/dismiss-all", "POST /scheduler/stop", "POST /maintenance/housekeeping", "POST /scheduler/start"]) {
      assert.ok(map.includes(`"${key}": {},`), `${key} → {}`);
    }
  });

  test("the lifted result carries body — the parsed 2xx JSON — and undefined on a failed request", async () => {
    const aff = await readSource(AFFORDANCE);
    const fn = aff.slice(aff.indexOf("function resultFromResponse("), aff.indexOf("function InDashboardAffordance("));
    assert.ok(fn.includes("    body: res,\n"), "every 2xx result object carries the response body");
    const fire = aff.slice(aff.indexOf("const fireRequest = useCallback("), aff.indexOf("const track = undoHost?.track;"));
    const catchArm = fire.slice(fire.indexOf("} catch (err) {"));
    assert.ok(catchArm.includes("body: undefined,"), "a thrown request lifts no body");
  });
});

describe("ControlAffordance resolves an {id} route before the affordance sees it (issue #4631 INV-9)", () => {
  test("a resolveRoute prop resolves the registry route; a throwing resolver renders DISABLED and never fires", async () => {
    const aff = await readSource(AFFORDANCE);
    const wrapper = aff.slice(aff.indexOf("export function ControlAffordance("));
    assert.ok(wrapper.includes("rereadNoun, resolveRoute }) {"), "resolveRoute is a ControlAffordance prop");
    const resolvedAt = wrapper.indexOf("const resolved = useMemo(");
    const renderAt = wrapper.indexOf("<ActionAffordance");
    assert.ok(resolvedAt > 0 && renderAt > resolvedAt, "the route resolves BEFORE ActionAffordance renders");
    const unresolved = wrapper.slice(wrapper.indexOf("if (resolved.error !== undefined) {"), renderAt);
    assert.ok(unresolved.includes("disabled"), "an unresolved route renders a disabled button");
    assert.ok(!unresolved.includes("onClick"), "the unresolved state has no trigger at all");
    assert.ok(wrapper.includes("console.error(`[ControlAffordance] ${controlKey}: ${out.error} — control disabled`);"), "fail loud");
  });

  test("the window id embeds the resolved route, so two alerts' Dismiss windows never collide", async () => {
    const { resolveControlRoute } = await import("../dashboard/src/lib/health-verdicts.ts");
    const aff = await readSource(AFFORDANCE);
    assert.match(aff, /const windowId = `action:\$\{action\.method\} \$\{action\.route\}/);
    const a = resolveControlRoute("/alerts/{id}/dismiss", { id: "alert-1" });
    const b = resolveControlRoute("/alerts/{id}/dismiss", { id: "alert-2" });
    assert.notEqual(`action:POST ${a}`, `action:POST ${b}`);
  });
});

describe("the /health panels render controls from the page's ONE registry read (issue #4631 INV-7/8)", () => {
  for (const panel of [ALERTS_PANEL, SERVICE_STRIP]) {
    test(`${panel} renders ControlAffordance from the entries prop and never reads the registry itself`, async () => {
      const src = await readSource(panel);
      assert.ok(src.includes("<ControlAffordance"));
      assert.ok(src.includes("registry={entries}"), "the controls read the entries handed down");
      assert.ok(!src.includes("useOperatorActions("), "no second registry read");
      assert.ok(!src.includes('"/operator-actions"'), "no direct registry fetch");
      assert.ok(!src.includes("apiFetch("), "no hand-rolled write");
      assert.ok(src.includes("useCheckedRefresh("), "onFired is a CHECKED re-read of the panel's own read");
      assert.ok(src.includes('rereadNoun="/health"'));
    });
  }

  test("Health.jsx passes its one registry read down to both panels", async () => {
    const src = await readSource(HEALTH);
    assert.ok(src.includes("<ServiceStrip entries={registry} />"));
    assert.ok(src.includes("<AlertsPanel entries={registry} />"));
  });

  test("the scheduler Stop ⇄ Start toggle swaps two ControlAffordance controls in one slot (remount per key)", async () => {
    const src = await readSource(SERVICE_STRIP);
    assert.match(
      src,
      /sched\.data\.running === true \? \(\s*<ControlAffordance[\s\S]*?controlKey="control:health\/scheduler-stop"[\s\S]*?\) : \(\s*<ControlAffordance[\s\S]*?controlKey="control:health\/scheduler-start"/,
    );
    // An UNKNOWN scheduler read renders no control at all (INV-13).
    assert.ok(src.includes("{!schedUnknown && (\n        <div data-testid=\"scheduler-controls\">"));
    assert.ok(src.includes("schedulerVerdicts(schedUnknown ? null : sched.data, Date.now())"), "an untrusted read yields no verdict");
  });

  test("every undismissed alert row carries its own Dismiss; Dismiss all sits beside the count", async () => {
    const src = await readSource(ALERTS_PANEL);
    const row = src.slice(src.indexOf("function AlertRow("), src.indexOf("export default function AlertsPanel("));
    assert.ok(row.includes('controlKey="control:health/alert-dismiss"'));
    assert.ok(row.includes("resolveControlRoute(route, { id: alertId })"), "the per-row route is resolved through the tested leaf");
    assert.ok(row.includes("resolveRoute={resolveRoute}"));
    assert.ok(row.includes("verdicts={alertVerdicts(alert)}"));
    const panel = src.slice(src.indexOf("export default function AlertsPanel("));
    // Headline AND disclosure rows both hand the row its controls.
    assert.equal((panel.match(/<AlertRow[\s\S]*?entries=\{entries\}[\s\S]*?onFired=\{refreshAlerts\}/g) ?? []).length, 2);
    const countAt = panel.indexOf('data-testid="alerts-count">\n              {undismissed.length} active');
    const allAt = panel.indexOf('controlKey="control:health/alerts-dismiss-all"');
    assert.ok(countAt > 0 && allAt > countAt, "Dismiss all renders beside the N active count");
    assert.ok(panel.includes("verdicts={alertsVerdicts(undismissed.length)}"));
  });
});

describe("resolveControlAction — no control route carrying { ever reaches the affordance (PR #5157 review)", () => {
  const action = (route: string) => ({ kind: "in-dashboard", method: "POST", route, label: "Dismiss" });

  test("a templated route rendered WITHOUT a resolver is refused, never fired against a literal {id}", () => {
    const out = resolveControlAction(action("/alerts/{id}/dismiss"));
    assert.equal(out.action, undefined);
    assert.match(out.error ?? "", /route still carries a placeholder: \/alerts\/\{id\}\/dismiss/);
  });

  test("a resolver that throws, returns a non-string, or leaves a { behind is refused", () => {
    const thrown = resolveControlAction(action("/alerts/{id}/dismiss"), () => {
      throw new Error("unresolved route placeholder {id}");
    });
    assert.match(thrown.error ?? "", /route did not resolve: unresolved route placeholder \{id\}/);
    assert.ok(resolveControlAction(action("/alerts/{id}/dismiss"), () => 42 as any).error);
    assert.match(resolveControlAction(action("/x/{a}/{b}"), (r) => r.replace("{a}", "1")).error ?? "", /still carries a placeholder/);
  });

  test("a resolved route passes with the route substituted; an untemplated route passes unchanged", () => {
    const out = resolveControlAction(action("/alerts/{id}/dismiss"), (r) => r.replace("{id}", "alert-1"));
    assert.equal(out.error, undefined);
    assert.equal(out.action?.route, "/alerts/alert-1/dismiss");
    const plain = action("/scheduler/stop");
    assert.equal(resolveControlAction(plain).action, plain, "no resolver, no placeholder → the action as served");
    assert.equal(resolveControlAction(plain, (r) => r).action, plain);
  });

  test("ControlAffordance renders the refusal DISABLED via the pure core", async () => {
    const aff = await readSource(AFFORDANCE);
    const wrapper = aff.slice(aff.indexOf("export function ControlAffordance("));
    assert.ok(wrapper.includes("resolveControlAction(entry.recommended, resolveRoute)"), "every control, resolver or not, goes through the guard");
    assert.ok(!wrapper.includes("resolveRoute(entry.recommended.route)"), "no inline resolution bypasses the guard");
    const refused = wrapper.slice(wrapper.indexOf("if (resolved.error !== undefined) {"), wrapper.indexOf("<ActionAffordance"));
    assert.ok(refused.includes("disabled") && refused.includes("✗ {resolved.error}"));
  });
});

// ---------------------------------------------------------------------------
// /now recommendation controls (issue #5152)
// ---------------------------------------------------------------------------

describe("the /now recommendation routes ride the closed body map (issue #5152)", () => {
  test("both bodies carry the panel's read run_id from context — never the `current` alias", async () => {
    const aff = await readSource(AFFORDANCE);
    const map = aff.slice(aff.indexOf("const IN_DASHBOARD_BODY = {"), aff.indexOf("\n};", aff.indexOf("const IN_DASHBOARD_BODY = {")));
    assert.ok(map.includes('"POST /now/recommendations/:id/dismiss": (context) => ({ run_id: context.runId }),'));
    assert.ok(map.includes('"POST /now/recommendations/mute-class": (context) => ({ run_id: context.runId, severity: context.severity }),'));
    assert.ok(!map.includes('"current"'), "no builder falls back to the current alias");
  });

  test("a resolved rec route matches the :id key, and two recs never share a window id", async () => {
    const { resolveControlRoute } = await import("../dashboard/src/lib/health-verdicts.ts");
    const a = resolveControlRoute("/now/recommendations/{id}/dismiss", { id: "run-A:1:0" });
    const b = resolveControlRoute("/now/recommendations/{id}/dismiss", { id: "run-A:1:1" });
    // Same encoding the page-local control used (encodeURIComponent(rec.id)).
    assert.equal(a, `/now/recommendations/${encodeURIComponent("run-A:1:0")}/dismiss`);
    assert.notEqual(`action:POST ${a}`, `action:POST ${b}`);
    // The resolved route has the :id key's segment shape (5 segments), so
    // bodyFor's pattern arm matches it and never the 4-segment mute-class key.
    assert.equal(a.split("/").length, "/now/recommendations/:id/dismiss".split("/").length);
    assert.notEqual(a.split("/").length, "/now/recommendations/mute-class".split("/").length);
  });
});
