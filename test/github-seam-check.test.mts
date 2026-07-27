/**
 * test/github-seam-check.test.mts — pin the GitHub CLI Adapter seam-check
 * grammar at the predicate level (no git scan, no process.exit), issue #899.
 *
 * The CI gate at scripts/ci/github-seam-check.ts forbids a raw
 * `node:child_process` import from any file outside `src/github/`, with a
 * carve-out for the non-gh/git spawner (exec-with-timeout.ts), the Host-Probe
 * Adapter family, and the Journal Adapter family (src/journal/*, issue #1958).
 * The index.ts carve-out was removed in issue #1960 once its startup git calls
 * moved behind gitExec; the autopilot/log.ts carve-out was removed in issue
 * #1958 once its journalctl spawn moved behind the Journal Adapter. This mirrors
 * the redis-seam-check / schema-seam-check ratchet.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  addIssueLabel,
  isIssueLabelWriteFailure,
  type IssueLabelTransport,
} from "../src/github/issues.ts";

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

  test("no longer exempts autopilot/log.ts — its journalctl spawn moved to the Journal Adapter (#1958)", () => {
    // After #1958 log.ts has no node:child_process import; were one to reappear
    // there it must route through src/journal/*, so it is NOT silently exempt.
    assert.equal(
      fileViolatesGithubSeam(
        "src/autopilot/log.ts",
        `import { spawn } from "node:child_process";`,
      ),
      true,
    );
  });

  test("exempts the Journal Adapter family (src/journal/*) — sibling Seam, issue #1958", () => {
    // src/journal/exec.ts owns the journalctl spawn as a separate Seam, NOT a
    // gh/git caller. It is carved out of this scan and policed by
    // journal-seam-check instead.
    assert.equal(
      fileViolatesGithubSeam(
        "src/journal/exec.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
    assert.equal(
      fileViolatesGithubSeam(
        "src/journal/read.ts",
        `import { runJournal } from "./exec.ts";`,
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

  test("exempts the Claude CLI Adapter family (src/claude-cli/*) — sibling Seam, issue #3703", () => {
    // src/claude-cli/exec.ts owns the `claude` CLI spawn as a separate Seam, NOT
    // a gh/git caller. Before #3703 the three claude spawn sites were flagged
    // here with no correct adapter to migrate to, which reddened
    // advisory-checks on every run.
    assert.equal(
      fileViolatesGithubSeam(
        "src/claude-cli/exec.ts",
        `import { spawn } from "node:child_process";`,
      ),
      false,
    );
  });

  test("the migrated claude spawn sites are no longer flagged (issue #3703)", () => {
    // They now import from src/claude-cli/exec.ts, so there is no
    // node:child_process import left to flag — and no baseline entry either.
    for (const f of [
      "src/vlm/claude-cli-runner.ts",
      "src/glm/drainer-runner.ts",
      "src/api/vlm.ts",
    ]) {
      assert.equal(
        fileViolatesGithubSeam(
          f,
          `import { runClaudeCli, type SpawnFn } from "../claude-cli/exec.ts";`,
        ),
        false,
        `${f} should route through the Claude CLI Adapter`,
      );
    }
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

// ---------------------------------------------------------------------------
// addIssueLabel — the label-write transport seam (issue #3755).
//
// The seam was read-only until #3755; this is the ONE narrow write surface. The
// tests pin (a) the exact `gh issue edit --add-label` argv the write rides on
// and (b) the result-object mapping for both the success and the failed-`gh`
// paths — WITHOUT spawning a real `gh`, by injecting a fake transport. New
// top-level describe (own lifecycle; no shared Redis teardown to piggyback on).
// ---------------------------------------------------------------------------
describe("addIssueLabel: label-write transport seam (#3755)", () => {
  test("success: builds the `gh issue edit --add-label` argv and returns ok", async () => {
    let captured: { args: string[] } | null = null;
    const transport: IssueLabelTransport = async (args) => {
      captured = { args };
      return { ok: true, data: { stdout: "", stderr: "" } };
    };

    const res = await addIssueLabel(42, "glm-eligible", {
      repo: "gaberoo322/hydra",
      transport,
    });

    // Success arm — ok:true, no throw.
    assert.equal(res.ok, true);
    assert.equal(isIssueLabelWriteFailure(res), false);
    // The argv is the single sanctioned `gh issue edit` add-label shape, with
    // the repo resolved through the seam (not re-spelled by the caller).
    assert.deepEqual(captured!.args, [
      "issue",
      "edit",
      "42",
      "--repo",
      "gaberoo322/hydra",
      "--add-label",
      "glm-eligible",
    ]);
  });

  test("failure: a failed `gh` invocation maps to the failure arm carrying the code", async () => {
    // Simulate `gh` exiting non-zero (e.g. auth/rate-limit/generic failure) —
    // the transport returns the Adapter's failure shape verbatim.
    const transport: IssueLabelTransport = async () => ({
      ok: false,
      code: "gh-failed",
      stderr: "could not add label: HTTP 403",
    });

    const res = await addIssueLabel(42, "glm-eligible", {
      repo: "gaberoo322/hydra",
      transport,
    });

    // Failure arm — ok:false with a machine-readable code (not a throw). The
    // caller discriminates on `code`, not stderr prose.
    assert.equal(isIssueLabelWriteFailure(res), true);
    if (isIssueLabelWriteFailure(res)) {
      assert.equal(res.code, "gh-failed");
      assert.equal(res.stderr, "could not add label: HTTP 403");
    }
  });
});
