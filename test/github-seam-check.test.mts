/**
 * test/github-seam-check.test.mts — pin the GitHub CLI Adapter seam-check
 * grammar at the predicate level (no git scan, no process.exit), issue #899.
 *
 * The CI gate at scripts/ci/github-seam-check.ts forbids a raw
 * `node:child_process` import from any file outside `src/github/`, with a
 * carve-out for the non-gh/git spawners (exec-with-timeout.ts, autopilot/log.ts,
 * index.ts). This mirrors the redis-seam-check / schema-seam-check ratchet.
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
        "src/plan-cache.ts",
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

  test("exempts index.ts (non-gh/git execFile use)", () => {
    assert.equal(
      fileViolatesGithubSeam(
        "src/index.ts",
        `const { execFile: ef } = await import("node:child_process");`,
      ),
      false,
    );
  });

  test("does NOT exempt src/api/health.ts — it stays a tolerated baseline entry", () => {
    // health.ts spawns df/free/systemctl AND owns one migrated git call. It is
    // intentionally a baseline violation (shrinkable later), not a carve-out.
    assert.equal(
      fileViolatesGithubSeam(
        "src/api/health.ts",
        `import { execFile } from "node:child_process";`,
      ),
      true,
    );
  });
});
