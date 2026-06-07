/**
 * Regression tests for the trivial-anchor grill gate in
 * `scripts/autopilot/collect-state.sh` (issue #1088).
 *
 * BACKGROUND
 *
 *   `collect-state.sh` emits `orch_pending_grill_anchor=issue-<N>|none` —
 *   the first orch-board `ready-for-agent` issue lacking a fresh
 *   design-concept artifact. `decide.py`'s `design_concept_orch` selector
 *   reads this signal verbatim and dispatches `hydra-grill` before
 *   `dev_orch` may proceed (#628 path). Pre-#1088 EVERY ready-for-agent
 *   anchor without a fresh artifact got promoted, making the grill the
 *   highest-frequency subagent class (~14% of burn).
 *
 * THE GATE (fail-toward-grill — see the loop comment in collect-state.sh)
 *
 *   Suppress the grill ONLY on a POSITIVE trivial signal: an explicit
 *   `Expected tier: T1` (or `Expected tier: 1`) body stamp AND no
 *   `needs-design-concept` label. ALWAYS grill (never suppress) when the
 *   `needs-design-concept` label is present, a T2/T3/T4 stamp is present,
 *   or there is NO stamp at all (unknown complexity). The emit contract is
 *   unchanged: still a single `issue-<N>|none` string.
 *
 * TEST STRATEGY
 *
 *   collect-state.sh shells out to `hydra`, `systemctl`, `gh`, and `curl`.
 *   We run the real script end-to-end with those four binaries stubbed on a
 *   temp PATH (real `python3` is kept — it is the classifier). The `gh`
 *   stub returns a fixture array for the grill-loop `gh issue list
 *   ... --json number,updatedAt,body,labels` call; the `curl` stub returns
 *   404 (empty) for every `/api/design-concepts/issue-<N>` probe so every
 *   fixtured issue is "no fresh artifact" — isolating the trivial gate as
 *   the only thing that decides which anchor is promoted. We then read just
 *   the `orch_pending_grill_anchor=` line from stdout.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COLLECT_STATE = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

interface Issue {
  number: number;
  updatedAt: string;
  body: string;
  labels: { name: string }[];
}

/**
 * Run collect-state.sh with stubbed external binaries and return the value
 * of the `orch_pending_grill_anchor=` line.
 *
 * @param issues the fixture the `gh` stub returns for the grill-loop list
 *   call, in board order (newest-first — the script reads them in order).
 */
