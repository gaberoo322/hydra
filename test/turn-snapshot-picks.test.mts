/**
 * Turn Snapshot — grill/dev-ready picks, Candidate Exclusions, merged-PR
 * refusal and active_dev_orch (ADR-0043 slice 3, #4931).
 *
 * All at the TS interface with NO `gh` on PATH and no source-text extraction:
 *
 * 1. GOLDEN (ADR-0043 Decision 4): every file under
 *    test/fixtures/turn-snapshot/picks/ was captured by running the OLD bash
 *    collectors (collect_orch_grill_candidates, collect_orch_merged_prs,
 *    collect_orch_grill_and_dev_ready_picks, collect_candidate_exclusions,
 *    collect_active_dev_orch at the slice's base SHA, `--jq` filters applied
 *    by the real jq) over each fixture the pre-slice tests used plus failure
 *    paths. Each replays through `collectPicks` + the production
 *    `TurnSnapshotGithub` port over a recording transport: the TYPED value
 *    (`expected.values`, captured while the retired kv wire still matched the
 *    bash byte for byte, #4934), the stderr lines exactly, the
 *    orch-board degraded verdict, the
 *    design-concept probe order, and the same underlying gh reads (the bash's
 *    `--jq` post-filters now run in TS, and its duplicate ready-for-agent read
 *    is shared).
 *
 * 2. PORTED behavioural cases, 1:1 (same fixtures, same assertions) from
 *    test/autopilot-grill-gate.test.mts (#1088, #1230, #3711, #4254, #4690),
 *    test/board-state.test.mts (#3965, #4823) and
 *    test/autopilot-dev-orch-gate.test.mts (#412, #3687, #4048) — driven
 *    through the real CLI `main` (pr-gate + picks in one run, the in-flight
 *    sets crossing in-process) or the exported pure classifiers.
 *
 * 3. The CLI / port contract for the new collector.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { main } from "../scripts/autopilot/turn-snapshot.ts";
import {
  blockedDependencyIssues,
  blockerRefUnion,
  collectPicks,
  countActiveDevOrch,
  grillCandidates,
  mergedRefIssues,
  openBlockers,
  parseGlmWithheld,
} from "../src/autopilot/turn-snapshot/picks.ts";
import {
  createTurnSnapshotGithub,
  READY_FOR_AGENT_ISSUE_FIELDS,
  type GhJsonRead,
  type GhTransport,
  type TurnSnapshotGithub,
} from "../src/autopilot/turn-snapshot/github-port.ts";
import { createTurnSnapshotHydra, type TurnSnapshotHydra } from "../src/autopilot/turn-snapshot/hydra-http.ts";

/** A full unified hydra client whose reads all fail, overridden per test (only designConceptBody matters to picks). */
function fakeHydra(o: Partial<TurnSnapshotHydra> = {}): TurnSnapshotHydra {
  const down = { kind: "failed", reason: "transport: ECONNREFUSED" } as const;
  return { get: async () => down, orchBoardState: async () => down, targetBoardState: async () => down, designConceptBody: async () => "", ...o };
}
import { DEFAULT_GITHUB_REPO } from "../src/github/issues.ts";
import { extractStrictBlockerRefs } from "../src/github/blockers.ts";
import {
  glmGrillExemption,
  glmPickVerdict,
  type GlmGrillExemption,
  type GlmPickContext,
  type GlmPickRow,
  type GlmPickVerdict,
} from "../src/glm/eligibility.ts";
import { ORCH_BOARD_LABELS } from "../src/board-labels.ts";
import { withGoldenValues } from "./_helpers/turn-snapshot-golden.mts";

const GOLDEN_DIR = resolve(import.meta.dirname, "fixtures", "turn-snapshot", "picks");
const PICKS_SRC = readFileSync(resolve(import.meta.dirname, "..", "src", "autopilot", "turn-snapshot", "picks.ts"), "utf-8");

const ok = (data: unknown): GhJsonRead => ({ kind: "ok", data });
const EMPTY: GhJsonRead = { kind: "empty" };

// ---------------------------------------------------------------------------
// 1. Golden files
// ---------------------------------------------------------------------------

interface GoldenRead {
  stdout: string;
  exitCode: number;
}

interface PicksGolden {
  name: string;
  nowMs: number;
  inputs: { inflight: { union: string; branch: string; body: string }; boardState: string | null };
  reads: {
    readyForAgent: GoldenRead;
    openBlockerSearch: GoldenRead;
    mergedPrs: GoldenRead;
    openDevPrs: GoldenRead;
    designConcepts: Record<string, string>;
  };
  expected: {
    /** `{ picks: <typed PicksSnapshot> }`. */
    values: Record<string, unknown>;
    stderrLines: string[];
    boardDegraded: boolean;
    bashGhCalls: string[][];
    designConceptProbes: number[];
  };
}

function goldenKey(args: string[]): keyof Omit<PicksGolden["reads"], "designConcepts"> | null {
  if (args.includes(READY_FOR_AGENT_ISSUE_FIELDS)) return "readyForAgent";
  if (args.includes("--search")) return "openBlockerSearch";
  if (args.includes("number,title,body")) return "mergedPrs";
  if (args.includes("updatedAt,headRefName,labels")) return "openDevPrs";
  return null;
}

/**
 * The reads the TS collector issues, derived from the bash's: the same gh
 * calls minus their `--jq` post-filter (now TS: `dropTargetBacklog`,
 * `countActiveDevOrch`), with the bash's second, byte-identical ready-for-agent
 * read (the Candidate Exclusion pool) shared with the first.
 */
