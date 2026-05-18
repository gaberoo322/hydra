/**
 * Regression tests for scripts/branch-prune.sh exit semantics (issue #494).
 *
 * Background: the `hydra-branch-prune.service` ExecStart comment claims
 * per-branch errors should NOT fail the service ("don't fail the service —
 * the next run picks them up"). But scripts/branch-prune.sh historically
 * exited 1 whenever its `ERRORS` counter > 0, so any transient per-branch
 * cleanup hiccup (e.g. a worktree lock held by a dead PID) flipped the
 * service to `failed` until the next successful run. hydra-doctor then had
 * to triage the spurious `failed_services=1` signal each timer pass.
 *
 * Issue #494 chose fix (a): make per-branch errors non-fatal at the script
 * level (exit 0 with a warning when only per-branch errors occurred). Hard
 * failures (worktree refusal, missing jq/npx, classifier returning no
 * output) must still be non-zero — only the per-branch error counter is
 * downgraded.
 *
 * These tests pin the contract by reading the script as text and asserting
 * the structural properties of the relevant code path. They do NOT spawn
 * the script against a fake repo (that would require mocking git fetch,
 * npx tsx, the classifier output, and the destructive ops — overkill for a
 * single exit-code change).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/branch-prune.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf-8");
}

describe("scripts/branch-prune.sh — per-branch errors are non-fatal (issue #494)", () => {
  test("the ERRORS > 0 branch exits 0, not 1", () => {
    const text = readScript();
    // Locate the `if [ "$ERRORS" -gt 0 ]; then` block and verify its `exit`
    // statement is `exit 0`. We match on the surrounding shape to avoid a
    // false positive on some other `exit 0` elsewhere in the script.
    const match = text.match(/if \[ "\$ERRORS" -gt 0 \]; then[\s\S]*?\n\s*exit\s+(\d+)\s*\n\s*fi/);
    assert.ok(match, "expected an `if [ \"$ERRORS\" -gt 0 ]; then ... exit N; fi` block");
    assert.equal(
      match![1],
      "0",
      "per-branch errors must exit 0 so the systemd unit doesn't flap to `failed` (issue #494)",
    );
  });

  test("the ERRORS > 0 branch logs a WARNING (so the operator can still see it)", () => {
    const text = readScript();
    // The warning has to be loud enough that journalctl/hydra-doctor still
    // surface it — exit 0 doesn't mean silent. We require the literal token
    // "WARNING" in the error-path echo so log scrapers can match on it.
    const block = text.match(/if \[ "\$ERRORS" -gt 0 \]; then([\s\S]*?)\n\s*exit\s+0\s*\n\s*fi/);
    assert.ok(block, "expected the ERRORS > 0 branch to be present");
    const body = block![1];
    assert.match(body, /WARNING/, "the ERRORS > 0 branch must log a WARNING (operator visibility)");
    assert.match(body, /\$ERRORS/, "the warning must include the error count");
  });

  test("hard-failure exits remain non-zero (worktree refusal, jq/npx missing, classifier empty)", () => {
    const text = readScript();
    // Safety rail 1: refusing to run from inside a worktree — exit 3.
    assert.match(
      text,
      /refusing to run from inside a worktree[\s\S]*?\n\s*exit\s+3\b/,
      "worktree-refusal path must still exit 3",
    );
    // Tool dependency check — exit 127 (POSIX "command not found"). The
    // jq/npx guards are single-line `|| { ... exit 127; }` forms, so we
    // assert the exit appears inside the same braced block (same line OK).
    assert.match(
      text,
      /jq required[^}]*?exit\s+127\b/,
      "missing-jq path must still exit 127",
    );
    assert.match(
      text,
      /npx required[^}]*?exit\s+127\b/,
      "missing-npx path must still exit 127",
    );
    // Classifier produced no output — exit 4.
    assert.match(
      text,
      /classifier produced no output[\s\S]*?\n\s*exit\s+4\b/,
      "empty-classifier path must still exit 4 (no destructive ops)",
    );
  });

  test("the success path still exits 0 (regression guard against accidentally inverting the change)", () => {
    const text = readScript();
    // The success exit comes right after a `branch-prune: done.` log line.
    assert.match(
      text,
      /branch-prune: done\.[\s\S]*?\n\s*exit\s+0\s*$/m,
      "successful run must still exit 0 with a `done.` log line",
    );
  });

  test("the exit-0 change references the systemd unit's promise (so future readers find the rationale)", () => {
    const text = readScript();
    // The ExecStart comment in ~/.config/systemd/user/hydra-branch-prune.service
    // says "don't fail the service — the next run picks them up". The script
    // must explain WHY ERRORS > 0 is non-fatal so a future maintainer doesn't
    // "fix" the exit code back to 1 thinking it's a bug.
    const block = text.match(/if \[ "\$ERRORS" -gt 0 \]; then([\s\S]*?)\n\s*exit\s+0/);
    assert.ok(block, "expected the ERRORS > 0 branch to be present");
    const body = block![1];
    assert.match(
      body,
      /next (timer )?run|systemd|non-fatal|#494/i,
      "the non-fatal exit must be commented with rationale (rationale loss caused issue #494 in the first place)",
    );
  });
});
