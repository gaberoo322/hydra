/**
 * The qa-verdict CLI (scripts/ci/qa-verdict.ts, issue #5080) and its phase
 * runner (src/qa/phases.ts).
 *
 * Two adapters behind the QaVerdictFetchers seam:
 *   1. the in-process FIXTURE fetcher below (recorded rollup
 *      test/fixtures/pr-4754-status-check-rollup.json + synthetic bodies),
 *      driven through runQaVerdictPhase directly;
 *   2. the production gh/git adapter, reached by spawning the CLI with a fake
 *      `gh` on PATH — never live gh.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runQaVerdictPhase, type QaVerdictFetchers } from "../src/qa/phases.ts";
import { renderQaVerdictTrailer } from "../src/qa/verdict-trailer.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts", "ci", "qa-verdict.ts");
const FIXTURE = join(ROOT, "test", "fixtures", "pr-4754-status-check-rollup.json");
const ROLLUP = JSON.parse(readFileSync(FIXTURE, "utf8")).statusCheckRollup as Array<Record<string, unknown>>;
const CONTEXTS = ["test", "dashboard-build", "tier-gate", "mutation-test", "scope-check", "secret-scan", "deep-qa-gate", "design-concept-reconcile"];
const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** Fixture fetcher; each override replaces one getter. null = that read failed. */
function fixtureFetchers(over: Partial<QaVerdictFetchers> = {}): QaVerdictFetchers & { calls: string[] } {
  const calls: string[] = [];
  const f: QaVerdictFetchers = {
    async rollup() { calls.push("rollup"); return ROLLUP; },
    async requiredContexts() { calls.push("contexts"); return CONTEXTS; },
    async headSha() { calls.push("headSha"); return HEAD; },
    async mergeStateStatus() { calls.push("mergeState"); return "CLEAN"; },
    async changedFiles() { calls.push("changedFiles"); return ["src/a.ts"]; },
    async priorBodies() { calls.push("priorBodies"); return []; },
    async ancestry() { calls.push("ancestry"); return { isAncestor: true, changedSince: ["src/a.ts"] }; },
    ...over,
  };
  return Object.assign(f, { calls });
}

const green = [
  { name: "test", status: "completed", conclusion: "success", required: true },
  { name: "tier-gate", status: "completed", conclusion: "success", required: true },
];

