/**
 * Regression test for issues #638 / #974 / #4766 — hydra-qa MUST clear
 * `needs-qa` from the source issue in every verdict-routing branch, and the
 * QA bounce label keys on "the linked PR is still open", not on GLM provenance.
 *
 * Before #5269 these invariants were pinned by parsing the bash fences of
 * `docs/operator-playbooks/hydra-qa.md` step 10. That bash now lives in
 * `scripts/qa/route.ts` (ADR-0046 Decision 7), so the SAME invariants are
 * asserted here against the route script's behaviour through a recording fake
 * `gh` — plus text pins on the playbook stubs that remain (strip-before-merge,
 * comment-not-approve, the retained merge fence).
 *
 * Issue #5317 (ADR-0047 D3): the exit is no longer a direct label edit. Every arm
 * leaves `needs-qa` through ONE `scripts/lifecycle.ts advance` seam call (the
 * `PlumbingPorts.advance` port here); PASS lands in `qa-passed`, never
 * `in-progress`, and only AFTER the verdict comment (the seam's `qa-verdict`
 * gate reads the trailer at head). No arm writes a state label by hand.
 *
 * Background of the contracts:
 *   - #638: a lingering `needs-qa` busy-looped `qa_orch` every autopilot tick
 *     (`src/autopilot/turn-snapshot/orch-board.ts` counts it to drive
 *     `signals.needs_qa_orch`), so EVERY verdict branch strips it.
 *   - #974: the strip must be REACHABLE before anything that can abort on a
 *     self-authored PR — `gh pr review --approve` always errors there, so a
 *     PASS is recorded as a comment and the strip runs first.
 *   - #4766: `ready-for-agent` on an open PR is a FRESH dev pick (duplicate PR);
 *     the open-PR bounce is `needs-dev-resume`, `ready-for-agent` only on a
 *     LIVE read of CLOSED/MERGED, and a failed/empty read defaults to
 *     `needs-dev-resume`. GLM provenance selects comment wording only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runRoute, type RouteDeps, type RouteOptions } from "../scripts/qa/route.ts";
import type { CmdResult, PlumbingPorts, SeamMoveInput, SeamMoveResult } from "../scripts/qa/_lib.ts";
/** Test-side view of a seam outcome: `rc !== 0` is a refusal named by `code`. */
type SeamOutcome = { rc: number; code: string };

/** The argv-shaped record of one in-process seam move (kept so the effect-order pins read as before). */
const seamArgv = (i: SeamMoveInput): string[] => [
  String(i.issue),
  i.to,
  ...Object.entries(i.evidence ?? {}).flatMap(([k, v]) => ["--evidence", `${k}=${v}`]),
  ...(i.reason !== undefined ? ["--reason", i.reason] : []),
  ...(i.rationale !== undefined ? ["--rationale", i.rationale] : []),
  "--actor",
  i.actor,
];
const seamResult = (o: SeamOutcome): SeamMoveResult => (o.rc === 0 ? { ok: true } : { ok: false, code: o.code });
/** The seam's one live read, faked from the harness's `gh pr view --json state` answer: the OPEN/CLOSED lane or a refusal. */
function bounceLane(state: string): { to: "needs-dev-resume" | "ready-for-agent" } | { code: string } {
  const s = state.trim();
  if (s === "OPEN") return { to: "needs-dev-resume" };
  if (s === "CLOSED") return { to: "ready-for-agent" };
  return { code: s === "MERGED" ? "pr-merged" : "fetch-failed" };
}

import type { PreflightResult } from "../src/schemas/qa-plumbing-cli.ts";
import { QA_ESCALATION_LABELS } from "../src/qa/round-action.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = readFileSync(join(__dirname, "..", "docs", "operator-playbooks", "hydra-qa.md"), "utf8");
const ROUTE_SRC = readFileSync(join(__dirname, "..", "scripts", "qa", "route.ts"), "utf8");

// ---- a minimal recording gh for runRoute ----------------------------------

const TRAILER = "QA-Verdict: FAIL pr=7 round=1 sha=0123456789ab blockers=1 max_severity=high";

