/**
 * test/host-probe-seam-check.test.mts — pin the Host-Probe Adapter seam-check
 * grammar at the predicate level (no git scan, no process.exit), issue #939.
 *
 * The CI gate at scripts/ci/host-probe-seam-check.ts forbids a raw
 * `node:child_process` import that shells out to a host-info binary from any
 * file outside `src/host-probe/`, with carve-outs for the GitHub CLI Adapter
 * family (owns its own gh/git spawn), the Journal Adapter family (owns its own
 * journalctl spawn, issue #1958), and the two acknowledged non-host spawners
 * (exec-with-timeout.ts, index.ts). Sibling to github-seam-check; together they
 * ensure every node:child_process in src/ is owned by exactly one Seam.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesHostProbeSeam } = await import("../scripts/ci/host-probe-seam-check.ts");

describe("host-probe-seam-check: child_process import grammar", () => {
  test("flags a NEW host-info child_process caller outside the family", () => {
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/api/health.ts",
        `import { execFile } from "node:child_process";`,
      ),
      true,
    );
    assert.equal(
      fileViolatesHostProbeSeam("src/some-new-module.ts", `import { spawn } from "child_process";`),
      true,
    );
  });

  test("flags require(...) and dynamic import(...) forms", () => {
    assert.equal(
      fileViolatesHostProbeSeam("src/foo.ts", `const cp = require("node:child_process");`),
      true,
    );
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/foo.ts",
        `const { execFile } = await import("node:child_process");`,
      ),
      true,
    );
  });

  test("does NOT flag a file that routes through the host-probe accessors", () => {
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/api/health.ts",
        `import { readDisk, readMem, readServiceStatus } from "../host-probe/probe.ts";`,
      ),
      false,
    );
  });
});

describe("host-probe-seam-check: carve-outs", () => {
  test("exempts the Host-Probe Adapter family itself (src/host-probe/*)", () => {
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/host-probe/exec.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
  });

  test("exempts the GitHub CLI Adapter family (src/github/* owns gh/git spawn)", () => {
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/github/exec.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/github/exec-file-compat.ts",
        `import { execFile } from "node:child_process";`,
      ),
      false,
    );
  });

  test("exempts the Journal Adapter family (src/journal/* owns journalctl spawn, #1958)", () => {
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/journal/exec.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
  });

  test("exempts the two acknowledged non-host spawners", () => {
    for (const f of ["src/exec-with-timeout.ts", "src/index.ts"]) {
      assert.equal(
        fileViolatesHostProbeSeam(f, `import { spawn } from "node:child_process";`),
        false,
        `${f} should be exempt`,
      );
    }
  });

  test("no longer exempts src/autopilot/log.ts — its journalctl spawn moved to the Journal Adapter (#1958)", () => {
    // After #1958 log.ts has no node:child_process import at all, so this is a
    // hypothetical: were a child_process import to reappear there, it would NOT
    // be silently tolerated — it must route through src/journal/*.
    assert.equal(
      fileViolatesHostProbeSeam(
        "src/autopilot/log.ts",
        `import { spawn } from "node:child_process";`,
      ),
      true,
    );
  });
});
