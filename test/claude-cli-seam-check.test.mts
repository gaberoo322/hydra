/**
 * test/claude-cli-seam-check.test.mts — pin the Claude CLI Adapter seam-check
 * grammar at the predicate level (no git scan, no process.exit), issue #3703.
 *
 * The CI gate at scripts/ci/claude-cli-seam-check.ts forbids a raw
 * `node:child_process` import that shells out to the `claude` CLI from any file
 * outside `src/claude-cli/`, with carve-outs for the three sibling Adapter
 * families (GitHub CLI, Host-Probe, Journal) and the process-group test-runner
 * primitive. Sibling to github-seam-check / host-probe-seam-check; together they
 * ensure every node:child_process in src/ is owned by exactly one Seam.
 *
 * The last block pins the STRUCTURAL outcome the issue asked for: the three
 * claude spawn sites that used to redden advisory-checks now import
 * node:child_process zero times, and the seam's baseline stays closed at zero.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const { fileViolatesClaudeCliSeam } = await import(
  "../scripts/ci/claude-cli-seam-check.ts"
);
const { REPO_ROOT, loadBaseline } = await import("../scripts/ci/seam-check-lib.ts");

describe("claude-cli-seam-check: child_process import grammar", () => {
  test("flags a NEW claude spawn caller outside the family", () => {
    assert.equal(
      fileViolatesClaudeCliSeam(
        "src/some/new/claude-runner.ts",
        `import { spawn } from "node:child_process";`,
      ),
      true,
    );
  });

  test("flags the bare, require(...) and dynamic import(...) forms", () => {
    assert.equal(
      fileViolatesClaudeCliSeam("src/foo.ts", `import { spawn } from "child_process";`),
      true,
    );
    assert.equal(
      fileViolatesClaudeCliSeam("src/foo.ts", `const cp = require("node:child_process");`),
      true,
    );
    assert.equal(
      fileViolatesClaudeCliSeam(
        "src/foo.ts",
        `const { spawn } = await import("node:child_process");`,
      ),
      true,
    );
  });

  test("does NOT flag a file that routes through the seam accessor", () => {
    assert.equal(
      fileViolatesClaudeCliSeam(
        "src/vlm/claude-cli-runner.ts",
        `import { runClaudeCli, type SpawnFn } from "../claude-cli/exec.ts";`,
      ),
      false,
    );
    assert.equal(
      fileViolatesClaudeCliSeam(
        "src/api/vlm.ts",
        `import { defaultClaudeSpawn } from "../claude-cli/exec.ts";`,
      ),
      false,
    );
  });
});

describe("claude-cli-seam-check: family + sibling-Seam carve-outs", () => {
  test("exempts the Claude CLI Adapter family itself (src/claude-cli/*)", () => {
    assert.equal(
      fileViolatesClaudeCliSeam(
        "src/claude-cli/exec.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
  });

  test("exempts the three sibling Adapter families", () => {
    for (const f of [
      "src/github/exec.ts",
      "src/host-probe/exec.ts",
      "src/journal/exec.ts",
    ]) {
      assert.equal(
        fileViolatesClaudeCliSeam(f, `import { spawn } from "node:child_process";`),
        false,
        `${f} should be exempt — it owns its own Seam`,
      );
    }
  });

  test("exempts the process-group test-runner primitive", () => {
    assert.equal(
      fileViolatesClaudeCliSeam(
        "src/exec-with-timeout.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
  });

  test("a near-miss directory name is NOT exempt (trailing-slash prefix)", () => {
    // `src/claude-cli-foo.ts` is not inside the family directory.
    assert.equal(
      fileViolatesClaudeCliSeam(
        "src/claude-cli-foo.ts",
        `import { spawn } from "node:child_process";`,
      ),
      true,
    );
  });
});

describe("claude-cli-seam-check: the boundary is actually closed (issue #3703)", () => {
  test("the former claude spawn sites import node:child_process zero times", async () => {
    // Two of the original three sites (src/vlm/claude-cli-runner.ts and
    // src/api/vlm.ts) were removed with OpenViking — the /vlm shim existed only
    // to serve OV's ov.conf vlm.api_base. The GLM drainer is what remains.
    for (const rel of [
      "src/glm/drainer-runner.ts",
    ]) {
      const body = await readFile(join(REPO_ROOT, rel), "utf8");
      assert.equal(
        /from\s+['"]node:child_process['"]/.test(body),
        false,
        `${rel} must route its claude spawn through src/claude-cli/exec.ts`,
      );
      assert.equal(
        fileViolatesClaudeCliSeam(rel, body),
        false,
        `${rel} must not violate the claude-cli seam`,
      );
    }
  });

  test("the baseline is seeded at ZERO and stays closed", async () => {
    const baseline = await loadBaseline(
      join(REPO_ROOT, "scripts/ci/claude-cli-seam-baseline.json"),
    );
    assert.deepEqual(
      baseline.callers,
      [],
      "a new Seam is never seeded with its own violations (host-probe precedent)",
    );
  });
});
