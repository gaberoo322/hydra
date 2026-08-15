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
  title: string;
}

interface OpenPr {
  headRefName: string;
  body: string;
}

interface GateOpts {
  /**
   * Issue numbers whose `/api/design-concepts/issue-<N>` probe returns a FRESH
   * artifact (a `createdAt` of now). Everything else 404s. Post-#3711 this is
   * what makes an anchor "grill-clear" and therefore a valid dev pin.
   */
  freshArtifacts?: number[];
  /**
   * Issue numbers whose `/api/design-concepts/issue-<N>` probe returns a FRESH
   * but DRAFT (unapproved) artifact — disjoint from `freshArtifacts`, which
   * always returns `status: "approved"`. Issue #3798: this is the fixture that
   * exercises the artifact-APPROVAL dimension of the frontier-routing
   * discriminator, orthogonal to freshness.
   */
  draftArtifacts?: number[];
  /** Fixture for the `gh pr list --json headRefName,body` in-flight probe (#3711). */
  openPrs?: OpenPr[];
}

interface GatePicks {
  /** The `orch_pending_grill_anchor=` value. */
  grill: string;
  /** The `orch_dev_ready_anchor=` value (issue #3711). */
  devReady: string;
  /** The `orch_dev_ready_anchor_artifact_approved=` value (issue #3798). */
  artifactApproved: string;
}

/**
 * Run collect-state.sh with stubbed external binaries and return both anchor
 * picks the grill loop emits.
 *
 * @param issues the fixture the `gh` stub returns for the grill-loop list call.
 *   Post-#3711 the ORDER OF THIS ARRAY IS IRRELEVANT: the script sorts
 *   candidates by issue number ascending (stable, oldest-first) rather than
 *   walking gh's newest-first order, so a test can pass them in any order and
 *   the walk order is deterministic. Several tests below pass them descending on
 *   purpose, to pin exactly that.
 */
