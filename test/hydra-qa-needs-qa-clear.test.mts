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
import type { CmdResult, PlumbingPorts } from "../scripts/qa/_lib.ts";
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
  o: { pre?: PreflightResult; state?: string; defer?: boolean } = {},
): Promise<string[][]> {
  const calls: string[][] = [];
  const ports: PlumbingPorts = {
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
  };
  await runRoute(opts, o.pre ?? pre(), ports, deps);
  return calls.filter((a) => !(a[0] === "pr" && a[1] === "view"));
}

const argAfter = (a: readonly string[], f: string) => a[a.indexOf(f) + 1];
/** Does this call strip needs-qa from the issue (relabel edit, or the escalation DELETE)? */
const stripsNeedsQa = (a: readonly string[]): boolean =>
  (a[0] === "issue" && a[1] === "edit" && argAfter(a, "--remove-label") === "needs-qa") ||
  (a[0] === "api" && a.includes("DELETE") && a.some((x) => x.endsWith("/issues/70/labels/needs-qa")));

describe("hydra-qa clears needs-qa on every verdict (issue #638)", () => {
  const arms: Array<[string, Canned, Parameters<typeof route>[1]]> = [
    ["PASS", { verdict: "PASS" }, {}],
    ["PASS-pending-CI", { verdict: "PASS-pending-CI" }, {}],
    ["FAIL on an open PR", { verdict: "FAIL" }, {}],
    ["FAIL on a GLM-authored PR", { verdict: "FAIL" }, { pre: pre({}, true) }],
    ["FAIL on a closed PR (not-open fallback)", { verdict: "FAIL" }, { state: "CLOSED" }],
    ["FAIL escalated (round cap)", { verdict: "FAIL", roundAction: "escalate" }, {}],
    ["T4 1st deep-QA FAIL (bounce)", { verdict: "FAIL", roundAction: "deep-qa", deepQa: { action: "bounce", failNumber: 1 } }, { pre: pre({ tier: { num: 4, adversarial: true } }) }],
    ["T4 2nd deep-QA FAIL (block-and-escalate)", { verdict: "FAIL", roundAction: "deep-qa", deepQa: { action: "block-and-escalate", failNumber: 2 } }, { pre: pre({ tier: { num: 4, adversarial: true } }) }],
    ["step-6.6 defer", { verdict: "PASS" }, { pre: pre({ gate: { action: "defer", reason: "d", redRequired: [], skipVerdict: null, skipCiSummary: null } }), defer: true }],
  ];
  for (const [name, canned, o] of arms) {
    test(`${name} strips needs-qa from the source issue`, async () => {
      const calls = await route(canned, o);
      assert.ok(calls.some(stripsNeedsQa), `no needs-qa strip among: ${calls.map((c) => c.slice(0, 3).join(" ")).join(" | ")}`);
    });
  }

  test("a not-open defer still strips needs-qa (the label-less orphan gap, #3788)", async () => {
    const calls = await route(
      { verdict: "PASS" },
      { pre: pre({ gate: { action: "defer", reason: "d", redRequired: [], skipVerdict: null, skipCiSummary: null } }), defer: true, state: "MERGED" },
    );
    const edit = calls.find((a) => a[1] === "edit") as string[];
    assert.equal(argAfter(edit, "--remove-label"), "needs-qa");
    assert.equal(argAfter(edit, "--add-label"), "ready-for-agent");
  });

  test("PASS-pending-CI never leaves the pre-#638 'leave needs-qa in place' instruction anywhere", () => {
    assert.doesNotMatch(PLAYBOOK, /Leave the needs-qa label in place/i);
    assert.doesNotMatch(ROUTE_SRC, /Leave the needs-qa label in place/i);
  });
});

