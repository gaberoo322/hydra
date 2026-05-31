/**
 * Regression tests for the /hydra-review pickup-set aggregator (issue #745).
 *
 * The pickup set unifies three buckets — operator-decision-queue +
 * ready-for-human + stale-blocked — which is intentionally NOT the same as the
 * dashboard-v2 `getDecisionQueue()` (whose third bucket is `needs-info`). The
 * phone-notify hook reads THIS aggregator so it mirrors what the operator sees
 * in `/hydra-review`.
 *
 * Pure helpers are tested directly; the integration shape is tested with an
 * exec stub that routes by command-string substring — no subprocesses, no
 * GitHub round-trips.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getReviewPickupSet,
  mergePickupItems,
  parseBlockedIssuesOutput,
  classifyStaleBlocked,
  parseOpenNumbers,
} from "../src/review-pickup.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");

function makeExecStub(routes: Array<{ match: string; stdout: string }>) {
  return async (cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const { match, stdout } of routes) {
      if (key.includes(match)) return { stdout, stderr: "" };
    }
    throw new Error(`exec-stub: no route for "${key}"`);
  };
}

// ---------------------------------------------------------------------------
// mergePickupItems — pure helper
// ---------------------------------------------------------------------------

describe("mergePickupItems — pure helper", () => {
  test("dedupes by number; digest wins as primary source", () => {
    const merged = mergePickupItems({
      "operator-decision-queue": [{ number: 10, title: "A", url: "ua" }],
      "ready-for-human": [{ number: 10, title: "A-dup", url: "ua" }],
      "stale-blocked": [{ number: 10, title: "A-dup2", url: "ua" }],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "operator-decision-queue");
    assert.deepEqual(merged[0].sources, [
      "operator-decision-queue",
      "ready-for-human",
      "stale-blocked",
    ]);
  });

  test("sorts by ascending issue number", () => {
    const merged = mergePickupItems({
      "ready-for-human": [
        { number: 30, title: "c", url: "u30" },
        { number: 10, title: "a", url: "u10" },
      ],
      "stale-blocked": [{ number: 20, title: "b", url: "u20" }],
    });
    assert.deepEqual(merged.map((i) => i.number), [10, 20, 30]);
  });

  test("empty input yields empty list", () => {
    assert.deepEqual(mergePickupItems({}), []);
  });
});

// ---------------------------------------------------------------------------
// parseBlockedIssuesOutput — pure helper
// ---------------------------------------------------------------------------

describe("parseBlockedIssuesOutput — pure helper", () => {
  test("returns [] on empty / non-JSON / non-array", () => {
    assert.deepEqual(parseBlockedIssuesOutput(""), []);
    assert.deepEqual(parseBlockedIssuesOutput("not json"), []);
    assert.deepEqual(parseBlockedIssuesOutput("{}"), []);
  });

  test("extracts blocker refs from body, dropping self-references", () => {
    const stdout = JSON.stringify([
      { number: 5, title: "T", url: "u5", body: "blocked by #5 and #9" },
    ]);
    const parsed = parseBlockedIssuesOutput(stdout);
    assert.equal(parsed.length, 1);
    // #5 is a self-reference and is filtered out; #9 remains.
    assert.deepEqual(parsed[0].blockerRefs, [9]);
  });

  test("no refs in body yields empty blockerRefs", () => {
    const stdout = JSON.stringify([
      { number: 7, title: "Standalone", url: "u7", body: "Waiting on operator decision." },
    ]);
    assert.deepEqual(parseBlockedIssuesOutput(stdout)[0].blockerRefs, []);
  });
});

// ---------------------------------------------------------------------------
// classifyStaleBlocked — pure helper
// ---------------------------------------------------------------------------

describe("classifyStaleBlocked — pure helper", () => {
  const blocked = [
    { number: 1, title: "no refs", url: "u1", blockerRefs: [] },
    { number: 2, title: "open blocker", url: "u2", blockerRefs: [100] },
    { number: 3, title: "closed blocker", url: "u3", blockerRefs: [200] },
    { number: 4, title: "mixed", url: "u4", blockerRefs: [200, 100] },
  ];

  test("no blocker refs => stale-blocked", () => {
    const stale = classifyStaleBlocked(blocked, new Set([100]));
    assert.ok(stale.some((s) => s.number === 1));
  });

  test("open blocker present => NOT stale", () => {
    const stale = classifyStaleBlocked(blocked, new Set([100]));
    assert.ok(!stale.some((s) => s.number === 2));
    // #4 has an open blocker (#100) among its refs, so not stale.
    assert.ok(!stale.some((s) => s.number === 4));
  });

  test("only closed blockers => stale-blocked", () => {
    const stale = classifyStaleBlocked(blocked, new Set([100]));
    // #3's only ref (#200) is not in the open set, so it's stale.
    assert.ok(stale.some((s) => s.number === 3));
  });
});

// ---------------------------------------------------------------------------
// parseOpenNumbers — pure helper
// ---------------------------------------------------------------------------

describe("parseOpenNumbers — pure helper", () => {
  test("intersects reported open numbers with requested", () => {
    const stdout = JSON.stringify([{ number: 100 }, { number: 999 }]);
    const open = parseOpenNumbers(stdout, [100, 200]);
    // 100 is open and requested; 999 is open but not requested (ignored).
    assert.deepEqual([...open], [100]);
  });

  test("empty / non-JSON yields empty set", () => {
    assert.equal(parseOpenNumbers("", [1]).size, 0);
    assert.equal(parseOpenNumbers("nope", [1]).size, 0);
  });
});

// ---------------------------------------------------------------------------
// getReviewPickupSet — integration shape (exec stub)
// ---------------------------------------------------------------------------

describe("getReviewPickupSet — integration", () => {
  test("merges all three buckets; only stale-blocked issues survive", async () => {
    const exec = makeExecStub([
      // Digest issue for today carries one ref (#100).
      {
        match: 'in:title "Operator decision queue 2026-05-29"',
        stdout: JSON.stringify([
          {
            number: 900,
            title: "Operator decision queue 2026-05-29",
            body: "Decide: #100",
            url: "https://x/900",
            createdAt: "2026-05-29T06:00:00Z",
            labels: [],
          },
        ]),
      },
      // Yesterday's digest — none.
      { match: 'in:title "Operator decision queue 2026-05-28"', stdout: "[]" },
      // ready-for-human
      {
        match: "--label ready-for-human",
        stdout: JSON.stringify([
          { number: 200, title: "Decide tier", url: "https://x/200", createdAt: "2026-05-29T08:00:00Z", labels: [] },
        ]),
      },
      // blocked: #300 has an open blocker (#100), #400 has only a closed one.
      {
        match: "--label blocked",
        stdout: JSON.stringify([
          { number: 300, title: "still blocked", url: "https://x/300", body: "blocked by #100" },
          { number: 400, title: "stale blocked", url: "https://x/400", body: "depends on #500" },
        ]),
      },
      // open-blocker lookup over {100, 500}: only #100 is open.
      {
        match: "--state open --search 100 500",
        stdout: JSON.stringify([{ number: 100 }]),
      },
    ]);

    const items = await getReviewPickupSet({ now: NOW, execFileAsync: exec });
    const numbers = items.map((i) => i.number);
    // #100 (digest ref), #200 (ready-for-human), #400 (stale-blocked).
    // #300 is NOT here — its blocker #100 is still open.
    assert.deepEqual(numbers, [100, 200, 400]);
    assert.equal(items.find((i) => i.number === 400)?.source, "stale-blocked");
  });

  test("never throws — a failed sub-source contributes []", async () => {
    const exec = makeExecStub([
      // ready-for-human succeeds...
      {
        match: "--label ready-for-human",
        stdout: JSON.stringify([
          { number: 200, title: "rfh", url: "https://x/200", createdAt: "2026-05-29T08:00:00Z", labels: [] },
        ]),
      },
      // ...everything else throws (no route) — digest + blocked sub-sources fail.
    ]);
    const items = await getReviewPickupSet({ now: NOW, execFileAsync: exec });
    // The surviving ready-for-human source still ships.
    assert.deepEqual(items.map((i) => i.number), [200]);
  });

  test("empty board yields empty pickup set", async () => {
    const exec = makeExecStub([
      { match: "issue list", stdout: "[]" },
    ]);
    const items = await getReviewPickupSet({ now: NOW, execFileAsync: exec });
    assert.deepEqual(items, []);
  });
});
