/**
 * Regression test for issue #512 — auto-escalation to GitHub via gh CLI.
 *
 * Strategy: stub the `gh` binary with a fake bash script controlled via
 * env vars (FAKE_GH_OUTPUT_DIR, FAKE_GH_SCENARIO). The escalation module
 * picks up the fake via HYDRA_GH_BIN. Each scenario writes the gh argv to
 * a file so the assertions can inspect what was invoked, and returns the
 * canned stdout the production code would parse.
 *
 * Scenarios:
 *   - `none`     : `gh issue list` returns []  → escalation creates a new issue.
 *   - `open`     : `gh issue list` returns one OPEN issue → comment-bump.
 *   - `closed`   : `gh issue list` returns one CLOSED issue → reopen + comment.
 *   - `error`    : `gh` exits non-zero → escalation returns status="error".
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

let workDir: string;
let fakeGhPath: string;
let invocationsPath: string;

let originalGhBin: string | undefined;
let originalDisabled: string | undefined;
let originalRepo: string | undefined;

let escalatePatternToIssue: typeof import("../src/learning/escalation.ts").escalatePatternToIssue;
let shouldEscalateAtHitCount: typeof import("../src/learning/escalation.ts").shouldEscalateAtHitCount;
let findExistingIssue: typeof import("../src/learning/escalation.ts").findExistingIssue;

/** Render a fake gh script that dispatches by SCENARIO env var. */
async function writeFakeGh(path: string, invocationsLog: string) {
  // The fake script appends its argv to a JSONL log file, then emits the
  // scenario-appropriate stdout. `gh issue list` returns JSON; everything
  // else returns a short success line.
  const body = `#!/usr/bin/env bash
set -u
SCENARIO=\${FAKE_GH_SCENARIO:-none}
LOGFILE="${invocationsLog}"
printf '%s\\n' "$(printf '%s ' "$@")" >> "$LOGFILE"

# Recognise the sub-command.
CMD="\${1:-}"; SUBCMD="\${2:-}"

if [ "$SCENARIO" = "error" ]; then
  echo "fake gh: simulated failure" >&2
  exit 1
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "list" ]; then
  case "$SCENARIO" in
    none)
      echo '[]'
      ;;
    open)
      echo '[{"number": 999, "state": "OPEN", "title": "meta(friction): some-cue hit 3 times across hydra-dev"}]'
      ;;
    closed)
      echo '[{"number": 999, "state": "CLOSED", "title": "meta(friction): some-cue hit 3 times across hydra-dev"}]'
      ;;
    *)
      echo '[]'
      ;;
  esac
  exit 0
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "create" ]; then
  echo "https://github.com/gaberoo322/hydra/issues/1234"
  exit 0
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "comment" ]; then
  echo "https://github.com/gaberoo322/hydra/issues/999#issuecomment-1"
  exit 0
fi

if [ "$CMD" = "issue" ] && [ "$SUBCMD" = "reopen" ]; then
  echo "reopened"
  exit 0
fi

if [ "$CMD" = "label" ]; then
  # The label-create call. Treat "already exists" as success.
  exit 0
fi

# Unknown — succeed silently.
exit 0
`;
  await writeFile(path, body, "utf-8");
  await chmod(path, 0o755);
}

async function readInvocations(): Promise<string[]> {
  if (!existsSync(invocationsPath)) return [];
  const raw = await readFile(invocationsPath, "utf-8");
  return raw.split("\n").filter(l => l.trim().length > 0);
}

async function resetInvocations() {
  await writeFile(invocationsPath, "", "utf-8");
}

