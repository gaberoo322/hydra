/**
 * Issue #5269 (ADR-0046 Decision 7) — the hydra-qa plumbing scripts
 * (`scripts/qa/{preflight,packet,route,poll}.ts`).
 *
 * The scripts add no verdict rule, so these tests pin PLUMBING: the fail-closed
 * defaults preflight emits, the byte shape of the review packet, the exact
 * order and bytes of route's `gh` effects (a recording fake `gh`), and the
 * bounded poll. The engine runs in-process over a fixture fetch port; nothing
 * touches GitHub, Redis or the network.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runPreflight, type PreflightDeps } from "../scripts/qa/preflight.ts";
import { runPacket, DELETED_FILE_SENTINEL, NO_STANDARDS_SENTENCE } from "../scripts/qa/packet.ts";
import { runRoute, type RouteDeps, type RouteOptions } from "../scripts/qa/route.ts";
import { runPoll } from "../scripts/qa/poll.ts";
import { phaseRunnerFor, type CmdResult, type CmdRunner, type PhaseRunner } from "../scripts/qa/common.ts";
import { runQaVerdictPhase, type QaVerdictFetchers } from "../src/qa/phases.ts";
import { DEEP_QA_FAIL_MARKER } from "../src/qa/round-action.ts";
import {
  PacketResultSchema,
  PreflightResultSchema,
  RouteResultSchema,
  type PreflightReady,
} from "../src/schemas/qa-plumbing-cli.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const FIXED = "fedcba9876543210fedcba9876543210fedcba98";
const ok = (stdout = ""): CmdResult => ({ ok: true, code: 0, stdout, stderr: "" });
const bad = (stderr = "boom"): CmdResult => ({ ok: false, code: 1, stdout: "", stderr });

const GREEN_ROLLUP = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
const PENDING_ROLLUP = [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }];
const RED_ROLLUP = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }];

function fixtureFetchers(over: Partial<QaVerdictFetchers> = {}): QaVerdictFetchers {
  return {
    async rollup() { return GREEN_ROLLUP; },
    async requiredContexts() { return ["test"]; },
    async headSha() { return HEAD; },
    async mergeStateStatus() { return "CLEAN"; },
    async changedFiles() { return ["src/a.ts"]; },
    async priorBodies() { return []; },
    async ancestry() { return { isAncestor: true, changedSince: ["src/a.ts"] }; },
    ...over,
  };
}
const enginePhase = (over: Partial<QaVerdictFetchers> = {}): PhaseRunner => {
  const f = fixtureFetchers(over);
  return phaseRunnerFor((phase, input) => runQaVerdictPhase(phase, input, f));
};

/** A recording fake `gh`: every argv is kept; `handler` may answer specific calls. */
function fakeGh(handler: (args: string[]) => CmdResult | undefined = () => undefined) {
  const calls: string[][] = [];
  const fn: CmdRunner = (args) => {
    calls.push(args);
    return handler(args) ?? ok("");
  };
  return Object.assign(fn, { calls });
}
const line = (args: string[]) => args.join(" ");

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

function preflightDeps(over: Partial<PreflightDeps> = {}): PreflightDeps & { gh: ReturnType<typeof fakeGh> } {
  const gh = fakeGh((a) => {
    if (a[0] === "pr" && a[1] === "view") {
      return ok(JSON.stringify({
        baseRefName: "master", headRefName: "worktree-agent-abc", mergeStateStatus: "CLEAN",
        headRefOid: HEAD, labels: [], body: "Closes #77\nTier: 3",
      }));
    }
    if (a[0] === "issue" && a[1] === "view") return ok(JSON.stringify({ labels: [] }));
    if (a[0] === "pr" && a[1] === "list") return ok(JSON.stringify([{ number: 5, body: "Closes #77" }]));
    return undefined;
  });
  const git: CmdRunner = (a) => {
    if (a[0] === "rev-parse") return ok(`${FIXED}\n`);
    if (a[0] === "diff") return ok("src/a.ts\n");
    return ok("");
  };
  return {
    gh,
    git,
    httpGet: async (url) => {
      if (url.includes("/resolve")) {
        return { status: 200, body: JSON.stringify({ found: true, concept: { anchorRef: "issue-77", invariants: ["x"] } }) };
      }
      if (url.includes("/api/tier")) return { status: 200, body: JSON.stringify({ tier: 3 }) };
      return null;
    },
    phase: enginePhase(),
    env: {},
    ...over,
  } as PreflightDeps & { gh: ReturnType<typeof fakeGh> };
}

