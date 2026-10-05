/**
 * src/glm/pick.ts — the GLM drainer's pick phase (issue #4686, ADR-0040
 * Decision 1-2 + Decision 6, epic #4681).
 *
 * Ports the bash-era golden groups D6 (open-PR skip), D7 (merged-PR skip),
 * D8 (glm-withhold / glm-ab-control exclusion), D9 (the 12-row `is_grill_clear`
 * table + picker cases) and D14 (`find_resumable_branch`) from
 * test/glm-drainer-loop.test.mts as typed TABLE tests over fake deps — no
 * `gh`, no real git, no processes, no goldens (the #4679 test-port rule).
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import {
  PICK_FETCH_LIMIT,
  pickResumeBranch,
  resumeBranchTs,
  runPick,
  type ArtifactStatus,
  type PickDeps,
  type PickResult,
  type ResumeRow,
} from "../src/glm/pick.ts";
import { runDriverMode, type DriverDeps } from "../src/glm/drainer-driver.ts";
import {
  GLM_DRAINER_HEARTBEAT_TTL_SECONDS,
  GLM_DRAINER_LAST_PICK_KEY,
  getGlmDrainerLastPick,
  setGlmDrainerLastPick,
} from "../src/redis/autopilot.ts";
import { parseLsRemoteHeads } from "../src/github/git.ts";
import { parsePrRows } from "../src/github/prs.ts";
import type { IssueReadResult, IssueRow } from "../src/github/issues.ts";
import type { PrRow } from "../src/github/prs.ts";

// ---------------------------------------------------------------------------
// Fake deps
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-29T12:00:00Z");

function issue(
  number: number,
  labels: string[],
  extra: Partial<IssueRow> = {},
): IssueRow {
  return {
    number,
    title: "",
    url: "",
    createdAt: "",
    labels,
    body: "",
    state: "OPEN",
    updatedAt: "2026-08-28T00:00:00Z",
    ...extra,
  };
}

function pr(number: number, extra: Partial<PrRow> = {}): PrRow {
  return {
    number,
    title: `PR #${number}`,
    url: "",
    updatedAt: "",
    state: "",
    headRefName: "",
    createdAt: "",
    statusCheckRollup: [],
    ...extra,
  };
}

interface Board {
  issues?: IssueRow[] | "fail";
  openPrs?: PrRow[] | "fail";
  mergedPrs?: PrRow[] | "fail";
  artifacts?: Record<number, ArtifactStatus>;
  /** Open blocker numbers the fake `fetchOpenBlockers` reports (default none). */
  openBlockers?: Set<number> | "all";
  resume?: Record<number, ResumeRow[]>;
  env?: NodeJS.ProcessEnv;
}

interface Harness {
  deps: PickDeps;
  logs: string[];
  calls: string[];
  published: Array<Parameters<PickDeps["publishLastPick"]>[0]>;
  recovered: number[][];
  fetchArgs: Array<{ fields: string; limit: number }>;
  blockerQueries: number[][];
}

function harness(board: Board): Harness {
  const h: Harness = { deps: null as any, logs: [], calls: [], published: [], recovered: [], fetchArgs: [], blockerQueries: [] };
  const asResult = <T,>(v: T[] | "fail" | undefined): IssueReadResult<any> =>
    v === "fail" ? { ok: false, code: "gh-nonzero-exit" as any } : { ok: true, rows: v ?? [] };
  h.deps = {
    env: board.env ?? {},
    now: () => NOW,
    log: (m) => h.logs.push(m),
    listGlmEligible: async (fields, limit) => {
      h.calls.push("listGlmEligible");
      h.fetchArgs.push({ fields, limit });
      return asResult(board.issues);
    },
    listOpenPrs: async () => {
      h.calls.push("listOpenPrs");
      return asResult(board.openPrs);
    },
    listMergedPrs: async () => {
      h.calls.push("listMergedPrs");
      return asResult(board.mergedPrs);
    },
    fetchOpenBlockers: async (nums) => {
      h.calls.push("fetchOpenBlockers");
      h.blockerQueries.push([...nums]);
      return board.openBlockers === "all" ? new Set(nums) : (board.openBlockers ?? new Set<number>());
    },
    fetchArtifact: async (n) => {
      h.calls.push(`fetchArtifact:${n}`);
      return board.artifacts?.[n] ?? null;
    },
    runRecoverStale: async (nums) => {
      h.calls.push("runRecoverStale");
      h.recovered.push(nums);
      return 0;
    },
    listResumeRows: async (n) => {
      h.calls.push(`listResumeRows:${n}`);
      return board.resume?.[n] ?? [];
    },
    publishLastPick: async (v) => {
      h.calls.push("publishLastPick");
      h.published.push(v);
    },
  };
  return h;
}

