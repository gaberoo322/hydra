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
// 7 — QA round-1 forward-fix pins (#4628, PR #4976)
// ---------------------------------------------------------------------------

describe("delayed commit never silently drops an operator action", () => {
  test("a replacing start() and an unmount FLUSH the pending commit", async () => {
    const src = await readSource(AFFORDANCE);
    assert.ok(src.includes("const firePending = useRef(null)"), "the pending fire closure is retained");
    assert.match(src, /flush\(\);\s*\n\s*setPending\(\{ label \}\)/, "start() flushes the prior commit first");
    assert.ok(src.includes("useEffect(() => flush, [flush])"), "unmount commits the pending action");
  });
});

describe("the verified-result line does not overclaim a failed re-read", () => {
  test("onFired resolving false renders a re-read FAILED line, and the result is lifted", async () => {
    const aff = await readSource(AFFORDANCE);
    assert.ok(aff.includes("reread === false"), "a false re-read must not render the plain ✓ line");
    assert.ok(aff.includes("feed re-read FAILED"));
    const feed = await readSource(FEED);
    assert.ok(feed.includes("const refreshChecked = useCallback"), "the feed verifies the re-read");
    assert.ok(feed.includes("onResult={setActionResult}"), "the result line is lifted above the rows");
  });
});

describe("dismiss banner and malformed payload", () => {
  test("dismissItem clears the stale failure banner on each attempt", async () => {
    const src = await readSource(FEED);
    assert.match(src, /async \(item, reason\) => \{\s*\n\s*setDismissError\(null\);/);
  });

  test("a present payload with no bucket summaries renders UNKNOWN, and only rendered items are counted", async () => {
    const src = await readSource(FEED);
    assert.ok(src.includes("const malformed = Boolean(data) && reported.length === 0"));
    assert.ok(src.includes("|| malformed}"), "malformed feeds the Section unknown prop");
    assert.ok(src.includes("count={rendered.length}"));
  });
});

describe("QA round-2 forward-fix pins (#4628, PR #4976)", () => {
  test("the in-dashboard immediate button is disabled while its commit is pending (no double-fire)", async () => {
    const src = await readSource(AFFORDANCE);
    assert.ok(src.includes("disabled={busy || Boolean(undoWindow.pending)}"));
  });

  test("a bucket with no summary is a synthetic UNKNOWN, orphaned items are surfaced, only proved buckets are counted", async () => {
    const src = await readSource(FEED);
    assert.ok(src.includes("Object.keys(BUCKET_WHY).filter"), "missing buckets are synthesised");
    assert.ok(src.includes("b.wired && b.sourcesOk"), "the count covers only proved buckets");
    assert.ok(src.includes("orphaned.length > 0"), "dropped items are surfaced");
    assert.ok(src.includes('{unproved ? "?" : summary.count}'), "an unproved header prints ? not a count");
  });

  test("the re-read verdict derives from the actual refresh, not a probe GET", async () => {
    const feed = await readSource(FEED);
    assert.ok(feed.includes("const ok = await refresh();"));
    assert.ok(!feed.includes('apiFetch("/attention/feed")'), "no separate probe read");
    const api = await readSource("dashboard/src/hooks/useApi.js");
    assert.ok(api.includes("return false;"), "useApi.refresh resolves false on failure");
  });
});