describe("preflight (steps 1-6.7 in one read-only call)", () => {
  test("preflight: unreachable tier classifier yields tier null, adversarial true and gate admit", async () => {
    const deps = preflightDeps({
      httpGet: async (url) => (url.includes("/resolve") ? { status: 404, body: JSON.stringify({ found: false, reason: "none" }) } : null),
    });
    const r = await runPreflight({ issue: 77, pr: 5, repo: "o/r" }, deps);
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.equal(r.tier.num, null);
    assert.equal(r.tier.adversarial, true);
    assert.equal(r.gate.action, "admit");
    assert.equal(r.fanout.mode, "adversarial", "an unknown tier takes the full fan-out");
    assert.match(r.spec.skippedReason ?? "", /Phase A shadow mode/);
    PreflightResultSchema.parse(r);
  });

  test("preflight performs no write: the fake gh records only read verbs", async () => {
    const deps = preflightDeps();
    const r = await runPreflight({ issue: 77, repo: "o/r" }, deps);
    assert.ok(r.ok);
    // issue 77 had no --pr, so the PR list was consulted too.
    const verbs = deps.gh.calls.map((a) => `${a[0]} ${a[1]}`);
    for (const v of verbs) assert.match(v, /^(issue (list|view)|pr (list|view)|api )/, `non-read gh verb: ${v}`);
    for (const a of deps.gh.calls) {
      assert.ok(!a.some((x) => ["comment", "edit", "merge", "create", "-X"].includes(x)), `write-shaped argv: ${line(a)}`);
    }
  });

  test("preflight: a checks-fetch failure takes the engine's rollup-only all-optional mapping, tagged in degraded", async () => {
    const deps = preflightDeps({ phase: enginePhase({ requiredContexts: async () => null }) });
    const r = await runPreflight({ issue: 77, pr: 5, repo: "o/r" }, deps);
    assert.ok(r.ok);
    assert.deepEqual(r.checks.degraded, ["required-contexts"]);
    assert.equal(r.checks.list?.every((c) => c.required === false), true);
  });

  test("preflight: no linked PR is ok:false stage no-pr with the issue comment text, exit-0 shape", async () => {
    const deps = preflightDeps({ gh: fakeGh((a) => (a[0] === "pr" && a[1] === "list" ? ok("[]") : undefined)) });
    const r = await runPreflight({ issue: 77, repo: "o/r" }, deps);
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.stage, "no-pr");
    assert.equal(r.commentTarget, "issue");
  });

  test("preflight: enforce mode with a missing artifact is ok:false stage spec-missing-enforce", async () => {
    const deps = preflightDeps({
      env: { DESIGN_CONCEPT_MODE: "enforce" },
      httpGet: async (url) =>
        url.includes("/resolve") ? { status: 404, body: JSON.stringify({ found: false, reason: "no artifact", handle: { redisKey: "k" } }) } : null,
    });
    const r = await runPreflight({ issue: 77, pr: 5, repo: "o/r" }, deps);
    assert.ok(!r.ok);
    assert.equal(r.stage, "spec-missing-enforce");
    assert.match(r.message ?? "", /design-concept artifact required/);
  });

  test("preflight: single mode clears adversarial; the red-required admission skip carries the engine's FAIL", async () => {
    const docs = preflightDeps({
      phase: enginePhase({ changedFiles: async () => ["docs/x.md"] }),
      git: (a) => (a[0] === "diff" ? ok("docs/x.md\n") : ok(`${FIXED}\n`)),
    });
    const single = await runPreflight({ issue: 77, pr: 5, repo: "o/r" }, docs);
    assert.ok(single.ok);
    assert.equal(single.fanout.mode, "single");
    assert.equal(single.tier.adversarial, false);

    const red = preflightDeps({ phase: enginePhase({ rollup: async () => RED_ROLLUP }) });
    const skipped = await runPreflight({ issue: 77, pr: 5, repo: "o/r" }, red);
    assert.ok(skipped.ok);
    assert.equal(skipped.gate.action, "skip-required-failed");
    assert.equal(skipped.gate.skipVerdict?.verdict, "FAIL");
    assert.deepEqual(skipped.gate.redRequired, ["test"]);
  });
});

// ---------------------------------------------------------------------------
// packet
// ---------------------------------------------------------------------------

function readyPre(over: Partial<PreflightReady> = {}): PreflightReady {
  return {
    ok: true, stage: "ready", issue: 77, repo: "o/r",
    pr: { number: 5, headSha: HEAD, headRefName: "worktree-agent-abc", baseRefName: "master", mergeStateStatus: "CLEAN", glmAuthored: false },
    fixedSha: FIXED,
    changedPaths: ["src/a.ts"],
    checks: { list: [{ name: "test", status: "completed", conclusion: "success", required: true }], degraded: [] },
    spec: { found: true, input: { anchorRef: "issue-77" }, skippedReason: null, mode: "warn" },
    tier: { num: 2, adversarial: false },
    gate: { action: "admit", reason: "ok", redRequired: [], skipVerdict: null, skipCiSummary: null },
    fanout: { mode: "standard", reviewers: ["standards", "spec"], reason: "Review fan-out: standard" },
    degraded: [],
    ...over,
  };
}