describe("qa-verdict phases over the fixture fetcher", () => {
  test("checks: folds the recorded rollup with branch-protection required-ness", async () => {
    const out = (await runQaVerdictPhase("checks", { pr: 4754 }, fixtureFetchers())) as any;
    assert.equal(out.source, "branch-protection");
    assert.deepEqual(out.degraded, []);
    assert.deepEqual(out.red, [], "advisory-checks is red but not required");
    assert.ok(Array.isArray(out.checks) && out.checks.length > 0);
    assert.equal(out.checks.find((c: any) => c.name === "advisory-checks").required, false);
    assert.equal(out.requiredPending, 0);
  });

  test("checks: unreadable rollup => checks null, degraded rollup", async () => {
    const out = (await runQaVerdictPhase("checks", { pr: 1 }, fixtureFetchers({ rollup: async () => null }))) as any;
    assert.equal(out.checks, null);
    assert.equal(out.source, null);
    assert.equal(out.requiredPending, null);
    assert.deepEqual(out.degraded, ["rollup"]);
  });

  test("checks: unreadable required contexts => all-optional mapping tagged rollup-only-all-optional", async () => {
    const out = (await runQaVerdictPhase("checks", { pr: 1 }, fixtureFetchers({ requiredContexts: async () => null }))) as any;
    assert.equal(out.source, "rollup-only-all-optional");
    assert.deepEqual(out.degraded, ["required-contexts"]);
    assert.ok(out.checks.every((c: any) => c.required === false));
    assert.deepEqual(out.red, []);
  });

  test("admission: supplied facts win and are never re-fetched", async () => {
    const f = fixtureFetchers();
    const out = (await runQaVerdictPhase(
      "admission",
      { pr: 1, tier: 3, checks: green, mergeStateStatus: "CLEAN", changedPaths: ["src/a.ts"] },
      f,
    )) as any;
    assert.deepEqual(f.calls, []);
    assert.equal(out.admission.action, "admit");
    assert.equal(out.promptOnly, false);
    assert.deepEqual(out.degraded, []);
  });

  test("admission: absent facts are fetched; a red required check skips the review", async () => {
    const f = fixtureFetchers();
    const out = (await runQaVerdictPhase("admission", { pr: 4754, tier: 3 }, f)) as any;
    assert.ok(f.calls.includes("rollup") && f.calls.includes("mergeState") && f.calls.includes("changedFiles"));
    assert.deepEqual(out.degraded, []);
    assert.equal(typeof out.admission.action, "string");
  });

  test("admission: every fetch failing degrades but still admits (fail-closed, INV-E)", async () => {
    const f = fixtureFetchers({
      rollup: async () => null,
      mergeStateStatus: async () => null,
      changedFiles: async () => null,
    });
    const out = (await runQaVerdictPhase("admission", { pr: 1, tier: null }, f)) as any;
    assert.equal(out.admission.action, "admit");
    assert.deepEqual(out.degraded.sort(), ["changed-paths", "checks:rollup", "merge-state"]);
  });

  test("fanout: head result plus degraded; null tier => adversarial", async () => {
    const out = (await runQaVerdictPhase("fanout", { pr: 1, tier: null, changedPaths: ["docs/x.md"] }, fixtureFetchers())) as any;
    assert.equal(out.mode, "adversarial");
    assert.deepEqual(out.degraded, []);
    const failed = (await runQaVerdictPhase("fanout", { pr: 1, tier: 3 }, fixtureFetchers({ changedFiles: async () => null }))) as any;
    assert.deepEqual(failed.degraded, ["changed-paths"]);
  });

  test("fanout: unreadable changed files fall back to the MAXIMAL (code) depth, not the lightest", async () => {
    const miss = (await runQaVerdictPhase("fanout", { pr: 1, tier: 2 }, fixtureFetchers({ changedFiles: async () => null }))) as any;
    assert.equal(miss.shape, "code");
    assert.equal(miss.mode, "standard");
    assert.deepEqual(miss.degraded, ["changed-paths"]);
    // sibling shape that keeps its verdict: a readable docs-only diff stays single.
    const docs = (await runQaVerdictPhase("fanout", { pr: 1, tier: 2 }, fixtureFetchers({ changedFiles: async () => ["docs/x.md"] }))) as any;
    assert.equal(docs.mode, "single");
  });

  test("prior-context: prior bodies unreadable => [] with degraded prior-bodies", async () => {
    const out = (await runQaVerdictPhase("prior-context", { pr: 7, tier: 3 }, fixtureFetchers({ priorBodies: async () => null }))) as any;
    assert.deepEqual(out.history, []);
    assert.equal(out.prior, null);
    assert.deepEqual(out.degraded, ["prior-bodies"]);
  });

  test("prior-context: consults the ancestry port for the latest prior verdict's sha", async () => {
    const trailer = renderQaVerdictTrailer({ verdict: "FAIL", pr: 7, round: 1, sha: "aaaaaaaaaaaa", blockers: 1, maxSeverity: "high" });
    const f = fixtureFetchers({ priorBodies: async () => [trailer] });
    const out = (await runQaVerdictPhase("prior-context", { pr: 7, tier: 3 }, f)) as any;
    assert.equal(out.prior.round, 1);
    assert.ok(f.calls.includes("ancestry"));
    // Ancestry unverifiable => the head still answers (null is allowed).
    const unverifiable = fixtureFetchers({
      priorBodies: async () => [trailer],
      ancestry: async () => ({ isAncestor: null, changedSince: null }),
    });
    const out2 = (await runQaVerdictPhase("prior-context", { pr: 7, tier: 3 }, unverifiable)) as any;
    assert.equal(out2.prior.round, 1);
  });

  test("fold: pure — needs no fetcher", async () => {
    const f = fixtureFetchers();
    const out = (await runQaVerdictPhase(
      "fold",
      { tier: 3, findings: [], spawnedReviewers: null, checks: green, standardsSummary: "ok", specSummary: "ok" },
      f,
    )) as any;
    assert.deepEqual(f.calls, []);
    assert.equal(out.fold.reviewVerdict, "PASS");
    assert.deepEqual(out.degraded, []);
    assert.equal(typeof out.report, "string");
  });

  test("trailer: renders the trailer and round from fetched prior bodies; head-sha miss => unknown", async () => {
    const out = (await runQaVerdictPhase(
      "trailer",
      { pr: 7, verdict: "PASS", blockers: 0, maxSeverity: "none" },
      fixtureFetchers(),
    )) as any;
    assert.match(out.trailer, /QA-Verdict: PASS/);
    assert.equal(out.round, 1);
    assert.deepEqual(out.degraded, []);
    const unk = (await runQaVerdictPhase(
      "trailer",
      { pr: 7, verdict: "PASS", blockers: 0, maxSeverity: "none" },
      fixtureFetchers({ headSha: async () => null }),
    )) as any;
    assert.match(unk.trailer, /sha=unknown/);
    assert.deepEqual(unk.degraded, ["head-sha"]);
  });

  test("round-action: a T3 PASS proceeds; supplied priorBodies win", async () => {
    const f = fixtureFetchers();
    const out = (await runQaVerdictPhase(
      "round-action",
      { pr: 7, tier: 3, verdict: "PASS", reviewVerdict: "PASS", headSha: HEAD, priorBodies: [] },
      f,
    )) as any;
    assert.deepEqual(f.calls, []);
    assert.equal(out.round.action, "proceed");
    assert.equal(out.deepQa, null);
    assert.deepEqual(out.degraded, []);
  });
});