function runGrillGate(issues: Issue[]): string {
  const dir = mkdtempSync(join(tmpdir(), "grill-gate-"));
  try {
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);

    const fixture = JSON.stringify(issues);
    writeFileSync(join(dir, "issues.json"), fixture);

    // `gh` stub: only the grill-loop invocation matters. It is the one
    // `gh issue list ... --json number,updatedAt,body,labels` call. We emit
    // the fixture for that and an empty array (or empty object) otherwise so
    // the earlier board collectors degrade gracefully.
    writeStub(
      bin,
      "gh",
      `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "number,updatedAt,body,labels" ]; then
    cat "${join(dir, "issues.json")}"
    exit 0
  fi
done
# Any other gh call (board-state fallback list, etc.) — emit empty so the
# upstream collectors don't error.
echo "[]"
exit 0
`,
    );

    // `curl` stub: every /api/design-concepts/issue-<N> probe 404s (prints
    // nothing, exits non-zero like `curl -sf` on 404) so every fixtured
    // issue counts as "no fresh artifact". Any other curl prints nothing.
    writeStub(
      bin,
      "curl",
      `#!/usr/bin/env bash
# Mimic 'curl -sf' on a 404: no body, non-zero exit.
exit 22
`,
    );

    // `hydra` and `systemctl` are called by earlier collectors. Stub them to
    // no-op so the script reaches the grill loop without network/systemd.
    writeStub(bin, "hydra", `#!/usr/bin/env bash\nexit 1\n`);
    writeStub(bin, "systemctl", `#!/usr/bin/env bash\necho ""\nexit 0\n`);

    const r = spawnSync("bash", [COLLECT_STATE], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });

    // The script is best-effort and never exits non-zero on a collector miss.
    const line = (r.stdout ?? "")
      .split("\n")
      .find((l) => l.startsWith("orch_pending_grill_anchor="));
    assert.ok(
      line !== undefined,
      `collect-state.sh did not emit orch_pending_grill_anchor (stderr: ${r.stderr})`,
    );
    return line.slice("orch_pending_grill_anchor=".length).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeStub(bin: string, name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

function issue(
  number: number,
  body: string,
  labels: string[] = [],
): Issue {
  return {
    number,
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    body,
    labels: labels.map((name) => ({ name })),
  };
}

describe("collect-state.sh — trivial-anchor grill gate (issue #1088)", () => {
  test("suppresses grill on an explicit 'Expected tier: T1' stamp", () => {
    const pick = runGrillGate([
      issue(101, "## Problem\nTrivial prompt tweak.\n\nExpected tier: T1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "a T1-stamped anchor must not be promoted to a grill",
    );
  });

  test("suppresses grill on the numeric 'Expected tier: 1' stamp form", () => {
    const pick = runGrillGate([
      issue(102, "Doc edit.\n\nExpected tier: 1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "the numeric 'Expected tier: 1' form is the same positive trivial signal",
    );
  });

  test("grills a T3-stamped anchor (non-trivial)", () => {
    const pick = runGrillGate([
      issue(103, "Core src/ change.\n\nExpected tier: T3\n"),
    ]);
    assert.equal(pick, "issue-103", "a T3 stamp must still grill");
  });

  test("grills a numeric T3-stamped anchor", () => {
    const pick = runGrillGate([
      issue(104, "Core change.\n\nExpected tier: 3\n"),
    ]);
    assert.equal(pick, "issue-104", "the numeric T3 form must still grill");
  });

  test("grills an UNSTAMPED anchor (unknown complexity → fail-toward-grill)", () => {
    const pick = runGrillGate([
      issue(105, "## Problem\nNo tier stamp anywhere in this body.\n"),
    ]);
    assert.equal(
      pick,
      "issue-105",
      "absence of any stamp must NEVER suppress — skip is the unsafe direction",
    );
  });

  test("grills a needs-design-concept anchor even when T1-stamped (label opt-in wins)", () => {
    const pick = runGrillGate([
      issue(106, "Looks trivial.\n\nExpected tier: T1\n", [
        "ready-for-agent",
        "needs-design-concept",
      ]),
    ]);
    assert.equal(
      pick,
      "issue-106",
      "the needs-design-concept label is an explicit grill opt-in that overrides a T1 stamp",
    );
  });

  test("skips a T1 anchor and promotes the next non-trivial one", () => {
    // Board order is newest-first; the loop walks it in order. The T1 anchor
    // is suppressed and the loop falls through to the unstamped one.
    const pick = runGrillGate([
      issue(201, "Trivial.\n\nExpected tier: T1\n"),
      issue(202, "Complex, no stamp.\n"),
    ]);
    assert.equal(
      pick,
      "issue-202",
      "a suppressed T1 anchor must not block grilling of a later non-trivial anchor",
    );
  });

  test("emits 'none' when every candidate is trivially T1-stamped", () => {
    const pick = runGrillGate([
      issue(301, "Tweak A.\n\nExpected tier: T1\n"),
      issue(302, "Tweak B.\n\nExpected tier: 1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "an all-trivial board must produce no grill anchor",
    );
  });

  test("emits 'none' on an empty board", () => {
    const pick = runGrillGate([]);
    assert.equal(pick, "none", "no ready-for-agent issues → no grill anchor");
  });

  test("T1 substring inside a word does not count as a stamp (word-boundary)", () => {
    // 'Expected tier: T12' is NOT a T1 stamp — the \b boundary guards it.
    const pick = runGrillGate([
      issue(401, "Weird body.\n\nExpected tier: T12\n"),
    ]);
    assert.equal(
      pick,
      "issue-401",
      "'T12' must not be read as a trivial T1 stamp",
    );
  });

  test("stamp match is case-insensitive", () => {
    const pick = runGrillGate([
      issue(402, "lower.\n\nexpected tier: t1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "a lowercase 'expected tier: t1' stamp is still a positive trivial signal",
    );
  });
});