function runGate(issues: Issue[], opts: GateOpts = {}): GatePicks {
  const dir = mkdtempSync(join(tmpdir(), "grill-gate-"));
  try {
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);

    writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
    writeFileSync(join(dir, "prs.json"), JSON.stringify(opts.openPrs ?? []));
    // One issue number per line — the curl stub greps this for an exact match.
    writeFileSync(
      join(dir, "fresh.txt"),
      (opts.freshArtifacts ?? []).map((n) => String(n)).join("\n") + "\n",
    );
    // Issue #3798: a disjoint fresh-but-DRAFT fixture list, same format.
    writeFileSync(
      join(dir, "fresh-draft.txt"),
      (opts.draftArtifacts ?? []).map((n) => String(n)).join("\n") + "\n",
    );

    // `gh` stub: two invocations matter, both keyed on their exact `--json`
    // field list. The grill-loop issue list, and (post-#3711) the open-PR probe
    // that feeds the in-flight-dev exclusion. Everything else emits an empty
    // array so the upstream collectors degrade gracefully.
    //
    // NOTE: the stub ignores `--jq`, so the script's own jq filters (the
    // target-backlog exclusion) are not exercised here — the fixture arrives raw.
    writeStub(
      bin,
      "gh",
      `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "number,updatedAt,body,labels,title" ]; then
    cat "${join(dir, "issues.json")}"
    exit 0
  fi
  if [ "$a" = "headRefName,body" ]; then
    cat "${join(dir, "prs.json")}"
    exit 0
  fi
done
# Any other gh call (board-state fallback list, etc.) — emit empty so the
# upstream collectors don't error.
echo "[]"
exit 0
`,
    );

    // `curl` stub: a /api/design-concepts/issue-<N> probe returns a FRESH
    // APPROVED artifact iff <N> is in fresh.txt, a FRESH DRAFT (unapproved)
    // artifact iff <N> is in fresh-draft.txt (issue #3798), otherwise it
    // mimics `curl -sf` on a 404 (no body, non-zero exit) so the issue counts
    // as "no fresh artifact".
    writeStub(
      bin,
      "curl",
      `#!/usr/bin/env bash
url=""
for a in "$@"; do
  case "$a" in http*) url="$a" ;; esac
done
case "$url" in
  */api/design-concepts/issue-*)
    n="\${url##*/issue-}"
    if grep -qxF "$n" "${join(dir, "fresh.txt")}" 2>/dev/null; then
      # A fresh, APPROVED artifact: createdAt = now (ms), well inside the
      # 7-day window.
      echo "{\\"createdAt\\": $(( $(date +%s) * 1000 )), \\"status\\": \\"approved\\"}"
      exit 0
    fi
    if grep -qxF "$n" "${join(dir, "fresh-draft.txt")}" 2>/dev/null; then
      # A fresh but DRAFT (unapproved) artifact — issue #3798: still
      # "grill-clear" (Phase B warn-only), but must NOT set the approval flag.
      echo "{\\"createdAt\\": $(( $(date +%s) * 1000 )), \\"status\\": \\"draft\\"}"
      exit 0
    fi
    ;;
esac
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
    const read = (key: string): string => {
      const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith(`${key}=`));
      assert.ok(
        line !== undefined,
        `collect-state.sh did not emit ${key} (stderr: ${r.stderr})`,
      );
      return line.slice(key.length + 1).trim();
    };
    return {
      grill: read("orch_pending_grill_anchor"),
      devReady: read("orch_dev_ready_anchor"),
      artifactApproved: read("orch_dev_ready_anchor_artifact_approved"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Back-compat shim: the pre-#3711 tests assert only the grill pick. */
function runGrillGate(issues: Issue[]): string {
  return runGate(issues).grill;
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
  title = "Some implementation work",
): Issue {
  return {
    number,
    updatedAt: new Date(Date.now() - number * 1000).toISOString(),
    body,
    labels: labels.map((name) => ({ name })),
    title,
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

describe("collect-state.sh — mechanical/non-implementable grill gate (issue #1230)", () => {
  test("suppresses grill on a cleanup-scan anchor (mechanical → straight to dev)", () => {
    // A cleanup-scan finding is self-checking and needs no design concept,
    // even when its body carries no T1 stamp (so the #1088 trivial gate would
    // otherwise promote it).
    const pick = runGrillGate([
      issue(
        1228,
        "cleanup: remove unused export DEFAULT_GH_TIMEOUT_MS\n",
        ["ready-for-agent", "cleanup-scan"],
        "cleanup: remove unused export DEFAULT_GH_TIMEOUT_MS",
      ),
    ]);
    assert.equal(
      pick,
      "none",
      "a cleanup-scan anchor must not be promoted to a grill — it routes straight to dev",
    );
  });

  test("emits 'none' when every ready-for-agent issue is a cleanup-scan finding", () => {
    // The acceptance criterion from #1230: a board whose only candidates are
    // cleanup-scan findings emits none so dev_orch dispatches directly.
    const pick = runGrillGate([
      issue(501, "remove dead export A.\n", ["ready-for-agent", "cleanup-scan"]),
      issue(502, "remove dead file B.\n", ["ready-for-agent", "cleanup-scan"]),
    ]);
    assert.equal(
      pick,
      "none",
      "an all-cleanup-scan board must produce no grill anchor",
    );
  });

  test("skips a cleanup-scan anchor and promotes the next non-trivial one", () => {
    // The cleanup-scan anchor is suppressed; the loop falls through to the
    // unstamped (non-mechanical) anchor, which still grills.
    const pick = runGrillGate([
      issue(601, "remove dead code.\n", ["ready-for-agent", "cleanup-scan"]),
      issue(602, "Complex refactor, no stamp.\n", ["ready-for-agent"]),
    ]);
    assert.equal(
      pick,
      "issue-602",
      "a suppressed cleanup-scan anchor must not block grilling of a later non-trivial anchor",
    );
  });

  test("suppresses grill on a 'track:'-prefixed measurement-window tracker", () => {
    // A track: tracker is calendar-bound and not implementable now — no design
    // concept should precede it. Title carries the prefix; body has no stamp.
    const pick = runGrillGate([
      issue(
        627,
        "Measurement window closes 2026-06-18.\n",
        ["ready-for-agent"],
        "track: weekly merge-rate baseline (window 2026-06-11 → 2026-06-18)",
      ),
    ]);
    assert.equal(
      pick,
      "none",
      "a track:-prefixed calendar-bound tracker must not be promoted to a grill",
    );
  });

  test("the track: prefix match is case-insensitive and tolerates leading space", () => {
    const pick = runGrillGate([
      issue(
        628,
        "Another tracker.\n",
        ["ready-for-agent"],
        "  Track: monthly cost ceiling check",
      ),
    ]);
    assert.equal(
      pick,
      "none",
      "a leading-space, capitalised 'Track:' title is still a calendar-bound tracker",
    );
  });

  test("a non-cleanup, non-track anchor still grills (no false suppression)", () => {
    // Guard against over-broad suppression: 'tracking' is not the 'track:'
    // prefix, and an ordinary label set does not trigger the mechanical gate.
    const pick = runGrillGate([
      issue(
        701,
        "Add tracking for X.\n",
        ["ready-for-agent", "enhancement"],
        "Add request tracking to the scheduler",
      ),
    ]);
    assert.equal(
      pick,
      "issue-701",
      "an ordinary anchor (title merely containing 'track', no cleanup-scan label) must still grill",
    );
  });
});

describe("collect-state.sh — orch_dev_ready_anchor, the per-anchor half of the gate (issue #3711)", () => {
  // The same loop pass now emits a SECOND signal: the first already-GRILL-CLEAR
  // anchor. decide.py pins dev_orch to it instead of yielding board-wide, so a
  // growing board can no longer starve orchestrator development for a whole run.
  //
  // Both directions, per the originating issue's caution: the gated anchor is
  // still promoted for a grill AND a second eligible anchor is still offered to
  // dev the same turn.

  test("a fresh artifact makes an anchor dev-ready while a later anchor still grills", () => {
    // THE headline both-directions case: issue-701 has an approved artifact,
    // issue-702 does not. The grill still targets 702; dev gets 701.
    const picks = runGate(
      [issue(701, "Already grilled.\n"), issue(702, "Complex, no stamp.\n")],
      { freshArtifacts: [701] },
    );
    assert.equal(picks.grill, "issue-702",
      "the un-grilled anchor must still be promoted — the gate is not weakened");
    assert.equal(picks.devReady, "issue-701",
      "an anchor with a fresh artifact must be offered to dev_orch the same turn");
  });

  test("emits none/none on an empty board", () => {
    const picks = runGate([]);
    assert.equal(picks.grill, "none");
    assert.equal(picks.devReady, "none", "no candidates → nothing for dev to be pinned to");
  });

  test("a board of only un-grilled anchors offers NO dev pin (gate holds)", () => {
    // This is the case that must still block dev_orch entirely.
    const picks = runGate([issue(703, "No stamp.\n"), issue(704, "No stamp either.\n")]);
    assert.equal(picks.grill, "issue-703", "the oldest un-grilled anchor is promoted");
    assert.equal(picks.devReady, "none",
      "no grill-clear anchor exists, so decide.py must still yield");
  });

  test("a T1-stamped anchor is dev-ready (trivial gate #1088 → grill-clear)", () => {
    const picks = runGate([
      issue(710, "Trivial tweak.\n\nExpected tier: T1\n"),
      issue(711, "Complex, no stamp.\n"),
    ]);
    assert.equal(picks.grill, "issue-711");
    assert.equal(picks.devReady, "issue-710",
      "a T1-stamped anchor needs no concept by construction, so it is a valid dev pin");
  });

  test("a cleanup-scan anchor is dev-ready (mechanical gate #1230 → grill-clear)", () => {
    const picks = runGate([
      issue(720, "remove dead export.\n", ["ready-for-agent", "cleanup-scan"]),
      issue(721, "Complex, no stamp.\n"),
    ]);
    assert.equal(picks.grill, "issue-721");
    assert.equal(picks.devReady, "issue-720",
      "a cleanup-scan finding is self-checking and routes straight to dev");
  });

  test("a 'track:' tracker is suppressed for BOTH picks (not implementable now)", () => {
    // The mechanical gate suppresses the grill for a calendar-bound tracker, but
    // unlike cleanup-scan it must NOT become a dev pin — its window is open.
    const picks = runGate([
      issue(730, "Window closes later.\n", ["ready-for-agent"], "track: weekly merge-rate baseline"),
    ]);
    assert.equal(picks.grill, "none", "a track: tracker is not a grill candidate (#1230)");
    assert.equal(picks.devReady, "none",
      "a track: tracker is not implementable now, so it must never be pinned to dev");
  });

  test("the dev pick is the FIRST grill-clear anchor, not merely any of them", () => {
    const picks = runGate(
      [
        issue(740, "No stamp.\n"),
        issue(741, "Grilled.\n"),
        issue(742, "Also grilled.\n"),
      ],
      { freshArtifacts: [741, 742] },
    );
    assert.equal(picks.grill, "issue-740");
    assert.equal(picks.devReady, "issue-741",
      "the lowest-numbered grill-clear anchor wins, mirroring the grill pick's stability");
  });
});

describe("collect-state.sh — orch_dev_ready_anchor_artifact_approved, the #3798 frontier-routing discriminator", () => {
  // `orch_dev_ready_anchor` alone conflates two populations that are BOTH
  // "grill-clear": a genuine fresh+APPROVED design-concept artifact, and the
  // mechanical (#1230) / trivial (#1088) exemption. decide.py's per-anchor
  // frontier-routing HINT (issue #3798) must tell them apart — routing the
  // exemption population to the frontier tier would spend Opus on exactly the
  // cheap work #3798 measured Sonnet as sufficient for. This signal is
  // stamped in LOCKSTEP with `orch_dev_ready_anchor`, in the same loop pass.

  test("fresh + APPROVED artifact -> artifact_approved=true", () => {
    const picks = runGate(
      [issue(1101, "Already grilled and approved.\n")],
      { freshArtifacts: [1101] },
    );
    assert.equal(picks.devReady, "issue-1101");
    assert.equal(picks.artifactApproved, "true",
      "a fresh, status:approved artifact is the genuine-artifact population");
  });

  test("fresh but DRAFT (unapproved) artifact -> artifact_approved=false", () => {
    // Phase B warn-only: a draft artifact is still a valid dev pin, but the
    // approval dimension is orthogonal to freshness and must read false.
    const picks = runGate(
      [issue(1102, "Grilled, awaiting approval.\n")],
      { draftArtifacts: [1102] },
    );
    assert.equal(picks.devReady, "issue-1102",
      "a fresh draft artifact is still grill-clear (Phase B warn-only)");
    assert.equal(picks.artifactApproved, "false",
      "a draft (unapproved) artifact must never set the approval flag");
  });

  test("mechanical (cleanup-scan) exemption -> artifact_approved=false", () => {
    const picks = runGate([
      issue(1103, "remove dead export.\n", ["ready-for-agent", "cleanup-scan"]),
    ]);
    assert.equal(picks.devReady, "issue-1103");
    assert.equal(picks.artifactApproved, "false",
      "the mechanical exemption is grill-clear by construction, NOT via an artifact — must not claim approval");
  });

  test("trivial (T1-stamped) exemption -> artifact_approved=false", () => {
    const picks = runGate([
      issue(1104, "Trivial tweak.\n\nExpected tier: T1\n"),
    ]);
    assert.equal(picks.devReady, "issue-1104");
    assert.equal(picks.artifactApproved, "false",
      "the trivial exemption is grill-clear by construction, NOT via an artifact — must not claim approval");
  });

  test("no dev-ready anchor at all -> artifact_approved=false (conservative default)", () => {
    const picks = runGate([issue(1105, "No stamp, needs a grill.\n")]);
    assert.equal(picks.devReady, "none");
    assert.equal(picks.artifactApproved, "false");
  });

  test("emits false on an empty board", () => {
    const picks = runGate([]);
    assert.equal(picks.devReady, "none");
    assert.equal(picks.artifactApproved, "false");
  });

  test("the flag tracks the FIRST dev-ready pick, not a later approved one", () => {
    // issue-1110 is dev-ready via the trivial exemption (first, wins the
    // pick); issue-1111 has a genuine approved artifact but is never reached
    // because the first pick already resolved ORCH_DEV_READY_PICK.
    const picks = runGate(
      [
        issue(1110, "Trivial.\n\nExpected tier: T1\n"),
        issue(1111, "Approved artifact.\n"),
      ],
      { freshArtifacts: [1111] },
    );
    assert.equal(picks.devReady, "issue-1110");
    assert.equal(picks.artifactApproved, "false",
      "the pick is the exemption anchor; a later anchor's approved artifact must not leak onto it");
  });

  test("a genuinely approved artifact still wins when it is the FIRST candidate", () => {
    const picks = runGate(
      [
        issue(1120, "Approved artifact.\n"),
        issue(1121, "Trivial.\n\nExpected tier: T1\n"),
      ],
      { freshArtifacts: [1120] },
    );
    assert.equal(picks.devReady, "issue-1120");
    assert.equal(picks.artifactApproved, "true");
  });
});

describe("collect-state.sh — candidate order is STABLE, not newest-first (issue #3711)", () => {
  // Pre-#3711 the candidate list was `sort_by(.updatedAt) | reverse` — so every
  // newly-filed issue displaced the head and RE-EXTENDED the block. Filing a bug
  // mid-run rotated the grill anchor to the new issue and restarted the gate from
  // scratch (observed three times in run a1c24124). Ordering is now issue number
  // ascending: monotonic in creation order, so the head only changes when the
  // head itself drains.
  //
  // The `issue()` helper deliberately sets updatedAt DESCENDING with the issue
  // number (higher number = older timestamp), so a newest-first implementation
  // and a lowest-number-first implementation disagree — which is what makes
  // these assertions load-bearing rather than incidental.

  test("walks candidates lowest-issue-number first regardless of fixture order", () => {
    const picks = runGate([issue(902, "No stamp.\n"), issue(901, "No stamp.\n")]);
    assert.equal(picks.grill, "issue-901",
      "the lowest-numbered (oldest) anchor is promoted, whatever order gh returned");
  });

  test("a newly-filed issue does NOT displace the head of the queue", () => {
    // #3711's sub-defect (a) verbatim: filing issue-999 mid-run must not steal
    // the anchor from the already-waiting issue-801.
    const picks = runGate([issue(999, "Just filed.\n"), issue(801, "Waiting a while.\n")]);
    assert.equal(picks.grill, "issue-801",
      "a freshly-filed higher-numbered issue must sort to the BACK, never re-extend the block");
  });

  test("the 10-candidate cap keeps the OLDEST ten, so the pool itself is stable", () => {
    // The cap moved out of the jq into the python extractor for this reason:
    // capping a newest-first list rotates the candidate POOL, not just its order.
    // 12 issues, all un-grilled — the pick must be the lowest number present.
    const many = Array.from({ length: 12 }, (_, i) => issue(1000 + i, "No stamp.\n"));
    const picks = runGate(many.reverse());
    assert.equal(picks.grill, "issue-1000",
      "the oldest candidate must survive the cap and win the pick");
  });
});

describe("collect-state.sh — in-flight dev work is not a grill anchor (issue #3711)", () => {
  // Sub-defect (b): the gate demanded a design concept for the very anchor
  // dev_orch was implementing. An anchor with dev work already in flight is
  // excluded from BOTH picks — a concept produced after the PR exists is
  // retro-active waste, and dev must not re-pick it either.
  //
  // This cannot weaken the gate: the predicate needs POSITIVE evidence that dev
  // work happened (an open PR referencing the issue, or the `in-progress`
  // label). A never-built un-grilled anchor matches neither and still grills —
  // pinned by the last two tests here.

  test("an issue with an open PR on an `issue-<N>-` branch is excluded", () => {
    const picks = runGate([issue(850, "No stamp.\n")], {
      openPrs: [{ headRefName: "issue-850-fix-the-thing", body: "" }],
    });
    assert.equal(picks.grill, "none",
      "an anchor that already has an open dev PR must not be promoted to a grill");
    assert.equal(picks.devReady, "none", "nor offered to dev as a fresh pin");
  });

  test("a `Closes #N` body ref excludes the issue even from an anonymous branch", () => {
    // The harness creates `worktree-agent-<hash>` branches that carry no issue
    // number, so the PR body's closing keyword is the only available signal.
    const picks = runGate([issue(851, "No stamp.\n")], {
      openPrs: [{ headRefName: "worktree-agent-abc123def456", body: "Some work.\n\nCloses #851\n" }],
    });
    assert.equal(picks.grill, "none",
      "a closing-keyword ref must exclude the anchor when the branch name cannot");
  });

  test("the `in-progress` label excludes an issue from both picks", () => {
    const picks = runGate([issue(852, "No stamp.\n", ["ready-for-agent", "in-progress"])]);
    assert.equal(picks.grill, "none", "an in-progress anchor is already being built");
    assert.equal(picks.devReady, "none");
  });

  test("an in-flight anchor is skipped and a LATER anchor still grills", () => {
    // The exclusion must behave like the mechanical/trivial gates: skip and
    // keep walking, never abort the loop.
    const picks = runGate([issue(860, "No stamp.\n"), issue(861, "No stamp.\n")], {
      openPrs: [{ headRefName: "issue-860-wip", body: "" }],
    });
    assert.equal(picks.grill, "issue-861",
      "an excluded in-flight anchor must not block grilling of a later anchor");
  });

  test("an unrelated open PR does NOT suppress a genuinely un-grilled anchor", () => {
    // The load-bearing non-weakening guard: an open PR for some OTHER issue
    // leaves issue-870 fully eligible, so it still gets its design concept.
    const picks = runGate([issue(870, "No stamp.\n")], {
      openPrs: [{ headRefName: "issue-999-unrelated", body: "Closes #998\n" }],
    });
    assert.equal(picks.grill, "issue-870",
      "an un-grilled anchor with no dev work of its own must STILL be grilled");
  });

  test("a gh failure yields an empty exclusion set (degrades to pre-#3711 behaviour)", () => {
    // `openPrs: []` is also what a gh outage produces — the exclusion is
    // best-effort and its absence must never suppress a needed grill.
    const picks = runGate([issue(880, "No stamp.\n")], { openPrs: [] });
    assert.equal(picks.grill, "issue-880",
      "no PR data → no exclusions → the anchor is promoted exactly as before");
  });
});
