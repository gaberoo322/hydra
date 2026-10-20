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
  triggerDisabled,
  undoWindowSeconds,
} from "../dashboard/src/lib/delayed-commit.ts";
import type { BucketSummary } from "../dashboard/src/lib/attention-buckets.ts";
import { deriveFeedBuckets, recordDismissOutcome } from "../dashboard/src/lib/attention-buckets.ts";

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
    const keys = objectLiteralKeys(await readSource(AFFORDANCE), "const IN_DASHBOARD_BODY = {");
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
    const dismissItem = async (itemId: string) => {
      inFlight.begin(itemId);
      try {
        await new Promise<void>((resolve, reject) => posts.push({ resolve, reject }));
      } catch {
        /* intentional: the harness only models the finally-clear */
      } finally {
        inFlight.end(itemId);
        settledCount += 1;
      }
    };
    const start = (itemId: string) => reg.start(`dismiss:${itemId}`, "Dismissing · Later", () => dismissItem(itemId));
    const disabled = (itemId: string) =>
      triggerDisabled(inFlightIds.has(itemId), windows, `dismiss:${itemId}`);
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
    assert.ok(aff.includes("disabled={triggerDisabled(busy, undoHost.windows, windowId)}"), "immediate in-dashboard button");
    const feed = await readSource(FEED);
    assert.ok(feed.includes("triggerDisabled(busy, undoHost.windows, dismissWindowId(item))"), "each dismiss reason button");
    assert.ok(!feed.includes("triggerDisabled(false,"), "no trigger hardcodes busy=false (QA round 5)");
    assert.ok(feed.includes("dismissBusy={dismissInFlight.has(item.id)}"), "rows read busy from the in-flight set");
    assert.ok(feed.includes("inFlight.current.end(item.id)"), "dismissItem clears its in-flight id");
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
    assert.ok(aff.includes("feed re-read FAILED"));
    const feed = await readSource(FEED);
    assert.ok(feed.includes("const refreshChecked = useCallback"), "the feed verifies the re-read");
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
