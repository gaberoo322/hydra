/**
 * Pure work-queue snapshot assembly tests (issue #3377).
 *
 * Exercises `buildWorkQueueSnapshot` directly with stubbed inputs — no Redis
 * fixture, no running Express server, no clock read (the `now` date is passed
 * in). Locks the on-wire Markdown grammar so a future edit that changes the
 * format is a failing test, not a silent regression.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildWorkQueueSnapshot } from "../src/api/queue-snapshot.ts";
import type { Backlog } from "../src/backlog/reads.ts";
import type { BacklogItem } from "../src/backlog/types.ts";

/** Minimal BacklogItem factory — only the fields the snapshot reads. */
function item(title: string, meta: BacklogItem["meta"] = {}): BacklogItem {
  return {
    id: title,
    title,
    lane: "backlog",
    movedAt: null,
    claimedAt: null,
    claimedBy: null,
    meta,
  };
}

/** An empty backlog with all six lanes present. */
function emptyBacklog(): Backlog {
  return {
    triage: [],
    backlog: [],
    queued: [],
    blocked: [],
    inProgress: [],
    done: [],
  };
}

describe("buildWorkQueueSnapshot", () => {
  it("renders the header, lane-counts table, and empty work queue", () => {
    const counts = { triage: 1, backlog: 2, queued: 3, inProgress: 4, blocked: 5, done: 6 };
    const md = buildWorkQueueSnapshot(counts, emptyBacklog(), [], "2026-07-16");

    assert.equal(
      md,
      [
        "# Work Snapshot (2026-07-16)",
        "",
        "## Lane Counts",
        "| Lane | Count |",
        "|------|-------|",
        "| Triage | 1 |",
        "| Backlog | 2 |",
        "| Queued | 3 |",
        "| In Progress | 4 |",
        "| Blocked | 5 |",
        "| Done | 6 |",
        "",
        "## Work Queue (0 items)",
        "(empty)",
        "",
      ].join("\n"),
    );
  });

  it("defaults missing lane counts to 0", () => {
    const md = buildWorkQueueSnapshot({}, emptyBacklog(), [], "2026-07-16");
    assert.match(md, /\| Triage \| 0 \|/);
    assert.match(md, /\| Done \| 0 \|/);
  });

  it("renders the work queue with a source tag, defaulting to operator", () => {
    const md = buildWorkQueueSnapshot(
      {},
      emptyBacklog(),
      [
        { reference: "issue-100", source: "research" },
        { reference: "issue-200" },
      ],
      "2026-07-16",
    );
    assert.match(md, /## Work Queue \(2 items\)/);
    assert.match(md, /- \[research\] issue-100/);
    assert.match(md, /- \[operator\] issue-200/);
    assert.doesNotMatch(md, /\(empty\)/);
  });

  it("renders the In Progress section with claimant and start date fallbacks", () => {
    const backlog = emptyBacklog();
    backlog.inProgress = [
      item("Wire the thing", { claimedBy: "pr-42", startedAt: "2026-07-15" }),
      item("Unclaimed task"),
    ];
    const md = buildWorkQueueSnapshot({}, backlog, [], "2026-07-16");
    assert.match(md, /## In Progress/);
    assert.match(md, /- Wire the thing \(pr-42, started 2026-07-15\)/);
    assert.match(md, /- Unclaimed task \(unknown, started \?\)/);
  });

  it("renders Triage, truncating to 10 with an overflow note", () => {
    const backlog = emptyBacklog();
    backlog.triage = Array.from({ length: 12 }, (_, i) =>
      item(`Triage item ${i}`, { source: "discover", addedAt: "2026-07-10" }),
    );
    const md = buildWorkQueueSnapshot({}, backlog, [], "2026-07-16");
    assert.match(md, /## Triage \(12 awaiting review\)/);
    assert.match(md, /- Triage item 0 \(discover, 2026-07-10\)/);
    assert.match(md, /- Triage item 9 \(discover, 2026-07-10\)/);
    assert.doesNotMatch(md, /Triage item 10 \(discover/);
    assert.match(md, /  \.\.\. and 2 more/);
  });

  it("renders Blocked items with a blockedReason fallback", () => {
    const backlog = emptyBacklog();
    backlog.blocked = [
      item("Stuck task", { blockedReason: "waiting on #999" }),
      item("Mystery block"),
    ];
    const md = buildWorkQueueSnapshot({}, backlog, [], "2026-07-16");
    assert.match(md, /## Blocked \(2\)/);
    assert.match(md, /- Stuck task — waiting on #999/);
    assert.match(md, /- Mystery block — no reason/);
  });

  it("omits optional sections when their lanes are empty", () => {
    const md = buildWorkQueueSnapshot({}, emptyBacklog(), [], "2026-07-16");
    assert.doesNotMatch(md, /## In Progress/);
    assert.doesNotMatch(md, /## Triage/);
    assert.doesNotMatch(md, /## Blocked/);
  });
});