describe("escalation to GitHub (issue #512)", () => {
  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hydra-escalation-"));
    await mkdir(workDir, { recursive: true });
    fakeGhPath = join(workDir, "fake-gh");
    invocationsPath = join(workDir, "invocations.log");
    await writeFakeGh(fakeGhPath, invocationsPath);

    originalGhBin = process.env.HYDRA_GH_BIN;
    originalDisabled = process.env.HYDRA_ESCALATION_DISABLED;
    originalRepo = process.env.HYDRA_GH_REPO;
    process.env.HYDRA_GH_BIN = fakeGhPath;
    process.env.HYDRA_GH_REPO = "gaberoo322/hydra";
    delete process.env.HYDRA_ESCALATION_DISABLED;

    const mod = await import("../src/learning/escalation.ts");
    escalatePatternToIssue = mod.escalatePatternToIssue;
    shouldEscalateAtHitCount = mod.shouldEscalateAtHitCount;
    findExistingIssue = mod.findExistingIssue;
  });

  beforeEach(async () => {
    await resetInvocations();
  });

  after(async () => {
    if (originalGhBin === undefined) delete process.env.HYDRA_GH_BIN;
    else process.env.HYDRA_GH_BIN = originalGhBin;
    if (originalDisabled === undefined) delete process.env.HYDRA_ESCALATION_DISABLED;
    else process.env.HYDRA_ESCALATION_DISABLED = originalDisabled;
    if (originalRepo === undefined) delete process.env.HYDRA_GH_REPO;
    else process.env.HYDRA_GH_REPO = originalRepo;
    delete process.env.FAKE_GH_SCENARIO;
    await rm(workDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // shouldEscalateAtHitCount — pure helper
  // -------------------------------------------------------------------------

  test("shouldEscalateAtHitCount: fires at threshold-cross", () => {
    assert.equal(shouldEscalateAtHitCount(3, 3), true);
  });

  test("shouldEscalateAtHitCount: silent between threshold-cross and next decade", () => {
    for (const n of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      assert.equal(shouldEscalateAtHitCount(n, 3), false, `hitCount=${n} should NOT fire`);
    }
  });

  test("shouldEscalateAtHitCount: fires on each multiple-of-10 above threshold", () => {
    assert.equal(shouldEscalateAtHitCount(13, 3), true);
    assert.equal(shouldEscalateAtHitCount(23, 3), true);
    assert.equal(shouldEscalateAtHitCount(33, 3), true);
    assert.equal(shouldEscalateAtHitCount(14, 3), false);
    assert.equal(shouldEscalateAtHitCount(2, 3), false);
  });

  // -------------------------------------------------------------------------
  // findExistingIssue
  // -------------------------------------------------------------------------

  test("findExistingIssue: returns null when gh issue list is empty", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    const got = await findExistingIssue("some-cue");
    assert.equal(got, null);
  });

  test("findExistingIssue: returns OPEN match", async () => {
    process.env.FAKE_GH_SCENARIO = "open";
    const got = await findExistingIssue("some-cue");
    assert.notEqual(got, null);
    assert.equal(got!.number, 999);
    assert.equal(got!.state, "OPEN");
  });

  test("findExistingIssue: returns CLOSED match", async () => {
    process.env.FAKE_GH_SCENARIO = "closed";
    const got = await findExistingIssue("some-cue");
    assert.notEqual(got, null);
    assert.equal(got!.state, "CLOSED");
  });

  // -------------------------------------------------------------------------
  // escalatePatternToIssue: create / comment / reopen branches
  // -------------------------------------------------------------------------

  test("creates a new issue when no existing match is found", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "stale-local-master-ref",
      hitCount: 3,
      skills: ["hydra-dev"],
      workarounds: ["used origin/master"],
      lastReference: "issue-512",
    });
    assert.equal(result.status, "created");
    if (result.status === "created") {
      assert.equal(result.issueNumber, 1234);
    }
    const invocations = await readInvocations();
    // Should have called: issue list (search), label create, issue create.
    assert.ok(invocations.some(l => l.startsWith("issue list ")), "expected `gh issue list` invocation");
    assert.ok(invocations.some(l => l.startsWith("issue create ")), "expected `gh issue create` invocation");
    assert.ok(invocations.some(l => l.includes("meta-friction")), "expected meta-friction label in args");
  });

  test("comment-bumps when an OPEN issue with the cue already exists", async () => {
    process.env.FAKE_GH_SCENARIO = "open";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "some-cue",
      hitCount: 13,
      skills: ["hydra-dev"],
      workarounds: ["w1", "w2"],
    });
    assert.equal(result.status, "commented");
    if (result.status === "commented") {
      assert.equal(result.issueNumber, 999);
    }
    const invocations = await readInvocations();
    assert.ok(invocations.some(l => l.startsWith("issue comment 999")), "expected comment on issue 999");
    assert.ok(
      !invocations.some(l => l.startsWith("issue create ")),
      "must NOT create a duplicate issue",
    );
  });

  test("reopens + comments when the only matching issue is CLOSED", async () => {
    process.env.FAKE_GH_SCENARIO = "closed";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "some-cue",
      hitCount: 3,
      skills: ["hydra-target-build"],
    });
    assert.equal(result.status, "reopened");
    if (result.status === "reopened") {
      assert.equal(result.issueNumber, 999);
    }
    const invocations = await readInvocations();
    assert.ok(invocations.some(l => l.startsWith("issue reopen 999")), "expected reopen on 999");
    assert.ok(invocations.some(l => l.startsWith("issue comment 999")), "expected comment after reopen");
    assert.ok(!invocations.some(l => l.startsWith("issue create ")), "must NOT create a duplicate");
  });

  test("returns status=error when gh fails — never throws", async () => {
    process.env.FAKE_GH_SCENARIO = "error";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "broken-cue",
      hitCount: 3,
      skills: ["hydra-dev"],
    });
    assert.equal(result.status, "error");
  });

  test("returns status=skipped when HYDRA_ESCALATION_DISABLED is set", async () => {
    process.env.HYDRA_ESCALATION_DISABLED = "1";
    try {
      const result = await escalatePatternToIssue({
        kind: "friction",
        cue: "any-cue",
        hitCount: 3,
        skills: ["hydra-dev"],
      });
      assert.equal(result.status, "skipped");
    } finally {
      delete process.env.HYDRA_ESCALATION_DISABLED;
    }
  });

  test("returns status=skipped when cue is empty", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    const result = await escalatePatternToIssue({
      kind: "friction",
      cue: "",
      hitCount: 3,
      skills: ["hydra-dev"],
    });
    assert.equal(result.status, "skipped");
  });

  test("uses meta(lesson) title for kind=lesson, meta(friction) for kind=friction", async () => {
    process.env.FAKE_GH_SCENARIO = "none";
    await escalatePatternToIssue({
      kind: "lesson",
      cue: "verification-failure",
      hitCount: 3,
      skills: ["hydra-dev"],
    });
    const invocations = await readInvocations();
    // Find the `issue create` invocation and check the title arg.
    const createLine = invocations.find(l => l.startsWith("issue create "));
    assert.ok(createLine, "expected an issue create invocation");
    assert.ok(createLine!.includes("meta(lesson)"), `expected meta(lesson) in title, got: ${createLine}`);
  });
});
