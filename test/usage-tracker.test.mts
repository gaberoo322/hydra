import { test, describe, afterEach, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearUsageCache,
  getUsage,
  getWeeklyQuotaTokens,
  getFiveHourQuotaTokens,
  parseUsageLine,
  cacheHitRatio,
  projectEligibility,
  PACING_SHEDDABLE_CLASSES,
  type UsageSnapshot,
  type TokenBreakdown,
} from "../src/cost/index.ts";

function breakdown(p: Partial<TokenBreakdown> = {}): TokenBreakdown {
  const input = p.input ?? 0;
  const output = p.output ?? 0;
  const cacheRead = p.cacheRead ?? 0;
  const cacheCreation = p.cacheCreation ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    total: p.total ?? input + output + cacheRead + cacheCreation,
  };
}

interface TokenInput {
  in?: number;
  out?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

function assistantLine(ts: string, tokens: TokenInput = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      role: "assistant",
      usage: {
        input_tokens: tokens.in ?? 0,
        output_tokens: tokens.out ?? 0,
        cache_read_input_tokens: tokens.cacheRead ?? 0,
        cache_creation_input_tokens: tokens.cacheCreation ?? 0,
      },
    },
  });
}

async function writeFixture(root: string, relPath: string, lines: string[]): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, lines.join("\n") + "\n", "utf-8");
}