function pre(over: Partial<PreflightResult> = {}, glm = false): PreflightResult {
  return {
    ok: true,
    stage: "ready",
    issue: 70,
    pr: { number: 7, headSha: "a".repeat(40), headRefName: "b", baseRefName: "master", mergeStateStatus: "CLEAN", glmAuthored: glm },
    fixedSha: "b".repeat(40),
    changedPaths: ["src/x.ts"],
    checks: { list: [{ name: "test", status: "completed", conclusion: "success", required: true }], degraded: false, source: "branch-protection" },
    spec: { found: false, input: null, skippedReason: "x", mode: "warn" },
    tier: { num: 3, adversarial: true },
    gate: { action: "admit", reason: "admit", redRequired: [], skipVerdict: null, skipCiSummary: null },
    fanout: { mode: "standard", reviewers: ["standards", "spec"], reason: "r" },
    stop: null,
    degraded: [],
    ...over,
  };
}

interface Canned {
  verdict: string;
  roundAction?: string;
  deepQa?: { action: string; failNumber?: number } | null;
}

function phase(c: Canned): PlumbingPorts["phase"] {
  return async (p) => {
    if (p === "fold") {
      return {
        fold: { reviewVerdict: c.verdict.startsWith("PASS") ? "PASS" : "FAIL", worstFinding: "", blocking: [], followUps: [] },
        counts: { blockers: c.verdict.startsWith("PASS") ? 0 : 1, maxSeverity: c.verdict.startsWith("PASS") ? "none" : "high" },
        report: "REPORT",
        verdict: { verdict: c.verdict, reason: "R" },
        ciSummary: "CI",
      };
    }
    if (p === "trailer") return { trailer: TRAILER, round: 1 };
    return {
      round: { action: c.roundAction ?? "bounce" },
      deepQa: c.deepQa ?? null,
      passMarker: c.deepQa?.action === "proceed" ? "M" : null,
      failMarker: c.deepQa ? "F" : null,
      escalationSummary: c.roundAction === "escalate" ? "E" : null,
      labels: QA_ESCALATION_LABELS,
    };
  };
}

async function route(
  c: Canned,
  o: { pre?: PreflightResult; state?: string; defer?: boolean; advance?: (args: string[]) => Partial<SeamOutcome> | undefined } = {},
): Promise<string[][]> {
  const calls: string[][] = [];
  const ports: PlumbingPorts = {
    async advance(input): Promise<SeamMoveResult> {
      const args = seamArgv(input);
      calls.push(["lifecycle", "advance", ...args]);
      return seamResult({ rc: 0, code: "", ...(o.advance?.(args) ?? {}) });
    },
    async qaBounce(input) {
      const lane = bounceLane(o.state ?? "OPEN");
      if ("code" in lane) return { ok: false, code: lane.code };
      const args = seamArgv({ issue: input.issue, to: lane.to, evidence: { pr: String(input.pr), ...(input.defer ? { defer: "1" } : {}) }, actor: input.actor });
      calls.push(["lifecycle", "advance", ...args]);
      const out = seamResult({ rc: 0, code: "", ...(o.advance?.(args) ?? {}) });
      if (out.ok === true) return { ok: true, to: lane.to };
      return out.code.startsWith("parked:") ? { ok: false, code: out.code, counts: [] } : { ok: false, code: out.code };
    },
    async gh(argv): Promise<CmdResult> {
      calls.push(argv);
      if (argv[0] === "pr" && argv[1] === "view") return { ok: true, stdout: `${o.state ?? "OPEN"}\n` };
      return { ok: true, stdout: "" };
    },
    async git() {
      return { ok: true, stdout: "" };
    },
    http: async () => null,
    fetchers: {} as never,
    phase: phase(c),
  };
  const opts: RouteOptions = {
    repo: "gaberoo322/hydra",
    defer: o.defer ?? false,
    dryRun: false,
    findingsPath: "/f",
    summariesPath: "/s",
  };
  const deps: RouteDeps = {
    readText: (p) => (p === "/s" ? JSON.stringify({ standardsSummary: "S", specSummary: "P" }) : "{}"),
    appendRows: async () => {},
    now: () => new Date(0),
    sleep: async () => {},
  };
  await runRoute(opts, o.pre ?? pre(), ports, deps);
  return calls.filter((a) => !(a[0] === "pr" && a[1] === "view"));
}

const argAfter = (a: readonly string[], f: string) => a[a.indexOf(f) + 1];
/** Does this call move the issue off needs-qa? Only the lifecycle seam may (ADR-0047 D4). */
const leavesNeedsQa = (a: readonly string[]): boolean => a[0] === "lifecycle" && a[1] === "advance";
/** The seam target of an advance call. */
const target = (a: readonly string[]): string => a[3] as string;
/** A by-hand state-label write (the retired shape): never allowed. */
const handLabelWrite = (a: readonly string[]): boolean =>
  (a[0] === "issue" && a[1] === "edit") || (a[0] === "api" && (a.includes("DELETE") || a.some((x) => x.includes("/labels"))));

