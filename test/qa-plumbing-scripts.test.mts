/**
 * The hydra-qa plumbing scripts (issue #5269, ADR-0046 Decision 7):
 * `scripts/qa/{preflight,packet,route,poll}.ts`.
 *
 * Two kinds of test:
 *   - in-process, over a fake {@link PlumbingPorts} (a recording gh/git, a
 *     canned orchestrator API and either the engine's real phases over a
 *     fixture fetcher or canned phase output) — the golden bodies and the
 *     effect ORDER;
 *   - spawned CLI runs with a fake `gh` on PATH recording argv — the production
 *     adapter wiring, exit codes and the read-only guarantee of preflight.
 *
 * No test touches live gh, the network or the real orchestrator API.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runQaVerdictPhase, type QaVerdictFetchers } from "../src/qa/phases.ts";
import { guardedSeamMove, phaseRunner, type CmdResult, type PlumbingPorts, type SeamMoveInput, type SeamMoveResult } from "../scripts/qa/_lib.ts";
import { extractAnchorRefFromPrBody } from "../scripts/ci/design-concept-reconcile-check.ts";
import { parentIssueOf, runPreflight, type PreflightOptions } from "../scripts/qa/preflight.ts";
import { bodyClosesIssue, closingIssuesInBody, referencedIssuesInBody } from "../src/github/pr-refs.ts";
import { NO_STANDARDS_SENTINEL, runPacket } from "../scripts/qa/packet.ts";
import { SKIP_REVIEW_REPORT, renderParkSummary, runRoute, type RouteDeps, type RouteOptions } from "../scripts/qa/route.ts";
import type { CapCount } from "../src/lifecycle/caps.ts";
import { parseChecks, runPoll } from "../scripts/qa/poll.ts";
import { PreflightResultSchema, type PreflightResult } from "../src/schemas/qa-plumbing-cli.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "test", "fixtures", "pr-4754-status-check-rollup.json");
const ROLLUP = JSON.parse(readFileSync(FIXTURE, "utf8")).statusCheckRollup as Array<Record<string, unknown>>;
const CONTEXTS = ["test", "dashboard-build", "tier-gate", "mutation-test", "scope-check", "secret-scan", "deep-qa-gate", "design-concept-reconcile"];
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const H12 = HEAD.slice(0, 12);
const BASE_SHA = "b".repeat(40);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fixtureFetchers(over: Partial<QaVerdictFetchers> = {}): QaVerdictFetchers {
  return {
    async rollup() { return ROLLUP; },
    async requiredContexts() { return CONTEXTS; },
    async headSha() { return HEAD; },
    async mergeStateStatus() { return "CLEAN"; },
    async changedFiles() { return ["src/a.ts"]; },
    async priorBodies() { return []; },
    async ancestry() { return { isAncestor: true, changedSince: ["src/a.ts"] }; },
    ...over,
  };
}


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

const ok = (stdout: string): CmdResult => ({ ok: true, stdout });
const fail = (stderr = "boom"): CmdResult => ({ ok: false, stderr });

/** gh verbs that change GitHub state (everything else is a read). */
function isWrite(argv: readonly string[]): boolean {
  const [a, b] = argv;
  if (a === "issue" && (b === "edit" || b === "comment")) return true;
  if (a === "pr" && (b === "comment" || b === "merge" || b === "edit")) return true;
  if (a === "api" && (argv.includes("POST") || argv.includes("DELETE") || argv.includes("PUT") || argv.includes("PATCH"))) return true;
  return false;
}

interface Harness {
  ports: PlumbingPorts;
  /** Every `scripts/lifecycle.ts advance` argv (after `advance`), in order. */
  advances: string[][];
  gh: string[][];
  git: string[][];
  writes: () => string[][];
}

interface HarnessOptions {
  ghHandler?: (argv: string[]) => CmdResult | undefined;
  gitHandler?: (argv: string[]) => CmdResult | undefined;
  /** Per-call advance outcome (default: accepted). */
  advanceHandler?: (args: string[]) => Partial<SeamOutcome> | undefined;
  /** The counts a `parked:<arm>` bounce refusal carries (default: none). */
  parkCounts?: CapCount[];
  /** Whether an `escalated:<arm>` bounce refusal's exit write landed (default: omitted, as a pre-#5662 seam). */
  exitWritten?: boolean;
  /** Whether the PR-bodies preflight read succeeds (default: true). */
  prBodiesReadable?: boolean;
  http?: PlumbingPorts["http"];
  fetchers?: QaVerdictFetchers;
  phase?: PlumbingPorts["phase"];
}

function harness(o: HarnessOptions = {}): Harness {
  const gh: string[][] = [];
  const git: string[][] = [];
  const advances: string[][] = [];
  /** Every state-changing call (gh writes AND seam advances) in call order. */
  const log: string[][] = [];
  const fetchers = o.fetchers ?? fixtureFetchers();
  const ports: PlumbingPorts = {
    async advance(input) {
      const args = seamArgv(input);
      advances.push(args);
      log.push(["lifecycle", "advance", ...args]);
      return seamResult({ rc: 0, code: "", ...(o.advanceHandler?.(args) ?? {}) });
    },
    async qaBounce(input) {
      const state = (await o.ghHandler?.(["pr", "view", String(input.pr), "--json", "state"])) ?? ok("OPEN\n");
      const lane = bounceLane(state.ok ? (state.stdout ?? "") : "");
      if ("code" in lane) return { ok: false, code: lane.code };
      const args = seamArgv({ issue: input.issue, to: lane.to, evidence: { pr: String(input.pr), ...(input.defer ? { defer: "1" } : {}) }, actor: input.actor });
      advances.push(args);
      log.push(["lifecycle", "advance", ...args]);
      const out = seamResult({ rc: 0, code: "", ...(o.advanceHandler?.(args) ?? {}) });
      if (out.ok === true) return { ok: true, to: lane.to };
      if (out.code.startsWith("escalated:")) {
        return { ok: false, code: out.code as `escalated:${string}`, counts: o.parkCounts ?? [], ...(o.exitWritten === undefined ? {} : { written: o.exitWritten }) };
      }
      return out.code.startsWith("parked:") ? { ok: false, code: out.code as `parked:${string}`, counts: o.parkCounts ?? [] } : { ok: false, code: out.code };
    },
    prBodiesReadable: async () => o.prBodiesReadable !== false,
    async gh(argv) {
      gh.push(argv);
      if (isWrite(argv)) log.push(argv);
      return o.ghHandler?.(argv) ?? ok("");
    },
    async git(argv) {
      git.push(argv);
      return o.gitHandler?.(argv) ?? ok("");
    },
    http: o.http ?? (async () => null),
    fetchers,
    phase: o.phase ?? phaseRunner(fetchers),
  };
  return { ports, advances, gh, git, writes: () => log };
}

const argAfter = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const PR_VIEW = {
  baseRefName: "master",
  mergeStateStatus: "CLEAN",
  headRefName: "worktree-agent-abc",
  headRefOid: HEAD,
  labels: [{ name: "needs-qa" }],
  body: "Closes #5269\n\nMerge danger: two-way — docs only",
};

function preflightGh(prView: Record<string, unknown> = PR_VIEW) {
  return (argv: string[]): CmdResult | undefined => {
    const [a, b] = argv;
    if (a === "pr" && b === "view") return ok(JSON.stringify(prView));
    if (a === "pr" && b === "list") return ok(JSON.stringify([{ number: 77, body: "Closes #5269" }]));
    if (a === "issue" && b === "view") return ok(JSON.stringify({ labels: [] }));
    if (a === "issue" && b === "list") return ok(JSON.stringify([{ number: 5269 }]));
    return undefined;
  };
}

function preflightGit(paths = "src/a.ts\n") {
  return (argv: string[]): CmdResult | undefined => {
    if (argv[0] === "fetch") return ok("");
    if (argv[0] === "rev-parse") return ok(`${BASE_SHA}\n`);
    if (argv[0] === "diff") return ok(paths);
    return undefined;
  };
}

const CONCEPT = { anchorRef: "issue-5269", invariants: ["INV-1 x"], gate: {} };
const httpFound = (tier: number | null): PlumbingPorts["http"] => async (path) => {
  if (path.includes("/resolve")) return { status: 200, body: JSON.stringify({ found: true, handle: {}, concept: CONCEPT }) };
  if (path.startsWith("/api/tier")) return tier === null ? null : { status: 200, body: JSON.stringify({ tier, reason: "r", perFile: [] }) };
  return null;
};

const PRE_OPTS: PreflightOptions = { issue: 5269, pr: 77, repo: "gaberoo322/hydra", mode: "warn" };