function withEnvSnapshot() {
  const keys = [
    "HYDRA_USAGE_WEEKLY_QUOTA_TOKENS",
    "HYDRA_USAGE_5H_QUOTA_TOKENS",
    "HYDRA_CLAUDE_PROJECTS_ROOT",
  ];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

describe("usage-tracker", () => {
  describe("parseUsageLine", () => {
    test("returns null on malformed JSON", () => {
      assert.equal(parseUsageLine("{not json"), null);
    });

    test("skips non-assistant lines without usage block", () => {
      const line = JSON.stringify({
        type: "user",
        timestamp: "2026-05-25T00:00:00Z",
        message: { role: "user" },
      });
      assert.equal(parseUsageLine(line), "skip");
    });

    test("skips lines without timestamp", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 1 } },
      });
      assert.equal(parseUsageLine(line), "skip");
    });

    test("skips lines with all-zero token counts", () => {
      const line = assistantLine("2026-05-25T00:00:00Z", {});
      assert.equal(parseUsageLine(line), "skip");
    });

    test("parses standard usage block (input + output + cache reads + cache writes)", () => {
      const line = assistantLine("2026-05-25T12:00:00Z", {
        in: 100,
        out: 200,
        cacheRead: 300,
        cacheCreation: 400,
      });
      const result = parseUsageLine(line);
      assert.ok(result !== null && result !== "skip");
      assert.equal(result.tokens.input, 100);
      assert.equal(result.tokens.output, 200);
      assert.equal(result.tokens.cacheRead, 300);
      assert.equal(result.tokens.cacheCreation, 400);
      assert.equal(result.tokens.total, 1000);
      assert.equal(result.tsMs, Date.parse("2026-05-25T12:00:00Z"));
    });

    test("treats missing token fields as zero (not NaN)", () => {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-25T12:00:00Z",
        message: { usage: { output_tokens: 50 } },
      });
      const result = parseUsageLine(line);
      assert.ok(result !== null && result !== "skip");
      assert.equal(result.tokens.input, 0);
      assert.equal(result.tokens.output, 50);
      assert.equal(result.tokens.total, 50);
    });
  });

  describe("cacheHitRatio", () => {
    // Formula: cacheRead / (cacheRead + cacheCreation + input).
    // Output tokens are NEVER in the denominator.

    test("all-cache-read → ratio = 1", () => {
      // Pure cache reads with no creation and no fresh input: every
      // cache-eligible token was a hit.
      const ratio = cacheHitRatio(breakdown({ cacheRead: 1000, output: 500 }));
      assert.equal(ratio, 1);
    });

    test("all-uncached-input → ratio = 0", () => {
      const ratio = cacheHitRatio(breakdown({ input: 1000, output: 500 }));
      assert.equal(ratio, 0);
    });

    test("mixed-realistic case → cacheRead / (cacheRead + cacheCreation + input)", () => {
      // 800 read, 100 created, 100 fresh input, 1000 output (excluded).
      // 800 / (800 + 100 + 100) = 0.8
      const ratio = cacheHitRatio(
        breakdown({ cacheRead: 800, cacheCreation: 100, input: 100, output: 1000 }),
      );
      assert.equal(ratio, 0.8);
    });

    test("zero-total → ratio = 0 (no division by zero)", () => {
      const ratio = cacheHitRatio(breakdown({}));
      assert.equal(ratio, 0);
      assert.ok(Number.isFinite(ratio));
    });

    test("output tokens are NOT in the denominator", () => {
      // Same input/cacheRead, wildly different output: ratio must not move.
      const a = cacheHitRatio(breakdown({ cacheRead: 50, input: 50, output: 0 }));
      const b = cacheHitRatio(breakdown({ cacheRead: 50, input: 50, output: 1_000_000 }));
      assert.equal(a, 0.5);
      assert.equal(b, 0.5);
    });

    test("cacheCreation IS in the denominator (cache-warming cost counted)", () => {
      // 100 read vs 100 created, no input → 100 / 200 = 0.5, not 1.
      const ratio = cacheHitRatio(breakdown({ cacheRead: 100, cacheCreation: 100 }));
      assert.equal(ratio, 0.5);
    });

    test("ratio is always within the closed interval [0, 1]", () => {
      const cases: TokenBreakdown[] = [
        breakdown({}),
        breakdown({ cacheRead: 1 }),
        breakdown({ input: 1 }),
        breakdown({ cacheRead: 3, cacheCreation: 7, input: 13, output: 999 }),
      ];
      for (const c of cases) {
        const r = cacheHitRatio(c);
        assert.ok(r >= 0 && r <= 1, `ratio ${r} out of [0,1] for ${JSON.stringify(c)}`);
      }
    });
  });

  describe("getUsage cache-hit ratio fields", () => {
    let root: string;
    let restore: () => void;
    beforeEach(async () => {
      restore = withEnvSnapshot();
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      root = await mkdtemp(join(tmpdir(), "usage-cache-ratio-"));
      clearUsageCache();
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
      restore();
      clearUsageCache();
    });

    test("snapshot carries cacheHitRatioLast5h / cacheHitRatioLast7d derived from the accumulators", async () => {
      const now = new Date("2026-05-25T12:00:00Z");
      // One in-5h line: 800 read, 100 created, 100 input → 0.8.
      await writeFixture(root, "p/recent.jsonl", [
        assistantLine("2026-05-25T11:00:00Z", {
          cacheRead: 800,
          cacheCreation: 100,
          in: 100,
          out: 5000,
        }),
      ]);
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      assert.equal(snap.cacheHitRatioLast5h, 0.8);
      assert.equal(snap.cacheHitRatioLast7d, 0.8);
      assert.ok(snap.cacheHitRatioLast5h >= 0 && snap.cacheHitRatioLast5h <= 1);
    });

    test("empty snapshot reports cache-hit ratios of 0 (no division by zero)", async () => {
      const now = new Date("2026-05-25T12:00:00Z");
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      assert.equal(snap.cacheHitRatioLast5h, 0);
      assert.equal(snap.cacheHitRatioLast7d, 0);
    });
  });

  describe("quota env parsing", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = withEnvSnapshot();
    });
    afterEach(() => restore());

    test("returns 0 when unset", () => {
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      assert.equal(getWeeklyQuotaTokens(), 0);
      assert.equal(getFiveHourQuotaTokens(), 0);
    });

    test("returns 0 on non-finite or non-positive values", () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "abc";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "-5";
      assert.equal(getWeeklyQuotaTokens(), 0);
      assert.equal(getFiveHourQuotaTokens(), 0);
    });

    test("returns positive parsed value when set", () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "50000";
      assert.equal(getWeeklyQuotaTokens(), 1_000_000);
      assert.equal(getFiveHourQuotaTokens(), 50_000);
    });
  });

  describe("getUsage scanning", () => {
    let restore: () => void;

    beforeEach(() => {
      restore = withEnvSnapshot();
      clearUsageCache();
    });

    afterEach(() => {
      restore();
      clearUsageCache();
    });

    test("sums tokens across files within each rolling window", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const oneHourAgo = "2026-05-25T11:00:00Z";
        const sixHoursAgo = "2026-05-25T06:00:00Z"; // outside 5h, inside 7d
        const tenDaysAgo = "2026-05-15T12:00:00Z"; // outside 7d

        await writeFixture(root, "proj-a/session-1.jsonl", [
          assistantLine(oneHourAgo, { in: 100, out: 200 }),
          assistantLine(sixHoursAgo, { in: 50, out: 50 }),
          assistantLine(tenDaysAgo, { in: 999_999, out: 999_999 }),
        ]);
        // Subagent transcripts also count (nested under session dir).
        await writeFixture(root, "proj-a/session-1/subagents/agent-x.jsonl", [
          assistantLine(oneHourAgo, { cacheRead: 1000, cacheCreation: 500 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        // 5h window: oneHourAgo entries only.
        //   primary: 100 + 200 = 300
        //   subagent: 1000 + 500 = 1500
        assert.equal(snap.tokensLast5h.total, 1800);
        assert.equal(snap.tokensLast5h.input, 100);
        assert.equal(snap.tokensLast5h.output, 200);
        assert.equal(snap.tokensLast5h.cacheRead, 1000);
        assert.equal(snap.tokensLast5h.cacheCreation, 500);

        // 7d window: + sixHoursAgo (50 + 50).
        assert.equal(snap.tokensLast7d.total, 1900);

        // 10-days-ago line excluded from totals (but still counts toward
        // linesWithUsage — that counter tracks parseability, not window
        // membership).
        assert.ok(snap.tokensLast7d.total < 999_999);
        assert.equal(snap.linesWithUsage, 4);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("uncalibrated snapshot reports raw tokens but zero percent + 'under' pacing + no emergencyStop", async () => {
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 1000, out: 1000 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.calibrated, false);
        assert.equal(snap.percentLast5h, 0);
        assert.equal(snap.percentLast7d, 0);
        assert.equal(snap.projectedWeeklyPercent, 0);
        assert.equal(snap.pacingState, "under");
        assert.equal(snap.emergencyStop, false);
        assert.equal(snap.tokensLast5h.total, 2000); // raw still reported
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: emergencyStop fires once percentLast5h >= 90", async () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 900, out: 50 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.calibrated, true);
        assert.equal(snap.tokensLast5h.total, 950);
        assert.equal(snap.percentLast5h, 95);
        assert.equal(snap.emergencyStop, true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: emergencyStop does NOT fire when 5h consumption is well under 90%", async () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 500, out: 500 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.percentLast5h, 10);
        assert.equal(snap.emergencyStop, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: pacingState 'over' when projectedWeeklyPercent > 100", async () => {
      // 24h tokens × 7 = 14k; weekly = 7k → projected 200%.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "7000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 1000, out: 1000 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.tokensLast24h, 2000);
        assert.equal(snap.projectedWeeklyPercent, 200);
        assert.equal(snap.pacingState, "over");
        assert.equal(snap.emergencyStop, false); // 5h quota is huge
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: pacingState 'on' when projectedWeeklyPercent in [80, 100]", async () => {
      // 24h: 2000 tokens; quota 16800 → projected = 2000*7/16800 ≈ 83.3%.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "16800";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 1000, out: 1000 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.ok(snap.projectedWeeklyPercent >= 80 && snap.projectedWeeklyPercent < 100);
        assert.equal(snap.pacingState, "on");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: pacingState 'under' when projectedWeeklyPercent < 80", async () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 1000, out: 1000 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.ok(snap.projectedWeeklyPercent < 80);
        assert.equal(snap.pacingState, "under");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("skips malformed JSON lines and counts them", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          "{not json",
          assistantLine("2026-05-25T11:00:00Z", { in: 100 }),
          "{also not json}",
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.tokensLast7d.total, 100);
        assert.equal(snap.parseErrors, 2);
        assert.equal(snap.linesWithUsage, 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("missing projects root does not throw", async () => {
      const snap = await getUsage({
        now: new Date("2026-05-25T12:00:00Z"),
        projectsRoot: "/does/not/exist/anywhere",
        force: true,
      });
      assert.equal(snap.tokensLast7d.total, 0);
      assert.equal(snap.filesScanned, 0);
    });

    test("memoizes within the 60s TTL when projectsRoot is not overridden", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        process.env.HYDRA_CLAUDE_PROJECTS_ROOT = root;
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 100 }),
        ]);

        const a = await getUsage({ now: new Date("2026-05-25T12:00:00Z") });
        assert.equal(a.tokensLast7d.total, 100);

        // Add tokens — second call should hit the cache and miss them.
        await writeFixture(root, "p/s2.jsonl", [
          assistantLine("2026-05-25T11:30:00Z", { in: 999 }),
        ]);
        const b = await getUsage({ now: new Date("2026-05-25T12:00:00.500Z") });
        assert.equal(b.tokensLast7d.total, 100, "cache served stale value");

        // force: true bypasses.
        const c = await getUsage({
          now: new Date("2026-05-25T12:00:00.501Z"),
          force: true,
        });
        assert.equal(c.tokensLast7d.total, 100 + 999);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("projectEligibility", () => {
    function snapshotWith(overrides: Partial<UsageSnapshot>): UsageSnapshot {
      const empty = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
      const base: UsageSnapshot = {
        tokensLast5h: empty,
        tokensLast7d: empty,
        tokensLast24h: 0,
        percentLast5h: 0,
        percentLast7d: 0,
        projectedWeeklyPercent: 0,
        pacingState: "under",
        emergencyStop: false,
        calibrated: false,
        weeklyQuotaTokens: 0,
        fiveHourQuotaTokens: 0,
        filesScanned: 0,
        filesSkippedByMtime: 0,
        linesParsed: 0,
        linesWithUsage: 0,
        parseErrors: 0,
        generatedAt: "2026-05-26T00:00:00.000Z",
      };
      return { ...base, ...overrides };
    }

    test("uncalibrated: allow=true, shed=[], pacing/emergency false", () => {
      const v = projectEligibility(snapshotWith({ calibrated: false }));
      assert.equal(v.allow, true);
      assert.deepEqual([...v.shed], []);
      assert.equal(v.reasons.emergencyStop, false);
      assert.equal(v.reasons.pacingShed, false);
      assert.equal(v.reasons.calibrated, false);
    });

    test("calibrated + under: allow=true, shed=[]", () => {
      const v = projectEligibility(
        snapshotWith({ calibrated: true, pacingState: "under", emergencyStop: false })
      );
      assert.equal(v.allow, true);
      assert.deepEqual([...v.shed], []);
      assert.equal(v.reasons.pacingShed, false);
    });

    test("calibrated + on (80–100%): allow=true, shed=[] — 'on' is informational only", () => {
      const v = projectEligibility(
        snapshotWith({ calibrated: true, pacingState: "on", emergencyStop: false })
      );
      assert.equal(v.allow, true);
      assert.deepEqual([...v.shed], []);
      assert.equal(v.reasons.pacingShed, false);
    });

    test("calibrated + over: allow=true, shed includes all sheddable classes", () => {
      const v = projectEligibility(
        snapshotWith({ calibrated: true, pacingState: "over", emergencyStop: false })
      );
      assert.equal(v.allow, true);
      // Sheddable list should match the exported constant exactly.
      assert.deepEqual([...v.shed], [...PACING_SHEDDABLE_CLASSES]);
      assert.equal(v.reasons.pacingShed, true);
      // Sanity: dev_* and qa_* are never shed.
      assert.equal(v.shed.includes("dev_orch"), false);
      assert.equal(v.shed.includes("dev_target"), false);
      assert.equal(v.shed.includes("qa_orch"), false);
      assert.equal(v.shed.includes("health"), false);
    });

    test("calibrated + emergencyStop: allow=false (regardless of pacing)", () => {
      const v = projectEligibility(
        snapshotWith({ calibrated: true, pacingState: "under", emergencyStop: true })
      );
      assert.equal(v.allow, false);
      assert.equal(v.reasons.emergencyStop, true);
    });

    test("calibrated + emergencyStop + over: allow=false AND shed populated (emergency takes precedence semantically)", () => {
      const v = projectEligibility(
        snapshotWith({ calibrated: true, pacingState: "over", emergencyStop: true })
      );
      assert.equal(v.allow, false);
      // shed is still populated — callers MUST honor `allow` first; if
      // they did go ahead, the shed list remains the right second filter.
      assert.deepEqual([...v.shed], [...PACING_SHEDDABLE_CLASSES]);
    });
  });
});
