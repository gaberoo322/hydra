/**
 * Turn Snapshot — the Target-board family collectors (ADR-0043 slice 4, #4932).
 *
 * Two suites, both at the TS interface with NO `gh` / `hydra` on PATH:
 *
 * 1. GOLDEN (ADR-0043 Decision 4): every file under
 *    test/fixtures/turn-snapshot/target-board/ was captured by running the
 *    OLD bash collectors (`collect_target_board`, `collect_target_scan_boards`,
 *    `collect_target_risk_surface`, at the slice's base SHA) over each fixture
 *    the pre-slice tests used — read-failure fixtures included — with a fake
 *    `gh` + `hydra` on PATH. Each replays through the real CLI `main`, the
 *    production `TurnSnapshotGithub` port over a recording transport and the
 *    production HTTP adapter over a fake `fetch`: stdout byte for byte, the
 *    `target…` stderr-note set, the exported lane flag, and the same `gh`
 *    calls in the same order.
 *
 * 2. PORTED behavioural cases from test/autopilot-target-board-signals.test.mts,
 *    test/collect-state-inflight-exclusion.test.mts (#4474 / #4653),
 *    test/autopilot-decide-dev-target-resume.test.mts (the collect-state half)
 *    and test/collect-state-target-risk-surface-pipefail.test.mts — same
 *    fixtures and assertions, now calling the typed collectors / pure
 *    classifiers instead of regex-extracting python heredocs.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { main, parseArgs, productionTargetDeps } from "../scripts/autopilot/turn-snapshot.ts";
import { createTurnSnapshotGithub, type GhJsonRead, type GhTransport, type TurnSnapshotGithub } from "../src/autopilot/turn-snapshot/github-port.ts";
import { createTurnSnapshotHttp, type TurnSnapshotHttp } from "../src/autopilot/turn-snapshot/hydra-http.ts";
import { pickDevResume } from "../src/autopilot/turn-snapshot/dev-resume.ts";
import type { PrRefsAvailability } from "../src/autopilot/turn-snapshot/pr-gate.ts";
import { renderTargetBoardKv, renderTargetRiskSurfaceKv, renderTargetScanKv } from "../src/autopilot/turn-snapshot/render-kv.ts";
import {
  adjustedReadyForAgent,
  collectTargetBoard,
  fallbackTally,
  healthyCounts,
  projectPrRefs,
  TARGET_BOARD_STATE_PATH,
  TARGET_WIP_LIMIT,
} from "../src/autopilot/turn-snapshot/target-board.ts";
import {
  classifyTargetScan,
  collectTargetScanBoards,
  DESIGN_QA_ADR_GLOB,
  designLanguageAdrPresent,
} from "../src/autopilot/turn-snapshot/target-scan-boards.ts";
import { collectTargetRiskSurface } from "../src/autopilot/turn-snapshot/target-risk-surface.ts";
import { referencedIssues } from "../src/github/pr-refs.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GOLDEN_DIR = join(REPO_ROOT, "test", "fixtures", "turn-snapshot", "target-board");

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
  collector: "target-board" | "target-scan-boards" | "target-risk-surface";
  repo: string;
  limit: number;
  prRefsUnavailable?: string | null;
  laneDegraded?: string;
  workQueue?: number;
  adr?: "present" | "absent" | "founding-only" | "missing";
  http?: Record<string, { body: string; status?: number }>;
  gh?: Record<string, GoldenRead>;
  facts?: unknown;
  expected: {
    stdout: string;
    stderrNotes: string[];
    exports?: Record<string, string>;
    ghCalls?: string[][];
    httpCalls?: string[][];
  };
}

/** Route an argv to the golden read the fake `gh` served for it (fake-gh.py's routing). */
function goldenKey(args: string[]): string | null {
  const joined = args.join(" ");
  if (args[0] === "issue" && args[1] === "list") return args.includes("--jq") ? "scanIssues" : "issuesFallback";
  if (args[0] === "api") {
    if (joined.includes("/pulls?")) return "pulls";
    const labels: [string, string][] = [
      ["ready-for-agent", "rfa"],
      ["in-progress", "inProgress"],
      ["needs-qa", "needsQa"],
      ["needs-dev-resume", "needsDevResume"],
    ];
    for (const [label, key] of labels) if (joined.includes(`labels=${label}&`)) return key;
  }
  return null;
}

/** A `fetch` serving the golden board-state reads with bin/hydra's status/HTML semantics. */
function goldenFetch(g: Golden, calls: string[][]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const path = String(url).replace(/^http:\/\/golden\.invalid\/api/, "");
    calls.push(["raw", "GET", path]);
    const r = g.http?.[path];
    if (r === undefined) return new Response("not found", { status: 404 });
    return new Response(r.body + "\n", { status: r.status ?? 200 });
  }) as typeof fetch;
}

const unusedOrchGithub = new Proxy({} as TurnSnapshotGithub, {
  get: () => () => Promise.reject(new Error("the orchestrator port must not be read by a Target collector")),
});

function makeWorkspace(adr: Golden["adr"]): string {
  if (adr === "missing") return "";
  const ws = mkdtempSync(join(tmpdir(), "ts-target-ws-"));
  if (adr === "present" || adr === "founding-only") {
    mkdirSync(join(ws, "docs", "adr"), { recursive: true });
    writeFileSync(join(ws, "docs", "adr", "0001-founding-scaffold.md"), "# founding\n");
    if (adr === "present") writeFileSync(join(ws, "docs", "adr", "0005-design-language.md"), "# design\n");
  }
  return ws;
}

const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();

