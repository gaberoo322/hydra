import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isLivePid } from "../src/process-probe.ts";

// ---------------------------------------------------------------------------
// isLivePid — the consolidated host-liveness predicate (issue #2816),
// extracted into its focused `src/process-probe.ts` leaf (issue #3503).
//
// Pins the CONTRACT: false (dead → reclaimable) ONLY for a finite, positive pid
// whose process.kill(pid,0) throws a non-EPERM error (ESRCH). EVERY other input
// — a live pid, EPERM, OR any invalid pid (!Number.isFinite || <=0) — is TRUE
// (conservative-live). The invalid-pid → live rail is the latent-bug fix: the
// two former unguarded copies returned false on a non-finite pid, which the
// worktree-destroying caller would have read as "reclaim".
// ---------------------------------------------------------------------------
describe("process-probe: isLivePid consolidated contract", () => {
  test("a live pid — this test process — is live", () => {
    assert.equal(isLivePid(process.pid), true);
  });

  test("a finite, positive, dead pid classifies dead (reclaimable)", () => {
    // 2^30 is comfortably above any real pid on this host; kill(pid,0) throws
    // ESRCH (no such process), the ONLY path that returns false.
    assert.equal(isLivePid(1 << 30), false);
  });

  test("a non-finite pid (NaN) is conservative-live — the #2816 latent-bug fix", () => {
    // The former unguarded copies returned FALSE here (would reclaim); the
    // consolidated predicate returns TRUE (never reclaim on garbage input).
    assert.equal(isLivePid(Number.NaN), true);
    assert.equal(isLivePid(Number("")), true); // Number('') === NaN
    assert.equal(isLivePid(Number.POSITIVE_INFINITY), true);
  });

  test("pid 0 and pid -1 are conservative-live (invalid → live)", () => {
    assert.equal(isLivePid(0), true);
    assert.equal(isLivePid(-1), true);
  });
});
