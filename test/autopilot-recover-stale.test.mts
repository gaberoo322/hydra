/**
 * Regression test for issue #838 — recover-stale.sh calendar awareness.
 *
 * `scripts/autopilot/recover-stale.sh` (Phase 1.5) re-queues a stale
 * `blocked` issue to `ready-for-agent` when every `#N` reference parsed
 * from its body is CLOSED. Before #838 this had NO calendar awareness, so
 * a calendar-blocked issue like #664 ("Do not start before 2026-06-10")
 * whose only `#N` refs are already-closed epics/PRs would be wrongly
 * re-queued before its promised start date.
 *
 * The fix adds a calendar guard: before unblocking, scan the WHOLE body
 * (case-insensitive) for a YYYY-MM-DD adjacent to a cue token
 * (`do not start before`, `Calendar:`, `blocked-until:`). If a FUTURE date
 * (UTC) is found, skip the unblock. Past/today dates and absent markers
 * stay eligible for normal recovery.
 *
 * recover-stale.sh shells out to bare `gh`, so (like
 * autopilot-unattended.test.mts / learning-escalation.test.mts) we inject
 * a fake `gh` on PATH that serves canned issue bodies + states and records
 * every `gh issue edit` so we can assert whether the unblock fired. No
 * service or GitHub access required.
 *
 * Invariants pinned here:
 *   - Future calendar date (inline `**Do not start before ...**`) → NOT unblocked.
 *   - Future calendar date (`## Blocked by` → `Calendar:` line) → NOT unblocked.
 *   - The real #664 body shape (BOTH markers) → NOT unblocked.
 *   - Past calendar date + all refs closed → unblocked normally.
 *   - No calendar marker + all refs closed → unblocked (unchanged behavior).
 *   - No calendar marker + an OPEN ref → NOT unblocked (unchanged behavior).
 *   - Multiple future dates → most-conservative (latest) one wins the skip.
 *   - blocked-until: machine marker (future) → NOT unblocked.
 *   - Per-issue isolation: a calendar-blocked issue doesn't strand a
 *     sibling that is genuinely recoverable in the same invocation.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");

interface FakeIssue {
  number: number;
  state: "OPEN" | "CLOSED";
  body: string;
}

/**
 * Write a fake `gh` onto PATH. It serves `gh issue view N --json body|state`
 * from a canned issue table and records every `gh issue edit` invocation so
 * the test can assert whether the unblock fired. Logic lives in a Python
 * helper to dodge bash string-interpolation gotchas with bodies that contain
 * quotes, asterisks, or newlines.
 */