describe("PASS strips needs-qa reachably (issue #974)", () => {
  test("PASS records its verdict as a comment, never `gh pr review --approve` (self-author cannot self-approve, #848)", async () => {
    const calls = await route({ verdict: "PASS" });
    assert.ok(!calls.some((a) => a[0] === "pr" && a[1] === "review"), "no pr review call of any kind");
    assert.ok(calls.some((a) => a[0] === "pr" && a[1] === "comment"));
    assert.doesNotMatch(PLAYBOOK, /gh pr review\s+\$pr_number[^\n]*--approve/);
  });

  test("the needs-qa strip precedes the verdict comment, and route never reaches the merge call", async () => {
    const calls = await route({ verdict: "PASS" });
    const strip = calls.findIndex(stripsNeedsQa);
    const comment = calls.findIndex((a) => a[0] === "pr" && a[1] === "comment");
    assert.ok(strip >= 0 && comment > strip, "strip first (#974), before anything that can abort");
    assert.ok(!calls.some((a) => a[0] === "pr" && a[1] === "merge"));
  });

  test("the playbook keeps the merge call AFTER the route stub, so the strip has already run", () => {
    const route = PLAYBOOK.indexOf("scripts/qa/route.ts");
    const merge = PLAYBOOK.indexOf("gh pr merge $pr_number --repo gaberoo322/hydra --auto --squash --delete-branch");
    assert.ok(route > 0 && merge > route, "route (which strips needs-qa) runs before the retained merge fence");
  });
});

describe("hydra-qa bounce label keys on open-PR state, not GLM provenance (issue #4766)", () => {
  test("the playbook no longer carries a bounce-label helper or any hand-spelled label fence", () => {
    assert.ok(!PLAYBOOK.includes(["qa_bounce_label", "() {"].join("")), "the helper moved into route.ts — one definition, in code");
    assert.ok(!/\$\(qa_bounce_label\)/.test(PLAYBOOK));
    assert.ok(!/gh issue (edit|comment)\b/.test(PLAYBOOK), "no gh issue edit/comment fence outside the retained merge fence");
    assert.ok(!/gh pr comment\b/.test(PLAYBOOK), "no gh pr comment fence outside the retained merge fence");
  });

  test("the bounce label is read LIVE per call and defaults to needs-dev-resume unless CLOSED/MERGED", () => {
    const helper = ROUTE_SRC.slice(ROUTE_SRC.indexOf('const res = await ports.gh(["pr", "view"'), ROUTE_SRC.indexOf("/** The result of a path that posted"));
    assert.match(helper, /"pr", "view", String\(pr\)[\s\S]{0,80}"--json", "state"/, "a live gh pr view --json state read at bounce time (INV-2)");
    assert.ok(helper.includes('state === "CLOSED" || state === "MERGED"'));
    const rfa = helper.indexOf('"ready-for-agent"');
    const ndr = helper.indexOf('"needs-dev-resume"');
    assert.ok(rfa > 0 && ndr > rfa, "ready-for-agent only on the confirmed CLOSED/MERGED arm; needs-dev-resume is the default");
    assert.equal((ROUTE_SRC.match(/await bounceLabel\(\)/g) ?? []).length, 3, "three call sites: defer, T1-T3 FAIL, T4 1st deep-QA FAIL");
  });

  test("an open PR bounces to needs-dev-resume — GLM or not — and never adds ready-for-agent", async () => {
    for (const glm of [false, true]) {
      const calls = await route({ verdict: "FAIL" }, { pre: pre({}, glm) });
      const edits = calls.filter((a) => a[1] === "edit");
      assert.equal(edits.length, 1);
      assert.equal(argAfter(edits[0] as string[], "--add-label"), "needs-dev-resume", `glm=${glm}`);
    }
  });

  test("failed or empty state reads default to needs-dev-resume; a confirmed CLOSED/MERGED PR is the only fallback", async () => {
    for (const [state, want] of [["CLOSED", "ready-for-agent"], ["MERGED", "ready-for-agent"], ["OPEN", "needs-dev-resume"], ["", "needs-dev-resume"]] as const) {
      const calls = await route({ verdict: "FAIL" }, { state });
      assert.equal(argAfter(calls.find((a) => a[1] === "edit") as string[], "--add-label"), want, `state '${state}'`);
    }
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