function expectedTsCalls(bash: string[][]): string[][] {
  const stripped = bash.map((c) => {
    const i = c.indexOf("--jq");
    return i === -1 ? c : [...c.slice(0, i), ...c.slice(i + 2)];
  });
  const seen = new Set<string>();
  return stripped.filter((c) => {
    if (!c.includes(READY_FOR_AGENT_ISSUE_FIELDS)) return true;
    const k = JSON.stringify(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const nums = (s: string) => (s === "" ? [] : s.split(" ").map(Number));

const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();

describe("Turn Snapshot picks — golden files from the bash collectors (ADR-0043 D4)", () => {
  test("the golden corpus is present (guards a vacuous pass)", () => {
    assert.ok(goldenFiles.length >= 100, `expected the captured corpus, found ${goldenFiles.length} files`);
  });

  for (const file of goldenFiles) {
    const g = withGoldenValues("picks", file, JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8")) as PicksGolden);
    test(`golden: ${g.name}`, async () => {
      const calls: string[][] = [];
      const transport: GhTransport = async (args) => {
        calls.push([...args]);
        const key = goldenKey(args);
        const r = key === null ? undefined : g.reads[key];
        if (r === undefined) return { ok: false, stderr: `unscripted call: ${args.join(" ")}` };
        return r.exitCode === 0 ? { ok: true, stdout: r.stdout, stderr: "" } : { ok: false, stderr: "" };
      };
      const probes: number[] = [];
      const hydra: Pick<TurnSnapshotHydra, "designConceptBody"> = {
        designConceptBody: async (n) => {
          probes.push(n);
          return g.reads.designConcepts[String(n)] ?? "";
        },
      };
      const outcome = await collectPicks({
        github: createTurnSnapshotGithub({ transport, repo: DEFAULT_GITHUB_REPO }),
        hydra,
        now: () => g.nowMs,
        ghListLimit: 100,
        inflight: { union: nums(g.inputs.inflight.union), branch: nums(g.inputs.inflight.branch), body: nums(g.inputs.inflight.body) },
        boardState: g.inputs.boardState,
      });
      assert.deepEqual(JSON.parse(JSON.stringify({ picks: outcome.value })), g.expected.values, "the typed value must match the golden");
      assert.deepEqual(outcome.notes, g.expected.stderrLines, "the stderr lines must match, in order");
      assert.equal(outcome.value.boardDegraded, g.expected.boardDegraded, "the ORCH_BOARD_DEGRADED verdict must match");
      assert.deepEqual(probes, g.expected.designConceptProbes, "the same design-concept probes, in the same order");
      assert.deepEqual(calls, expectedTsCalls(g.expected.bashGhCalls), "the same underlying gh reads");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Ported behavioural cases — the pick walk (from autopilot-grill-gate)
// ---------------------------------------------------------------------------

const NOW_MS = 1_800_000_000_000;

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

interface MergedPr {
  title: string;
  body: string;
}

interface GateOpts {
  /** Issue numbers whose design-concept probe returns a FRESH artifact; everything else 404s. */
  freshArtifacts?: number[];
  /** The open-PR read the pr-gate collector's in-flight sets come from (#3711). */
  openPrs?: OpenPr[];
  /** The merged-PR read (#4690). */
  mergedPrs?: MergedPr[];
  /** Make the merged-PR read FAIL (empty payload). */
  mergedFetchFails?: boolean;
  /** When set, a HEALTHY board-state body carrying this glm_withheld list (#4254); absent = degraded read. */
  glmWithheld?: number[];
}

interface GatePicks {
  /** The CLI's `--format values` JSON. */
  stdout: string;
  stderr: string;
  /** The picks as Anchor references (`issue-N`), `none` when there is none. */
  grill: string;
  devReady: string;
  /** How many merged-PR reads the pass issued. */
  mergedReads: number;
}

/** A fake port: typed reads, no argv. pr-gate reads answer "nothing to classify". */
function fakeGithub(issues: unknown[], opts: GateOpts, counters: { merged: number }): TurnSnapshotGithub {
  return {
    // slice 2 (#4930) reads — unused by pr-gate/picks
    listOpenIssueBoardRows: async () => ok([]),
    listOpenIssueLabelRows: async () => ok([]),
    listOpenPrs: async () => ok(opts.openPrs ?? []),
    listOpenPrMergeStates: async () => ({ read: ok([]), stderrHead: "" }),
    latestWorkflowRunCreatedAt: async () => null,
    requiredStatusContexts: async () => ok([]),
    openIssueNumbersByLabel: async () => ok([]),
    listReadyForAgentIssues: async () => ok(issues),
    searchOpenIssueNumbers: async () => ok([]),
    listMergedPrs: async () => {
      counters.merged++;
      return opts.mergedFetchFails ? EMPTY : ok(opts.mergedPrs ?? []);
    },
    listOpenPrHeads: async () => ok([]),
    // slice 5B (#4933) reads — unused by pr-gate/picks
    openIssuesWithLabel: async () => ok([]),
    openIssueLabelsWithLabel: async () => ok([]),
    openIssueAssigneesWithLabel: async () => ok([]),
    wayfinderMapSubIssues: async () => ok([]),
    // slice 4 (#4932) Target-board reads — issued on the Target repo's port, never this one
    listOpenIssueLabelNames: async () => ok([]),
    listOpenPullsRest: async () => ok([]),
    listOpenIssuesByLabelRest: async () => ok([]),
  };
}

/**
 * Run the real CLI (`--collectors pr-gate,picks`) over a fake port and fake
 * HTTP and return both anchor picks. The ORDER of `issues` is irrelevant: the
 * collector sorts candidates by issue number ascending (#3711).
 */
async function runGate(issues: Issue[], opts: GateOpts = {}): Promise<GatePicks> {
  const counters = { merged: 0 };
  const fresh = new Set(opts.freshArtifacts ?? []);
  const hydra = fakeHydra({
    designConceptBody: async (n) => (fresh.has(n) ? JSON.stringify({ createdAt: NOW_MS, status: "approved" }) : ""),
  });
  const board =
    opts.glmWithheld === undefined
      ? null
      : JSON.stringify({ ready_for_agent: 1, degraded: false, sourcesOk: true, glm_withheld: opts.glmWithheld });
  let stdout = "";
  let stderr = "";
  const code = await main(
    ["--collectors", "pr-gate,picks", "--format", "values", ...(board === null ? [] : ["--board-state-file", "board.json"])],
    { github: fakeGithub(issues, opts, counters), hydra, now: () => NOW_MS, sleep: async () => {} },
    {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      readFile: () => board ?? "",
    },
  );
  assert.equal(code, 0);
  const picks = JSON.parse(stdout).picks;
  assert.ok(picks !== undefined, `the CLI did not return the picks (stderr: ${stderr})`);
  const ref = (n: number | null) => (n === null ? "none" : `issue-${n}`);
  return { stdout, stderr, grill: ref(picks.grillPick), devReady: ref(picks.devReadyPick), mergedReads: counters.merged };
}

/** Back-compat shim: the pre-#3711 tests assert only the grill pick. */
async function runGrillGate(issues: Issue[]): Promise<string> {
  return (await runGate(issues)).grill;
}

function issue(number: number, body: string, labels: string[] = [], title = "Some implementation work"): Issue {
  return {
    number,
    updatedAt: new Date(NOW_MS - number * 1000).toISOString(),
    body,
    labels: labels.map((name) => ({ name })),
    title,
  };
}

describe("Turn Snapshot picks — trivial-anchor grill gate (issue #1088)", () => {
  test("suppresses grill on an explicit 'Expected tier: T1' stamp", async () => {
    const pick = await runGrillGate([
      issue(101, "## Problem\nTrivial prompt tweak.\n\nExpected tier: T1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "a T1-stamped anchor must not be promoted to a grill",
    );
  });

  test("suppresses grill on the numeric 'Expected tier: 1' stamp form", async () => {
    const pick = await runGrillGate([
      issue(102, "Doc edit.\n\nExpected tier: 1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "the numeric 'Expected tier: 1' form is the same positive trivial signal",
    );
  });

  test("grills a T3-stamped anchor (non-trivial)", async () => {
    const pick = await runGrillGate([
      issue(103, "Core src/ change.\n\nExpected tier: T3\n"),
    ]);
    assert.equal(pick, "issue-103", "a T3 stamp must still grill");
  });

  test("grills a numeric T3-stamped anchor", async () => {
    const pick = await runGrillGate([
      issue(104, "Core change.\n\nExpected tier: 3\n"),
    ]);
    assert.equal(pick, "issue-104", "the numeric T3 form must still grill");
  });

  test("grills an UNSTAMPED anchor (unknown complexity → fail-toward-grill)", async () => {
    const pick = await runGrillGate([
      issue(105, "## Problem\nNo tier stamp anywhere in this body.\n"),
    ]);
    assert.equal(
      pick,
      "issue-105",
      "absence of any stamp must NEVER suppress — skip is the unsafe direction",
    );
  });

  test("grills a needs-design-concept anchor even when T1-stamped (label opt-in wins)", async () => {
    const pick = await runGrillGate([
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

  test("skips a T1 anchor and promotes the next non-trivial one", async () => {
    // Board order is newest-first; the loop walks it in order. The T1 anchor
    // is suppressed and the loop falls through to the unstamped one.
    const pick = await runGrillGate([
      issue(201, "Trivial.\n\nExpected tier: T1\n"),
      issue(202, "Complex, no stamp.\n"),
    ]);
    assert.equal(
      pick,
      "issue-202",
      "a suppressed T1 anchor must not block grilling of a later non-trivial anchor",
    );
  });

  test("emits 'none' when every candidate is trivially T1-stamped", async () => {
    const pick = await runGrillGate([
      issue(301, "Tweak A.\n\nExpected tier: T1\n"),
      issue(302, "Tweak B.\n\nExpected tier: 1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "an all-trivial board must produce no grill anchor",
    );
  });

  test("emits 'none' on an empty board", async () => {
    const pick = await runGrillGate([]);
    assert.equal(pick, "none", "no ready-for-agent issues → no grill anchor");
  });

  test("T1 substring inside a word does not count as a stamp (word-boundary)", async () => {
    // 'Expected tier: T12' is NOT a T1 stamp — the \b boundary guards it.
    const pick = await runGrillGate([
      issue(401, "Weird body.\n\nExpected tier: T12\n"),
    ]);
    assert.equal(
      pick,
      "issue-401",
      "'T12' must not be read as a trivial T1 stamp",
    );
  });

  test("stamp match is case-insensitive", async () => {
    const pick = await runGrillGate([
      issue(402, "lower.\n\nexpected tier: t1\n"),
    ]);
    assert.equal(
      pick,
      "none",
      "a lowercase 'expected tier: t1' stamp is still a positive trivial signal",
    );
  });
});

describe("Turn Snapshot picks — mechanical/non-implementable grill gate (issue #1230)", () => {
  test("suppresses grill on a cleanup-scan anchor (mechanical → straight to dev)", async () => {
    // A cleanup-scan finding is self-checking and needs no design concept,
    // even when its body carries no T1 stamp (so the #1088 trivial gate would
    // otherwise promote it).
    const pick = await runGrillGate([
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

  test("emits 'none' when every ready-for-agent issue is a cleanup-scan finding", async () => {
    // The acceptance criterion from #1230: a board whose only candidates are
    // cleanup-scan findings emits none so dev_orch dispatches directly.
    const pick = await runGrillGate([
      issue(501, "remove dead export A.\n", ["ready-for-agent", "cleanup-scan"]),
      issue(502, "remove dead file B.\n", ["ready-for-agent", "cleanup-scan"]),
    ]);
    assert.equal(
      pick,
      "none",
      "an all-cleanup-scan board must produce no grill anchor",
    );
  });

  test("skips a cleanup-scan anchor and promotes the next non-trivial one", async () => {
    // The cleanup-scan anchor is suppressed; the loop falls through to the
    // unstamped (non-mechanical) anchor, which still grills.
    const pick = await runGrillGate([
      issue(601, "remove dead code.\n", ["ready-for-agent", "cleanup-scan"]),
      issue(602, "Complex refactor, no stamp.\n", ["ready-for-agent"]),
    ]);
    assert.equal(
      pick,
      "issue-602",
      "a suppressed cleanup-scan anchor must not block grilling of a later non-trivial anchor",
    );
  });

  test("suppresses grill on a 'track:'-prefixed measurement-window tracker", async () => {
    // A track: tracker is calendar-bound and not implementable now — no design
    // concept should precede it. Title carries the prefix; body has no stamp.
    const pick = await runGrillGate([
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

  test("the track: prefix match is case-insensitive and tolerates leading space", async () => {
    const pick = await runGrillGate([
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

  test("a non-cleanup, non-track anchor still grills (no false suppression)", async () => {
    // Guard against over-broad suppression: 'tracking' is not the 'track:'
    // prefix, and an ordinary label set does not trigger the mechanical gate.
    const pick = await runGrillGate([
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

describe("Turn Snapshot picks — orch_dev_ready_anchor, the per-anchor half of the gate (issue #3711)", () => {
  // The same loop pass now emits a SECOND signal: the first already-GRILL-CLEAR
  // anchor. decide.py pins dev_orch to it instead of yielding board-wide, so a
  // growing board can no longer starve orchestrator development for a whole run.
  //
  // Both directions, per the originating issue's caution: the gated anchor is
  // still promoted for a grill AND a second eligible anchor is still offered to
  // dev the same turn.

  test("a fresh artifact makes an anchor dev-ready while a later anchor still grills", async () => {
    // THE headline both-directions case: issue-701 has an approved artifact,
    // issue-702 does not. The grill still targets 702; dev gets 701.
    const picks = await runGate(
      [issue(701, "Already grilled.\n"), issue(702, "Complex, no stamp.\n")],
      { freshArtifacts: [701] },
    );
    assert.equal(picks.grill, "issue-702",
      "the un-grilled anchor must still be promoted — the gate is not weakened");
    assert.equal(picks.devReady, "issue-701",
      "an anchor with a fresh artifact must be offered to dev_orch the same turn");
  });

  test("emits none/none on an empty board", async () => {
    const picks = await runGate([]);
    assert.equal(picks.grill, "none");
    assert.equal(picks.devReady, "none", "no candidates → nothing for dev to be pinned to");
  });

  test("a board of only un-grilled anchors offers NO dev pin (gate holds)", async () => {
    // This is the case that must still block dev_orch entirely.
    const picks = await runGate([issue(703, "No stamp.\n"), issue(704, "No stamp either.\n")]);
    assert.equal(picks.grill, "issue-703", "the oldest un-grilled anchor is promoted");
    assert.equal(picks.devReady, "none",
      "no grill-clear anchor exists, so decide.py must still yield");
  });

  test("a T1-stamped anchor is dev-ready (trivial gate #1088 → grill-clear)", async () => {
    const picks = await runGate([
      issue(710, "Trivial tweak.\n\nExpected tier: T1\n"),
      issue(711, "Complex, no stamp.\n"),
    ]);
    assert.equal(picks.grill, "issue-711");
    assert.equal(picks.devReady, "issue-710",
      "a T1-stamped anchor needs no concept by construction, so it is a valid dev pin");
  });

  test("a cleanup-scan anchor is dev-ready (mechanical gate #1230 → grill-clear)", async () => {
    const picks = await runGate([
      issue(720, "remove dead export.\n", ["ready-for-agent", "cleanup-scan"]),
      issue(721, "Complex, no stamp.\n"),
    ]);
    assert.equal(picks.grill, "issue-721");
    assert.equal(picks.devReady, "issue-720",
      "a cleanup-scan finding is self-checking and routes straight to dev");
  });

  test("a 'track:' tracker is suppressed for BOTH picks (not implementable now)", async () => {
    // The mechanical gate suppresses the grill for a calendar-bound tracker, but
    // unlike cleanup-scan it must NOT become a dev pin — its window is open.
    const picks = await runGate([
      issue(730, "Window closes later.\n", ["ready-for-agent"], "track: weekly merge-rate baseline"),
    ]);
    assert.equal(picks.grill, "none", "a track: tracker is not a grill candidate (#1230)");
    assert.equal(picks.devReady, "none",
      "a track: tracker is not implementable now, so it must never be pinned to dev");
  });

  test("the dev pick is the FIRST grill-clear anchor, not merely any of them", async () => {
    const picks = await runGate(
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

describe("Turn Snapshot picks — candidate order is STABLE, not newest-first (issue #3711)", () => {
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

  test("walks candidates lowest-issue-number first regardless of fixture order", async () => {
    const picks = await runGate([issue(902, "No stamp.\n"), issue(901, "No stamp.\n")]);
    assert.equal(picks.grill, "issue-901",
      "the lowest-numbered (oldest) anchor is promoted, whatever order gh returned");
  });

  test("a newly-filed issue does NOT displace the head of the queue", async () => {
    // #3711's sub-defect (a) verbatim: filing issue-999 mid-run must not steal
    // the anchor from the already-waiting issue-801.
    const picks = await runGate([issue(999, "Just filed.\n"), issue(801, "Waiting a while.\n")]);
    assert.equal(picks.grill, "issue-801",
      "a freshly-filed higher-numbered issue must sort to the BACK, never re-extend the block");
  });

  test("the 10-candidate cap keeps the OLDEST ten, so the pool itself is stable", async () => {
    // The cap moved out of the jq into the python extractor for this reason:
    // capping a newest-first list rotates the candidate POOL, not just its order.
    // 12 issues, all un-grilled — the pick must be the lowest number present.
    const many = Array.from({ length: 12 }, (_, i) => issue(1000 + i, "No stamp.\n"));
    const picks = await runGate(many.reverse());
    assert.equal(picks.grill, "issue-1000",
      "the oldest candidate must survive the cap and win the pick");
  });
});

describe("Turn Snapshot picks — in-flight dev work is not a grill anchor (issue #3711)", () => {
  // Sub-defect (b): the gate demanded a design concept for the very anchor
  // dev_orch was implementing. An anchor with dev work already in flight is
  // excluded from BOTH picks — a concept produced after the PR exists is
  // retro-active waste, and dev must not re-pick it either.
  //
  // This cannot weaken the gate: the predicate needs POSITIVE evidence that dev
  // work happened (an open PR referencing the issue, or the `in-progress`
  // label). A never-built un-grilled anchor matches neither and still grills —
  // pinned by the last two tests here.

  test("an issue with an open PR on an `issue-<N>-` branch is excluded", async () => {
    const picks = await runGate([issue(850, "No stamp.\n")], {
      openPrs: [{ headRefName: "issue-850-fix-the-thing", body: "" }],
    });
    assert.equal(picks.grill, "none",
      "an anchor that already has an open dev PR must not be promoted to a grill");
    assert.equal(picks.devReady, "none", "nor offered to dev as a fresh pin");
  });

  test("a `Closes #N` body ref excludes the issue even from an anonymous branch", async () => {
    // The harness creates `worktree-agent-<hash>` branches that carry no issue
    // number, so the PR body's closing keyword is the only available signal.
    const picks = await runGate([issue(851, "No stamp.\n")], {
      openPrs: [{ headRefName: "worktree-agent-abc123def456", body: "Some work.\n\nCloses #851\n" }],
    });
    assert.equal(picks.grill, "none",
      "a closing-keyword ref must exclude the anchor when the branch name cannot");
  });

  test("the `in-progress` label excludes an issue from both picks", async () => {
    const picks = await runGate([issue(852, "No stamp.\n", ["ready-for-agent", "in-progress"])]);
    assert.equal(picks.grill, "none", "an in-progress anchor is already being built");
    assert.equal(picks.devReady, "none");
  });

  test("an in-flight anchor is skipped and a LATER anchor still grills", async () => {
    // The exclusion must behave like the mechanical/trivial gates: skip and
    // keep walking, never abort the loop.
    const picks = await runGate([issue(860, "No stamp.\n"), issue(861, "No stamp.\n")], {
      openPrs: [{ headRefName: "issue-860-wip", body: "" }],
    });
    assert.equal(picks.grill, "issue-861",
      "an excluded in-flight anchor must not block grilling of a later anchor");
  });

  test("an unrelated open PR does NOT suppress a genuinely un-grilled anchor", async () => {
    // The load-bearing non-weakening guard: an open PR for some OTHER issue
    // leaves issue-870 fully eligible, so it still gets its design concept.
    const picks = await runGate([issue(870, "No stamp.\n")], {
      openPrs: [{ headRefName: "issue-999-unrelated", body: "Closes #998\n" }],
    });
    assert.equal(picks.grill, "issue-870",
      "an un-grilled anchor with no dev work of its own must STILL be grilled");
  });

  test("a gh failure yields an empty exclusion set (degrades to pre-#3711 behaviour)", async () => {
    // `openPrs: []` is also what a gh outage produces — the exclusion is
    // best-effort and its absence must never suppress a needed grill.
    const picks = await runGate([issue(880, "No stamp.\n")], { openPrs: [] });
    assert.equal(picks.grill, "issue-880",
      "no PR data → no exclusions → the anchor is promoted exactly as before");
  });
});

describe("Turn Snapshot picks — a GLM-withheld anchor is never the dev pin (issue #4254)", () => {
  // The count path (`deriveBoardState` → `isGlmWithheldFromClaude`) subtracts a
  // glm-eligible issue from `ready_for_agent` while the drainer is live, but the
  // pick loop used to pin `orch_dev_ready_anchor` unconditionally — so decide.py
  // (which MUST honour a pin) put a paid dev_orch onto the one issue the free
  // z.ai lane owns (run 8e50460f: #4247 pinned while eleven non-GLM issues sat).
  //
  // The fix is ONE DERIVED PREDICATE: the board-state response carries
  // `glm_withheld` (issue numbers, computed from the SAME liveness read as the
  // count) and this script refuses a pin on a member at each of the three pick
  // sites. The label rule is NOT re-spelled in shell — the stub below hands the
  // script issue NUMBERS only, which is exactly the contract.

  test("[N fresh, M fresh] with N withheld → the pin is M, not N (walk continues past the refusal)", async () => {
    // The observed 8e50460f shape: the lowest-numbered grill-clear anchor is
    // the GLM one. Pre-#4254 this pinned issue-4247.
    const picks = await runGate(
      [issue(4247, "Grilled, drainer-owned.\n"), issue(4255, "Grilled.\n")],
      { freshArtifacts: [4247, 4255], glmWithheld: [4247] },
    );
    assert.equal(picks.devReady, "issue-4255",
      "the withheld anchor must be refused and the NEXT grill-clear anchor pinned — never 'none'");
    assert.equal(picks.grill, "none", "both anchors are grill-clear; nothing to grill");
  });

  test("a refused fresh-artifact pick is the only anchor → devReady=none", async () => {
    const picks = await runGate([issue(4247, "Grilled, drainer-owned.\n")], {
      freshArtifacts: [4247],
      glmWithheld: [4247],
    });
    assert.equal(picks.devReady, "none");
  });

  test("a fresh-artifact anchor outside the withheld set is still pinned (guard is inert for non-members)", async () => {
    const picks = await runGate([issue(4255, "Grilled.\n")], {
      freshArtifacts: [4255],
      glmWithheld: [4247],
    });
    assert.equal(picks.devReady, "issue-4255");
  });

  test("the retired design-concept status signal is no longer emitted (issue #4821)", async () => {
    // #3798's `orch_dev_ready_anchor_design_concept_status` fed the
    // first-attempt frontier-routing hint, removed by #4821. A pinned
    // fresh-artifact anchor is the one case that used to emit a non-"none"
    // value, so it is the case that must now emit nothing at all.
    const picks = await runGate([issue(4255, "Grilled.\n")], { freshArtifacts: [4255] });
    assert.equal(picks.devReady, "issue-4255");
    assert.equal(/design_?concept_?status/i.test(picks.stdout), false,
      "the Turn Snapshot must not carry the retired status key");
  });

  test("[N cleanup-scan] with N withheld → devReady=none (mechanical exemption site guarded)", async () => {
    const picks = await runGate(
      [issue(4247, "remove dead export.\n", ["ready-for-agent", "cleanup-scan"])],
      { glmWithheld: [4247] },
    );
    assert.equal(picks.devReady, "none",
      "a withheld cleanup-scan anchor is the drainer's to build, not dev_orch's");
    assert.equal(picks.grill, "none", "cleanup-scan still needs no grill");
  });

  test("[N T1-trivial] with N withheld → devReady=none (trivial exemption site guarded)", async () => {
    const picks = await runGate(
      [issue(4247, "Trivial tweak.\n\nExpected tier: T1\n")],
      { glmWithheld: [4247] },
    );
    assert.equal(picks.devReady, "none",
      "a withheld T1 anchor is the drainer's to build, not dev_orch's");
    assert.equal(picks.grill, "none", "a T1 stamp still suppresses the grill");
  });

  test("[N no artifact] with N withheld → grill=issue-N (the grill path STILL sees it)", async () => {
    // ADR-0032 invariant 2 / the #3870 fix: design_concept_orch designs every
    // glm-eligible issue. The guard is a soft refusal at the pick sites, not a
    // hard skip at candidate construction, so the withheld anchor still grills.
    const picks = await runGate([issue(4247, "Complex, no stamp.\n")], {
      glmWithheld: [4247],
    });
    assert.equal(picks.grill, "issue-4247",
      "a withheld anchor lacking an artifact must STILL become the pending-grill anchor");
    assert.equal(picks.devReady, "none");
  });

  test("[N fresh] with the OLD blanket exit-1 hydra stub → devReady=issue-N (fail-open on a down API)", async () => {
    // No `glmWithheld` → the historical stub → BOARD_STATE_DEGRADED=1 → the
    // withheld set is EMPTY and the pin behaves exactly as before #4254.
    const picks = await runGate([issue(4247, "Grilled.\n")], { freshArtifacts: [4247] });
    assert.equal(picks.devReady, "issue-4247",
      "unknown partition state never withholds — a degraded read must not refuse a pin");
  });

  test("a healthy board-state with an EMPTY glm_withheld list refuses nothing", async () => {
    const picks = await runGate([issue(4247, "Grilled.\n")], {
      freshArtifacts: [4247],
      glmWithheld: [],
    });
    assert.equal(picks.devReady, "issue-4247");
  });

  test("membership is exact-number: 424 and 2470 are NOT withheld by member 4247", async () => {
    const picks = await runGate(
      [issue(424, "Grilled.\n"), issue(2470, "Grilled.\n"), issue(4247, "Grilled.\n")],
      { freshArtifacts: [424, 2470, 4247], glmWithheld: [4247] },
    );
    assert.equal(picks.devReady, "issue-424",
      "a substring of a withheld number must not match — the test is space-delimited exact");
  });

  test("the withheld guard does not disturb an unrelated board (every non-member pins as before)", async () => {
    const picks = await runGate(
      [issue(4255, "No stamp.\n"), issue(4256, "Grilled.\n")],
      { freshArtifacts: [4256], glmWithheld: [4247] },
    );
    assert.equal(picks.grill, "issue-4255");
    assert.equal(picks.devReady, "issue-4256");
  });
});

describe("Turn Snapshot picks — a merged-PR-referenced anchor is never the dev pin (issue #4690)", () => {
  // ADR-0040 Decision 4 row 7 / Decision 6 ("the Claude lane adopts the
  // merged-PR skip"): a MERGED PR answers "did work for this issue already
  // ship". An issue still open after such a merge is open only because the
  // PR body carried no closing keyword (the 2026-08-27 #4236/#4130 incident:
  // the already-merged work was re-dispatched every tick for ~90 min). The
  // rule is the drainer's `issue_has_merged_pr`: a closing verb over the
  // merged PR's title+body OR a bare `(#N)` title anchor — computed by
  // `pr-refs.py --merged`, NOT re-spelled in shell. Only the dev PIN is
  // refused: the grill path still sees the anchor and the issue is NOT
  // relabelled — closing or re-scoping stays a human call.

  test("a fresh-artifact anchor referenced by a merged PR titled `fix: x (#N)` is not pinned and logs merged-pr-referenced", async () => {
    const picks = await runGate(
      [issue(4130, "Grilled.\n")],
      { freshArtifacts: [4130], mergedPrs: [{ title: "fix: x (#4130)", body: "" }] },
    );
    // Fresh artifact → grill-clear, so it is NOT a grill candidate…
    assert.equal(picks.grill, "none");
    // …but the shipped-work guard refuses the pin, and says why on stderr
    // (INV-6: the literal token + the issue-<N> anchor, not-relabelled note).
    assert.equal(picks.devReady, "none");
    assert.match(picks.stderr, /merged-pr-referenced/);
    assert.match(picks.stderr, /issue-4130/);
  });

  test("a closing verb in the merged PR's body refuses the pin too (both halves of the rule)", async () => {
    const picks = await runGate(
      [issue(4130, "Grilled.\n")],
      {
        freshArtifacts: [4130],
        mergedPrs: [{ title: "unrelated subject", body: "Work shipped.\n\nCloses #4130" }],
      },
    );
    assert.equal(picks.devReady, "none");
    assert.match(picks.stderr, /merged-pr-referenced/);
  });

  test("a non-closing `Refs #N` merged body does NOT refuse the pin (excluded form)", async () => {
    const picks = await runGate(
      [issue(4130, "Grilled.\n")],
      { freshArtifacts: [4130], mergedPrs: [{ title: "unrelated subject", body: "Refs #4130" }] },
    );
    assert.equal(picks.devReady, "issue-4130");
    assert.doesNotMatch(picks.stderr, /merged-pr-referenced/);
  });

  test("membership is exact-number: an anchor of 4130 is not refused by a merged PR anchored (#41300)", async () => {
    const picks = await runGate(
      [issue(4130, "Grilled.\n")],
      { freshArtifacts: [4130], mergedPrs: [{ title: "fix: x (#41300)", body: "" }] },
    );
    assert.equal(picks.devReady, "issue-4130");
  });

  test("[N cleanup-scan] with N merged-referenced → devReady=none (mechanical exemption site guarded)", async () => {
    const picks = await runGate(
      [issue(4130, "remove dead export.\n", ["ready-for-agent", "cleanup-scan"])],
      { mergedPrs: [{ title: "fix: x (#4130)", body: "" }] },
    );
    assert.equal(picks.devReady, "none");
    assert.match(picks.stderr, /merged-pr-referenced/);
  });

  test("[N T1-trivial] with N merged-referenced → devReady=none (trivial exemption site guarded)", async () => {
    const picks = await runGate(
      [issue(4130, "Trivial.\n\nExpected tier: T1\n")],
      { mergedPrs: [{ title: "fix: x (#4130)", body: "" }] },
    );
    assert.equal(picks.devReady, "none");
    assert.match(picks.stderr, /merged-pr-referenced/);
  });

  test("the grill path STILL sees a merged-referenced anchor (only the pin is refused)", async () => {
    const picks = await runGate(
      [issue(4130, "No stamp.\n")],
      { mergedPrs: [{ title: "fix: x (#4130)", body: "" }] },
    );
    assert.equal(picks.grill, "issue-4130");
    assert.equal(picks.devReady, "none");
  });

  test("a refused pin walks on to the next grill-clear anchor", async () => {
    const picks = await runGate(
      [issue(4130, "Grilled.\n"), issue(4131, "Grilled.\n")],
      {
        freshArtifacts: [4130, 4131],
        mergedPrs: [{ title: "fix: x (#4130)", body: "" }],
      },
    );
    assert.equal(picks.devReady, "issue-4131");
  });

  test("a failed merged-PR fetch degrades to no refusal that pass (fail-open) and logs a WARN", async () => {
    const picks = await runGate(
      [issue(4130, "Grilled.\n")],
      { freshArtifacts: [4130], mergedFetchFails: true },
    );
    assert.equal(picks.devReady, "issue-4130");
    assert.match(picks.stderr, /WARN/);
    assert.match(picks.stderr, /merged-PR/);
  });

  test("the merged set is its own read: exactly ONE merged-PR fetch per pass, none when no pin is possible (INV-3)", async () => {
    // Was a source-text check of the bash's single `gh pr list --state merged`
    // call; now the read count itself is asserted.
    const withCandidates = await runGate([issue(4130, "Grilled.\n")], { freshArtifacts: [4130] });
    assert.equal(withCandidates.mergedReads, 1, "exactly one merged-PR fetch per pass");
    const noCandidates = await runGate([]);
    assert.equal(noCandidates.mergedReads, 0, "no candidates → no pin is possible → no fetch is paid");
  });
});

describe("Turn Snapshot picks — the GLM-withheld set is DERIVED, never re-spelled (issue #4254)", () => {
  // The label rule lives ONLY in src/autopilot/board-state.ts. The picks
  // collector handles issue NUMBERS off board-state's glm_withheld, and must
  // carry neither label literal nor a liveness read of its own — the mirror
  // class #4253 documents drifting. (Ported from the bash pick-guard region.)
  test("the picks collector contains no `glm-eligible` label literal", () => {
    assert.ok(!PICKS_SRC.includes("glm-eligible"), "the guard must consume board-state's glm_withheld, not mirror the label rule");
  });

  test("the picks collector contains no `glm-ab-control` carve-out literal", () => {
    assert.ok(!PICKS_SRC.includes("glm-ab-control"), "the carve-out that drifted in #4253 must live only in isGlmWithheldFromClaude");
  });

  test("the picks collector performs no Redis liveness read of its own", () => {
    assert.ok(!/redis/i.test(PICKS_SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "liveness is resolved once, server-side, in the same board-state request as the count");
  });

  // The parse (was: extract-and-run the python block): every malformed input → empty set → fail-open.
  const parseWithheld = (input: string | null) => [...parseGlmWithheld(input)].sort((a, b) => a - b).join(" ");

  test("a well-formed list parses to a sorted, space-separated set", () => {
    assert.equal(parseWithheld('{"glm_withheld":[4247,12,4247]}'), "12 4247");
  });

  test("a missing field (older service) parses to the empty set", () => {
    assert.equal(parseWithheld('{"ready_for_agent":3}'), "");
  });

  test("a non-list value parses to the empty set", () => {
    assert.equal(parseWithheld('{"glm_withheld":"4247"}'), "");
  });

  test("garbage and empty stdin parse to the empty set (never a traceback)", () => {
    assert.equal(parseWithheld("garbage"), "");
    assert.equal(parseWithheld(""), "");
  });

  test("non-positive, non-int and boolean members are dropped", () => {
    assert.equal(parseWithheld('{"glm_withheld":[0,-1,"7",true,3.5,99]}'), "99");
  });
});

// ---------------------------------------------------------------------------
// The grill-exemption table (ADR-0040 Decision 5). The collector now calls
// glmGrillExemption directly, so the python MECHANICAL / TRIVIAL twins and
// their cross-language parity check retired with ADR-0043 slice 3; the
// table's TS assertions stay.
// ---------------------------------------------------------------------------

const RFA = ORCH_BOARD_LABELS.ready_for_agent;
const ELIG = ORCH_BOARD_LABELS.glm_eligible;
const CLEANUP = ORCH_BOARD_LABELS.cleanup_scan;
const NDC = ORCH_BOARD_LABELS.needs_design_concept;
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function ctx(over: Partial<GlmPickContext> = {}): GlmPickContext {
  return {
    artifact: null,
    openPrs: [],
    mergedPrs: [],
    openBlockers: new Set(),
    now: NOW,
    ...over,
  };
}

/**
 * One table row. `artifact` is the design-concept context for the verdict.
 * `row: null` was a python-only fail-closed case (issue absent from the list):
 * its TS counterpart is `candidateExemption` returning `null` for a missing row.
 */
interface ParityCase {
  name: string;
  n: number;
  row: { number: number; title?: string; labels: string[]; body?: string | null } | null;
  artifact: GlmPickContext["artifact"];
  exemption: GlmGrillExemption | null;
  verdict: GlmPickVerdict | null;
}

/** Lane labels every TS row needs so the lane check passes and the grill arm is reached. */
const LANE = [RFA, ELIG];

// The 12 D9 cases from test/glm-drainer-loop.test.mts (labels/body verbatim,
// plus the lane labels), then the four rows the table itself doesn't reach.
const PARITY: ParityCase[] = [
  { name: "D9 101 cleanup-scan label", n: 101, row: { number: 101, labels: [...LANE, CLEANUP] }, artifact: null, exemption: "cleanup-scan", verdict: { pickable: true, reason: "cleanup-scan" } },
  { name: "D9 102 Expected tier: T1 stamp", n: 102, row: { number: 102, labels: [...LANE], body: "Do it.\n\nExpected tier: T1" }, artifact: null, exemption: "expected-tier-t1", verdict: { pickable: true, reason: "expected-tier-t1" } },
  { name: "D9 103 Expected tier: 1 stamp", n: 103, row: { number: 103, labels: [...LANE], body: "Expected tier: 1" }, artifact: null, exemption: "expected-tier-t1", verdict: { pickable: true, reason: "expected-tier-t1" } },
  { name: "D9 104 lowercase 'expected tier: t1'", n: 104, row: { number: 104, labels: [...LANE], body: "expected tier: t1" }, artifact: null, exemption: "expected-tier-t1", verdict: { pickable: true, reason: "expected-tier-t1" } },
  { name: "D9 105 T1 stamp + needs-design-concept (opt-in wins)", n: 105, row: { number: 105, labels: [...LANE, NDC], body: "Expected tier: T1" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 106 T12 stamp (word boundary rejects)", n: 106, row: { number: 106, labels: [...LANE], body: "Expected tier: T12" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 107 T3 stamp", n: 107, row: { number: 107, labels: [...LANE], body: "Expected tier: T3" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 108 empty body", n: 108, row: { number: 108, labels: [...LANE], body: "" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 109 cleanup-scan + needs-design-concept (unconditional)", n: 109, row: { number: 109, labels: [...LANE, CLEANUP, NDC], body: "irrelevant" }, artifact: null, exemption: "cleanup-scan", verdict: { pickable: true, reason: "cleanup-scan" } },
  { name: "D9 110 null body", n: 110, row: { number: 110, labels: [...LANE], body: null }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 111 no stamp + approved artifact within 7 days", n: 111, row: { number: 111, labels: [...LANE], body: "no stamps here" }, artifact: { status: "approved", createdAt: NOW - 2 * DAY_MS }, exemption: null, verdict: { pickable: true, reason: "approved-fresh" } },
  { name: "D9 112 issue absent from rows (python fail-closed)", n: 112, row: null, artifact: null, exemption: null, verdict: null },
  { name: "track: title row", n: 113, row: { number: 113, title: "track: 14-day measurement window", labels: [...LANE], body: "" }, artifact: null, exemption: "track-title", verdict: { pickable: false, reason: "track-title" } },
  { name: "cleanup-scan + track: title (exemption cleanup-scan, verdict track-title)", n: 114, row: { number: 114, title: "Track: remove dead export", labels: [...LANE, CLEANUP], body: "" }, artifact: null, exemption: "cleanup-scan", verdict: { pickable: false, reason: "track-title" } },
  { name: "stale approved artifact (8 days old)", n: 115, row: { number: 115, labels: [...LANE], body: "plain" }, artifact: { status: "approved", createdAt: NOW - 8 * DAY_MS }, exemption: null, verdict: { pickable: false, reason: "artifact-stale" } },
  { name: "fresh draft artifact", n: 116, row: { number: 116, labels: [...LANE], body: "plain" }, artifact: { status: "draft", createdAt: NOW - DAY_MS }, exemption: null, verdict: { pickable: false, reason: "artifact-draft" } },
];


describe("grill-exemption table: glmGrillExemption / glmPickVerdict (ADR-0040 Decision 5)", () => {
  for (const c of PARITY) {
    if (c.row === null) continue;
    const r = c.row;
    test(`table: ${c.name}`, () => {
      const row: GlmPickRow = { number: r.number, labels: r.labels, title: r.title ?? `Issue ${r.number}`, body: r.body };
      assert.equal(glmGrillExemption(row), c.exemption, "TS exemption");
      assert.deepEqual(glmPickVerdict(row, ctx({ artifact: c.artifact })), c.verdict, "TS verdict");
    });
  }
});

// ---------------------------------------------------------------------------
// 2b. Ported: blocked-dependency exclusion (from board-state.test.mts, #3965 / #4823)
// ---------------------------------------------------------------------------

interface BlockerIssue {
  number: number;
  body: string;
  labels?: { name: string }[];
}

/** Step 1 — the union of strict-blocker refs across the pool, self-refs excluded. */
const blockerRefs = (issues: BlockerIssue[]) => blockerRefUnion(issues);
/** Step 3 — the candidates blocked by an OPEN strict blocker, given a pre-resolved open set. */
const blockedDeps = (issues: BlockerIssue[], open: Set<number>) => blockedDependencyIssues(issues, open);
/** The candidate pool with in-flight / in-progress / blocked-dependency issues subtracted. */
const candidates = (issues: BlockerIssue[], inflight: Set<number>, blockedDep: Set<number>) =>
  grillCandidates(issues, inflight, blockedDep);

describe("Turn Snapshot picks — blocked-dependency exclusion (issue #3965)", () => {
  test("a ready-for-agent issue citing an OPEN strict blocker is excluded from BOTH picks", () => {
    const issues: BlockerIssue[] = [
      { number: 100, body: "Blocked by #500." },
      { number: 101, body: "No blocker here." },
    ];
    assert.deepEqual(blockerRefs(issues), [500]);
    const blocked = blockedDeps(issues, new Set([500]));
    assert.deepEqual(blocked, [100]);
    const cands = candidates(issues, new Set(), new Set(blocked));
    assert.ok(!cands.includes(100), "blocked #100 must be dropped from candidates → excluded from both picks");
    assert.ok(cands.includes(101), "unblocked #101 must remain a candidate");
  });

  test("the same issue with its blocker CLOSED is selected normally", () => {
    const issues: BlockerIssue[] = [
      { number: 100, body: "Blocked by #500." },
      { number: 101, body: "depends on #500 too" },
    ];
    const blocked = blockedDeps(issues, new Set());
    assert.deepEqual(blocked, []);
    assert.deepEqual(candidates(issues, new Set(), new Set(blocked)), [100, 101]);
  });

  test("`depends on #N` excludes just like `blocked by #N`", () => {
    const issues: BlockerIssue[] = [{ number: 7, body: "Depends on #9." }];
    assert.deepEqual(blockerRefs(issues), [9]);
    assert.deepEqual(blockedDeps(issues, new Set([9])), [7]);
  });

  test("a BARE `#N` mention does NOT exclude (would starve real work)", () => {
    const issues: BlockerIssue[] = [{ number: 200, body: "See also #500 and part of #501." }];
    assert.deepEqual(blockerRefs(issues), []);
    assert.deepEqual(blockedDeps(issues, new Set([500, 501])), []);
  });

  test("a `#N` inside a backtick code span does NOT exclude (code-span-safe)", () => {
    const issues: BlockerIssue[] = [
      { number: 300, body: "Blocked by `#500` in a snippet." },
      { number: 301, body: "`code #500` but blocked by #501" },
    ];
    assert.deepEqual(blockerRefs(issues), [501]);
    assert.deepEqual(blockedDeps(issues, new Set([500, 501])), [301]);
  });

  test("a SELF-reference does NOT exclude (an issue can't block itself)", () => {
    const issues: BlockerIssue[] = [{ number: 400, body: "blocked by #400" }];
    assert.deepEqual(blockerRefs(issues), []);
    assert.deepEqual(blockedDeps(issues, new Set([400])), []);
  });

  test("fail-safe: a blocker-lookup failure (all refs treated open) excludes the issue", () => {
    const issues: BlockerIssue[] = [
      { number: 100, body: "Blocked by #500." },
      { number: 101, body: "depends on #501" },
      { number: 102, body: "clean" },
    ];
    const refs = blockerRefs(issues);
    assert.deepEqual(refs, [500, 501]);
    const blocked = blockedDeps(issues, new Set(openBlockers(EMPTY, refs)));
    assert.deepEqual(blocked, [100, 101]);
    assert.deepEqual(candidates(issues, new Set(), new Set(blocked)), [102]);
  });

  test("the fail-safe never fails the collect step (best-effort degrade)", () => {
    // Was a source-text check of the bash else-branch; now the lookup reducer
    // itself: a failed, empty or unparseable read is "every ref still open",
    // never a throw; a healthy read is intersected with the requested refs.
    assert.deepEqual(openBlockers(EMPTY, [500, 501]), [500, 501]);
    assert.deepEqual(openBlockers({ kind: "unparseable", error: "x" }, [500]), [500]);
    assert.deepEqual(openBlockers(ok([{ number: 501 }, { number: 77 }]), [500, 501]), [501]);
    assert.deepEqual(openBlockers(ok([7]), [500]), [500], "a malformed row fails toward exclusion");
  });

  test("the exclusion is a HARD skip in the candidate pool (not a soft loop continue)", () => {
    // A dependency-blocked issue must not reach the walk at all — not even as a
    // cleanup-scan / T1 dev pin the soft gates could promote.
    const issues: BlockerIssue[] = [
      { number: 100, body: "Blocked by #500.\n\nExpected tier: T1", labels: [{ name: "cleanup-scan" }] },
    ];
    assert.deepEqual(candidates(issues, new Set(), new Set([100])), []);
  });
});

describe("Turn Snapshot picks — declared-Epic subtraction (issue #4823)", () => {
  test("the incident shape is NOT blocked by its open Epic", () => {
    const issues: BlockerIssue[] = [
      { number: 200, body: "**Child of #194 (M5 Paper Clock).** Blocked by #194." },
      { number: 201, body: "Blocked by #194." },
      { number: 202, body: "Child of #194.\n\nBlocked by #195 (sibling)." },
      { number: 203, body: "## Parent\n\n#194\n\n## Blocked by\n- Blocked by #194" },
    ];
    assert.deepEqual(
      blockedDeps(issues, new Set([194, 195])),
      [201, 202],
      "#200/#203 (Epic-declared) must be selectable; #201 (bare blocker) and #202 (open sibling) stay blocked",
    );
    assert.deepEqual(blockedDeps(issues, new Set([194])), [201]);
    assert.deepEqual(blockerRefs([issues[0], issues[3]]), []);
    assert.deepEqual(blockerRefs(issues), [194, 195]);
  });

  test("the collector's blocked verdict IS the canonical predicate's (one predicate, one call site)", () => {
    const golden: Array<[number, string]> = [
      [1000, "Child of #194.\n\nBlocked by #194."],
      [1001, "Blocked by #194."],
      [1002, "parent epic: #194. depends on #194."],
      [1003, "Part of #194 — blocked by #194."],
      [1004, "Child of #194.\n\nBlocked by #195."],
      [1005, "See also #99, part of #42."],
      [1006, "Blocked by `#194` and child of `#194`."],
      [1007, "## Parent\n- #194\n\nblocked-by #194"],
      [300, "blocked by #300"],
      [1008, "no refs at all"],
    ];
    const all = new Set<number>([194, 195, 99, 42]);
    for (const openSet of [all, new Set([194]), new Set([195]), new Set<number>()]) {
      const blocked = new Set(blockedDeps(golden.map(([number, body]) => ({ number, body })), openSet));
      for (const [n, body] of golden) {
        const expected = extractStrictBlockerRefs(body).some((x) => x !== n && openSet.has(x));
        assert.equal(blocked.has(n), expected, `mismatch on #${n} (body ${JSON.stringify(body)}, open=[${[...openSet].join(",")}])`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2c. Ported: active_dev_orch (from autopilot-dev-orch-gate.test.mts, #412 / #3687 / #4048)
// ---------------------------------------------------------------------------

function iso(secondsAgo: number): string {
  // GitHub's `updatedAt` is whole-second ISO-8601; fractional seconds were a
  // jq fromdateiso8601 error (the whole read → 0), and still are.
  return new Date(NOW_MS - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const activeDev = (prs: unknown[]) => countActiveDevOrch(ok(prs), NOW_MS / 1000);

describe("Turn Snapshot picks — active_dev_orch (issue #412)", () => {
  test("stale in-progress label + no active PR → dispatch allowed (active_dev_orch=0)", () => {
    assert.equal(activeDev([]), 0, "no PRs → count must be 0 (gate open)");
  });

  test("fresh PR on issue-<N> head → dispatch blocked (active_dev_orch=1)", () => {
    assert.equal(activeDev([{ headRefName: "issue-412-dev-orch-gate", updatedAt: iso(60) }]), 1);
  });

  test("fresh PR on hydra-dev/ head → dispatch blocked (active_dev_orch=1)", () => {
    assert.equal(activeDev([{ headRefName: "hydra-dev/some-feature", updatedAt: iso(120) }]), 1);
  });

  test("fresh PR on worktree-agent- head → dispatch blocked (active_dev_orch=1)", () => {
    assert.equal(activeDev([{ headRefName: "worktree-agent-ab3a8b01c3f11f366", updatedAt: iso(300) }]), 1);
  });

  test("no label + no PR → dispatch allowed (active_dev_orch=0)", () => {
    assert.equal(activeDev([]), 0);
  });

  test("old PR (>90 min stale) → dispatch allowed (active_dev_orch=0)", () => {
    assert.equal(activeDev([{ headRefName: "issue-377-stale-dev", updatedAt: iso(91 * 60) }]), 0,
      "PR older than 90 min must NOT count — that's the bug we're fixing");
  });

  test("PR with non-hydra-dev branch prefix is ignored", () => {
    assert.equal(activeDev([
      { headRefName: "fix/priorities-unstick-planner-loop", updatedAt: iso(60) },
      { headRefName: "feat/issue-407-hydra-pr-rebase-skill", updatedAt: iso(60) },
    ]), 0, "non-hydra-dev branches must be ignored");
  });

  test("boundary: PR exactly at 90 min is NOT counted", () => {
    assert.equal(activeDev([{ headRefName: "issue-100-foo", updatedAt: iso(5400) }]), 0, "PR exactly at boundary is stale (filter is < 5400)");
  });

  test("mixed fresh + stale + foreign → only fresh hydra-dev counted", () => {
    assert.equal(activeDev([
      { headRefName: "issue-1-fresh", updatedAt: iso(60) },
      { headRefName: "issue-2-stale", updatedAt: iso(99 * 60) },
      { headRefName: "hydra-dev/x", updatedAt: iso(1000) },
      { headRefName: "worktree-agent-deadbeef", updatedAt: iso(10) },
      { headRefName: "fix/foreign", updatedAt: iso(10) },
    ]), 3, "three fresh hydra-dev PRs out of five total");
  });

  test("fresh glm-authored PR on worktree-agent- head is NOT counted (#3687)", () => {
    assert.equal(activeDev([{ headRefName: "worktree-agent-ab3a8b01c3f11f366", updatedAt: iso(60), labels: [{ name: "glm-authored" }] }]), 0,
      "a glm-authored drainer PR must not gate the Opus dev_orch slot");
  });

  test("glm-authored is subtracted while a sibling Opus PR still counts (#3687)", () => {
    assert.equal(activeDev([
      { headRefName: "worktree-agent-deadbeef", updatedAt: iso(60), labels: [{ name: "glm-authored" }, { name: "enhancement" }] },
      { headRefName: "worktree-agent-cafebabe", updatedAt: iso(60), labels: [{ name: "enhancement" }] },
    ]), 1, "only the non-glm-authored PR counts — the branch prefix is identical");
  });

  test("PR row with no labels field is not treated as glm-authored (#3687)", () => {
    assert.equal(activeDev([{ headRefName: "issue-412-no-labels-field", updatedAt: iso(60) }]), 1, "missing labels ⇒ not glm-authored ⇒ still counted");
  });

  test("fresh UNLABELLED worktree-agent-glm- PR is NOT counted (#4048 — the branch-prefix fallback)", () => {
    assert.equal(activeDev([{ headRefName: "worktree-agent-glm-4048-1786841729", updatedAt: iso(60), labels: [] }]), 0,
      "an unlabelled drainer PR must not gate the Opus dev_orch slot — the branch prefix excludes it");
  });

  test("unlabelled worktree-agent-glm- PR is subtracted while a sibling hex-hash Opus PR still counts (#4048)", () => {
    assert.equal(activeDev([
      { headRefName: "worktree-agent-glm-3690-1752950000", updatedAt: iso(60), labels: [] },
      { headRefName: "worktree-agent-cafebabe0123456789abcdef-1752950001", updatedAt: iso(60), labels: [] },
    ]), 1, "only the hex-hash Opus PR counts");
  });

  test("a branch that merely CONTAINS glm but diverges before the dash is still Opus work (prefix-exact match, #4048)", () => {
    assert.equal(activeDev([{ headRefName: "worktree-agent-glmtree-not-the-drainer", updatedAt: iso(60), labels: [] }]), 1,
      "startswith(worktree-agent-glm-) is prefix-exact — glm alone must not exclude");
  });

  test("the active_dev_orch read requests labels so the glm filter can see them (#3687)", async () => {
    // Was a source-text check of the bash gh call; now the port's argv.
    const seen: string[][] = [];
    const port = createTurnSnapshotGithub({
      repo: "owner/repo",
      transport: async (args) => {
        seen.push(args);
        return { ok: true, stdout: "[]", stderr: "" };
      },
    });
    await port.listOpenPrHeads();
    const fields = seen[0][seen[0].indexOf("--json") + 1].split(",");
    assert.ok(fields.includes("labels"), "the active_dev_orch read must request `labels` from gh");
  });

  test("a failed read degrades to 0 (the bash `|| echo 0`)", () => {
    assert.equal(countActiveDevOrch(EMPTY, NOW_MS / 1000), 0);
  });
});

// ---------------------------------------------------------------------------
// 3. The CLI + port contract
// ---------------------------------------------------------------------------

describe("turn-snapshot CLI — picks collector contract (ADR-0043 D2, slice 3)", () => {
  const io = (sink: { stdout: string; stderr: string }, files: Record<string, string> = {}) => ({
    stdout: (t: string) => (sink.stdout += t),
    stderr: (t: string) => (sink.stderr += t),
    readFile: (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  });

  test("picks needs pr-gate in the same run (usage error, exit 2)", async () => {
    const sink = { stdout: "", stderr: "" };
    const code = await main(["--collectors", "picks", "--format", "values"], { github: fakeGithub([], {}, { merged: 0 }), now: () => NOW_MS, sleep: async () => {} }, io(sink));
    assert.equal(code, 2);
    assert.equal(sink.stdout, "");
    assert.match(sink.stderr, /^turn-snapshot: picks needs pr-gate/);
  });

  test("pr-gate then picks, in one run; the in-flight sets cross in-process; the board-degraded verdict is on the value", async () => {
    const sink = { stdout: "", stderr: "" };
    const github = fakeGithub([issue(850, "No stamp.\n"), issue(851, "No stamp.\n")], { openPrs: [{ headRefName: "issue-850-wip", body: "" }] }, { merged: 0 });
    const code = await main(
      ["--collectors", "pr-gate,picks", "--format", "values"],
      { github, hydra: fakeHydra({ designConceptBody: async () => "" }), now: () => NOW_MS, sleep: async () => {} },
      io(sink),
    );
    assert.equal(code, 0);
    const out = JSON.parse(sink.stdout);
    assert.deepEqual(Object.keys(out), ["pr-gate", "picks"]);
    assert.equal(out.picks.grillPick, 851, "in-flight #850 (pr-gate's branch set) is excluded in-process");
    assert.deepEqual(out.picks.candidateExclusions.find((r: { anchor: string; member: string }) => r.anchor === "issue-850" && r.member === "in-flight-dev-exclusion"), {
      anchor: "issue-850",
      member: "in-flight-dev-exclusion",
      verdict: "excluded",
      evidence: "pr-branch-name",
    });
    assert.equal(out.picks.boardDegraded, false);
  });

  test("a failed grill-list read flags the board degraded and notes it", async () => {
    const sink = { stdout: "", stderr: "" };
    const github = { ...fakeGithub([], {}, { merged: 0 }), listReadyForAgentIssues: async () => EMPTY };
    await main(["--collectors", "pr-gate,picks", "--format", "values"], { github, hydra: fakeHydra({ designConceptBody: async () => "" }), now: () => NOW_MS, sleep: async () => {} }, io(sink));
    assert.equal(JSON.parse(sink.stdout).picks.boardDegraded, true);
    assert.match(sink.stderr, /orch grill-list read FAILED \(empty payload\) — flagged degraded \(issue #4130\)/);
  });

  test("the picks collector crashing returns the fail-open fallback, flags the lane degraded, exits 0", async () => {
    const sink = { stdout: "", stderr: "" };
    const github = { ...fakeGithub([], {}, { merged: 0 }), listReadyForAgentIssues: async (): Promise<GhJsonRead> => Promise.reject(new Error("boom")) };
    const code = await main(["--collectors", "pr-gate,picks", "--format", "values"], { github, hydra: fakeHydra({ designConceptBody: async () => "" }), now: () => NOW_MS, sleep: async () => {} }, io(sink));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(sink.stdout).picks, { grillPick: null, devReadyPick: null, candidateExclusions: [], activeDevOrch: 0, boardDegraded: true });
    assert.match(sink.stderr, /orch turn-snapshot picks collector crashed \(boom\)/);
  });

  test("--board-state-file feeds the GLM-withheld refusal; an unreadable file is noted and refuses nothing", async () => {
    const run = async (files: Record<string, string>) => {
      const sink = { stdout: "", stderr: "" };
      await main(
        ["--collectors", "pr-gate,picks", "--format", "values", "--board-state-file", "b"],
        { github: fakeGithub([issue(4247, "Grilled.\n")], {}, { merged: 0 }), hydra: fakeHydra({ designConceptBody: async () => JSON.stringify({ createdAt: NOW_MS }) }), now: () => NOW_MS, sleep: async () => {} },
        io(sink, files),
      );
      return { ...sink, devReady: JSON.parse(sink.stdout).picks.devReadyPick };
    };
    assert.equal((await run({ b: '{"glm_withheld":[4247]}\n' })).devReady, null);
    const missing = await run({});
    assert.equal(missing.devReady, 4247);
    assert.match(missing.stderr, /could not read the board-state file \(ENOENT\)/);
  });

  test("mergedRefIssues fails open on an unparsable / non-list payload (was pr-refs.py --merged)", () => {
    for (const read of [EMPTY, { kind: "unparseable", error: "x" } as GhJsonRead, ok({ not: "a list" })]) {
      assert.deepEqual([...mergedRefIssues(read)], []);
    }
  });

  test("the production port issues the slice-3 reads against the resolved repo (no literal)", async () => {
    const seen: string[][] = [];
    const port = createTurnSnapshotGithub({
      repo: "example-owner/example-repo",
      transport: async (args) => {
        seen.push(args);
        return { ok: true, stdout: "[]\n", stderr: "" };
      },
    });
    await port.listReadyForAgentIssues(50);
    await port.searchOpenIssueNumbers("500 501", 50);
    await port.listMergedPrs(100);
    await port.listOpenPrHeads();
    assert.deepEqual(seen, [
      ["issue", "list", "--repo", "example-owner/example-repo", "--state", "open", "--label", "ready-for-agent", "--limit", "50", "--json", "number,updatedAt,body,labels,title"],
      ["issue", "list", "--repo", "example-owner/example-repo", "--state", "open", "--search", "500 501", "--limit", "50", "--json", "number"],
      ["pr", "list", "--repo", "example-owner/example-repo", "--state", "merged", "--limit", "100", "--json", "number,title,body"],
      ["pr", "list", "--repo", "example-owner/example-repo", "--state", "open", "--json", "updatedAt,headRefName,labels"],
    ]);
  });

  test("the hydra HTTP port is `curl -sf` shaped: 2xx body (trailing newlines stripped), else empty, never a throw", async () => {
    const urls: string[] = [];
    const mk = (impl: () => Promise<{ status: number; body: string }>) =>
      createTurnSnapshotHydra({
        baseUrl: "http://h",
        transport: async (u, timeoutMs) => {
          urls.push(`${u} ${timeoutMs}`);
          return impl();
        },
      });
    assert.equal(await mk(async () => ({ status: 200, body: '{"createdAt":1}\n\n' })).designConceptBody(7), '{"createdAt":1}');
    assert.equal(await mk(async () => ({ status: 404, body: "nope" })).designConceptBody(7), "");
    assert.equal(await mk(async () => Promise.reject(new Error("ECONNREFUSED"))).designConceptBody(7), "");
    assert.deepEqual(urls, Array(3).fill("http://h/api/design-concepts/issue-7 3000"));
  });
});
