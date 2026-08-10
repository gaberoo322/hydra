/**
 * Regression test for issue #3852 — recover-stale.sh open-PR guard on the
 * stale-in-progress loop.
 *
 * `scripts/autopilot/recover-stale.sh` (Phase 1.5) re-queues a stale
 * `in-progress` issue by demoting it `in-progress → ready-for-agent`. Before
 * #3852 this was UNCONDITIONAL: there was no check for whether an open PR
 * already implements the issue. So an issue that was stale in `in-progress`
 * because it was FINISHED and waiting on review (not because dev stalled) got
 * demoted to `ready-for-agent`, where the anchor selector handed it back to
 * dev_orch as fresh work — manufacturing a duplicate implementation of an
 * already-open PR (observed: #3689 was demoted while its PR #3836 sat open and
 * clean).
 *
 * The fix adds an open-PR guard: before demoting, check for an open PR that
 * references the issue (via the `issue-<N>-<slug>` head branch OR a closing /
 * `Refs` keyword in the PR body). On a hit → route `in-progress → needs-qa`
 * (awaiting review, not stalled). On no hit → keep today's behaviour exactly
 * (`in-progress → ready-for-agent`). A `gh pr list` failure degrades to today's
 * behaviour (never strands the turn).
 *
 * recover-stale.sh shells out to bare `gh`, so (like the calendar-guard suite
 * in test/autopilot-recover-stale.test.mts) we inject a fake `gh` on PATH that
 * serves canned issue bodies/states AND a canned open-PR list, recording every
 * `gh issue edit` so we can assert the relabel target. No service or GitHub
 * access required. The fake `gh` serves the PR JSON; the REAL
 * scripts/autopilot/pr-refs.py parses it (end-to-end through the shared
 * predicate the issue mandates).
 *
 * Acceptance pinned here:
 *   - Open PR via `issue-<N>-<slug>` branch → needs-qa, never ready-for-agent.
 *   - Open PR via `Closes #N` body      → needs-qa.
 *   - Open PR via `Refs #N` body        → needs-qa (the non-closing form).
 *   - No open PR                        → ready-for-agent (unchanged default).
 *   - `gh pr list` failure              → ready-for-agent (degrades, never aborts).
 *   - Per-issue isolation: one with a PR, one without → needs-qa / ready-for-agent.
 *   - No over-match: a bare `#N` (no keyword) and an unrelated issue number are
 *     NOT treated as a referencing PR.
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

interface FakePr {
  headRefName: string;
  body: string;
}

/**
 * Write a fake `gh` onto PATH. It honours the subcommands recover-stale.sh
 * exercises on the in-progress path:
 *   gh issue view N --repo R --json body|state
 *   gh issue edit N --repo R --remove-label L --add-label L
 *   gh issue comment N --repo R --body B
 *   gh pr list --repo R --state open --json headRefName,body
 * and records every `gh issue edit`. Logic lives in a Python helper to dodge
 * bash string-interpolation gotchas with bodies that contain quotes, asterisks,
 * or newlines.
 *
 * `opts.prListFails` makes the stub exit 1 on `gh pr list` (no stdout), so the
 * script's never-abort degradation path can be exercised.
 */