function packetDeps(over: Record<string, unknown> = {}) {
  const written: Array<{ label: string; content: string }> = [];
  const gitCalls: string[][] = [];
  const base = {
    gh: fakeGh((a) => (a[1] === "view" ? ok(JSON.stringify({ body: "Merge danger: two-way — pure refactor\nCloses #77" })) : undefined)),
    git: ((a: string[]) => {
      gitCalls.push(a);
      if (a[0] === "diff" && a.includes("--name-only")) return ok("src/a.ts\nsrc/gone.ts\n");
      if (a[0] === "diff") return ok("diff --git a/src/a.ts b/src/a.ts\n+x\n\n");
      if (a[0] === "show") return a[1] === "HEAD:src/a.ts" ? ok("const a = 1;\n\n") : bad("fatal: path does not exist");
      if (a[0] === "rev-parse") return ok(`${HEAD}\n`);
      return ok("");
    }) as CmdRunner,
    phase: enginePhase(),
    loadStandards: async () => ({ ok: true as const, found: true as const, path: "/x/CODING_STANDARDS.md", text: "STD-RULE-ONE: do the thing", parsed: {} as never }),
    writeTemp: (label: string, content: string) => {
      written.push({ label, content });
      return `/tmp/${label}.txt`;
    },
    cwd: "/repo",
  };
  return { deps: { ...base, ...over }, written, gitCalls };
}

describe("packet (steps 7.0 / 7.0a / 7.0b)", () => {
  test("packet text: header, per-file sections, deleted-file sentinel, no standards text", async () => {
    const { deps, written } = packetDeps();
    const out = await runPacket(readyPre(), deps as never);
    assert.equal(out.exitCode, 0);
    assert.ok(out.result);
    PacketResultSchema.parse(out.result);
    const review = written.find((w) => w.label === "review-packet")!.content;
    assert.ok(review.startsWith(`Diff (${FIXED.slice(0, 12)}…HEAD):\n\ndiff --git a/src/a.ts b/src/a.ts\n+x\n\nFull contents of every changed file at HEAD:\n\n`));
    assert.ok(review.includes("===== src/a.ts @ HEAD =====\nconst a = 1;\n\n"), "trailing newlines of the body are stripped, then one blank line follows");
    assert.ok(review.includes(`===== src/gone.ts @ HEAD =====\n${DELETED_FILE_SENTINEL}\n\n`));
    assert.ok(!review.includes("STD-RULE-ONE"), "the Spec axis never sees the standards text");
    assert.ok(review.includes("Merge danger check (informational): declared=two-way detector="));
    assert.equal(written.find((w) => w.label === "standards-packet")!.content, "STD-RULE-ONE: do the thing");
    assert.equal(out.result.standardsFound, true);
  });

  test("packet: a missing CODING_STANDARDS.md writes the fixed sentence into the standards packet", async () => {
    const { deps, written } = packetDeps({ loadStandards: async () => ({ ok: true, found: false, path: "/x" }) });
    const out = await runPacket(readyPre(), deps as never);
    assert.equal(out.exitCode, 0);
    assert.equal(written.find((w) => w.label === "standards-packet")!.content, NO_STANDARDS_SENTENCE);
  });

  test("packet: standards catalog read failure exits 1 and writes no packet", async () => {
    const { deps, written, gitCalls } = packetDeps({
      loadStandards: async () => ({ ok: false, code: "standards-read-failed", path: "/x", message: "EACCES" }),
    });
    const out = await runPacket(readyPre(), deps as never);
    assert.equal(out.exitCode, 1);
    assert.equal(written.length, 0, "no packet file is written before the pre-spawn exit");
    assert.equal(gitCalls.length, 0, "the catalog is read before any diff is taken");
  });

  test("packet: prior findings are appended to the full packet with the since-verdict diff", async () => {
    const prior = "QA-Verdict: FAIL pr=5 round=1 sha=abcdef012345 blockers=1 max_severity=medium";
    const body = `> *Automated QA — two-axis review*\n\n## Findings\n\n| Severity | Axis | Reviewer | Location | Finding | Fix |\n|---|---|---|---|---|---|\n| medium | standards | standards | src/a.ts:1 | STD-X: bad | fix |\n\n${prior}`;
    const { deps, written } = packetDeps({ phase: enginePhase({ priorBodies: async () => [body] }) });
    const out = await runPacket(readyPre(), deps as never);
    assert.equal(out.exitCode, 0);
    const review = written.find((w) => w.label === "review-packet")!.content;
    if (out.result!.priorFindings !== "") {
      assert.ok(review.includes("RE-REVIEW CONTEXT — the previous QA round FAILed with the findings below."));
      assert.ok(review.includes(out.result!.priorFindings));
    } else {
      assert.ok(!review.includes("RE-REVIEW CONTEXT"));
    }
  });
});

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

