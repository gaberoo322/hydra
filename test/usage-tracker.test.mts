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
  getOAuthUsageTtlMs,
  getOAuthUsageMaxStaleMs,
  DEFAULT_OAUTH_USAGE_TTL_MS,
  modelToFamily,
  parseUsageLine,
  parseObservedResetMs,
  cacheHitRatio,
  projectEligibility,
  projectResetWindow,
  getWeeklyResetAnchorMs,
  getWeeklyPaceCeiling,
  DEFAULT_WEEKLY_PACE_CEILING,
  PACE_STATE_TOLERANCE_PERCENT,
  getCacheReadWeight,
  DEFAULT_CACHE_READ_WEIGHT,
  weightedTokens,
  getDriftReferencePercent,
  getDriftFactor,
  DEFAULT_DRIFT_FACTOR,
  sessionIdFromPath,
  PACING_SHEDDABLE_CLASSES,
  fiveHourThrottleShed,
  FIVE_HOUR_THROTTLE_T1_CLASSES,
  FIVE_HOUR_THROTTLE_T2_CLASSES,
  DEFAULT_FIVE_HOUR_THROTTLE_T1,
  DEFAULT_FIVE_HOUR_THROTTLE_T2,
  UNATTRIBUTED_SKILL,
  overlayPauseEligibility,
  overlaySessionBlockEligibility,
  parseSessionLimitReset,
  type UsageSnapshot,
  type UsageEligibility,
  type TokenBreakdown,
  type SkillResolver,
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

