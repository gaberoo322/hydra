/**
 * Regression tests for src/backlog.mjs — the Kanban-file state machine.
 *
 * Uses a temporary directory as the vault so tests don't touch the real
 * obsidian-vault backlog.md. HYDRA_VAULT_PATH must be set BEFORE the
 * dynamic import of backlog.mjs because backlog.mjs captures BACKLOG_FILE
 * at module load time.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempVault;
let backlog;

describe("backlog state machine", () => {
  before(async () => {
    // Create a temp vault and redirect HYDRA_VAULT_PATH before importing
    tempVault = await mkdtemp(join(tmpdir(), "hydra-backlog-test-"));
    await mkdir(join(tempVault, "hydra"), { recursive: true });
    process.env.HYDRA_VAULT_PATH = tempVault;
    backlog = await import("../src/backlog.mjs");
  });

  beforeEach(async () => {
    // Reset to empty state between tests
    await backlog.saveBacklog({
      backlog: [],
      queued: [],
      inProgress: [],
      done: [],
    });
  });

  after(async () => {
    if (tempVault) {
      await rm(tempVault, { recursive: true, force: true });
    }
  });

  test("addToBacklog → getBacklogCounts round-trip", async () => {
    const result = await backlog.addToBacklog({
      title: "Test item 1",
      category: "reliability",
    });
    assert.equal(result.added, true);

    const counts = await backlog.getBacklogCounts();
    assert.equal(counts.backlog, 1);
    assert.equal(counts.queued, 0);
    assert.equal(counts.total, 1);
  });

  test("addToBacklog dedups items with the same title", async () => {
    const first = await backlog.addToBacklog({
      title: "Duplicate test",
      category: "test",
    });
    const second = await backlog.addToBacklog({
      title: "Duplicate test",
      category: "test",
    });
    assert.equal(first.added, true);
    assert.equal(second.added, false);
    assert.equal(second.reason, "duplicate");
  });

  test("promoteToQueued moves items backlog → queued", async () => {
    await backlog.addToBacklog({ title: "Promote me A", category: "test" });
    await backlog.addToBacklog({ title: "Promote me B", category: "test" });

    const promoted = await backlog.promoteToQueued(2);
    assert.equal(promoted.length, 2);

    const counts = await backlog.getBacklogCounts();
    assert.equal(counts.backlog, 0);
    assert.equal(counts.queued, 2);
  });

  test("promoteToQueued with count > backlog length moves only what exists", async () => {
    await backlog.addToBacklog({ title: "Only one", category: "test" });
    const promoted = await backlog.promoteToQueued(5);
    assert.equal(promoted.length, 1);
  });

  test("regression (2026-04-08): moveToInProgress requires EXACT title match", async () => {
    // This is the stale-Kanban bug. control-loop.mjs was calling
    // moveToInProgress(task.title) where task.title is the planner's
    // rephrased title, not the anchor reference that matches the Kanban
    // row. backlog.mjs does exact-match lookup and silently returns
    // false on mismatch, so Kanban rows got stranded in Queued.
    //
    // The fix (commit 4a4d963) changed control-loop.mjs to pass
    // anchor.reference instead. This test locks in the exact-match
    // behavior so nobody accidentally "fixes" it by making lookup
    // fuzzy — that would break other assumptions.
    await backlog.addToBacklog({
      title: "Exact title required",
      category: "test",
    });
    await backlog.promoteToQueued(1);

    // Mismatched title → no-op, returns false
    const mismatchResult = await backlog.moveToInProgress(
      "Rephrased exact title required",
    );
    assert.equal(
      mismatchResult,
      false,
      "mismatched title must silently return false",
    );

    // Exact title → succeeds, returns true
    const exactResult = await backlog.moveToInProgress(
      "Exact title required",
    );
    assert.equal(exactResult, true, "exact title must succeed");

    const counts = await backlog.getBacklogCounts();
    assert.equal(counts.queued, 0);
    assert.equal(counts.inProgress, 1);
  });

  test("moveToInProgress can also pull directly from Backlog lane", async () => {
    // Bypass path for direct backlog → in-progress without queuing
    await backlog.addToBacklog({
      title: "Direct from backlog",
      category: "test",
    });
    const result = await backlog.moveToInProgress("Direct from backlog");
    assert.equal(result, true);
    const counts = await backlog.getBacklogCounts();
    assert.equal(counts.backlog, 0);
    assert.equal(counts.inProgress, 1);
  });

  test("moveToDone only moves items that are in-progress", async () => {
    await backlog.addToBacklog({
      title: "Lifecycle item",
      category: "test",
    });
    // Not in in-progress yet — should return false
    const tooEarly = await backlog.moveToDone("Lifecycle item", "merged");
    assert.equal(tooEarly, false);

    // Go through the full lifecycle
    await backlog.promoteToQueued(1);
    await backlog.moveToInProgress("Lifecycle item");
    const done = await backlog.moveToDone("Lifecycle item", "merged");
    assert.equal(done, true);

    const counts = await backlog.getBacklogCounts();
    assert.equal(counts.inProgress, 0);
    assert.equal(counts.done, 1);
  });

  test("returnToBacklog moves in-progress items back with reason", async () => {
    await backlog.addToBacklog({ title: "Will fail", category: "test" });
    await backlog.promoteToQueued(1);
    await backlog.moveToInProgress("Will fail");
    const result = await backlog.returnToBacklog(
      "Will fail",
      "rolled-back",
    );
    assert.equal(result, true);

    const counts = await backlog.getBacklogCounts();
    assert.equal(counts.backlog, 1);
    assert.equal(counts.inProgress, 0);
  });

  test("full lifecycle: add → promote → inProgress → done", async () => {
    const title = "End-to-end item";
    await backlog.addToBacklog({ title, category: "e2e" });

    let counts = await backlog.getBacklogCounts();
    assert.equal(counts.backlog, 1);

    await backlog.promoteToQueued(1);
    counts = await backlog.getBacklogCounts();
    assert.equal(counts.queued, 1);

    await backlog.moveToInProgress(title);
    counts = await backlog.getBacklogCounts();
    assert.equal(counts.inProgress, 1);

    await backlog.moveToDone(title, "merged");
    counts = await backlog.getBacklogCounts();
    assert.equal(counts.done, 1);
    assert.equal(counts.backlog, 0);
    assert.equal(counts.queued, 0);
    assert.equal(counts.inProgress, 0);
  });
});