const CLEAN_FINDINGS = JSON.stringify({ standards: [], spec: [] });
const MEDIUM_FINDINGS = JSON.stringify({
  standards: [{ severity: "medium", axis: "standards", location: "src/a.ts:1", finding: "STD-X: bad", fix: "fix it" }],
  spec: [],
});
const T4_REVIEWERS = ["reviewer-A-standards", "reviewer-A-spec", "reviewer-B-standards", "reviewer-B-spec"];
const T4_FINDINGS = JSON.stringify({
  "reviewer-A-standards": [{ severity: "low", axis: "standards", location: "src/a.ts:1", finding: "STD-X: bad", fix: "fix it" }],
  "reviewer-A-spec": [], "reviewer-B-standards": [], "reviewer-B-spec": [],
});
const failTrailer = (round: number) => `QA-Verdict: FAIL pr=5 round=${round} sha=${HEAD.slice(0, 12)} blockers=1 max_severity=medium`;

interface Scenario {
  pre?: Partial<PreflightReady>;
  findings?: string;
  rollup?: unknown[];
  prior?: string[];
  prState?: string | null;
  defer?: boolean;
  dryRun?: boolean;
  gapLine?: string | null;
  appendRows?: RouteDeps["appendRows"];
  fetchers?: Partial<QaVerdictFetchers>;
}

async function route(s: Scenario = {}) {
  const gh = fakeGh((a) => {
    if (a[0] === "pr" && a[1] === "view" && a.includes("state")) {
      return s.prState === null ? bad("gh down") : ok(`${s.prState ?? "OPEN"}\n`);
    }
    return undefined;
  });
  const appended: unknown[] = [];
  const deps: RouteDeps = {
    gh,
    phase: enginePhase({ rollup: async () => s.rollup ?? GREEN_ROLLUP, priorBodies: async () => s.prior ?? [], ...s.fetchers }),
    appendRows: s.appendRows ?? (async (rows) => { appended.push(rows); return { written: 0 }; }),
    now: () => "2026-11-03T00:00:00.000Z",
  };
  const pre = readyPre(s.pre);
  const opts: RouteOptions = {
    pre,
    findingsText: s.findings ?? CLEAN_FINDINGS,
    summaries: { standards: "Standards ok.", spec: "Spec ok." },
    gapLine: s.gapLine ?? null,
    defer: s.defer ?? false,
    dryRun: s.dryRun ?? false,
  };
  const out = await runRoute(opts, deps);
  return { out, gh, appended, writes: gh.calls.filter((a) => a[0] !== "pr" || a[1] !== "view") };
}

/** Bodies of every `gh ... comment --body` call, in order. */
const commentBodies = (calls: string[][]) =>
  calls.filter((a) => a.includes("comment")).map((a) => ({ target: `${a[0]} ${a[2]}`, body: a[a.indexOf("--body") + 1] as string }));

/** Real prior FAIL round bodies (findings table + trailer), produced by route itself. */
async function priorFailBodies(n: number): Promise<string[]> {
  const bodies: string[] = [];
  for (let i = 0; i < n; i++) {
    const { gh } = await route({ pre: PASS_PRE, findings: MEDIUM_FINDINGS, prior: [...bodies] });
    bodies.push(commentBodies(gh.calls).find((c) => c.target.startsWith("pr "))!.body);
  }
  return bodies;
}

const PASS_PRE: Partial<PreflightReady> = {
  checks: { list: [{ name: "test", status: "completed", conclusion: "success", required: true }], degraded: [] },
};