describe("Turn Snapshot Target board family — golden files from the bash collectors (ADR-0043 D4)", () => {
  test("the golden corpus is present (guards a vacuous pass)", () => {
    assert.ok(goldenFiles.length >= 100, `expected the captured corpus, found ${goldenFiles.length} files`);
  });

  for (const file of goldenFiles) {
    const g = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8")) as Golden;
    test(`golden: ${g.name}`, async () => {
      const ghCalls: string[][] = [];
      const httpCalls: string[][] = [];
      const transport: GhTransport = async (args) => {
        ghCalls.push([...args]);
        const key = goldenKey(args);
        const r = key === null ? undefined : g.gh?.[key];
        if (r === undefined) return { ok: false, stderr: `unscripted call: ${args.join(" ")}` };
        return r.exitCode === 0 ? { ok: true, stdout: r.stdout, stderr: r.stderr } : { ok: false, stderr: r.stderr };
      };
      const workspace = g.collector === "target-scan-boards" ? makeWorkspace(g.adr) : "";
      const argv = ["--collectors", g.collector, "--format", "kv", "--gh-list-limit", String(g.limit ?? 100)];
      if (g.collector === "target-board") argv.push("--exports-file", "exports");
      if (g.collector === "target-scan-boards") {
        argv.push("--target-lane-degraded", g.laneDegraded ?? "0", "--target-work-queue", String(g.workQueue ?? 0));
      }
      let stdout = "";
      let stderr = "";
      let exportsText = "";
      try {
        const code = await main(
          argv,
          {
            github: unusedOrchGithub,
            now: () => 0,
            sleep: async () => {},
            target: () => ({
              github: createTurnSnapshotGithub({ transport, repo: g.repo ?? "acme/target-app" }),
              http: createTurnSnapshotHttp({ baseUrl: "http://golden.invalid", fetchImpl: goldenFetch(g, httpCalls) }),
              workspace: () => workspace,
              facts: () => g.facts,
              ...(g.prRefsUnavailable ? { prRefs: { ok: false, error: g.prRefsUnavailable } as PrRefsAvailability } : {}),
            }),
          },
          {
            stdout: (t) => (stdout += t),
            stderr: (t) => (stderr += t),
            writeFile: (_p, t) => (exportsText = t),
          },
        );
        assert.equal(code, 0);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
      assert.equal(stdout, g.expected.stdout, "stdout must match the bash byte for byte");
      const notes = stderr.split("\n").filter((l) => l.startsWith("target"));
      assert.deepEqual([...notes].sort(), [...g.expected.stderrNotes].sort(), "the stderr-note set must match");
      if (g.collector === "target-board") {
        assert.equal(exportsText, `TARGET_LANE_DEGRADED=${g.expected.exports?.TARGET_LANE_DEGRADED}\n`, "the lane flag must match");
        assert.deepEqual(httpCalls, g.expected.httpCalls, "the same board-state read");
      }
      if (g.expected.ghCalls !== undefined) assert.deepEqual(ghCalls, g.expected.ghCalls, "the same gh calls, in the same order");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Ported behavioural cases — shared fakes
// ---------------------------------------------------------------------------

const ok = (data: unknown): GhJsonRead => ({ kind: "ok", data });
const EMPTY: GhJsonRead = { kind: "empty" };

interface TargetFake {
  board?: unknown;
  issuesFallback?: GhJsonRead;
  pulls?: GhJsonRead;
  rfa?: GhJsonRead;
  inProgress?: GhJsonRead;
  needsQa?: GhJsonRead;
  needsDevResume?: GhJsonRead;
  scanIssues?: GhJsonRead;
}

/** A fake Target port + HTTP adapter returning typed fixtures and recording reads. */
function fakeTarget(o: TargetFake) {
  const calls: string[] = [];
  const github = {
    async listOpenIssueLabels() {
      calls.push("issuesFallback");
      return o.issuesFallback ?? EMPTY;
    },
    async listOpenIssueLabelNames() {
      calls.push("scanIssues");
      return o.scanIssues ?? EMPTY;
    },
    async listOpenPullsRest() {
      calls.push("pulls");
      return o.pulls ?? ok([]);
    },
    async listOpenIssuesByLabelRest(label: string) {
      calls.push(label);
      const byLabel: Record<string, GhJsonRead | undefined> = {
        "ready-for-agent": o.rfa,
        "in-progress": o.inProgress,
        "needs-qa": o.needsQa,
        "needs-dev-resume": o.needsDevResume,
      };
      return byLabel[label] ?? ok([]);
    },
  };
  const http: TurnSnapshotHttp = {
    async get(path) {
      calls.push(`GET ${path}`);
      return o.board === undefined ? "" : JSON.stringify(o.board);
    },
  };
  return { github, http, calls };
}

const pr = (number: number, ref: string, body: string | null, extra: Record<string, unknown> = {}) => ({
  number,
  draft: false,
  head: { ref },
  body,
  html_url: `https://example/pull/${number}`,
  ...extra,
});
const issues = (...nums: number[]) => nums.map((number) => ({ number }));

/** Run the target-board collector; returns the kv lines parsed plus the raw outcome. */
async function runBoard(o: TargetFake, prRefs?: PrRefsAvailability) {
  const fake = fakeTarget(o);
  const outcome = await collectTargetBoard({ github: fake.github, http: fake.http, ghListLimit: 100, prRefs });
  const stdout = renderTargetBoardKv(outcome.value);
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { out, stdout, notes: outcome.notes, value: outcome.value, calls: fake.calls };
}

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const countsOf = (d: Record<string, unknown>) => Object.fromEntries(healthyCounts(d));

// ---------------------------------------------------------------------------
// #3435 / #3709 — Target board-state emission + seam wiring
// ---------------------------------------------------------------------------

describe("target-board — board-state emission (issue #3435, ADR-0031)", () => {
  test("emits the four target_-prefixed counts decide.py's Target branch reads", () => {
    const out = countsOf({
      ready_for_agent: 3,
      needs_qa: 2,
      needs_triage: 5,
      needs_research: 1,
      in_progress: 4,
      blocked: 7,
      stale_in_progress: [10, 11],
      stale_blocked: [12],
    });
    assert.equal(out.target_ready_for_agent, "3");
    assert.equal(out.target_needs_qa, "2");
    assert.equal(out.target_needs_research, "1");
    assert.equal(out.target_needs_triage, "5", "issue #3709: without this count sweep_target is a dead arm");
    assert.equal(out.ready_for_agent, undefined);
    assert.equal(out.needs_qa, undefined);
    assert.equal(out.needs_triage, undefined);
  });

  test("a triage-only board still emits target_needs_triage (the sweep_target trigger)", () => {
    const out = countsOf({ ready_for_agent: 0, needs_qa: 0, needs_triage: 9, needs_research: 0 });
    assert.equal(out.target_needs_triage, "9");
    assert.equal(out.target_ready_for_agent, "0");
  });

  test("an empty target board emits zero ready_for_agent (drives research, not dev)", () => {
    assert.equal(countsOf({ ready_for_agent: 0, needs_qa: 0, needs_research: 0 }).target_ready_for_agent, "0");
  });

  test("missing count fields default to 0 (never a crash / never a bare key)", () => {
    const out = countsOf({ ready_for_agent: 5 });
    assert.equal(out.target_ready_for_agent, "5");
    assert.equal(out.target_needs_qa, "0");
    assert.equal(out.target_needs_triage, "0");
    assert.equal(out.target_needs_research, "0");
  });

  test("reads the scope=target board-state endpoint (ADR-0031 Decision 3 one-seam reuse)", async () => {
    const r = await runBoard({ board: { ready_for_agent: 0 } });
    assert.equal(r.calls[0], `GET ${TARGET_BOARD_STATE_PATH}`);
    assert.equal(TARGET_BOARD_STATE_PATH, "/autopilot/board-state?scope=target");
  });

  test("the fallback reads the Target repo through gh, never GraphQL-by-hand (ADR-0031 Decision 6)", async () => {
    const calls: string[][] = [];
    const port = createTurnSnapshotGithub({
      repo: "acme/target-app",
      transport: async (args) => {
        calls.push(args);
        return { ok: true, stdout: "[]", stderr: "" };
      },
    });
    await collectTargetBoard({ github: port, http: { get: async () => "" }, ghListLimit: 100 });
    assert.deepEqual(calls[0], ["issue", "list", "--repo", "acme/target-app", "--state", "open", "--limit", "100", "--json", "number,labels"]);
    for (const c of calls) assert.ok(!c.join(" ").includes("graphql"), "the Target board reads never reach for gh api graphql");
  });

  test("resolves the Target repo from HYDRA_TARGET_GITHUB_REPO through the target seam (no literal)", async () => {
    const prev = process.env.HYDRA_TARGET_GITHUB_REPO;
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/seam-resolved";
    try {
      const calls: string[][] = [];
      const deps = productionTargetDeps({
        transport: async (args) => {
          calls.push(args);
          return { ok: true, stdout: "[]", stderr: "" };
        },
      });
      await deps.github.listOpenPullsRest(100);
      assert.deepEqual(calls[0], ["api", "repos/acme/seam-resolved/pulls?state=open&per_page=100"]);
    } finally {
      if (prev === undefined) delete process.env.HYDRA_TARGET_GITHUB_REPO;
      else process.env.HYDRA_TARGET_GITHUB_REPO = prev;
    }
  });
});

describe("target-board — gh fallback tally (issue #3709)", () => {
  const tally = (labelSets: string[][]) => {
    const t = fallbackTally(ok(labelSets.map((labels, i) => ({ number: i + 1, labels: labels.map((name) => ({ name })) }))));
    assert.ok(t !== null);
    return Object.fromEntries(t.counts);
  };

  test("counts open needs-triage issues", () => {
    assert.equal(tally([["needs-triage"], ["needs-triage", "enhancement"], ["ready-for-agent"], []]).target_needs_triage, "2");
  });

  test("does NOT exclude blocked items — triage is how a blocked lane gets re-examined", () => {
    assert.equal(
      tally([["needs-triage"], ["needs-triage", "blocked"], ["needs-triage", "target-backlog"]]).target_needs_triage,
      "3",
      "every open needs-triage issue counts, blocked ones included",
    );
  });

  test("no needs-triage labels → 0 (never a phantom sweep_target dispatch)", () => {
    assert.equal(tally([["ready-for-agent"], ["needs-qa"]]).target_needs_triage, "0");
  });

  test("total failure of the fallback emits zeros for all five counts and latches the lane flag (#4130)", async () => {
    const r = await runBoard({ issuesFallback: EMPTY });
    assert.equal(r.value.laneDegraded, true);
    for (const k of ["target_ready_for_agent", "target_ready_blocker_excluded", "target_needs_qa", "target_needs_triage", "target_needs_research"]) {
      assert.equal(r.out[k], "0", k);
    }
  });

  test("the fallback read carries the shared limit (never gh's silent 30 default)", async () => {
    const calls: string[][] = [];
    const port = createTurnSnapshotGithub({
      repo: "acme/target-app",
      transport: async (args) => {
        calls.push(args);
        return { ok: true, stdout: "[]", stderr: "" };
      },
    });
    await collectTargetBoard({ github: port, http: { get: async () => "" }, ghListLimit: 37 });
    for (const c of calls) {
      const joined = c.join(" ");
      assert.ok(joined.includes("--limit 37") || joined.includes("per_page=37"), `every Target read pages via the shared limit: ${joined}`);
      assert.ok(!joined.includes("--paginate"));
    }
  });
});

// ---------------------------------------------------------------------------
// #4823 — blocker-excluded advisory count + starvation note
// ---------------------------------------------------------------------------

describe("target-board — blocker-excluded advisory count (issue #4823)", () => {
  test("the healthy emitter surfaces the length of the endpoint's blocker_excluded list", () => {
    const out = countsOf({ ready_for_agent: 2, blocker_excluded: [11, 12, 13], needs_qa: 0, needs_triage: 0, needs_research: 0 });
    assert.equal(out.target_ready_blocker_excluded, "3");
    assert.equal(out.target_ready_for_agent, "2");
  });

  test("a board response omitting the field degrades to 0 (shape-drift safe)", () => {
    assert.equal(countsOf({ ready_for_agent: 1, needs_qa: 0, needs_triage: 0, needs_research: 0 }).target_ready_blocker_excluded, "0");
  });

  test("the labels-only fallback emits the key as a literal 0, by construction", () => {
    const t = fallbackTally(ok([{ number: 1, labels: [{ name: "ready-for-agent" }] }]));
    assert.deepEqual(t?.counts.slice(0, 2), [["target_ready_for_agent", "1"], ["target_ready_blocker_excluded", "0"]]);
  });

  describe("INV-8 starvation note (behavioural, issue #4880)", () => {
    const starved = (notes: readonly string[]) => notes.filter((n) => n.includes("target board STARVED, not empty"));

    test("effective 0 + non-empty excluded set -> stderr STARVED note naming the issues", async () => {
      const r = await runBoard({ board: { ready_for_agent: 0, blocker_excluded: [11, 12] } });
      assert.equal(starved(r.notes).length, 1);
      assert.match(starved(r.notes)[0], /11 12/);
      assert.ok(!r.stdout.includes("STARVED"), "the note is stderr only");
    });

    test("effective 0 + empty excluded set -> no note", async () => {
      assert.deepEqual(starved((await runBoard({ board: { ready_for_agent: 0, blocker_excluded: [] } })).notes), []);
    });

    test("effective > 0 + non-empty excluded set -> no note", async () => {
      const r = await runBoard({ board: { ready_for_agent: 2, blocker_excluded: [11, 12] }, rfa: ok(issues(1, 2)) });
      assert.deepEqual(starved(r.notes), []);
    });

    test("the in-flight-adjusted count (not the base) decides starvation", async () => {
      const zero = await runBoard({ board: { ready_for_agent: 1, blocker_excluded: [11, 12] }, rfa: ok(issues(100)), pulls: ok([pr(5, "f", "Closes #100")]) });
      assert.equal(starved(zero.notes).length, 1);
      const healthy = await runBoard({ board: { ready_for_agent: 3, blocker_excluded: [11, 12] }, rfa: ok(issues(100)) });
      assert.deepEqual(starved(healthy.notes), []);
    });
  });
});

// ---------------------------------------------------------------------------
// #4474 — target_ready_for_agent in-flight PR exclusion
// ---------------------------------------------------------------------------

describe("target-board — target_ready_for_agent in-flight PR exclusion (issue #4474)", () => {
  const adjust = (o: { base: number; rfa: unknown[] | null; inflight: number[]; glm?: number[]; blocker?: number[] }) =>
    adjustedReadyForAgent({
      base: String(o.base),
      ready: o.rfa,
      inflight: new Set(o.inflight),
      glmWithheld: o.glm ?? [],
      blockerExcluded: o.blocker ?? [],
    });

  test("an in-flight ready-for-agent issue is subtracted from the base count", () => {
    assert.equal(adjust({ base: 3, rfa: [100, 101, 102], inflight: [101] }), 2);
  });

  test("an in-flight issue that is NOT labelled ready-for-agent does not affect the count", () => {
    assert.equal(adjust({ base: 3, rfa: [100, 101], inflight: [999] }), 3);
  });

  test("multiple in-flight ready-for-agent issues each subtract one", () => {
    assert.equal(adjust({ base: 3, rfa: [100, 101, 102], inflight: [100, 101] }), 1);
  });

  test("the exclusion never drives the count negative (clamped at 0)", () => {
    assert.equal(adjust({ base: 1, rfa: [1, 2, 3], inflight: [1, 2, 3] }), 0);
  });

  test("an empty in-flight set (failed PR-list read, or genuinely none open) excludes nothing", () => {
    assert.equal(adjust({ base: 3, rfa: [100, 101], inflight: [] }), 3);
  });

  test("an unreadable ready-for-agent read (failed REST read) excludes nothing rather than crashing", async () => {
    assert.equal(adjust({ base: 3, rfa: null, inflight: [101] }), 3);
    const r = await runBoard({ board: { ready_for_agent: 3 }, rfa: EMPTY, pulls: ok([pr(1, "f", "Closes #101")]) });
    assert.equal(r.out.target_ready_for_agent, "3");
  });

  test("a non-list rfa-numbers payload excludes nothing rather than crashing", async () => {
    const r = await runBoard({ board: { ready_for_agent: 3 }, rfa: ok({ degraded: true }), pulls: ok([pr(1, "f", "Closes #101")]) });
    assert.equal(r.out.target_ready_for_agent, "3");
  });

  test("an issue already withheld by the GLM partition is not double-subtracted", () => {
    assert.equal(adjust({ base: 2, rfa: [100, 101], inflight: [100, 101], glm: [101] }), 1);
  });

  test("an issue already blocker-excluded by the endpoint (B) is not double-subtracted (issue #4823)", () => {
    assert.equal(adjust({ base: 1, rfa: [100, 101, 102], inflight: [100, 101], blocker: [101] }), 0);
    assert.equal(adjust({ base: 3, rfa: [100, 101, 102], inflight: [100, 101] }), 1);
    assert.equal(adjust({ base: 3, rfa: [100, 101, 102], inflight: [100, 101], blocker: [101] }), 2);
  });

  test("an empty glm_withheld set (fallback path) subtracts the full R ∩ P intersection", () => {
    assert.equal(adjust({ base: 3, rfa: [100, 101, 102], inflight: [100, 101], glm: [] }), 1);
  });

  test("the open-PR and ready-for-agent reads are REST gh api calls against the Target repo, never gh pr list", async () => {
    const calls: string[][] = [];
    const port = createTurnSnapshotGithub({
      repo: "acme/target-app",
      transport: async (args) => {
        calls.push(args);
        return { ok: true, stdout: "[]", stderr: "" };
      },
    });
    await collectTargetBoard({ github: port, http: { get: async () => JSON.stringify({ ready_for_agent: 1 }) }, ghListLimit: 100 });
    assert.deepEqual(calls[0], ["api", "repos/acme/target-app/pulls?state=open&per_page=100"]);
    assert.deepEqual(calls[1], ["api", "repos/acme/target-app/issues?labels=ready-for-agent&state=open&per_page=100"]);
    assert.ok(!calls.some((c) => c[0] === "pr"), "the Target lane never uses gh pr list --json (GraphQL)");
  });

  test("the REST issues payload is filtered for pull requests before counting as R", async () => {
    const r = await runBoard({
      board: { ready_for_agent: 2 },
      rfa: ok([{ number: 100 }, { number: 101, pull_request: { url: "x" } }]),
      pulls: ok([pr(1, "f", "Closes #101")]),
    });
    assert.equal(r.out.target_ready_for_agent, "2", "a PR-shaped entry never counts as a ready-for-agent issue");
  });

  test("the degraded path derives R from its own already-fetched issue-list payload (zero extra REST calls)", async () => {
    const lab = (n: number, ...labels: string[]) => ({ number: n, labels: labels.map((name) => ({ name })) });
    const r = await runBoard({
      issuesFallback: ok([lab(100, "ready-for-agent"), lab(101, "ready-for-agent"), lab(102, "needs-triage")]),
      pulls: ok([pr(7, "f", "Closes #101"), pr(8, "g", "Closes #102")]),
    });
    assert.equal(r.out.target_ready_for_agent, "1");
    assert.ok(!r.calls.includes("ready-for-agent"), "no ready-for-agent REST read on the fallback arm");
  });

  test("the REST pulls payload is projected to the pr-refs {headRefName, body} shape", () => {
    const rows = projectPrRefs(
      ok([
        { number: 1, head: { ref: "issue-4474-fix" }, body: "some notes" },
        { number: 2, head: { ref: "worktree-agent-abc" }, body: "Closes #55\n" },
      ]),
    );
    assert.ok(rows !== null);
    assert.deepEqual([...referencedIssues(rows)].sort((a, b) => a - b), [55, 4474]);
  });

  test("a failed Target open-PR REST read logs a stderr note naming issue #4474 (fail-CLOSED, not silent)", async () => {
    const r = await runBoard({ board: { ready_for_agent: 3 }, pulls: EMPTY, rfa: ok(issues(100)) });
    assert.ok(r.notes.includes("target open-PR REST read FAILED (empty payload) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' (issue #4474)"));
    assert.equal(r.out.target_ready_for_agent, "3");
  });

  test("a failed Target ready-for-agent REST read logs a stderr note naming issue #4474 (fail-CLOSED, not silent)", async () => {
    const r = await runBoard({ board: { ready_for_agent: 3 }, rfa: EMPTY });
    assert.ok(r.notes.includes("target ready-for-agent REST read FAILED (empty payload) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' (issue #4474)"));
  });

  test("the exclusion never flips the lane-degraded flag (reserved for a failed counts read, issue #4130)", async () => {
    const r = await runBoard({ board: { ready_for_agent: 3 }, pulls: EMPTY, rfa: EMPTY });
    assert.equal(r.value.laneDegraded, false);
  });

  test("needs-dev-resume issues are not subtracted into the in-flight exclusion (#4739 INV-6)", () => {
    assert.equal(adjust({ base: 1, rfa: [42], inflight: [12] }), 1, "a needs-dev-resume issue in P but not in R subtracts nothing");
  });
});

// ---------------------------------------------------------------------------
// #4475 — WIP liveness (target-wip.py stays the build playbook's leaf)
// ---------------------------------------------------------------------------

describe("target-board — WIP liveness (issue #4475)", () => {
  test("TARGET_WIP_LIMIT matches target-wip.py --limit (the build playbook's gate)", () => {
    const r = spawnSync("python3", [join(REPO_ROOT, "scripts", "autopilot", "target-wip.py"), "--limit"], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(Number(r.stdout.trim()), TARGET_WIP_LIMIT);
  });

  test("only PR-backed in-progress claims count; saturated at the limit", async () => {
    const live = await runBoard({ inProgress: ok(issues(1, 2, 3)), pulls: ok([pr(10, "a", "Closes #1"), pr(11, "issue-2-b", "x"), pr(12, "c", "Refs #3")]) });
    assert.equal(live.out.target_wip_live, "3");
    assert.equal(live.out.target_wip_saturated, "true");
    const orphaned = await runBoard({ inProgress: ok(issues(1, 2, 3)) });
    assert.equal(orphaned.out.target_in_progress, "3");
    assert.equal(orphaned.out.target_wip_live, "0");
    assert.equal(orphaned.out.target_wip_saturated, "false");
  });

  test("an unreadable in-progress or open-PR payload fails OPEN with a note", async () => {
    const r = await runBoard({ inProgress: EMPTY });
    assert.equal(r.out.target_wip_saturated, "false");
    assert.ok(r.notes.some((n) => n.startsWith("target WIP read FAILED")));
  });
});

// ---------------------------------------------------------------------------
// #4576 / #4653 — needs-qa PR pre-resolution
// ---------------------------------------------------------------------------

describe("target-board — target_needs_qa_pr_ref / _head (issues #4576, #4653)", () => {
  test("a matching needs-qa issue + closing PR emits url then head.ref", async () => {
    const r = await runBoard({
      board: { ready_for_agent: 0, needs_qa: 1 },
      needsQa: ok([{ number: 55, labels: [{ name: "needs-qa" }] }]),
      pulls: ok([{ html_url: "https://github.com/example/target/pull/9", body: "Closes #55", head: { ref: "feature/deadbeef1-t2-dev_target" } }]),
    });
    assert.equal(r.out.target_needs_qa_pr_ref, "https://github.com/example/target/pull/9");
    assert.equal(r.out.target_needs_qa_pr_head, "feature/deadbeef1-t2-dev_target");
  });

  test("a matching PR with a missing/malformed head still emits the url with an empty head", async () => {
    const r = await runBoard({
      board: { ready_for_agent: 0, needs_qa: 1 },
      needsQa: ok([{ number: 55 }]),
      pulls: ok([{ html_url: "https://github.com/example/target/pull/9", body: "Closes #55", head: null }]),
    });
    assert.equal(r.out.target_needs_qa_pr_ref, "https://github.com/example/target/pull/9");
    assert.equal(r.out.target_needs_qa_pr_head, "");
  });

  test("no closing PR for any needs-qa issue leaves both facts empty", async () => {
    const r = await runBoard({
      board: { ready_for_agent: 0, needs_qa: 1 },
      needsQa: ok([{ number: 55 }]),
      pulls: ok([{ html_url: "https://github.com/example/target/pull/9", body: "Refs #55", head: { ref: "f" } }]),
    });
    assert.equal(r.out.target_needs_qa_pr_ref, "");
    assert.equal(r.out.target_needs_qa_pr_head, "");
  });

  test("the zero-count and failed-read branches each emit both keys empty", async () => {
    const zero = await runBoard({ board: { ready_for_agent: 0, needs_qa: 0 }, needsQa: ok([{ number: 55 }]), pulls: ok([pr(9, "f", "Closes #55")]) });
    assert.ok(!zero.calls.includes("needs-qa"), "a zero count skips the read");
    assert.equal(zero.out.target_needs_qa_pr_ref, "");
    assert.equal(zero.out.target_needs_qa_pr_head, "");
    const failed = await runBoard({ board: { ready_for_agent: 0, needs_qa: 2 }, needsQa: EMPTY });
    assert.equal(failed.out.target_needs_qa_pr_ref, "");
    assert.equal(failed.out.target_needs_qa_pr_head, "");
    assert.ok(failed.notes.some((n) => n.includes("(issue #4576)")));
  });
});

// ---------------------------------------------------------------------------
// #4739 — Target dev resume pick (the shared dev-resume pick, Target policy)
// ---------------------------------------------------------------------------

describe("target-board — target_dev_resume_pick (issue #4739)", () => {
  const PR_57 = pr(57, "feature/resume-176", "Closes #176");
  const resume = async (ndr: GhJsonRead, pulls: GhJsonRead, prRefs?: PrRefsAvailability) => {
    const r = await runBoard({ needsDevResume: ndr, pulls }, prRefs);
    return { pick: r.out.target_dev_resume_pick, notes: r.notes };
  };

  test("needs-dev-resume issue + referencing open PR yields the pick (lowest issue number wins)", async () => {
    const r = await resume(ok(issues(4452, 176)), ok([pr(901, "feature/resume-4452", "Closes #4452"), PR_57]));
    assert.equal(r.pick, "issue-176:57:feature/resume-176");
  });

  test("needs-dev-resume issue with no PR yields none", async () => {
    assert.equal((await resume(ok(issues(176)), ok([]))).pick, "none");
  });

  test("a PR that REFERENCES but does not CLOSE the issue never qualifies", async () => {
    assert.equal((await resume(ok(issues(176)), ok([pr(57, "feature/resume-176", "Refs #176")]))).pick, "none");
  });

  test("a PR closing TWO issues never qualifies (the pin must be unambiguous)", async () => {
    assert.equal((await resume(ok(issues(176, 177)), ok([pr(57, "feature/resume-176", "Closes #176\n\nCloses #177")]))).pick, "none");
  });

  test("empty or unreadable payload yields none", async () => {
    assert.equal((await resume(ok([]), ok([]))).pick, "none");
    const degraded = await resume(EMPTY, ok([PR_57]));
    assert.equal(degraded.pick, "none");
    assert.ok(degraded.notes.some((n) => n.includes("#4739")));
    const garbage = await resume({ kind: "unparseable", error: "Expecting value: line 1 column 1 (char 0)" }, ok([PR_57]));
    assert.equal(garbage.pick, "none");
    assert.ok(garbage.notes.some((n) => n.includes("#4739")));
    const noRefs = await resume(ok(issues(176)), ok([PR_57]), { ok: false, error: "predicate unavailable" });
    assert.equal(noRefs.pick, "none");
    assert.ok(noRefs.notes.some((n) => n.includes("#4739")));
  });

  test("draft PR yields none", async () => {
    assert.equal((await resume(ok(issues(176)), ok([pr(57, "feature/resume-176", "Closes #176", { draft: true })]))).pick, "none");
  });

  test("two PRs closing one issue yield none (ambiguous pin)", async () => {
    const r = await resume(ok(issues(176)), ok([pr(57, "feature/resume-176", "Closes #176"), pr(58, "feature/other-176", "Closes #176")]));
    assert.equal(r.pick, "none");
  });

  test("PR-shaped entries in the issues payload are filtered out (.pull_request)", async () => {
    assert.equal((await resume(ok([{ number: 176, pull_request: { url: "https://example/issue/176" } }]), ok([PR_57]))).pick, "none");
  });

  test("a head.ref containing ':' never qualifies (wire-shape poison)", async () => {
    assert.equal((await resume(ok(issues(176)), ok([pr(57, "we:ird", "Closes #176")]))).pick, "none");
  });

  test("the emission is exactly one key=value line with a none fallback", async () => {
    const r = await runBoard({ needsDevResume: EMPTY });
    assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("target_dev_resume_pick=")).length, 1);
    assert.equal(r.out.target_dev_resume_pick, "none");
  });

  test("a failed resume read never flips the lane-degraded flag (INV-4), and reuses the one pulls read (INV-3)", async () => {
    const r = await runBoard({ board: { ready_for_agent: 0 }, needsDevResume: EMPTY });
    assert.equal(r.value.laneDegraded, false);
    assert.equal(r.calls.filter((c) => c === "pulls").length, 1, "exactly one open-PR read feeds every Target consumer");
  });

  test("ONE dev-resume pick serves both realms: the policies differ only in selection", () => {
    const candidates = [
      { pr: 57, headRefName: "a" },
      { pr: 58, headRefName: "b" },
      { pr: 40, headRefName: "c" },
    ];
    const closes: Record<number, number> = { 57: 176, 58: 176, 40: 300 };
    const base = { candidates, resumeIssues: new Set([176, 300]), closing: (c: { pr: number }) => new Set([closes[c.pr]]) };
    assert.deepEqual(pickDevResume({ ...base, policy: "lowest-pr" }), { issue: 300, pr: 40, headRefName: "c" });
    assert.deepEqual(pickDevResume({ ...base, policy: "lowest-unambiguous-issue" }), { issue: 300, pr: 40, headRefName: "c" });
    assert.deepEqual(pickDevResume({ ...base, resumeIssues: new Set([176]), policy: "lowest-pr" }), { issue: 176, pr: 57, headRefName: "a" });
    assert.equal(pickDevResume({ ...base, resumeIssues: new Set([176]), policy: "lowest-unambiguous-issue" }), null);
  });
});

// ---------------------------------------------------------------------------
// #3710 / #3973 / #4130 / #4528 — scan-board signals
// ---------------------------------------------------------------------------

const rows = (n: number, labels: string[] = ["needs-triage"]) => Array.from({ length: n }, (_, i) => ({ number: i + 1, labels }));

async function runScan(o: { rows?: unknown; read?: GhJsonRead; limit?: number; laneDegraded?: boolean; workQueue?: number; adr?: boolean }) {
  const fake = fakeTarget({ scanIssues: o.read ?? ok(o.rows ?? []) });
  const outcome = await collectTargetScanBoards({
    github: fake.github,
    ghListLimit: o.limit ?? 100,
    laneDegraded: o.laneDegraded ?? false,
    workQueue: o.workQueue ?? 0,
    workspace: "/ws",
    adrPresent: () => o.adr ?? false,
  });
  return { out: kv(renderTargetScanKv(outcome.value)), value: outcome.value };
}

describe("target-scan-boards — truncation signal (issue #3710)", () => {
  test("a board under the page size reports truncated=false", async () => {
    assert.equal((await runScan({ rows: rows(35) })).out.target_board_signals_truncated, "false");
  });

  test("a row count exactly at the page size reports truncated=true", async () => {
    assert.equal((await runScan({ rows: rows(100) })).out.target_board_signals_truncated, "true");
  });

  test("truncation is ADVISORY — it never flips a dispatch-gating signal", async () => {
    const out = (await runScan({ rows: [...rows(60), ...rows(40, ["wire-or-retire", "needs-triage"])], adr: true })).out;
    assert.equal(out.target_board_signals_truncated, "true");
    assert.equal(out.wire_or_retire_target_available, "true");
    assert.equal(out.target_cleanup_board_saturated, "false");
    assert.equal(out.design_qa_target_due, "true");
  });

  test("truncation and degradation stay separate keys with opposite meanings", async () => {
    const out = (await runScan({ rows: rows(100) })).out;
    assert.equal(out.target_board_signals_degraded, "false");
    assert.equal(out.target_board_signals_truncated, "true");
  });

  test("the classifier honours the shared limit rather than hardcoding 100", async () => {
    assert.equal((await runScan({ rows: rows(30), limit: 30 })).out.target_board_signals_truncated, "true");
  });

  test("the key is emitted on the degraded branch too, so decide.py never sees it missing", async () => {
    const out = (await runScan({ read: EMPTY })).out;
    assert.equal(out.target_board_signals_degraded, "true");
    assert.equal(out.target_board_signals_truncated, "false");
  });
});

describe("target-scan-boards — wire-or-retire unlabelled advisory count (issue #3973)", () => {
  const scan = (r: { labels: string[] }[]) => classifyTargetScan(r, { limit: 100, workQueue: 0 });

  test("wire-or-retire + bug only is counted (the live #760 case)", () => {
    const s = scan([{ labels: ["wire-or-retire", "bug"] }]);
    assert.equal(s.wireOrRetireUnlabelled, 1);
    assert.equal(s.wireOrRetireTriage, 0);
  });

  test("a bare wire-or-retire label (no other label) is counted", () => {
    assert.equal(scan([{ labels: ["wire-or-retire"] }]).wireOrRetireUnlabelled, 1);
  });

  test("wire-or-retire + needs-triage is NOT counted (already resolver-visible)", () => {
    const s = scan([{ labels: ["wire-or-retire", "needs-triage"] }]);
    assert.equal(s.wireOrRetireUnlabelled, 0);
    assert.equal(s.wireOrRetireTriage, 1);
  });

  test("wire-or-retire + ready-for-human is NOT counted (resolver's UNCLEAR verdict)", () => {
    assert.equal(scan([{ labels: ["wire-or-retire", "ready-for-human"] }]).wireOrRetireUnlabelled, 0);
  });

  test("wire-or-retire + ready-for-agent is NOT counted (WIRE/RETIRE verdict)", () => {
    assert.equal(scan([{ labels: ["wire-or-retire", "ready-for-agent"] }]).wireOrRetireUnlabelled, 0);
  });

  test("wire-or-retire + blocked is NOT counted (blocked is a lifecycle label)", () => {
    assert.equal(scan([{ labels: ["wire-or-retire", "blocked"] }]).wireOrRetireUnlabelled, 0);
  });

  test("a non-wire-or-retire issue is never counted", () => {
    assert.equal(scan([{ labels: ["bug", "enhancement"] }]).wireOrRetireUnlabelled, 0);
  });

  test("the AND predicate is unchanged: wire-or-retire + ready-for-agent stays out of wire_or_retire_target_triage", async () => {
    const out = (await runScan({ rows: [{ labels: ["wire-or-retire", "ready-for-agent"] }] })).out;
    assert.equal(out.wire_or_retire_target_triage, "0");
    assert.equal(out.wire_or_retire_target_available, "false");
  });

  test("a mixed board counts only the lifecycle-less wire-or-retire items", async () => {
    const out = (
      await runScan({
        rows: [
          { number: 760, labels: ["wire-or-retire", "bug"] },
          { labels: ["wire-or-retire", "needs-triage"] },
          { labels: ["wire-or-retire", "ready-for-agent"] },
          { labels: ["wire-or-retire", "ready-for-human"] },
          { labels: ["wire-or-retire", "blocked"] },
          { labels: ["wire-or-retire"] },
          { labels: ["bug"] },
        ],
      })
    ).out;
    assert.equal(out.wire_or_retire_target_unlabelled, "2");
    assert.equal(out.wire_or_retire_target_triage, "1");
    assert.equal(out.wire_or_retire_target_available, "true");
  });

  test("the key is emitted on every branch so decide.py never sees it missing", async () => {
    for (const read of [ok([]), EMPTY, { kind: "unparseable", error: "x" } as GhJsonRead]) {
      assert.ok("wire_or_retire_target_unlabelled" in (await runScan({ read })).out);
    }
  });

  test("a degraded/unreachable board read emits 0, never a spurious non-zero", async () => {
    assert.equal((await runScan({ read: EMPTY })).out.wire_or_retire_target_unlabelled, "0");
  });
});

describe("target-scan-boards — lane degraded accumulator (issue #4130)", () => {
  test("a failed counts read latches the lane flag the scan collector receives", async () => {
    const r = await runBoard({ issuesFallback: EMPTY });
    assert.equal(r.value.laneDegraded, true);
  });

  test("the healthy per-item branch emits the ACCUMULATED verdict, not a hard false", async () => {
    assert.equal((await runScan({ rows: rows(1), laneDegraded: true })).out.target_board_signals_degraded, "true");
    assert.equal((await runScan({ rows: rows(1), laneDegraded: false })).out.target_board_signals_degraded, "false");
  });

  test("the fail-closed per-item branch also latches the accumulator", async () => {
    const r = await runScan({ read: EMPTY, laneDegraded: false });
    assert.equal(r.value.signalsDegraded, true);
    assert.equal(r.out.target_board_signals_degraded, "true");
  });

  test("a failed counts read is distinguishable from a genuinely zero board", async () => {
    const zero = await runBoard({ issuesFallback: ok([]) });
    assert.equal(zero.value.laneDegraded, false);
    assert.equal(zero.out.target_ready_for_agent, "0");
    const failed = await runBoard({ issuesFallback: EMPTY });
    assert.equal(failed.value.laneDegraded, true);
  });
});

describe("target-scan-boards — design_qa_target ADR-presence gate (issue #4528)", () => {
  test("due defaults to false when no design ADR is present (fail closed)", async () => {
    const out = (await runScan({ rows: [{ labels: ["needs-triage"] }] })).out;
    assert.equal(out.design_qa_target_adr_present, "false");
    assert.equal(out.design_qa_target_saturated, "false");
    assert.equal(out.design_qa_target_due, "false");
  });

  test("ADR present + reachable unsaturated board emits due=true", async () => {
    const out = (await runScan({ rows: [{ labels: ["needs-triage"] }], adr: true })).out;
    assert.equal(out.design_qa_target_adr_present, "true");
    assert.equal(out.design_qa_target_due, "true");
  });

  test("the CSB shape — board reachable, no design ADR — stays dormant without saturating", async () => {
    const out = (await runScan({ rows: [{ labels: ["bug"] }] })).out;
    assert.equal(out.design_qa_target_saturated, "false");
    assert.equal(out.design_qa_target_due, "false");
  });

  test("ADR presence never rescues a saturated board (the anti-flood cap stays FIRST)", async () => {
    const out = (await runScan({ rows: rows(6, ["design-qa"]), adr: true })).out;
    assert.equal(out.design_qa_target_saturated, "true");
    assert.equal(out.design_qa_target_due, "false");
  });

  test("saturated depends only on the design-qa count vs the cap of 5, never on ADR presence", async () => {
    assert.equal((await runScan({ rows: rows(6, ["design-qa"]), adr: true })).out.design_qa_target_saturated, "true");
    assert.equal((await runScan({ rows: rows(6, ["design-qa"]) })).out.design_qa_target_saturated, "true");
    assert.equal((await runScan({ rows: rows(2, ["design-qa"]), adr: true })).out.design_qa_target_saturated, "false");
    assert.equal((await runScan({ rows: rows(2, ["design-qa"]) })).out.design_qa_target_saturated, "false");
  });

  test("the advisory adr_present key is emitted on every branch (decide.py never reads it — pinned in autopilot-target-board-signals)", async () => {
    assert.equal((await runScan({ read: EMPTY, adr: true })).out.design_qa_target_adr_present, "true");
    assert.equal((await runScan({ read: { kind: "unparseable", error: "x" }, adr: true })).out.design_qa_target_adr_present, "true");
  });

  test("the glob matches only design-language ADRs under the workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "dqa-ws-"));
    try {
      assert.equal(designLanguageAdrPresent(ws), false);
      mkdirSync(join(ws, "docs", "adr"), { recursive: true });
      writeFileSync(join(ws, "docs", "adr", "0001-founding-scaffold.md"), "# founding\n");
      assert.equal(designLanguageAdrPresent(ws), false);
      writeFileSync(join(ws, "docs", "adr", "0005-design-language.md"), "# design\n");
      assert.equal(designLanguageAdrPresent(ws), true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("the glob fails closed on an unresolved workspace", () => {
    assert.equal(designLanguageAdrPresent(""), false);
  });

  test("the ADR glob is identical in the collector and the playbook (drift pin)", () => {
    assert.equal(DESIGN_QA_ADR_GLOB, "docs/adr/*design-language*.md");
    const playbook = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-design-qa.md"), "utf-8");
    assert.ok(playbook.includes(DESIGN_QA_ADR_GLOB), "hydra-design-qa.md must re-check the SAME glob literal");
  });

  test("hydra-design-qa.md resolves the Target seam and carries no Target literal", () => {
    const playbook = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-design-qa.md"), "utf-8");
    assert.match(playbook, /@include _fragments\/target-seam-preamble\.md/);
    assert.ok(!playbook.includes("hydra-betting"));
  });
});

// ---------------------------------------------------------------------------
// #4411 — target_risk_surface_json (ported from the pipefail suite)
// ---------------------------------------------------------------------------

describe("target-risk-surface — exactly one well-formed line (issue #4411)", () => {
  const run = async (facts: () => unknown) => renderTargetRiskSurfaceKv((await collectTargetRiskSurface({ facts })).value);
  const payload = (stdout: string) => {
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `expected exactly one output line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /^target_risk_surface_json=/);
    return JSON.parse(lines[0].slice("target_risk_surface_json=".length));
  };

  test("a manifest ok:false (the documented failure signal) emits exactly one well-formed line", async () => {
    const stdout = await run(() => ({ manifest: { ok: false, errors: ["no resolvable Target Manifest"] } }));
    const p = payload(stdout);
    assert.equal(p.ok, false);
    assert.deepEqual(p.errors, ["no resolvable Target Manifest"]);
    assert.ok(!stdout.includes("unreachable"));
  });

  test("a healthy manifest emits exactly one well-formed line", async () => {
    const p = payload(await run(() => ({ manifest: { ok: true, appSubdir: "web", surfaceRepoRelative: ["web/src/risk/"] } })));
    assert.equal(p.ok, true);
    assert.equal(p.appSubdir, "web");
  });

  test("the production facts read stays quiet on a missing manifest (bash parity: print-target-facts 2>/dev/null)", async () => {
    const prevRoot = process.env.TARGET_MANIFEST_ROOT;
    process.env.TARGET_MANIFEST_ROOT = join(tmpdir(), "ts-no-such-manifest-root");
    const captured: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    const origWrite = process.stderr.write.bind(process.stderr);
    console.error = (...a: unknown[]) => void captured.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void captured.push(a.map(String).join(" "));
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let stdout: string;
    try {
      stdout = await run(productionTargetDeps().facts);
    } finally {
      console.error = origError;
      console.warn = origWarn;
      process.stderr.write = origWrite;
      if (prevRoot === undefined) delete process.env.TARGET_MANIFEST_ROOT;
      else process.env.TARGET_MANIFEST_ROOT = prevRoot;
    }
    assert.deepEqual(captured, [], "no extra stderr — the old collector discarded print-target-facts' stderr");
    assert.equal(payload(stdout).ok, false, "a missing manifest still fails closed");
  });

  test("an unresolvable facts read still fails closed to exactly one well-formed line", async () => {
    const p = payload(
      await run(() => {
        throw new Error("manifest root unreadable");
      }),
    );
    assert.equal(p.ok, false);
    assert.deepEqual(p.errors, ["target_risk_surface_json: manifest root unreadable"]);
  });
});

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

describe("turn-snapshot CLI — Target collectors (ADR-0043 slice 4)", () => {
  test("the Target collectors are registered and their flags validated", () => {
    const a = parseArgs(["--collectors", "target-scan-boards,target-risk-surface", "--target-lane-degraded", "1", "--target-work-queue", "4"]);
    assert.ok(!("error" in a));
    assert.equal(a.targetLaneDegraded, true);
    assert.equal(a.targetWorkQueue, 4);
    assert.ok("error" in parseArgs(["--collectors", "target-board", "--target-lane-degraded", "yes"]));
    assert.ok("error" in parseArgs(["--collectors", "target-board", "--target-work-queue", "-1"]));
  });

  test("a crashing Target collector reports a note and renders its fail-closed fallback (exit 0)", async () => {
    let stdout = "";
    let stderr = "";
    let exportsText = "";
    const code = await main(
      ["--collectors", "target-board", "--exports-file", "x"],
      {
        github: unusedOrchGithub,
        now: () => 0,
        sleep: async () => {},
        target: () => {
          throw new Error("boom");
        },
      },
      { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), writeFile: (_p, t) => (exportsText = t) },
    );
    assert.equal(code, 0);
    assert.match(stderr, /target turn-snapshot target-board collector crashed \(boom\)/);
    assert.equal(kv(stdout).target_dev_resume_pick, "none");
    assert.equal(kv(stdout).target_ready_for_agent, "0");
    assert.equal(exportsText, "TARGET_LANE_DEGRADED=1\n");
  });

  test("a pr-gate-only invocation never builds the Target deps", async () => {
    let built = false;
    const port = new Proxy({} as TurnSnapshotGithub, { get: () => async () => ({ kind: "empty" }) });
    await main(["--collectors", "pr-gate"], {
      github: port,
      now: () => 0,
      sleep: async () => {},
      target: () => {
        built = true;
        throw new Error("unexpected");
      },
    }, { stdout: () => {}, stderr: () => {}, writeFile: () => {} });
    assert.equal(built, false);
  });
});
