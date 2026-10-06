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
  /** Model the number as a pull request: merged vs closed-unmerged vs open. */
  pr?: "merged" | "closed-unmerged";
}

/** The ready-for-agent precondition the stub appends to every body. */
const SCOPE_FOOTER = "\n\n## Files in scope\n\n- src/example.ts\n";

/**
 * Write a fake `gh` onto PATH. It serves `gh issue view N --json body|state`
 * from a canned issue table and records every `gh issue edit` invocation so
 * the test can assert whether the unblock fired. Logic lives in a Python
 * helper to dodge bash string-interpolation gotchas with bodies that contain
 * quotes, asterisks, or newlines.
 */
function makeGhStub(
  dir: string,
  issues: FakeIssue[],
  opts: {
    openPrs?: unknown[];
    rawPrList?: string;
    failOpenList?: boolean;
    failApi?: boolean;
    failCliBody?: boolean;
    failCli?: boolean;
    noScope?: boolean;
  } = {},
): {
  binDir: string;
  editsFile: string;
  readEdits(): string[][];
} {
  const binDir = join(dir, "bin");
  const issuesFile = join(dir, "issues.json");
  const editsFile = join(dir, "edits.jsonl");

  writeFileSync(
    issuesFile,
    JSON.stringify(
      issues.map((i) => ({ ...i, body: opts.noScope ? i.body : i.body + SCOPE_FOOTER })),
    ),
  );
  const prsFile = join(dir, "prs.json");
  writeFileSync(prsFile, opts.rawPrList ?? JSON.stringify(opts.openPrs ?? []));
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
PRS_FILE = ${JSON.stringify(prsFile)}
FAIL_OPEN_LIST = ${JSON.stringify(opts.failOpenList ? "1" : "0")}
FAIL_API = ${JSON.stringify(opts.failApi ? "1" : "0")}
FAIL_CLI_BODY = ${JSON.stringify(opts.failCliBody ? "1" : "0")}


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
    if json_field == "body" and find_flag(rest, "--jq") is None:
        if FAIL_CLI_BODY == "1":
            sys.exit(1)
        # Real gh without --jq prints the JSON object (the blockers-cleared CLI path).
        sys.stdout.write(json.dumps({"body": hit["body"]}) + "\\n")
    elif json_field == "body":
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


def cmd_list(rest):
    # gh issue list --state open --search "<n1> <n2>" --json ... : the batched
    # open-blocker lookup. Serve every OPEN canned issue (the TS side intersects).
    if FAIL_OPEN_LIST == "1":
        sys.exit(1)
    rows = [
        {"number": i["number"], "title": "t", "url": "u", "createdAt": "", "labels": [],
         "body": i["body"], "state": "OPEN"}
        for i in load_issues().values()
        if i["state"] == "OPEN" and not i.get("pr")
    ]
    sys.stdout.write(json.dumps(rows) + "\\n")


def cmd_api(argv):
    # gh api repos/R/issues/N : per-ref confirmation (issue OR pull request).
    if FAIL_API == "1":
        sys.exit(1)
    number = int(argv[1].rsplit("/", 1)[1])
    hit = load_issues().get(number)
    if hit is None:
        sys.exit(1)
    out = {"state": hit["state"].lower()}
    if hit.get("pr"):
        out["pull_request"] = {"merged_at": "2026-01-01T00:00:00Z" if hit["pr"] == "merged" else None}
    sys.stdout.write(json.dumps(out) + "\\n")


def main():
    argv = sys.argv[1:]
    if argv[:1] == ["api"]:
        cmd_api(argv)
        return
    if argv[:2] == ["pr", "list"]:
        with open(PRS_FILE, "r", encoding="utf-8") as f:
            sys.stdout.write(f.read() + "\\n")
        return
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
    elif sub == "list":
        cmd_list(rest)
    else:
        sys.stderr.write(f"stub: unknown issue subcommand {sub}\\n")
        sys.exit(99)


if __name__ == "__main__":
    main()
`;

  spawnSync("mkdir", ["-p", binDir]);
  if (opts.failCli) {
    const npxPath = join(binDir, "npx");
    writeFileSync(npxPath, "#!/usr/bin/env bash\necho 'boom from fake npx' >&2\nexit 3\n");
    chmodSync(npxPath, 0o755);
  }
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
          body: `**Do not start before ${PAST}.**\n\nBlocked by #100.`,
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

function wasRoutedNeedsQa(edits: string[][], issue: number): boolean {
  return edits.some(
    (e) =>
      e[0] === String(issue) &&
      e.includes("blocked") &&
      e.includes("needs-qa") &&
      !e.includes("ready-for-agent"),
  );
}

function runCase(
  issues: FakeIssue[],
  args: string[],
  opts: Parameters<typeof makeGhStub>[2] = {},
): { r: ReturnType<typeof runRecoverStale>; edits: string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "recover-stale-blockers-"));
  try {
    const stub = makeGhStub(dir, issues, opts);
    const r = runRecoverStale(stub.binDir, args);
    return { r, edits: stub.readEdits() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("recover-stale.sh — blocker clearance predicate (issue #4806)", () => {
  // Mirror of #4628's shape: open Parent epic + open sibling + merged ADR PR,
  // but the only real blocker (#4623) is closed.
  const sliceBody = [
    "## Parent",
    "",
    "#4619",
    "",
    "## Blocked by",
    "",
    "- Blocked by #4623",
    "",
    "See also sibling #4627 and ADR PR #4617.",
  ].join("\n");
  const slice = (): FakeIssue[] => [
    { number: 4628, state: "OPEN", body: sliceBody },
    { number: 4623, state: "CLOSED", body: "x" },
    { number: 4619, state: "OPEN", body: "epic" },
    { number: 4627, state: "OPEN", body: "sibling" },
    { number: 4617, state: "CLOSED", body: "adr", pr: "merged" },
  ];

  test("slice with closed blocker is promoted despite open Parent/sibling mentions", () => {
    const { r, edits } = runCase(slice(), ["stale_blocked", "4628"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(wasUnblocked(edits, 4628), true);
  });

  test("a merged PR blocker counts as cleared", () => {
    const { r, edits } = runCase(
      [
        { number: 10, state: "OPEN", body: "Blocked by #11." },
        { number: 11, state: "CLOSED", body: "pr", pr: "merged" },
      ],
      ["stale_blocked", "10"],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(wasUnblocked(edits, 10), true);
  });

  test("a closed-unmerged PR blocker holds the issue", () => {
    const { edits } = runCase(
      [
        { number: 10, state: "OPEN", body: "Blocked by #11." },
        { number: 11, state: "CLOSED", body: "pr", pr: "closed-unmerged" },
      ],
      ["stale_blocked", "10"],
    );
    assert.equal(edits.length, 0);
  });

  test("a second ref on the same strict line is also a blocker (open => held)", () => {
    const { edits } = runCase(
      [
        { number: 20, state: "OPEN", body: "Blocked by #100 and #101." },
        { number: 100, state: "CLOSED", body: "x" },
        { number: 101, state: "OPEN", body: "open" },
      ],
      ["stale_blocked", "20"],
    );
    assert.equal(edits.length, 0);
  });

  test("an issue with NO strict blocker refs (epic parent) is never promoted", () => {
    const { r, edits } = runCase(
      [
        { number: 30, state: "OPEN", body: "Epic. Children: #31 #32." },
        { number: 31, state: "CLOSED", body: "x" },
        { number: 32, state: "CLOSED", body: "x" },
      ],
      ["stale_blocked", "30"],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(edits.length, 0);
  });

  test("a body without a parseable Files in scope section is not promoted", () => {
    const { edits } = runCase(
      [
        { number: 40, state: "OPEN", body: "Blocked by #41." },
        { number: 41, state: "CLOSED", body: "x" },
      ],
      ["stale_blocked", "40"],
      { noScope: true },
    );
    assert.equal(edits.length, 0);
  });

  test("an open PR referencing the cleared issue routes to needs-qa, never ready-for-agent", () => {
    const { edits } = runCase(
      [
        { number: 50, state: "OPEN", body: "Blocked by #51." },
        { number: 51, state: "CLOSED", body: "x" },
      ],
      ["stale_blocked", "50"],
      { openPrs: [{ headRefName: "feat/x", body: "Closes #50" }] },
    );
    assert.equal(wasRoutedNeedsQa(edits, 50), true);
    assert.equal(wasUnblocked(edits, 50), false);
  });

  test("lookup failure (batched open search) promotes nothing and exits 0", () => {
    const { r, edits } = runCase(slice(), ["stale_blocked", "4628"], { failOpenList: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(edits.length, 0);
  });

  test("lookup failure (per-ref confirmation read) promotes nothing and exits 0", () => {
    const { r, edits } = runCase(slice(), ["stale_blocked", "4628"], { failApi: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(edits.length, 0);
  });

  test("empty stale_blocked list does not spawn the blockers-cleared CLI", () => {
    const { r, edits } = runCase([], ["stale_blocked"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(edits.length, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /blockers-cleared/);
  });

  test("blockers-cleared CLI non-zero exit promotes nothing, exits 0, logs its stderr", () => {
    const { r, edits } = runCase(slice(), ["stale_blocked", "4628"], { failCli: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(edits.length, 0);
    assert.match(r.stdout, /blockers-cleared exited 3.*boom from fake npx/);
  });

  test("unreadable issue body (CLI read fails) promotes nothing and exits 0", () => {
    const { r, edits } = runCase(slice(), ["stale_blocked", "4628"], { failCliBody: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(edits.length, 0);
  });

  test("unparseable open-PR list promotes nothing (PR_LIST_OK gate, QA #4869)", () => {
    const { r, edits } = runCase(slice(), ["stale_blocked", "4628"], { rawPrList: "not json" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(edits.length, 0);
    assert.match(r.stdout, /open-PR list unreadable/);
  });
});

describe("hydra-dev parent-flow fragment — no unblock-dependents step (INV-12, #4806)", () => {
  const fragment = readFileSync(
    join(REPO_ROOT, "docs", "operator-playbooks", "_fragments", "hydra-dev-parent-flow.md"),
    "utf-8",
  );

  test("never unblocks a dependent from the parent flow", () => {
    assert.doesNotMatch(fragment, /Then unblock dependents/);
    assert.doesNotMatch(fragment, /--remove-label\s+"?blocked"?/);
    assert.match(fragment, /Dependents are NOT unblocked here/);
  });
});