function makeGhStub(
  dir: string,
  issues: FakeIssue[],
  prs: FakePr[],
  opts: { prListFails?: boolean } = {},
): {
  binDir: string;
  editsFile: string;
  readEdits(): string[][];
} {
  const binDir = join(dir, "bin");
  const issuesFile = join(dir, "issues.json");
  const prsFile = join(dir, "prs.json");
  const editsFile = join(dir, "edits.jsonl");
  const prListFails = opts.prListFails ? "1" : "0";

  writeFileSync(issuesFile, JSON.stringify(issues));
  writeFileSync(prsFile, JSON.stringify(prs));
  writeFileSync(editsFile, "");

  const stubScript = `#!/usr/bin/env bash
set -uo pipefail
exec python3 ${JSON.stringify(join(dir, "gh-stub.py"))} "\$@"
`;

  const helper = `#!/usr/bin/env python3
"""Fake gh for test/recover-stale.test.mts (issue #3852 open-PR guard)."""
import json
import os
import sys

ISSUES_FILE = ${JSON.stringify(issuesFile)}
PRS_FILE = ${JSON.stringify(prsFile)}
EDITS_FILE = ${JSON.stringify(editsFile)}
PR_LIST_FAILS = ${JSON.stringify(prListFails)}


def load_issues():
    with open(ISSUES_FILE, "r", encoding="utf-8") as f:
        return {i["number"]: i for i in json.load(f)}


def load_prs():
    with open(PRS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


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


def cmd_pr_list(rest):
    # gh pr list --json headRefName,body prints a JSON array. We serve the
    # canned list verbatim so the real scripts/autopilot/pr-refs.py parses it.
    if PR_LIST_FAILS == "1":
        sys.exit(1)
    sys.stdout.write(json.dumps(load_prs()) + "\\n")


def main():
    argv = sys.argv[1:]
    if len(argv) < 1:
        sys.stderr.write(f"stub: unexpected gh call {argv!r}\\n")
        sys.exit(2)
    kind, rest = argv[0], argv[1:]
    if kind == "issue":
        sub = rest[0] if rest else ""
        inner = rest[1:]
        if sub == "view":
            cmd_view(inner)
        elif sub == "edit":
            cmd_edit(inner)
        elif sub == "comment":
            cmd_comment(inner)
        else:
            sys.stderr.write(f"stub: unknown issue subcommand {sub}\\n")
            sys.exit(99)
    elif kind == "pr":
        sub = rest[0] if rest else ""
        if sub == "list":
            cmd_pr_list(rest[1:])
        else:
            sys.stderr.write(f"stub: unknown pr subcommand {sub}\\n")
            sys.exit(99)
    else:
        sys.stderr.write(f"stub: unexpected gh call {argv!r}\\n")
        sys.exit(2)


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

/** Which label was ADDED for issue N on a stale-in-progress relabel? */
function addedLabel(edits: string[][], issue: number): string | null {
  for (const e of edits) {
    if (e[0] !== String(issue)) continue;
    if (!e.includes("--remove-label") || !e.includes("in-progress")) continue;
    const i = e.indexOf("--add-label");
    if (i !== -1 && i + 1 < e.length) return e[i + 1];
  }
  return null;
}

describe("recover-stale.sh — open-PR guard on stale in-progress (issue #3852)", () => {
  test("open PR via `issue-<N>-<slug>` head branch → needs-qa", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [{ number: 950, state: "OPEN", body: "stale in-progress" }],
        [{ headRefName: "issue-950-fix-thing", body: "" }],
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "950"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(addedLabel(stub.readEdits(), 950), "needs-qa");
      assert.match(r.stdout, /routed in-progress→needs-qa issue=950/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("open PR via `Closes #N` body → needs-qa", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [{ number: 951, state: "OPEN", body: "stale in-progress" }],
        [{ headRefName: "worktree-agent-abc", body: "Implements the thing.\n\nCloses #951" }],
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "951"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(addedLabel(stub.readEdits(), 951), "needs-qa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("open PR via `Refs #N` body (non-closing) → needs-qa", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [{ number: 952, state: "OPEN", body: "stale in-progress" }],
        [{ headRefName: "worktree-agent-def", body: "Related to the drainer. Refs #952." }],
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "952"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(addedLabel(stub.readEdits(), 952), "needs-qa", "Refs #N must route to needs-qa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no open PR → ready-for-agent (unchanged default)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [{ number: 953, state: "OPEN", body: "stale in-progress" }],
        [], // no open PRs
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "953"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(addedLabel(stub.readEdits(), 953), "ready-for-agent");
      assert.match(r.stdout, /re-queued in-progress issue=953/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`gh pr list` failure → degrades to ready-for-agent (never aborts)", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [{ number: 954, state: "OPEN", body: "stale in-progress" }],
        [{ headRefName: "issue-954-x", body: "Closes #954" }], // would route to needs-qa if read
        { prListFails: true },
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "954"]);
      assert.equal(r.status, 0, r.stderr);
      // gh pr list failed → empty referenced-issue set → today's behaviour.
      assert.equal(
        addedLabel(stub.readEdits(), 954),
        "ready-for-agent",
        "a gh pr list failure must fall back to today's ready-for-agent relabel",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("per-issue isolation: one issue has a PR, a sibling does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [
          { number: 955, state: "OPEN", body: "stale in-progress" },
          { number: 956, state: "OPEN", body: "stale in-progress" },
        ],
        [{ headRefName: "issue-955-slug", body: "Refs #955" }],
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "955", "956"]);
      assert.equal(r.status, 0, r.stderr);
      const edits = stub.readEdits();
      assert.equal(addedLabel(edits, 955), "needs-qa", "issue with an open PR routes to needs-qa");
      assert.equal(addedLabel(edits, 956), "ready-for-agent", "issue without a PR is re-queued");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no over-match: a bare `#N` (no keyword) is not a referencing PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [{ number: 957, state: "OPEN", body: "stale in-progress" }],
        // A bare mention with NO closing/Refs keyword must not count.
        [{ headRefName: "worktree-agent-xyz", body: "See earlier discussion in #957." }],
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "957"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        addedLabel(stub.readEdits(), 957),
        "ready-for-agent",
        "a bare #N with no keyword is not a reference",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no over-match: a Refs to a DIFFERENT issue does not route this one", () => {
    const dir = mkdtempSync(join(tmpdir(), "recover-stale-prguard-"));
    try {
      const stub = makeGhStub(
        dir,
        [{ number: 958, state: "OPEN", body: "stale in-progress" }],
        [{ headRefName: "worktree-agent-q", body: "Refs #999" }],
      );
      const r = runRecoverStale(stub.binDir, ["stale_in_progress", "958"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        addedLabel(stub.readEdits(), 958),
        "ready-for-agent",
        "a PR referencing another issue must not route this one to needs-qa",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
