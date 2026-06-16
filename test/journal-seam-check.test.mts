/**
 * test/journal-seam-check.test.mts — pin the Journal Adapter seam-check grammar
 * at the predicate level (no git scan, no process.exit), issue #1958.
 *
 * The CI gate at scripts/ci/journal-seam-check.ts forbids spawning `journalctl`
 * (a `node:child_process` import PLUS a `journalctl` binary token) from any file
 * outside `src/journal/`, with carve-outs for the sibling process Seams
 * (src/github/*, src/host-probe/*) that own their own spawn and may name
 * journalctl in doc-prose. The FOURTH process Seam after redis / github /
 * host-probe; together they ensure every journalctl spawn in src/ is owned by
 * exactly one Seam.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { fileViolatesJournalSeam } = await import("../scripts/ci/journal-seam-check.ts");

describe("journal-seam-check: journalctl spawn grammar", () => {
  test("flags a NEW journalctl caller outside the family (child_process + journalctl token)", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/autopilot/log.ts",
        `import { spawn } from "node:child_process";\nspawn("journalctl", ["--user"]);`,
      ),
      true,
    );
    assert.equal(
      fileViolatesJournalSeam(
        "src/some-new-module.ts",
        `const cp = require("child_process");\ncp.spawn("journalctl", []);`,
      ),
      true,
    );
  });

  test("flags require(...) and dynamic import(...) forms alongside a journalctl token", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/foo.ts",
        `const { spawn } = await import("node:child_process");\nspawn("journalctl");`,
      ),
      true,
    );
  });

  test("does NOT flag a child_process import without a journalctl token (owned by another Seam's gate)", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/foo.ts",
        `import { spawn } from "node:child_process";\nspawn("df", ["-h"]);`,
      ),
      false,
    );
  });

  test("does NOT flag a journalctl mention without a child_process import (prose/doc reference)", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/docs-ish.ts",
        `// We used to spawn journalctl here; now it routes through src/journal/*.`,
      ),
      false,
    );
  });

  test("does NOT flag a file that routes through the journal accessor", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/api/autopilot.ts",
        `import { readJournalSlice } from "../journal/read.ts";`,
      ),
      false,
    );
  });
});

describe("journal-seam-check: carve-outs", () => {
  test("exempts the Journal Adapter family itself (src/journal/*)", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/journal/exec.ts",
        `import { spawn } from "node:child_process";\nspawn("journalctl", args);`,
      ),
      false,
    );
  });

  test("exempts sibling process Seams that name journalctl in prose (github / host-probe)", () => {
    // exec-file-compat.ts lists journalctl as an example non-gh binary in its
    // doc comment while importing child_process for the gh/git boundary.
    assert.equal(
      fileViolatesJournalSeam(
        "src/github/exec-file-compat.ts",
        `import { execFile } from "node:child_process";\n// e.g. df/free/systemctl/journalctl`,
      ),
      false,
    );
    assert.equal(
      fileViolatesJournalSeam(
        "src/host-probe/exec.ts",
        `import { spawn } from "node:child_process";\n// not journalctl — df/free/systemctl`,
      ),
      false,
    );
  });
});