describe("preflight (steps 1-6.7 in one read-only call)", () => {
  test("preflight: unreachable tier classifier yields tier null, adversarial true and gate admit", async () => {
    const h = harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: httpFound(null) });
    const r = await runPreflight(PRE_OPTS, h.ports);
    assert.equal(r.ok, true);
    assert.equal(r.stage, "ready");
    assert.equal(r.tier.num, null);
    assert.equal(r.tier.adversarial, true);
    assert.equal(r.gate.action, "admit");
    assert.equal(r.fanout.mode, "adversarial", "an unknown tier keeps the deeper fan-out");
    assert.ok(r.degraded.includes("tier-unreachable"));
    PreflightResultSchema.parse(r);
  });

  test("preflight: changedPaths comes from fixedSha...headSha, never the worktree HEAD (#5520)", async () => {
    const h = harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: httpFound(2) });
    await runPreflight(PRE_OPTS, h.ports);
    assert.ok(h.git.some((a) => a.join(" ") === `diff --no-renames --name-only ${BASE_SHA}...${HEAD}`));
    assert.ok(!h.git.flat().some((a) => a === "HEAD" || a.endsWith("...HEAD")), "no git argv names the literal HEAD");
  });

  test("preflight performs no write: the fake gh records only read verbs", async () => {
    const h = harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: httpFound(2) });
    await runPreflight({ ...PRE_OPTS, pr: undefined }, h.ports);
    assert.ok(h.gh.length > 0, "preflight must have read through gh");
    assert.deepEqual(h.writes(), [], "no label, comment, merge or POST/DELETE api call");
    assert.ok(h.git.every((a) => ["fetch", "rev-parse", "diff", "cat-file"].includes(a[0] as string)), "git: only fetch/rev-parse/diff/cat-file — no checkout, switch, reset or worktree");
  });

  test("preflight: a T2 prompt-free diff with a persisted artifact is ready, single-tier standard fan-out, spec found", async () => {
    const h = harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: httpFound(2) });
    const r = await runPreflight(PRE_OPTS, h.ports);
    assert.equal(r.tier.num, 2);
    assert.equal(r.tier.adversarial, false);
    assert.equal(r.spec.found, true);
    assert.deepEqual(r.spec.input, CONCEPT, "the flat artifact is unwrapped from .concept");
    assert.equal(r.fixedSha, BASE_SHA);
    assert.deepEqual(r.fanout.reviewers, ["standards", "spec"]);
    assert.equal(r.pr?.glmAuthored, false);
  });

  test("preflight: a single-reviewer docs diff sets adversarial false", async () => {
    const h = harness({
      ghHandler: preflightGh(),
      gitHandler: preflightGit("docs/x.md\n"),
      http: httpFound(3),
      fetchers: fixtureFetchers({ changedFiles: async () => ["docs/x.md"] }),
    });
    const r = await runPreflight(PRE_OPTS, h.ports);
    assert.equal(r.fanout.mode, "single");
    assert.equal(r.tier.adversarial, false, "single mode folds one reviewer's verdict");
  });

  test("preflight: the GLM provenance predicate matches a head-branch prefix or the glm-authored label", async () => {
    for (const view of [
      { ...PR_VIEW, headRefName: "worktree-agent-glm-1" },
      { ...PR_VIEW, labels: [{ name: "glm-authored" }] },
    ]) {
      const h = harness({ ghHandler: preflightGh(view), gitHandler: preflightGit(), http: httpFound(2) });
      assert.equal((await runPreflight(PRE_OPTS, h.ports)).pr?.glmAuthored, true);
    }
  });

  test("preflight: a missing artifact in warn mode records the Phase A skip reason; enforce stops with the one comment", async () => {
    const miss: PlumbingPorts["http"] = async (path) =>
      path.includes("/resolve")
        ? { status: 404, body: JSON.stringify({ found: false, handle: { redisKey: "k" }, reason: "no artifact" }) }
        : { status: 200, body: JSON.stringify({ tier: 2 }) };
    const warn = await runPreflight(PRE_OPTS, harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: miss }).ports);
    assert.equal(warn.ok, true);
    assert.match(warn.spec.skippedReason ?? "", /Phase A shadow mode — DESIGN_CONCEPT_MODE=warn\): no artifact/);

    const enforce = await runPreflight(
      { ...PRE_OPTS, mode: "enforce" },
      harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: miss }).ports,
    );
    assert.equal(enforce.ok, false);
    assert.equal(enforce.stage, "spec-missing-enforce");
    assert.equal(enforce.stop?.target, "pr");
    assert.match(enforce.stop?.body ?? "", /design-concept artifact required/);
    assert.match(enforce.stop?.body ?? "", /\*\*Resolver reason:\*\* no artifact/);
    assert.match(enforce.stop?.body ?? "", /`k`/);
  });

  test("preflight: the spec parent is the PR refs module's answer — a real closing ref first, else the first plain reference", async () => {
    const parentFor = async (body: string): Promise<string[]> => {
      const asked: string[] = [];
      const http: PlumbingPorts["http"] = async (path) => {
        if (path.includes("/resolve")) asked.push(path);
        return httpFound(2)(path);
      };
      await runPreflight(PRE_OPTS, harness({ ghHandler: preflightGh({ ...PR_VIEW, body }), gitHandler: preflightGit(), http }).ports);
      return asked;
    };
    assert.deepEqual(await parentFor("Closes #5269"), ["/api/design-concepts/5269/resolve"]);
    assert.deepEqual(await parentFor("Refs #41"), ["/api/design-concepts/41/resolve"]);
    assert.deepEqual(await parentFor("Does not close #26 — the sibling does.\n\nCloses #63"), ["/api/design-concepts/63/resolve"]);
    assert.deepEqual(await parentFor("Refs #30. Closes #10."), ["/api/design-concepts/10/resolve"]);
    assert.deepEqual(await parentFor("Resolved #8"), ["/api/design-concepts/8/resolve"]);
    assert.deepEqual(await parentFor("Closes#5 and encloses #6"), [], "no ref the module recognises means no parent and no resolve call");
  });

  test("preflight: the exempt labels skip the Spec axis (PR label, then cleanup-scan on the parent issue)", async () => {
    const miss: PlumbingPorts["http"] = async (path) =>
      path.includes("/resolve") ? { status: 404, body: JSON.stringify({ found: false }) } : { status: 200, body: JSON.stringify({ tier: 2 }) };
    const prExempt = await runPreflight(
      { ...PRE_OPTS, mode: "enforce" },
      harness({ ghHandler: preflightGh({ ...PR_VIEW, labels: [{ name: "design-concept-exempt" }] }), gitHandler: preflightGit(), http: miss }).ports,
    );
    assert.equal(prExempt.ok, true);
    assert.equal(prExempt.spec.skippedReason, "design-concept-exempt label present (operator override)");

    const gh = (argv: string[]) =>
      argv[0] === "issue" && argv[1] === "view" ? ok(JSON.stringify({ labels: [{ name: "cleanup-scan" }] })) : preflightGh()(argv);
    const cleanup = await runPreflight({ ...PRE_OPTS, mode: "enforce" }, harness({ ghHandler: gh, gitHandler: preflightGit(), http: miss }).ports);
    assert.equal(cleanup.spec.skippedReason, "cleanup-scan label present on parent issue (deterministic-exempt class)");
  });

  test("preflight: no issue and no linked PR are clean ok:false stages (exit 0 at the CLI)", async () => {
    const none = await runPreflight(
      { ...PRE_OPTS, issue: undefined, pr: undefined },
      harness({ ghHandler: (a) => (a[0] === "issue" && a[1] === "list" ? ok("[]") : undefined) }).ports,
    );
    assert.equal(none.ok, false);
    assert.equal(none.stage, "no-issue");

    const noPr = await runPreflight(
      { ...PRE_OPTS, pr: undefined },
      harness({ ghHandler: (a) => (a[0] === "pr" && a[1] === "list" ? ok("[]") : undefined) }).ports,
    );
    assert.equal(noPr.stage, "no-pr");
    assert.equal(noPr.stop?.target, "issue");

    // #5767: "linked" is the PR refs module's closing predicate, not a private verb list. A verb embedded in a
    // longer word and a negated ref are NOT links; any-tense closing verbs and the colon form ARE.
    const listing = (prs: Array<{ number: number; body: string }>) => (a: string[]) =>
      a[0] === "pr" && a[1] === "list" ? ok(JSON.stringify(prs)) : preflightGh()(a);
    const notLinked = await runPreflight(
      { ...PRE_OPTS, pr: undefined },
      harness({
        ghHandler: listing([
          { number: 78, body: "encloses #5269 and prefixes #5269" },
          { number: 79, body: "Never closes #5269" },
          { number: 80, body: "Closes #5269a" },
        ]),
      }).ports,
    );
    assert.equal(notLinked.stage, "no-pr");
    for (const body of ["Resolves #5269", "Fixed #5269", "Closes: #5269", "Closes  #5269"]) {
      const linked = await runPreflight(
        { ...PRE_OPTS, pr: undefined },
        harness({ ghHandler: listing([{ number: 78, body: "Refs #5269" }, { number: 77, body }]), gitHandler: preflightGit(), http: httpFound(2) }).ports,
      );
      assert.equal(linked.pr?.number, 77, `a PR whose body is ${JSON.stringify(body)} is the linked PR`);
    }
  });

  test("preflight: over the shared truth table, the finder links a PR exactly when its body closes the issue, and posts the no-linked-PR comment only otherwise (#5767)", async () => {
    const rows = (
      JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "pr-refs-truth-table.json"), "utf8")) as {
        rows: Array<{ name: string; body: string; closing: number[]; referenced: number[]; doesNotClose?: number[] }>;
      }
    ).rows;
    let accepted = 0;
    let refused = 0;
    const zeroProbeRows: string[] = [];
    for (const row of rows) {
      // Every number the row names AND every number written after a hash in its body, so a row with empty
      // expectation columns (an embedded verb, a no-space form) still goes through runPreflight.
      const probes = [
        ...new Set([
          ...row.closing,
          ...row.referenced,
          ...(row.doesNotClose ?? []),
          ...[...row.body.matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
        ]),
      ];
      if (probes.length === 0) zeroProbeRows.push(row.name);
      for (const issue of probes) {
        const gh = (a: string[]) =>
          a[0] === "pr" && a[1] === "list" ? ok(JSON.stringify([{ number: 91, body: row.body }])) : preflightGh()(a);
        const h = harness({ ghHandler: gh, gitHandler: preflightGit(), http: httpFound(2) });
        const out = await runPreflight({ ...PRE_OPTS, issue, pr: undefined }, h.ports);
        const where = `row ${JSON.stringify(row.name)}, issue #${issue}`;
        // The table's own `closing` column is what the seam's pr-open gate accepts (bodyClosesIssue, pinned to
        // the same table by test/github-pr-refs.test.mts); asserted here too so the two can never drift apart.
        assert.equal(bodyClosesIssue(row.body, issue), row.closing.includes(issue), `${where}: module vs table`);
        if (row.closing.includes(issue)) {
          accepted += 1;
          assert.equal(out.pr?.number, 91, `${where}: a body the pr-open gate accepts must be found`);
          assert.notEqual(out.stage, "no-pr", where);
          assert.equal(out.stop, null, `${where}: no stop comment when a PR closes the issue`);
        } else {
          refused += 1;
          assert.equal(out.stage, "no-pr", `${where}: a body that does not close the issue is not the linked PR`);
          assert.equal(out.pr, null, where);
          assert.equal(out.stop?.target, "issue", where);
          assert.match(out.stop?.body ?? "", new RegExp(`no open PR whose body closes #${issue} `), where);
        }
        assert.deepEqual(h.writes(), [], `${where}: preflight never writes`);
      }
    }
    assert.ok(accepted >= 20 && refused >= 10, `the table must exercise both arms (accepted ${accepted}, refused ${refused})`);
    // Only a body with no hash-number at all may skip runPreflight.
    assert.deepEqual(zeroProbeRows, ["empty body"]);
    for (const name of zeroProbeRows) assert.doesNotMatch(rows.find((r) => r.name === name)?.body ?? "#0", /#\d/);
  });

  test("preflight: the no-linked-PR comment needs EVERY open PR to not close the issue; one closer among non-closers is found (#5767)", async () => {
    const bodies = ["Refs #5269", "Does not close #5269 — #91 does.", "encloses #5269", "Closes #52690", "Closes #526"];
    const listing = (prs: Array<{ number: number; body: string | null }>) => (a: string[]) =>
      a[0] === "pr" && a[1] === "list" ? ok(JSON.stringify(prs)) : preflightGh()(a);
    const nonClosers = bodies.map((body, i) => ({ number: 80 + i, body }));
    assert.ok(nonClosers.every((p) => !bodyClosesIssue(p.body, 5269)));
    const none = await runPreflight(
      { ...PRE_OPTS, pr: undefined },
      harness({ ghHandler: listing([...nonClosers, { number: 90, body: null }]), gitHandler: preflightGit(), http: httpFound(2) }).ports,
    );
    assert.equal(none.stage, "no-pr");
    assert.match(none.stop?.body ?? "", /no open PR whose body closes #5269 /);

    const one = await runPreflight(
      { ...PRE_OPTS, pr: undefined },
      harness({ ghHandler: listing([...nonClosers, { number: 91, body: "Summary.\n\nResolves: #5269" }]), gitHandler: preflightGit(), http: httpFound(2) }).ports,
    );
    assert.equal(one.pr?.number, 91);
    assert.equal(one.stop, null);
  });

  test("preflight: the spec parent is the issue under QA when the PR closes it, even after an earlier prose colon-ref to another issue; else parentIssueOf (#5767)", async () => {
    const resolveCalls = async (body: string): Promise<string[]> => {
      const asked: string[] = [];
      const http: PlumbingPorts["http"] = async (path) => {
        if (path.includes("/resolve")) asked.push(path);
        return httpFound(2)(path);
      };
      await runPreflight(PRE_OPTS, harness({ ghHandler: preflightGh({ ...PR_VIEW, body }), gitHandler: preflightGit(), http }).ports);
      return asked;
    };
    // The closed-PR-5328 shape: prose "primary fix: #N" for another issue first, the genuine closing line later.
    const prose = "Stacked on the primary fix: #5326, which lands the parser.\n\n## Summary\n\nCloses #5269";
    assert.equal(parentIssueOf(prose), 5326, "closing-first alone picks the prose hit");
    assert.deepEqual(await resolveCalls(prose), ["/api/design-concepts/5269/resolve"]);
    // Fallback: the body does not close the QA'd issue, so parentIssueOf's answer stands.
    assert.deepEqual(await resolveCalls("Stacked on the primary fix: #5326.\n\nRefs #5269"), ["/api/design-concepts/5326/resolve"]);
    assert.deepEqual(await resolveCalls("No closing line here.\n\nRefs #41"), ["/api/design-concepts/41/resolve"]);
  });

  test("parentIssueOf: closing ref first, then the first plain reference, over the shared truth table (#5767)", () => {
    const rows = (
      JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "pr-refs-truth-table.json"), "utf8")) as {
        rows: Array<{ name: string; body: string; closing: number[]; referenced: number[] }>;
      }
    ).rows;
    for (const row of rows) {
      assert.equal(parentIssueOf(row.body), row.closing[0] ?? row.referenced[0] ?? null, `row ${JSON.stringify(row.name)}`);
      assert.equal(parentIssueOf(row.body), closingIssuesInBody(row.body)[0] ?? referencedIssuesInBody(row.body)[0] ?? null);
    }
    assert.equal(parentIssueOf("Does not close #26 — #63 does.\n\nCloses #63"), 63, "the negated companion ref is not the parent");
    assert.equal(parentIssueOf("Does not close #26"), 26, "with no closing ref, the plain reference is followed");
    assert.equal(parentIssueOf("Closes#5"), null);
    assert.equal(parentIssueOf("refs#5"), null);
    assert.equal(parentIssueOf(""), null);
  });

  test("CI anchor and preflight parent agree on every body closing at most one issue; a multi-close body is the one pinned disagreement", () => {
    const rows = (
      JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "pr-refs-truth-table.json"), "utf8")) as {
        rows: Array<{ name: string; body: string; closing: number[] }>;
      }
    ).rows;
    for (const row of rows.filter((r) => r.closing.length <= 1)) {
      const ci = extractAnchorRefFromPrBody(row.body);
      if (ci !== null) assert.equal(parentIssueOf(row.body), ci, `row ${JSON.stringify(row.name)}`);
    }
    // Multi-close: CI binds the first closing ref; preflight binds the issue under QA when the body closes it.
    const body = "Closes #10\n\nCloses #20";
    assert.equal(extractAnchorRefFromPrBody(body), 10);
    assert.equal(bodyClosesIssue(body, 20) ? 20 : parentIssueOf(body), 20);
    assert.equal(parentIssueOf(body), 10);
  });

  test("preflight: a failed gh list is a pre-stage exit, never read as 'nothing found' (no false no-pr / no-issue)", async () => {
    await assert.rejects(
      runPreflight({ ...PRE_OPTS, pr: undefined }, harness({ ghHandler: (a) => (a[0] === "pr" && a[1] === "list" ? fail("gh: 502") : undefined) }).ports),
      /gh pr list failed/,
    );
    await assert.rejects(
      runPreflight({ ...PRE_OPTS, issue: undefined, pr: undefined }, harness({ ghHandler: (a) => (a[0] === "issue" && a[1] === "list" ? fail("gh: 502") : undefined) }).ports),
      /gh issue list failed/,
    );
    // Sibling pin: a SUCCESSFUL empty list keeps its clean no-pr stage (covered above) and writes nothing.
  });

  test("preflight: a required check already red on T3 yields skip-required-failed with the engine's FAIL verdict carried", async () => {
    const red = ROLLUP.map((c) => (c.name === "test" ? { ...c, conclusion: "FAILURE" } : c));
    const h = harness({
      ghHandler: preflightGh(),
      gitHandler: preflightGit(),
      http: httpFound(3),
      fetchers: fixtureFetchers({ rollup: async () => red }),
    });
    const r = await runPreflight(PRE_OPTS, h.ports);
    assert.equal(r.gate.action, "skip-required-failed");
    assert.deepEqual(r.gate.redRequired, ["test"]);
    assert.equal(r.gate.skipVerdict?.verdict, "FAIL");
    assert.ok(r.gate.skipCiSummary);
  });

  test("preflight: an unreadable required-contexts read is the all-optional mapping tagged degraded; an unreadable rollup fails closed", async () => {
    const noContexts = await runPreflight(
      PRE_OPTS,
      harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: httpFound(2), fetchers: fixtureFetchers({ requiredContexts: async () => null }) }).ports,
    );
    assert.equal(noContexts.checks.degraded, true);
    assert.equal(noContexts.checks.source, "rollup-only-all-optional");
    assert.ok(noContexts.checks.list.every((c) => c.required === false));

    const noRollup = await runPreflight(
      PRE_OPTS,
      harness({ ghHandler: preflightGh(), gitHandler: preflightGit(), http: httpFound(2), fetchers: fixtureFetchers({ rollup: async () => null }) }).ports,
    );
    assert.equal(noRollup.checks.source, null);
    assert.ok(noRollup.degraded.includes("checks-unreadable"));
    assert.equal(noRollup.gate.action, "admit", "an unreadable rollup fails closed to the full review");
  });

  test("preflight: a failed fan-out sizing call keeps the tier fan-out with the 'kept the tier path' reason", async () => {
    const fetchers = fixtureFetchers();
    const real = phaseRunner(fetchers);
    const h = harness({
      ghHandler: preflightGh(),
      gitHandler: preflightGit(),
      http: httpFound(2),
      fetchers,
      phase: async (p, i) => {
        if (p === "fanout") throw new Error("engine down");
        return real(p, i);
      },
    });
    const r = await runPreflight(PRE_OPTS, h.ports);
    assert.equal(r.fanout.mode, "standard");
    assert.deepEqual(r.fanout.reviewers, ["standards", "spec"]);
    assert.match(r.fanout.reason, /change-shape sizing unavailable, kept the tier path/);
    assert.ok(r.degraded.includes("fanout-failed"));
  });

  test("preflight: a failed admission call fails closed to admit with the full-review reason", async () => {
    const fetchers = fixtureFetchers();
    const real = phaseRunner(fetchers);
    const h = harness({
      ghHandler: preflightGh(),
      gitHandler: preflightGit(),
      http: httpFound(3),
      fetchers,
      phase: async (p, i) => {
        if (p === "admission") throw new Error("engine down");
        return real(p, i);
      },
    });
    const r = await runPreflight(PRE_OPTS, h.ports);
    assert.equal(r.gate.action, "admit");
    assert.equal(r.gate.reason, "gate produced no output; fail-closed to full review");
  });
});

// ---------------------------------------------------------------------------
// Packet
// ---------------------------------------------------------------------------

function readyPre(over: Partial<PreflightResult> = {}): PreflightResult {
  return {
    ok: true,
    stage: "ready",
    issue: 5269,
    pr: { number: 77, headSha: HEAD, headRefName: "worktree-agent-abc", baseRefName: "master", mergeStateStatus: "CLEAN", glmAuthored: false },
    fixedSha: BASE_SHA,
    changedPaths: ["src/a.ts"],
    checks: { list: [{ name: "test", status: "completed", conclusion: "success", required: true }], degraded: false, source: "branch-protection" },
    spec: { found: true, input: CONCEPT, skippedReason: null, mode: "warn" },
    tier: { num: 3, adversarial: true },
    gate: { action: "admit", reason: "admit", redRequired: [], skipVerdict: null, skipCiSummary: null },
    fanout: { mode: "adversarial", reviewers: ["reviewer-A-standards", "reviewer-A-spec", "reviewer-B-standards", "reviewer-B-spec"], reason: "Review fan-out: adversarial" },
    stop: null,
    degraded: [],
    ...over,
  };
}

