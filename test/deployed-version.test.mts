/**
 * Deployed-version probe tests (issue #3677, epic #3676 alpha).
 *
 * Covers src/health/deployed-version.ts — the 1:1 structural mirror of
 * src/health/deployed-sha.ts — with NO real git process:
 *  - cache-miss reads through the injected gitExec seam and returns the tag.
 *  - cache-hit inside the 60s TTL returns the cached tag WITHOUT a second call
 *    (the watchdog hot-path win the cache exists for).
 *  - advancing the injected clock past DEPLOYED_VERSION_TTL_MS forces a refetch.
 *  - a gitExec failure arm (untagged repo, git missing) degrades to null (never
 *    throws, never blocks /health).
 *  - resetDeployedVersionCache() drops the singleton so the next call re-reads.
 *
 * The clock (`now`) and the git seam (`gitExec`) are injected via the deps bag,
 * so the TTL cache-hit/cache-miss transitions are asserted deterministically
 * without spawning git or sleeping — mirroring test/health-deployed-sha.test.mts.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getDeployedVersion,
  resetDeployedVersionCache,
  DEPLOYED_VERSION_TTL_MS,
} from "../src/health/deployed-version.ts";
import type { gitExec as GitExecFn } from "../src/github/git.ts";

// A gitExec stub that records call count and returns a pinned tag on success.
function okGitExec(tag: string): { impl: typeof GitExecFn; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return { ok: true as const, data: { stdout: `${tag}\n`, stderr: "" } };
  }) as unknown as typeof GitExecFn;
  return { impl, calls: () => calls };
}

// A gitExec stub that always returns the failure arm (seam never throws) — the
// untagged-repo / git-missing case where `git describe --tags` exits non-zero.
function failGitExec(): { impl: typeof GitExecFn; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok: false as const,
      code: "gh-failed" as any,
      stderr: "fatal: No names found, cannot describe anything.",
    };
  }) as unknown as typeof GitExecFn;
  return { impl, calls: () => calls };
}

describe("getDeployedVersion — cache + fail-safe (issue #3677)", () => {
  // Reset the process-lifetime singleton per case so cases don't leak cache
  // state into each other (beforeEach, not before — per-case isolation).
  beforeEach(() => resetDeployedVersionCache());

  test("cache-miss reads through the git seam and returns the trimmed tag", async () => {
    const git = okGitExec("v1.2.3");
    const version = await getDeployedVersion({ now: () => 1000, gitExec: git.impl });
    assert.equal(version, "v1.2.3");
    assert.equal(git.calls(), 1, "expected exactly one git read on a cold cache");
  });

  test("cache-hit inside the TTL returns the cached tag without a second git call", async () => {
    const git = okGitExec("v1.2.3");
    let t = 1000;
    const now = () => t;
    const first = await getDeployedVersion({ now, gitExec: git.impl });
    assert.equal(first, "v1.2.3");
    // Advance the clock but stay inside the TTL window.
    t = 1000 + DEPLOYED_VERSION_TTL_MS - 1;
    const second = await getDeployedVersion({ now, gitExec: git.impl });
    assert.equal(second, "v1.2.3");
    assert.equal(git.calls(), 1, "expected the cached value, no second git read inside the TTL");
  });

  test("advancing past the TTL forces a refetch", async () => {
    const git = okGitExec("v1.2.3");
    let t = 1000;
    const now = () => t;
    await getDeployedVersion({ now, gitExec: git.impl });
    // Cross the TTL boundary exactly.
    t = 1000 + DEPLOYED_VERSION_TTL_MS;
    await getDeployedVersion({ now, gitExec: git.impl });
    assert.equal(git.calls(), 2, "expected a refetch once the TTL elapsed");
  });

  test("a gitExec failure (untagged repo) degrades to null (never throws)", async () => {
    const git = failGitExec();
    const version = await getDeployedVersion({ now: () => 1000, gitExec: git.impl });
    assert.equal(version, null, "a failure arm must resolve to null, not throw");
    assert.equal(git.calls(), 1);
  });

  test("resetDeployedVersionCache drops the singleton so the next call re-reads", async () => {
    const git = okGitExec("v1.2.3");
    const now = () => 1000; // same instant — a hit would be served if the cache survived
    await getDeployedVersion({ now, gitExec: git.impl });
    assert.equal(git.calls(), 1);
    resetDeployedVersionCache();
    await getDeployedVersion({ now, gitExec: git.impl });
    assert.equal(git.calls(), 2, "expected a fresh git read after resetDeployedVersionCache");
  });
});