function makeGhStub(dir: string, issues: FakeIssue[]): {
  binDir: string;
  editsFile: string;
  readEdits(): string[][];
} {
  const binDir = join(dir, "bin");
  const issuesFile = join(dir, "issues.json");
  const editsFile = join(dir, "edits.jsonl");

  writeFileSync(issuesFile, JSON.stringify(issues));
  writeFileSync(editsFile, "");

  const stubScript = `#!/usr/bin/env bash
set -uo pipefail
exec python3 ${JSON.stringify(join(dir, "gh-stub.py"))} "\$@"
`;

  const helper = `#!/usr/bin/env python3
"""Fake gh for test/autopilot-recover-stale.test.mts.

Honors only the subcommands recover-stale.sh exercises:
  gh issue view N --repo R --json body  --jq .body
  gh issue view N --repo R --json state --jq .state
  gh issue edit N --repo R --remove-label L --add-label L
  gh issue comment N --repo R --body B
"""
import json
import os
import sys

ISSUES_FILE = ${JSON.stringify(issuesFile)}
EDITS_FILE = ${JSON.stringify(editsFile)}


def load_issues():
    with open(ISSUES_FILE, "r", encoding="utf-8") as f:
        return {i["number"]: i for i in json.load(f)}


def find_flag(argv, name):
    for i, tok in enumerate(argv):
        if tok == name and i + 1 < len(argv):
            return argv[i + 1]
    return None


def cmd_view(rest):
    number = int(rest[0])
    json_field = find_flag(rest, "--json") or ""
    issues = load_issues()
    hit = issues.get(number)
    if hit is None:
        sys.stderr.write(f"not found: {number}\\n")
        sys.exit(1)
    if json_field == "body":
        sys.stdout.write(hit["body"] + "\\n")
    elif json_field == "state":
        sys.stdout.write(hit["state"] + "\\n")
    else:
        sys.stderr.write(f"stub: unsupported --json {json_field}\\n")
        sys.exit(99)


def cmd_edit(rest):
    with open(EDITS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(rest) + "\\n")
    # Mimic gh success.


def cmd_comment(rest):
    # No-op; recover-stale.sh tolerates comment failures anyway.
    pass


def main():
    argv = sys.argv[1:]
    if len(argv) < 2 or argv[0] != "issue":
        sys.stderr.write(f"stub: unexpected gh call {argv!r}\\n")
        sys.exit(2)
    sub, rest = argv[1], argv[2:]
    if sub == "view":
        cmd_view(rest)
    elif sub == "edit":
        cmd_edit(rest)
    elif sub == "comment":
        cmd_comment(rest)
    else:
        sys.stderr.write(f"stub: unknown issue subcommand {sub}\\n")
        sys.exit(99)


if __name__ == "__main__":
    main()
`;

  spawnSync("mkdir", ["-p", binDir]);
  const stubPath = join(binDir, "gh");
  writeFileSync(stubPath, stubScript);
  chmodSync(stubPath, 0o755);
  writeFileSync(join(dir, "gh-stub.py"), helper);
  chmodSync(join(dir, "gh-stub.py"), 0o755);

  return {
    binDir,
    editsFile,
    readEdits() {
      return readFileSync(editsFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as string[]);
    },
  };
}

