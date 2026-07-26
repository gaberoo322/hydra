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
        "src/api/autopilot-log.ts",
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

  test("a doc-comment mention alone never violates, in ANY directory (issue #3703)", () => {
    // THE regression. src/claude-cli/exec.ts documents its sibling Seams — one
    // of which is the Journal Adapter — and imports node:child_process to spawn
    // the `claude` binary. It names `journalctl` ONLY in prose and never spawns
    // it, but the token regex matched raw source, so the gate fired and kept
    // advisory-checks red. The detector's own docstring already promised this:
    // "Naming `journalctl` in prose/comments alone ... is not a violation".
    // Fixing the detector (rather than adding a fifth directory carve-out)
    // closes the whole class: every future Adapter that documents its siblings
    // would otherwise hit the same trap.
    assert.equal(
      fileViolatesJournalSeam(
        "src/claude-cli/exec.ts",
        `/**\n * Sibling to the Journal Adapter (src/journal/exec.ts, journalctl).\n */\nimport { spawn } from "node:child_process";\nspawn("claude", args);`,
      ),
      false,
    );
  });

  test("a line-comment mention alone never violates (issue #3703)", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/some/new/adapter.ts",
        `import { spawn } from "node:child_process";\n// unlike journalctl, this spawns the claude binary\nspawn("claude");`,
      ),
      false,
    );
  });

  test("a REAL spawn is still flagged — the gate is not weakened (issue #3703)", () => {
    // Code-level tokens survive stripping, including inside string literals,
    // which is exactly where a spawned binary name lives.
    assert.equal(
      fileViolatesJournalSeam(
        "src/some/new/adapter.ts",
        `/* we should not spawn journalctl inline */\nimport { spawn } from "node:child_process";\nspawn("journalctl", ["--user"]);`,
      ),
      true,
    );
  });

  test("a commented-out child_process import does not count as the spawn capability (issue #3703)", () => {
    assert.equal(
      fileViolatesJournalSeam(
        "src/some/new/adapter.ts",
        `// import { spawn } from "node:child_process";\nconst bin = "journalctl";`,
      ),
      false,
    );
  });

  test("stripping does not swallow code after an escaped-slash regex (issue #3703)", () => {
    // Guard against a naive stripper treating `\/\/` inside a regex literal as
    // a line comment and eating the rest of the file — that would turn the gate
    // silently permissive.
    assert.equal(
      fileViolatesJournalSeam(
        "src/some/new/adapter.ts",
        `const re = /https?:\\/\\//;\nimport { spawn } from "node:child_process";\nspawn("journalctl");`,
      ),
      true,
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
