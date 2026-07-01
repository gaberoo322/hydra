/**
 * Deployed-SHA probe tests (issue #2605 — extracted from src/api/health.ts).
 *
 * Covers the extracted src/health/deployed-sha.ts leaf with NO real git process:
 *  - cache-miss reads through the injected gitExec seam and returns the SHA.
 *  - cache-hit inside the 60s TTL returns the cached SHA WITHOUT a second git call
 *    (the watchdog hot-path win the cache exists for).
 *  - advancing the injected clock past DEPLOYED_SHA_TTL_MS forces a refetch.
 *  - a gitExec failure arm degrades to null (never throws, never blocks /health).
 *  - resetDeployedShaCache() drops the singleton so the next call re-reads.
 *
 * The clock (`now`) and the git seam (`gitExec`) are injected via the deps bag,
 * so the TTL cache-hit/cache-miss transitions are asserted deterministically
 * without spawning git or sleeping — mirroring the fan-out.ts CollectProbeDeps
 * and wol.ts WakeGate injectable-clock conventions.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getDeployedSha,
  resetDeployedShaCache,
  DEPLOYED_SHA_TTL_MS,
} from "../src/health/deployed-sha.ts";
import type { gitExec as GitExecFn } from "../src/github/git.ts";

// A gitExec stub that records call count and returns a pinned SHA on success.
function okGitExec(sha: string): { impl: typeof GitExecFn; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return { ok: true as const, data: { stdout: `${sha}\n`, stderr: "" } };
  }) as unknown as typeof GitExecFn;
  return { impl, calls: () => calls };
}

// A gitExec stub that always returns the failure arm (seam never throws).
function failGitExec(): { impl: typeof GitExecFn; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return { ok: false as const, code: "gh-nonzero-exit" as any, stderr: "not a git repository" };
  }) as unknown as typeof GitExecFn;
  return { impl, calls: () => calls };
}

describe("getDeployedSha — cache + fail-safe (issue #2605)", () => {
  // Reset the process-lifetime singleton per case so cases don't leak cache
  // state into each other (beforeEach, not before — per-case isolation).
  beforeEach(() => resetDeployedShaCache());

  test("cache-miss reads through the git seam and returns the trimmed SHA", async () => {
    const git = okGitExec("abc123");
    const sha = await getDeployedSha({ now: () => 1000, gitExec: git.impl });
    assert.equal(sha, "abc123");
    assert.equal(git.calls(), 1, "expected exactly one git read on a cold cache");
  });

  test("cache-hit inside the TTL returns the cached SHA without a second git call", async () => {
    const git = okGitExec("abc123");
    let t = 1000;
    const now = () => t;
    const first = await getDeployedSha({ now, gitExec: git.impl });
    assert.equal(first, "abc123");
    // Advance the clock but stay inside the TTL window.
    t = 1000 + DEPLOYED_SHA_TTL_MS - 1;
    const second = await getDeployedSha({ now, gitExec: git.impl });
    assert.equal(second, "abc123");
    assert.equal(git.calls(), 1, "expected the cached value, no second git read inside the TTL");
  });

  test("advancing past the TTL forces a refetch", async () => {
    const git = okGitExec("abc123");
    let t = 1000;
    const now = () => t;
    await getDeployedSha({ now, gitExec: git.impl });
    // Cross the TTL boundary exactly.
    t = 1000 + DEPLOYED_SHA_TTL_MS;
    await getDeployedSha({ now, gitExec: git.impl });
    assert.equal(git.calls(), 2, "expected a refetch once the TTL elapsed");
  });

  test("a gitExec failure degrades to null (never throws)", async () => {
    const git = failGitExec();
    const sha = await getDeployedSha({ now: () => 1000, gitExec: git.impl });
    assert.equal(sha, null, "a failure arm must resolve to null, not throw");
    assert.equal(git.calls(), 1);
  });

  test("resetDeployedShaCache drops the singleton so the next call re-reads", async () => {
    const git = okGitExec("abc123");
    const now = () => 1000; // same instant — a hit would be served if the cache survived
    await getDeployedSha({ now, gitExec: git.impl });
    assert.equal(git.calls(), 1);
    resetDeployedShaCache();
    await getDeployedSha({ now, gitExec: git.impl });
    assert.equal(git.calls(), 2, "expected a fresh git read after resetDeployedShaCache");
  });
});