function runRecoverStale(
  binDir: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(join(SCRIPTS, "recover-stale.sh"), args, {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HYDRA_AUTOPILOT_REPO: "gaberoo322/hydra",
    },
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Did the script issue an unblock edit (remove blocked → add ready) for N? */
function wasUnblocked(edits: string[][], issue: number): boolean {
  return edits.some(
    (e) =>
      e[0] === String(issue) &&
      e.includes("--remove-label") &&
      e.includes("blocked") &&
      e.includes("--add-label") &&
      e.includes("ready-for-agent"),
  );
}

// A far-future / far-past date relative to any plausible test-run clock.
const FUTURE = "2999-01-01";
const PAST = "2000-01-01";

describe("recover-stale.sh — calendar guard (issue #838)", () => {
  test("future inline 'Do not start before' (bolded) → NOT unblocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const stub = makeGhStub(dir, [
        {
          number: 664,
          state: "OPEN",
          body: `Cleanup epic.\n\n**Do not start before ${FUTURE}.**\n\nRefs #100.`,
        },
        { number: 100, state: "CLOSED", body: "closed blocker" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "664"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 664), false, "must not unblock a future-calendar issue");
      assert.match(r.stdout, new RegExp(`calendar-blocked until ${FUTURE}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("future 'Calendar:' line under '## Blocked by' → NOT unblocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const stub = makeGhStub(dir, [
        {
          number: 664,
          state: "OPEN",
          body: `Refs #100.\n\n## Blocked by\n\nCalendar: do not start before **${FUTURE}**.`,
        },
        { number: 100, state: "CLOSED", body: "closed blocker" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "664"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 664), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real #664 body shape (BOTH markers) → NOT unblocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      // Mirror of the actual #664 body: inline bold marker + Blocked-by
      // Calendar line + only-closed `#N` refs (epic #642, PR #659, PRD #615).
      const body = [
        "> *Calendar-blocked cleanup of epic #642 / slice 7 PR2 (#659).*",
        "",
        "## What to do",
        "",
        "Two weeks after the atomic swap (merged in PR #659), retire the view.",
        "",
        `**Do not start before ${FUTURE}.** The deprecation banner promises that date.`,
        "",
        "## Blocked by",
        "",
        `Calendar: do not start before **${FUTURE}**.`,
      ].join("\n");
      const stub = makeGhStub(dir, [
        { number: 664, state: "OPEN", body },
        { number: 642, state: "CLOSED", body: "epic" },
        { number: 659, state: "CLOSED", body: "pr" },
        { number: 615, state: "CLOSED", body: "prd" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "664"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 664), false, "#664 must survive every turn until its date passes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PAST calendar date + all refs closed → unblocked normally", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const stub = makeGhStub(dir, [
        {
          number: 700,
          state: "OPEN",
          body: `**Do not start before ${PAST}.**\n\nRefs #100.`,
        },
        { number: 100, state: "CLOSED", body: "closed blocker" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "700"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 700), true, "a past calendar date must not gate recovery");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no calendar marker + all refs closed → unblocked (unchanged)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const stub = makeGhStub(dir, [
        { number: 800, state: "OPEN", body: "Plain blocker issue.\n\nBlocked by #100 and #101." },
        { number: 100, state: "CLOSED", body: "x" },
        { number: 101, state: "CLOSED", body: "x" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "800"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 800), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no calendar marker + an OPEN ref → NOT unblocked (unchanged)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const stub = makeGhStub(dir, [
        { number: 801, state: "OPEN", body: "Blocked by #100 and #101." },
        { number: 100, state: "CLOSED", body: "x" },
        { number: 101, state: "OPEN", body: "still open" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "801"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 801), false, "open blocker must still gate recovery");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multiple future dates → most-conservative (latest) one is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const earlier = "2999-01-01";
      const later = "2999-12-31";
      const stub = makeGhStub(dir, [
        {
          number: 802,
          state: "OPEN",
          body: `Calendar: do not start before ${earlier}.\nblocked-until: ${later}\n\nRefs #100.`,
        },
        { number: 100, state: "CLOSED", body: "x" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "802"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 802), false);
      assert.match(r.stdout, new RegExp(`calendar-blocked until ${later}`), "latest future date wins");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("future 'blocked-until:' machine marker → NOT unblocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const stub = makeGhStub(dir, [
        { number: 803, state: "OPEN", body: `blocked-until: ${FUTURE}\n\nRefs #100.` },
        { number: 100, state: "CLOSED", body: "x" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "803"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(wasUnblocked(stub.readEdits(), 803), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("per-issue isolation: a calendar-blocked issue doesn't strand a recoverable sibling", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      const stub = makeGhStub(dir, [
        { number: 664, state: "OPEN", body: `**Do not start before ${FUTURE}.**\n\nRefs #100.` },
        { number: 900, state: "OPEN", body: "Plain. Blocked by #100." },
        { number: 100, state: "CLOSED", body: "x" },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_blocked", "664", "900"]);
      assert.equal(r.status, 0, r.stderr);
      const edits = stub.readEdits();
      assert.equal(wasUnblocked(edits, 664), false, "calendar-blocked sibling stays blocked");
      assert.equal(wasUnblocked(edits, 900), true, "genuinely-recoverable sibling still recovers");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale in-progress recovery is unaffected by the calendar guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-test-"));
    try {
      // in-progress recovery never reads the body, so a calendar marker is irrelevant.
      const stub = makeGhStub(dir, [
        { number: 950, state: "OPEN", body: `**Do not start before ${FUTURE}.**` },
      ]);
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "950"]);
      assert.equal(r.status, 0, r.stderr);
      const requeued = stub.readEdits().some(
        (e) =>
          e[0] === "950" &&
          e.includes("--remove-label") &&
          e.includes("in-progress") &&
          e.includes("ready-for-agent"),
      );
      assert.equal(requeued, true, "stale in-progress is re-queued regardless of body content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
