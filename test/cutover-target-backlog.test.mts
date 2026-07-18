/**
 * test/cutover-target-backlog.test.mts — pin the pure cutover POLICY of
 * scripts/cutover-target-backlog-to-github.ts (ADR-0031 #3438) without spawning
 * `gh` or touching Redis.
 *
 * The `gh` create/dedup I/O is integration-territory; here we lock the
 * agent-facing contract that carries the ADR-0031 invariants:
 *   - only the three ACTIONABLE lanes (backlog/queued/blocked) are migrated;
 *     inProgress/done/triage are NEVER selected (drain-and-fresh, Decision 6);
 *   - lane→label mapping (queued/backlog→ready-for-agent, blocked→blocked) with
 *     the money-critical flag preserved (Decision 4/5);
 *   - the throttle math keeps creations under the <500/hr ceiling (#3427);
 *   - dry-run is the default (parseArgs), --apply opts in.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Backlog } from "../src/backlog/reads.ts";
import type { BacklogItem } from "../src/backlog/types.ts";

const {
  ACTIONABLE_LANES,
  DEFAULT_RATE_PER_HOUR,
  selectActionableItems,
  itemToLabels,
  dedupTitle,
  renderIssueBody,
  throttleDelayMs,
  parseArgs,
} = await import("../scripts/cutover-target-backlog-to-github.ts");

function item(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: overrides.id ?? "item-1",
    title: overrides.title ?? "Untitled",
    lane: overrides.lane ?? "backlog",
    movedAt: null,
    claimedAt: null,
    claimedBy: null,
    ...overrides,
  };
}

function backlog(overrides: Partial<Backlog> = {}): Backlog {
  return {
    triage: [],
    backlog: [],
    queued: [],
    blocked: [],
    inProgress: [],
    done: [],
    ...overrides,
  } as Backlog;
}

describe("cutover: selectActionableItems", () => {
  test("migrates ONLY backlog/queued/blocked; never triage/inProgress/done", () => {
    const b = backlog({
      triage: [item({ id: "t1", title: "triage-item" })],
      backlog: [item({ id: "b1", title: "backlog-item" })],
      queued: [item({ id: "q1", title: "queued-item" })],
      blocked: [item({ id: "k1", title: "blocked-item" })],
      inProgress: [item({ id: "p1", title: "inprogress-item" })],
      done: [item({ id: "d1", title: "done-item" })],
    });
    const selected = selectActionableItems(b);
    const titles = selected.map(s => s.item.title).sort();
    assert.deepEqual(titles, ["backlog-item", "blocked-item", "queued-item"]);
    // Explicitly assert the excluded lanes contributed nothing.
    for (const s of selected) {
      assert.ok(["backlog", "queued", "blocked"].includes(s.lane));
    }
  });

  test("ACTIONABLE_LANES is exactly the three drain-and-fresh lanes", () => {
    assert.deepEqual([...ACTIONABLE_LANES].sort(), ["backlog", "blocked", "queued"]);
  });

  test("empty backlog yields an empty plan", () => {
    assert.deepEqual(selectActionableItems(backlog()), []);
  });

  test("orders queued before backlog before blocked, priority within lane", () => {
    const b = backlog({
      blocked: [item({ id: "k1", title: "blk", priority: 1 })],
      backlog: [
        item({ id: "b-low", title: "bk-low", priority: 0 }),
        item({ id: "b-hi", title: "bk-hi", priority: 1 }),
      ],
      queued: [item({ id: "q1", title: "qd", priority: 2 })],
    });
    const order = selectActionableItems(b).map(s => s.item.title);
    // queued first, then backlog (priority 1 before 0/unset), then blocked.
    assert.deepEqual(order, ["qd", "bk-hi", "bk-low", "blk"]);
  });

  test("tolerates a missing lane array (defensive ?? [])", () => {
    const partial = { backlog: [item({ title: "only" })] } as unknown as Backlog;
    const selected = selectActionableItems(partial);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].item.title, "only");
  });
});

describe("cutover: itemToLabels", () => {
  test("queued and backlog map to ready-for-agent", () => {
    assert.deepEqual(itemToLabels(item(), "queued"), ["ready-for-agent"]);
    assert.deepEqual(itemToLabels(item(), "backlog"), ["ready-for-agent"]);
  });

  test("blocked maps to blocked", () => {
    assert.deepEqual(itemToLabels(item(), "blocked"), ["blocked"]);
  });

  test("preserves a carried money-critical flag onto the issue", () => {
    const labels = itemToLabels(item({ labels: ["money-critical"] }), "queued");
    assert.ok(labels.includes("ready-for-agent"));
    assert.ok(labels.includes("money-critical"));
  });

  test("preserves surviving reframe / wire-or-retire flags", () => {
    const labels = itemToLabels(
      item({ labels: ["reframe", "wire-or-retire", "some-noise"] }),
      "blocked",
    );
    assert.ok(labels.includes("blocked"));
    assert.ok(labels.includes("reframe"));
    assert.ok(labels.includes("wire-or-retire"));
    // A non-vocabulary label is NOT carried across.
    assert.ok(!labels.includes("some-noise"));
  });

  test("does not double-add a lane label already carried", () => {
    const labels = itemToLabels(item({ labels: ["ready-for-agent"] }), "queued");
    assert.deepEqual(labels, ["ready-for-agent"]);
  });
});

describe("cutover: dedupTitle", () => {
  test("trims and collapses whitespace so a lexical dup is not defeated", () => {
    assert.equal(dedupTitle(item({ title: "  hello   world " })), "hello world");
  });

  test("empty/missing title yields empty string", () => {
    assert.equal(dedupTitle(item({ title: "" })), "");
  });
});

describe("cutover: renderIssueBody", () => {
  test("preserves priority and records the source lane + Redis id", () => {
    const body = renderIssueBody(
      item({ id: "item-42", priority: 1, description: "do the thing" }),
      "queued",
    );
    assert.match(body, /do the thing/);
    assert.match(body, /Source lane: `queued`/);
    assert.match(body, /Priority: 1/);
    assert.match(body, /Redis id: `item-42`/);
    assert.match(body, /#3438/);
  });

  test("blocked item surfaces its blockedReason", () => {
    const body = renderIssueBody(
      item({ meta: { blockedReason: "waiting on #99" } }),
      "blocked",
    );
    assert.match(body, /Blocked reason: waiting on #99/);
  });

  test("missing description falls back to a placeholder", () => {
    const body = renderIssueBody(item({ description: undefined }), "backlog");
    assert.match(body, /no description/);
  });
});

describe("cutover: throttleDelayMs (the <500/hr safety invariant, #3427)", () => {
  test("default 500/hr paces at ~7.2s between creates", () => {
    const d = throttleDelayMs(DEFAULT_RATE_PER_HOUR);
    assert.equal(d, Math.ceil(3_600_000 / 500)); // 7200ms
    // Enforce the ceiling: creations/hr at this spacing must not exceed 500.
    assert.ok(3_600_000 / d <= 500);
  });

  test("lower rate paces slower (more ms between creates)", () => {
    assert.ok(throttleDelayMs(100) > throttleDelayMs(500));
    assert.ok(3_600_000 / throttleDelayMs(100) <= 100);
  });

  test("<= 0 or non-finite disables the throttle", () => {
    assert.equal(throttleDelayMs(0), 0);
    assert.equal(throttleDelayMs(-5), 0);
    assert.equal(throttleDelayMs(NaN), 0);
  });
});

describe("cutover: parseArgs (dry-run by default)", () => {
  test("no flags => dry-run, default rate, no repo/limit override", () => {
    const a = parseArgs([]);
    assert.equal(a.apply, false);
    assert.equal(a.ratePerHour, DEFAULT_RATE_PER_HOUR);
    assert.equal(a.repo, null);
    assert.equal(a.limit, null);
  });

  test("--apply opts in to writes", () => {
    assert.equal(parseArgs(["--apply"]).apply, true);
  });

  test("--rate overrides the ceiling and floors at 1", () => {
    assert.equal(parseArgs(["--rate", "200"]).ratePerHour, 200);
    // An out-of-range rate falls back to the safe default, never 0/negative.
    assert.equal(parseArgs(["--rate", "0"]).ratePerHour, DEFAULT_RATE_PER_HOUR);
    assert.equal(parseArgs(["--rate", "-9"]).ratePerHour, DEFAULT_RATE_PER_HOUR);
    assert.equal(parseArgs(["--rate", "notnum"]).ratePerHour, DEFAULT_RATE_PER_HOUR);
  });

  test("--repo and --limit are read", () => {
    const a = parseArgs(["--repo", "acme/widget", "--limit", "5"]);
    assert.equal(a.repo, "acme/widget");
    assert.equal(a.limit, 5);
  });

  test("a negative --limit is ignored (treated as unset)", () => {
    assert.equal(parseArgs(["--limit", "-3"]).limit, null);
  });
});
