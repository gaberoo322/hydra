/**
 * test/work-projections.test.mts — the /work queue's GLM badge ruling
 * (issue #4692, ADR-0040 Decision 4 row 13).
 *
 * The badge on a WorkQueueRow is no longer a raw `glm-eligible` label read:
 * it consumes the ONE lane predicate (`glmLane`, src/glm/eligibility.ts) with
 * the partition liveness the /work-queue route already resolves for
 * `resolveOpenBlockers` — the same "one definition, two consumers, zero new
 * mirrors" shape `src/autopilot/board-state.ts` set when it delegated its
 * count predicate to `glmLane` (#4684). A withheld (`glm-withhold`) or
 * A/B-control (`glm-ab-control`) issue is Claude-pinned, and a dead partition
 * owns no rows at all (fail-open, #3754), so none of them shows the badge.
 *
 * The remaining /work projections (lane derivation, ordering, promote gate,
 * relabel plan, hitl-grill lane) stay pinned by test/work-page.test.mts —
 * this file owns only the badge-behaviour change #4692 ships.
 *
 * Lifecycle: top-level describes with their OWN before/after (per the
 * shared-Redis-teardown authoring rule); these tests are pure and need no
 * lifecycle hooks at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toWorkQueueRow } from "../src/autopilot/work-projections.ts";
import type { IssueRow } from "../src/github/issues.ts";

/** A minimal OPEN IssueRow carrying an operator lane + GLM provenance. */
function issue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    number: 1,
    title: "Example issue",
    url: "https://github.com/gaberoo322/hydra/issues/1",
    createdAt: "2026-08-01T00:00:00Z",
    labels: ["ready-for-agent"],
    body: "## Files in scope\n\n- `src/a.ts`\n- `test/a.test.mts`",
    state: "OPEN",
    updatedAt: "2026-08-10T00:00:00Z",
    ...overrides,
  };
}

describe("toWorkQueueRow — the GLM badge consumes glmLane (issue #4692)", () => {
  test("plain glm-eligible + ready-for-agent, partition live → badge true", () => {
    const row = toWorkQueueRow(
      issue({ number: 7, labels: ["ready-for-agent", "glm-eligible"] }),
      new Set<number>(),
      true,
    );
    assert.ok(row);
    assert.equal(row.glmEligible, true);
  });

  test("glm-eligible + glm-withhold (handed back to Claude) → badge false even with the partition live", () => {
    const row = toWorkQueueRow(
      issue({
        number: 8,
        labels: ["ready-for-agent", "glm-eligible", "glm-withhold"],
      }),
      new Set<number>(),
      true,
    );
    assert.ok(row);
    assert.equal(row.glmEligible, false);
  });

  test("glm-ab-control (A/B control arm) → badge false", () => {
    const row = toWorkQueueRow(
      issue({ number: 9, labels: ["ready-for-agent", "glm-ab-control"] }),
      new Set<number>(),
      true,
    );
    assert.ok(row);
    assert.equal(row.glmEligible, false);
  });

  test("glm-eligible + partition dead → badge false (liveness is threaded; a dead partition owns no rows, #3754)", () => {
    const row = toWorkQueueRow(
      issue({ number: 10, labels: ["ready-for-agent", "glm-eligible"] }),
      new Set<number>(),
      false,
    );
    assert.ok(row);
    assert.equal(row.glmEligible, false);
  });

  test("glm-eligible without ready-for-agent → badge false (not a dispatch candidate, so not GLM-owned)", () => {
    const row = toWorkQueueRow(
      issue({ number: 11, labels: ["needs-triage", "glm-eligible"] }),
      new Set<number>(),
      true,
    );
    assert.ok(row); // needs-triage IS an operator lane: the row is queued…
    assert.equal(row.lane, "needs-triage");
    assert.equal(row.glmEligible, false); // …but never badged GLM
  });
});