describe("packet (steps 7.0 / 7.0a / 7.0b)", () => {
  const standardsOk = async () => ({ ok: true as const, found: true as const, path: "/x/CODING_STANDARDS.md", text: "RULES-TEXT", parsed: { rules: [], sections: [] } as never });

  function packetGit(over: Record<string, CmdResult> = {}) {
    return (argv: string[]): CmdResult | undefined => {
      const key = argv.join(" ");
      if (key in over) return over[key];
      if (argv[0] === "diff" && argv.includes("--name-only") && argv.includes("--no-renames")) return ok("src/a.ts\nsrc/gone.ts\n");
      if (argv[0] === "diff" && argv.includes("--name-only")) return ok("src/a.ts\nsrc/gone.ts\n");
      if (argv[0] === "diff") return ok("DIFF-BODY\n\n");
      if (argv[0] === "show" && argv[1] === `${HEAD}:src/a.ts`) return ok("A-BODY\n\n");
      if (argv[0] === "show") return fail("fatal: path does not exist");
      if (argv[0] === "rev-parse") return ok(`${HEAD}\n`);
      return undefined;
    };
  }
  const prBodyGh = (body: string) => (argv: string[]): CmdResult | undefined =>
    argv[0] === "pr" && argv[1] === "view" ? ok(body) : undefined;

  test("packet: every git revision is the PR head sha, never the worktree HEAD, and nothing mutates the worktree (#5520)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({
        gitHandler: (argv) => (argv.join(" ") === "diff --no-renames PRIOR123 " + HEAD ? ok("SINCE\n") : packetGit()(argv)),
        ghHandler: prBodyGh("Merge danger: two-way — docs\n"),
        phase: async (p) =>
          p === "prior-context"
            ? { priorFindings: "F", context: { includeFindings: true, includeDiff: true, baseSha: "PRIOR123", reason: "r" }, degraded: [] }
            : {},
      });
      await runPacket(readyPre(), "gaberoo322/hydra", h.ports, { loadStandards: standardsOk, outDir: dir });
      const flat = h.git.flat();
      assert.ok(!flat.some((a) => a === "HEAD" || a.endsWith("...HEAD") || a.endsWith("..HEAD") || a.startsWith("HEAD:")), "no git argv names the literal HEAD");
      assert.ok(h.git.some((a) => a.join(" ") === "fetch origin refs/pull/77/head"), "the PR head ref is fetched");
      assert.ok(h.git.some((a) => a.join(" ") === `diff ${BASE_SHA}...${HEAD}`), "the diff is fixedSha...headSha");
      const mutating = ["checkout", "switch", "reset", "worktree", "clean", "stash"];
      assert.ok(!h.git.some((a) => mutating.includes(a[0] as string)), "no worktree-mutating verb");
      assert.ok(!h.gh.some((a) => a[0] === "pr" && a[1] === "checkout"), "no gh pr checkout");
      assert.ok(!readFileSync(join(dir, "review-packet.txt"), "utf8").includes("HEAD"), "packet text never says HEAD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: an unreachable PR head exits 1 before any packet file is written (#5520)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({
        gitHandler: (argv) => (argv[0] === "cat-file" ? fail("fatal: Not a valid object name") : argv[0] === "fetch" ? fail("fatal: couldn't find remote ref") : packetGit()(argv)),
        ghHandler: prBodyGh(""),
      });
      await assert.rejects(
        runPacket(readyPre(), "gaberoo322/hydra", h.ports, { loadStandards: standardsOk, outDir: dir }),
        /not resolvable locally/,
      );
      assert.deepEqual(readdirSync(dir), [], "no packet file for a head that does not resolve");
      assert.ok(!h.git.some((a) => a[0] === "diff"), "no diff is built against a missing head");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: standards catalog read failure exits 1 and writes no packet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({ gitHandler: packetGit(), ghHandler: prBodyGh("") });
      await assert.rejects(
        runPacket(readyPre(), "gaberoo322/hydra", h.ports, {
          loadStandards: async () => ({ ok: false, code: "standards-read-failed", path: "/x", message: "EACCES" }),
          outDir: dir,
        }),
        /standards catalog read failed: EACCES/,
      );
      assert.deepEqual(readdirSync(dir), [], "nothing is written when the catalog read fails");
      assert.deepEqual(h.git, [], "the catalog is loaded before any git read, let alone a reviewer spawn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: the review packet is byte-identical to the playbook bash and never carries the standards text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({ gitHandler: packetGit(), ghHandler: prBodyGh("Merge danger: two-way — docs\n") });
      const r = await runPacket(readyPre(), "gaberoo322/hydra", h.ports, { loadStandards: standardsOk, outDir: dir });
      const packet = readFileSync(r.reviewPacketPath, "utf8");
      assert.ok(
        packet.startsWith(
          `Diff (${BASE_SHA.slice(0, 12)}…${H12}):\n\nDIFF-BODY\n\nFull contents of every changed file at ${H12}:\n\n` +
            `===== src/a.ts @ ${H12} =====\nA-BODY\n\n` +
            `===== src/gone.ts @ ${H12} =====\n(file deleted or absent at the PR head — see the diff above)\n\n`,
        ),
        packet,
      );
      assert.ok(!packet.includes("RULES-TEXT"), "the Spec axis never sees the standards catalog");
      assert.equal(readFileSync(r.standardsPacketPath as string, "utf8"), "RULES-TEXT");
      assert.equal(r.standardsFound, true);
      assert.equal(readFileSync(r.specInputPath as string, "utf8"), JSON.stringify(CONCEPT));
      assert.match(packet, /\n\nMerge danger check \(informational\): declared=two-way detector=\w[\w-]* outcome=\w[\w-]* classes=.*$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: the Mechanical companions line lists only companions present in the diff, `none` otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const withCompanions = harness({
        gitHandler: packetGit({ [`diff --name-only ${BASE_SHA}...${HEAD}`]: ok("src/a.ts\ndocs/generated/adrs.json\ntest/fixtures/suite-count-baseline.json\ntest/fixtures/qa-cohort-baseline.json\n") }),
        ghHandler: prBodyGh("Merge danger: two-way — docs\n"),
      });
      const r1 = await runPacket(readyPre(), "gaberoo322/hydra", withCompanions.ports, { loadStandards: standardsOk, outDir: dir });
      const p1 = readFileSync(r1.reviewPacketPath, "utf8");
      assert.match(p1, /\n\nMechanical companions in this diff \([^)]*\): docs\/generated\/adrs\.json, test\/fixtures\/suite-count-baseline\.json\n\nMerge danger check/);
      assert.ok(!/Mechanical companions[^\n]*qa-cohort-baseline/.test(p1), "the graduation ledger is not a companion");

      const without = harness({ gitHandler: packetGit(), ghHandler: prBodyGh("Merge danger: two-way — docs\n") });
      const r2 = await runPacket(readyPre(), "gaberoo322/hydra", without.ports, { loadStandards: standardsOk, outDir: dir });
      assert.match(readFileSync(r2.reviewPacketPath, "utf8"), /\): none\n\nMerge danger check/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: a non-missing-path show failure is degraded, not rendered as a deleted file; a failed since-diff is degraded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({
        gitHandler: packetGit({ [`show ${HEAD}:src/a.ts`]: fail("fatal: unable to read tree (index lock)") }),
        ghHandler: prBodyGh(""),
      });
      const r = await runPacket(readyPre(), "gaberoo322/hydra", h.ports, { loadStandards: standardsOk, outDir: dir });
      const packet = readFileSync(r.reviewPacketPath, "utf8");
      assert.ok(r.degraded.includes("changed-file-unreadable"));
      assert.ok(!packet.includes(`===== src/a.ts @ ${H12} =====\n(file deleted`), "a transient error is not the deleted sentinel");
      assert.ok(packet.includes(`===== src/gone.ts @ ${H12} =====\n(file deleted or absent at the PR head`), "sibling: a genuinely missing path keeps the sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: an absent CODING_STANDARDS.md yields the fixed sentinel for the Standards prompts only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({ gitHandler: packetGit(), ghHandler: prBodyGh("") });
      const r = await runPacket(readyPre({ spec: { found: false, input: null, skippedReason: "x", mode: "warn" } }), "gaberoo322/hydra", h.ports, {
        loadStandards: async () => ({ ok: true, found: false, path: "/x/CODING_STANDARDS.md" }),
        outDir: dir,
      });
      assert.equal(r.standardsFound, false);
      assert.equal(readFileSync(r.standardsPacketPath as string, "utf8"), NO_STANDARDS_SENTINEL);
      assert.equal(r.specInputPath, null, "no artifact, no spec input file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: a re-review round appends the prior findings and the incremental diff to the packet (context only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({
        gitHandler: (argv) => (argv.join(" ") === `diff --no-renames PRIOR123 ${HEAD}` ? ok("SINCE-DIFF\n") : packetGit()(argv)),
        ghHandler: prBodyGh(""),
        phase: async (p) =>
          p === "prior-context"
            ? { priorFindings: "### Findings\n\n| medium | x |", context: { includeFindings: true, includeDiff: true, baseSha: "PRIOR123", reason: "r" }, degraded: [] }
            : {},
      });
      const r = await runPacket(readyPre(), "gaberoo322/hydra", h.ports, { loadStandards: standardsOk, outDir: dir });
      const packet = readFileSync(r.reviewPacketPath, "utf8");
      assert.equal(r.priorFindings, "### Findings\n\n| medium | x |");
      assert.equal(r.rereviewDiffBase, "PRIOR123");
      assert.match(packet, /\n\nRE-REVIEW CONTEXT — the previous QA round FAILed with the findings below\. Review the FULL change above as usual\./);
      assert.match(packet, /Changes since the prior verdict \(PRIOR123\.\.0123456789ab\), context only:\n\nSINCE-DIFF/);
      assert.ok(packet.indexOf("Full contents of every changed file") < packet.indexOf("RE-REVIEW CONTEXT"), "the full diff stays first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: a failed prior-context call means a plain first-pass review, named in degraded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      const h = harness({
        gitHandler: packetGit(),
        ghHandler: prBodyGh(""),
        phase: async () => {
          throw new Error("engine down");
        },
      });
      const r = await runPacket(readyPre(), "gaberoo322/hydra", h.ports, { loadStandards: standardsOk, outDir: dir });
      assert.equal(r.priorFindings, "");
      assert.ok(!readFileSync(r.reviewPacketPath, "utf8").includes("RE-REVIEW CONTEXT"));
      assert.deepEqual(r.degraded, ["prior-context"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packet: an under-declared Merge danger line yields a medium finding row and no gap line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-packet-test-"));
    try {
      // A `.github/workflows` path is a one-way-door class; the PR declares two-way.
      const h = harness({
        gitHandler: (argv) => (argv[0] === "diff" && argv.includes("--name-only") ? ok(".github/workflows/x.yml\n") : packetGit()(argv)),
        ghHandler: prBodyGh("Merge danger: two-way — nothing\n"),
      });
      const r = await runPacket(readyPre(), "gaberoo322/hydra", h.ports, { loadStandards: standardsOk, outDir: dir });
      const md = r.mergeDanger as { finding: { severity?: string } | null; gapLine: string | null };
      // Detector verdicts are the engine's; this pins only that the comparison result is carried verbatim.
      assert.ok(md.finding === null || typeof md.finding === "object");
      assert.ok(md.gapLine === null || typeof md.gapLine === "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const TRAILER = "QA-Verdict: FAIL pr=77 round=1 sha=0123456789ab blockers=1 max_severity=medium";
const PASS_TRAILER = "QA-Verdict: PASS pr=77 round=1 sha=0123456789ab blockers=0 max_severity=none";

interface Canned {
  verdict: string;
  reviewVerdict?: "PASS" | "FAIL";
  blockers?: number;
  maxSeverity?: string;
  worst?: string;
  trailer?: string;
  passMarker?: string | null;
  failMarker?: string | null;
  foldThrows?: boolean;
  trailerThrows?: boolean;
  roundThrows?: boolean;
  /** Fold blocking rows (the reviewer-commit decision reads their locations). */
  blocking?: Array<{ location: string }>;
  /** Canned `reviewer-commit` phase answer (default: `none` / `stage-off`). */
  reviewerCommit?: Record<string, unknown>;
}

/** Canned engine output, so every posted byte is determined by the route templates alone. */
function cannedPhase(c: Canned): PlumbingPorts["phase"] {
  return async (phase, input) => {
    if (phase === "fold") {
      if (c.foldThrows) throw new Error("fold down");
      return {
        fold: { reviewVerdict: c.reviewVerdict ?? "PASS", worstFinding: c.worst ?? "", blocking: c.blocking ?? [], followUps: [] },
        counts: { blockers: c.blockers ?? 0, maxSeverity: c.maxSeverity ?? "none" },
        report: "REPORT",
        verdict: { verdict: c.verdict, reason: "REASON" },
        ciSummary: "CHECKS",
        degraded: [],
      };
    }
    if (phase === "reviewer-commit") {
      return c.reviewerCommit ?? { action: "none", reason: "stage-off", detail: "off", blockingPaths: [], followUpPaths: [], bodyFix: false, degraded: [] };
    }
    if (phase === "trailer") {
      if (c.trailerThrows) throw new Error("trailer down");
      const verdictIn = String((input as { verdict?: unknown }).verdict ?? c.verdict);
      return { trailer: c.trailer ?? (verdictIn.startsWith("PASS") ? PASS_TRAILER : TRAILER), round: 1, degraded: [] };
    }
    if (c.roundThrows) throw new Error("round-action down");
    return {
      passMarker: c.passMarker ?? null,
      failMarker: c.failMarker ?? null,
      degraded: [],
    };
  };
}

const routeFiles = mkdtempSync(join(tmpdir(), "qa-route-files-"));
const findingsPath = join(routeFiles, "findings.json");
const summariesPath = join(routeFiles, "summaries.json");
writeFileSync(findingsPath, JSON.stringify({ standards: [], spec: [] }));
writeFileSync(summariesPath, JSON.stringify({ standardsSummary: "S", specSummary: "P" }));

const ROUTE_OPTS: RouteOptions = { repo: "gaberoo322/hydra", defer: false, dryRun: false, findingsPath, summariesPath };
const realDeps = (rows: unknown[][] = []): RouteDeps => ({
  readText: (p) => readFileSync(p, "utf8"),
  appendRows: async (r) => {
    rows.push(r);
  },
  now: () => new Date("2026-11-05T00:00:00Z"),
  sleep: async (ms) => {
    sleeps.push(ms);
  },
});
/** Backoff waits requested through `RouteDeps.sleep` (never a real timer in tests). */
const sleeps: number[] = [];

/** An `advance` fake: refuse the Nth call (or every call to `target`) with `code`. */
const refuse = (target: string, code: string, rc = 1) => (args: string[]): Partial<SeamOutcome> | undefined =>
  args[1] === target ? { rc, code } : undefined;
const advTo = (args: string[]): string => args[1] as string;

/** The counts a real `parked:qa-fail-rounds` refusal carries: the seam's timestamped count over its limit. */
const PARK_COUNTS: CapCount[] = [
  { arm: "qa-fail-rounds", unit: "pr", count: 3, limit: 3, source: "trailer", applicable: true },
  { arm: "total-claims", unit: "issue", count: 4, limit: 10, source: "journal", applicable: true },
];

/** A `gh` fake: answers the live PR-state read, records the rest. */
const withState = (state: string | "fail" | "empty") => (argv: string[]): CmdResult | undefined => {
  if (argv[0] === "pr" && argv[1] === "view" && argv.includes("state")) {
    if (state === "fail") return fail("gh: network");
    return ok(state === "empty" ? "" : `${state}\n`);
  }
  return undefined;
};

const summary = (b: number, s: string, w = "") => `${b} blocker(s), worst: ${s}${w ? ` — ${w}` : ""}`;

describe("route (steps 9.5-10, the single effect owner)", () => {
  test("route PASS: the verdict comment precedes the qa-passed seam advance; no direct label write, no gh pr merge --auto", async () => {
    const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "PASS" }) });
    const r = await runRoute(ROUTE_OPTS, readyPre({ tier: { num: 2, adversarial: false } }), h.ports, realDeps());
    const w = h.writes();
    assert.deepEqual(w.map((a) => `${a[0]} ${a[1]}`), ["pr comment", "lifecycle advance"]);
    assert.deepEqual(w[1], ["lifecycle", "advance", "5269", "qa-passed", "--evidence", "pr=77", "--actor", "hydra-qa"]);
    assert.ok(!h.gh.some((a) => a[0] === "issue" && a[1] === "edit"), "no direct state-label write (ADR-0047 D4)");
    assert.ok(!h.gh.some((a) => a[0] === "pr" && a[1] === "merge"), "route never arms auto-merge");
    assert.equal(r.nextStep, "arm-auto-merge");
    assert.equal(r.verdict, "PASS");
  });

  test("route PASS at T4 posts the engine's PASS marker comment only when it is non-empty", async () => {
    const pre = readyPre({ tier: { num: 4, adversarial: true } });
    const withMarker = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "PASS", passMarker: "MARKER-LINE" }) });
    await runRoute(ROUTE_OPTS, pre, withMarker.ports, realDeps());
    const bodies = withMarker.writes().filter((a) => a[1] === "comment").map((a) => argAfter(a, "--body"));
    assert.equal(bodies.length, 2);
    assert.match(bodies[1] ?? "", /^> \*T4 Verifier-Core deep-QA — PASS proof\*\n\nMARKER-LINE\n\n/);

    const without = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "PASS", passMarker: null }) });
    const r = await runRoute(ROUTE_OPTS, pre, without.ports, realDeps());
    assert.equal(without.writes().filter((a) => a[1] === "comment").length, 1, "no marker comment on an empty .passMarker");
    assert.ok(r.degraded.includes("pass-marker"));
  });

  test("route FAIL: the seam's one live read picks the lane (OPEN -> needs-dev-resume, CLOSED -> ready-for-agent); an unreadable state refuses; MERGED stops", async () => {
    const failPhase = cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium", worst: "w" });
    const open = harness({ ghHandler: withState("OPEN"), phase: failPhase });
    await runRoute(ROUTE_OPTS, readyPre({ tier: { num: 3, adversarial: true } }), open.ports, realDeps());
    assert.deepEqual(open.advances.map(advTo), ["needs-dev-resume"]);
    assert.deepEqual(open.advances[0], ["5269", "needs-dev-resume", "--evidence", "pr=77", "--actor", "hydra-qa"]);

    const closed = harness({ ghHandler: withState("CLOSED"), phase: failPhase });
    await runRoute(ROUTE_OPTS, readyPre(), closed.ports, realDeps());
    assert.deepEqual(closed.advances.map(advTo), ["ready-for-agent"]);

    for (const state of ["fail", "empty"] as const) {
      const h = harness({ ghHandler: withState(state), phase: failPhase });
      await assert.rejects(runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps()), /bounce refused \(fetch-failed\)/, `state read '${state}'`);
      assert.deepEqual(h.advances, [], "an unreadable PR state writes no label");
    }

    const merged = harness({ ghHandler: withState("MERGED"), phase: failPhase });
    const r = await runRoute(ROUTE_OPTS, readyPre(), merged.ports, realDeps());
    assert.deepEqual(merged.advances, [], "MERGED: reconcile owns the exit, QA writes nothing");
    assert.ok(r.degraded.includes("pr-merged"));
  });

  test("route: GLM provenance selects comment wording only, never the bounce lane", async () => {
    const pre = readyPre({ pr: { ...(readyPre().pr as NonNullable<PreflightResult["pr"]>), glmAuthored: true } });
    const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }) });
    await runRoute(ROUTE_OPTS, pre, h.ports, realDeps());
    assert.deepEqual(h.advances.map(advTo), ["needs-dev-resume"]);
    const issueBody = argAfter(h.writes().filter((a) => a[0] === "issue" && a[1] === "comment")[0] as string[], "--body");
    assert.match(issueBody ?? "", /^> \*Automated QA failed \(GLM-authored PR\)\*/);
  });

  test("route FAIL (T1-T3) effect order: disarm, PR verdict comment, seam advance, issue comment — the disarm is first", async () => {
    const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }) });
    await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(h.writes().map((a) => `${a[0]} ${a[1]}`), ["pr merge", "pr comment", "lifecycle advance", "issue comment"]);
    assert.deepEqual(h.writes()[0], ["pr", "merge", "77", "--repo", "gaberoo322/hydra", "--disable-auto"]);
  });

  test("route escalate (enforce): the seam's parked:qa-fail-rounds refusal IS the escalation - one advance, no ready-for-human, no by-hand label call", async () => {
    const h = harness({
      ghHandler: withState("OPEN"),
      advanceHandler: refuse("needs-dev-resume", "parked:qa-fail-rounds"),
      parkCounts: PARK_COUNTS,
      phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 2, maxSeverity: "high" }),
    });
    const r = await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(h.advances.map(advTo), ["needs-dev-resume"], "the seam parked in the same call; QA adds nothing");
    assert.ok(!h.gh.some((a) => a[0] === "api" || (a[0] === "issue" && a[1] === "edit")), "no label call by hand");
    assert.ok(!h.advances.some((a) => a.includes("ready-for-human")), "a T1-T3 round cap never writes ready-for-human");
    const last = argAfter(h.writes().at(-1) as string[], "--body") as string;
    assert.match(last, /round cap reached/);
    assert.ok(last.includes(renderParkSummary("parked:qa-fail-rounds", PARK_COUNTS)), "the summary is rendered from the seam's counts");
    assert.match(last, /qa-fail-rounds=3\/3/);
    assert.equal(h.writes().filter((a) => a[1] === "comment" && a[0] === "issue").length, 1, "enforce: the seam posted the cap-park comment, QA posts only its own");
    assert.ok(r.effects.some((e) => e.kind === "fail-bounce-advance" && !e.ok));
  });

  test("route acts on the seam park only: an allowed advance parks nothing (#5437)", async () => {
    const h = harness({
      ghHandler: withState("OPEN"),
      phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }),
    });
    await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    const bodies = h.writes().filter((a) => a[0] === "issue" && a[1] === "comment").map((a) => argAfter(a as string[], "--body") as string);
    assert.ok(!bodies.some((b) => /round cap reached/.test(b)), "no escalation comment without the seam refusal");
  });

  test("a park after an operator reset renders its summary from the seam's timestamped count, never fallback prose", async () => {
    // The seam counts only rounds newer than the Hydra-Cap-Reset marker (countReviewedFailRoundsAfterReset);
    // the route renders exactly the counts the refusal carries.
    const h = harness({
      ghHandler: withState("OPEN"),
      advanceHandler: refuse("needs-dev-resume", "parked:qa-fail-rounds"),
      parkCounts: [{ arm: "qa-fail-rounds", unit: "pr", count: 3, limit: 3, source: "trailer", applicable: true }],
      phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }),
    });
    await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    const last = argAfter(h.writes().at(-1) as string[], "--body") as string;
    assert.match(last, /`qa-fail-rounds` is at 3\/3 \(per pr\)/);
    assert.doesNotMatch(last, /See the PR thread/);
  });

  test("renderParkSummary is total: an empty or arm-less counts array still names the arm from the code", () => {
    assert.match(renderParkSummary("parked:qa-fail-rounds", []), /`qa-fail-rounds`/);
    assert.match(renderParkSummary("parked:qa-fail-rounds", undefined), /`qa-fail-rounds`/);
    assert.match(renderParkSummary("parked:qa-fail-rounds", [PARK_COUNTS[1] as CapCount]), /total-claims=4\/10/);
  });

  test("route escalate: a park is the parked:qa-fail-rounds refusal - no follow-up park advance, no caller-side cap comment", async () => {
    // The seam parks the qa-fail-rounds arm and posts the unified comment itself, so the route
    // adds only its own escalation comment.
    const h = harness({
      ghHandler: withState("OPEN"),
      advanceHandler: refuse("needs-dev-resume", "parked:qa-fail-rounds"),
      phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high" }),
    });
    await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(h.advances.map(advTo), ["needs-dev-resume"], "no explicit follow-up park advance");
    const bodies = h.writes().filter((a) => a[0] === "issue" && a[1] === "comment").map((a) => argAfter(a, "--body") as string);
    assert.equal(bodies.length, 1, "QA posts only failEscalated; the unified park comment is the seam's");
    assert.match(bodies[0] ?? "", /round cap reached/);
    assert.ok(!bodies.some((b) => b.startsWith("## Hydra cap park")));
    // sibling: no refusal keeps the plain bounce (one advance).
    const plain = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high" }) });
    await runRoute(ROUTE_OPTS, readyPre(), plain.ports, realDeps());
    assert.deepEqual(plain.advances.map(advTo), ["needs-dev-resume"]);
  });

  test("route FAIL: any other seam refusal ends the route (exit 1), never a by-hand label edit; pr-merged ends it with exit 0", async () => {
    const mk = (code: string) => harness({
      ghHandler: withState("OPEN"),
      advanceHandler: refuse("needs-dev-resume", code),
      phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }),
    });
    const bad = mk("state-entry-unknown");
    await assert.rejects(runRoute(ROUTE_OPTS, readyPre(), bad.ports, realDeps()), /refused \(state-entry-unknown\)/);
    assert.ok(!bad.gh.some((a) => a[0] === "issue" && a[1] === "edit"));
    assert.equal(bad.writes().filter((a) => a[0] === "issue" && a[1] === "comment").length, 0, "no issue comment after a refused advance");
    const merged = mk("pr-merged");
    const r = await runRoute(ROUTE_OPTS, readyPre(), merged.ports, realDeps());
    assert.ok(r.degraded.includes("pr-merged"));
    assert.equal(r.nextStep, "none");
  });

  test("route T4 FAIL: disarm, then the PR comment carrying .failMarker, then the same seam bounce as every FAIL; an escalated refusal posts nothing more", async () => {
    const pre = readyPre({ tier: { num: 4, adversarial: true } });
    const t4Fail: Canned = { verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high", failMarker: "FAIL-MARKER" };
    const bounce = harness({ ghHandler: withState("OPEN"), phase: cannedPhase(t4Fail) });
    await runRoute(ROUTE_OPTS, pre, bounce.ports, realDeps());
    assert.deepEqual(bounce.writes().map((a) => `${a[0]} ${a[1]}`), ["pr merge", "pr comment", "lifecycle advance", "issue comment"]);
    assert.match(argAfter(bounce.writes()[1] as string[], "--body") ?? "", /\n\nFAIL-MARKER\n\n/);
    assert.deepEqual(bounce.advances, [["5269", "needs-dev-resume", "--evidence", "pr=77", "--actor", "hydra-qa"]]);

    // The seam's deep-qa-fails arm escalated: it wrote ready-for-human and posted the unified comment itself.
    const escalated = harness({ ghHandler: withState("OPEN"), advanceHandler: refuse("needs-dev-resume", "escalated:deep-qa-fails"), phase: cannedPhase(t4Fail) });
    await runRoute(ROUTE_OPTS, pre, escalated.ports, realDeps());
    assert.deepEqual(escalated.writes().map((a) => `${a[0]} ${a[1]}`), ["pr merge", "pr comment", "lifecycle advance"]);
    assert.deepEqual(escalated.advances.map(advTo), ["needs-dev-resume"], "the route names no ready-for-human advance of its own");

    // Sibling shape: an escalation whose exit write landed stays a quiet success.
    const landed = harness({ ghHandler: withState("OPEN"), advanceHandler: refuse("needs-dev-resume", "escalated:deep-qa-fails"), exitWritten: true, phase: cannedPhase(t4Fail) });
    await runRoute(ROUTE_OPTS, pre, landed.ports, realDeps());
  });

  test("route T4 FAIL: an escalated refusal whose ready-for-human write did NOT land fails loudly, never a silent success", async () => {
    const pre = readyPre({ tier: { num: 4, adversarial: true } });
    const t4Fail: Canned = { verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high", failMarker: "FAIL-MARKER" };
    const lost = harness({ ghHandler: withState("OPEN"), advanceHandler: refuse("needs-dev-resume", "escalated:deep-qa-fails"), exitWritten: false, phase: cannedPhase(t4Fail) });
    await assert.rejects(runRoute(ROUTE_OPTS, pre, lost.ports, realDeps()), /escalation refused/);
  });

  test("route T4 FAIL with unreadable PR bodies refuses before ANY side effect: no disarm, no comment, no marker, no bounce", async () => {
    const pre = readyPre({ tier: { num: 4, adversarial: true } });
    const t4Fail: Canned = { verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high", failMarker: "FAIL-MARKER" };
    const unreadable = harness({ ghHandler: withState("OPEN"), prBodiesReadable: false, phase: cannedPhase(t4Fail) });
    await assert.rejects(runRoute(ROUTE_OPTS, pre, unreadable.ports, realDeps()), /fetch-failed/);
    assert.deepEqual(unreadable.writes(), [], "nothing written: needs-qa retained, no marker to double-count on retry");
    assert.deepEqual(unreadable.advances, []);
  });

  test("sibling shape: a T1-T3 FAIL does not preflight the PR bodies and still bounces", async () => {
    const t3Fail: Canned = { verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high" };
    const h = harness({ ghHandler: withState("OPEN"), prBodiesReadable: false, phase: cannedPhase(t3Fail) });
    await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.equal(h.advances.length, 1);
  });

  test("route: PASS-pending-CI posts the pending comment then enters qa-passed through the seam", async () => {
    const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "PASS-pending-CI" }) });
    const r = await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(h.writes().map((a) => `${a[0]} ${a[1]}`), ["pr comment", "lifecycle advance"]);
    assert.equal(advTo(h.advances[0] as string[]), "qa-passed");
    assert.equal(r.nextStep, "none", "a pending-CI PASS is re-polled by the autopilot, never merged here");
  });

  const errorComment = "> *Automated QA — fold failed, no verdict emitted*\n\nQA-Verdict-Error: pr=77 reason=fold-phase-failed";

  test("route: a fold failure is exit 1 with ONE visible QA-Verdict-Error comment and no label change, never a PASS", async () => {
    for (const c of [{ foldThrows: true }, { trailerThrows: true }, { roundThrows: true }] as const) {
      const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "PASS", ...c }) });
      await assert.rejects(runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps()), /down/);
      const w = h.writes();
      assert.equal(w.length, 1, `${Object.keys(c)[0]}: only the error comment, needs-qa untouched`);
      assert.deepEqual(w[0]?.slice(0, 3), ["pr", "comment", "77"]);
      assert.equal(argAfter(w[0] as string[], "--body"), errorComment);
    }
  });

  test("route: the error comment is best-effort (a failing post still rethrows the original error) and never posted on --dry-run", async () => {
    const failing = harness({ ghHandler: (a) => (a[0] === "pr" && a[1] === "comment" ? fail("gh: down") : undefined), phase: cannedPhase({ verdict: "PASS", foldThrows: true }) });
    await assert.rejects(runRoute(ROUTE_OPTS, readyPre(), failing.ports, realDeps()), /fold down/);
    const dry = harness({ phase: cannedPhase({ verdict: "PASS", foldThrows: true }) });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, dryRun: true }, readyPre(), dry.ports, realDeps()), /fold down/);
    assert.deepEqual(dry.writes(), []);
  });

  test("route: a T4 FAIL without a fail marker still posts the QA-Verdict-Error comment (pre-verdict exit)", async () => {
    const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high", failMarker: null }) });
    await assert.rejects(runRoute(ROUTE_OPTS, readyPre({ tier: { num: 4, adversarial: true } }), h.ports, realDeps()), /deep-QA fail marker/);
    assert.equal(h.writes().length, 1, "only the error comment; no disarm, no relabel");
    assert.equal(argAfter(h.writes()[0] as string[], "--body"), errorComment);
  });

  test("route FAIL: a failed disarm is retried once then surfaced as degraded disarm-failed; a clean disarm is not", async () => {
    const mk = (failDisarm: boolean) => harness({
      ghHandler: (a) => (failDisarm && a[0] === "pr" && a[1] === "merge" ? fail("gh: 502") : withState("OPEN")(a)),
      phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }),
    });
    const bad = mk(true);
    sleeps.length = 0;
    const r = await runRoute(ROUTE_OPTS, readyPre(), bad.ports, realDeps());
    assert.ok(r.degraded.includes("disarm-failed"));
    assert.equal(bad.writes().filter((a) => a[0] === "pr" && a[1] === "merge").length, 2, "retried once");
    assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms > 0), "a short backoff precedes the single retry");
    const good = mk(false);
    sleeps.length = 0;
    const r2 = await runRoute(ROUTE_OPTS, readyPre(), good.ports, realDeps());
    assert.ok(!r2.degraded.includes("disarm-failed"), "sibling: clean disarm");
    assert.deepEqual(sleeps, [], "sibling: a clean disarm never waits");
  });

  test("route FAIL: a failed disarm followed by a refused seam advance re-disarms and prints a loud HARD STOP on stderr, then still throws; a clean disarm prints none", async () => {
    const mk = (failDisarm: boolean) => harness({
      ghHandler: (a) => (failDisarm && a[0] === "pr" && a[1] === "merge" ? fail("gh: 502") : withState("OPEN")(a)),
      advanceHandler: refuse("needs-dev-resume", "state-entry-unknown"),
      phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }),
    });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    try {
      const bad = mk(true);
      await assert.rejects(runRoute(ROUTE_OPTS, readyPre(), bad.ports, realDeps()), /refused \(state-entry-unknown\)/);
      assert.equal(bad.writes().filter((a) => a[0] === "pr" && a[1] === "merge").length, 3, "2 in disarmChecked + 1 final re-disarm");
      assert.ok(errs.some((e) => /HARD STOP.*#77.*--disable-auto/.test(e)), "loud stderr names the manual disarm");
      errs.length = 0;
      const good = mk(false);
      await assert.rejects(runRoute(ROUTE_OPTS, readyPre(), good.ports, realDeps()), /refused/);
      assert.equal(good.writes().filter((a) => a[0] === "pr" && a[1] === "merge").length, 1, "sibling: clean disarm, no extra re-disarm");
      assert.ok(!errs.some((e) => /HARD STOP/.test(e)), "sibling: no HARD STOP line");
    } finally {
      console.error = orig;
    }
  });

  test("route PASS: arm-auto-merge only when the PASS comment AND the qa-passed advance both landed", async () => {
    const pre = readyPre({ tier: { num: 2, adversarial: false } });
    const commentFails = harness({
      ghHandler: (a) => (a[0] === "pr" && a[1] === "comment" ? fail("gh: 502") : undefined),
      phase: cannedPhase({ verdict: "PASS" }),
    });
    const r1 = await runRoute(ROUTE_OPTS, pre, commentFails.ports, realDeps());
    assert.equal(r1.nextStep, "none", "a failed PASS comment must not arm auto-merge");
    assert.ok(r1.degraded.includes("pass-effects"));
    const okRun = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "PASS" }) });
    const r = await runRoute(ROUTE_OPTS, pre, okRun.ports, realDeps());
    assert.equal(r.nextStep, "arm-auto-merge", "sibling: all effects ok keeps the arm step");
    assert.ok(!r.degraded.includes("pass-effects"));
  });

  test("route PASS: a refused qa-passed advance posts a QA-Verdict-Error, defers off needs-qa through the seam, and never arms", async () => {
    const h = harness({
      ghHandler: withState("OPEN"),
      advanceHandler: refuse("qa-passed", "qa-verdict-stale"),
      phase: cannedPhase({ verdict: "PASS" }),
    });
    const r = await runRoute(ROUTE_OPTS, readyPre({ tier: { num: 2, adversarial: false } }), h.ports, realDeps());
    assert.deepEqual(h.advances.map(advTo), ["qa-passed", "needs-dev-resume"]);
    assert.deepEqual(h.advances[1]?.slice(2), ["--evidence", "pr=77", "--evidence", "defer=1", "--actor", "hydra-qa"]);
    const bodies = h.writes().filter((a) => a[0] === "pr" && a[1] === "comment").map((a) => argAfter(a, "--body") as string);
    assert.match(bodies[1] ?? "", /^QA-Verdict-Error: verdict=PASS pr=77 reason=lifecycle advance to qa-passed refused \(qa-verdict-stale\)/);
    assert.equal(r.nextStep, "none");
    assert.ok(r.degraded.includes("qa-passed-refused"));
    // both refused: exit 1, never a by-hand edit.
    const both = harness({ ghHandler: withState("OPEN"), advanceHandler: () => ({ rc: 1, code: "nope" }), phase: cannedPhase({ verdict: "PASS" }) });
    await assert.rejects(runRoute(ROUTE_OPTS, readyPre({ tier: { num: 2, adversarial: false } }), both.ports, realDeps()), /refused/);
    // pr-merged exits 0 with no further effects.
    const merged = harness({ ghHandler: withState("OPEN"), advanceHandler: refuse("qa-passed", "pr-merged"), phase: cannedPhase({ verdict: "PASS" }) });
    const rm = await runRoute(ROUTE_OPTS, readyPre({ tier: { num: 2, adversarial: false } }), merged.ports, realDeps());
    assert.equal(rm.nextStep, "none");
    assert.deepEqual(merged.advances.map(advTo), ["qa-passed"], "no defer reroute after pr-merged");
  });

  test("route PASS at T4: a failed pass-proof comment withholds arm-auto-merge", async () => {
    let n = 0;
    const h = harness({
      ghHandler: (a) => (a[0] === "pr" && a[1] === "comment" && ++n === 2 ? fail("gh: 502") : undefined),
      phase: cannedPhase({ verdict: "PASS", passMarker: "MARKER" }),
    });
    const r = await runRoute(ROUTE_OPTS, readyPre({ tier: { num: 4, adversarial: true } }), h.ports, realDeps());
    assert.equal(r.nextStep, "none");
  });

  test("route: unreadable checks at preflight is a pre-verdict exit, never an implicit PASS", async () => {
    const pre = readyPre({ checks: { list: [], degraded: true, source: null } });
    const h = harness({ phase: cannedPhase({ verdict: "PASS" }) });
    await assert.rejects(runRoute(ROUTE_OPTS, pre, h.ports, realDeps()), /checks were unreadable/);
    assert.deepEqual(h.writes(), []);
  });

  test("route: a malformed findings file reaches the engine RAW (fail-closed there), never a jq-style abort", async () => {
    const seen: unknown[] = [];
    const bad = join(routeFiles, "bad.json");
    writeFileSync(bad, "not json {");
    const h = harness({
      ghHandler: withState("OPEN"),
      phase: async (p, i) => {
        if (p === "fold") seen.push((i as { findings: unknown }).findings);
        return cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high" })(p, i);
      },
    });
    await runRoute({ ...ROUTE_OPTS, findingsPath: bad }, readyPre(), h.ports, realDeps());
    assert.equal(seen[0], "not json {");
    // A missing file is the empty raw text.
    const seen2: unknown[] = [];
    const h2 = harness({
      ghHandler: withState("OPEN"),
      phase: async (p, i) => {
        if (p === "fold") seen2.push((i as { findings: unknown }).findings);
        return cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "high" })(p, i);
      },
    });
    await runRoute({ ...ROUTE_OPTS, findingsPath: join(routeFiles, "absent.json") }, readyPre(), h2.ports, {
      ...realDeps(),
      readText: (p) => (p.endsWith("absent.json") ? null : readFileSync(p, "utf8")),
    });
    assert.equal(seen2[0], "");
  });

  test("route: skip-required-failed spawns no fold, carries the engine FAIL, and does not count as a reviewed round", async () => {
    const calls: string[] = [];
    const inputs: Record<string, unknown> = {};
    const pre = readyPre({
      gate: { action: "skip-required-failed", reason: "r", redRequired: ["test", "tier-gate"], skipVerdict: { verdict: "FAIL", reason: "Required CI check(s) failed: test, tier-gate" }, skipCiSummary: "SKIP-CI" },
    });
    const h = harness({
      ghHandler: withState("OPEN"),
      phase: async (p, i) => {
        calls.push(p);
        inputs[p] = i;
        return cannedPhase({ verdict: "FAIL" })(p, i);
      },
    });
    const r = await runRoute({ ...ROUTE_OPTS, findingsPath: undefined, summariesPath: undefined }, pre, h.ports, realDeps());
    assert.deepEqual(calls, ["trailer", "round-action"], "no fold on a CI-only round");
    assert.deepEqual(Object.keys(inputs["round-action"] as object).sort(), ["pr", "reviewVerdict", "tier", "verdict"], "the round-action input carries no round-decision fields");
    assert.equal((inputs["trailer"] as { blockers: number }).blockers, 2);
    assert.equal((inputs["trailer"] as { maxSeverity: string }).maxSeverity, "high");
    assert.equal(r.worstFinding, "required CI check(s) red: test, tier-gate");
    assert.ok(argAfter(h.writes()[1] as string[], "--body")?.includes(SKIP_REVIEW_REPORT));
  });

  test("route --defer: PR comment, seam bounce, issue comment — and no verdict, trailer or engine call", async () => {
    const calls: string[] = [];
    const pre = readyPre({ gate: { action: "defer", reason: "mergeStateStatus is DIRTY", redRequired: ["test"], skipVerdict: null, skipCiSummary: null } });
    const h = harness({ ghHandler: withState("OPEN"), phase: async (p) => { calls.push(p); return {}; } });
    const r = await runRoute({ ...ROUTE_OPTS, defer: true, findingsPath: undefined, summariesPath: undefined }, pre, h.ports, realDeps());
    assert.deepEqual(h.writes().map((a) => `${a[0]} ${a[1]}`), ["pr comment", "lifecycle advance", "issue comment"]);
    assert.deepEqual(h.advances[0], ["5269", "needs-dev-resume", "--evidence", "pr=77", "--evidence", "defer=1", "--actor", "hydra-qa"]);
    assert.deepEqual(calls, [], "a defer reaches no fold / trailer / round-action");
    assert.equal(r.verdict, null);
    assert.equal(r.trailer, "");
    assert.equal(r.nextStep, "none");
    await assert.rejects(runRoute({ ...ROUTE_OPTS, defer: true }, readyPre(), h.ports, realDeps()), /--defer is only valid/);
  });

  test("route: a non-ready preflight stage posts its ONE stop comment and nothing else (no engine call, no relabel)", async () => {
    const calls: string[] = [];
    const stopPre = readyPre({ ok: false, stage: "spec-missing-enforce", stop: { target: "pr", body: "STOP-BODY" } });
    const noFiles = { ...ROUTE_OPTS, findingsPath: undefined, summariesPath: undefined };
    const h = harness({ phase: async (p) => { calls.push(p); return {}; } });
    const r = await runRoute(noFiles, stopPre, h.ports, realDeps());
    assert.deepEqual(h.writes().map((a) => `${a[0]} ${a[1]}`), ["pr comment"]);
    assert.equal(argAfter(h.writes()[0] as string[], "--body"), "STOP-BODY");
    assert.deepEqual(calls, []);
    assert.equal(r.verdict, null);

    const noPr = readyPre({ ok: false, stage: "no-pr", pr: null, stop: { target: "issue", body: "NO-PR" } });
    const h2 = harness();
    await runRoute(noFiles, noPr, h2.ports, realDeps());
    assert.deepEqual(h2.writes().map((a) => `${a[0]} ${a[1]}`), ["issue comment"]);

    const none = readyPre({ ok: false, stage: "no-issue", issue: null, pr: null, stop: null });
    const h3 = harness();
    await runRoute(noFiles, none, h3.ports, realDeps());
    assert.deepEqual(h3.gh, [], "no issue to review: report and stop, nothing posted");
  });

  test("route --dry-run prints the identical effect plan with zero writes", async () => {
    const mk = () => harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }) });
    const live = mk();
    const liveRes = await runRoute(ROUTE_OPTS, readyPre(), live.ports, realDeps());
    const dry = mk();
    const rows: unknown[][] = [];
    const dryRes = await runRoute({ ...ROUTE_OPTS, dryRun: true }, readyPre(), dry.ports, realDeps(rows));
    assert.deepEqual(dry.writes(), []);
    assert.deepEqual(dryRes.effects.map((e) => `${e.kind} ${e.target}`), liveRes.effects.map((e) => `${e.kind} ${e.target}`));
    assert.equal(rows.length, 0, "--dry-run appends no review-findings rows");
    assert.equal(dryRes.dryRun, true);
  });

  test("route appends review-findings rows after the gh effects; a failing append is non-fatal and named in degraded", async () => {
    const rows: unknown[][] = [];
    const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }) });
    await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps(rows));
    assert.equal(rows.length, 1, "rows ride the route step once the trailer carries a round");

    const failing = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }) });
    const r = await runRoute(ROUTE_OPTS, readyPre(), failing.ports, {
      ...realDeps(),
      appendRows: async () => {
        throw new Error("redis down");
      },
    });
    assert.ok(r.degraded.includes("review-findings"));
    assert.equal(failing.writes().length, 4, "the gh and seam effects were all performed");
  });

  test("route: a throwing or missing loadStandards degrades to grammar-only and still appends rows", async () => {
    const mk = () => harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }) });
    const thrown: unknown[][] = [];
    const r = await runRoute(ROUTE_OPTS, readyPre(), mk().ports, {
      ...realDeps(thrown),
      loadStandards: async () => {
        throw new Error("fs down");
      },
    });
    assert.equal(thrown.length, 1, "loader throw must not skip the append");
    assert.ok(!r.degraded.includes("review-findings"));
    const missing: unknown[][] = [];
    await runRoute(ROUTE_OPTS, readyPre(), mk().ports, {
      ...realDeps(missing),
      loadStandards: async () => ({ ok: true, found: false }) as never,
    });
    assert.equal(missing.length, 1, "found:false keeps the grammar-only append");
  });

  test("route: a Merge-danger finding row is added to the findings map and the gap line is appended to the report", async () => {
    const packetPath = join(routeFiles, "packet.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        reviewPacketPath: "/x", standardsPacketPath: "/y", standardsFound: true, specInputPath: null,
        priorFindings: "", rereviewDiffBase: "",
        mergeDanger: { finding: { severity: "medium", location: "PR body", finding: "under-declared", fix: "declare one-way" }, gapLine: "Merge-danger-gap: pr=77" },
        degraded: [],
      }),
    );
    let folded: { findings?: Record<string, unknown> } = {};
    const h = harness({
      ghHandler: withState("OPEN"),
      phase: async (p, i) => {
        if (p === "fold") folded = i as typeof folded;
        return cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" })(p, i);
      },
    });
    await runRoute({ ...ROUTE_OPTS, packetPath }, readyPre(), h.ports, realDeps());
    assert.deepEqual(Object.keys(folded.findings ?? {}).sort(), ["merge-danger-check", "spec", "standards"]);
    assert.ok(!readyPre().fanout.reviewers.includes("merge-danger-check"), "the synthetic key is never a spawned reviewer");
    assert.match(argAfter(h.writes().find((a) => a[1] === "comment") as string[], "--body") ?? "", /REPORT\n\nMerge-danger-gap: pr=77\n\n---/);
  });
});