const READY = "ready-for-agent";
const GLM = "glm-eligible";
const cand = (n: number, extra: string[] = [], body = "", updatedAt = "2026-08-28T00:00:00Z"): IssueRow =>
  issue(n, [GLM, READY, ...extra], { body, updatedAt });

const approved: ArtifactStatus = { status: "approved", createdAt: NOW - 1000 };

function picked(r: PickResult): number | null {
  return "issue" in r ? r.issue : null;
}

// ---------------------------------------------------------------------------
// D9 — the 12 is_grill_clear rows (bash expected reasons) via runPick
// ---------------------------------------------------------------------------

describe("runPick — grill-clear admission table (ported D9, issue #4286 rows)", () => {
  const rows: Array<{
    name: string;
    row: IssueRow;
    artifact?: ArtifactStatus;
    /** null = not admitted */
    expected: string | null;
  }> = [
    { name: "cleanup-scan label", row: cand(101, ["cleanup-scan"]), expected: "cleanup-scan" },
    { name: "Expected tier: T1 stamp", row: cand(102, [], "Do it.\n\nExpected tier: T1"), expected: "expected-tier-t1" },
    { name: "Expected tier: 1 stamp", row: cand(103, [], "Expected tier: 1"), expected: "expected-tier-t1" },
    { name: "lowercase 'expected tier: t1'", row: cand(104, [], "expected tier: t1"), expected: "expected-tier-t1" },
    { name: "T1 stamp + needs-design-concept (opt-in wins; pending artifact)", row: cand(105, ["needs-design-concept"], "Expected tier: T1"), expected: null },
    { name: "T12 stamp (word boundary)", row: cand(106, [], "Expected tier: T12"), expected: null },
    { name: "T3 stamp", row: cand(107, [], "Expected tier: T3"), expected: null },
    { name: "empty body", row: cand(108, [], ""), expected: null },
    { name: "cleanup-scan + needs-design-concept (mechanical arm unconditional)", row: cand(109, ["cleanup-scan", "needs-design-concept"], "irrelevant"), expected: "cleanup-scan" },
    { name: "null body", row: issue(110, [GLM, READY], { body: null as any }), expected: null },
    { name: "no stamp + APPROVED artifact (fall-through)", row: cand(111, [], "no stamps here"), artifact: approved, expected: "approved-fresh" },
    { name: "approved artifact older than 7 days is stale (delta 3)", row: cand(113, [], "plain"), artifact: { status: "approved", createdAt: NOW - 8 * 24 * 3600 * 1000 }, expected: null },
    { name: "plain + draft artifact (INV-2: not adopted)", row: cand(114, [], "plain"), artifact: { status: "draft", createdAt: NOW - 1000 }, expected: null },
    { name: "plain + artifact fetch failed/404", row: cand(115, [], "plain"), artifact: null, expected: null },
    { name: "title track: is refused absolutely even with a T1 stamp (delta 4)", row: issue(116, [GLM, READY], { title: "track: epic", body: "Expected tier: T1" }), expected: null },
  ];

  for (const c of rows) {
    test(`${c.name} -> ${c.expected ?? "not picked"}`, async () => {
      const h = harness({ issues: [c.row], artifacts: { [c.row.number]: c.artifact ?? null } });
      const r = await runPick(h.deps);
      if (c.expected === null) {
        assert.equal(picked(r), null);
        assert.ok("idle" in r);
        assert.ok(!h.logs.some((l) => l.startsWith("picked issue")));
      } else {
        assert.equal(picked(r), c.row.number);
        assert.equal((r as any).reason, c.expected);
        assert.ok(
          h.logs.includes(`picked issue #${c.row.number} (grill-clear: ${c.expected})`),
          `journal line must be byte-identical: ${h.logs.join(" | ")}`,
        );
      }
    });
  }

  test("exemption arms never consult the design-concept API (pure over fetched rows)", async () => {
    const h = harness({ issues: [cand(120, ["cleanup-scan"])] });
    await runPick(h.deps);
    assert.ok(!h.calls.some((c) => c.startsWith("fetchArtifact")));
  });
});

