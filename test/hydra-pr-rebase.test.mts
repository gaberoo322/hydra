/**
 * Regression tests for the hydra-pr-rebase skill's classifier (issue #407).
 *
 * Before #407, a PR could sit at `mergeStateStatus: BEHIND` for the entire
 * autopilot quiet period after a sibling merge. PR #404 (2026-05-14)
 * demonstrated the failure mode — 30+ minutes of merge-queue stalling
 * because no automation called `update-branch`.
 *
 * The new skill walks open PRs and routes each into one of three actions:
 *
 *   rebase  → call gh api -X PUT .../update-branch
 *   surface → label `ready-for-human`, list conflicts
 *   skip    → no-op (idempotent on repeat sweeps)
 *
 * These tests guard the classifier *and* the idempotency contract — re-running
 * the skill on an already-handled PR must produce `skip` every time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPR,
  classifyBatch,
  shouldPostRebaseComment,
  renderReport,
  READY_FOR_HUMAN_LABEL,
  NO_REBASE_LABEL,
  type PullRequestRow,
} from "../scripts/ci/pr-rebase.ts";

function row(
  number: number,
  mergeStateStatus: PullRequestRow["mergeStateStatus"],
  labels: string[] = [],
  headRefName = `pr-${number}-branch`,
): PullRequestRow {
  return {
    number,
    mergeStateStatus,
    headRefName,
    labels: labels.map((name) => ({ name })),
  };
}

describe("classifyPR — BEHIND path (issue #407 AC)", () => {
  test("BEHIND with no opt-out label → rebase", () => {
    const r = classifyPR(row(401, "BEHIND"));
    assert.equal(r.action, "rebase");
    assert.match(r.reason, /BEHIND/);
  });

  test("BEHIND with no-rebase label → skip (operator opt-out)", () => {
    const r = classifyPR(row(401, "BEHIND", [NO_REBASE_LABEL]));
    assert.equal(r.action, "skip");
    assert.match(r.reason, /no-rebase/);
  });

  test("BEHIND with unrelated labels → still rebase", () => {
    const r = classifyPR(row(401, "BEHIND", ["enhancement", "in-progress"]));
    assert.equal(r.action, "rebase");
  });
});

describe("classifyPR — DIRTY path (issue #407 AC)", () => {
  test("DIRTY with no ready-for-human label → surface", () => {
    const r = classifyPR(row(408, "DIRTY"));
    assert.equal(r.action, "surface");
    assert.match(r.reason, /DIRTY/);
  });

  test("DIRTY with ready-for-human label → skip (already notified)", () => {
    const r = classifyPR(row(408, "DIRTY", [READY_FOR_HUMAN_LABEL]));
    assert.equal(r.action, "skip");
    assert.match(r.reason, /ready-for-human/);
  });

  test("DIRTY + ready-for-human + other labels → skip", () => {
    const r = classifyPR(row(408, "DIRTY", ["bug", READY_FOR_HUMAN_LABEL, "blocked"]));
    assert.equal(r.action, "skip");
  });
});

describe("classifyPR — skip all other states", () => {
  for (const state of ["CLEAN", "BLOCKED", "HAS_HOOKS", "UNSTABLE", "UNKNOWN"] as const) {
    test(`mergeStateStatus=${state} → skip`, () => {
      const r = classifyPR(row(500, state));
      assert.equal(r.action, "skip");
      assert.match(r.reason, new RegExp(state));
    });
  }
});

describe("classifyBatch — buckets preserve order and partition correctly", () => {
  test("mixed batch produces three independent buckets", () => {
    const rows: PullRequestRow[] = [
      row(401, "BEHIND"),
      row(402, "CLEAN"),
      row(403, "DIRTY"),
      row(404, "BEHIND", [NO_REBASE_LABEL]),
      row(405, "DIRTY", [READY_FOR_HUMAN_LABEL]),
      row(406, "UNKNOWN"),
      row(407, "BEHIND"),
    ];
    const b = classifyBatch(rows);
    assert.deepEqual(
      b.rebase.map((r) => r.number),
      [401, 407],
    );
    assert.deepEqual(
      b.surface.map((r) => r.number),
      [403],
    );
    assert.deepEqual(
      b.skip.map((s) => s.row.number),
      [402, 404, 405, 406],
    );
  });

  test("empty input produces empty buckets, not crashes", () => {
    const b = classifyBatch([]);
    assert.deepEqual(b.rebase, []);
    assert.deepEqual(b.surface, []);
    assert.deepEqual(b.skip, []);
  });
});

describe("idempotency — re-running the skill on a handled PR is a no-op (issue #407 AC)", () => {
  test("two consecutive sweeps on a DIRTY PR: first surfaces, second skips", () => {
    // Sweep 1: PR is DIRTY with no label. Classifier says surface.
    const pre = row(408, "DIRTY");
    assert.equal(classifyPR(pre).action, "surface");

    // After the skill runs, the PR has gained the ready-for-human label.
    const post = row(408, "DIRTY", [READY_FOR_HUMAN_LABEL]);
    // Sweep 2: same PR, now labeled. Classifier says skip.
    assert.equal(classifyPR(post).action, "skip");
  });

  test("two consecutive sweeps on a BEHIND PR: first rebases, second skips after state transition", () => {
    // Sweep 1: PR is BEHIND. Classifier says rebase.
    const pre = row(401, "BEHIND");
    assert.equal(classifyPR(pre).action, "rebase");

    // After update-branch succeeds, GitHub recomputes mergeStateStatus.
    // It will be one of CLEAN/UNSTABLE/HAS_HOOKS — *not* BEHIND. The classifier
    // emits skip for every one of those, which is the idempotency guarantee.
    for (const newState of ["CLEAN", "UNSTABLE", "HAS_HOOKS"] as const) {
      const post = row(401, newState);
      assert.equal(
        classifyPR(post).action,
        "skip",
        `post-rebase state ${newState} should be skip`,
      );
    }
  });

  test("shouldPostRebaseComment skips when an automated 'rebased onto master' comment already exists", () => {
    const existing =
      "> *Automated by `/hydra-pr-rebase`*\n\nRebased onto master via `update-branch`.";
    assert.equal(shouldPostRebaseComment(existing), false);
  });

  test("shouldPostRebaseComment posts when no prior automated comment", () => {
    assert.equal(shouldPostRebaseComment(""), true);
    assert.equal(shouldPostRebaseComment(null), true);
    assert.equal(shouldPostRebaseComment(undefined), true);
  });

  test("shouldPostRebaseComment posts when the prior automated comment was a different action", () => {
    // e.g. a `surface` comment was the most recent automated comment.
    const surfaceComment =
      "> *Automated by `/hydra-pr-rebase`*\n\nThis PR has merge conflicts...";
    assert.equal(shouldPostRebaseComment(surfaceComment), true);
  });
});

describe("renderReport — deterministic single-pass summary", () => {
  test("renders all three buckets with counts and per-row detail", () => {
    const rows: PullRequestRow[] = [
      row(401, "BEHIND"),
      row(403, "DIRTY"),
      row(405, "DIRTY", [READY_FOR_HUMAN_LABEL]),
      row(402, "CLEAN"),
    ];
    const out = renderReport(classifyBatch(rows), "2026-05-14");
    assert.match(out, /## Hydra PR Rebase — 2026-05-14/);
    assert.match(out, /Scanned: 4 open PRs/);
    assert.match(out, /Rebased \(BEHIND → updated\)[\s\S]*#401/);
    assert.match(out, /Surfaced \(DIRTY → operator\)[\s\S]*#403/);
    assert.match(out, /Skipped[\s\S]*#405[\s\S]*ready-for-human/);
    assert.match(out, /Skipped[\s\S]*#402[\s\S]*CLEAN/);
  });

  test("empty input renders without crashing", () => {
    const out = renderReport(classifyBatch([]), "2026-05-14");
    assert.match(out, /Scanned: 0 open PRs/);
    assert.match(out, /_none_/);
  });
});
