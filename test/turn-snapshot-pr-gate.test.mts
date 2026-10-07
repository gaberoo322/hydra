/**
 * Turn Snapshot — in-flight PR + PR-gate collector (ADR-0043 slice 1, #4929).
 *
 * Two suites, both at the TS interface with NO `gh` on PATH:
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
 *
 * 2. PORTED behavioural cases: the cases that lived in
 *    test/collect-state-inflight-exclusion.test.mts (#4240, #4460, #4518,
 *    #4807, #4812), 1:1 — same fixtures, same assertions — now driving
 *    `collectPrGate` through a fake port returning typed fixtures instead of
 *    regex-extracting a python heredoc.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { main, parseArgs } from "../scripts/autopilot/turn-snapshot.ts";
import {
  applyMergeStateRepoll,
  collectPrGate,
  prGateFallbackSnapshot,
  type PrGateEnv,
  type PrRefsAvailability,
} from "../src/autopilot/turn-snapshot/pr-gate.ts";
import {
  createTurnSnapshotGithub,
  type GhJsonRead,
  type GhTransport,
  type TurnSnapshotGithub,
} from "../src/autopilot/turn-snapshot/github-port.ts";
import { pyJsonLoads } from "../src/autopilot/turn-snapshot/py-compat.ts";
import { DEFAULT_GITHUB_REPO } from "../src/github/issues.ts";
import { withGoldenValues } from "./_helpers/turn-snapshot-golden.mts";

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
  };
}

// Other slices' goldens share the directory under their own prefix (slice 2: `orch-board-`).
const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("orch-board-")).sort();

describe("Turn Snapshot pr-gate — golden files from the bash collectors (ADR-0043 D4)", () => {
  test("the golden corpus is present (guards a vacuous pass)", () => {
    assert.ok(goldenFiles.length >= 90, `expected the captured corpus, found ${goldenFiles.length} files`);
  });

  for (const file of goldenFiles) {
    const g = withGoldenValues("root", file, JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8")) as Golden);
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
      assert.deepEqual(JSON.parse(stdout), g.expected.values, "the typed value (in-flight sets included) must match the golden");
      const notes = stderr.split("\n").filter((l) => l.startsWith("orch "));
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

/** A fake TurnSnapshotGithub returning typed fixtures and counting reads. */
function fakeGithub(o: FakeOpts): TurnSnapshotGithub & { prListReads: () => number } {
  let prListReads = 0;
  return {
    prListReads: () => prListReads,
    async listOpenPrs() {
      prListReads++;
      return o.first ?? ok([]);
    },
    async listOpenPrMergeStates() {
      prListReads++;
      return { read: o.repoll ?? ok([]), stderrHead: o.repollStderr ?? "" };
    },
    async latestWorkflowRunCreatedAt(event) {
      return (event === "push" ? o.runsPush : o.runsPullRequest) ?? null;
    },
    async requiredStatusContexts() {
      return o.required ?? ok(REQUIRED);
    },
    async openIssueNumbersByLabel() {
      return o.resume ?? ok([]);
    },
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
  glmRed: number[];
  glmRedForwardFix: string;
  devResumePick: string;
  dirtyForwardFix: string;
  dirtySurface: string;
  stderr: string;
}

interface PrGateOverrides {
  /** "" models a FAILED read (the INV-5 fail-closed path). */
  requiredContextsJson?: string;
  devResumeIssuesJson?: string;
  glmRedQuiescenceSeconds?: string;
  prRefs?: PrRefsAvailability;
}

const jsonOrEmpty = (s: string): GhJsonRead => {
  if (s === "") return EMPTY;
  const p = pyJsonLoads(s);
  return "error" in p ? { kind: "unparseable", error: p.error } : ok(p.value);
};

/**
 * A pin in the Anchor-reference notation signal EVENTS carry
 * (`issue-N:PR:branch`), `none` when absent or degraded — the ported cases
 * keep their assertions in it.
 */
const pinRef = (p: { issue: number; pr: number; headRefName: string } | null) => (p === null ? "none" : `issue-${p.issue}:${p.pr}:${p.headRefName}`);

/** The ported `runPrGate`: the collector over a fake port, its typed value as flat buckets. */
async function runPrGate(prs: unknown[], overrides: PrGateOverrides = {}, repoll?: GhJsonRead): Promise<PrGateBuckets> {
  const outcome = await collectPrGate({
    github: fakeGithub({
      first: ok(prs),
      repoll,
      required: jsonOrEmpty(overrides.requiredContextsJson ?? JSON.stringify(REQUIRED)),
      resume: jsonOrEmpty(overrides.devResumeIssuesJson ?? "[]"),
    }),
    now: () => NOW_MS,
    sleep: async () => {},
    ghListLimit: 100,
    env: { uncheckedGraceSeconds: "600", glmRedQuiescenceSeconds: overrides.glmRedQuiescenceSeconds ?? "1800" },
    ...(overrides.prRefs ? { prRefs: overrides.prRefs } : {}),
  });
  const v = outcome.value;
  const glm = v.glmRed.ok ? v.glmRed.value : { bucket: [], pick: null };
  const dirtyFix = v.dirtyFix.ok ? v.dirtyFix.value : { pick: null, surface: [] };
  return {
    dirty: [...v.dirty],
    unchecked: [...v.unchecked],
    behind: [...v.behind],
    ciTriggerStale: v.ciTriggerStale.ok && v.ciTriggerStale.value,
    glmRed: [...glm.bucket],
    glmRedForwardFix: pinRef(glm.pick),
    devResumePick: pinRef(v.devResumePick.ok ? v.devResumePick.value : null),
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
});

describe("pr-gate — GLM red-PR forward-fix predicate (issue #4460)", () => {
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

  test("a qualifying GLM red PR (branch-prefix provenance, red required `test`) yields the forward-fix pick", async () => {
    const buckets = await runPrGate([baseGlmPr()]);
    assert.deepEqual(buckets.glmRed, [4433]);
    assert.equal(buckets.glmRedForwardFix, "issue-4240:4433:worktree-agent-glm-4240-1789");
  });

  test("glm-authored LABEL provenance also qualifies (INV-3a OR-predicate, same as #4048)", async () => {
    const pr = baseGlmPr({
      number: 4450,
      headRefName: "issue-4450-not-a-worktree-branch",
      labels: [{ name: "glm-authored" }],
      body: "Closes #4450",
    });
    const buckets = await runPrGate([pr]);
    assert.equal(buckets.glmRedForwardFix, "issue-4450:4450:issue-4450-not-a-worktree-branch");
  });

  test("an advisory (non-required) FAILURE never qualifies (INV-4)", async () => {
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup(undefined, [
        { __typename: "CheckRun", name: "advisory-checks", status: "COMPLETED", conclusion: "FAILURE", startedAt: isoSecondsAgo(7000) },
      ]),
    });
    const buckets = await runPrGate([pr]);
    assert.deepEqual(buckets.glmRed, []);
    assert.equal(buckets.glmRedForwardFix, "none");
  });

  test("CANCELLED on a required check is NOT red — dedupe keeps the LATEST entry (INV-4)", async () => {
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup("test", [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "CANCELLED", startedAt: isoSecondsAgo(6900) },
      ]),
    });
    const buckets = await runPrGate([pr]);
    assert.deepEqual(buckets.glmRed, [], "CANCELLED must never arm a dispatch");
  });

  test("a still-PENDING required check disqualifies (INV-3e) — even with another check red", async () => {
    const buckets = await runPrGate([baseGlmPr({ statusCheckRollup: fullRequiredRollup("test").slice(0, -1) })]);
    assert.deepEqual(buckets.glmRed, []);
  });

  test("a non-GLM PR with an identical red required check never qualifies (INV-3a)", async () => {
    const buckets = await runPrGate([baseGlmPr({ headRefName: "issue-4240-plain-branch", labels: [] })]);
    assert.deepEqual(buckets.glmRed, []);
    assert.equal(buckets.glmRedForwardFix, "none");
  });

  test("not-yet-quiescent (updatedAt inside the 1800s window) disqualifies (INV-3c)", async () => {
    const buckets = await runPrGate([baseGlmPr({ updatedAt: isoSecondsAgo(300) })]);
    assert.deepEqual(buckets.glmRed, []);
  });

  test("draft / ready-for-human / DIRTY / UNKNOWN each disqualify (INV-3b)", async () => {
    for (const [name, over] of [
      ["draft", { isDraft: true }],
      ["ready-for-human", { labels: [{ name: "ready-for-human" }] }],
      ["DIRTY", { mergeStateStatus: "DIRTY" }],
      ["UNKNOWN", { mergeStateStatus: "UNKNOWN" }],
    ] as const) {
      const buckets = await runPrGate([baseGlmPr(over as Partial<PrGateOpenPr>)]);
      assert.deepEqual(buckets.glmRed, [], `${name} must disqualify`);
    }
  });

  test("exactly-one closing issue is required — two closing refs and zero both disqualify (INV-3d)", async () => {
    for (const body of ["Closes #4240\n\nCloses #9999", "Refs #4240"]) {
      const buckets = await runPrGate([baseGlmPr({ body })]);
      assert.deepEqual(buckets.glmRed, [], `body "${body}" must disqualify`);
    }
  });

  test("the needs-dev-resume arm qualifies an all-green GLM PR whose closed issue carries the label (INV-3f)", async () => {
    const buckets = await runPrGate([baseGlmPr({ statusCheckRollup: fullRequiredRollup() })], {
      devResumeIssuesJson: JSON.stringify([{ number: 4240 }]),
    });
    assert.deepEqual(buckets.glmRed, [4433]);
    assert.equal(buckets.glmRedForwardFix, "issue-4240:4433:worktree-agent-glm-4240-1789");
  });

  test("a StatusContext FAILURE on a required context is red (deep-qa-gate commit status shape)", async () => {
    const rollup = fullRequiredRollup().map((e) =>
      e.name === "deep-qa-gate"
        ? { __typename: "StatusContext", context: "deep-qa-gate", state: "FAILURE", startedAt: isoSecondsAgo(7000) }
        : e,
    );
    const buckets = await runPrGate([baseGlmPr({ statusCheckRollup: rollup })]);
    assert.deepEqual(buckets.glmRed, [4433]);
  });

  test("the LOWEST-numbered qualifying PR wins the pick; the debug bucket is sorted (INV-2)", async () => {
    const later = baseGlmPr({ number: 4470, headRefName: "worktree-agent-glm-4266-1", body: "Closes #4266" });
    const earlier = baseGlmPr({ number: 4465, headRefName: "worktree-agent-glm-4300-1", body: "Closes #4300" });
    const buckets = await runPrGate([later, earlier]);
    assert.deepEqual(buckets.glmRed, [4465, 4470]);
    assert.equal(buckets.glmRedForwardFix, "issue-4300:4465:worktree-agent-glm-4300-1");
  });

  test("a failed required-contexts read fails CLOSED: empty buckets + stderr note, never a dispatch pick (INV-5)", async () => {
    const r = await runPrGate([baseGlmPr()], { requiredContextsJson: "" });
    assert.deepEqual(r.glmRed, []);
    assert.equal(r.glmRedForwardFix, "none");
    assert.match(r.stderr, /glm-red classifier fail-closed.*#4460 INV-5/, "INV-5 requires a stderr note naming WHY the signal is empty");
    // The four #4240 buckets are unaffected — fail-closed toward NO dispatch, NOT board degradation.
    assert.deepEqual(r.behind, []);
  });

  test("legacy #4240 classification is unchanged by the #4460 additions (regression control)", async () => {
    const buckets = await runPrGate([basePrGate({ number: 4246, updatedAt: isoSecondsAgo(7200) })]);
    assert.deepEqual(buckets.behind, [4246]);
    assert.deepEqual(buckets.glmRed, []);
    assert.equal(buckets.glmRedForwardFix, "none");
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
    assert.equal(buckets.glmRedForwardFix, "none", "no GLM provenance -> the #4460 arm stays dormant");
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

  test("GLM-provenance PRs are left to the #4460 arm (disjoint picks; its cap stays the only owner)", async () => {
    const byBranch = claudeResumePr({ headRefName: "worktree-agent-glm-4510-1" });
    const byLabel = claudeResumePr({ labels: [{ name: "glm-authored" }] });
    for (const pr of [byBranch, byLabel]) {
      const buckets = await runPrGate([pr], RESUME_4510);
      assert.equal(buckets.devResumePick, "none");
      assert.match(buckets.glmRedForwardFix, /^issue-4510:4532:/, "the GLM arm still owns it");
    }
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

  test("the #4460 GLM pick is unchanged by the #4518 addition (regression control)", async () => {
    const glm = claudeResumePr({
      number: 4433,
      body: "Closes #4240",
      headRefName: "worktree-agent-glm-4240-1789",
      mergeStateStatus: "BLOCKED",
    });
    const buckets = await runPrGate([glm, claudeResumePr()], {
      devResumeIssuesJson: JSON.stringify([{ number: 4240 }, { number: 4510 }]),
    });
    assert.deepEqual(buckets.glmRed, [4433]);
    assert.equal(buckets.glmRedForwardFix, "issue-4240:4433:worktree-agent-glm-4240-1789");
    assert.equal(buckets.devResumePick, "issue-4510:4532:worktree-agent-a5706403c05633ec3");
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
    assert.match(stderr, /UNKNOWN re-poll FAILED \(not a list\).*stay skipped: 5 \(issue #4812\)/);
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
      assert.equal(buckets.glmRedForwardFix, "none");
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
// 3. The CLI + port contract (new for the TS entry point)
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