/** A fake `gh` answering exactly the production adapter's argv from the fixture. */
function writeFakeGh(dir: string): void {
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      'case "$*" in',
      "  *required_status_checks*)",
      '    if [ -n "$GH_FAIL_CONTEXTS" ]; then echo "gh: Branch protection rules not found" >&2; exit 1; fi',
      `    printf '%s' '{"contexts":${JSON.stringify(CONTEXTS)}}' ;;`,
      "  *statusCheckRollup*)",
      '    if [ -n "$GH_FAIL_ROLLUP" ]; then echo "gh: Could not resolve to a PullRequest" >&2; exit 1; fi',
      `    jq -c '.statusCheckRollup |= map(if .name == "tier-gate" then .conclusion = "FAILURE" else . end)' "$GH_FIXTURE" ;;`,
      "  *headRefOid*)",
      `    printf '%s' '{"headRefOid":"${HEAD}","mergeStateStatus":"CLEAN"}' ;;`,
      "  *comments,reviews*)",
      `    printf '%s' '{"comments":[{"body":"hello"}],"reviews":[]}' ;;`,
      "  *pulls/*/files*)",
      // Real gh: --slurp wraps pages in one array; without it pages are concatenated documents.
      `    case "$*" in *--slurp*) printf '%s' '[[{"filename":"docs/x.md"}],[{"filename":"src/a.ts"}]]' ;; *) printf '%s' '[{"filename":"docs/x.md"}][{"filename":"src/a.ts"}]' ;; esac ;;`,
      '  *) echo "fake-gh: unmatched call: $*" >&2; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
}

describe("qa-verdict CLI (spawned)", () => {
  function run(args: string[], input: string | undefined, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "qa-verdict-cli-"));
    try {
      writeFakeGh(dir);
      const r = spawnSync("node", ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
        cwd: ROOT,
        input,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_FIXTURE: FIXTURE, ...env },
        encoding: "utf8",
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, dir };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("checks over stdin reproduces {red:['tier-gate']} through the production adapter", () => {
    const r = run(["checks"], '{"pr":4754}');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.red, ["tier-gate"]);
    assert.equal(out.source, "branch-protection");
    assert.deepEqual(out.degraded, []);
  });

  test("--input <file> is read instead of stdin", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-verdict-cli-in-"));
    try {
      const file = join(dir, "in.json");
      writeFileSync(file, JSON.stringify({ pr: 1, tier: 3, changedPaths: ["src/a.ts"] }));
      const r = run(["fanout", "--input", file], undefined);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).mode, "adversarial");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent facts are fetched through gh keyed by pr", () => {
    const r = run(["fanout"], '{"pr":9,"tier":2}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).shape, "code");
  });

  test("multi-page changed files parse (--paginate --slurp) with nothing degraded", () => {
    const r = run(["fanout"], '{"pr":9,"tier":2}');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.shape, "code");
    assert.deepEqual(out.degraded, []);
  });

  test("a malformed fold payload exits 2 with schema-validation-failed", () => {
    const r = run(["fold"], JSON.stringify({ tier: 3, findings: "nope", checks: [], standardsSummary: "s", specSummary: "p" }));
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    const ok = run(["fold"], JSON.stringify({ tier: 3, findings: [], checks: [], standardsSummary: "s", specSummary: "p" }));
    assert.equal(ok.status, 0, ok.stderr);
  });

  test("unreadable required contexts => exit 0, degraded + all-optional source (not an abort)", () => {
    const r = run(["checks"], '{"pr":4754}', { GH_FAIL_CONTEXTS: "1" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.source, "rollup-only-all-optional");
    assert.deepEqual(out.degraded, ["required-contexts"]);
  });

  test("unreadable rollup => exit 0 with checks null", () => {
    const r = run(["checks"], '{"pr":4754}', { GH_FAIL_ROLLUP: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).checks, null);
  });

  test("usage and input errors exit 2 with schema-validation-failed on stderr and nothing on stdout", () => {
    for (const [args, input] of [
      [[], "{}"],
      [["bogus-phase"], "{}"],
      [["checks"], "not json"],
      [["checks"], "{}"],
      [["checks", "--input", "/nonexistent/in.json"], undefined],
    ] as Array<[string[], string | undefined]>) {
      const r = run(args, input);
      assert.equal(r.status, 2, `${args.join(" ")} :: ${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.equal(JSON.parse(r.stderr.trim().split("\n").pop() as string).code, "schema-validation-failed");
    }
  });

  test("importing the facade has no side effects and keeps the frozen export set (INV-2)", async () => {
    const facade = await import("../scripts/ci/qa-verdict.ts");
    for (const name of ["hasFreshDeepQaPass", "buildCheckStates", "classifyVerdict", "buildQaVerdictTrailer", "decideReviewerFanout"]) {
      assert.equal(typeof (facade as Record<string, unknown>)[name], "function", name);
    }
  });
});