// ---------------------------------------------------------------------------
// D6 / D7 / D8 — skips and exclusions
// ---------------------------------------------------------------------------

describe("runPick — open-PR skip (ported D6), merged-PR skip (D7), lane exclusion (D8)", () => {
  test("D6: a candidate with an open PR body 'Closes #N' is skipped; next candidate picked", async () => {
    const h = harness({
      issues: [cand(50, ["cleanup-scan"], "", "2026-08-28T00:00:00Z"), cand(51, [], "plain", "2026-08-29T00:00:00Z")],
      openPrs: [pr(900, { body: "Closes #50" })],
      artifacts: { 51: approved },
    });
    const r = await runPick(h.deps);
    assert.equal(picked(r), 51);
    assert.ok(h.logs.some((l) => /skipping issue #50 — an open PR already references it/.test(l)));
  });

  test("D6 (delta 6): the open-PR union counts — a bare 'Refs #N' or issue-N branch skips 'open-pr'", async () => {
    const h = harness({
      issues: [cand(60, ["cleanup-scan"]), cand(61, ["cleanup-scan"], "", "2026-08-29T00:00:00Z")],
      openPrs: [pr(901, { body: "Refs #60" })],
    });
    assert.equal(picked(await runPick(h.deps)), 61);
    assert.equal(h.published[0].skipped["open-pr"], 1);
    const h2 = harness({
      issues: [cand(60, ["cleanup-scan"])],
      openPrs: [pr(902, { headRefName: "issue-60-foo" })],
    });
    assert.equal(picked(await runPick(h2.deps)), null);
    assert.equal(h2.published[0].skipped["open-pr"], 1);
  });

  test("D6: open-PR list failure -> WARN + proceeds with an empty skip list", async () => {
    const h = harness({ issues: [cand(62, ["cleanup-scan"])], openPrs: "fail" });
    const r = await runPick(h.deps);
    assert.equal(picked(r), 62);
    assert.ok(h.logs.some((l) => /^WARN gh pr list failed while building the open-PR skip list/.test(l)));
  });

  const mergedRows: Array<{ name: string; merged: PrRow; skipped: boolean }> = [
    { name: "closing keyword in merged body", merged: pr(910, { title: "feat: thing", body: "Closes #70" }), skipped: true },
    { name: "closing keyword in merged title", merged: pr(911, { title: "Fixes #70: thing", body: "" }), skipped: true },
    { name: "bare (#N) title anchor, no keyword (the #4130 shape)", merged: pr(912, { title: "fix(x): subject (#70) (#912)", body: "" }), skipped: true },
    { name: "unrelated merged PR", merged: pr(913, { title: "fix: other (#71)", body: "Closes #71" }), skipped: false },
  ];
  for (const c of mergedRows) {
    test(`D7: ${c.name} -> ${c.skipped ? "skipped" : "not skipped"}`, async () => {
      const h = harness({ issues: [cand(70, ["cleanup-scan"])], mergedPrs: [c.merged] });
      const r = await runPick(h.deps);
      assert.equal(picked(r), c.skipped ? null : 70);
      if (c.skipped) assert.ok(h.logs.some((l) => /skipping issue #70 — a MERGED PR already references it/.test(l)));
    });
  }

  test("D7: merged-PR list failure -> WARN + proceeds", async () => {
    const h = harness({ issues: [cand(72, ["cleanup-scan"])], mergedPrs: "fail" });
    const r = await runPick(h.deps);
    assert.equal(picked(r), 72);
    assert.ok(h.logs.some((l) => /^WARN gh pr list --state merged failed/.test(l)));
  });

  test("D6/D7: the open- and merged-PR skips keep priority over an exemption arm", async () => {
    const h = harness({
      issues: [cand(52, ["cleanup-scan"]), cand(53, [], "plain", "2026-08-29T00:00:00Z"), cand(54, ["cleanup-scan"], "", "2026-08-30T00:00:00Z")],
      openPrs: [pr(900, { body: "Closes #52" })],
      mergedPrs: [pr(901, { title: "x (#54)" })],
      artifacts: { 53: approved },
    });
    assert.equal(picked(await runPick(h.deps)), 53);
  });

  for (const label of ["glm-withhold", "glm-ab-control"]) {
    test(`D8: a candidate carrying ${label} is never picked; the next is`, async () => {
      const h = harness({
        issues: [cand(80, ["cleanup-scan", label]), cand(81, ["cleanup-scan"], "", "2026-08-29T00:00:00Z")],
      });
      const r = await runPick(h.deps);
      assert.equal(picked(r), 81);
      assert.equal(h.published[0].skipped.lane, 1);
    });
  }

  test("delta 8: in-progress alongside ready-for-agent is skipped 'lane'", async () => {
    const h = harness({ issues: [cand(82, ["cleanup-scan", "in-progress"])] });
    assert.equal(picked(await runPick(h.deps)), null);
    assert.equal(h.published[0].skipped.lane, 1);
  });

  test("delta 9: target-backlog alongside ready-for-agent is skipped 'lane'", async () => {
    const h = harness({ issues: [cand(82, ["cleanup-scan", "target-backlog"])] });
    assert.equal(picked(await runPick(h.deps)), null);
    assert.equal(h.published[0].skipped.lane, 1);
  });

  test("delta 5: a body 'Blocked by #N' with N open is skipped 'open-blocker'", async () => {
    const h = harness({
      issues: [cand(83, ["cleanup-scan"], "Blocked by #500"), cand(84, ["cleanup-scan"], "", "2026-08-29T00:00:00Z")],
      openBlockers: new Set([500]),
    });
    assert.equal(picked(await runPick(h.deps)), 84);
    assert.equal(h.published[0].skipped["open-blocker"], 1);
    assert.deepEqual(h.blockerQueries, [[500]], "one batched call over the union of refs");
  });

  test("INV-6 fail-safe: a lookup that returns the full requested set skips 'open-blocker'", async () => {
    const h = harness({ issues: [cand(85, ["cleanup-scan"], "Blocked by #501")], openBlockers: "all" });
    assert.equal(picked(await runPick(h.deps)), null);
    assert.equal(h.published[0].skipped["open-blocker"], 1);
  });

  test("INV-6: an empty blocker union makes NO fetchOpenBlockers call", async () => {
    const h = harness({ issues: [cand(86, ["cleanup-scan"], "no refs")] });
    await runPick(h.deps);
    assert.ok(!h.calls.includes("fetchOpenBlockers"));
  });

  test("delta 3: an approved artifact older than 7 days is skipped 'artifact-stale'", async () => {
    const h = harness({
      issues: [cand(87, [], "plain")],
      artifacts: { 87: { status: "approved", createdAt: NOW - 8 * 24 * 3600 * 1000 } },
    });
    assert.equal(picked(await runPick(h.deps)), null);
    assert.equal(h.published[0].skipped["artifact-stale"], 1);
  });

  test("delta 4: a track: title carrying an Expected tier: T1 stamp is skipped 'track-title'", async () => {
    const h = harness({ issues: [issue(88, [GLM, READY], { title: "Track: epic", body: "Expected tier: T1" })] });
    assert.equal(picked(await runPick(h.deps)), null);
    assert.equal(h.published[0].skipped["track-title"], 1);
  });

  test("delta 6: open PR with only 'Refs #N', or only an issue-N head branch, is skipped 'open-pr'", async () => {
    for (const p of [pr(903, { body: "Refs #89" }), pr(904, { headRefName: "issue-89" })]) {
      const h = harness({ issues: [cand(89, ["cleanup-scan"])], openPrs: [p] });
      assert.equal(picked(await runPick(h.deps)), null);
      assert.equal(h.published[0].skipped["open-pr"], 1);
    }
  });

  test("INV-2: fetchArtifact is called for a plain row and NOT for rows skipped earlier or exempt", async () => {
    const h = harness({
      issues: [
        issue(97, [GLM, READY, "in-progress"], { updatedAt: "2026-08-26T00:00:00Z" }),
        cand(98, [], "plain", "2026-08-27T00:00:00Z"),
        cand(99, ["cleanup-scan"], "", "2026-08-28T00:00:00Z"),
      ],
      artifacts: { 98: approved },
    });
    await runPick(h.deps);
    const fetched = h.calls.filter((c) => c.startsWith("fetchArtifact"));
    assert.deepEqual(fetched, ["fetchArtifact:98"]);
  });

  test("INV-13: an idle tick logs the skip histogram line", async () => {
    const h = harness({ issues: [cand(100, [], "plain")] });
    await runPick(h.deps);
    assert.ok(h.logs.includes('idle: candidates=1 skipped={"artifact-missing":1}'), h.logs.join(" | "));
  });

  test("candidates are ordered by updatedAt ascending and the first admitted returns immediately", async () => {
    const h = harness({
      issues: [
        cand(92, ["cleanup-scan"], "", "2026-08-30T00:00:00Z"),
        cand(90, ["cleanup-scan"], "", "2026-08-26T00:00:00Z"),
        cand(91, ["cleanup-scan"], "", "2026-08-28T00:00:00Z"),
      ],
    });
    assert.equal(picked(await runPick(h.deps)), 90);
    assert.equal(h.calls.filter((c) => c.startsWith("listResumeRows")).length, 1, "resume runs only for the picked issue");
  });

  test("the ready-for-agent filter is applied client-side (glm-eligible-only rows are not candidates)", async () => {
    const h = harness({
      issues: [issue(95, [GLM, "cleanup-scan"]), cand(96, ["cleanup-scan"])],
    });
    const r = await runPick(h.deps);
    assert.equal(picked(r), 96);
    assert.equal(h.published[0].candidates, 1);
  });
});

// ---------------------------------------------------------------------------
// Fetch window, recovery sequencing, fail-open
// ---------------------------------------------------------------------------

describe("runPick — fetch window, stale-claim recovery, fail-open, publication", () => {
  test("the candidate fetch uses limit 100 (ADR-0040 row 12), not bash's 30", async () => {
    const h = harness({ issues: [] });
    await runPick(h.deps);
    assert.equal(PICK_FETCH_LIMIT, 100);
    assert.ok(h.fetchArgs.length >= 1);
    for (const a of h.fetchArgs) assert.equal(a.limit, 100);
  });

  test("stale-claim recovery runs BEFORE the candidate fetch, only for in-progress > 5400s", async () => {
    const stale = new Date(NOW - 5401_000).toISOString();
    const fresh = new Date(NOW - 5399_000).toISOString();
    const h = harness({
      issues: [
        issue(1, [GLM, "in-progress"], { updatedAt: stale }),
        issue(2, [GLM, "in-progress"], { updatedAt: fresh }),
        issue(3, [GLM, READY], { updatedAt: stale }),
      ],
    });
    await runPick(h.deps);
    assert.deepEqual(h.recovered, [[1]]);
    const firstFetch = h.calls.indexOf("listGlmEligible");
    const recover = h.calls.indexOf("runRecoverStale");
    const secondFetch = h.calls.indexOf("listGlmEligible", firstFetch + 1);
    assert.ok(firstFetch < recover && recover < secondFetch, h.calls.join(","));
  });

  test("a recovery-list failure is a silent no-op and the pick still runs", async () => {
    const h = harness({ issues: "fail" });
    const r = await runPick(h.deps);
    assert.deepEqual(h.recovered, []);
    assert.ok("idle" in r);
  });

  test("a non-zero recover exit logs WARN and is non-fatal", async () => {
    const stale = new Date(NOW - 6000_000).toISOString();
    const h = harness({ issues: [issue(1, [GLM, "in-progress"], { updatedAt: stale })] });
    h.deps.runRecoverStale = async () => 3;
    const r = await runPick(h.deps);
    assert.ok("idle" in r);
    assert.ok(h.logs.some((l) => /WARN recover-stale\.sh exited non-zero/.test(l)));
  });

  test("issue-list failure -> zero candidates -> idle, and the verdict is STILL published", async () => {
    const h = harness({ issues: "fail" });
    const r = await runPick(h.deps);
    assert.deepEqual(r, { idle: true, skipped: {} });
    assert.equal(h.published.length, 1);
    assert.deepEqual(h.published[0], { picked: null, reason: "idle", candidates: 0, skipped: {} });
  });

  test("last-pick is written on an IDLE tick with the skip histogram (GlmUnpickableReason spellings)", async () => {
    const h = harness({
      issues: [
        cand(1, ["glm-withhold"]),
        cand(2, ["cleanup-scan"]),
        cand(3, ["cleanup-scan"]),
        cand(4, [], "plain"),
        cand(5, [], "plain"),
        cand(6, [], "plain"),
        cand(7, [], "plain"),
      ],
      openPrs: [pr(9, { body: "Closes #2" })],
      mergedPrs: [pr(8, { title: "x (#3)" })],
      artifacts: { 5: { status: "draft", createdAt: NOW - 1000 }, 6: { status: "superseded", createdAt: NOW - 1000 }, 7: null as any },
    });
    const r = await runPick(h.deps);
    assert.equal(picked(r), null);
    assert.deepEqual(h.published[0], {
      picked: null,
      reason: "idle",
      candidates: 7,
      skipped: { lane: 1, "open-pr": 1, "merged-pr": 1, "artifact-missing": 2, "artifact-draft": 1, "artifact-stale": 1 },
    });
  });

  test("last-pick is written on a PICKED tick with the admitting reason", async () => {
    const h = harness({ issues: [cand(31, [], "Expected tier: T1")] });
    await runPick(h.deps);
    assert.deepEqual(h.published[0], { picked: 31, reason: "expected-tier-t1", candidates: 1, skipped: {} });
  });

  test("a publish failure never fails the tick", async () => {
    const h = harness({ issues: [cand(32, ["cleanup-scan"])] });
    h.deps.publishLastPick = async () => {
      throw new Error("redis down");
    };
    assert.equal(picked(await runPick(h.deps)), 32);
  });

  test("runPick never throws: a rejecting dependency resolves idle", async () => {
    const h = harness({ issues: [cand(33, ["cleanup-scan"])] });
    h.deps.listOpenPrs = async () => {
      throw new Error("boom");
    };
    const r = await runPick(h.deps);
    assert.ok("idle" in r);
  });
});

// ---------------------------------------------------------------------------
// Dry-run hermeticity
// ---------------------------------------------------------------------------

describe("runPick — dry-run is hermetic", () => {
  test("HYDRA_GLM_DRAINER_DRY_RUN=1 performs no gh/git/subprocess/HTTP/Redis I/O and preserves the log text", async () => {
    const h = harness({ issues: [cand(1, ["cleanup-scan"])], env: { HYDRA_GLM_DRAINER_DRY_RUN: "1" } });
    const r = await runPick(h.deps);
    assert.deepEqual(r, { idle: true, skipped: {}, dryRun: true });
    assert.deepEqual(h.calls, []);
    assert.ok(h.logs.includes("would-pick-eligible-issue (DRY_RUN=1)"));
  });
});

// ---------------------------------------------------------------------------
// D14 — resume-branch rule (pure) + wiring
// ---------------------------------------------------------------------------

describe("pickResumeBranch — newest AHEAD head wins (ported D14 55/56/57 cases)", () => {
  const row = (branch: string, aheadCount: number): ResumeRow => ({ branch, aheadCount, ts: resumeBranchTs(branch) as number });
  const cases: Array<{ name: string; rows: ResumeRow[]; expected: string | null }> = [
    {
      name: "55: 2500 (0 ahead) sits between two ahead heads — newest ahead (3000) wins",
      rows: [row("worktree-agent-glm-55-2000", 1), row("worktree-agent-glm-55-2500", 0), row("worktree-agent-glm-55-3000", 1)],
      expected: "worktree-agent-glm-55-3000",
    },
    {
      name: "56: the newest (4000) is behind — the older ahead 3500 wins",
      rows: [row("worktree-agent-glm-56-4000", 0), row("worktree-agent-glm-56-3500", 1)],
      expected: "worktree-agent-glm-56-3500",
    },
    { name: "57: no pushed drainer branches -> null", rows: [], expected: null },
    { name: "all heads at 0 commits ahead -> null", rows: [row("worktree-agent-glm-58-100", 0)], expected: null },
    {
      name: "ordering is numeric, not lexicographic (900 < 10000)",
      rows: [row("worktree-agent-glm-59-900", 2), row("worktree-agent-glm-59-10000", 1)],
      expected: "worktree-agent-glm-59-10000",
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(pickResumeBranch(c.rows)?.branch ?? null, c.expected);
    });
  }

  test("resumeBranchTs: numeric trailing suffix, null otherwise", () => {
    assert.equal(resumeBranchTs("worktree-agent-glm-55-3000"), 3000);
    assert.equal(resumeBranchTs("worktree-agent-glm-55-abc"), null);
  });
});

describe("runPick — resume branch rides on the pick", () => {
  test("the picked issue carries resumeBranch + resumeCommits from the injected listing", async () => {
    const h = harness({
      issues: [cand(55, ["cleanup-scan"])],
      resume: { 55: [{ branch: "worktree-agent-glm-55-3000", aheadCount: 3, ts: 3000 }] },
    });
    const r = await runPick(h.deps);
    assert.deepEqual(r, { issue: 55, reason: "cleanup-scan", resumeBranch: "worktree-agent-glm-55-3000", resumeCommits: 3 });
  });

  test("no resumable branch -> nulls", async () => {
    const h = harness({ issues: [cand(57, ["cleanup-scan"])] });
    const r = await runPick(h.deps);
    assert.deepEqual(r, { issue: 57, reason: "cleanup-scan", resumeBranch: null, resumeCommits: null });
  });

  test("a resume-listing rejection starts fresh (does not fail the pick)", async () => {
    const h = harness({ issues: [cand(57, ["cleanup-scan"])] });
    h.deps.listResumeRows = async () => {
      throw new Error("git down");
    };
    const r = await runPick(h.deps);
    assert.equal(picked(r), 57);
    assert.equal((r as any).resumeBranch, null);
  });
});

// ---------------------------------------------------------------------------
// Driver `pick` mode + seam parsers
// ---------------------------------------------------------------------------

describe("drainer-driver — pick mode prints one JSON line, exit 0", () => {
  const baseDeps = (pick: PickDeps): DriverDeps => ({ env: {}, pick } as unknown as DriverDeps);

  test("picked outcome", async () => {
    const h = harness({ issues: [cand(5, ["cleanup-scan"])] });
    const out = await runDriverMode(["pick"], baseDeps(h.deps));
    assert.ok(out.ok);
    if (out.ok) {
      assert.equal(out.exitCode, 0);
      assert.deepEqual(JSON.parse(out.line), { issue: 5, reason: "cleanup-scan", resumeBranch: null, resumeCommits: null });
    }
  });

  test("idle outcome", async () => {
    const h = harness({ issues: [] });
    const out = await runDriverMode(["pick"], baseDeps(h.deps));
    assert.ok(out.ok);
    if (out.ok) {
      assert.equal(out.exitCode, 0);
      assert.deepEqual(JSON.parse(out.line), { idle: true, skipped: {} });
    }
  });
});

describe("github seam additions", () => {
  test("parseLsRemoteHeads keeps heads, strips refs/heads/, drops junk", () => {
    const out = parseLsRemoteHeads("abc123\trefs/heads/worktree-agent-glm-1-10\n\ngarbage\ndef456\trefs/tags/v1\n");
    assert.deepEqual(out, [{ sha: "abc123", branch: "worktree-agent-glm-1-10" }]);
  });

  test("parsePrRows carries body only when requested", () => {
    const rows = parsePrRows([{ number: 1, body: "Closes #2" }, { number: 2 }], "o/r");
    assert.equal(rows[0].body, "Closes #2");
    assert.equal("body" in rows[1], false);
  });
});

// ---------------------------------------------------------------------------
// Redis accessor round trip (own top-level lifecycle — CLAUDE.md pitfall)
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

describe("setGlmDrainerLastPick / getGlmDrainerLastPick (hydra:glm:drainer:last-pick)", () => {
  let redis: Redis;
  before(() => {
    redis = new Redis(REDIS_URL);
  });
  after(() => {
    redis.disconnect();
  });
  beforeEach(async () => {
    await redis.del(GLM_DRAINER_LAST_PICK_KEY);
  });

  test("round-trips an idle verdict through the typed accessor with the heartbeat TTL", async () => {
    const r = await setGlmDrainerLastPick({ picked: null, reason: "idle", candidates: 4, skipped: { "open-pr": 2 } }, 1234);
    assert.deepEqual(r, { ok: true });
    assert.equal(GLM_DRAINER_LAST_PICK_KEY, "hydra:glm:drainer:last-pick");
    assert.deepEqual(await getGlmDrainerLastPick(), {
      at: 1234,
      picked: null,
      reason: "idle",
      candidates: 4,
      skipped: { "open-pr": 2 },
    });
    const ttl = await redis.ttl(GLM_DRAINER_LAST_PICK_KEY);
    assert.ok(ttl > 0 && ttl <= GLM_DRAINER_HEARTBEAT_TTL_SECONDS, `ttl ${ttl}`);
  });

  test("absent key reads null", async () => {
    assert.equal(await getGlmDrainerLastPick(), null);
  });
});

describe("runRecoverStaleScript — child stdout never reaches driver stdout (INV-10)", () => {
  test("a recovery tick still emits exactly one parseable JSON line on stdout", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "glm-recover-"));
    const script = join(dir, "recover-stale.sh");
    writeFileSync(script, '#!/usr/bin/env bash\necho "[autopilot] recover-stale: requeued $2"\n');
    const runner = join(dir, "run.mts");
    const pickUrl = new URL("../src/glm/pick.ts", import.meta.url).href;
    writeFileSync(
      runner,
      `import { runRecoverStaleScript } from ${JSON.stringify(pickUrl)};\n` +
        `const code = await runRecoverStaleScript(${JSON.stringify(script)}, [7]);\n` +
        `process.stdout.write(JSON.stringify({ issue: 7, code }) + "\\n");\n` +
        `process.exit(0);\n`,
    );
    const r = spawnSync(process.execPath, ["--experimental-strip-types", runner], { encoding: "utf8" });
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.deepEqual(JSON.parse(lines[0]), { issue: 7, code: 0 });
    assert.match(r.stderr, /\[autopilot\] recover-stale: requeued 7/);
  });
});