describe("route (steps 9 / 9.5 / 9.6 / 10 — the single effect owner)", () => {
  test("route PASS: needs-qa strip precedes the PR comment and no gh pr merge --auto is issued", async () => {
    const { out, gh } = await route({ pre: PASS_PRE });
    assert.equal(out.exitCode, 0);
    assert.ok(out.result);
    RouteResultSchema.parse(out.result);
    assert.equal(out.result.verdict, "PASS");
    assert.equal(out.result.nextStep, "arm-auto-merge");
    const writes = gh.calls.filter((a) => a[0] === "issue" || a.includes("comment") || a.includes("merge"));
    assert.equal(line(writes[0]!), "issue edit 77 --repo o/r --remove-label needs-qa --add-label in-progress");
    assert.equal(writes[1]![0], "pr");
    assert.equal(writes[1]![1], "comment");
    assert.ok(!gh.calls.some((a) => a.includes("merge")), "route never merges: the merge call stays in the playbook");
    assert.ok(!gh.calls.some((a) => a.includes("--auto")));
  });

  test("route FAIL on an open PR relabels needs-dev-resume; a failed state read also relabels needs-dev-resume", async () => {
    for (const prState of ["OPEN", null] as const) {
      const { out, gh } = await route({ pre: PASS_PRE, findings: MEDIUM_FINDINGS, prState });
      assert.equal(out.exitCode, 0);
      assert.equal(out.result!.verdict, "FAIL");
      const calls = gh.calls.map(line);
      assert.equal(calls[calls.findIndex((c) => c.includes("--disable-auto"))], "pr merge 5 --repo o/r --disable-auto");
      assert.ok(calls.includes("issue edit 77 --repo o/r --remove-label needs-qa --add-label needs-dev-resume"), `state ${prState}`);
      assert.ok(!calls.some((c) => c.includes("--add-label ready-for-agent")));
    }
  });

  test("route FAIL on a CLOSED or MERGED PR relabels ready-for-agent (confirmed not-open read only)", async () => {
    for (const prState of ["CLOSED", "MERGED"]) {
      const { gh } = await route({ pre: PASS_PRE, findings: MEDIUM_FINDINGS, prState });
      assert.ok(gh.calls.map(line).includes("issue edit 77 --repo o/r --remove-label needs-qa --add-label ready-for-agent"));
    }
  });

  test("route: a fold failure is exit 1 with no gh write (pre-verdict exit), never a PASS", async () => {
    const { out, gh } = await route({ pre: { checks: { list: null, degraded: ["rollup"] } } });
    assert.equal(out.exitCode, 1);
    assert.equal(out.result, null);
    assert.deepEqual(
      gh.calls.filter((a) => !(a[0] === "pr" && a[1] === "view")),
      [],
      "nothing is posted and needs-qa is untouched",
    );

    // An unreadable PR thread at T4 is also a pre-verdict exit (no safe degraded T4 answer).
    const t4 = await route({
      pre: { tier: { num: 4, adversarial: true }, fanout: { mode: "adversarial", reviewers: T4_REVIEWERS, reason: "r" } },
      findings: JSON.stringify(Object.fromEntries(T4_REVIEWERS.map((r) => [r, []]))),
      fetchers: { priorBodies: async () => null },
    });
    assert.equal(t4.out.exitCode, 1);
    assert.deepEqual(t4.gh.calls.filter((a) => !(a[0] === "pr" && a[1] === "view")), []);
  });

  test("route: a malformed findings file reaches the fold and fails closed to FAIL, never PASS", async () => {
    const { out } = await route({ pre: PASS_PRE, findings: "not json at all" });
    assert.equal(out.exitCode, 0);
    assert.equal(out.result!.verdict, "FAIL");
    assert.equal(out.result!.maxSeverity, "high");
  });

  test("route PASS-pending-CI: PR comment, then strip needs-qa + in-progress", async () => {
    const { out, gh } = await route({
      pre: { checks: { list: [{ name: "test", status: "in_progress", conclusion: null, required: true }], degraded: [] } },
      rollup: PENDING_ROLLUP,
    });
    assert.equal(out.result!.verdict, "PASS-pending-CI");
    const calls = gh.calls.filter((a) => a[0] === "pr" || a[0] === "issue").map((a) => `${a[0]} ${a[1]}`);
    assert.deepEqual(calls.filter((c) => c !== "pr view"), ["pr comment", "issue edit"]);
    const body = commentBodies(gh.calls)[0]!.body;
    assert.ok(body.startsWith("> *Automated QA — two-axis review (pending CI)*\n\n"));
    assert.ok(body.includes("Verdict: `PASS-pending-CI`. Autopilot will re-evaluate once required checks conclude. **The QA subagent has exited — no background wait.**"));
  });

  test("route skip-required-failed: no fold, the engine's FAIL, the skip report, currentReviewed false", async () => {
    const red = {
      checks: { list: [{ name: "test", status: "completed", conclusion: "failure", required: true }], degraded: [] },
      gate: {
        action: "skip-required-failed" as const, reason: "required failed", redRequired: ["test"],
        skipVerdict: { verdict: "FAIL", reason: "required CI check failed: test" }, skipCiSummary: "CI: test red",
      },
    };
    const { out, gh } = await route({ pre: red, rollup: RED_ROLLUP });
    assert.equal(out.result!.verdict, "FAIL");
    assert.equal(out.result!.blockers, 1);
    assert.equal(out.result!.worstFinding, "required CI check(s) red: test");
    const pr = commentBodies(gh.calls).find((c) => c.target.startsWith("pr "))!.body;
    assert.ok(pr.includes("_Review skipped by the admission gate (issue #3815)"));
    assert.ok(pr.includes("CI: test red"));
    const issue = commentBodies(gh.calls).find((c) => c.target.startsWith("issue "))!.body;
    assert.ok(issue.includes("\n\nRed required check(s): test\n\n"), "the red-required suffix rides the issue pointer");
  });

  test("route escalation: the 3rd reviewed FAIL round POSTs adds before DELETEs (label in the URL path), then the PR label", async () => {
    const { out, gh } = await route({
      pre: PASS_PRE,
      findings: MEDIUM_FINDINGS,
      prior: await priorFailBodies(2),
    });
    assert.equal(out.exitCode, 0);
    const api = gh.calls.filter((a) => a[0] === "api").map(line);
    assert.ok(api.length >= 3, `expected label API calls, got ${api.join(" | ")}`);
    const firstDelete = api.findIndex((c) => c.includes("-X DELETE"));
    const lastIssuePost = api.map((c, i) => (c.includes("-X POST") && c.includes("/issues/77/labels") ? i : -1)).filter((i) => i >= 0).pop()!;
    assert.ok(lastIssuePost < firstDelete, "issue adds precede removes");
    assert.ok(api.some((c) => /-X DELETE repos\/o\/r\/issues\/77\/labels\/needs-qa$/.test(c)), "the name is in the URL path, never -f name=");
    assert.ok(!api.some((c) => c.includes("-f name=")));
    assert.ok(api.some((c) => c.includes("repos/o/r/issues/5/labels")), "the PR label add");
    const issueBody = commentBodies(gh.calls).find((c) => c.target.startsWith("issue "))!.body;
    assert.ok(issueBody.startsWith("> *Automated QA escalated — operator decision needed*\n\n`FAIL` on PR #5 — "));
    assert.ok(issueBody.includes("Labelled `ready-for-human` (issue and PR)"));
  });

  test("route escalation: a 404 on a label DELETE counts as success, any other failure is named", async () => {
    const priors = await priorFailBodies(2);
    const mk = (stderr: string) => async () => {
      const gh = fakeGh((a) => (a.includes("DELETE") ? { ok: false, code: 1, stdout: "", stderr } : undefined));
      const deps: RouteDeps = {
        gh,
        phase: enginePhase({ priorBodies: async () => priors }),
        appendRows: async () => ({}),
        now: () => "t",
      };
      const out = await runRoute(
        { pre: readyPre(PASS_PRE), findingsText: MEDIUM_FINDINGS, summaries: { standards: "s", spec: "p" }, gapLine: null, defer: false, dryRun: false },
        deps,
      );
      return commentBodies(gh.calls).find((c) => c.target.startsWith("issue "))!.body + (out.exitCode === 0 ? "" : "!");
    };
    assert.ok((await mk("HTTP 404: Label does not exist")()).includes("Labelled `ready-for-human`"));
    assert.ok((await mk("HTTP 500")()).includes("**Label routing FAILED**"));
  });

  test("route T4 1st FAIL: disarm, PR comment carrying the engine's fail marker, bounce to dev", async () => {
    const t4 = {
      tier: { num: 4, adversarial: true },
      fanout: { mode: "adversarial", reviewers: T4_REVIEWERS, reason: "r" },
      checks: PASS_PRE.checks,
    };
    const { out, gh } = await route({ pre: t4, findings: T4_FINDINGS });
    assert.equal(out.result!.verdict, "FAIL");
    const calls = gh.calls.map(line);
    assert.equal(calls.filter((c) => !c.startsWith("pr view"))[0], "pr merge 5 --repo o/r --disable-auto");
    const bodies = commentBodies(gh.calls);
    assert.ok(bodies[0]!.body.startsWith("> *Automated QA — T4 Verifier-Core deep review*"));
    assert.ok(bodies[0]!.body.includes(`${DEEP_QA_FAIL_MARKER} (fail #1 on this PR)`));
    assert.ok(bodies[1]!.body.startsWith("> *T4 Deep-QA failed (1st) — bouncing to dev*"));
    assert.ok(calls.includes("issue edit 77 --repo o/r --remove-label needs-qa --add-label needs-dev-resume"));
  });

  test("route T4 2nd FAIL: block-and-escalate labels ready-for-human and does not bounce", async () => {
    const t4 = {
      tier: { num: 4, adversarial: true },
      fanout: { mode: "adversarial", reviewers: T4_REVIEWERS, reason: "r" },
      checks: PASS_PRE.checks,
    };
    const { out, gh } = await route({ pre: t4, findings: T4_FINDINGS, prior: [`${DEEP_QA_FAIL_MARKER} (fail #1 on this PR)\n\n${failTrailer(1)}`] });
    assert.equal(out.exitCode, 0);
    const calls = gh.calls.map(line);
    assert.ok(calls.includes("issue edit 77 --repo o/r --remove-label needs-qa --add-label ready-for-human"));
    assert.ok(commentBodies(gh.calls).some((c) => c.body.startsWith("> *T4 Deep-QA blocked — operator decision needed*")));
    assert.ok(!calls.some((c) => c.includes("needs-dev-resume")));
  });

  test("route T4 PASS: posts the engine's pass marker only when non-empty and never spells it", async () => {
    const t4 = {
      tier: { num: 4, adversarial: true },
      fanout: { mode: "adversarial", reviewers: T4_REVIEWERS, reason: "r" },
      checks: PASS_PRE.checks,
    };
    const clean = JSON.stringify(Object.fromEntries(T4_REVIEWERS.map((r) => [r, []])));
    const { out, gh } = await route({ pre: t4, findings: clean });
    assert.equal(out.result!.verdict, "PASS");
    const bodies = commentBodies(gh.calls);
    assert.equal(bodies.length, 2);
    assert.ok(bodies[1]!.body.startsWith("> *T4 Verifier-Core deep-QA — PASS proof*\n\n"));
    assert.ok(/Verifier-Core deep-QA: PASS @ [0-9a-f]{7,40}/.test(bodies[1]!.body), bodies[1]!.body);
  });

  test("route --defer: PR comment, then the bounce relabel and issue pointer; no verdict, no trailer", async () => {
    const pre = { gate: { action: "defer" as const, reason: "merge conflict", redRequired: ["test"], skipVerdict: null, skipCiSummary: null } };
    const open = await route({ pre, defer: true });
    assert.equal(open.out.exitCode, 0);
    assert.equal(open.out.result!.verdict, null);
    const calls = open.gh.calls.map(line).filter((c) => !c.startsWith("pr view"));
    assert.deepEqual(calls.map((c) => c.split(" --")[0]), ["pr comment 5", "issue edit 77", "issue comment 77"]);
    const bodies = commentBodies(open.gh.calls);
    assert.ok(bodies[0]!.body.startsWith("> *Automated QA — review deferred*\n\nmerge conflict\n\nNo verdict is being emitted"));
    assert.equal(
      bodies[1]!.body,
      "> *Automated QA — review deferred (open PR)*\n\nmerge conflict\n\nRed required check(s): test\n\nRelabelled `needs-dev-resume` (not `ready-for-agent`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the next attempt on this branch.",
    );
    assert.ok(!bodies.some((b) => /^QA-Verdict:/m.test(b.body)));

    const glm = await route({ pre: { ...pre, pr: { ...readyPre().pr, glmAuthored: true } }, defer: true });
    assert.ok(commentBodies(glm.gh.calls)[1]!.body.startsWith("> *Automated QA — review deferred (GLM-authored PR)*"));

    const closed = await route({ pre, defer: true, prState: "MERGED" });
    assert.deepEqual(
      closed.gh.calls.map(line).filter((c) => !c.startsWith("pr view")).map((c) => c.split(" --")[0]),
      ["pr comment 5", "issue edit 77"],
      "the not-open fallback relabels and posts no issue pointer",
    );
    assert.ok(closed.gh.calls.map(line).includes("issue edit 77 --repo o/r --remove-label needs-qa --add-label ready-for-agent"));
  });

  test("route --dry-run prints the identical plan with zero writes", async () => {
    const live = await route({ pre: PASS_PRE, findings: MEDIUM_FINDINGS });
    const dry = await route({ pre: PASS_PRE, findings: MEDIUM_FINDINGS, dryRun: true });
    assert.deepEqual(dry.out.result!.effects.map((e) => [e.kind, e.target]), live.out.result!.effects.map((e) => [e.kind, e.target]));
    assert.deepEqual(dry.gh.calls.filter((a) => !(a[0] === "pr" && a[1] === "view")), [], "no gh write in a dry run");
    assert.equal(dry.appended.length, 0, "a dry run appends no review-findings rows");
  });

  test("route appends review-findings rows after the verdict comment; a failure is named in degraded and is never fatal", async () => {
    const good = await route({ pre: PASS_PRE, findings: MEDIUM_FINDINGS });
    assert.equal(good.appended.length, 1);
    const failing = await route({
      pre: PASS_PRE,
      findings: MEDIUM_FINDINGS,
      appendRows: async () => { throw new Error("redis down"); },
    });
    assert.equal(failing.out.exitCode, 0);
    assert.ok(failing.out.result!.degraded.includes("review-findings"));
    assert.ok(failing.gh.calls.some((a) => a.includes("comment")), "the gh effects still ran");
  });

  test("route appends the merge-danger gap line to the report", async () => {
    const { gh } = await route({ pre: PASS_PRE, gapLine: "Merge-danger-gap: pr=5 sha=0123456789ab declared=one-way detector=two-way reason=-" });
    assert.ok(commentBodies(gh.calls)[0]!.body.includes("\n\nMerge-danger-gap: pr=5 sha=0123456789ab declared=one-way detector=two-way reason=-\n\n---"));
  });

  test("golden: every verdict body ends with exactly one QA-Verdict trailer line and matches the recorded template", async () => {
    const scenarios: Array<[string, Scenario, RegExp, RegExp | null]> = [
      ["PASS", { pre: PASS_PRE }, /^> \*Automated QA — two-axis review\*\n\n[\s\S]+\n\n---\n\n\*\*Verdict:\*\* `PASS` — .+\n\n[\s\S]*QA-Verdict: PASS pr=5 round=1 sha=0123456789ab blockers=0 max_severity=none$/, null],
      [
        "FAIL open",
        { pre: PASS_PRE, findings: MEDIUM_FINDINGS },
        /^> \*Automated QA — two-axis review\*\n\n[\s\S]+\n\n---\n\n\*\*Verdict:\*\* `FAIL` — .+\n\n[\s\S]*QA-Verdict: FAIL pr=5 round=1 sha=0123456789ab blockers=1 max_severity=medium$/,
        /^> \*Automated QA failed \(open PR\)\*\n\n`FAIL` on PR #5 — 1 blocker\(s\), worst: medium — src\/a\.ts:1 — STD-X: bad\. Full review on the PR\.\n\nRelabelled `needs-dev-resume` \(not `ready-for-agent`\) — the PR is still open, so the autopilot's durable resume pin \(issue #4518\) owns the retry on this branch\.\n\nQA-Verdict: FAIL pr=5 round=1 sha=0123456789ab blockers=1 max_severity=medium$/,
      ],
      [
        "FAIL GLM",
        { pre: { ...PASS_PRE, pr: { ...readyPre().pr, glmAuthored: true } }, findings: MEDIUM_FINDINGS },
        /QA-Verdict: FAIL pr=5/,
        /^> \*Automated QA failed \(GLM-authored PR\)\*\n\n`FAIL` on PR #5 — [\s\S]+\n\nRelabelled `needs-dev-resume` \(not `ready-for-agent`\) — the GLM drainer skips open-PR anchors; the autopilot's pinned forward-fix \(issue #4460\) owns the retry on this branch\.\n\nQA-Verdict: FAIL pr=5/,
      ],
      [
        "FAIL not-open",
        { pre: PASS_PRE, findings: MEDIUM_FINDINGS, prState: "CLOSED" },
        /QA-Verdict: FAIL pr=5/,
        /^> \*Automated QA failed\*\n\n`FAIL` on PR #5 — [\s\S]+\. Full review on the PR\.\n\nReturning to ready-for-agent for retry\.\n\nQA-Verdict: FAIL pr=5/,
      ],
    ];
    for (const [name, scenario, prRe, issueRe] of scenarios) {
      const { out, gh } = await route(scenario);
      assert.equal(out.exitCode, 0, name);
      const trailer = out.result!.trailer!;
      const bodies = commentBodies(gh.calls);
      for (const b of bodies) {
        assert.equal(b.body.split("\n").filter((l) => l.startsWith("QA-Verdict:")).length, 1, `${name}: exactly one trailer per body`);
        assert.ok(b.body.endsWith(trailer), `${name}: the trailer is the LAST line`);
      }
      assert.match(bodies[0]!.body, prRe, `${name}: PR body template`);
      if (issueRe) {
        const issue = bodies.find((b) => b.target.startsWith("issue "))!.body;
        assert.match(issue, issueRe, `${name}: issue pointer template`);
        assert.ok(issue.length <= 800, `${name}: issue pointer ≤ 800 chars (${issue.length})`);
        assert.ok(!issue.includes("## Findings"), "the issue pointer never carries the review report");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

describe("poll (the bounded foreground CI poll)", () => {
  const checksOut = (states: string[]) => states.map((s, i) => `check-${i}\t${s}\t1m\turl`).join("\n");

  test("poll: budget expiry reports settled:false and never re-arms", () => {
    const gh = fakeGh(() => ({ ok: false, code: 8, stdout: checksOut(["pass", "pending"]), stderr: "" }));
    const sleeps: number[] = [];
    const r = runPoll({ pr: 5, repo: "o/r", iterations: 3, intervalSeconds: 15 }, { gh, sleep: (s) => sleeps.push(s) });
    assert.equal(r.settled, false);
    assert.equal(r.pending, 1);
    assert.equal(r.iterations, 3);
    assert.equal(gh.calls.length, 3, "exactly --iterations reads, never more");
    assert.deepEqual(sleeps, [15, 15], "no sleep after the final iteration");
  });

  test("poll: settles as soon as no check is pending", () => {
    let n = 0;
    const gh = fakeGh(() => ok(checksOut(n++ < 1 ? ["pending"] : ["pass", "pass"])));
    const r = runPoll({ pr: 5, repo: "o/r", iterations: 40, intervalSeconds: 1 }, { gh, sleep: () => {} });
    assert.equal(r.settled, true);
    assert.equal(r.pending, 0);
    assert.equal(r.iterations, 2);
  });

  test("poll: an unreadable gh pr checks keeps polling with pending unknown and never settles", () => {
    const gh = fakeGh(() => bad("rate limited"));
    const r = runPoll({ pr: 5, repo: "o/r", iterations: 4, intervalSeconds: 1 }, { gh, sleep: () => {} });
    assert.equal(r.pending, null, "unknown is never read as terminal");
    assert.equal(r.settled, false);
    assert.equal(gh.calls.length, 4);
  });
});