function assistantLine(ts: string, tokens: TokenInput = {}, model?: string): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    usage: {
      input_tokens: tokens.in ?? 0,
      output_tokens: tokens.out ?? 0,
      cache_read_input_tokens: tokens.cacheRead ?? 0,
      cache_creation_input_tokens: tokens.cacheCreation ?? 0,
    },
  };
  if (model !== undefined) message.model = model;
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message,
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
    "HYDRA_USAGE_WEEKLY_RESET_ANCHOR",
    "HYDRA_USAGE_WEEKLY_PACE_CEILING",
    "HYDRA_CLAUDE_PROJECTS_ROOT",
    "HYDRA_QUOTA_WEIGHT_OPUS",
    "HYDRA_QUOTA_WEIGHT_SONNET",
    "HYDRA_QUOTA_WEIGHT_HAIKU",
    "HYDRA_USAGE_CACHE_READ_WEIGHT",
    "HYDRA_USAGE_DRIFT_REFERENCE_PERCENT",
    "HYDRA_USAGE_DRIFT_FACTOR",
    "HYDRA_OAUTH_USAGE_TTL_MS",
    "HYDRA_OAUTH_USAGE_MAX_STALE_MS",
    "HYDRA_USAGE_5H_THROTTLE_T1",
    "HYDRA_USAGE_5H_THROTTLE_T2",
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

    test("surfaces the model string when present", () => {
      const line = assistantLine("2026-05-25T12:00:00Z", { in: 10 }, "claude-opus-4-7");
      const result = parseUsageLine(line);
      assert.ok(result !== null && result !== "skip");
      assert.equal(result.model, "claude-opus-4-7");
    });

    test("model defaults to empty string when absent", () => {
      const line = assistantLine("2026-05-25T12:00:00Z", { in: 10 });
      const result = parseUsageLine(line);
      assert.ok(result !== null && result !== "skip");
      assert.equal(result.model, "");
    });
  });

  describe("modelToFamily", () => {
    test("maps observed opus/sonnet/haiku strings by prefix", () => {
      assert.equal(modelToFamily("claude-opus-4-6"), "opus");
      assert.equal(modelToFamily("claude-opus-4-7"), "opus");
      assert.equal(modelToFamily("claude-sonnet-4-6"), "sonnet");
      assert.equal(modelToFamily("claude-haiku-4-5"), "haiku");
    });

    test("is case-insensitive on the prefix", () => {
      assert.equal(modelToFamily("Claude-Opus-4-7"), "opus");
    });

    test("falls back to unknown for non-claude / synthetic / missing strings", () => {
      assert.equal(modelToFamily("<synthetic>"), "unknown");
      assert.equal(modelToFamily("gpt-5.5"), "unknown");
      assert.equal(modelToFamily(""), "unknown");
      assert.equal(modelToFamily(null), "unknown");
      assert.equal(modelToFamily(undefined), "unknown");
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

    test("byModel buckets tokens per family by prefix, including unknown fallback (always populated)", async () => {
      delete process.env.HYDRA_QUOTA_WEIGHT_OPUS;
      delete process.env.HYDRA_QUOTA_WEIGHT_SONNET;
      delete process.env.HYDRA_QUOTA_WEIGHT_HAIKU;

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/s.jsonl", [
          assistantLine(t, { in: 100, out: 100 }, "claude-opus-4-7"), // opus 200
          assistantLine(t, { in: 50 }, "claude-opus-4-6"), // opus 50
          assistantLine(t, { in: 30 }, "claude-sonnet-4-6"), // sonnet 30
          assistantLine(t, { in: 10 }, "claude-haiku-4-5"), // haiku 10
          assistantLine(t, { in: 5 }, "<synthetic>"), // unknown 5
          assistantLine(t, { in: 7 }), // no model -> unknown 7
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        // All four keys present (invariant: always populated).
        assert.ok(snap.byModel.opus);
        assert.ok(snap.byModel.sonnet);
        assert.ok(snap.byModel.haiku);
        assert.ok(snap.byModel.unknown);

        assert.equal(snap.byModel.opus.total, 250);
        assert.equal(snap.byModel.sonnet.total, 30);
        assert.equal(snap.byModel.haiku.total, 10);
        assert.equal(snap.byModel.unknown.total, 12);

        // Sum of families equals the 7d aggregate.
        assert.equal(snap.tokensLast7d.total, 250 + 30 + 10 + 12);

        // Uncalibrated quota-weight: byModel still populated, weights are 0.
        assert.equal(snap.quotaWeightCalibrated, false);
        assert.equal(snap.quotaWeightLast5h, 0);
        assert.equal(snap.quotaWeightLast7d, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("byModel families are all zero-valued when no tokens were recorded", async () => {
      const snap = await getUsage({
        now: new Date("2026-05-25T12:00:00Z"),
        projectsRoot: "/does/not/exist/anywhere",
        force: true,
      });
      for (const family of ["opus", "sonnet", "haiku", "unknown"] as const) {
        assert.equal(snap.byModel[family].total, 0);
        assert.equal(snap.byModel[family].input, 0);
      }
    });

    test("quotaWeight* stays 0 when only some of the three weights are set", async () => {
      process.env.HYDRA_QUOTA_WEIGHT_OPUS = "5";
      process.env.HYDRA_QUOTA_WEIGHT_SONNET = "1";
      delete process.env.HYDRA_QUOTA_WEIGHT_HAIKU; // missing -> uncalibrated

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 100 }, "claude-opus-4-7"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.quotaWeightCalibrated, false);
        assert.equal(snap.quotaWeightLast5h, 0);
        assert.equal(snap.quotaWeightLast7d, 0);
        // byModel is unaffected by calibration.
        assert.equal(snap.byModel.opus.total, 100);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("quotaWeight* computes the weighted family total when all three weights are set (unknown weight 1.0)", async () => {
      process.env.HYDRA_QUOTA_WEIGHT_OPUS = "5";
      process.env.HYDRA_QUOTA_WEIGHT_SONNET = "1";
      process.env.HYDRA_QUOTA_WEIGHT_HAIKU = "0.2";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const oneHourAgo = "2026-05-25T11:00:00Z"; // inside 5h + 7d
        const sixHoursAgo = "2026-05-25T06:00:00Z"; // inside 7d only
        await writeFixture(root, "p/s.jsonl", [
          assistantLine(oneHourAgo, { in: 1000 }, "claude-opus-4-7"), // opus 1000
          assistantLine(oneHourAgo, { in: 1000 }, "claude-sonnet-4-6"), // sonnet 1000
          assistantLine(oneHourAgo, { in: 1000 }, "claude-haiku-4-5"), // haiku 1000
          assistantLine(oneHourAgo, { in: 1000 }, "<synthetic>"), // unknown 1000
          assistantLine(sixHoursAgo, { in: 500 }, "claude-opus-4-6"), // opus 500 (7d only)
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.quotaWeightCalibrated, true);

        // 5h: opus 1000*5 + sonnet 1000*1 + haiku 1000*0.2 + unknown 1000*1.0
        //   = 5000 + 1000 + 200 + 1000 = 7200
        assert.equal(snap.quotaWeightLast5h, 7200);

        // 7d: + opus 500*5 = 2500 more -> 9700
        assert.equal(snap.quotaWeightLast7d, 9700);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("unknown-family records trigger a once-per-scan console.warn (not per-line)", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/s.jsonl", [
          assistantLine(t, { in: 5 }, "<synthetic>"),
          assistantLine(t, { in: 5 }, "<synthetic>"),
          assistantLine(t, { in: 5 }, "gpt-5.5"),
          assistantLine(t, { in: 5 }, "claude-opus-4-7"),
        ]);

        await getUsage({ now, projectsRoot: root, force: true });

        const trackerWarnings = warnings.filter((w) => w.includes("[usage-tracker]"));
        assert.equal(trackerWarnings.length, 1, "expected exactly one warn per scan");
        assert.ok(trackerWarnings[0].includes("unrecognised model"));
      } finally {
        console.warn = originalWarn;
        await rm(root, { recursive: true, force: true });
      }
    });

    test("no unknown-model warn fires when every model string is recognised", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 5 }, "claude-opus-4-7"),
          assistantLine("2026-05-25T11:00:00Z", { in: 5 }, "claude-sonnet-4-6"),
        ]);

        await getUsage({ now, projectsRoot: root, force: true });
        const trackerWarnings = warnings.filter((w) => w.includes("[usage-tracker]"));
        assert.equal(trackerWarnings.length, 0);
      } finally {
        console.warn = originalWarn;
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("sessionIdFromPath", () => {
    test("derives the sessionId from the transcript filename basename", () => {
      assert.equal(
        sessionIdFromPath("/root/proj/38c78e5c-884f-47ae-acb4-5d48286776b3.jsonl"),
        "38c78e5c-884f-47ae-acb4-5d48286776b3",
      );
    });

    test("works on a bare filename", () => {
      assert.equal(sessionIdFromPath("abc.jsonl"), "abc");
    });
  });

  describe("bySkillByModel cross-tab (issue #693)", () => {
    // A SkillResolver backed by a fixed sessionId -> skill map; null for
    // sessions absent from the map (the unattributed case). Records calls so
    // the O(files) resolution invariant can be asserted.
    function fakeResolver(
      map: Record<string, string>,
      calls?: string[],
    ): SkillResolver {
      return async (sessionId: string) => {
        if (calls) calls.push(sessionId);
        return map[sessionId] ?? null;
      };
    }

    test("buckets each session's 7d tokens under its resolved skill × family", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        // sess-dev.jsonl -> hydra-dev; sess-qa.jsonl -> hydra-qa.
        await writeFixture(root, "p/sess-dev.jsonl", [
          assistantLine(t, { in: 100 }, "claude-opus-4-7"), // opus 100
          assistantLine(t, { in: 40 }, "claude-sonnet-4-6"), // sonnet 40
        ]);
        await writeFixture(root, "p/sess-qa.jsonl", [
          assistantLine(t, { in: 25 }, "claude-haiku-4-5"), // haiku 25
          assistantLine(t, { in: 60 }, "claude-opus-4-7"), // opus 60
        ]);

        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          resolveSkill: fakeResolver({
            "sess-dev": "hydra-dev",
            "sess-qa": "hydra-qa",
          }),
        });

        assert.ok(snap.bySkillByModel["hydra-dev"]);
        assert.ok(snap.bySkillByModel["hydra-qa"]);
        assert.equal(snap.bySkillByModel["hydra-dev"].opus.total, 100);
        assert.equal(snap.bySkillByModel["hydra-dev"].sonnet.total, 40);
        assert.equal(snap.bySkillByModel["hydra-dev"].haiku.total, 0);
        assert.equal(snap.bySkillByModel["hydra-qa"].haiku.total, 25);
        assert.equal(snap.bySkillByModel["hydra-qa"].opus.total, 60);
        // No spurious unattributed bucket when every session resolved.
        assert.equal(snap.bySkillByModel[UNATTRIBUTED_SKILL], undefined);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("sessions without a registry entry bucket under 'unattributed'", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/known.jsonl", [
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
        ]);
        await writeFixture(root, "p/legacy.jsonl", [
          assistantLine(t, { in: 70 }, "claude-sonnet-4-6"),
        ]);

        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          resolveSkill: fakeResolver({ known: "hydra-dev" }), // legacy unmapped
        });

        assert.equal(snap.bySkillByModel["hydra-dev"].opus.total, 100);
        assert.ok(snap.bySkillByModel[UNATTRIBUTED_SKILL]);
        assert.equal(snap.bySkillByModel[UNATTRIBUTED_SKILL].sonnet.total, 70);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("reconciliation: Σ over skills of bySkillByModel[*][f] === byModel[f] per family", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/a.jsonl", [
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
          assistantLine(t, { in: 30 }, "claude-sonnet-4-6"),
        ]);
        await writeFixture(root, "p/b.jsonl", [
          assistantLine(t, { in: 50 }, "claude-opus-4-6"),
          assistantLine(t, { in: 9 }, "<synthetic>"), // unknown
        ]);
        await writeFixture(root, "p/c.jsonl", [
          assistantLine(t, { in: 11 }, "claude-haiku-4-5"),
        ]);

        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          resolveSkill: fakeResolver({ a: "hydra-dev", b: "hydra-qa" }), // c unattributed
        });

        for (const family of ["opus", "sonnet", "haiku", "unknown"] as const) {
          for (const field of [
            "input",
            "output",
            "cacheRead",
            "cacheCreation",
            "total",
          ] as const) {
            const summed = Object.values(snap.bySkillByModel).reduce(
              (acc, row) => acc + row[family][field],
              0,
            );
            assert.equal(
              summed,
              snap.byModel[family][field],
              `cross-tab must reconcile to byModel for ${family}.${field}`,
            );
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("resolves the skill at most once per transcript file (O(files), not O(lines))", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        // 4 token-bearing lines in one file -> still exactly one resolution.
        await writeFixture(root, "p/sess.jsonl", [
          assistantLine(t, { in: 10 }, "claude-opus-4-7"),
          assistantLine(t, { in: 10 }, "claude-opus-4-7"),
          assistantLine(t, { in: 10 }, "claude-sonnet-4-6"),
          assistantLine(t, { in: 10 }, "claude-haiku-4-5"),
        ]);

        const calls: string[] = [];
        await getUsage({
          now,
          projectsRoot: root,
          force: true,
          resolveSkill: fakeResolver({ sess: "hydra-dev" }, calls),
        });

        assert.deepEqual(calls, ["sess"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibration discipline preserved: uncalibrated still populates raw cross-tab cells, no weighting", async () => {
      delete process.env.HYDRA_QUOTA_WEIGHT_OPUS;
      delete process.env.HYDRA_QUOTA_WEIGHT_SONNET;
      delete process.env.HYDRA_QUOTA_WEIGHT_HAIKU;

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/sess.jsonl", [
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
        ]);

        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          resolveSkill: fakeResolver({ sess: "hydra-dev" }),
        });

        // Raw cross-tab cell populated regardless of weight calibration.
        assert.equal(snap.bySkillByModel["hydra-dev"].opus.total, 100);
        // No quota-weight env -> uncalibrated -> no weighted burn.
        assert.equal(snap.quotaWeightCalibrated, false);
        assert.equal(snap.quotaWeightLast7d, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("empty when no transcripts produced in-window tokens", async () => {
      const snap = await getUsage({
        now: new Date("2026-05-25T12:00:00Z"),
        projectsRoot: "/does/not/exist/anywhere",
        force: true,
        resolveSkill: fakeResolver({}),
      });
      assert.deepEqual(snap.bySkillByModel, {});
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
        usageSource: "estimate",
        oauthError: null,
        oauthStale: false,
        oauthAgeMs: null,
        oauthFiveHourResetsAt: null,
        oauthSevenDayResetsAt: null,
        projectedWeeklyPercent: 0,
        pacingState: "under",
        emergencyStop: false,
        weeklyEmergencyStop: false,
        calibrated: false,
        byModel: {
          opus: { ...empty },
          sonnet: { ...empty },
          haiku: { ...empty },
          unknown: { ...empty },
        },
        bySkillByModel: {},
        quotaWeightLast5h: 0,
        quotaWeightLast7d: 0,
        quotaWeightCalibrated: false,
        weeklyQuotaTokens: 0,
        fiveHourQuotaTokens: 0,
        filesScanned: 0,
        filesSkippedByMtime: 0,
        linesParsed: 0,
        linesWithUsage: 0,
        parseErrors: 0,
        generatedAt: "2026-05-26T00:00:00.000Z",
        cacheHitRatioLast5h: 0,
        cacheHitRatioLast7d: 0,
        tokensSinceReset: { ...empty },
        percentSinceReset: 0,
        weeklyResetAnchor: null,
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

    test("calibrated + weeklyEmergencyStop: allow=false (weekly hard-stop blocks every class)", () => {
      const v = projectEligibility(
        snapshotWith({
          calibrated: true,
          pacingState: "under",
          emergencyStop: false,
          weeklyEmergencyStop: true,
        })
      );
      assert.equal(v.allow, false);
      assert.equal(v.reasons.weeklyEmergencyStop, true);
      assert.equal(v.reasons.emergencyStop, false);
    });

    test("weeklyEmergencyStop is independent of the 5h emergencyStop", () => {
      // 5h fine, weekly exhausted → still blocked.
      assert.equal(
        projectEligibility(
          snapshotWith({ calibrated: true, emergencyStop: false, weeklyEmergencyStop: true })
        ).allow,
        false
      );
      // weekly fine, 5h exhausted → still blocked.
      assert.equal(
        projectEligibility(
          snapshotWith({ calibrated: true, emergencyStop: true, weeklyEmergencyStop: false })
        ).allow,
        false
      );
      // both fine → allowed.
      assert.equal(
        projectEligibility(
          snapshotWith({ calibrated: true, emergencyStop: false, weeklyEmergencyStop: false })
        ).allow,
        true
      );
    });

    // -----------------------------------------------------------------------
    // Graduated 5h-utilization throttle (issue #1087, builds on #1085).
    // Pure function of the OAuth `percentLast5h` + the T1/T2 env thresholds.
    // Defaults: T1=0.60, T2=0.75. Inert on the transcript `estimate`.
    // -----------------------------------------------------------------------
    describe("graduated 5h throttle", () => {
      const restore = withEnvSnapshot();
      beforeEach(() => {
        delete process.env.HYDRA_USAGE_5H_THROTTLE_T1;
        delete process.env.HYDRA_USAGE_5H_THROTTLE_T2;
      });
      afterEach(() => restore());

      function oauthSnap(percentLast5h: number): UsageSnapshot {
        return snapshotWith({
          calibrated: true,
          usageSource: "oauth",
          percentLast5h,
          // keep pacing/emergency inert so we isolate the 5h throttle
          pacingState: "under",
          emergencyStop: false,
          weeklyEmergencyStop: false,
        });
      }

      const T1 = new Set(FIVE_HOUR_THROTTLE_T1_CLASSES);
      const T1T2 = new Set([
        ...FIVE_HOUR_THROTTLE_T1_CLASSES,
        ...FIVE_HOUR_THROTTLE_T2_CLASSES,
      ]);

      test("defaults are 0.60 / 0.75", () => {
        assert.equal(DEFAULT_FIVE_HOUR_THROTTLE_T1, 0.6);
        assert.equal(DEFAULT_FIVE_HOUR_THROTTLE_T2, 0.75);
      });

      test("below T1 (59%): no shed", () => {
        assert.deepEqual([...fiveHourThrottleShed(oauthSnap(59))], []);
        const v = projectEligibility(oauthSnap(59));
        assert.deepEqual([...v.shed], []);
        assert.equal(v.reasons.fiveHourThrottleShed, false);
        assert.equal(v.allow, true);
      });

      test("exactly at T1 (60%): T1 set sheds (boundary is inclusive)", () => {
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(60))), T1);
        const v = projectEligibility(oauthSnap(60));
        assert.deepEqual(new Set(v.shed), T1);
        assert.equal(v.reasons.fiveHourThrottleShed, true);
        // dev_orch / qa_* / dev_target NOT shed at T1.
        assert.equal(v.shed.includes("dev_orch"), false);
        assert.equal(v.shed.includes("dev_target"), false);
        assert.equal(v.shed.includes("qa_orch"), false);
        assert.equal(v.shed.includes("qa_target"), false);
      });

      test("between T1 and T2 (70%): only the T1 set", () => {
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(70))), T1);
      });

      test("exactly at T2 (75%): T1 ∪ T2; dev_orch shed but qa_* + dev_target kept", () => {
        const shed = new Set(fiveHourThrottleShed(oauthSnap(75)));
        assert.deepEqual(shed, T1T2);
        assert.equal(shed.has("dev_orch"), true);
        assert.equal(shed.has("design_concept_orch"), true);
        assert.equal(shed.has("qa_orch"), false);
        assert.equal(shed.has("qa_target"), false);
        assert.equal(shed.has("dev_target"), false);
      });

      test("above T2 (89%, below 90% emergency): T1 ∪ T2, still allow=true", () => {
        const v = projectEligibility(oauthSnap(89));
        assert.deepEqual(new Set(v.shed), T1T2);
        assert.equal(v.reasons.fiveHourThrottleShed, true);
        assert.equal(v.allow, true);
      });

      test("usageSource=estimate: inert even above T2", () => {
        const snap = snapshotWith({
          calibrated: true,
          usageSource: "estimate",
          percentLast5h: 88,
          pacingState: "under",
        });
        assert.deepEqual([...fiveHourThrottleShed(snap)], []);
        const v = projectEligibility(snap);
        assert.deepEqual([...v.shed], []);
        assert.equal(v.reasons.fiveHourThrottleShed, false);
      });

      test("env override: custom T1/T2 thresholds honoured", () => {
        process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0.40";
        process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "0.50";
        // 45% now crosses the custom T1 but not the custom T2.
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(45))), T1);
        // 55% crosses both.
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(55))), T1T2);
        // 35% below custom T1 → no shed.
        assert.deepEqual([...fiveHourThrottleShed(oauthSnap(35))], []);
      });

      test("set-but-invalid env falls back to default (fail-loud, no throw)", () => {
        process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "not-a-number";
        process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "1.5"; // >=1 invalid
        // Falls back to 0.60 / 0.75: 70% → T1 only.
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(70))), T1);
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(80))), T1T2);
      });

      test("mis-set T2 < T1: T2 cut never inverts below T1", () => {
        process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0.70";
        process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "0.50";
        // T1=70, T2 clamped up to max(70,50)=70. At 65% → no shed.
        assert.deepEqual([...fiveHourThrottleShed(oauthSnap(65))], []);
        // At 72% → both tiers fire together (T2 boundary == T1 boundary).
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(72))), T1T2);
      });

      test("composes with pacing shed (union, de-duped)", () => {
        // pacingState 'over' + 5h above T1 → union of both lists, no dupes.
        const snap = snapshotWith({
          calibrated: true,
          usageSource: "oauth",
          percentLast5h: 65,
          pacingState: "over",
          emergencyStop: false,
        });
        const v = projectEligibility(snap);
        const expected = new Set([
          ...PACING_SHEDDABLE_CLASSES,
          ...FIVE_HOUR_THROTTLE_T1_CLASSES,
        ]);
        assert.deepEqual(new Set(v.shed), expected);
        // No duplicate entries (discover_orch is in BOTH lists).
        assert.equal(v.shed.length, new Set(v.shed).size);
        assert.equal(v.reasons.pacingShed, true);
        assert.equal(v.reasons.fiveHourThrottleShed, true);
      });

      test("emergencyStop (>=90%) supersedes: allow=false", () => {
        const snap = snapshotWith({
          calibrated: true,
          usageSource: "oauth",
          percentLast5h: 95,
          emergencyStop: true,
        });
        const v = projectEligibility(snap);
        assert.equal(v.allow, false);
      });
    });

    // -----------------------------------------------------------------------
    // Pacing Curve verdict (issue #857, ADR-0021). ADDITIVE fields on the
    // eligibility projection: paceState / targetPercent / sinceResetPercent /
    // anchor. `now` is derived from snapshot.generatedAt so the projection
    // stays a pure function of the snapshot.
    // -----------------------------------------------------------------------
    describe("Pacing Curve", () => {
      const restore = withEnvSnapshot();
      // Use the default ceiling (0.92) unless a test overrides it.
      beforeEach(() => {
        delete process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING;
      });
      afterEach(() => restore());

      const DAY = 86_400_000;
      const isoOf = (ms: number) => new Date(ms).toISOString();
      const anchorMs = Date.parse("2026-05-25T00:00:00.000Z");

      // Build a snapshot with an Anchor boundary and a `now` (generatedAt)
      // some fraction into the 7-day window, plus a percentSinceReset.
      function curveSnap(opts: {
        nowMs: number;
        sinceResetPercent: number;
        anchorIso?: string | null;
      }): UsageSnapshot {
        return snapshotWith({
          calibrated: true,
          generatedAt: isoOf(opts.nowMs),
          weeklyResetAnchor: opts.anchorIso === undefined ? isoOf(anchorMs) : opts.anchorIso,
          percentSinceReset: opts.sinceResetPercent,
        });
      }

      test("target ≈ 0 at window start (now == anchor)", () => {
        const v = projectEligibility(curveSnap({ nowMs: anchorMs, sinceResetPercent: 0 }));
        assert.equal(v.targetPercent, 0);
        // 0 vs 0 within tolerance → on.
        assert.equal(v.paceState, "on");
        assert.equal(v.anchor, isoOf(anchorMs));
        assert.equal(v.sinceResetPercent, 0);
      });

      test("target ≈ ceiling*100/2 at window midpoint (3.5 days in)", () => {
        const nowMs = anchorMs + 3.5 * DAY;
        const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
        // ceiling default 0.92 → midpoint target = 46.
        assert.equal(v.targetPercent, 0.92 * 100 * 0.5);
        assert.equal(v.targetPercent, 46);
      });

      test("target ≈ ceiling*100 at window end (7 days in)", () => {
        const nowMs = anchorMs + 7 * DAY;
        const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
        assert.equal(v.targetPercent, 92);
      });

      test("target clamps to ceiling*100 past the window end (fraction clamps to 1)", () => {
        const nowMs = anchorMs + 10 * DAY;
        const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
        assert.equal(v.targetPercent, 92);
      });

      test("target clamps to 0 before the window start (fraction clamps to 0)", () => {
        // generatedAt earlier than the anchor boundary → fraction floors at 0.
        const nowMs = anchorMs - 2 * DAY;
        const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
        assert.equal(v.targetPercent, 0);
      });

      test("custom ceiling flows into the target", () => {
        process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "0.5";
        const nowMs = anchorMs + 7 * DAY;
        const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
        assert.equal(v.targetPercent, 50);
      });

      test("paceState=behind when sinceReset well below target", () => {
        const nowMs = anchorMs + 3.5 * DAY; // target 46
        const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 20 }));
        assert.equal(v.paceState, "behind");
      });

      test("paceState=ahead when sinceReset well above target", () => {
        const nowMs = anchorMs + 3.5 * DAY; // target 46
        const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 80 }));
        assert.equal(v.paceState, "ahead");
      });

      test("paceState=on when sinceReset within ±tolerance of target", () => {
        const nowMs = anchorMs + 3.5 * DAY; // target 46
        // 46 + 1pp and 46 - 1pp both inside ±2pp.
        assert.equal(
          projectEligibility(curveSnap({ nowMs, sinceResetPercent: 47 })).paceState,
          "on",
        );
        assert.equal(
          projectEligibility(curveSnap({ nowMs, sinceResetPercent: 45 })).paceState,
          "on",
        );
      });

      test("tolerance edges: strictly-beyond flips, exactly-at-edge stays on", () => {
        const nowMs = anchorMs + 3.5 * DAY; // target 46
        const tol = PACE_STATE_TOLERANCE_PERCENT;
        // Exactly target+tol → NOT > target+tol → still "on".
        assert.equal(
          projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 + tol })).paceState,
          "on",
        );
        // Exactly target-tol → NOT < target-tol → still "on".
        assert.equal(
          projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 - tol })).paceState,
          "on",
        );
        // Just past the upper edge → ahead.
        assert.equal(
          projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 + tol + 0.01 })).paceState,
          "ahead",
        );
        // Just past the lower edge → behind.
        assert.equal(
          projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 - tol - 0.01 })).paceState,
          "behind",
        );
      });

      test("anchor unset → neutral: paceState 'on', targetPercent 0, anchor null", () => {
        const v = projectEligibility(
          curveSnap({ nowMs: anchorMs + 3.5 * DAY, sinceResetPercent: 50, anchorIso: null }),
        );
        assert.equal(v.paceState, "on");
        assert.equal(v.targetPercent, 0);
        assert.equal(v.anchor, null);
        // sinceResetPercent is still surfaced verbatim even when neutral.
        assert.equal(v.sinceResetPercent, 50);
      });

      test("uncalibrated snapshot with no anchor → neutral curve, allow unchanged", () => {
        const v = projectEligibility(snapshotWith({ calibrated: false }));
        assert.equal(v.paceState, "on");
        assert.equal(v.targetPercent, 0);
        assert.equal(v.anchor, null);
        // Existing allow/shed semantics untouched.
        assert.equal(v.allow, true);
        assert.deepEqual([...v.shed], []);
      });

      test("Pacing Curve does NOT change allow/shed (additive only)", () => {
        // Ahead of the curve must NOT block dispatch — that is #858's job.
        const v = projectEligibility(
          curveSnap({ nowMs: anchorMs + 1 * DAY, sinceResetPercent: 90 }),
        );
        assert.equal(v.paceState, "ahead");
        assert.equal(v.allow, true);
        assert.deepEqual([...v.shed], []);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Pacing Ceiling env helper (issue #857, ADR-0021)
  // -------------------------------------------------------------------------
  describe("getWeeklyPaceCeiling", () => {
    const restore = withEnvSnapshot();
    afterEach(() => restore());

    test("unset → default", () => {
      delete process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING;
      assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
    });

    test("empty → default", () => {
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "";
      assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
    });

    test("valid fraction in (0,1] is used", () => {
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "0.8";
      assert.equal(getWeeklyPaceCeiling(), 0.8);
    });

    test("1.0 boundary is allowed", () => {
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "1";
      assert.equal(getWeeklyPaceCeiling(), 1);
    });

    test("above 1.0 clamps to 1.0", () => {
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "1.5";
      assert.equal(getWeeklyPaceCeiling(), 1);
    });

    test("zero/negative → default", () => {
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "0";
      assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "-0.3";
      assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
    });

    test("non-numeric → default", () => {
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "abc";
      assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
    });
  });

  // -------------------------------------------------------------------------
  // Weekly Reset Anchor + since-reset fixed window (issue #856, ADR-0021)
  // -------------------------------------------------------------------------
  describe("projectResetWindow", () => {
    const D7 = 7 * 86_400_000;

    test("now exactly on the anchor: current=anchor, next=anchor+7d", () => {
      const anchor = Date.parse("2026-06-01T00:00:00Z");
      const w = projectResetWindow(anchor, anchor);
      assert.equal(w.currentMs, anchor);
      assert.equal(w.nextMs, anchor + D7);
    });

    test("now mid-window: snaps back to the most recent boundary", () => {
      const anchor = Date.parse("2026-06-01T00:00:00Z");
      const now = anchor + 3 * 86_400_000; // 3 days in
      const w = projectResetWindow(anchor, now);
      assert.equal(w.currentMs, anchor);
      assert.equal(w.nextMs, anchor + D7);
    });

    test("projects forward across MULTIPLE 7d periods", () => {
      const anchor = Date.parse("2026-06-01T00:00:00Z");
      // ~23 days later → 3 full weeks elapsed (k=3).
      const now = anchor + 23 * 86_400_000;
      const w = projectResetWindow(anchor, now);
      assert.equal(w.currentMs, anchor + 3 * D7);
      assert.equal(w.nextMs, anchor + 4 * D7);
      assert.ok(w.currentMs <= now && now < w.nextMs);
    });

    test("anchor in the FUTURE: k is negative, current is still <= now", () => {
      const anchor = Date.parse("2026-06-15T00:00:00Z");
      const now = Date.parse("2026-06-01T00:00:00Z"); // 14 days before anchor
      const w = projectResetWindow(anchor, now);
      // k = floor(-14d / 7d) = -2 → current = anchor - 14d = 2026-06-01
      assert.equal(w.currentMs, anchor - 2 * D7);
      assert.equal(w.nextMs, anchor - 1 * D7);
      assert.ok(w.currentMs <= now && now < w.nextMs);
    });
  });

  describe("getWeeklyResetAnchorMs", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = withEnvSnapshot();
    });
    afterEach(() => restore());

    test("unset → null", () => {
      delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
      assert.equal(getWeeklyResetAnchorMs(), null);
    });

    test("empty string → null", () => {
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "";
      assert.equal(getWeeklyResetAnchorMs(), null);
    });

    test("valid ISO → epoch-ms", () => {
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-06-01T00:00:00Z";
      assert.equal(getWeeklyResetAnchorMs(), Date.parse("2026-06-01T00:00:00Z"));
    });

    test("garbage (set but unparseable) → null, does not throw", () => {
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "not-a-date";
      assert.equal(getWeeklyResetAnchorMs(), null);
    });
  });

  describe("parseObservedResetMs", () => {
    test("returns null on malformed JSON", () => {
      assert.equal(parseObservedResetMs("{nope"), null);
    });

    test("returns null when no reset field present", () => {
      assert.equal(
        parseObservedResetMs(JSON.stringify({ timestamp: "2026-06-01T00:00:00Z", message: {} })),
        null,
      );
    });

    test("reads message.usage.resets_at (ISO)", () => {
      const line = JSON.stringify({
        message: { usage: { resets_at: "2026-06-02T00:00:00Z" } },
      });
      assert.equal(parseObservedResetMs(line), Date.parse("2026-06-02T00:00:00Z"));
    });

    test("reads message.rate_limit.resets_at (ISO)", () => {
      const line = JSON.stringify({
        message: { rate_limit: { resets_at: "2026-06-03T12:00:00Z" } },
      });
      assert.equal(parseObservedResetMs(line), Date.parse("2026-06-03T12:00:00Z"));
    });

    test("reads top-level usageLimitResetTime", () => {
      const line = JSON.stringify({ usageLimitResetTime: "2026-06-04T06:00:00Z" });
      assert.equal(parseObservedResetMs(line), Date.parse("2026-06-04T06:00:00Z"));
    });

    test("coerces numeric epoch-SECONDS to ms", () => {
      const secs = Math.floor(Date.parse("2026-06-05T00:00:00Z") / 1000);
      const line = JSON.stringify({ resetsAt: secs });
      assert.equal(parseObservedResetMs(line), secs * 1000);
    });

    test("coerces numeric epoch-MS as-is", () => {
      const ms = Date.parse("2026-06-06T00:00:00Z");
      const line = JSON.stringify({ reset_at: ms });
      assert.equal(parseObservedResetMs(line), ms);
    });
  });

  describe("since-reset window via getUsage", () => {
    // Timestamps are computed RELATIVE TO REAL `Date.now()` so that fixture
    // files (whose mtime is the real wall-clock) always fall inside the
    // tracker's 7d mtime pre-filter, regardless of when CI runs. Helpers below
    // build a deterministic anchor/now/offsets scenario around "now-ish".
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    let restore: () => void;
    let root: string;
    // A stable `now` a couple of hours in the past so every fixture timestamp
    // is < now and the fixture file's real mtime is comfortably inside 7d.
    const nowMs = Date.now() - 2 * HOUR;
    const now = new Date(nowMs);
    const iso = (ms: number) => new Date(ms).toISOString();

    beforeEach(async () => {
      restore = withEnvSnapshot();
      root = await mkdtemp(join(tmpdir(), "usage-anchor-"));
    });
    afterEach(async () => {
      restore();
      clearUsageCache();
      await rm(root, { recursive: true, force: true });
    });

    test("anchor UNSET: since-reset fields are neutral and do not throw", async () => {
      delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "50000";
      await writeFixture(root, "p/s.jsonl", [
        assistantLine(iso(nowMs - 2 * DAY), { in: 1000 }),
      ]);
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      assert.equal(snap.weeklyResetAnchor, null);
      assert.equal(snap.percentSinceReset, 0);
      assert.deepEqual(snap.tokensSinceReset, breakdown());
      // Rolling window is unaffected and still counts the token.
      assert.equal(snap.tokensLast7d.total, 1000);
    });

    test("since-reset sums ONLY tokens after the projected boundary (distinct from rolling 7d)", async () => {
      // Anchor exactly 3 days before now → k=0, current boundary = anchor.
      const anchorMs = nowMs - 3 * DAY;
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = iso(anchorMs);
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "10000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";
      await writeFixture(root, "p/s.jsonl", [
        // BEFORE the boundary but within rolling 7d → rolling only.
        assistantLine(iso(anchorMs - 2 * DAY), { in: 3000 }),
        // AFTER the boundary → both rolling and since-reset.
        assistantLine(iso(anchorMs + 6 * HOUR), { in: 1000 }),
      ]);
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      assert.equal(snap.weeklyResetAnchor, iso(anchorMs));
      // since-reset: only the 1000 after the boundary.
      assert.equal(snap.tokensSinceReset.total, 1000);
      assert.equal(snap.percentSinceReset, (1000 / 10000) * 100);
      // rolling 7d: both → 4000, demonstrably distinct.
      assert.equal(snap.tokensLast7d.total, 4000);
      assert.equal(snap.percentLast7d, (4000 / 10000) * 100);
    });

    test("multiple 7d periods: boundary projects forward across several weeks", async () => {
      // Anchor 5 weeks + 1 day before now → k=5, boundary = anchor + 35d.
      const anchorMs = nowMs - (5 * 7 + 1) * DAY;
      const boundaryMs = anchorMs + 5 * 7 * DAY; // = nowMs - 1*DAY
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = iso(anchorMs);
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "10000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";
      // Sanity: the projected boundary really is one full day before now.
      assert.equal(projectResetWindow(anchorMs, nowMs).currentMs, boundaryMs);
      await writeFixture(root, "p/s.jsonl", [
        // Before the boundary, within rolling 7d → rolling only.
        assistantLine(iso(boundaryMs - 3 * DAY), { in: 500 }),
        // After the boundary → since-reset too.
        assistantLine(iso(boundaryMs + 6 * HOUR), { in: 700 }),
      ]);
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      assert.equal(snap.weeklyResetAnchor, iso(boundaryMs));
      assert.equal(snap.tokensSinceReset.total, 700);
      assert.equal(snap.tokensLast7d.total, 1200);
    });

    test("auto-correct: an observed reset MORE RECENT than the env projection overrides it", async () => {
      // Env boundary = anchor (k=0); an observed reset 12h later wins.
      const anchorMs = nowMs - 2 * DAY;
      const observedMs = anchorMs + 12 * HOUR;
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = iso(anchorMs);
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "10000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";
      await writeFixture(root, "p/s.jsonl", [
        // Between env boundary and observed reset → excluded by auto-correct.
        assistantLine(iso(anchorMs + 1 * HOUR), { in: 2000 }),
        // The observed-reset notice line (no usage block).
        JSON.stringify({
          timestamp: iso(observedMs),
          message: { rate_limit: { resets_at: iso(observedMs) } },
        }),
        // After the observed reset → counted.
        assistantLine(iso(observedMs + 6 * HOUR), { in: 1500 }),
      ]);
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      // Effective boundary tracks the observed reset, not the env projection.
      assert.equal(snap.weeklyResetAnchor, iso(observedMs));
      assert.equal(snap.tokensSinceReset.total, 1500);
    });

    test("auto-correct ignores an observed reset OLDER than the env projection", async () => {
      const anchorMs = nowMs - 2 * DAY;
      const observedOldMs = anchorMs - 1 * DAY; // older than the env boundary
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = iso(anchorMs);
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "10000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";
      await writeFixture(root, "p/s.jsonl", [
        JSON.stringify({
          timestamp: iso(observedOldMs),
          message: { usage: { resets_at: iso(observedOldMs) } },
        }),
        assistantLine(iso(anchorMs + 6 * HOUR), { in: 800 }),
      ]);
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      // Stays on the env projection boundary.
      assert.equal(snap.weeklyResetAnchor, iso(anchorMs));
      assert.equal(snap.tokensSinceReset.total, 800);
    });

    test("anchor set but quota uncalibrated: anchor + tokens present, percent stays 0", async () => {
      const anchorMs = nowMs - 2 * DAY;
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = iso(anchorMs);
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      await writeFixture(root, "p/s.jsonl", [
        assistantLine(iso(anchorMs + 6 * HOUR), { in: 900 }),
      ]);
      const snap = await getUsage({ now, projectsRoot: root, force: true });
      assert.equal(snap.weeklyResetAnchor, iso(anchorMs));
      assert.equal(snap.tokensSinceReset.total, 900);
      assert.equal(snap.percentSinceReset, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Cache-read weight + drift detection (issue #873)
  // -------------------------------------------------------------------------
  describe("cache-read weight env parsing", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = withEnvSnapshot();
    });
    afterEach(() => restore());

    test("defaults to 1.0 (identity) when unset", () => {
      delete process.env.HYDRA_USAGE_CACHE_READ_WEIGHT;
      assert.equal(getCacheReadWeight(), DEFAULT_CACHE_READ_WEIGHT);
      assert.equal(getCacheReadWeight(), 1.0);
    });

    test("defaults to 1.0 on non-finite or non-positive values", () => {
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "abc";
      assert.equal(getCacheReadWeight(), 1.0);
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0";
      assert.equal(getCacheReadWeight(), 1.0);
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "-0.5";
      assert.equal(getCacheReadWeight(), 1.0);
    });

    test("returns the parsed positive fractional weight when set", () => {
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0.1";
      assert.equal(getCacheReadWeight(), 0.1);
    });
  });

  describe("weightedTokens helper", () => {
    test("at w_cache = 1.0 reduces exactly to .total", () => {
      const b = breakdown({ input: 100, output: 200, cacheRead: 5000, cacheCreation: 50 });
      assert.equal(weightedTokens(b, 1.0), b.total);
    });

    test("down-weights ONLY cacheRead; input/output/cacheCreation stay full weight", () => {
      const b = breakdown({ input: 100, output: 200, cacheRead: 1000, cacheCreation: 50 });
      // 100 + 200 + 50 + 0.1*1000 = 450
      assert.equal(weightedTokens(b, 0.1), 450);
    });

    test("w_cache = 0 drops cacheRead entirely", () => {
      const b = breakdown({ input: 100, output: 200, cacheRead: 9999, cacheCreation: 50 });
      assert.equal(weightedTokens(b, 0), 350);
    });
  });

  describe("drift env parsing", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = withEnvSnapshot();
    });
    afterEach(() => restore());

    test("reference is null (inert) when unset", () => {
      delete process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT;
      assert.equal(getDriftReferencePercent(), null);
    });

    test("reference is null on non-positive / non-finite", () => {
      process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "0";
      assert.equal(getDriftReferencePercent(), null);
      process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "nope";
      assert.equal(getDriftReferencePercent(), null);
    });

    test("reference is the parsed positive percent when set", () => {
      process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "5";
      assert.equal(getDriftReferencePercent(), 5);
    });

    test("factor defaults to 2 when unset or <= 1", () => {
      delete process.env.HYDRA_USAGE_DRIFT_FACTOR;
      assert.equal(getDriftFactor(), DEFAULT_DRIFT_FACTOR);
      process.env.HYDRA_USAGE_DRIFT_FACTOR = "1";
      assert.equal(getDriftFactor(), DEFAULT_DRIFT_FACTOR);
      process.env.HYDRA_USAGE_DRIFT_FACTOR = "0.5";
      assert.equal(getDriftFactor(), DEFAULT_DRIFT_FACTOR);
    });

    test("factor is the parsed value when > 1", () => {
      process.env.HYDRA_USAGE_DRIFT_FACTOR = "3";
      assert.equal(getDriftFactor(), 3);
    });
  });

  describe("weighted quota-burn percentages (issue #873)", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = withEnvSnapshot();
      clearUsageCache();
    });
    afterEach(() => {
      restore();
      clearUsageCache();
    });

    // A cache-heavy fixture: cacheRead dominates the token mix, mirroring the
    // real-world regression that motivated #873.
    async function cacheHeavyRoot(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "usage-w873-"));
      await writeFixture(root, "p/s.jsonl", [
        // in:100 out:100 cacheCreation:100 cacheRead:9700 -> total 10000
        assistantLine("2026-05-25T11:00:00Z", {
          in: 100,
          out: 100,
          cacheCreation: 100,
          cacheRead: 9700,
        }),
      ]);
      return root;
    }

    test("default w_cache (unset) is behaviour-neutral: percent uses raw total", async () => {
      delete process.env.HYDRA_USAGE_CACHE_READ_WEIGHT;
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      const root = await cacheHeavyRoot();
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const snap = await getUsage({ now, projectsRoot: root, force: true });
        // raw total 10000 / 100000 = 10%
        assert.equal(snap.percentLast7d, 10);
        assert.equal(snap.percentLast5h, 10);
        // raw .total fields untouched regardless
        assert.equal(snap.tokensLast7d.total, 10000);
        assert.equal(snap.tokensLast7d.cacheRead, 9700);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("w_cache = 0.1 down-weights the cache-heavy burn ~7x vs raw", async () => {
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0.1";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      const root = await cacheHeavyRoot();
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const snap = await getUsage({ now, projectsRoot: root, force: true });
        // weighted = 100+100+100 + 0.1*9700 = 1270; /100000 = 1.27%
        assert.ok(Math.abs(snap.percentLast7d - 1.27) < 1e-9, `got ${snap.percentLast7d}`);
        assert.ok(Math.abs(snap.percentLast5h - 1.27) < 1e-9);
        // raw .total is STILL the honest on-disk count
        assert.equal(snap.tokensLast7d.total, 10000);
        // cacheHitRatio (a diagnostic, not a burn figure) is untouched: it uses
        // raw cacheRead, so 9700/(9700+100+100) = 0.97979...
        assert.ok(Math.abs(snap.cacheHitRatioLast7d - 9700 / 9900) < 1e-9);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("projectedWeeklyPercent uses the weighted 24h burn", async () => {
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0.1";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      const root = await cacheHeavyRoot();
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const snap = await getUsage({ now, projectsRoot: root, force: true });
        // weighted 24h burn 1270, *7 / 100000 = 8.89%
        assert.ok(Math.abs(snap.projectedWeeklyPercent - 8.89) < 1e-9, `got ${snap.projectedWeeklyPercent}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("percentSinceReset uses the weighted unit", async () => {
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0.1";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      const anchor = "2026-05-25T00:00:00Z"; // boundary earlier the same day
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = anchor;
      const root = await cacheHeavyRoot();
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const snap = await getUsage({ now, projectsRoot: root, force: true });
        // The single 11:00 line is after the 00:00 boundary; weighted 1270.
        assert.equal(snap.tokensSinceReset.total, 10000); // raw honest count
        assert.ok(Math.abs(snap.percentSinceReset - 1.27) < 1e-9, `got ${snap.percentSinceReset}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("composition: cache-weight (Axis A) composes with Quota Weight (Axis B) without double-counting", async () => {
      // Two families, distinct family weights, distinct token mixes. The
      // weighted-burn numerator must apply cache-weight INSIDE each family and
      // the family weight OUTSIDE.
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0.1";
      process.env.HYDRA_QUOTA_WEIGHT_OPUS = "2";
      process.env.HYDRA_QUOTA_WEIGHT_SONNET = "1";
      process.env.HYDRA_QUOTA_WEIGHT_HAIKU = "1";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      const root = await mkdtemp(join(tmpdir(), "usage-w873c-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          // opus: in:100 cacheRead:1000 -> weighted 100 + 0.1*1000 = 200
          assistantLine("2026-05-25T11:00:00Z", { in: 100, cacheRead: 1000 }, "claude-opus-4-7"),
          // sonnet: in:300 cacheRead:0 -> weighted 300
          assistantLine("2026-05-25T11:00:00Z", { in: 300 }, "claude-sonnet-4-5"),
        ]);
        const snap = await getUsage({ now, projectsRoot: root, force: true });
        // composed burn = 2*200 (opus) + 1*300 (sonnet) = 700; /100000 = 0.7%
        assert.ok(Math.abs(snap.percentLast7d - 0.7) < 1e-9, `got ${snap.percentLast7d}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("composition reduces to single-axis cache-weighted total when family weights are uncalibrated", async () => {
      // No HYDRA_QUOTA_WEIGHT_* set -> family weights all 1.0 -> the composed
      // numerator equals Σ_family weightedTokens(family, w_cache).
      delete process.env.HYDRA_QUOTA_WEIGHT_OPUS;
      delete process.env.HYDRA_QUOTA_WEIGHT_SONNET;
      delete process.env.HYDRA_QUOTA_WEIGHT_HAIKU;
      process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0.1";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      const root = await mkdtemp(join(tmpdir(), "usage-w873r-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 100, cacheRead: 1000 }, "claude-opus-4-7"),
          assistantLine("2026-05-25T11:00:00Z", { in: 300 }, "claude-sonnet-4-5"),
        ]);
        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.quotaWeightCalibrated, false);
        // single-axis: (100 + 0.1*1000) + 300 = 200 + 300 = 500; /100000 = 0.5%
        assert.ok(Math.abs(snap.percentLast7d - 0.5) < 1e-9, `got ${snap.percentLast7d}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("drift detector warns (issue #873)", () => {
    let restore: () => void;
    let warnings: string[];
    let origWarn: typeof console.warn;
    beforeEach(() => {
      restore = withEnvSnapshot();
      clearUsageCache();
      warnings = [];
      origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(" "));
      };
    });
    afterEach(() => {
      console.warn = origWarn;
      restore();
      clearUsageCache();
    });

    function driftWarnings(): string[] {
      return warnings.filter((w) => w.includes("calibration drift"));
    }

    async function rootWithBurn(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "usage-drift-"));
      // 10000 tokens against a 100000 weekly quota since the anchor -> 10%.
      await writeFixture(root, "p/s.jsonl", [
        assistantLine("2026-05-25T11:00:00Z", { in: 10000 }),
      ]);
      return root;
    }

    test("inert when reference unset (no warning, no false alarm)", async () => {
      delete process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT;
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-25T00:00:00Z";
      const root = await rootWithBurn();
      try {
        await getUsage({ now: new Date("2026-05-25T12:00:00Z"), projectsRoot: root, force: true });
        assert.equal(driftWarnings().length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("fires ONCE when tracker percentSinceReset diverges > factor from reference", async () => {
      // Reference 1%, tracker 10% -> 10x > default 2x factor -> warn.
      process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "1";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-25T00:00:00Z";
      const root = await rootWithBurn();
      try {
        await getUsage({ now: new Date("2026-05-25T12:00:00Z"), projectsRoot: root, force: true });
        assert.equal(driftWarnings().length, 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("does NOT fire when within the factor band", async () => {
      // Reference 8%, tracker 10% -> within 2x -> no warn.
      process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "8";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-25T00:00:00Z";
      const root = await rootWithBurn();
      try {
        await getUsage({ now: new Date("2026-05-25T12:00:00Z"), projectsRoot: root, force: true });
        assert.equal(driftWarnings().length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("inert when the anchor is unset (no since-reset metric to compare)", async () => {
      process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "1";
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "100000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "100000";
      delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
      const root = await rootWithBurn();
      try {
        await getUsage({ now: new Date("2026-05-25T12:00:00Z"), projectsRoot: root, force: true });
        assert.equal(driftWarnings().length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("inert when uncalibrated (percentSinceReset is 0)", async () => {
      process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "1";
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-25T00:00:00Z";
      const root = await rootWithBurn();
      try {
        await getUsage({ now: new Date("2026-05-25T12:00:00Z"), projectsRoot: root, force: true });
        assert.equal(driftWarnings().length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  // OAuth meter rebase + gate-safe fallback (issue #1083). The injected
  // `readUsage` lets these pin the meter result without a live endpoint.
  describe("OAuth meter rebase (issue #1083)", () => {
    const meterOk = (fiveHour: number, sevenDay: number) => async () => ({
      ok: true as const,
      data: {
        fiveHour: { utilization: fiveHour, resetsAt: "2026-06-07T02:50:00.000Z" },
        sevenDay: { utilization: sevenDay, resetsAt: "2026-06-10T17:00:00.000Z" },
      },
    });
    const meterFail = (code: any) => async () => ({ ok: false as const, code });

    test("successful meter read REBASES percentLast5h/percentLast7d onto OAuth utilization", async () => {
      // Transcript estimate would compute very different numbers; the OAuth
      // headline must win and usageSource must be 'oauth'.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 100, out: 100 }),
        ]);
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: meterOk(50, 34),
        });
        assert.equal(snap.usageSource, "oauth");
        assert.equal(snap.percentLast5h, 50);
        assert.equal(snap.percentLast7d, 34);
        assert.equal(snap.oauthError, null);
        assert.equal(snap.oauthFiveHourResetsAt, "2026-06-07T02:50:00.000Z");
        assert.equal(snap.oauthSevenDayResetsAt, "2026-06-10T17:00:00.000Z");
        // Raw transcript token accounting is untouched (attribution stays).
        assert.equal(snap.tokensLast5h.total, 200);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("OAuth >=90 fires emergencyStop on the meter path (real utilization gate)", async () => {
      // No quota env set => uncalibrated estimate, yet the OAuth meter alone
      // must be able to trip the 5h emergency stop.
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 10 }),
        ]);
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: meterOk(92, 40),
        });
        assert.equal(snap.usageSource, "oauth");
        assert.equal(snap.percentLast5h, 92);
        assert.equal(snap.emergencyStop, true);
        assert.equal(projectEligibility(snap).allow, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("HARD INVARIANT: a FAILED meter read falls back to the estimate, NEVER 0", async () => {
      // Estimate computes 95% (>=90 => emergencyStop). A failed OAuth read must
      // keep that conservative number, NOT silently degrade to 0 (which would
      // unblock dispatch during an outage).
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 900, out: 50 }),
        ]);
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: meterFail("oauth-usage-token-expired"),
        });
        assert.equal(snap.usageSource, "estimate");
        assert.equal(snap.oauthError, "oauth-usage-token-expired");
        assert.equal(snap.percentLast5h, 95); // estimate stands — NOT 0
        assert.equal(snap.emergencyStop, true);
        assert.equal(projectEligibility(snap).allow, false);
        // OAuth reset boundaries are null on the fallback path.
        assert.equal(snap.oauthFiveHourResetsAt, null);
        assert.equal(snap.oauthSevenDayResetsAt, null);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("Pace-Gate isolation: percentSinceReset / weeklyResetAnchor unchanged by the OAuth rebase", async () => {
      // The ADR-0021 since-reset machinery keys off the env anchor, NOT the
      // OAuth meter. A successful OAuth read must not move it.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-25T00:00:00Z";
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T06:00:00Z", { in: 250 }),
        ]);
        const withMeter = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: meterOk(50, 34),
        });
        const withoutMeter = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: meterFail("oauth-usage-network"),
        });
        // since-reset projection identical regardless of the OAuth headline.
        assert.equal(withMeter.percentSinceReset, withoutMeter.percentSinceReset);
        assert.equal(withMeter.weeklyResetAnchor, withoutMeter.weeklyResetAnchor);
        assert.equal(withMeter.weeklyEmergencyStop, withoutMeter.weeklyEmergencyStop);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a real OAuth 0% is honored on the meter path (distinct from a failed read)", async () => {
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: meterOk(0, 0),
        });
        assert.equal(snap.usageSource, "oauth");
        assert.equal(snap.percentLast5h, 0);
        assert.equal(snap.emergencyStop, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  // OAuth-read cadence decoupling + last-good-serve on transient failure
  // (issue #1090). The module-level oauthCache is normally bypassed on the
  // injected/fixture path; `useOAuthCache: true` opts these tests IN so they can
  // drive the independent-TTL + last-good behaviour with a pinned reader. Each
  // test clears the cache first (clearUsageCache nulls BOTH caches).
  describe("OAuth read cadence + last-good (issue #1090)", () => {
    let restoreEnv: () => void;
    beforeEach(() => {
      restoreEnv = withEnvSnapshot();
      clearUsageCache();
    });
    afterEach(() => {
      restoreEnv();
      clearUsageCache();
    });

    // A reader that counts its calls and returns a programmable result, so the
    // tests can assert OAuth GETs are NOT made on every snapshot scan.
    function countingMeter(results: Array<{ ok: boolean; five?: number; seven?: number; code?: any }>) {
      let calls = 0;
      const reader = async () => {
        const r = results[Math.min(calls, results.length - 1)];
        calls++;
        if (r.ok) {
          return {
            ok: true as const,
            data: {
              fiveHour: { utilization: r.five ?? 0, resetsAt: null },
              sevenDay: { utilization: r.seven ?? 0, resetsAt: null },
            },
          };
        }
        return { ok: false as const, code: r.code ?? "oauth-usage-non-2xx" };
      };
      return { reader, calls: () => calls };
    }

    test("getOAuthUsageTtlMs: default, override, and invalid fall-back", () => {
      delete process.env.HYDRA_OAUTH_USAGE_TTL_MS;
      assert.equal(getOAuthUsageTtlMs(), DEFAULT_OAUTH_USAGE_TTL_MS);
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "120000";
      assert.equal(getOAuthUsageTtlMs(), 120000);
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "not-a-number";
      assert.equal(getOAuthUsageTtlMs(), DEFAULT_OAUTH_USAGE_TTL_MS);
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "-5";
      assert.equal(getOAuthUsageTtlMs(), DEFAULT_OAUTH_USAGE_TTL_MS);
    });

    test("getOAuthUsageMaxStaleMs: defaults to the effective TTL, honours override", () => {
      delete process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS;
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "90000";
      assert.equal(getOAuthUsageMaxStaleMs(), 90000);
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "30000";
      assert.equal(getOAuthUsageMaxStaleMs(), 30000);
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "bad";
      assert.equal(getOAuthUsageMaxStaleMs(), 90000); // falls back to TTL
    });

    test("AC1: cache reuse within TTL — one OAuth GET across many scans", async () => {
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "300000"; // 5 min
      const root = await mkdtemp(join(tmpdir(), "usage-1090-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
        const m = countingMeter([{ ok: true, five: 50, seven: 34 }]);
        const base = new Date("2026-05-25T12:00:00Z").getTime();
        // 5 scans spaced 60s apart, all within the 5-min OAuth TTL.
        for (let i = 0; i < 5; i++) {
          const snap = await getUsage({
            now: new Date(base + i * 60_000),
            projectsRoot: root,
            force: true, // bust the snapshot scan each time...
            useOAuthCache: true,
            readUsage: m.reader,
          });
          assert.equal(snap.usageSource, "oauth");
          assert.equal(snap.percentLast5h, 50);
          assert.equal(snap.oauthStale, false);
        }
        // ...but the OAuth endpoint was hit exactly ONCE (the cadence decoupling).
        assert.equal(m.calls(), 1, "OAuth GET should fire once, not per-scan");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("AC4: force busts the snapshot scan but NOT the OAuth read", async () => {
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "300000";
      const root = await mkdtemp(join(tmpdir(), "usage-1090-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
        const m = countingMeter([{ ok: true, five: 42, seven: 20 }]);
        const now = new Date("2026-05-25T12:00:00Z");
        // Two force=1 reads within the OAuth TTL — an operator hammering ?force=1.
        await getUsage({ now, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        await getUsage({
          now: new Date(now.getTime() + 1000),
          projectsRoot: root,
          force: true,
          useOAuthCache: true,
          readUsage: m.reader,
        });
        assert.equal(m.calls(), 1, "force must not spend the OAuth budget");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("AC2: a 429 serves the last-good value as STALE oauth (does NOT flip to estimate)", async () => {
      // Calibrate so the estimate would be a concrete number — proving we stay
      // on the OAuth last-good rather than degrading to it.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "300000"; // 5 min grace
      const root = await mkdtemp(join(tmpdir(), "usage-1090-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 900, out: 50 })]);
        // First read succeeds (seeds last-good = 55%); second (after TTL) 429s.
        const m = countingMeter([
          { ok: true, five: 55, seven: 33 },
          { ok: false, code: "oauth-usage-non-2xx" },
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        const first = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(first.usageSource, "oauth");
        assert.equal(first.percentLast5h, 55);
        assert.equal(first.oauthStale, false);

        // 90s later (> 60s TTL, < TTL+grace) the meter 429s: serve last-good stale.
        const t1 = new Date(t0.getTime() + 90_000);
        const second = await getUsage({ now: t1, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(second.usageSource, "oauth", "stays on OAuth ground truth, not estimate");
        assert.equal(second.percentLast5h, 55, "serves the last-good 55%, not the estimate");
        assert.equal(second.oauthStale, true);
        assert.equal(second.oauthError, "oauth-usage-stale");
        assert.equal(second.oauthAgeMs, 90_000, "exposes the served value's age");
        assert.equal(m.calls(), 2, "a fresh GET was attempted, then fell back to last-good");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("AC3: after TTL + maxStale with no successful read, falls through to estimate", async () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "60000"; // 1 min grace
      const root = await mkdtemp(join(tmpdir(), "usage-1090-"));
      try {
        // Estimate = (950 / 1000) * 100 = 95% (>=90 => emergencyStop stays on).
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:30:00Z", { in: 900, out: 50 })]);
        const m = countingMeter([
          { ok: true, five: 55, seven: 33 },
          { ok: false, code: "oauth-usage-non-2xx" },
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        // 5 min later: age (300s) >= TTL(60s)+maxStale(60s) => too stale.
        const tFar = new Date(t0.getTime() + 300_000);
        const snap = await getUsage({ now: tFar, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(snap.usageSource, "estimate", "too-stale last-good falls through to estimate");
        assert.equal(snap.oauthError, "oauth-usage-non-2xx");
        assert.equal(snap.oauthStale, false);
        assert.equal(snap.oauthAgeMs, null);
        assert.equal(snap.percentLast5h, 95, "estimate stands — never silently 0");
        assert.equal(snap.emergencyStop, true, "gate stays conservative on the estimate");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a successful read after TTL REFRESHES the cache (fresh, not stale)", async () => {
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000";
      const root = await mkdtemp(join(tmpdir(), "usage-1090-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
        const m = countingMeter([
          { ok: true, five: 40, seven: 20 },
          { ok: true, five: 70, seven: 50 },
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        const first = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(first.percentLast5h, 40);
        // 2 min later (> TTL) a fresh successful read replaces the cached value.
        const t1 = new Date(t0.getTime() + 120_000);
        const second = await getUsage({ now: t1, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(second.usageSource, "oauth");
        assert.equal(second.percentLast5h, 70, "refreshed to the new reading");
        assert.equal(second.oauthStale, false);
        assert.equal(second.oauthAgeMs, 0);
        assert.equal(m.calls(), 2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a fresh failure with NO prior last-good falls straight to the estimate", async () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      const root = await mkdtemp(join(tmpdir(), "usage-1090-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 300 })]);
        const m = countingMeter([{ ok: false, code: "oauth-usage-token-expired" }]);
        const snap = await getUsage({
          now: new Date("2026-05-25T12:00:00Z"),
          projectsRoot: root,
          force: true,
          useOAuthCache: true,
          readUsage: m.reader,
        });
        assert.equal(snap.usageSource, "estimate");
        assert.equal(snap.oauthError, "oauth-usage-token-expired");
        assert.equal(snap.oauthStale, false);
        assert.equal(snap.oauthAgeMs, null);
        assert.equal(snap.percentLast5h, 30); // (300/1000)*100
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("parseSessionLimitReset (issue #1089)", () => {
    // 2026-06-06 12:00:00 PDT == 19:00:00Z (PDT is UTC-7 in June).
    const nowMs = Date.parse("2026-06-06T19:00:00.000Z");

    test("parses the real CLI/journal line and resolves to a future instant", () => {
      const line =
        "Jun 06 14:41:18 gabenuc env[1522365]: You've hit your session limit · resets 4:40pm (America/Los_Angeles)";
      const ms = parseSessionLimitReset(line, nowMs);
      assert.ok(ms !== null);
      // 4:40pm PDT on 2026-06-06 == 23:40:00Z, which is after nowMs (19:00Z).
      assert.equal(new Date(ms!).toISOString(), "2026-06-06T23:40:00.000Z");
      assert.ok(ms! > nowMs);
    });

    test("a wall-clock time already passed today resolves to tomorrow", () => {
      // 9:00am PDT on 2026-06-06 == 16:00Z, BEFORE nowMs (19:00Z) → next day.
      const line = "You've hit your session limit · resets 9:00am (America/Los_Angeles)";
      const ms = parseSessionLimitReset(line, nowMs);
      assert.ok(ms !== null);
      assert.equal(new Date(ms!).toISOString(), "2026-06-07T16:00:00.000Z");
    });

    test("tolerates AM/PM casing and a missing-minutes form", () => {
      const ms = parseSessionLimitReset(
        "hit your session limit · resets 5PM (America/Los_Angeles)",
        nowMs,
      );
      assert.ok(ms !== null);
      assert.equal(new Date(ms!).toISOString(), "2026-06-07T00:00:00.000Z"); // 5pm PDT
    });

    test("12am/12pm boundary handling", () => {
      const noon = parseSessionLimitReset(
        "hit your session limit · resets 12:00pm (America/Los_Angeles)",
        nowMs,
      );
      assert.equal(new Date(noon!).toISOString(), "2026-06-07T19:00:00.000Z"); // next-day noon PDT
      const midnight = parseSessionLimitReset(
        "hit your session limit · resets 12:00am (America/Los_Angeles)",
        nowMs,
      );
      assert.equal(new Date(midnight!).toISOString(), "2026-06-07T07:00:00.000Z"); // midnight PDT
    });

    test("a UTC timezone resolves with no offset", () => {
      const ms = parseSessionLimitReset(
        "hit your session limit · resets 11:30pm (UTC)",
        nowMs,
      );
      assert.equal(new Date(ms!).toISOString(), "2026-06-06T23:30:00.000Z");
    });

    test("non-session-limit / generic lines return null", () => {
      assert.equal(parseSessionLimitReset("ordinary log line", nowMs), null);
      assert.equal(parseSessionLimitReset("rate_limit resets soon", nowMs), null);
      assert.equal(parseSessionLimitReset("", nowMs), null);
    });

    test("an unknown timezone returns null (no throw)", () => {
      assert.equal(
        parseSessionLimitReset(
          "hit your session limit · resets 4:40pm (Not/AZone)",
          nowMs,
        ),
        null,
      );
    });

    test("an out-of-range hour returns null", () => {
      assert.equal(
        parseSessionLimitReset(
          "hit your session limit · resets 13:40pm (America/Los_Angeles)",
          nowMs,
        ),
        null,
      );
    });
  });

  describe("overlaySessionBlockEligibility (issue #1089)", () => {
    const base: UsageEligibility = {
      allow: true,
      shed: [],
      reasons: {
        emergencyStop: false,
        weeklyEmergencyStop: false,
        pacingShed: false,
        calibrated: true,
        paused: false,
        sessionBlockedUntil: null,
      },
      paceState: "on",
      targetPercent: 0,
      sinceResetPercent: 0,
      anchor: null,
      usage: {} as UsageSnapshot,
    };
    const nowMs = Date.parse("2026-06-06T19:00:00.000Z");

    test("a future block forces allow=false and surfaces the ISO instant", () => {
      const blockedUntilMs = nowMs + 60 * 60 * 1000; // +1h
      const v = overlaySessionBlockEligibility(base, blockedUntilMs, nowMs);
      assert.equal(v.allow, false);
      assert.equal(v.reasons.sessionBlockedUntil, new Date(blockedUntilMs).toISOString());
    });

    test("a null block returns the input unchanged", () => {
      const v = overlaySessionBlockEligibility(base, null, nowMs);
      assert.equal(v, base);
    });

    test("a past block returns the input unchanged (self-clear)", () => {
      const v = overlaySessionBlockEligibility(base, nowMs - 1000, nowMs);
      assert.equal(v, base);
      assert.equal(v.allow, true);
    });

    test("composes after pause without dropping reasons.paused", () => {
      const paused = overlayPauseEligibility(base, true);
      const v = overlaySessionBlockEligibility(paused, nowMs + 1000, nowMs);
      assert.equal(v.allow, false);
      assert.equal(v.reasons.paused, true);
      assert.ok(v.reasons.sessionBlockedUntil !== null);
    });

    test("does not mutate the input object", () => {
      const snapshot = JSON.stringify(base);
      overlaySessionBlockEligibility(base, nowMs + 1000, nowMs);
      assert.equal(JSON.stringify(base), snapshot);
    });
  });
});