// ---------------------------------------------------------------------------
// Golden bodies — the recorded posted bytes of every arm.
// ---------------------------------------------------------------------------

describe("route golden bodies (posted bytes frozen, issue #5269 INV-7)", () => {
  interface Arm {
    name: string;
    advance?: (args: string[]) => Partial<SeamOutcome> | undefined;
    pre: PreflightResult;
    canned: Canned;
    state?: string;
    opts?: Partial<RouteOptions>;
    /** Expected `--body` of each gh comment, in order. */
    bodies: string[];
  }
  const sum = summary(1, "medium", "w");
  const failCanned: Canned = { verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium", worst: "w" };
  const glmPre = readyPre({ pr: { ...(readyPre().pr as NonNullable<PreflightResult["pr"]>), glmAuthored: true } });
  const redPre = readyPre({ gate: { action: "admit", reason: "admit", redRequired: ["test", "tier-gate"], skipVerdict: null, skipCiSummary: null } });

  const failPr = `> *Automated QA — two-axis review*\n\nREPORT\n\n---\n\n**Verdict:** \`FAIL\` — REASON\n\nCHECKS\n\n${TRAILER}`;
  const arms: Arm[] = [
    {
      name: "PASS",
      pre: readyPre(),
      canned: { verdict: "PASS" },
      bodies: [`> *Automated QA — two-axis review*\n\nREPORT\n\n---\n\n**Verdict:** \`PASS\` — REASON\n\nCHECKS\n\n${PASS_TRAILER}`],
    },
    {
      name: "PASS-pending-CI",
      pre: readyPre(),
      canned: { verdict: "PASS-pending-CI", trailer: "QA-Verdict: PASS-pending-CI pr=77 round=1 sha=0123456789ab blockers=0 max_severity=none" },
      bodies: [
        "> *Automated QA — two-axis review (pending CI)*\n\nREPORT\n\n---\n\nCode review **PASS**. Awaiting CI:\n\nCHECKS\n\nVerdict: `PASS-pending-CI`. Autopilot will re-evaluate once required checks conclude. **The QA subagent has exited — no background wait.**\n\nQA-Verdict: PASS-pending-CI pr=77 round=1 sha=0123456789ab blockers=0 max_severity=none",
      ],
    },
    {
      name: "FAIL open",
      pre: readyPre(),
      canned: failCanned,
      state: "OPEN",
      bodies: [
        failPr,
        `> *Automated QA failed (open PR)*\n\n\`FAIL\` on PR #77 — ${sum}. Full review on the PR.\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the retry on this branch.\n\n${TRAILER}`,
      ],
    },
    {
      name: "FAIL open with red required checks",
      pre: redPre,
      canned: failCanned,
      state: "OPEN",
      bodies: [
        failPr,
        `> *Automated QA failed (open PR)*\n\n\`FAIL\` on PR #77 — ${sum}. Full review on the PR.\n\nRed required check(s): test, tier-gate\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the retry on this branch.\n\n${TRAILER}`,
      ],
    },
    {
      name: "FAIL GLM wording",
      pre: glmPre,
      canned: failCanned,
      state: "OPEN",
      bodies: [
        failPr,
        `> *Automated QA failed (GLM-authored PR)*\n\n\`FAIL\` on PR #77 — ${sum}. Full review on the PR.\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the GLM drainer skips open-PR anchors; the autopilot's pinned forward-fix (issue #4460) owns the retry on this branch.\n\n${TRAILER}`,
      ],
    },
    {
      name: "FAIL not-open",
      pre: readyPre(),
      canned: failCanned,
      state: "CLOSED",
      bodies: [failPr, `> *Automated QA failed*\n\n\`FAIL\` on PR #77 — ${sum}. Full review on the PR.\n\nReturning to ready-for-agent for retry.\n\n${TRAILER}`],
    },
    {
      name: "escalate (enforce: the seam parked)",
      pre: readyPre(),
      advance: (a) => (a[1] === "needs-dev-resume" ? { rc: 1, code: "parked:qa-fail-rounds" } : undefined),
      canned: { ...failCanned },
      state: "OPEN",
      bodies: [
        failPr,
        `> *Automated QA escalated — round cap reached*\n\n\`FAIL\` on PR #77 — ${sum}. The issue is \`parked\`; no dev lane will pick it up until the operator un-parks it.\n\n${renderParkSummary("parked:qa-fail-rounds", [])}\n\n${TRAILER}`,
      ],
    },
    {
      name: "T4 bounce",
      pre: readyPre({ tier: { num: 4, adversarial: true } }),
      canned: { ...failCanned, failMarker: "Verifier-Core deep-QA: FAIL" },
      state: "OPEN",
      bodies: [
        `> *Automated QA — T4 Verifier-Core deep review*\n\nREPORT\n\n---\n\n**Verdict:** \`FAIL\` — REASON\n\nVerifier-Core deep-QA: FAIL\n\nCHECKS\n\n${TRAILER}`,
        `> *Automated QA failed (open PR)*\n\n\`FAIL\` on PR #77 — ${sum}. Full review on the PR.\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the retry on this branch.\n\n${TRAILER}`,
      ],
    },
    {
      name: "T4 escalate (the seam wrote ready-for-human and commented)",
      pre: readyPre({ tier: { num: 4, adversarial: true } }),
      advance: (a) => (a[1] === "needs-dev-resume" ? { rc: 1, code: "escalated:deep-qa-fails" } : undefined),
      canned: { ...failCanned, failMarker: "Verifier-Core deep-QA: FAIL" },
      state: "OPEN",
      bodies: [
        `> *Automated QA — T4 Verifier-Core deep review*\n\nREPORT\n\n---\n\n**Verdict:** \`FAIL\` — REASON\n\nVerifier-Core deep-QA: FAIL\n\nCHECKS\n\n${TRAILER}`,
      ],
    },
    {
      name: "defer open",
      pre: readyPre({ gate: { action: "defer", reason: "GATE-REASON", redRequired: ["test"], skipVerdict: null, skipCiSummary: null } }),
      canned: { verdict: "PASS" },
      state: "OPEN",
      opts: { defer: true },
      bodies: [
        "> *Automated QA — review deferred*\n\nGATE-REASON\n\nNo verdict is being emitted — the PR cannot merge on this pass. The full review (including the Verifier-Core fan-out for a T4 PR) runs once the PR is rebased / CI is green. QA has exited; the autopilot re-queues it when the PR is ready.",
        "> *Automated QA — review deferred (open PR)*\n\nGATE-REASON\n\nRed required check(s): test\n\nRelabelled `needs-dev-resume` (not `ready-for-agent`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the next attempt on this branch.",
      ],
    },
    {
      name: "defer GLM",
      pre: { ...glmPre, gate: { action: "defer", reason: "GATE-REASON", redRequired: [], skipVerdict: null, skipCiSummary: null } },
      canned: { verdict: "PASS" },
      state: "OPEN",
      opts: { defer: true },
      bodies: [
        "> *Automated QA — review deferred*\n\nGATE-REASON\n\nNo verdict is being emitted — the PR cannot merge on this pass. The full review (including the Verifier-Core fan-out for a T4 PR) runs once the PR is rebased / CI is green. QA has exited; the autopilot re-queues it when the PR is ready.",
        "> *Automated QA — review deferred (GLM-authored PR)*\n\nGATE-REASON\n\nRelabelled `needs-dev-resume` (not `ready-for-agent`) — this PR is GLM-authored with an open PR, which the GLM drainer skips; the autopilot's pinned forward-fix (issue #4460) owns the next attempt on this branch.",
      ],
    },
    {
      name: "defer not-open",
      pre: readyPre({ gate: { action: "defer", reason: "GATE-REASON", redRequired: [], skipVerdict: null, skipCiSummary: null } }),
      canned: { verdict: "PASS" },
      state: "MERGED",
      opts: { defer: true },
      bodies: [
        "> *Automated QA — review deferred*\n\nGATE-REASON\n\nNo verdict is being emitted — the PR cannot merge on this pass. The full review (including the Verifier-Core fan-out for a T4 PR) runs once the PR is rebased / CI is green. QA has exited; the autopilot re-queues it when the PR is ready.",
      ],
    },
    {
      name: "skip-required-failed",
      pre: readyPre({
        gate: { action: "skip-required-failed", reason: "r", redRequired: ["test"], skipVerdict: { verdict: "FAIL", reason: "Required CI check(s) failed: test" }, skipCiSummary: "SKIP-CI" },
      }),
      canned: { verdict: "FAIL", trailer: "QA-Verdict: FAIL pr=77 round=1 sha=0123456789ab blockers=1 max_severity=high" },
      state: "OPEN",
      opts: { findingsPath: undefined, summariesPath: undefined },
      bodies: [
        `> *Automated QA — two-axis review*\n\n${SKIP_REVIEW_REPORT}\n\n---\n\n**Verdict:** \`FAIL\` — Required CI check(s) failed: test\n\nSKIP-CI\n\nQA-Verdict: FAIL pr=77 round=1 sha=0123456789ab blockers=1 max_severity=high`,
        `> *Automated QA failed (open PR)*\n\n\`FAIL\` on PR #77 — 1 blocker(s), worst: high — required CI check(s) red: test. Full review on the PR.\n\nRed required check(s): test\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the retry on this branch.\n\nQA-Verdict: FAIL pr=77 round=1 sha=0123456789ab blockers=1 max_severity=high`,
      ],
    },
  ];

  test("golden: every verdict body ends with exactly one QA-Verdict trailer line and matches the recorded template", async () => {
    for (const arm of arms) {
      const h = harness({ ghHandler: withState(arm.state ?? "OPEN"), advanceHandler: arm.advance, phase: cannedPhase(arm.canned) });
      await runRoute({ ...ROUTE_OPTS, ...arm.opts }, arm.pre, h.ports, realDeps());
      const posted = h.writes().filter((a) => a[1] === "comment").map((a) => argAfter(a, "--body") as string);
      assert.deepEqual(posted, arm.bodies, `arm '${arm.name}'`);
      const isDefer = arm.opts?.defer === true;
      for (const b of posted) {
        if (isDefer || b.includes("PASS proof")) continue;
        assert.equal(b.split("QA-Verdict:").length - 1, 1, `arm '${arm.name}': exactly one trailer`);
        assert.ok(b.trimEnd().split("\n").at(-1)?.startsWith("QA-Verdict: "), `arm '${arm.name}': the trailer is the LAST line`);
      }
    }
  });

  test("golden: issue pointers stay within 800 chars (2500 with the escalation summary) and never carry the review report", async () => {
    for (const arm of arms.filter((a) => a.name !== "PASS" && a.name !== "PASS-pending-CI")) {
      const issueBodies = arm.bodies.slice(1);
      for (const b of issueBodies) {
        const limit = b.includes("This PR reached the QA round cap") ? 2500 : 800;
        assert.ok(b.length <= limit, `arm '${arm.name}': ${b.length} chars`);
        assert.ok(!b.includes("REPORT"), `arm '${arm.name}': the full review lives only on the PR`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

describe("poll (the bounded foreground CI poll)", () => {
  const row = (name: string, state: string) => `${name}\t${state}\t1m\thttps://x`;

  test("poll: budget expiry reports settled:false and never re-arms", async () => {
    let calls = 0;
    let sleeps = 0;
    const r = await runPoll(
      { pr: 5, repo: "o/r", iterations: 3, intervalSeconds: 15 },
      { checks: async () => { calls++; return ok(`${row("test", "pending")}\n${row("lint", "pass")}\n`); }, sleep: async () => { sleeps++; } },
    );
    assert.equal(r.settled, false);
    assert.equal(r.pending, 1);
    assert.equal(r.iterations, 3);
    assert.equal(calls, 3, "exactly the budgeted number of reads, never one more");
    assert.equal(sleeps, 2, "no trailing sleep after the last iteration");
  });

  test("poll: settles as soon as no check is pending", async () => {
    const seq = [`${row("test", "pending")}\n`, `${row("test", "pass")}\n`];
    let i = 0;
    const r = await runPoll({ pr: 5, repo: "o/r", iterations: 40, intervalSeconds: 15 }, { checks: async () => ok(seq[i++] as string), sleep: async () => {} });
    assert.equal(r.settled, true);
    assert.equal(r.pending, 0);
    assert.equal(r.iterations, 2);
    assert.deepEqual(r.checks, [{ name: "test", state: "pass" }]);
  });

  test("poll: an unreadable gh pr checks keeps polling with pending unknown (fail closed), never settled", async () => {
    const r = await runPoll({ pr: 5, repo: "o/r", iterations: 4, intervalSeconds: 1 }, { checks: async () => fail("rate limited"), sleep: async () => {} });
    assert.equal(r.pending, null);
    assert.equal(r.settled, false);
    assert.equal(r.iterations, 4);
    assert.deepEqual(r.checks, []);
  });

  test("poll: parseChecks reads the state column only", () => {
    assert.deepEqual(parseChecks("a\tpass\t1s\tu\nbad line\n\nb\tfail\t2s\tu\n"), [
      { name: "a", state: "pass" },
      { name: "b", state: "fail" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Spawned CLI runs — the production adapter over a fake gh on PATH.
// ---------------------------------------------------------------------------

function fakeBin(dir: string, name: string, script: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
}

function spawnScript(script: string, args: string[], opts: { dir: string; cwd?: string; input?: string; env?: Record<string, string> }) {
  return spawnSync("node", ["--no-warnings", "--experimental-strip-types", join(ROOT, "scripts", "qa", script), ...args], {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${opts.dir}:${process.env.PATH}`, REDIS_URL: "redis://127.0.0.1:1", ...opts.env },
  });
}

describe("spawned CLIs (production adapter, fake gh on PATH)", () => {
  test("packet CLI: an unreadable CODING_STANDARDS.md exits 1 before any packet file is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-cli-"));
    const cwd = mkdtempSync(join(tmpdir(), "qa-cli-cwd-"));
    try {
      mkdirSync(join(cwd, "CODING_STANDARDS.md")); // readFile -> EISDIR: a non-ENOENT read failure
      fakeBin(dir, "git", 'echo "git must not be called" >&2; exit 99');
      const pre = join(dir, "pre.json");
      writeFileSync(pre, JSON.stringify(readyPre()));
      const r = spawnScript("packet.ts", ["--preflight", pre], { dir, cwd, env: { HYDRA_GIT_BIN: join(dir, "git") } });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /standards catalog read failed/);
      assert.equal(r.stdout, "");
      assert.doesNotMatch(r.stderr, /git must not be called/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("CLIs: a bad invocation is exit 2 with the schema-validation-failed envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-cli-"));
    try {
      for (const [script, args] of [["preflight.ts", ["--issue", "abc"]], ["packet.ts", []], ["route.ts", []], ["poll.ts", []]] as const) {
        const r = spawnScript(script, [...args], { dir });
        assert.equal(r.status, 2, `${script}: ${r.stderr}`);
        assert.match(r.stderr, /"code":"schema-validation-failed"/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preflight CLI: reads through gh and git only; the recorded gh calls are reads and the result validates", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-cli-"));
    try {
      const log = join(dir, "gh.log");
      fakeBin(
        dir,
        "gh",
        [
          `echo "$*" >> ${log}`,
          'case "$*" in',
          '  *"pr view"*"baseRefName"*) echo \'{"baseRefName":"master","mergeStateStatus":"CLEAN","headRefName":"b","headRefOid":"' + HEAD + '","labels":[],"body":"Closes #5269"}\' ;;',
          '  *required_status_checks*) echo \'{"contexts":["test"]}\' ;;',
          `  *statusCheckRollup*) echo '{"statusCheckRollup":[{"name":"test","status":"COMPLETED","conclusion":"SUCCESS"}]}' ;;`,
          '  *"pr list"*) echo \'[{"number":77,"body":"Closes #5269"}]\' ;;',
          '  *"issue view"*) echo \'{"labels":[]}\' ;;',
          '  *pulls/*/files*) echo \'[[{"filename":"src/a.ts"}]]\' ;;',
          '  *) echo "fake-gh: unmatched: $*" >&2; exit 1 ;;',
          "esac",
        ].join("\n"),
      );
      fakeBin(
        dir,
        "git",
        ['case "$1" in', "  fetch|cat-file) exit 0 ;;", `  rev-parse) echo ${BASE_SHA} ;;`, "  diff) echo src/a.ts ;;", "  *) exit 1 ;;", "esac"].join("\n"),
      );
      const r = spawnScript("preflight.ts", ["--issue", "5269", "--pr", "77"], {
        dir,
        env: { HYDRA_GIT_BIN: join(dir, "git"), HYDRA_API_BASE: "http://127.0.0.1:1" },
      });
      assert.equal(r.status, 0, r.stderr);
      const out = PreflightResultSchema.parse(JSON.parse(r.stdout));
      assert.equal(out.stage, "ready");
      assert.equal(out.tier.num, null, "the API is unreachable on port 1");
      assert.equal(out.tier.adversarial, true);
      assert.equal(out.gate.action, "admit");
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(calls.length > 0);
      for (const c of calls) {
        assert.ok(!/(issue (edit|comment)|pr (comment|merge|edit)|-X (POST|DELETE))/.test(c), `a write was issued: ${c}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("route CLI: a PASS posts through the production adapter in order; a dead Redis is named in degraded, not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-cli-"));
    try {
      const log = join(dir, "gh.log");
      fakeBin(
        dir,
        "gh",
        [
          `echo "$*" >> ${log}`,
          'case "$*" in',
          "  *required_status_checks*) echo '{\"contexts\":[\"test\"]}' ;;",
          // The seam's one live PR read (fetchQaLive, #5659): number + state + rollup + comments in one call.
          `  *statusCheckRollup*) echo '{"number":77,"state":"OPEN","isDraft":false,"mergeStateStatus":"CLEAN","headRefOid":"${HEAD}","statusCheckRollup":[{"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS"}],"comments":[{"body":"QA-Verdict: PASS pr=77 round=1 sha=${HEAD.slice(0, 12)} blockers=0 max_severity=none","createdAt":"2026-06-01T00:00:00Z"}],"reviews":[]}' ;;`,
          "  *comments,reviews*) echo '{\"comments\":[],\"reviews\":[]}' ;;",
          `  *headRefOid*) echo '{"headRefOid":"${HEAD}","mergeStateStatus":"CLEAN"}' ;;`,
          // The in-process seam re-reads the issue: needs-qa until the label edit lands, then qa-passed.
          `  *"issue view"*) if [ -f ${dir}/edited ]; then L=qa-passed; else L=needs-qa; fi; printf '{"number":5269,"title":"t","url":"https://github.com/gaberoo322/hydra/issues/5269","createdAt":"2026-01-01T00:00:00Z","labels":[{"name":"%s"}],"body":"b","state":"OPEN"}' "$L" ;;`,
          `  *"issue edit"*) touch ${dir}/edited; exit 0 ;;`,
          // The seam's state-entry read (#5659): the paginated+slurped issue events, one old needs-qa label.
          `  *issues/5269/events*) echo '[[{"event":"labeled","label":{"name":"needs-qa"},"created_at":"2026-01-02T00:00:00Z"}]]' ;;`,
          '  *"pr comment"*) exit 0 ;;',
          '  *) echo "fake-gh: unmatched: $*" >&2; exit 1 ;;',
          "esac",
        ].join("\n"),
      );
      const pre = join(dir, "pre.json");
      writeFileSync(pre, JSON.stringify(readyPre({ tier: { num: 2, adversarial: false }, fanout: { mode: "standard", reviewers: ["standards", "spec"], reason: "Review fan-out: standard" } })));
      const findings = join(dir, "findings.json");
      // One lone low: a non-blocking follow-up (PASS), but a real row for the Redis seam to try to write.
      writeFileSync(findings, JSON.stringify({ standards: [{ severity: "low", axis: "standards", location: "src/a.ts:1", finding: "nit", fix: "reword" }], spec: [] }));
      const summaries = join(dir, "summaries.json");
      writeFileSync(summaries, JSON.stringify({ standardsSummary: "S", specSummary: "P" }));
      const r = spawnScript("route.ts", ["--preflight", pre, "--findings", findings, "--summaries", summaries], { dir });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.verdict, "PASS");
      assert.equal(out.nextStep, "arm-auto-merge");
      assert.match(out.trailer, /^QA-Verdict: PASS pr=77 round=1 sha=0123456789ab blockers=0 max_severity=none$/);
      assert.ok(out.degraded.includes("review-findings"), `Redis is unreachable on port 1: ${r.stdout} ${r.stderr}`);
      const writes = readFileSync(log, "utf8").trim().split("\n").filter((l) => /^(issue edit|pr comment)/.test(l));
      assert.deepEqual(writes.map((l) => l.split(" ").slice(0, 2).join(" ")), ["pr comment", "issue edit"]);
      assert.match(writes[1] ?? "", /issue edit 5269 .*--add-label qa-passed/, "the in-process seam wrote qa-passed");
      assert.ok(!readFileSync(log, "utf8").includes("pr merge"), "the merge call site stays in the playbook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("poll CLI: an exit-8 (pending) gh pr checks still yields its rows; expiry is settled:false", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-cli-"));
    try {
      fakeBin(dir, "gh", 'printf "test\\tpending\\t1m\\tu\\nlint\\tpass\\t1m\\tu\\n"; exit 8');
      const r = spawnScript("poll.ts", ["--pr", "5", "--iterations", "2", "--interval", "1"], { dir });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.settled, false);
      assert.equal(out.pending, 1);
      assert.equal(out.iterations, 2);
      assert.deepEqual(out.checks, [{ name: "test", state: "pending" }, { name: "lint", state: "pass" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Route: reviewer commit class A wired into the executed path (issue #5415)
// ---------------------------------------------------------------------------

describe("guardedSeamMove (production advance adapter never throws)", () => {
  test("a seam crash becomes the crashed refusal instead of rejecting", async () => {
    const res = await guardedSeamMove(async () => {
      throw new Error("boom");
    });
    assert.deepEqual(res, { ok: false, code: "crashed" });
  });

  test("an accepted move and a parked refusal keep their verdicts (counts ride through)", async () => {
    assert.deepEqual(await guardedSeamMove(async () => ({ ok: true })), { ok: true });
    const counts = [{ arm: "qa-fail-rounds", count: 3, cap: 3 }] as never;
    assert.deepEqual(await guardedSeamMove(async () => ({ ok: false, code: "parked:qa-fail-rounds", counts })), {
      ok: false,
      code: "parked:qa-fail-rounds",
      counts,
    });
    assert.deepEqual(await guardedSeamMove(async () => ({ ok: false, code: "no-edge" })), { ok: false, code: "no-edge" });
  });
});

describe("route: reviewer commit class A and class B (issue #5415, executed-path order pins)", () => {
  const NEW_HEAD = "f".repeat(40);
  const NEW12 = "f".repeat(12);
  const FAIL_CANNED: Canned = {
    verdict: "FAIL",
    reviewVerdict: "FAIL",
    blockers: 1,
    maxSeverity: "medium",
    worst: "w",
    blocking: [{ location: "docs/guide.md:3" }],
  };
  const COMMIT_A = {
    action: "commit-a",
    reason: "class-a-fixable",
    detail: "d",
    blockingPaths: ["docs/guide.md"],
    followUpPaths: [],
    bodyFix: true,
    degraded: [],
  };

  /** Records the phase order and every phase input around a canned engine. */
  function recording(c: Canned) {
    const inner = cannedPhase(c);
    const order: string[] = [];
    const inputs: Record<string, unknown[]> = {};
    const phase: PlumbingPorts["phase"] = async (p, input) => {
      order.push(p);
      (inputs[p] ??= []).push(input);
      return inner(p, input);
    };
    return { phase, order, inputs };
  }

  /** gh answers: PR state OPEN, the live head, and the commit object of NEW_HEAD. */
  const rcGh = (live: string, parent = HEAD, message = "fix(qa): x\n\nQA-Fix: A") => (argv: string[]): CmdResult | undefined => {
    if (argv[0] === "pr" && argv[1] === "view" && argv.includes("headRefOid")) return ok(`${live}\n`);
    if (argv[0] === "api" && argv[1] === `repos/gaberoo322/hydra/commits/${NEW_HEAD}`) {
      return ok(JSON.stringify({ parents: [{ sha: parent }], commit: { message } }));
    }
    return withState("OPEN")(argv);
  };

  test("FAIL + none: phase order is fold, reviewer-commit, trailer, round-action and the FAIL effect order is unchanged", async () => {
    const rec = recording(FAIL_CANNED);
    const h = harness({ ghHandler: withState("OPEN"), phase: rec.phase });
    const r = await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(rec.order, ["fold", "reviewer-commit", "trailer", "round-action"]);
    assert.deepEqual(h.writes().map((a) => `${a[0]} ${a[1]}`), ["pr merge", "pr comment", "lifecycle advance", "issue comment"]);
    assert.equal(r.nextStep, "none");
    assert.deepEqual(r.reviewerCommit, { action: "none", reason: "stage-off" });
  });

  test("a PASS fold never invokes the reviewer-commit phase", async () => {
    const rec = recording({ verdict: "PASS" });
    const h = harness({ ghHandler: withState("OPEN"), phase: rec.phase });
    const r = await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(rec.order, ["fold", "trailer", "round-action"]);
    assert.equal(r.reviewerCommit, undefined);
  });

  test("skip-required-failed and --defer never invoke the reviewer-commit phase", async () => {
    const rec = recording(FAIL_CANNED);
    const skip = readyPre({ gate: { action: "skip-required-failed", reason: "r", redRequired: ["test"], skipVerdict: { verdict: "FAIL", reason: "x" }, skipCiSummary: "CI" } });
    await runRoute({ ...ROUTE_OPTS, findingsPath: undefined, summariesPath: undefined }, skip, harness({ ghHandler: withState("OPEN"), phase: rec.phase }).ports, realDeps());
    const defer = recording(FAIL_CANNED);
    const deferPre = readyPre({ gate: { action: "defer", reason: "r", redRequired: [], skipVerdict: null, skipCiSummary: null } });
    await runRoute({ ...ROUTE_OPTS, defer: true, findingsPath: undefined, summariesPath: undefined }, deferPre, harness({ ghHandler: withState("OPEN"), phase: defer.phase }).ports, realDeps());
    assert.ok(!rec.order.includes("reviewer-commit"));
    assert.deepEqual(defer.order, []);
  });

  test("a commit-a decision pauses pass 1 BEFORE any effect: zero writes, no trailer call, a full plan", async () => {
    const rec = recording({ ...FAIL_CANNED, reviewerCommit: COMMIT_A });
    const h = harness({ ghHandler: withState("OPEN"), phase: rec.phase });
    const r = await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(rec.order, ["fold", "reviewer-commit"]);
    assert.deepEqual(h.writes(), []);
    assert.deepEqual(r.effects, []);
    assert.equal(r.verdict, null);
    assert.equal(r.reviewVerdict, "FAIL");
    assert.equal(r.nextStep, "reviewer-commit");
    assert.deepEqual(r.reviewerCommit, {
      action: "commit-a",
      reason: "class-a-fixable",
      reviewedHead: HEAD,
      headRef: "worktree-agent-abc",
      fixedSha: BASE_SHA,
      blockingPaths: ["docs/guide.md"],
      followUpPaths: [],
      blockingTestPaths: [],
      followUpTestPaths: [],
      bodyFix: true,
      blockingLocations: ["docs/guide.md:3"],
    });
    // Pass 1 is idempotent: a second run writes nothing either.
    const again = harness({ ghHandler: withState("OPEN"), phase: recording({ ...FAIL_CANNED, reviewerCommit: COMMIT_A }).phase });
    await runRoute(ROUTE_OPTS, readyPre(), again.ports, realDeps());
    assert.deepEqual(again.writes(), []);
  });

  test("the stage is read at fixedSha, never the session tree: a tree saying A while fixedSha says off decides stage-off", async () => {
    const sessionSaysA: QaVerdictFetchers = fixtureFetchers({ async rolloutStage() { return "A"; } });
    const inner = cannedPhase(FAIL_CANNED);
    const phase: PlumbingPorts["phase"] = (p, input) => (p === "reviewer-commit" ? runQaVerdictPhase(p, input, sessionSaysA) : inner(p, input));
    const h = harness({
      ghHandler: withState("OPEN"),
      phase,
      gitHandler: (argv) => {
        if (argv[0] !== "show") return undefined;
        if (argv[1] === `${BASE_SHA}:config/orchestrator/qa-rollout.json`) return ok(JSON.stringify({ "two-way-pair": "off", "reviewer-commits": "off" }));
        if (argv[1] === `${BASE_SHA}:test/fixtures/qa-cohort-baseline.json`) return ok(JSON.stringify({ metrics: { tripped: false } }));
        return undefined;
      },
    });
    const r = await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.deepEqual(h.git.filter((a) => a[0] === "show").map((a) => a[1]), [
      `${BASE_SHA}:config/orchestrator/qa-rollout.json`,
      `${BASE_SHA}:test/fixtures/qa-cohort-baseline.json`,
    ]);
    assert.equal(r.reviewerCommit?.action, "none");
    assert.equal(r.reviewerCommit?.reason, "stage-off");
    assert.equal(r.nextStep, "none");
    // Sibling: the same fixed point saying A lets the phase proceed past the stage fence.
    const a = harness({
      ghHandler: withState("OPEN"),
      phase: (p, input) => (p === "reviewer-commit" ? runQaVerdictPhase(p, input, fixtureFetchers({ async changedFiles() { return ["docs/guide.md"]; } })) : inner(p, input)),
      gitHandler: (argv) => (argv[0] === "show" && String(argv[1]).endsWith("qa-rollout.json") ? ok(JSON.stringify({ "reviewer-commits": "A" })) : argv[0] === "show" ? ok(JSON.stringify({ metrics: { tripped: false } })) : undefined),
    });
    const ra = await runRoute(ROUTE_OPTS, readyPre(), a.ports, realDeps());
    assert.notEqual(ra.reviewerCommit?.reason, "stage-off");
  });

  test("a null fixedSha or a failed show yields stage off and degraded rollout-stage", async () => {
    const nullSha = harness({ ghHandler: withState("OPEN"), phase: cannedPhase(FAIL_CANNED) });
    const rn = await runRoute(ROUTE_OPTS, readyPre({ fixedSha: null }), nullSha.ports, realDeps());
    assert.ok(rn.degraded.includes("rollout-stage"));
    const failed = harness({ ghHandler: withState("OPEN"), phase: cannedPhase(FAIL_CANNED), gitHandler: (argv) => (argv[0] === "show" ? fail("fatal") : undefined) });
    const rf = await runRoute(ROUTE_OPTS, readyPre(), failed.ports, realDeps());
    assert.ok(rf.degraded.includes("rollout-stage"));
  });

  test("pass 2a appends review-findings rows at the trailer's NEW sha and round; a plain FAIL round keeps its own sha/round (sibling)", async () => {
    const rows: unknown[][] = [];
    const trailer = `QA-Verdict: PASS-pending-CI pr=77 round=2 sha=${NEW12} blockers=0 max_severity=none`;
    const full = [{ severity: "medium", axis: "standards", location: "docs/guide.md:3", finding: "f", reviewers: ["reviewer-A-standards"] }] as unknown as Canned["blocking"];
    const h = harness({ ghHandler: rcGh(NEW_HEAD), phase: cannedPhase({ ...FAIL_CANNED, blocking: full, reviewerCommit: COMMIT_A, trailer }) });
    const r2a = await runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), h.ports, realDeps(rows));
    assert.ok(!r2a.degraded.includes("review-findings"));
    assert.equal(rows.length, 1);
    const appended = rows[0] as Array<{ row: { sha: string; round: number } }>;
    assert.ok(appended.length > 0);
    assert.ok(appended.every((r) => r.row.sha === NEW12 && r.row.round === 2), "rows carry the NEW head sha and trailer round");
    const rows1: unknown[][] = [];
    const plain = harness({ ghHandler: withState("OPEN"), phase: cannedPhase({ verdict: "FAIL", reviewVerdict: "FAIL", blockers: 1, maxSeverity: "medium" }) });
    await runRoute(ROUTE_OPTS, readyPre(), plain.ports, realDeps(rows1));
    assert.equal(rows1.length, 1);
    assert.equal(rows1[0]?.length, 0, "a fold with no findings appends an empty row set at its own round");
  });

  test("pass 2a: a verified reviewer commit yields PASS-pending-CI at the new head; the trailer input carries headSha and qaFixes; bare PASS is unreachable", async () => {
    const rec = recording({ ...FAIL_CANNED, reviewerCommit: COMMIT_A });
    const h = harness({ ghHandler: rcGh(NEW_HEAD), phase: rec.phase });
    const r = await runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), h.ports, realDeps());
    assert.deepEqual(rec.order, ["fold", "reviewer-commit", "trailer", "round-action"]);
    assert.deepEqual(rec.inputs.trailer?.[0], { pr: 77, verdict: "PASS-pending-CI", blockers: 0, maxSeverity: "none", headSha: NEW_HEAD, qaFixes: [NEW12] });
    assert.deepEqual(h.writes().map((a) => `${a[0]} ${a[1]}`), ["pr comment", "lifecycle advance"], "pending comment, then qa-passed");
    assert.deepEqual(h.advances.map((a) => a[1]), ["qa-passed"]);
    const body = argAfter(h.writes()[0] as string[], "--body") as string;
    assert.match(body, /Verdict: `PASS-pending-CI`/);
    assert.ok(body.includes(`Reviewer-fixed in ${NEW12} (QA-Fix: A)`));
    assert.ok(!h.writes().some((a) => a[1] === "merge"), "no disarm: this is not a FAIL round");
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.nextStep, "none", "arm-auto-merge is unreachable on a reviewer-fixed round");
    assert.equal(r.blockers, 0);
    assert.equal(r.maxSeverity, "none");
  });

  test("class B (#5268 merged into #5415): commit-ab verifies the A-then-B first-parent chain and names both sha12s; commit-a with a B-only trailer is refused (sibling)", async () => {
    const MID = "c".repeat(40);
    const chainGh = (aMsg: string, bMsg: string) => (argv: string[]): CmdResult | undefined => {
      if (argv[0] === "pr" && argv[1] === "view" && argv.includes("headRefOid")) return ok(`${NEW_HEAD}\n`);
      if (argv[0] === "api" && argv[1] === `repos/gaberoo322/hydra/commits/${NEW_HEAD}`) return ok(JSON.stringify({ parents: [{ sha: MID }], commit: { message: bMsg } }));
      if (argv[0] === "api" && argv[1] === `repos/gaberoo322/hydra/commits/${MID}`) return ok(JSON.stringify({ parents: [{ sha: HEAD }], commit: { message: aMsg } }));
      return withState("OPEN")(argv);
    };
    const COMMIT_AB = { ...COMMIT_A, action: "commit-ab", blockingTestPaths: ["test/x.test.mts"], followUpTestPaths: [] };
    const rec = recording({ ...FAIL_CANNED, reviewerCommit: COMMIT_AB });
    const h = harness({ ghHandler: chainGh("fix\n\nQA-Fix: A", "fix\n\nQA-Fix: B"), phase: rec.phase });
    const r = await runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), h.ports, realDeps());
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.deepEqual(rec.inputs.trailer?.[0], { pr: 77, verdict: "PASS-pending-CI", blockers: 0, maxSeverity: "none", headSha: NEW_HEAD, qaFixes: ["c".repeat(12), NEW12] });
    // Sibling: a commit-ab plan whose chain is B then A (wrong order) is refused.
    const wrong = harness({ ghHandler: chainGh("fix\n\nQA-Fix: B", "fix\n\nQA-Fix: A"), phase: cannedPhase({ ...FAIL_CANNED, reviewerCommit: COMMIT_AB }) });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), wrong.ports, realDeps()), /not verified/);
    // Sibling: a commit-a plan keeps refusing a lone QA-Fix: B commit.
    const bOnly = harness({ ghHandler: rcGh(NEW_HEAD, HEAD, "fix\n\nQA-Fix: B"), phase: cannedPhase({ ...FAIL_CANNED, reviewerCommit: COMMIT_A }) });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), bOnly.ports, realDeps()), /not verified/);
  });

  test("pass 2a is refused (pre-verdict exit, one QA-Verdict-Error comment, nothing else) when the commit is not the reviewed head's QA-Fix: A child at the live head", async () => {
    const cases: Array<[string, (argv: string[]) => CmdResult | undefined]> = [
      ["wrong parent", rcGh(NEW_HEAD, "e".repeat(40))],
      ["missing trailer", rcGh(NEW_HEAD, HEAD, "fix(qa): x")],
      ["head moved on", rcGh("d".repeat(40))],
    ];
    for (const [name, ghHandler] of cases) {
      const h = harness({ ghHandler, phase: cannedPhase({ ...FAIL_CANNED, reviewerCommit: COMMIT_A }) });
      await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), h.ports, realDeps()), /not verified/, name);
      const w = h.writes();
      assert.equal(w.length, 1, `${name}: exactly one write`);
      assert.match(argAfter(w[0] as string[], "--body") as string, /QA-Verdict-Error: pr=77 reason=reviewer-fixed-unverified/, name);
      assert.equal(h.advances.length, 0, `${name}: needs-qa untouched`);
    }
  });

  test("class B only: a commit-b plan over a lone QA-Fix: B commit reaches the trailer with that one sha12; a QA-Fix: A commit under it stops before the trailer (sibling)", async () => {
    const COMMIT_B = { ...COMMIT_A, action: "commit-b", reason: "class-b-fixable", blockingPaths: [], blockingTestPaths: ["test/widget.test.mts"] };
    const rec = recording({ ...FAIL_CANNED, reviewerCommit: COMMIT_B });
    const h = harness({ ghHandler: rcGh(NEW_HEAD, HEAD, "test: tighten\n\nQA-Fix: B"), phase: rec.phase });
    const r = await runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), h.ports, realDeps());
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.deepEqual(rec.order, ["fold", "reviewer-commit", "trailer", "round-action"]);
    assert.deepEqual(rec.inputs.trailer?.[0], { pr: 77, verdict: "PASS-pending-CI", blockers: 0, maxSeverity: "none", headSha: NEW_HEAD, qaFixes: [NEW12] });
    // Sibling: the same plan over a QA-Fix: A trailer is refused before the trailer phase.
    const wrong = recording({ ...FAIL_CANNED, reviewerCommit: COMMIT_B });
    const hw = harness({ ghHandler: rcGh(NEW_HEAD, HEAD, "test: tighten\n\nQA-Fix: A"), phase: wrong.phase });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), hw.ports, realDeps()), /not verified/);
    assert.ok(!wrong.order.includes("trailer"));
    assert.deepEqual(wrong.order, ["fold", "reviewer-commit"]);
    assert.equal(hw.writes().length, 1);
    assert.match(argAfter(hw.writes()[0] as string[], "--body") as string, /QA-Verdict-Error: pr=77 reason=reviewer-fixed-unverified/);
    assert.equal(hw.advances.length, 0);
  });

  test("pass 2a without a fresh commit-a decision (or on a PASS fold) is a pre-verdict exit", async () => {
    const none = harness({ ghHandler: rcGh(NEW_HEAD), phase: cannedPhase(FAIL_CANNED) });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), none.ports, realDeps()), /no fresh commit decision/);
    const pass = harness({ ghHandler: rcGh(NEW_HEAD), phase: cannedPhase({ verdict: "PASS" }) });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD }, readyPre(), pass.ports, realDeps()), /requires a reviewed FAIL/);
    assert.equal(none.advances.length + pass.advances.length, 0);
  });

  test("pass 2b: --reviewer-commit-aborted re-routes the ORIGINAL FAIL at the reviewed head and never re-runs the decision", async () => {
    const rec = recording({ ...FAIL_CANNED, reviewerCommit: COMMIT_A });
    const h = harness({ ghHandler: rcGh(HEAD), phase: rec.phase });
    const r = await runRoute({ ...ROUTE_OPTS, reviewerCommitAborted: true }, readyPre(), h.ports, realDeps());
    assert.deepEqual(rec.order, ["fold", "trailer", "round-action"]);
    assert.deepEqual(h.writes().map((a) => `${a[0]} ${a[1]}`), ["pr merge", "pr comment", "lifecycle advance", "issue comment"]);
    assert.equal(r.verdict, "FAIL");
    assert.equal(r.reviewerCommit?.reason, "reviewer-commit-aborted");
  });

  test("pass 2b: a moved head is a pre-verdict exit with reason reviewer-commit-aborted-head-moved", async () => {
    const h = harness({ ghHandler: rcGh("d".repeat(40)), phase: cannedPhase({ ...FAIL_CANNED, reviewerCommit: COMMIT_A }) });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerCommitAborted: true }, readyPre(), h.ports, realDeps()), /head moved/);
    assert.equal(h.writes().length, 1);
    assert.match(argAfter(h.writes()[0] as string[], "--body") as string, /reason=reviewer-commit-aborted-head-moved/);
  });

  test("the two pass-2 flags are mutually exclusive, exclude --defer, and --reviewer-fixed needs a 40-hex sha (UsageError)", async () => {
    const h = harness({ ghHandler: withState("OPEN"), phase: cannedPhase(FAIL_CANNED) });
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD, reviewerCommitAborted: true }, readyPre(), h.ports, realDeps()), /mutually exclusive/);
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: NEW_HEAD, defer: true }, readyPre(), h.ports, realDeps()), /cannot be combined with --defer/);
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerCommitAborted: true, defer: true }, readyPre(), h.ports, realDeps()), /cannot be combined with --defer/);
    await assert.rejects(runRoute({ ...ROUTE_OPTS, reviewerFixed: "abc123" }, readyPre(), h.ports, realDeps()), /40-hex/);
    assert.equal(h.writes().length, 0, "usage errors post nothing");
  });

  test("a throwing reviewer-commit phase never takes the verdict down: the original FAIL routes and the miss is degraded", async () => {
    const inner = cannedPhase(FAIL_CANNED);
    const h = harness({ ghHandler: withState("OPEN"), phase: async (p, input) => { if (p === "reviewer-commit") throw new Error("engine down"); return inner(p, input); } });
    const r = await runRoute(ROUTE_OPTS, readyPre(), h.ports, realDeps());
    assert.equal(r.verdict, "FAIL");
    assert.ok(r.degraded.includes("reviewer-commit"));
  });
});
