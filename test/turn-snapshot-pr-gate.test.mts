/**
 * Turn Snapshot — in-flight PR + PR-gate collector (ADR-0043 slice 1, #4929).
 *
 * Three suites, all at the TS interface with NO `gh` on PATH:
 *
 * 1. GOLDEN (ADR-0043 Decision 4): every file under
 *    test/fixtures/turn-snapshot/ was captured by running the OLD bash
 *    collectors (`collect_orch_inflight_prs` + `collect_pr_gate_reachability`,
 *    at the slice's base SHA) over each fixture the pre-slice tests used —
 *    failure fixtures included. Each is replayed through the real CLI `main`
 *    (`--format values`) + the production `TurnSnapshotGithub` port over a
 *    recording transport: the TYPED value (`expected.values`, in-flight sets
 *    included — captured while the retired kv wire still matched the bash
 *    byte for byte, #4934), the `orch …` stderr-note set exactly, and the
 *    `gh` argv list exactly (the same underlying calls, in the same order).
 *    The capture recipe + provenance: test/fixtures/turn-snapshot/README.md;
 *    the opt-in expected-block re-record mode: UPDATE_TURN_SNAPSHOT_PR_GATE_GOLDEN.
 *
 * 2. PORTED behavioural cases: the cases that lived in
 *    test/collect-state-inflight-exclusion.test.mts (#4240, #4460, #4518,
 *    #4807, #4812), 1:1 — same fixtures, same assertions — now driving
 *    `collectPrGate` through a fake port returning typed fixtures instead of
 *    regex-extracting a python heredoc. `runPrGate` also asserts the read
 *    budget (5 + the single UNKNOWN re-poll) on every case.
 *
 * 3. The port READ-COUNT + ORDER guard (#4941): exactly five reads in the
 *    recorded order with no UNKNOWN PR; six with one (the re-poll second,
 *    after the sleep) — the zero-added-reads property the deleted "no Redis
 *    access" bash case used to pin.
 */

import { degradeDetail } from "../src/autopilot/turn-snapshot/collector.ts";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { main, parseArgs } from "../scripts/autopilot/turn-snapshot.ts";
import {
  applyMergeStateRepoll,
  checkVerdictFor,
  collectPrGate,
  hasUnknownMergeState,
  parseTierLine,
  prGateFallbackSnapshot,
  type PrGateEnv,
  type PrRefsAvailability,
  rotateQaRecheckBatch,
} from "../src/autopilot/turn-snapshot/pr-gate.ts";
import {
  createTurnSnapshotGithub,
  ghTimestampSeconds,
  parseJsonRead,
  PR_GATE_PR_FIELDS,
  type GhJsonRead,
  type GhTransport,
  type TurnSnapshotGithub,
} from "../src/autopilot/turn-snapshot/github-port.ts";
import { pickNoPrResume } from "../src/autopilot/turn-snapshot/dev-resume.ts";
import { DEFAULT_GITHUB_REPO } from "../src/github/issues.ts";

const GOLDEN_DIR = resolve(import.meta.dirname, "fixtures", "turn-snapshot");

const PR_REFS_UNAVAILABLE: PrRefsAvailability = {
  ok: false,
  error: "[Errno 2] No such file or directory: '/nonexistent/pr-refs.py'",
};

// ---------------------------------------------------------------------------
// 1. Golden files
// ---------------------------------------------------------------------------

interface GoldenRead {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Golden {
  name: string;
  nowMs: number;
  env: Record<string, string>;
  prRefsUnavailable: boolean;
  gh: Partial<Record<"first" | "repoll" | "runsPush" | "runsPullRequest" | "required" | "resume", GoldenRead>>;
  expected: {
    /** `--format values` output: `{ "pr-gate": <typed PrGateSnapshot> }`. */
    values: Record<string, unknown>;
    stderrNotes: string[];
    ghCalls: string[][];
    sleeps: string[];
  };
}

/** Route an argv to the golden read the old fake `gh` served for it. */
function goldenKey(args: string[]): keyof Golden["gh"] | null {
  const joined = args.join(" ");
  if (joined.includes("number,headRefName,body,mergeStateStatus,statusCheckRollup,createdAt,updatedAt,isDraft,labels")) return "first";
  if (joined.includes("--json number,mergeStateStatus")) return "repoll";
  if (joined.includes("event=push")) return "runsPush";
  if (joined.includes("event=pull_request")) return "runsPullRequest";
  if (joined.includes("required_status_checks")) return "required";
  if (joined.includes("needs-dev-resume")) return "resume";
  return null;
}

function goldenEnv(env: Record<string, string>): PrGateEnv {
  return {
    uncheckedGraceSeconds: env.HYDRA_ORCH_PR_UNCHECKED_GRACE_SECONDS,
    glmRedQuiescenceSeconds: env.HYDRA_ORCH_GLM_RED_QUIESCENCE_SECONDS,
    unknownRepollDelaySeconds: env.HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS,
    devResumeNoprQuiescenceSeconds: env.HYDRA_ORCH_DEV_RESUME_NOPR_QUIESCENCE_SECONDS,
  };
}

// Other slices' goldens share the directory under their own prefix (slice 2: `orch-board-`).
const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("orch-board-")).sort();

/**
 * Re-record the goldens' `expected` blocks — ONLY for an intentional
 * collector behaviour change, never to silence a mismatch:
 *
 *   UPDATE_TURN_SNAPSHOT_PR_GATE_GOLDEN=1 npm run test:file -- test/turn-snapshot-pr-gate.test.mts
 *
 * Same convention as UPDATE_DECIDE_GOLDEN (test/decide-golden.test.mts) and
 * UPDATE_TURN_SNAPSHOT_JSON_GOLDEN (test/turn-snapshot-json.test.mts). Each
 * golden's scenario inputs (`name`, `nowMs`, `env`, `prRefsUnavailable`,
 * `gh`) are never touched — only the `expected` block is rewritten from the
 * TS replay. The historical bash capture recipe + provenance live in
 * test/fixtures/turn-snapshot/README.md.
 */
const UPDATE_GOLDEN = process.env.UPDATE_TURN_SNAPSHOT_PR_GATE_GOLDEN === "1";