describe("hydra-qa clears needs-qa on every verdict (issue #638)", () => {
  const arms: Array<[string, Canned, Parameters<typeof route>[1]]> = [
    ["PASS", { verdict: "PASS" }, {}],
    ["PASS-pending-CI", { verdict: "PASS-pending-CI" }, {}],
    ["FAIL on an open PR", { verdict: "FAIL" }, {}],
    ["FAIL on a GLM-authored PR", { verdict: "FAIL" }, { pre: pre({}, true) }],
    ["FAIL on a closed PR (not-open fallback)", { verdict: "FAIL" }, { state: "CLOSED" }],
    ["FAIL escalated (round cap, enforce park)", { verdict: "FAIL", roundAction: "escalate" }, { advance: (a) => (a[1] === "needs-dev-resume" ? { rc: 1, code: "parked:qa-fail-rounds" } : undefined) }],
    ["T4 1st deep-QA FAIL (bounce)", { verdict: "FAIL", roundAction: "deep-qa", deepQa: { action: "bounce", failNumber: 1 } }, { pre: pre({ tier: { num: 4, adversarial: true } }) }],
    ["T4 2nd deep-QA FAIL (block-and-escalate)", { verdict: "FAIL", roundAction: "deep-qa", deepQa: { action: "block-and-escalate", failNumber: 2 } }, { pre: pre({ tier: { num: 4, adversarial: true } }) }],
    ["step-6.6 defer", { verdict: "PASS" }, { pre: pre({ gate: { action: "defer", reason: "d", redRequired: [], skipVerdict: null, skipCiSummary: null } }), defer: true }],
  ];
  for (const [name, canned, o] of arms) {
    test(`${name} leaves needs-qa through the lifecycle seam, with no by-hand label write`, async () => {
      const calls = await route(canned, o);
      assert.ok(calls.some(leavesNeedsQa), `no seam advance among: ${calls.map((c) => c.slice(0, 3).join(" ")).join(" | ")}`);
      assert.ok(!calls.some(handLabelWrite), "ADR-0047 D4: no direct state-label write");
    });
  }

  test("a closed-PR defer still leaves needs-qa to ready-for-agent through the seam (the label-less orphan gap, #3788)", async () => {
    const calls = await route(
      { verdict: "PASS" },
      { pre: pre({ gate: { action: "defer", reason: "d", redRequired: [], skipVerdict: null, skipCiSummary: null } }), defer: true, state: "CLOSED" },
    );
    const adv = calls.find(leavesNeedsQa) as string[];
    assert.equal(target(adv), "ready-for-agent");
    assert.ok(adv.includes("defer=1"), "the trailer-less defer edge");
  });

  test("a MERGED-PR defer writes nothing: reconcile owns needs-qa -> closed (pr-merged stops the route)", async () => {
    const calls = await route(
      { verdict: "PASS" },
      { pre: pre({ gate: { action: "defer", reason: "d", redRequired: [], skipVerdict: null, skipCiSummary: null } }), defer: true, state: "MERGED" },
    );
    assert.ok(!calls.some(leavesNeedsQa), "no advance after a pr-merged refusal");
  });

  test("T4 first deep-QA FAIL bounces through the seam's one read: the lane follows the PR state, the route never names it", async () => {
    const t4 = { verdict: "FAIL", roundAction: "deep-qa", deepQa: { action: "bounce", failNumber: 1 } } as const;
    const t4pre = pre({ tier: { num: 4, adversarial: true } });
    const open = await route(t4, { pre: t4pre, state: "OPEN" });
    const closed = await route(t4, { pre: t4pre, state: "CLOSED" });
    assert.equal(target(open.find(leavesNeedsQa) as string[]), "needs-dev-resume");
    assert.equal(target(closed.find(leavesNeedsQa) as string[]), "ready-for-agent");
    assert.ok(!closed.some(handLabelWrite));
  });

  test("PASS-pending-CI never leaves the pre-#638 'leave needs-qa in place' instruction anywhere", () => {
    assert.doesNotMatch(PLAYBOOK, /Leave the needs-qa label in place/i);
    assert.doesNotMatch(ROUTE_SRC, /Leave the needs-qa label in place/i);
  });
});

