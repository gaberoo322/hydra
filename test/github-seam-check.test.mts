/**
 * test/github-seam-check.test.mts — pin the GitHub CLI Adapter seam-check
 * grammar at the predicate level (no git scan, no process.exit), issue #899.
 *
 * The CI gate at scripts/ci/github-seam-check.ts forbids a raw
 * `node:child_process` import from any file outside `src/github/`, with a
 * carve-out for the non-gh/git spawners (exec-with-timeout.ts, autopilot/log.ts).
 * The index.ts carve-out was removed in issue #1960 once its startup git calls
 * moved behind gitExec. This mirrors the redis-seam-check / schema-seam-check ratchet.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesGithubSeam } = await import("../scripts/ci/github-seam-check.ts");

describe("github-seam-check: child_process import grammar", () => {
  test("flags a static `from 'node:child_process'` import", () => {
    assert.equal(
      fileViolatesGithubSeam(
        "src/aggregators/stuck-items.ts",
        `import { execFile } from "node:child_process";`,
      ),
      true,
    );
  });

  test("flags the bare `from 'child_process'` form", () => {
    assert.equal(
      fileViolatesGithubSeam("src/foo.ts", `import { spawn } from "child_process";`),
      true,
    );
  });

  test("flags a require(...) and a dynamic import(...) form", () => {
    assert.equal(
      fileViolatesGithubSeam("src/foo.ts", `const cp = require("node:child_process");`),
      true,
    );
    assert.equal(
      fileViolatesGithubSeam(
        "src/foo.ts",
        `const { execFile } = await import("node:child_process");`,
      ),
      true,
    );
  });

  test("does NOT flag a file that routes through the seam accessors", () => {
    assert.equal(
      fileViolatesGithubSeam(
        "src/aggregators/stuck-items.ts",
        `import { execFileViaSeam } from "../github/exec-file-compat.ts";`,
      ),
      false,
    );
    assert.equal(
      fileViolatesGithubSeam(
        "src/grounding.ts",
        `import { gitExec } from "./github/git.ts";`,
      ),
      false,
    );
  });
});

describe("github-seam-check: non-gh/git spawner carve-out", () => {
  test("exempts exec-with-timeout.ts (test-runner process-group primitive)", () => {
    assert.equal(
      fileViolatesGithubSeam(
        "src/exec-with-timeout.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
  });

  test("exempts autopilot/log.ts (spawns journalctl, not gh/git)", () => {
    assert.equal(
      fileViolatesGithubSeam(
        "src/autopilot/log.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
  });

  test("flags src/index.ts IF it re-introduces a child_process import (carve-out removed, issue #1960)", () => {
    // Issue #1960 routed index.ts's startup branch-cleanup git calls through the
    // gitExec seam and removed its NON_GITHUB_SPAWNERS carve-out, so index.ts is
    // an ordinary policed file again — re-importing child_process must be flagged.
    assert.equal(
      fileViolatesGithubSeam(
        "src/index.ts",
        `const { execFile: ef } = await import("node:child_process");`,
      ),
      true,
    );
  });

  test("exempts the Host-Probe Adapter family (src/host-probe/*) — sibling Seam, issue #939", () => {
    // src/host-probe/exec.ts owns the host-info spawn (df/free/systemctl) as a
    // separate Seam, NOT a gh/git caller. It is carved out of this scan and
    // policed by host-probe-seam-check instead.
    assert.equal(
      fileViolatesGithubSeam(
        "src/host-probe/exec.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
    assert.equal(
      fileViolatesGithubSeam(
        "src/host-probe/probe.ts",
        `import { runProbe } from "./exec.ts";`,
      ),
      false,
    );
  });

  test("still flags src/api/health.ts IF it re-introduces a child_process import (post-#939)", () => {
    // After #939 the real health.ts routes host probes through the Host-Probe
    // Adapter and no longer imports child_process, so it dropped off the
    // baseline (which closed to zero). It is NOT a carve-out, though: a future
    // raw child_process import here would be caught on its own merits.
    assert.equal(
      fileViolatesGithubSeam(
        "src/api/health.ts",
        `import { execFile } from "node:child_process";`,
      ),
      true,
    );
  });
});