describe("Turn Snapshot pr-gate — golden files from the bash collectors (ADR-0043 D4)", () => {
  test("the golden corpus is present (guards a vacuous pass)", () => {
    assert.ok(goldenFiles.length >= 90, `expected the captured corpus, found ${goldenFiles.length} files`);
  });

  for (const file of goldenFiles) {
    const g = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8")) as Golden;
    test(`golden: ${g.name}`, async () => {
      const calls: string[][] = [];
      const transport: GhTransport = async (args) => {
        calls.push([...args]);
        const key = goldenKey(args);
        const r = key === null ? undefined : g.gh[key];
        if (r === undefined) return { ok: false, stderr: `unscripted call: ${args.join(" ")}` };
        return r.exitCode === 0 ? { ok: true, stdout: r.stdout, stderr: r.stderr } : { ok: false, stderr: r.stderr };
      };
      const sleeps: string[] = [];
      let stdout = "";
      let stderr = "";
      const code = await main(
        ["--collectors", "pr-gate", "--format", "values", "--gh-list-limit", "100"],
        {
          github: createTurnSnapshotGithub({ transport, repo: DEFAULT_GITHUB_REPO }),
          now: () => g.nowMs,
          sleep: async (s) => {
            sleeps.push(String(s));
          },
          env: goldenEnv(g.env),
          ...(g.prRefsUnavailable ? { prRefs: PR_REFS_UNAVAILABLE } : {}),
        },
        {
          stdout: (t) => (stdout += t),
          stderr: (t) => (stderr += t),
        },
      );
      assert.equal(code, 0);
      const notes = stderr.split("\n").filter((l) => l.startsWith("orch "));
      if (UPDATE_GOLDEN) {
        // The corpus's own key order (stderrNotes, ghCalls, sleeps, values) —
        // a no-op run of this mode must round-trip every file byte-identically.
        writeFileSync(
          join(GOLDEN_DIR, file),
          JSON.stringify({ ...g, expected: { stderrNotes: notes, ghCalls: calls, sleeps, values: JSON.parse(stdout) } }, null, 2) + "\n",
        );
        return;
      }
      assert.deepEqual(JSON.parse(stdout), g.expected.values, "the typed value (in-flight sets included) must match the golden");
      assert.deepEqual([...notes].sort(), [...g.expected.stderrNotes].sort(), "the stderr-note set must match");
      assert.deepEqual(calls, g.expected.ghCalls, "the same gh calls, in the same order");
      assert.deepEqual(sleeps, g.expected.sleeps, "the re-poll delay must match");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Ported behavioural cases
// ---------------------------------------------------------------------------

const NOW_MS = 1_800_000_000_000;

/** ISO8601 `secondsAgo` before the fixed clock, in the `%Y-%m-%dT%H:%M:%SZ` shape. */
function isoSecondsAgo(secondsAgo: number): string {
  return new Date(NOW_MS - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const ok = (data: unknown): GhJsonRead => ({ kind: "ok", data });
const EMPTY: GhJsonRead = { kind: "empty" };

const REQUIRED = [
  "test",
  "dashboard-build",
  "tier-gate",
  "mutation-test",
  "scope-check",
  "secret-scan",
  "deep-qa-gate",
  "design-concept-reconcile",
];

interface PrGateOpenPr {
  number: number;
  mergeStateStatus: string;
  statusCheckRollup: unknown[];
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  labels: { name: string }[];
  headRefName?: string;
  body?: string;
}

interface FakeOpts {
  first?: GhJsonRead;
  repoll?: GhJsonRead;
  repollStderr?: string;
  runsPush?: string | null;
  runsPullRequest?: string | null;
  required?: GhJsonRead;
  resume?: GhJsonRead;
}

/** A fake TurnSnapshotGithub returning typed fixtures, counting and logging reads. */
function fakeGithub(o: FakeOpts): TurnSnapshotGithub & { prListReads: () => number; totalReads: () => number; readLog: () => string[] } {
  let prListReads = 0;
  let totalReads = 0;
  const log: string[] = [];
  return {
    prListReads: () => prListReads,
    totalReads: () => totalReads,
    readLog: () => log,
    async listOpenPrs() {
      prListReads++;
      totalReads++;
      log.push("listOpenPrs");
      return o.first ?? ok([]);
    },
    async listOpenPrMergeStates() {
      prListReads++;
      totalReads++;
      log.push("listOpenPrMergeStates");
      return { read: o.repoll ?? ok([]), stderrHead: o.repollStderr ?? "" };
    },
    async latestWorkflowRunCreatedAt(event) {
      totalReads++;
      log.push(`latestWorkflowRunCreatedAt(${event})`);
      return (event === "push" ? o.runsPush : o.runsPullRequest) ?? null;
    },
    async requiredStatusContexts() {
      totalReads++;
      log.push("requiredStatusContexts");
      return o.required ?? ok(REQUIRED);
    },
    async listOpenIssueRowsByLabel() {
      totalReads++;
      log.push("listOpenIssueRowsByLabel");
      return o.resume ?? ok([]);
    },
    // The needs-triage / needs-qa number read — no longer the pr-gate
    // collector's (#4808 INV-3 widened it to listOpenIssueRowsByLabel in
    // place); kept so the fake still satisfies the full port type.
    openIssueNumbersByLabel: unusedRead,
    // Slice-2 reads (#4930) — never issued by the pr-gate collector.
    async listOpenIssueBoardRows() {
      return EMPTY;
    },
    async listOpenIssueLabelRows() {
      return EMPTY;
    },
    // slice 3 (#4931) reads — unused by the pr-gate collector
    listReadyForAgentIssues: async () => ok([]),
    searchOpenIssueNumbers: async () => ok([]),
    listMergedPrs: async () => ok([]),
    listOpenPrHeads: async () => ok([]),
    // Slice 5B (#4933) reads — never part of a pr-gate run.
    ...SLICE_5B_READS_UNUSED,
    // Slice 4 (#4932) Target-board reads — issued against the Target repo's port, never this one.
    listOpenIssueLabelNames: unusedRead,
    listOpenPullsRest: unusedRead,
    listOpenIssuesByLabelRest: unusedRead,
    listQaVerdictCommentsRest: unusedRead,
    // #4946 read — issued against the Target repo's port, never this one.
    listOpenIssueBlockerRows: unusedRead,
  };
}

const unusedRead = async (): Promise<GhJsonRead> => assert.fail("not a pr-gate read");
const SLICE_5B_READS_UNUSED = {
  openIssuesWithLabel: unusedRead,
  openIssueLabelsWithLabel: unusedRead,
  openIssueAssigneesWithLabel: unusedRead,
  wayfinderMapSubIssues: unusedRead,
};

interface PrGateBuckets {
  dirty: number[];
  unchecked: number[];
  behind: number[];
  ciTriggerStale: boolean;
  /** `orch_prs_red_resume`: pick candidates qualifying ONLY via the red-CI arm (#5058). */
  redResume: number[];
  devResumePick: string;
  /** The #4808 no-PR pick: the anchor, or null when absent OR degraded. */
  devResumeNoprAnchor: number | null;
  dirtyForwardFix: string;
  dirtySurface: string;
  stderr: string;
}

interface PrGateOverrides {
  /** "" models a FAILED read (the INV-5 fail-closed path). */
  requiredContextsJson?: string;
  devResumeIssuesJson?: string;
  glmRedQuiescenceSeconds?: string;
  devResumeNoprQuiescenceSeconds?: string;
  prRefs?: PrRefsAvailability;
}

/** "" models a FAILED read; anything else goes through the port's own JSON parse. */
const jsonOrEmpty = (s: string): GhJsonRead => parseJsonRead(s);

/**
 * A pin in the Anchor-reference notation signal EVENTS carry
 * (`issue-N:PR:branch`), `none` when absent or degraded — the ported cases
 * keep their assertions in it.
 */
const pinRef = (p: { issue: number; pr: number; headRefName: string } | null) => (p === null ? "none" : `issue-${p.issue}:${p.pr}:${p.headRefName}`);

/** The ported `runPrGate`: the collector over a fake port, its typed value as flat buckets. */
async function runPrGate(prs: unknown[], overrides: PrGateOverrides = {}, repoll?: GhJsonRead): Promise<PrGateBuckets> {
  const github = fakeGithub({
    first: ok(prs),
    repoll,
    required: jsonOrEmpty(overrides.requiredContextsJson ?? JSON.stringify(REQUIRED)),
    resume: jsonOrEmpty(overrides.devResumeIssuesJson ?? "[]"),
  });
  const outcome = await collectPrGate({
    github,
    now: () => NOW_MS,
    sleep: async () => {},
    ghListLimit: 100,
    env: {
      uncheckedGraceSeconds: "600",
      glmRedQuiescenceSeconds: overrides.glmRedQuiescenceSeconds ?? "1800",
      devResumeNoprQuiescenceSeconds: overrides.devResumeNoprQuiescenceSeconds ?? "5400",
    },
    ...(overrides.prRefs ? { prRefs: overrides.prRefs } : {}),
  });
  // The read budget (#4941): five reads, plus the single #4812 re-poll when
  // the first payload holds an UNKNOWN — an added read trips every ported case.
  assert.equal(github.totalReads(), 5 + (hasUnknownMergeState(prs) ? 1 : 0));
  const v = outcome.value;
  const dirtyFix = v.dirtyFix.ok ? v.dirtyFix.value : { pick: null, surface: [] };
  return {
    dirty: [...v.dirty],
    unchecked: [...v.unchecked],
    behind: [...v.behind],
    ciTriggerStale: v.ciTriggerStale.ok && v.ciTriggerStale.value,
    redResume: v.redResume.ok ? [...v.redResume.value] : [],
    devResumePick: pinRef(v.devResumePick.ok ? v.devResumePick.value : null),
    devResumeNoprAnchor: v.devResumeNoprPick.ok ? v.devResumeNoprPick.value : null,
    dirtyForwardFix: pinRef(dirtyFix.pick),
    dirtySurface: dirtyFix.surface.map((e) => `${e.pr}:${e.closingIssue ?? "none"}`).join(" "),
    stderr: outcome.notes.map((n) => `${n}\n`).join(""),
  };
}

function basePrGate(overrides: Partial<PrGateOpenPr>): PrGateOpenPr {
  return {
    number: 9001,
    mergeStateStatus: "BEHIND",
    statusCheckRollup: [],
    createdAt: isoSecondsAgo(7200),
    updatedAt: isoSecondsAgo(7200),
    isDraft: false,
    labels: [],
    ...overrides,
  };
}

describe("pr-gate — BEHIND/draft classification (issue #4240)", () => {
  test("a BEHIND PR pushed moments ago with an empty rollup is NOT misclassified unchecked", async () => {
    const pr = basePrGate({ number: 4290, updatedAt: isoSecondsAgo(30), statusCheckRollup: [] });
    const buckets = await runPrGate([pr]);
    assert.deepEqual(buckets.unchecked, [], "a recently-pushed BEHIND PR must never land in orch_prs_unchecked");
    assert.deepEqual(
      buckets.behind,
      [],
      "a not-yet-quiescent BEHIND PR must not land in orch_prs_behind either — it is simply not surfaced yet",
    );
  });

  test("a quiescent, non-draft BEHIND PR still lands in orch_prs_behind (positive control)", async () => {
    const buckets = await runPrGate([basePrGate({ number: 4246, updatedAt: isoSecondsAgo(7200), isDraft: false })]);
    assert.deepEqual(buckets.behind, [4246]);
    assert.deepEqual(buckets.unchecked, []);
  });

  test("a draft PR that is BEHIND and quiescent is excluded from orch_prs_behind (INV-H)", async () => {
    const buckets = await runPrGate([basePrGate({ number: 4311, updatedAt: isoSecondsAgo(7200), isDraft: true })]);
    assert.deepEqual(
      buckets.behind,
      [],
      "a draft PR must never be classified into orch_prs_behind — decide.py would emit a live update-branch against it",
    );
    assert.deepEqual(buckets.unchecked, []);
    assert.deepEqual(buckets.dirty, []);
  });

  test("a non-BEHIND, non-draft, aged PR with an empty rollup still lands in orch_prs_unchecked (positive control)", async () => {
    const pr = basePrGate({
      number: 4237,
      mergeStateStatus: "CLEAN",
      createdAt: isoSecondsAgo(1200),
      updatedAt: isoSecondsAgo(1200),
      statusCheckRollup: [],
    });
    const buckets = await runPrGate([pr]);
    assert.deepEqual(buckets.unchecked, [4237]);
    assert.deepEqual(buckets.behind, []);
  });

  test("isDraft reads with Python truthiness: an EMPTY list / object is not a draft, so a DIRTY PR still lands in orch_prs_dirty (#5084)", async () => {
    for (const isDraft of [[], {}]) {
      const buckets = await runPrGate([{ ...basePrGate({ number: 4400, mergeStateStatus: "DIRTY" }), isDraft }]);
      assert.deepEqual(buckets.dirty, [4400], `isDraft ${JSON.stringify(isDraft)} is Python-falsy`);
    }
    for (const isDraft of [[0], { a: 1 }, true]) {
      const buckets = await runPrGate([{ ...basePrGate({ number: 4401, mergeStateStatus: "DIRTY" }), isDraft }]);
      assert.deepEqual(buckets.dirty, [], `isDraft ${JSON.stringify(isDraft)} is Python-truthy`);
    }
  });
});

describe("pr-gate — red-CI resume arm, provenance-agnostic (issues #4460, #5058)", () => {
  interface RollupEntry {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
    startedAt?: string;
  }

  /** All 8 required contexts present: `red` FAILURE, everything else SUCCESS. */
  function fullRequiredRollup(red?: string, extra: RollupEntry[] = []): RollupEntry[] {
    const out: RollupEntry[] = REQUIRED.map((name) => ({
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion: name === red ? "FAILURE" : "SUCCESS",
      startedAt: isoSecondsAgo(7000),
    }));
    return [...out, ...extra];
  }

  function baseGlmPr(overrides: Partial<PrGateOpenPr> = {}): PrGateOpenPr {
    return basePrGate({
      number: 4433,
      mergeStateStatus: "BLOCKED",
      headRefName: "worktree-agent-glm-4240-1789",
      body: "Closes #4240",
      labels: [],
      updatedAt: isoSecondsAgo(7200),
      statusCheckRollup: fullRequiredRollup("test"),
      ...overrides,
    });
  }

  test("a qualifying red PR (red required `test`, no resume label) yields the resume pick and lands in the red-resume cap scope", async () => {
    const buckets = await runPrGate([baseGlmPr()]);
    assert.deepEqual(buckets.redResume, [4433]);
    assert.equal(buckets.devResumePick, "issue-4240:4433:worktree-agent-glm-4240-1789");
  });

  test("glm-authored LABEL provenance qualifies exactly like any other PR (provenance is display-only, #5058)", async () => {
    const pr = baseGlmPr({
      number: 4450,
      headRefName: "issue-4450-not-a-worktree-branch",
      labels: [{ name: "glm-authored" }],
      body: "Closes #4450",
    });
    const buckets = await runPrGate([pr]);
    assert.equal(buckets.devResumePick, "issue-4450:4450:issue-4450-not-a-worktree-branch");
  });

  test("an advisory (non-required) FAILURE never qualifies (INV-4)", async () => {
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup(undefined, [
        { __typename: "CheckRun", name: "advisory-checks", status: "COMPLETED", conclusion: "FAILURE", startedAt: isoSecondsAgo(7000) },
      ]),
    });
    const buckets = await runPrGate([pr]);
    assert.deepEqual(buckets.redResume, []);
    assert.equal(buckets.devResumePick, "none");
  });

  test("CANCELLED on a required check is NOT red — dedupe keeps the LATEST entry (INV-4)", async () => {
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup("test", [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "CANCELLED", startedAt: isoSecondsAgo(6900) },
      ]),
    });
    const buckets = await runPrGate([pr]);
    assert.deepEqual(buckets.redResume, [], "CANCELLED must never arm a dispatch");
    assert.equal(buckets.devResumePick, "none");
  });

  test("a still-PENDING required check disqualifies (INV-3e) — even with another check red", async () => {
    const buckets = await runPrGate([baseGlmPr({ statusCheckRollup: fullRequiredRollup("test").slice(0, -1) })]);
    assert.deepEqual(buckets.redResume, []);
    assert.equal(buckets.devResumePick, "none");
  });

  test("a non-GLM PR with an identical red required check qualifies too — the pick is provenance-agnostic (#5058)", async () => {
    const buckets = await runPrGate([baseGlmPr({ headRefName: "worktree-agent-a5706403c05633ec3", labels: [] })]);
    assert.deepEqual(buckets.redResume, [4433]);
    assert.equal(buckets.devResumePick, "issue-4240:4433:worktree-agent-a5706403c05633ec3");
  });

  test("not-yet-quiescent (updatedAt inside the 1800s window) disqualifies (INV-3c)", async () => {
    const buckets = await runPrGate([baseGlmPr({ updatedAt: isoSecondsAgo(300) })]);
    assert.deepEqual(buckets.redResume, []);
    assert.equal(buckets.devResumePick, "none");
  });

  test("draft / ready-for-human / DIRTY / UNKNOWN each disqualify (INV-3b)", async () => {
    for (const [name, over] of [
      ["draft", { isDraft: true }],
      ["ready-for-human", { labels: [{ name: "ready-for-human" }] }],
      ["DIRTY", { mergeStateStatus: "DIRTY" }],
      ["UNKNOWN", { mergeStateStatus: "UNKNOWN" }],
    ] as const) {
      const buckets = await runPrGate([baseGlmPr(over as Partial<PrGateOpenPr>)]);
      assert.deepEqual(buckets.redResume, [], `${name} must disqualify`);
      assert.equal(buckets.devResumePick, "none", `${name} must disqualify`);
    }
  });

  test("exactly-one closing issue is required — two closing refs and zero both disqualify (INV-3d)", async () => {
    for (const body of ["Closes #4240\n\nCloses #9999", "Refs #4240"]) {
      const buckets = await runPrGate([baseGlmPr({ body })]);
      assert.deepEqual(buckets.redResume, [], `body "${body}" must disqualify`);
      assert.equal(buckets.devResumePick, "none", `body "${body}" must disqualify`);
    }
  });

  test("the needs-dev-resume arm picks an all-green PR but leaves it OUT of the red-resume cap scope (label arm is uncapped)", async () => {
    const buckets = await runPrGate([baseGlmPr({ statusCheckRollup: fullRequiredRollup() })], {
      devResumeIssuesJson: JSON.stringify([{ number: 4240 }]),
    });
    assert.deepEqual(buckets.redResume, []);
    assert.equal(buckets.devResumePick, "issue-4240:4433:worktree-agent-glm-4240-1789");
  });

  test("a red PR whose closing issue ALSO carries needs-dev-resume is the label arm — picked, not capped", async () => {
    const buckets = await runPrGate([baseGlmPr()], { devResumeIssuesJson: JSON.stringify([{ number: 4240 }]) });
    assert.deepEqual(buckets.redResume, []);
    assert.equal(buckets.devResumePick, "issue-4240:4433:worktree-agent-glm-4240-1789");
  });

  test("a StatusContext FAILURE on a required context is red (deep-qa-gate commit status shape)", async () => {
    const rollup = fullRequiredRollup().map((e) =>
      e.name === "deep-qa-gate"
        ? { __typename: "StatusContext", context: "deep-qa-gate", state: "FAILURE", startedAt: isoSecondsAgo(7000) }
        : e,
    );
    const buckets = await runPrGate([baseGlmPr({ statusCheckRollup: rollup })]);
    assert.deepEqual(buckets.redResume, [4433]);
  });

  test("the LOWEST-numbered qualifying PR wins the pick; the red-resume bucket is sorted (INV-2)", async () => {
    const later = baseGlmPr({ number: 4470, headRefName: "worktree-agent-glm-4266-1", body: "Closes #4266" });
    const earlier = baseGlmPr({ number: 4465, headRefName: "worktree-agent-glm-4300-1", body: "Closes #4300" });
    const buckets = await runPrGate([later, earlier]);
    assert.deepEqual(buckets.redResume, [4465, 4470]);
    assert.equal(buckets.devResumePick, "issue-4300:4465:worktree-agent-glm-4300-1");
  });

  test("a failed required-contexts read fails CLOSED: empty buckets + stderr note, never a dispatch pick (INV-5)", async () => {
    const r = await runPrGate([baseGlmPr()], { requiredContextsJson: "" });
    assert.deepEqual(r.redResume, []);
    assert.equal(r.devResumePick, "none");
    assert.match(r.stderr, /dev-resume classifier fail-closed.*#4460 INV-5/, "INV-5 requires a stderr note naming WHY the signal is empty");
    // The four #4240 buckets are unaffected — fail-closed toward NO dispatch, NOT board degradation.
    assert.deepEqual(r.behind, []);
  });

  test("legacy #4240 classification is unchanged by the #4460 additions (regression control)", async () => {
    const buckets = await runPrGate([basePrGate({ number: 4246, updatedAt: isoSecondsAgo(7200) })]);
    assert.deepEqual(buckets.behind, [4246]);
    assert.deepEqual(buckets.redResume, []);
    assert.equal(buckets.devResumePick, "none");
  });
});

describe("pr-gate — Claude-lane durable dev resume pick (issue #4518)", () => {
  function greenRollup(pendingName?: string): unknown[] {
    return REQUIRED.map((name) => ({
      __typename: "CheckRun",
      name,
      status: name === pendingName ? "IN_PROGRESS" : "COMPLETED",
      conclusion: name === pendingName ? "" : "SUCCESS",
      startedAt: isoSecondsAgo(7000),
    }));
  }

  /** The live #4510 strand: a Claude-lane PR, green on every required check, closing issue bounced to needs-dev-resume. */
  function claudeResumePr(overrides: Partial<PrGateOpenPr> = {}): PrGateOpenPr {
    return basePrGate({
      number: 4532,
      mergeStateStatus: "UNSTABLE",
      headRefName: "worktree-agent-a5706403c05633ec3",
      body: "Closes #4510",
      labels: [],
      updatedAt: isoSecondsAgo(7200),
      statusCheckRollup: greenRollup(),
      ...overrides,
    });
  }

  const RESUME_4510 = { devResumeIssuesJson: JSON.stringify([{ number: 4510 }]) };

  test("a needs-dev-resume issue with an open non-draft Claude-lane PR yields the resume pick", async () => {
    const buckets = await runPrGate([claudeResumePr()], RESUME_4510);
    assert.equal(buckets.devResumePick, "issue-4510:4532:worktree-agent-a5706403c05633ec3");
    assert.deepEqual(buckets.redResume, [], "an all-green label-arm pick is outside the red-CI cap scope");
  });

  test("no needs-dev-resume label on the closing issue -> none", async () => {
    assert.equal((await runPrGate([claudeResumePr()])).devResumePick, "none");
  });

  test("a draft PR or a ready-for-human PR never yields a pick", async () => {
    assert.equal((await runPrGate([claudeResumePr({ isDraft: true })], RESUME_4510)).devResumePick, "none");
    assert.equal(
      (await runPrGate([claudeResumePr({ labels: [{ name: "ready-for-human" }] })], RESUME_4510)).devResumePick,
      "none",
    );
  });

  test("GLM-provenance PRs get the SAME resume pick — no provenance partition (#5058)", async () => {
    const byBranch = claudeResumePr({ headRefName: "worktree-agent-glm-4510-1" });
    const byLabel = claudeResumePr({ labels: [{ name: "glm-authored" }] });
    for (const pr of [byBranch, byLabel]) {
      const buckets = await runPrGate([pr], RESUME_4510);
      assert.match(buckets.devResumePick, /^issue-4510:4532:/, "the one provenance-agnostic pick owns it");
      assert.deepEqual(buckets.redResume, []);
    }
  });

  test("a ready-for-human PR stays excluded even when its issue is needs-dev-resume — the operator hand-back clears the label (#5058)", async () => {
    const stranded = claudeResumePr({ labels: [{ name: "ready-for-human" }, { name: "conflict-fix-attempted" }] });
    assert.equal((await runPrGate([stranded], RESUME_4510)).devResumePick, "none");
    const handedBack = claudeResumePr({ labels: [] });
    assert.match((await runPrGate([handedBack], RESUME_4510)).devResumePick, /^issue-4510:4532:/);
  });

  test("DIRTY / UNKNOWN merge state, a non-quiescent PR, and a pending required check all wait a turn", async () => {
    for (const mergeStateStatus of ["DIRTY", "UNKNOWN"]) {
      assert.equal((await runPrGate([claudeResumePr({ mergeStateStatus })], RESUME_4510)).devResumePick, "none");
    }
    assert.equal(
      (await runPrGate([claudeResumePr({ updatedAt: isoSecondsAgo(60) })], RESUME_4510)).devResumePick,
      "none",
      "an actively-pushed PR never races a resume",
    );
    assert.equal(
      (await runPrGate([claudeResumePr({ statusCheckRollup: greenRollup("test") })], RESUME_4510)).devResumePick,
      "none",
    );
  });

  test("zero or multiple closing refs disqualify (the anchor must be unambiguous)", async () => {
    for (const body of ["no closing ref here", "Closes #4510\nCloses #4511"]) {
      assert.equal((await runPrGate([claudeResumePr({ body })], RESUME_4510)).devResumePick, "none", body);
    }
  });

  test("the lowest-numbered qualifying PR wins", async () => {
    const buckets = await runPrGate(
      [claudeResumePr({ number: 4600, body: "Closes #4511", headRefName: "worktree-agent-bbb" }), claudeResumePr()],
      { devResumeIssuesJson: JSON.stringify([{ number: 4510 }, { number: 4511 }]) },
    );
    assert.equal(buckets.devResumePick, "issue-4510:4532:worktree-agent-a5706403c05633ec3");
  });

  test("a FAILED supporting read fails closed to none (never a partial classification)", async () => {
    assert.equal((await runPrGate([claudeResumePr()], { devResumeIssuesJson: "" })).devResumePick, "none");
    assert.equal(
      (await runPrGate([claudeResumePr()], { ...RESUME_4510, requiredContextsJson: "" })).devResumePick,
      "none",
    );
  });

  test("GLM red PR and Claude needs-dev-resume PR compete in ONE pick — lowest PR wins (#5058)", async () => {
    const glm = claudeResumePr({
      number: 4433,
      body: "Closes #4240",
      headRefName: "worktree-agent-glm-4240-1789",
      mergeStateStatus: "BLOCKED",
    });
    const buckets = await runPrGate([glm, claudeResumePr()], {
      devResumeIssuesJson: JSON.stringify([{ number: 4240 }, { number: 4510 }]),
    });
    assert.deepEqual(buckets.redResume, []);
    assert.equal(buckets.devResumePick, "issue-4240:4433:worktree-agent-glm-4240-1789");
  });
});

describe("pr-gate — UNKNOWN mergeStateStatus re-poll (#4812)", () => {
  /**
   * The ported `run(first, second, ghErr)`: the collector over a fake port
   * that serves a scripted first read and re-poll. `out` is the re-polled
   * payload (`applyMergeStateRepoll` — what the bash left in
   * ORCH_INFLIGHT_PR_JSON); `degraded` is whether the PR list itself was
   * marked degraded (the bash's ORCH_BOARD_DEGRADED analogue).
   */
  async function run(first: unknown, second: GhJsonRead, ghErr?: string, env: PrGateEnv = { unknownRepollDelaySeconds: "0" }) {
    const firstRead: GhJsonRead = typeof first === "string" ? jsonOrEmpty(first) : ok(first);
    const github = fakeGithub({ first: firstRead, repoll: second, repollStderr: ghErr });
    const sleeps: number[] = [];
    const outcome = await collectPrGate({
      github,
      now: () => NOW_MS,
      sleep: async (s) => {
        sleeps.push(s);
      },
      ghListLimit: 100,
      env,
    });
    const reread = github.prListReads() > 1;
    const out =
      firstRead.kind === "ok" && Array.isArray(firstRead.data)
        ? reread
          ? applyMergeStateRepoll(firstRead.data, second).rows
          : firstRead.data
        : first;
    return {
      ghCalls: github.prListReads(),
      out: out as any,
      stderr: outcome.notes.join("\n"),
      degraded: outcome.degraded.some((m) => m.field === "prList") ? "set" : "unset",
      sleeps,
    };
  }
  const pr = (number: number, mergeStateStatus: string) => ({ number, mergeStateStatus, headRefName: `b${number}`, body: "", labels: [] });

  test("UNKNOWN then known: the re-poll state is merged in and only mergeStateStatus changes", async () => {
    const { ghCalls, out, stderr } = await run(
      [pr(1, "UNKNOWN"), pr(2, "CLEAN")],
      ok([
        { number: 1, mergeStateStatus: "BLOCKED" },
        { number: 2, mergeStateStatus: "DIRTY" },
      ]),
    );
    assert.equal(ghCalls, 2);
    assert.equal(out[0].mergeStateStatus, "BLOCKED");
    assert.equal(out[0].headRefName, "b1");
    assert.equal(out[1].mergeStateStatus, "CLEAN", "known PRs keep their first-read state");
    assert.match(stderr, /re-poll resolved mergeStateStatus for PR\(s\): 1=BLOCKED \(issue #4812\)/);
  });

  test("UNKNOWN then UNKNOWN: stays UNKNOWN (fail closed) and is named on stderr", async () => {
    const { ghCalls, out, stderr } = await run(
      [pr(7, "UNKNOWN")],
      ok([
        { number: 7, mergeStateStatus: "UNKNOWN" },
        { number: 99, mergeStateStatus: "CLEAN" },
      ]),
    );
    assert.equal(ghCalls, 2);
    assert.equal(out.length, 1, "re-poll-only PRs are never appended");
    assert.equal(out[0].mergeStateStatus, "UNKNOWN");
    assert.match(stderr, /UNKNOWN after re-poll — skipping PR\(s\): 7 \(issue #4812\)/);
  });

  test("no UNKNOWN: exactly one gh read (no re-poll)", async () => {
    const { ghCalls, out } = await run([pr(3, "CLEAN")], ok([]));
    assert.equal(ghCalls, 1);
    assert.equal(out[0].mergeStateStatus, "CLEAN");
  });

  test("a failed re-poll keeps the first payload untouched and notes it", async () => {
    const { ghCalls, out, stderr, degraded } = await run([pr(4, "UNKNOWN")], jsonOrEmpty("not json"), "HTTP 502 bad gateway");
    assert.equal(ghCalls, 2);
    assert.equal(degraded, "unset", "a failed re-poll never degrades the PR list");
    assert.equal(out[0].mergeStateStatus, "UNKNOWN");
    assert.match(stderr, /UNKNOWN re-poll FAILED.*gh stderr: HTTP 502 bad gateway.*stay skipped: 4 \(issue #4812\)/);
  });

  test("a non-list (JSON object) re-poll payload is treated as a failed re-poll", async () => {
    const { ghCalls, out, stderr, degraded } = await run([pr(5, "UNKNOWN")], ok({}));
    assert.equal(ghCalls, 2);
    assert.equal(degraded, "unset");
    assert.equal(out[0].mergeStateStatus, "UNKNOWN");
    assert.match(stderr, /UNKNOWN re-poll FAILED \(not-a-list\).*stay skipped: 5 \(issue #4812\)/);
  });

  test("a PR absent from the re-poll ([]) keeps its first-read state and is named as still UNKNOWN", async () => {
    const { ghCalls, out, stderr, degraded } = await run([pr(6, "UNKNOWN"), pr(8, "CLEAN")], ok([]));
    assert.equal(ghCalls, 2);
    assert.equal(degraded, "unset");
    assert.equal(out[0].mergeStateStatus, "UNKNOWN");
    assert.equal(out[1].mergeStateStatus, "CLEAN");
    assert.match(stderr, /UNKNOWN after re-poll — skipping PR\(s\): 6 \(issue #4812\)/);
  });

  test("an unparseable first payload: probe notes the parse failure, no re-poll", async () => {
    const { ghCalls, out, stderr } = await run("not json", ok([]));
    assert.equal(ghCalls, 1);
    assert.equal(out, "not json");
    assert.match(stderr, /UNKNOWN probe could not parse first payload .*skipping re-poll \(issue #4812\)/);
  });

  test("a reducer crash keeps the first payload untouched and logs (INV-5)", async () => {
    // An unhashable (list) `number` in the re-poll broke the python reducer's
    // dict build; the TS reducer reports the same failure and keeps the first payload.
    const first = [pr(11, "UNKNOWN"), pr(12, "CLEAN")];
    const { ghCalls, out, stderr, degraded } = await run(first, ok([{ number: [11], mergeStateStatus: "CLEAN" }]));
    assert.equal(ghCalls, 2);
    assert.equal(degraded, "unset");
    assert.deepEqual(out, first, "first payload survives a reducer crash verbatim");
    assert.match(stderr, /UNKNOWN re-poll reducer failed or produced no output — keeping first payload/);
  });

  test("a non-numeric delay is logged and defaulted instead of aborting the re-poll", async () => {
    const { stderr, sleeps, out } = await run(
      [{ number: 21, mergeStateStatus: "UNKNOWN" }],
      ok([{ number: 21, mergeStateStatus: "CLEAN" }]),
      undefined,
      { unknownRepollDelaySeconds: "abc" },
    );
    assert.match(stderr, /non-numeric HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS='abc' — using 5/);
    assert.deepEqual(sleeps, [5]);
    assert.equal(out[0].mergeStateStatus, "CLEAN");
  });

  describe("end-to-end: re-polled payload -> pr-gate buckets and picks", () => {
    const greenRollup = () =>
      REQUIRED.map((name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: isoSecondsAgo(7000) }));
    const RESUME_4510 = { devResumeIssuesJson: JSON.stringify([{ number: 4510 }]) };
    const resumePr = () =>
      basePrGate({
        number: 4532,
        mergeStateStatus: "UNKNOWN",
        headRefName: "worktree-agent-a5706403c05633ec3",
        body: "Closes #4510",
        statusCheckRollup: greenRollup(),
      });
    const behindPr = () => basePrGate({ number: 4246, mergeStateStatus: "UNKNOWN", headRefName: "b4246", body: "" });

    test("UNKNOWN -> UNSTABLE on re-poll: the PR becomes the orch_dev_resume_pick", async () => {
      const { ghCalls } = await run([resumePr()], ok([{ number: 4532, mergeStateStatus: "UNSTABLE" }]));
      assert.equal(ghCalls, 2);
      const buckets = await runPrGate([resumePr()], RESUME_4510, ok([{ number: 4532, mergeStateStatus: "UNSTABLE" }]));
      assert.equal(buckets.devResumePick, "issue-4510:4532:worktree-agent-a5706403c05633ec3");
    });

    test("UNKNOWN -> BEHIND on re-poll: the PR lands in orch_prs_behind", async () => {
      const { ghCalls } = await run([behindPr()], ok([{ number: 4246, mergeStateStatus: "BEHIND" }]));
      assert.equal(ghCalls, 2);
      const buckets = await runPrGate([behindPr()], {}, ok([{ number: 4246, mergeStateStatus: "BEHIND" }]));
      assert.deepEqual(buckets.behind, [4246]);
      assert.deepEqual(buckets.unchecked, []);
    });

    test("UNKNOWN -> UNKNOWN on re-poll: the PR is neither picked nor bucketed (fail closed)", async () => {
      const second = ok([
        { number: 4532, mergeStateStatus: "UNKNOWN" },
        { number: 4246, mergeStateStatus: "UNKNOWN" },
      ]);
      const { ghCalls } = await run([resumePr(), behindPr()], second);
      assert.equal(ghCalls, 2);
      const buckets = await runPrGate([resumePr(), behindPr()], RESUME_4510, second);
      assert.equal(buckets.devResumePick, "none");
      assert.deepEqual(buckets.redResume, []);
      assert.deepEqual(buckets.behind, []);
      assert.deepEqual(buckets.dirty, []);
    });
  });
});

describe("pr-gate — dirty PR conflict fix-forward (issue #4807)", () => {
  function dirtyPr(overrides: Partial<PrGateOpenPr> = {}): PrGateOpenPr {
    return basePrGate({
      number: 4775,
      mergeStateStatus: "DIRTY",
      headRefName: "worktree-agent-dirty1",
      body: "Closes #4758",
      labels: [],
      updatedAt: isoSecondsAgo(7200),
      ...overrides,
    });
  }

  test("(a) quiescent unattempted DIRTY PR with one closing issue is pinned; bucket stays whole; not surfaced", async () => {
    const b = await runPrGate([dirtyPr()]);
    assert.equal(b.dirtyForwardFix, "issue-4758:4775:worktree-agent-dirty1");
    assert.deepEqual(b.dirty, [4775]);
    assert.equal(b.dirtySurface, "");
  });

  test("(a) the lowest-numbered candidate wins and the others wait", async () => {
    const b = await runPrGate([dirtyPr({ number: 4800, body: "Closes #4801", headRefName: "b2" }), dirtyPr({ number: 4775 })]);
    assert.equal(b.dirtyForwardFix, "issue-4758:4775:worktree-agent-dirty1");
    assert.equal(b.dirtySurface, "");
  });

  test("(b) a DIRTY PR pushed moments ago waits: no pin, no surface", async () => {
    const b = await runPrGate([dirtyPr({ updatedAt: isoSecondsAgo(30) })]);
    assert.equal(b.dirtyForwardFix, "none");
    assert.equal(b.dirtySurface, "");
  });

  test("(c) zero or >=2 closing issues surface immediately with closing none", async () => {
    const b = await runPrGate([dirtyPr({ number: 4775, body: "no ref" }), dirtyPr({ number: 4776, body: "Closes #1\nCloses #2" })]);
    assert.equal(b.dirtyForwardFix, "none");
    assert.equal(b.dirtySurface, "4775:none 4776:none");
  });

  test("(d) attempted + quiescent 5400s surfaces with its closing issue", async () => {
    const b = await runPrGate([dirtyPr({ labels: [{ name: "conflict-fix-attempted" }], updatedAt: isoSecondsAgo(6000) })]);
    assert.equal(b.dirtyForwardFix, "none");
    assert.equal(b.dirtySurface, "4775:4758");
    assert.deepEqual(b.dirty, [4775]);
  });

  test("(e) attempted but not quiescent waits (attempt in flight)", async () => {
    const b = await runPrGate([dirtyPr({ labels: [{ name: "conflict-fix-attempted" }], updatedAt: isoSecondsAgo(600) })]);
    assert.equal(b.dirtyForwardFix, "none");
    assert.equal(b.dirtySurface, "");
  });

  test("surfaces an unattempted single-anchor PR that can never be pinned (empty head)", async () => {
    const b = await runPrGate([dirtyPr({ headRefName: "" })]);
    assert.equal(b.dirtyForwardFix, "none");
    assert.equal(b.dirtySurface, "4775:4758");
  });

  test("surfaces an attempted PR whose updatedAt is unparseable", async () => {
    const b = await runPrGate([dirtyPr({ labels: [{ name: "conflict-fix-attempted" }], updatedAt: "not-a-date" })]);
    assert.equal(b.dirtySurface, "4775:4758");
  });

  test("a ready-for-human DIRTY PR is in neither the pin nor the surface", async () => {
    const b = await runPrGate([dirtyPr({ labels: [{ name: "ready-for-human" }] })]);
    assert.equal(b.dirtyForwardFix, "none");
    assert.equal(b.dirtySurface, "");
    assert.deepEqual(b.dirty, []);
  });

  test("INV-4: an unavailable reference predicate fails closed to none + empty surface, bucket intact", async () => {
    const r = await runPrGate([dirtyPr()], { requiredContextsJson: "[]", prRefs: PR_REFS_UNAVAILABLE });
    assert.equal(r.dirtyForwardFix, "none");
    assert.equal(r.dirtySurface, "");
    assert.deepEqual(r.dirty, [4775]);
    assert.match(r.stderr, /#4807/);
  });
});

// ---------------------------------------------------------------------------
// 3. Port read-count guard (#4941)
// ---------------------------------------------------------------------------

describe("pr-gate — port read-count + order guard (#4941)", () => {
  const CLEAN_ORDER = [
    "listOpenPrs",
    "latestWorkflowRunCreatedAt(push)",
    "latestWorkflowRunCreatedAt(pull_request)",
    "requiredStatusContexts",
    "listOpenIssueRowsByLabel",
  ];

  test("no UNKNOWN: EXACTLY five port reads, in the recorded order — the zero-added-reads guard", async () => {
    // The deleted "no Redis access in the PR-gate python block" case pinned
    // the collector's zero-added-reads property at the bash seam; this
    // restores that guard at the port seam — an added read (an extra gh call,
    // a Redis touch through a second port) trips the count, and a reordered
    // read trips the log.
    const github = fakeGithub({ first: ok([{ number: 1, mergeStateStatus: "CLEAN", headRefName: "b1", body: "", labels: [] }]) });
    await collectPrGate({ github, now: () => NOW_MS, sleep: async () => {}, ghListLimit: 100 });
    assert.equal(github.totalReads(), 5);
    assert.deepEqual(github.readLog(), CLEAN_ORDER);
  });

  test("one UNKNOWN: EXACTLY six reads — listOpenPrMergeStates second, after the sleep", async () => {
    const github = fakeGithub({
      first: ok([{ number: 2, mergeStateStatus: "UNKNOWN", headRefName: "b2", body: "", labels: [] }]),
      repoll: ok([{ number: 2, mergeStateStatus: "CLEAN" }]),
    });
    const sleeps: string[] = [];
    const logAtSleep: string[][] = [];
    await collectPrGate({
      github,
      now: () => NOW_MS,
      sleep: async (s) => {
        sleeps.push(String(s));
        logAtSleep.push([...github.readLog()]);
      },
      ghListLimit: 100,
      env: { unknownRepollDelaySeconds: "0" },
    });
    assert.equal(github.totalReads(), 6);
    assert.deepEqual(github.readLog(), ["listOpenPrs", "listOpenPrMergeStates", ...CLEAN_ORDER.slice(1)]);
    assert.deepEqual(sleeps, ["0"]);
    assert.deepEqual(logAtSleep, [["listOpenPrs"]], "the re-poll read is issued after the delay elapses, not before it");
  });
});

// ---------------------------------------------------------------------------
// 4. The CLI + port contract (new for the TS entry point)
// ---------------------------------------------------------------------------

describe("turn-snapshot CLI — fail-open contract (ADR-0043 D2)", () => {
  test("usage errors exit 2 without output (turn.sh then applies the all-degraded snapshot)", async () => {
    for (const argv of [
      ["--collectors", "pr-gate"],
      ["--collectors", "bogus", "--format", "values"],
      ["--collectors", "pr-gate", "--format", "json"],
      ["--collectors", "pr-gate", "--format", "kv"],
      ["--format", "values"],
      ["--gh-list-limit", "x", "--collectors", "pr-gate", "--format", "values"],
    ]) {
      let stdout = "";
      let stderr = "";
      const code = await main(argv, { github: fakeGithub({}), now: () => NOW_MS, sleep: async () => {} }, {
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
      });
      assert.equal(code, 2, JSON.stringify(argv));
      assert.equal(stdout, "");
      assert.match(stderr, /^turn-snapshot: /);
    }
    assert.match((parseArgs(["--format", "kv"]) as { error: string }).error, /kv wire was retired/);
    assert.deepEqual((parseArgs([]) as { format: string }).format, "json", "json is the default format");
  });

  test("a collector that throws returns the fully-degraded fallback, notes why, and exits 0", async () => {
    const broken = { ...fakeGithub({}), listOpenPrs: async () => Promise.reject(new Error("boom")) };
    let stdout = "";
    let stderr = "";
    const code = await main(
      ["--collectors", "pr-gate", "--format", "values"],
      { github: broken, now: () => NOW_MS, sleep: async () => {} },
      { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { "pr-gate": JSON.parse(JSON.stringify(prGateFallbackSnapshot("collector-crashed"))) });
    assert.match(stderr, /orch turn-snapshot pr-gate collector crashed \(boom\)/);
  });

  test("the production port resolves the repo through src/github/repo.ts (HYDRA_GITHUB_REPO), never a literal", async () => {
    const prior = process.env.HYDRA_GITHUB_REPO;
    process.env.HYDRA_GITHUB_REPO = "example-owner/example-repo";
    try {
      const seen: string[][] = [];
      const port = createTurnSnapshotGithub({
        transport: async (args) => {
          seen.push(args);
          return { ok: true, stdout: "[]\n", stderr: "" };
        },
      });
      await port.listOpenPrs(100);
      await port.requiredStatusContexts();
      assert.equal(seen[0][seen[0].indexOf("--repo") + 1], "example-owner/example-repo");
      assert.equal(seen[1][1], "repos/example-owner/example-repo/branches/master/protection/required_status_checks");
    } finally {
      if (prior === undefined) delete process.env.HYDRA_GITHUB_REPO;
      else process.env.HYDRA_GITHUB_REPO = prior;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The no-PR durable resume pick (issue #4808)
// ---------------------------------------------------------------------------

describe("pr-gate — no-PR durable resume pick (issue #4808)", () => {
  const NOW_SECONDS = NOW_MS / 1000;

  /** A parsed #4808 row, in the shape parseNoPrResumeRows emits. */
  const noprRow = (n: number, labels: string[], secondsAgo: number | null) => ({
    number: n,
    labels: new Set(labels),
    updatedAt: secondsAgo === null ? null : NOW_SECONDS - secondsAgo,
  });

  test("pickNoPrResume: picks the LOWEST-numbered qualifying issue regardless of payload order", () => {
    const pick = pickNoPrResume({
      // Deliberately NOT in ascending order — the min is numeric, never payload order (INV-2).
      rows: [noprRow(4830, ["needs-dev-resume"], 7000), noprRow(4826, ["needs-dev-resume"], 7000)],
      inflightUnion: new Set<number>(),
      nowSeconds: NOW_SECONDS,
      quiescenceSeconds: 5400,
    });
    assert.equal(pick, 4826, "the lowest-numbered qualifying issue wins, not the first in payload order");
  });

  test("pickNoPrResume: an issue referenced by any open PR is excluded (in-flight union)", () => {
    const rows = [noprRow(4826, ["needs-dev-resume"], 7000), noprRow(4830, ["needs-dev-resume"], 7000)];
    const pick = pickNoPrResume({ rows, inflightUnion: new Set([4826]), nowSeconds: NOW_SECONDS, quiescenceSeconds: 5400 });
    assert.equal(pick, 4830, "an in-flight issue stays with the #4807/#4518/#4460 PR-keyed pins (INV-7)");
  });

  test("pickNoPrResume: in-progress and ready-for-human rows never qualify", () => {
    const pick = pickNoPrResume({
      rows: [
        noprRow(4826, ["needs-dev-resume", "in-progress"], 7000),
        noprRow(4827, ["needs-dev-resume", "ready-for-human"], 7000),
        noprRow(4828, ["needs-dev-resume"], 7000),
      ],
      inflightUnion: new Set<number>(),
      nowSeconds: NOW_SECONDS,
      quiescenceSeconds: 5400,
    });
    assert.equal(pick, 4828);
  });

  test("pickNoPrResume: quiescence boundary — exactly at the window qualifies, one second under does not", () => {
    const rows = (s: number) => [noprRow(4826, ["needs-dev-resume"], s)];
    const at = pickNoPrResume({ rows: rows(5400), inflightUnion: new Set<number>(), nowSeconds: NOW_SECONDS, quiescenceSeconds: 5400 });
    const under = pickNoPrResume({ rows: rows(5399), inflightUnion: new Set<number>(), nowSeconds: NOW_SECONDS, quiescenceSeconds: 5400 });
    assert.equal(at, 4826, "at-least-the-window means exactly 5400s of quiet qualifies");
    assert.equal(under, null, "an issue reap just relabelled (still inside the window) must not be re-pinned");
  });

  test("pickNoPrResume: a row without needs-dev-resume or with a missing updatedAt is skipped, never a failed read", () => {
    const pick = pickNoPrResume({
      rows: [noprRow(4826, ["needs-qa"], 7000), noprRow(4827, ["needs-dev-resume"], null), noprRow(4828, ["needs-dev-resume"], 7000)],
      inflightUnion: new Set<number>(),
      nowSeconds: NOW_SECONDS,
      quiescenceSeconds: 5400,
    });
    assert.equal(pick, 4828, "missing/unparseable updatedAt skips the ROW, not the read (INV-2)");
  });

  test("pickNoPrResume: never throws on empty inputs", () => {
    assert.equal(pickNoPrResume({ rows: [], inflightUnion: new Set<number>(), nowSeconds: NOW_SECONDS, quiescenceSeconds: 5400 }), null);
  });

  /** The widened needs-dev-resume payload both parsers share (INV-3). */
  const noprRowsJson = JSON.stringify([
    { number: 4831, labels: [{ name: "needs-dev-resume" }, { name: "in-progress" }], updatedAt: isoSecondsAgo(7000) },
    { number: 4830, labels: [{ name: "needs-dev-resume" }], updatedAt: isoSecondsAgo(7000) },
    { number: 4826, labels: [{ name: "needs-dev-resume" }], updatedAt: isoSecondsAgo(7000) },
    { number: 4832, labels: [{ name: "needs-dev-resume" }], updatedAt: isoSecondsAgo(100) },
    { number: 4833, labels: [{ name: "needs-dev-resume" }] },
  ]);

  test("the needs-dev-resume read is widened in place — one listOpenIssueRowsByLabel call, parseDevResumeIssues output unchanged", async () => {
    // No open PRs at all: the union is legitimately empty and the pick is the
    // lowest quiescent, non-progress issue. runPrGate's own read-budget assert
    // (5 reads) + the CLEAN_ORDER guard pin INV-3's zero-added-reads property.
    const r = await runPrGate([], { devResumeIssuesJson: noprRowsJson });
    assert.equal(r.devResumeNoprAnchor, 4826);
    assert.doesNotMatch(r.stderr, /#4808 INV-4/, "a healthy read must not emit the fail-closed note");
  });

  test("an issue referenced by any open PR is excluded from the collector pick too (INV-7)", async () => {
    // PR 5001 closes #4826 (the lowest row) — the pick falls to 4830 while the
    // #4518 pin simultaneously owns 4826 through the SAME widened read. The
    // rollup is green on every required context so the #4518 arm's settled
    // gate passes (greenRollup is scoped to the #4518 describe; same shape).
    const green = REQUIRED.map((name) => ({
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: isoSecondsAgo(7000),
    }));
    const pr = basePrGate({
      number: 5001,
      mergeStateStatus: "UNSTABLE",
      headRefName: "worktree-agent-x-4826",
      body: "Closes #4826",
      statusCheckRollup: green,
    });
    const r = await runPrGate([pr], { devResumeIssuesJson: noprRowsJson });
    assert.equal(r.devResumeNoprAnchor, 4830);
    assert.equal(r.devResumePick, "issue-4826:5001:worktree-agent-x-4826", "the #4518 PR-keyed pick is unchanged by the widening");
  });

  test("an unparsable quiescence env falls back to 5400s with one note", async () => {
    const r = await runPrGate([], { devResumeIssuesJson: noprRowsJson, devResumeNoprQuiescenceSeconds: "not-a-number" });
    assert.equal(r.devResumeNoprAnchor, 4826, "the 5400s default applies");
    assert.match(r.stderr, /ORCH_DEV_RESUME_NOPR_QUIESCENCE_SECONDS unparsable .* — falling back to 5400s default \(issue #4808\)/);
  });

  test("no-PR pick fail-closed arms — every unusable input yields ok:false + one #4808 note + its own DegradedMarker", async () => {
    const healthy = { first: ok([]), resume: ok(JSON.parse(noprRowsJson)) };
    const cases: { name: string; opts: Partial<Parameters<typeof collectNoprOutcome>[0]> }[] = [
      { name: "open-PR list read empty", opts: { first: EMPTY } },
      { name: "open-PR list read unparseable", opts: { first: { kind: "unparseable" } } },
      { name: "pr-refs predicates unavailable", opts: { prRefs: PR_REFS_UNAVAILABLE } },
      { name: "needs-dev-resume read empty", opts: { resume: EMPTY } },
      { name: "needs-dev-resume read unparseable", opts: { resume: { kind: "unparseable" } } },
      { name: "open-PR page saturated (payload length >= ghListLimit)", opts: { ghListLimit: 1, first: ok([basePrGate({ number: 9001 })]) } },
    ];
    for (const c of cases) {
      const outcome = await collectNoprOutcome({ ...healthy, ...c.opts } as Parameters<typeof collectNoprOutcome>[0]);
      const pick = outcome.value.devResumeNoprPick;
      assert.equal(pick.ok, false, `${c.name}: the pick must be {ok:false}, never a guess`);
      assert.match(pick.reason, /.+/, `${c.name}: a machine-readable reason`);
      assert.equal(outcome.notes.filter((n) => n.includes("#4808") && n.includes("no-PR pick fail-closed")).length, 1, `${c.name}: exactly ONE stderr note naming #4808`);
      assert.ok(outcome.degraded.some((d) => d.field === "devResumeNoprPick"), `${c.name}: its own DegradedMarker (INV-4)`);
    }
  });

  test("the required-contexts read being unavailable does NOT fail the no-PR pick closed (INV-4)", async () => {
    const outcome = await collectNoprOutcome({ first: ok([]), resume: ok(JSON.parse(noprRowsJson)), required: EMPTY });
    assert.equal(outcome.value.devResumeNoprPick.ok, true);
    assert.equal(outcome.value.devResumeNoprPick.ok ? outcome.value.devResumeNoprPick.value : null, 4826);
  });

  test("prGateFallbackSnapshot carries the pick degraded", () => {
    assert.equal(prGateFallbackSnapshot("collector-crashed").devResumeNoprPick.ok, false);
  });
});

/** collectPrGate over a fake port, returning the raw outcome (degraded + notes included). */
async function collectNoprOutcome(o: {
  first: GhJsonRead;
  resume: GhJsonRead;
  required?: GhJsonRead;
  prRefs?: PrRefsAvailability;
  ghListLimit?: number;
  prs?: unknown[];
}): Promise<Awaited<ReturnType<typeof collectPrGate>>> {
  const github = fakeGithub({
    first: o.first,
    repoll: ok([]),
    required: o.required ?? ok(["test", "typecheck"]),
    resume: o.resume,
  });
  return collectPrGate({
    github,
    now: () => NOW_MS,
    sleep: async () => {},
    ghListLimit: o.ghListLimit ?? 100,
    ...(o.prRefs ? { prRefs: o.prRefs } : {}),
  });
}

// ---------------------------------------------------------------------------
// #5052 - the durable QA-verdict recheck signal (orch_qa_verdict_recheck)
// ---------------------------------------------------------------------------

describe("pr-gate — QA-verdict recheck (#5052)", () => {
  const REQUIRED = ["test", "typecheck"];
  const greenRollup = REQUIRED.map((name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: isoSecondsAgo(900) }));
  const redRollup = [{ ...greenRollup[0], conclusion: "FAILURE" }, greenRollup[1]];
  const pendingRollup = [{ ...greenRollup[0], status: "IN_PROGRESS", conclusion: null }, greenRollup[1]];

  const candidatePr = (n: number, extra: Record<string, unknown> = {}) =>
    ({
      ...basePrGate({ number: n, mergeStateStatus: "CLEAN", statusCheckRollup: greenRollup }),
      body: "Tier: 3 (core)\n\nCloses #1",
      autoMergeRequest: null,
      ...extra,
    }) as unknown;

  type Runner = { runQaVerdictEvent(pr: number, tier: number): Promise<unknown> };
  function run(prs: unknown[], opts: { required?: GhJsonRead; first?: GhJsonRead; host?: Runner | null } = {}) {
    return collectPrGate({
      github: fakeGithub({ first: opts.first ?? ok(prs), repoll: ok([]), required: opts.required ?? ok(REQUIRED), resume: ok([]) }),
      now: () => NOW_MS,
      sleep: async () => {},
      ghListLimit: 100,
      ...(opts.host === null ? {} : { host: opts.host ?? passHost() }),
    });
  }
  const passHost = (log: number[] = []): Runner => ({
    runQaVerdictEvent: async (pr: number, tier: number) => {
      log.push(pr);
      return { type: "qa-verdict", pr_number: pr, tier, verdict: "PASS", verdict_sha: "abc1234", head_sha: "abc1234def" };
    },
  });
  const value = (o: Awaited<ReturnType<typeof run>>) => (o.value.qaVerdictRecheck.ok ? o.value.qaVerdictRecheck.value : null);

  test("parseTierLine reads a line-anchored Tier N in 1-4 only", () => {
    assert.equal(parseTierLine("Tier: 3 (core)"), 3);
    assert.equal(parseTierLine("intro\n**Tier:** 2\n"), 2);
    assert.equal(parseTierLine("Tier: 0 (docs)"), null);
    assert.equal(parseTierLine("we think Tier: 3 is right"), null);
    assert.equal(parseTierLine(undefined), null);
  });

  test("a green, unarmed, tiered PR becomes a recheck entry whose fields are the script's stdout", async () => {
    const log: number[] = [];
    const o = await run([candidatePr(7)], { host: passHost(log) });
    assert.deepEqual(value(o), [{ pr: 7, tier: 3, verdict: "PASS", verdictSha: "abc1234", headSha: "abc1234def" }]);
    assert.deepEqual(log, [7]);
  });

  test("exclusions spend no script run: draft, ready-for-human, armed, DIRTY, UNKNOWN, no tier, red, pending", async () => {
    const log: number[] = [];
    const prs = [
      candidatePr(1, { isDraft: true }),
      candidatePr(2, { labels: [{ name: "ready-for-human" }] }),
      candidatePr(3, { autoMergeRequest: { enabledAt: "2026-10-01T00:00:00Z" } }),
      candidatePr(4, { mergeStateStatus: "DIRTY" }),
      candidatePr(5, { mergeStateStatus: "UNKNOWN" }),
      candidatePr(6, { body: "no tier here" }),
      candidatePr(8, { statusCheckRollup: redRollup }),
      candidatePr(9, { statusCheckRollup: pendingRollup }),
      candidatePr(10, { autoMergeRequest: undefined }),
    ];
    const o = await run(prs, { host: passHost(log) });
    assert.deepEqual(value(o), []);
    assert.deepEqual(log, [], "no excluded PR may cost a script run");
  });

  test("fail closed: unreadable PR list or required contexts yields [] plus a qaVerdictRecheck marker", async () => {
    for (const opts of [{ first: EMPTY }, { required: EMPTY }]) {
      const log: number[] = [];
      const o = await run([candidatePr(7)], { ...opts, host: passHost(log) });
      assert.equal(o.value.qaVerdictRecheck.ok, false);
      assert.ok(o.degraded.some((d) => d.field === "qaVerdictRecheck"));
      assert.deepEqual(log, []);
    }
  });

  test("fail closed: a null / throwing / mis-shaped script run omits that PR only; no PASS is synthesised", async () => {
    const host: Runner = {
      runQaVerdictEvent: async (pr: number, tier: number): Promise<unknown> => {
        if (pr === 11) return null;
        if (pr === 12) throw new Error("spawn failed");
        if (pr === 13) return { type: "qa-verdict", pr_number: 99, tier, verdict: "PASS", verdict_sha: "a", head_sha: "a" };
        return { type: "qa-verdict", pr_number: pr, tier, verdict: "PENDING", verdict_sha: "unknown", head_sha: "" };
      },
    };
    const o = await run([candidatePr(11), candidatePr(12), candidatePr(13), candidatePr(14)], { host });
    assert.deepEqual(value(o), [{ pr: 14, tier: 3, verdict: "PENDING", verdictSha: "unknown", headSha: "" }]);
    assert.equal(o.notes.filter((n) => n.includes("#5052")).length, 4, "one note per omission plus the thrown call");
  });

  test("bounded fan-out: at most 3 script runs in flight and 12 per turn; the overflow is skipped and noted", async () => {
    let inFlight = 0;
    let peak = 0;
    const log: number[] = [];
    const host: Runner = {
      runQaVerdictEvent: async (pr: number, tier: number) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        log.push(pr);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { type: "qa-verdict", pr_number: pr, tier, verdict: "PASS", verdict_sha: "abc1234", head_sha: "abc1234def" };
      },
    };
    const prs = Array.from({ length: 15 }, (_, i) => candidatePr(100 + i));
    const o = await run(prs, { host });
    assert.ok(peak <= 3, `peak concurrency ${peak} exceeds 3`);
    assert.equal(log.length, 12);
    assert.equal(value(o)?.length, 12);
    assert.equal(new Set(log).size, 12, "12 distinct PRs run");
    const skipped = prs.map((p) => (p as { number: number }).number).filter((n) => !log.includes(n));
    assert.equal(skipped.length, 3);
    assert.ok(o.notes.some((n) => n.includes("capped at 12") && skipped.every((n2) => n.includes(`#${n2}`))));
  });

  test("no starvation: the capped window rotates so every candidate is reached across successive turns", () => {
    const cands = Array.from({ length: 30 }, (_, i) => i + 1);
    const seen = new Set<number>();
    for (let step = 0; step < 30; step++) {
      const batch = rotateQaRecheckBatch(cands, 12, step * 60_000);
      assert.equal(batch.length, 12);
      assert.equal(new Set(batch).size, 12, "no duplicates within a window");
      batch.forEach((n) => seen.add(n));
    }
    assert.equal(seen.has(30), true, "the highest-numbered candidate is evaluated even when 12 lower ones never merge");
    assert.deepEqual(rotateQaRecheckBatch([1, 2, 3], 12, 999_999), [1, 2, 3]);
  });

  test("rotation does not alias with a fixed 5-minute turn cadence (n = 15/20/30/60)", () => {
    for (const n of [15, 20, 30, 60]) {
      const cands = Array.from({ length: n }, (_, i) => i + 1);
      const seen = new Set<number>();
      for (let turn = 0; turn < 60; turn++) {
        rotateQaRecheckBatch(cands, 12, 1_700_000_000_000 + turn * 300_000).forEach((c) => seen.add(c));
      }
      assert.equal(seen.size, n, `every candidate reached at n=${n}`);
    }
  });

  test("fail closed: a candidate with no host port yields [] plus a marker", async () => {
    const o = await run([candidatePr(7)], { host: null });
    assert.equal(o.value.qaVerdictRecheck.ok, false);
    assert.ok(o.degraded.some((d) => d.field === "qaVerdictRecheck"));
  });

  test("the five-read order is unchanged; only the open-PR read gains autoMergeRequest", async () => {
    const github = fakeGithub({ first: ok([candidatePr(7)]), repoll: ok([]), required: ok(REQUIRED), resume: ok([]) });
    await collectPrGate({ github, now: () => NOW_MS, sleep: async () => {}, ghListLimit: 100, host: passHost() });
    assert.equal(github.totalReads(), 5);
    assert.ok(PR_GATE_PR_FIELDS.endsWith(",autoMergeRequest"));
  });

  test("prGateFallbackSnapshot carries the recheck degraded", () => {
    assert.equal(prGateFallbackSnapshot(degradeDetail("x")).qaVerdictRecheck.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 4. A malformed payload degrades, never throws (#5084, the #4934 per-field contract)
// ---------------------------------------------------------------------------

/** Payloads no healthy `gh` read produces — every shape a typed fold must survive. */
const MALFORMED_READS: readonly GhJsonRead[] = [
  { kind: "unparseable" },
  ok(null),
  ok(true),
  ok(7),
  ok("text"),
  ok({ a: 1 }),
  ok([null, 7, "x", true, [], {}]),
  ok([
    {
      number: [1],
      labels: null,
      headRefName: 5,
      body: {},
      isDraft: {},
      mergeStateStatus: [],
      statusCheckRollup: { a: 1 },
      createdAt: 5,
      updatedAt: [],
    },
    { number: 9, labels: [{ name: 3 }, null, "x"], mergeStateStatus: "DIRTY", isDraft: [], statusCheckRollup: [null, 4, { name: {} }], updatedAt: "2026-10-07T03:20:07.000Z" },
  ]),
];

/** A port whose every read returns `read` (the runs reads get a non-timestamp string). */
function everyRead(read: GhJsonRead): PrGateGithubAll {
  return {
    listOpenPrs: async () => read,
    listOpenPrMergeStates: async () => ({ read, stderrHead: "" }),
    latestWorkflowRunCreatedAt: async () => "not-a-timestamp",
    requiredStatusContexts: async () => read,
    listOpenIssueRowsByLabel: async () => read,
  };
}
type PrGateGithubAll = Parameters<typeof collectPrGate>[0]["github"];

describe("Turn Snapshot pr-gate — a malformed payload degrades, never throws (#5084)", () => {
  MALFORMED_READS.forEach((read, i) => {
    test(`every read malformed (shape #${i}) → the collector resolves with integer buckets`, async () => {
      const o = await collectPrGate({ github: everyRead(read), now: () => NOW_MS, sleep: async () => {}, ghListLimit: 100 });
      for (const bucket of [o.value.dirty, o.value.unchecked, o.value.behind, ...Object.values(o.value.inflight)]) {
        assert.ok(bucket.every((n) => Number.isInteger(n)), `shape #${i}: a bucket holds only PR / issue numbers`);
      }
      assert.doesNotThrow(() => JSON.stringify(o.value));
      if (read.kind !== "ok") assert.ok(o.degraded.some((d) => d.field === "prList" && d.reason === "unparseable"), `shape #${i}: the PR list is marked`);
    });
  });

  test("one malformed read degrades ONLY its own fields — the PR buckets from a healthy list stand", async () => {
    const dirty = { number: 12, mergeStateStatus: "DIRTY", isDraft: false, labels: [], statusCheckRollup: [], createdAt: isoSecondsAgo(9000), updatedAt: isoSecondsAgo(9000) };
    const o = await collectPrGate({
      github: fakeGithub({ first: ok([dirty]), required: { kind: "unparseable" }, runsPush: isoSecondsAgo(10), runsPullRequest: isoSecondsAgo(10) }),
      now: () => NOW_MS,
      sleep: async () => {},
      ghListLimit: 100,
    });
    assert.deepEqual(o.value.dirty, [12]);
    assert.equal(o.value.ciTriggerStale.ok, true);
    assert.deepEqual(o.value.devResumePick, { ok: false, reason: "dev-resume-input-unavailable" });
    assert.deepEqual(
      o.degraded.map((d) => d.field),
      ["requiredContexts", "qaVerdictRecheck"],
      "only the required-contexts read and the recheck that consumes it degrade",
    );
  });

  test("a malformed env window falls back to its default with a not-numeric note; float literals are accepted", async () => {
    const notesFor = async (env: PrGateEnv) =>
      (await collectPrGate({ github: fakeGithub({}), now: () => NOW_MS, sleep: async () => {}, ghListLimit: 100, env })).notes.filter((n) => n.includes("unparsable"));
    assert.deepEqual(await notesFor({ uncheckedGraceSeconds: "10m" }), [
      'orch pr-gate ORCH_PR_UNCHECKED_GRACE_SECONDS unparsable (not-numeric: "10m") — falling back to 600s default (issue #4240)',
    ]);
    for (const accepted of [" 900 ", "1_800", "1e3", ".5", "5.", "inf", "-Infinity", "NaN"]) {
      assert.deepEqual(await notesFor({ glmRedQuiescenceSeconds: accepted, uncheckedGraceSeconds: accepted }), [], `${JSON.stringify(accepted)} is a window literal`);
    }
  });

  test("gh timestamps parse in the canonical second-resolution UTC shape only", () => {
    assert.equal(ghTimestampSeconds("2026-10-07T03:20:07Z"), Date.UTC(2026, 9, 7, 3, 20, 7) / 1000);
    assert.equal(ghTimestampSeconds("2026-1-7T3:2:7Z"), Date.UTC(2026, 0, 7, 3, 2, 7) / 1000, "one-digit fields, the windows' historical parse");
    for (const bad of ["2026-10-07T03:20:07.000Z", "2026-10-07T03:20:07+00:00", "2026-02-30T00:00:00Z", "2026-10-07T03:20:60Z", "", null, 1791344407]) {
      assert.equal(ghTimestampSeconds(bad), null, `${JSON.stringify(bad)} is not a gh timestamp`);
    }
  });
});

describe("pr-gate — rollup + required-contexts edge shapes (#5089 QA round 1)", () => {
  test("checkVerdictFor: a missing / non-array rollup is unsettled even with required [] (INV-3 exactly)", () => {
    for (const rollup of [undefined, null, {}, "x", 7]) {
      assert.deepEqual(checkVerdictFor(rollup, new Set()), { settled: false, red: false });
      assert.deepEqual(checkVerdictFor(rollup, new Set(["test"])), { settled: false, red: false });
    }
  });

  test("checkVerdictFor sibling pin: an empty ARRAY rollup with required [] stays settled; with a required name it is unsettled", () => {
    assert.deepEqual(checkVerdictFor([], new Set()), { settled: true, red: false });
    assert.deepEqual(checkVerdictFor([], new Set(["test"])), { settled: false, red: false });
  });

  test("checkVerdictFor: an IN_PROGRESS CheckRun with no conclusion is unsettled", () => {
    const rollup = [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS" }];
    assert.equal(checkVerdictFor(rollup, new Set(["test"])).settled, false);
  });

  test("required-contexts read of a non-list JSON ({} or 7) degrades as malformed-payload", async () => {
    for (const json of ["{}", "7"]) {
      const o = await collectPrGate({
        github: fakeGithub({ first: ok([]), required: parseJsonRead(json) }),
        now: () => NOW_MS,
        sleep: async () => {},
        ghListLimit: 100,
      });
      const d = o.degraded.find((x) => x.field === "requiredContexts");
      assert.ok(d, `${json}: requiredContexts is marked degraded`);
      assert.equal(d.reason, "malformed-payload");
    }
  });

  test("required-contexts sibling pin: JSON null is a healthy empty set; non-string / empty members are dropped, not degraded", async () => {
    const collect = (json: string) =>
      collectPrGate({ github: fakeGithub({ first: ok([]), required: parseJsonRead(json) }), now: () => NOW_MS, sleep: async () => {}, ghListLimit: 100 });
    const empty = await collect("null");
    assert.equal(empty.degraded.some((x) => x.field === "requiredContexts"), false);
    const mixed = await collect('["test", 5, "", null]');
    assert.equal(mixed.degraded.some((x) => x.field === "requiredContexts"), false, "non-string / empty members are dropped, not degraded");
  });
});
