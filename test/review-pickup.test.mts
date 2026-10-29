/**
 * Regression tests for the /hydra-review pickup-set aggregator (issue #745).
 *
 * The pickup set unifies two buckets — ready-for-human + stale-blocked —
 * which is intentionally NOT the same as the dashboard-v2 `getDecisionQueue()`
 * (whose second bucket is `needs-info`). A third bucket — the dated
 * `Operator decision queue YYYY-MM-DD` digest issue — was retired by
 * ADR-0034 §8.1 / #4621: `hydra-grill` now posts its gate-fail handoff
 * directly on the anchor issue (a `## hydra-grill handoff` comment plus the
 * `ready-for-human` label) instead of a dated queue issue.
 * `hitl-grill` was a fourth bucket from #4026 until the lane moved to its own
 * skill (`/hydra-hitl-grill`): parked ideas are NOT operator-attention items,
 * so `/hydra-review` — and the phone-notify hook that mirrors it — ignore them. The
 * phone-notify hook reads THIS aggregator so it mirrors what the operator sees
 * in `/hydra-review`.
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`). Tests stub the seam readers
 * (the discriminated `listIssuesByLabel`, and `listIssuesBySearch` for
 * the open-blocker lookup) and feed the pure helpers the canonical `IssueRow`
 * shape — the raw-JSON parse now lives in the seam's own suite
 * (`github-issues.test.mts`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { getReviewPickupSet } from "../src/review-pickup.ts";
import type { IssueReadResult, IssueRow } from "../src/github/issues.ts";

function issueRow(over: Partial<IssueRow> & { number: number }): IssueRow {
  return {
    number: over.number,
    title: over.title ?? `Issue #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/issues/${over.number}`,
    createdAt: over.createdAt ?? "",
    labels: over.labels ?? [],
    body: over.body ?? "",
    state: over.state ?? "OPEN",
  };
}

/** Adapt a `label -> rows` stub to the discriminated seam reader (throws propagate). */
function byLabel(
  fn: (label: string) => Promise<IssueRow[]> | IssueRow[],
): (label: string) => Promise<IssueReadResult<IssueRow>> {
  return async (label) => ({ ok: true, rows: await fn(label) }) as IssueReadResult<IssueRow>;
}

describe("getReviewPickupSet — integration", () => {
  test("module is a pure projection: no github/, digest-issue or extractIssueRefs import", () => {
    const src = readFileSync(new URL("../src/review-pickup.ts", import.meta.url), "utf8");
    const imports = src.match(/^(?:import|export)[\s\S]*?from\s+"[^"]+";/gm) ?? [];
    for (const imp of imports) {
      assert.ok(!imp.includes("github/"), imp);
      assert.ok(!imp.includes("digest-issue"), imp);
      assert.ok(!imp.includes("extractIssueRefs"), imp);
    }
  });

  test("merges both buckets; only stale-blocked issues survive", async () => {
    const items = await getReviewPickupSet({
      listIssuesByLabel: byLabel(async (label) => {
        if (label === "ready-for-human") {
          return [
            issueRow({ number: 200, title: "Decide tier", url: "https://x/200", createdAt: "2026-05-29T08:00:00Z" }),
          ];
        }
        if (label === "blocked") {
          // #300 has an open blocker (#100); #400 only a closed one (#500).
          return [
            issueRow({ number: 300, title: "still blocked", url: "https://x/300", body: "blocked by #100" }),
            issueRow({ number: 400, title: "stale blocked", url: "https://x/400", body: "depends on #500" }),
          ];
        }
        return [];
      }),
      // open-blocker lookup over {100, 500}: only #100 is open.
      listIssuesBySearch: async () => ({ ok: true, rows: [issueRow({ number: 100 })] }),
    });
    const numbers = items.map((i) => i.number);
    // #200 (ready-for-human), #400 (stale-blocked).
    // #300 is NOT here — its blocker #100 is still open.
    assert.deepEqual(numbers, [200, 400]);
    assert.equal(items.find((i) => i.number === 400)?.source, "stale-blocked");
  });

  test("a failed open-blocker lookup conservatively treats all blockers as open", async () => {
    const items = await getReviewPickupSet({
      listIssuesByLabel: byLabel(async (label) =>
        label === "blocked"
          ? [issueRow({ number: 400, title: "blocked", url: "https://x/400", body: "depends on #500" })]
          : [],
      ),
      // Discriminated reader reports a failure → #500 treated as still-open →
      // #400 is NOT surfaced as stale (no false notification).
      listIssuesBySearch: async () => ({ ok: false, code: "gh-failed" }),
    });
    assert.deepEqual(items, []);
  });

  test("never throws — a failed sub-source contributes []", async () => {
    const items = await getReviewPickupSet({
      listIssuesByLabel: byLabel(async (label) => {
        if (label === "ready-for-human") throw new Error("ready-for-human reader exploded");
        if (label === "blocked") {
          return [issueRow({ number: 400, title: "stale blocked", url: "https://x/400", body: "depends on #500" })];
        }
        return [];
      }),
      // #500 not in the open set → #400 stale-blocked survives.
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    // The surviving stale-blocked source still ships.
    assert.deepEqual(items.map((i) => i.number), [400]);
  });

  test("empty board yields empty pickup set", async () => {
    const items = await getReviewPickupSet({
      listIssuesByLabel: byLabel(async () => []),
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.deepEqual(items, []);
  });

  test("hitl-grill issues never enter the pickup set, and the lane is never even read", async () => {
    const labelsRead: string[] = [];
    const items = await getReviewPickupSet({
      listIssuesByLabel: byLabel(async (label) => {
        labelsRead.push(label);
        return label === "hitl-grill"
          ? [issueRow({ number: 700, title: "Parked idea", url: "https://x/700" })]
          : [];
      }),
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.deepEqual(items, []);
    assert.ok(
      !labelsRead.includes("hitl-grill"),
      "/hydra-review must not spend a gh call on the park lane — /hydra-hitl-grill owns it",
    );
  });

  test("an issue in both hitl-grill and ready-for-human surfaces once, under ready-for-human only", async () => {
    const items = await getReviewPickupSet({
      listIssuesByLabel: byLabel(async (label) => {
        if (label === "ready-for-human" || label === "hitl-grill") {
          return [issueRow({ number: 200, title: "Both", url: "https://x/200" })];
        }
        return [];
      }),
      listIssuesBySearch: async () => ({ ok: true, rows: [] }),
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "ready-for-human");
    assert.deepEqual(items[0].sources, ["ready-for-human"]);
  });
});
