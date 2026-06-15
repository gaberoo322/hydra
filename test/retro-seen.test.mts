/**
 * test/retro-seen.test.mts — the cross-run seen-list + recurrence ledger seam
 * (issue #919, epic #917).
 *
 * Split out of the former `test/retro-artifact.test.mts` (issue #1914) when the
 * combined `src/redis/retro.ts` was split into this slice-A module
 * (`retro-seen.ts`) and a slice-B artifacts module. This file imports from
 * exactly one source module.
 *
 * ---------------------------------------------------------------------------
 * Slice-A seen-list + recurrence seam — existence/signature guard (issue #1041)
 * ---------------------------------------------------------------------------
 *
 * #1007 deleted bumpRetroRecurrence / getRetroSeen / getRetroRecurrence /
 * recordRetroSeen as knip-dead — but their only caller is the live
 * /hydra-retro SKILL.md (markdown, invisible to static analysis), so the
 * deletion broke retro_orch at runtime (getRetroSeen threw). These accessors
 * use the global Redis singleton (no DI seam), so this guard does not exercise
 * a live round-trip; it asserts the four symbols still exist as callable
 * accessors with their original signatures, which is the exact regression
 * #1041 protects against AND the static-analysis-visible reference that stops
 * knip from re-flagging and re-deleting them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  // Slice-A seen-list + recurrence accessors. Imported here as the live
  // /hydra-retro SKILL.md caller is markdown invisible to knip — this test
  // is the static-analysis-visible reference that keeps them from being
  // re-flagged dead and re-deleted (issue #1041; the #1007 regression).
  bumpRetroRecurrence,
  getRetroSeen,
  getRetroRecurrence,
  recordRetroSeen,
  type RetroSeenEntry,
} from "../src/redis/retro-seen.ts";

describe("redis/retro-seen — slice-A seen/recurrence accessors restored (#1041)", () => {
  test("the four accessors are exported as functions", () => {
    assert.equal(typeof getRetroSeen, "function");
    assert.equal(typeof recordRetroSeen, "function");
    assert.equal(typeof getRetroRecurrence, "function");
    assert.equal(typeof bumpRetroRecurrence, "function");
  });

  test("accessors keep their original arity (the live SKILL.md call shape)", () => {
    // getRetroSeen() / getRetroRecurrence() — no args (SKILL.md steps 6).
    assert.equal(getRetroSeen.length, 0);
    assert.equal(getRetroRecurrence.length, 0);
    // recordRetroSeen(entry) — one required arg (SKILL.md step 8).
    assert.equal(recordRetroSeen.length, 1);
    // bumpRetroRecurrence(cue, delta = 1) — one required arg, `delta` defaulted
    // so .length counts only the leading required params (SKILL.md step 6).
    assert.equal(bumpRetroRecurrence.length, 1);
  });

  test("RetroSeenEntry shape stays usable by recordRetroSeen callers", () => {
    // Type-level guard: a value the live SKILL.md builds must still satisfy the
    // restored RetroSeenEntry type. A compile error here means the type drifted.
    const entry: RetroSeenEntry = {
      cue: "some-recurring-gotcha",
      decision: "issue",
      runId: "c59c13fc-e5b4-42ad-834d-c62c7ee23b74",
      ref: "1041",
      at: new Date(0).toISOString(),
    };
    assert.equal(entry.decision, "issue");
    assert.equal(entry.ref, "1041");
  });
});