describe("PASS leaves needs-qa reachably (issues #974, #5317)", () => {
  test("PASS records its verdict as a comment, never `gh pr review --approve` (self-author cannot self-approve, #848)", async () => {
    const calls = await route({ verdict: "PASS" });
    assert.ok(!calls.some((a) => a[0] === "pr" && a[1] === "review"), "no pr review call of any kind");
    assert.ok(calls.some((a) => a[0] === "pr" && a[1] === "comment"));
    assert.doesNotMatch(PLAYBOOK, /gh pr review\s+\$pr_number[^\n]*--approve/);
  });

  test("the PASS verdict comment precedes the qa-passed seam call (the qa-verdict gate reads the trailer), and route never reaches the merge call", async () => {
    const calls = await route({ verdict: "PASS" });
    const adv = calls.findIndex(leavesNeedsQa);
    const comment = calls.findIndex((a) => a[0] === "pr" && a[1] === "comment");
    assert.ok(comment >= 0 && adv > comment, "comment first (#5317 INV-8), then the seam call");
    assert.equal(target(calls[adv] as string[]), "qa-passed", "PASS lands in qa-passed, never in-progress");
    assert.ok(!calls.some((a) => a[0] === "pr" && a[1] === "merge"));
  });

  test("the playbook keeps the merge call AFTER the route stub, so the seam call has already run", () => {
    const route = PLAYBOOK.indexOf("scripts/qa/route.ts");
    const merge = PLAYBOOK.indexOf("gh pr merge $pr_number --repo gaberoo322/hydra --auto --squash --delete-branch");
    assert.ok(route > 0 && merge > route, "route (which advances off needs-qa) runs before the retained merge fence");
  });
});

describe("hydra-qa bounce label keys on open-PR state, not GLM provenance (issue #4766)", () => {
  test("the playbook no longer carries a bounce-label helper or any hand-spelled label fence", () => {
    assert.ok(!PLAYBOOK.includes(["qa_bounce_label", "() {"].join("")), "the helper moved into route.ts — one definition, in code");
    assert.ok(!/\$\(qa_bounce_label\)/.test(PLAYBOOK));
    assert.ok(!/gh issue (edit|comment)\b/.test(PLAYBOOK), "no gh issue edit/comment fence outside the retained merge fence");
    assert.ok(!/gh pr comment\b/.test(PLAYBOOK), "no gh pr comment fence outside the retained merge fence");
  });

  test("the route never reads the PR state itself on a FAIL: the seam's one read picks the lane", async () => {
    const calls = await route({ verdict: "FAIL" }, { state: "CLOSED" });
    assert.ok(!calls.some((a) => a[0] === "pr" && a[1] === "view" && a.includes("state")), "no route-side PR-state read");
    assert.equal(target(calls.find(leavesNeedsQa) as string[]), "ready-for-agent");
  });

  test("an open PR bounces to needs-dev-resume — GLM or not — and never adds ready-for-agent", async () => {
    for (const glm of [false, true]) {
      const calls = await route({ verdict: "FAIL" }, { pre: pre({}, glm) });
      const advs = calls.filter(leavesNeedsQa);
      assert.equal(advs.length, 1);
      assert.equal(target(advs[0] as string[]), "needs-dev-resume", `glm=${glm}`);
    }
  });

  test("the seam's one read picks the lane: CLOSED -> ready-for-agent, OPEN -> needs-dev-resume, MERGED writes nothing, an unreadable state refuses", async () => {
    for (const [state, want] of [["CLOSED", "ready-for-agent"], ["OPEN", "needs-dev-resume"]] as const) {
      const calls = await route({ verdict: "FAIL" }, { state });
      assert.equal(target(calls.find(leavesNeedsQa) as string[]), want, `state '${state}'`);
    }
    const merged = await route({ verdict: "FAIL" }, { state: "MERGED" });
    assert.ok(!merged.some(leavesNeedsQa), "MERGED: reconcile owns the exit");
    await assert.rejects(route({ verdict: "FAIL" }, { state: "" }), /bounce refused \(fetch-failed\)/);
  });
});

describe("the needs-qa collector documents the needs-qa contract (issue #638)", () => {
  // The needs-qa read moved from collect-state.sh into the typed Turn Snapshot
  // orch-board collector (ADR-0043 slice 2); collect-state.sh was deleted in #4934.
  const collectorPath = join(__dirname, "..", "src", "autopilot", "turn-snapshot", "orch-board.ts");
  const script = readFileSync(collectorPath, "utf8");

  test("the needs-qa collector's doc references issue #638", () => {
    // needs-qa on an issue means "diff not yet reviewed", NOT "PR is in CI".
    assert.match(
      script,
      /needs[_-]qa[\s\S]{0,800}#638/,
      "the orch-board collector's needs-qa doc must reference issue #638's contract",
    );
  });
});
