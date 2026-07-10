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
  getOAuthUsageBackoffBaseMs,
  getOAuthUsageBackoffMaxMs,
  DEFAULT_OAUTH_USAGE_TTL_MS,
  DEFAULT_OAUTH_USAGE_MAX_STALE_MS,
  DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS,
  DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS,
  getWeeklyResetAnchorMs,
  getCacheReadWeight,
  DEFAULT_CACHE_READ_WEIGHT,
  getDriftReferencePercent,
  getDriftFactor,
  DEFAULT_DRIFT_FACTOR,
  getOAuthEstimateDivergenceFactor,
  DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR,
  getWeeklyPaceCeiling,
  DEFAULT_WEEKLY_PACE_CEILING,
  sessionIdFromPath,
  INTERACTIVE_SKILL,
  type UsageSnapshot,
  type SkillResolver,
  type OAuthUsageResult,
} from "../src/cost/index.ts";
// In-transcript skill derivation (issue #2402): the pure resolver + the
// first-user-message extractor live on the TranscriptScan seam. Imported
// directly to unit-test the derivation grammar without the JSONL-scan machinery.
import {
  deriveSkill,
  firstUserMessageText,
  deriveDispatchKind,
  emptyByDispatchKind,
  oauthBackoffDelayMs,
  makeReadOAuth,
  DISPATCH_KINDS,
  setOAuthBackoffPersistence,
} from "../src/cost/transcript-scan.ts";
import type { OAuthBackoffPersistence } from "../src/cost/transcript-scan.ts";
import type { PersistedOAuthBackoff } from "../src/redis/oauth-backoff.ts";
// Attribution coverage % pure fold (issue #2403) lives on the snapshot-assembly
// leaf; imported directly for unit test without the JSONL-scan machinery.
import { deriveAttributedPercent } from "../src/cost/snapshot-assembly.ts";
// The pure token-math functions now live in their own leaf (issue #1909).
// Import them directly from cost/token-math.ts to prove the seam is importable
// without pulling in the JSONL-scan machinery — mirroring the eligibility.ts
// import below. (They are also still re-exported through the index barrel above,
// so external callers see no import-line change.)
import {
  modelToFamily,
  parseUsageLine,
  parseObservedResetMs,
  cacheHitRatio,
  projectResetWindow,
  weightedTokens,
  parseSessionLimitReset,
  type TokenBreakdown,
  type ModelFamily,
} from "../src/cost/token-math.ts";
// The pure eligibility-projection fold now lives in its own module
// (issue #1377). Import it directly from cost/eligibility.ts to prove the seam
// is importable without pulling in the JSONL-scan machinery. The env-config
// readers (incl. getWeeklyPaceCeiling, moved to cost/config.ts in #1896) come
// in via the index re-export above.
import {
  projectEligibility,
  deriveHardStop,
  EMERGENCY_STOP_PERCENT,
  PACE_STATE_TOLERANCE_PERCENT,
  PACING_SHEDDABLE_CLASSES,
  fiveHourThrottleShed,
  FIVE_HOUR_THROTTLE_T1_CLASSES,
  FIVE_HOUR_THROTTLE_T2_CLASSES,
  overlayPauseEligibility,
  overlaySessionBlockEligibility,
  type UsageEligibility,
} from "../src/cost/eligibility.ts";
// The 5h-throttle threshold DEFAULT_* constants (and their env-reader getters)
// were relocated to the Cost env-reader leaf cost/config.ts in #2550; import
// them from there (cost/index.ts re-exports them at the same names too).
import {
  DEFAULT_FIVE_HOUR_THROTTLE_T1,
  DEFAULT_FIVE_HOUR_THROTTLE_T2,
  getFiveHourThrottleT1,
  getFiveHourThrottleT2,
} from "../src/cost/config.ts";
// The pure snapshot-assembly helpers (extracted in issue #2188, relocated to
// their own pure leaf cost/snapshot-assembly.ts in issue #2279). They are
// exported from cost/snapshot-assembly.ts (for direct unit test) but deliberately
// NOT added to the cost/index.ts public barrel — same module-internal visibility
// as eligibility.ts's deriveHardStop. Import them straight from the leaf so the
// scalar-input seam is asserted without pulling in the JSONL-scan coordinator.
import {
  derivePacingState,
  rebaseOnOAuth,
  deriveSinceReset,
  detectCalibrationDrift,
  detectEstimateOAuthDivergence,
  deriveWeightedBurns,
  deriveEstimatePercents,
  deriveQuotaWeightTotals,
  deriveBySkillWoW,
} from "../src/cost/snapshot-assembly.ts";
// Weekly Usage Snapshot ISO-week label helper (issue #2404). Pure, no Redis —
// imported from the typed accessor seam for direct unit test of the week math.
import { isoWeekLabel } from "../src/redis/usage-snapshots.ts";
// `rebaseOnOAuth` consumes the already-resolved OAuth read (`ScanResult["oauth"]`,
// = CachedOAuthRead). Alias it here so the fixtures below name the shape the
// helper expects without importing the whole ScanResult boundary type.
import type { CachedOAuthRead as ScanResultOAuth } from "../src/cost/transcript-scan.ts";

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

/**
 * A `type:"user"` transcript line carrying `content` as a plain string — the
 * first-user-message signal `deriveSkill` reads (issue #2402). Pass the
 * `hydra-dispatch` sentinel comment or a `<command-name>/skill</command-name>`
 * marker to attribute a fixture session; omit to leave it interactive.
 * `isMeta:true` marks a harness-injected line the extractor must skip.
 */
function userLine(content: string, opts: { meta?: boolean } = {}): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-05-25T10:59:00Z",
    isMeta: opts.meta === true,
    message: { role: "user", content },
  });
}

/** The hydra-dispatch sentinel comment for `skill`, as it lands in a transcript. */
function sentinelLine(skill: string): string {
  return userLine(
    `<!-- hydra-dispatch v1 skill=${skill} dispatchId=worktree-agent-deadbeef-t1-x runId=deadbeef-0000 -->`,
  );
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
    "HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR",
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

    test("maps claude-fable strings into the opus (frontier) family", () => {
      assert.equal(modelToFamily("claude-fable-5"), "opus");
      assert.equal(modelToFamily("claude-fable-5[1m]"), "opus");
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

    test("emergencyStop fires once the OAuth meter percentLast5h >= 90", async () => {
      // Post-#1124 the hard-stop rides the real OAuth meter, never the
      // transcript estimate. Inject a 95% meter read so percentLast5h is the
      // authoritative OAuth headline that trips the stop. (The transcript
      // fixture is retained only to keep the raw token accounting populated.)
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
          readUsage: async () => ({
            ok: true as const,
            data: {
              fiveHour: { utilization: 95, resetsAt: null },
              sevenDay: { utilization: 40, resetsAt: null },
            },
          }),
        });
        assert.equal(snap.calibrated, true);
        assert.equal(snap.tokensLast5h.total, 950);
        assert.equal(snap.usageSource, "oauth");
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

  describe("deriveSkill — in-transcript precedence (issue #2402)", () => {
    test("(1) hydra-dispatch sentinel skill= wins over everything", () => {
      assert.equal(
        deriveSkill("<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=x runId=y -->"),
        "hydra-dev",
      );
      // Sentinel embedded in a longer prompt body still wins over a slash marker.
      assert.equal(
        deriveSkill(
          "/hydra-autopilot\n<!-- hydra-dispatch v1 skill=hydra-grill dispatchId=x runId=y -->\nbody",
        ),
        "hydra-grill",
      );
    });

    test("(2a) <command-name>/skill</command-name> marker, then (2b) leading /skill", () => {
      assert.equal(
        deriveSkill(
          "<command-message>hydra-autopilot</command-message>\n<command-name>/hydra-autopilot</command-name>",
        ),
        "hydra-autopilot",
      );
      // Leading-slash optional inside the command-name tag.
      assert.equal(
        deriveSkill("<command-name>hydra-incident</command-name>"),
        "hydra-incident",
      );
      // A raw typed slash command (no command-name wrapper).
      assert.equal(deriveSkill("/hydra-digest please summarise"), "hydra-digest");
      // Namespaced plugin:skill form.
      assert.equal(deriveSkill("<command-name>/foo:bar</command-name>"), "foo:bar");
    });

    test("(3) residual: plain prose, empty, and null all bucket to 'interactive'", () => {
      assert.equal(deriveSkill("hey can you look at this bug"), INTERACTIVE_SKILL);
      assert.equal(deriveSkill(""), INTERACTIVE_SKILL);
      assert.equal(deriveSkill(null), INTERACTIVE_SKILL);
      assert.equal(INTERACTIVE_SKILL, "interactive");
    });
  });

  describe("firstUserMessageText — extractor (issue #2402)", () => {
    test("returns the first non-meta user message text (string content)", () => {
      const lines = [
        assistantLine("2026-05-25T10:00:00Z", { in: 1 }, "claude-opus-4-7"),
        userLine("<local-command-caveat>banner</local-command-caveat>", { meta: true }),
        userLine("/hydra-dev real prompt"),
        userLine("a later message"),
      ];
      assert.equal(firstUserMessageText(lines), "/hydra-dev real prompt");
    });

    test("concatenates text blocks of an array content; skips blank/meta lines", () => {
      const arrayContentLine = JSON.stringify({
        type: "user",
        timestamp: "2026-05-25T10:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<command-name>/hydra-qa</command-name>" },
            { type: "image", source: {} },
          ],
        },
      });
      assert.equal(firstUserMessageText([arrayContentLine]).trim(), "<command-name>/hydra-qa</command-name>");
    });

    test("returns null when there is no readable first user message", () => {
      assert.equal(firstUserMessageText([]), null);
      assert.equal(
        firstUserMessageText([assistantLine("2026-05-25T10:00:00Z", { in: 1 }, "claude-opus-4-7")]),
        null,
      );
      // A user line whose content is only whitespace is skipped.
      assert.equal(firstUserMessageText([userLine("   ")]), null);
    });
  });

  describe("bySkillByModel cross-tab (issue #693, #2402)", () => {
    // A SkillResolver backed by a fixed firstUserText -> skill map (issue #2402:
    // the resolver now keys on the first user message text, not sessionId).
    // Records calls so the O(files) resolution invariant can be asserted.
    function fakeResolver(
      map: Record<string, string>,
      calls?: string[],
    ): SkillResolver {
      return (firstUserText: string | null) => {
        const key = firstUserText ?? "";
        if (calls) calls.push(key);
        return map[key] ?? INTERACTIVE_SKILL;
      };
    }

    test("derives skill in-transcript: sentinel + slash marker buckets, production resolver", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        // sess-dev.jsonl carries a sentinel -> hydra-dev; sess-qa.jsonl a slash
        // marker -> hydra-qa. No resolveSkill injected: exercises the production
        // deriveSkill path (the #2402 acceptance criterion).
        await writeFixture(root, "p/sess-dev.jsonl", [
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"), // opus 100
          assistantLine(t, { in: 40 }, "claude-sonnet-4-6"), // sonnet 40
        ]);
        await writeFixture(root, "p/sess-qa.jsonl", [
          userLine("<command-name>/hydra-qa</command-name>"),
          assistantLine(t, { in: 25 }, "claude-haiku-4-5"), // haiku 25
          assistantLine(t, { in: 60 }, "claude-opus-4-7"), // opus 60
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        assert.ok(snap.bySkillByModel["hydra-dev"], "real skill name, not 'unattributed'");
        assert.ok(snap.bySkillByModel["hydra-qa"]);
        assert.equal(snap.bySkillByModel["hydra-dev"].opus.total, 100);
        assert.equal(snap.bySkillByModel["hydra-dev"].sonnet.total, 40);
        assert.equal(snap.bySkillByModel["hydra-dev"].haiku.total, 0);
        assert.equal(snap.bySkillByModel["hydra-qa"].haiku.total, 25);
        assert.equal(snap.bySkillByModel["hydra-qa"].opus.total, 60);
        // No interactive residual bucket when every session resolved a signal.
        assert.equal(snap.bySkillByModel[INTERACTIVE_SKILL], undefined);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("sessions with no sentinel/marker bucket under 'interactive' (production path)", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/known.jsonl", [
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
        ]);
        // No first user message at all -> interactive residual.
        await writeFixture(root, "p/legacy.jsonl", [
          assistantLine(t, { in: 70 }, "claude-sonnet-4-6"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        assert.equal(snap.bySkillByModel["hydra-dev"].opus.total, 100);
        assert.ok(snap.bySkillByModel[INTERACTIVE_SKILL]);
        assert.equal(snap.bySkillByModel[INTERACTIVE_SKILL].sonnet.total, 70);
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
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
          assistantLine(t, { in: 30 }, "claude-sonnet-4-6"),
        ]);
        await writeFixture(root, "p/b.jsonl", [
          userLine("<command-name>/hydra-qa</command-name>"),
          assistantLine(t, { in: 50 }, "claude-opus-4-6"),
          assistantLine(t, { in: 9 }, "<synthetic>"), // unknown
        ]);
        // c has no signal -> interactive residual.
        await writeFixture(root, "p/c.jsonl", [
          assistantLine(t, { in: 11 }, "claude-haiku-4-5"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

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
        const firstText = "<command-name>/hydra-dev</command-name>";
        await writeFixture(root, "p/sess.jsonl", [
          userLine(firstText),
          assistantLine(t, { in: 10 }, "claude-opus-4-7"),
          assistantLine(t, { in: 10 }, "claude-opus-4-7"),
          assistantLine(t, { in: 10 }, "claude-sonnet-4-6"),
          assistantLine(t, { in: 10 }, "claude-haiku-4-5"),
        ]);

        const calls: string[] = [];
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          resolveSkill: fakeResolver({ [firstText]: "hydra-dev" }, calls),
        });

        assert.deepEqual(calls, [firstText]);
        assert.equal(snap.bySkillByModel["hydra-dev"].opus.total, 20);
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
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

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
      });
      assert.deepEqual(snap.bySkillByModel, {});
    });
  });

  describe("deriveDispatchKind — precedence projection (issue #2403)", () => {
    test("sentinel -> autopilot-dispatched", () => {
      assert.equal(
        deriveDispatchKind(
          "<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=x runId=y -->",
        ),
        "autopilot-dispatched",
      );
    });

    test("a sentinel embedded in a longer prompt still wins -> autopilot-dispatched", () => {
      assert.equal(
        deriveDispatchKind(
          "preamble text <!-- hydra-dispatch v1 skill=hydra-qa dispatchId=x runId=z --> more",
        ),
        "autopilot-dispatched",
      );
    });

    test("<command-name> marker -> operator-invoked", () => {
      assert.equal(
        deriveDispatchKind("<command-name>hydra-incident</command-name>"),
        "operator-invoked",
      );
      assert.equal(
        deriveDispatchKind("<command-name>/hydra-qa</command-name>"),
        "operator-invoked",
      );
    });

    test("leading /slash -> operator-invoked", () => {
      assert.equal(deriveDispatchKind("/hydra-digest please summarise"), "operator-invoked");
    });

    test("no marker / empty / null -> interactive residual", () => {
      assert.equal(deriveDispatchKind("hey can you look at this bug"), "interactive");
      assert.equal(deriveDispatchKind(""), "interactive");
      assert.equal(deriveDispatchKind(null), "interactive");
    });

    test("is total: every input lands in exactly one of the three kinds", () => {
      for (const input of [
        "<!-- hydra-dispatch v1 skill=s runId=r -->",
        "<command-name>/x</command-name>",
        "/y",
        "plain",
        "",
        null,
      ]) {
        assert.ok(
          DISPATCH_KINDS.includes(deriveDispatchKind(input)),
          `kind for ${JSON.stringify(input)} must be one of DISPATCH_KINDS`,
        );
      }
    });
  });

  describe("deriveAttributedPercent — coverage % pure fold (issue #2403)", () => {
    const b = (total: number) => ({ ...EMPTY, input: total, total });
    const EMPTY = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
    const row = (opus: number) => ({
      opus: b(opus),
      sonnet: { ...EMPTY },
      haiku: { ...EMPTY },
      unknown: { ...EMPTY },
    });

    test("0 when total is 0 (no division by zero)", () => {
      assert.equal(deriveAttributedPercent(emptyByDispatchKind()), 0);
    });

    test("0 when every token is interactive (the pre-#2402 all-residual world)", () => {
      const k = emptyByDispatchKind();
      k.interactive = row(500);
      assert.equal(deriveAttributedPercent(k), 0);
    });

    test("100 when no interactive tokens", () => {
      const k = emptyByDispatchKind();
      k["autopilot-dispatched"] = row(300);
      k["operator-invoked"] = row(100);
      assert.equal(deriveAttributedPercent(k), 100);
    });

    test("(total - interactive)/total * 100 on a mixed split", () => {
      const k = emptyByDispatchKind();
      k["autopilot-dispatched"] = row(60);
      k["operator-invoked"] = row(20);
      k.interactive = row(20);
      // (100 - 20) / 100 * 100 = 80
      assert.equal(deriveAttributedPercent(k), 80);
    });
  });

  describe("byDispatchKind cross-tab + attributedPercent (issue #2403)", () => {
    test("production path partitions sentinel/slash/interactive into the three kinds", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        // sentinel -> autopilot-dispatched
        await writeFixture(root, "p/auto.jsonl", [
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
        ]);
        // slash marker -> operator-invoked
        await writeFixture(root, "p/op.jsonl", [
          userLine("<command-name>/hydra-qa</command-name>"),
          assistantLine(t, { in: 40 }, "claude-sonnet-4-6"),
        ]);
        // no signal -> interactive
        await writeFixture(root, "p/inter.jsonl", [
          assistantLine(t, { in: 60 }, "claude-haiku-4-5"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        assert.equal(snap.byDispatchKind["autopilot-dispatched"].opus.total, 100);
        assert.equal(snap.byDispatchKind["operator-invoked"].sonnet.total, 40);
        assert.equal(snap.byDispatchKind.interactive.haiku.total, 60);
        // attributedPercent = (200 - 60) / 200 * 100 = 70
        assert.equal(snap.attributedPercent, 70);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("all three kind keys always present (zero-valued where empty)", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/only-auto.jsonl", [
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        for (const kind of DISPATCH_KINDS) {
          assert.ok(snap.byDispatchKind[kind], `kind key ${kind} must be present`);
        }
        assert.equal(snap.byDispatchKind["operator-invoked"].opus.total, 0);
        assert.equal(snap.byDispatchKind.interactive.opus.total, 0);
        assert.equal(snap.attributedPercent, 100);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("reconciliation: Σ over kinds of byDispatchKind[*][f] === byModel[f] per family", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/a.jsonl", [
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
          assistantLine(t, { in: 30 }, "claude-sonnet-4-6"),
        ]);
        await writeFixture(root, "p/b.jsonl", [
          userLine("<command-name>/hydra-qa</command-name>"),
          assistantLine(t, { in: 50 }, "claude-opus-4-6"),
          assistantLine(t, { in: 9 }, "<synthetic>"), // unknown
        ]);
        await writeFixture(root, "p/c.jsonl", [
          assistantLine(t, { in: 11 }, "claude-haiku-4-5"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        for (const family of ["opus", "sonnet", "haiku", "unknown"] as const) {
          for (const field of [
            "input",
            "output",
            "cacheRead",
            "cacheCreation",
            "total",
          ] as const) {
            const summed = DISPATCH_KINDS.reduce(
              (acc, kind) => acc + snap.byDispatchKind[kind][family][field],
              0,
            );
            assert.equal(
              summed,
              snap.byModel[family][field],
              `kind cross-tab must reconcile to byModel for ${family}.${field}`,
            );
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("kind partition reconciles to the SAME tokens as bySkillByModel per family", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        const t = "2026-05-25T11:00:00Z";
        await writeFixture(root, "p/a.jsonl", [
          sentinelLine("hydra-dev"),
          assistantLine(t, { in: 100 }, "claude-opus-4-7"),
        ]);
        await writeFixture(root, "p/b.jsonl", [
          assistantLine(t, { in: 70 }, "claude-sonnet-4-6"),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });

        for (const family of ["opus", "sonnet", "haiku", "unknown"] as const) {
          const bySkill = Object.values(snap.bySkillByModel).reduce(
            (acc, r) => acc + r[family].total,
            0,
          );
          const byKind = DISPATCH_KINDS.reduce(
            (acc, kind) => acc + snap.byDispatchKind[kind][family].total,
            0,
          );
          assert.equal(byKind, bySkill, `both partitions must cover the same ${family} tokens`);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("attributedPercent is 0 when no transcripts produced in-window tokens", async () => {
      const snap = await getUsage({
        now: new Date("2026-05-25T12:00:00Z"),
        projectsRoot: "/does/not/exist/anywhere",
        force: true,
      });
      assert.equal(snap.attributedPercent, 0);
      for (const kind of DISPATCH_KINDS) {
        assert.equal(snap.byDispatchKind[kind].opus.total, 0);
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
        bySkillWoW: {},
        byDispatchKind: {
          "autopilot-dispatched": {
            opus: { ...empty },
            sonnet: { ...empty },
            haiku: { ...empty },
            unknown: { ...empty },
          },
          "operator-invoked": {
            opus: { ...empty },
            sonnet: { ...empty },
            haiku: { ...empty },
            unknown: { ...empty },
          },
          interactive: {
            opus: { ...empty },
            sonnet: { ...empty },
            haiku: { ...empty },
            unknown: { ...empty },
          },
        },
        attributedPercent: 0,
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
      // The default thresholds, passed explicitly into the now-pure fold
      // (issue #2550): fiveHourThrottleShed no longer reads process.env — the
      // caller supplies the parsed fractions. Tests exercise pinned tiers by
      // passing them directly, NO process.env mutation needed.
      const D1 = DEFAULT_FIVE_HOUR_THROTTLE_T1;
      const D2 = DEFAULT_FIVE_HOUR_THROTTLE_T2;

      test("defaults are 0.60 / 0.75", () => {
        assert.equal(DEFAULT_FIVE_HOUR_THROTTLE_T1, 0.6);
        assert.equal(DEFAULT_FIVE_HOUR_THROTTLE_T2, 0.75);
      });

      test("below T1 (59%): no shed", () => {
        assert.deepEqual([...fiveHourThrottleShed(oauthSnap(59), D1, D2)], []);
        const v = projectEligibility(oauthSnap(59));
        assert.deepEqual([...v.shed], []);
        assert.equal(v.reasons.fiveHourThrottleShed, false);
        assert.equal(v.allow, true);
      });

      test("exactly at T1 (60%): T1 set sheds (boundary is inclusive)", () => {
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(60), D1, D2)), T1);
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
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(70), D1, D2)), T1);
      });

      test("exactly at T2 (75%): T1 ∪ T2; dev_orch shed but qa_* + dev_target kept", () => {
        const shed = new Set(fiveHourThrottleShed(oauthSnap(75), D1, D2));
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
        assert.deepEqual([...fiveHourThrottleShed(snap, D1, D2)], []);
        const v = projectEligibility(snap);
        assert.deepEqual([...v.shed], []);
        assert.equal(v.reasons.fiveHourThrottleShed, false);
      });

      test("custom T1/T2 thresholds honoured (pure fold over passed args)", () => {
        // Pass custom thresholds directly — no process.env mutation (#2550).
        // 45% crosses the custom T1 (0.40) but not the custom T2 (0.50).
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(45), 0.4, 0.5)), T1);
        // 55% crosses both.
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(55), 0.4, 0.5)), T1T2);
        // 35% below custom T1 → no shed.
        assert.deepEqual([...fiveHourThrottleShed(oauthSnap(35), 0.4, 0.5)], []);
      });

      test("env override threads through projectEligibility's getters", () => {
        // projectEligibility reads HYDRA_USAGE_5H_THROTTLE_T1/_T2 via the Cost
        // env-reader leaf (cost/config.ts) and passes the parsed fractions into
        // the fold — the full env-read→fold path stays behavior-preserving.
        process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0.40";
        process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "0.50";
        // 45% crosses the custom T1 but not the custom T2 → T1 only.
        assert.deepEqual(new Set(projectEligibility(oauthSnap(45)).shed), T1);
        // 55% crosses both.
        assert.deepEqual(new Set(projectEligibility(oauthSnap(55)).shed), T1T2);
        // 35% below custom T1 → no shed.
        assert.deepEqual([...projectEligibility(oauthSnap(35)).shed], []);
      });

      test("mis-set T2 < T1: T2 cut never inverts below T1 (pure fold)", () => {
        // T1=0.70, T2=0.50 passed directly; T2 clamped up to max(70,50)=70.
        // At 65% → no shed.
        assert.deepEqual([...fiveHourThrottleShed(oauthSnap(65), 0.7, 0.5)], []);
        // At 72% → both tiers fire together (T2 boundary == T1 boundary).
        assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(72), 0.7, 0.5)), T1T2);
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
  // 5h-throttle threshold env-readers (relocated to cost/config.ts in #2550).
  // These are the env-read seam the fiveHourThrottleShed fold no longer owns:
  // parse a fraction in (0,1); unset/empty/invalid → default + fail-loud.
  // -------------------------------------------------------------------------
  describe("getFiveHourThrottleT1 / getFiveHourThrottleT2", () => {
    const restore = withEnvSnapshot();
    afterEach(() => restore());

    test("unset → default", () => {
      delete process.env.HYDRA_USAGE_5H_THROTTLE_T1;
      delete process.env.HYDRA_USAGE_5H_THROTTLE_T2;
      assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
      assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
    });

    test("empty → default", () => {
      process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "";
      process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "";
      assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
      assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
    });

    test("valid fraction in (0,1) is used", () => {
      process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0.4";
      process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "0.5";
      assert.equal(getFiveHourThrottleT1(), 0.4);
      assert.equal(getFiveHourThrottleT2(), 0.5);
    });

    test("non-finite / non-numeric → default (fail-loud, no throw)", () => {
      process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "not-a-number";
      process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "NaN";
      assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
      assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
    });

    test("≤0 → default", () => {
      process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0";
      process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "-0.2";
      assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
      assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
    });

    test("≥1 → default (must be a strict fraction below 1)", () => {
      process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "1";
      process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "1.5";
      assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
      assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
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

  describe("estimate/OAuth divergence env parsing (issue #2832 AC3)", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = withEnvSnapshot();
    });
    afterEach(() => restore());

    test("factor defaults to 1.5 when unset", () => {
      delete process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR;
      assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
      assert.equal(DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR, 1.5);
    });

    test("factor falls back to default on <= 1 / non-finite", () => {
      process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "1";
      assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
      process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "0.5";
      assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
      process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "nope";
      assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
    });

    test("factor is the parsed value when > 1", () => {
      process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "2.5";
      assert.equal(getOAuthEstimateDivergenceFactor(), 2.5);
    });
  });

  // AC3: the pure estimate-vs-OAuth divergence detector (issue #2832). Fires a
  // single console.warn when the fail-open transcript estimate has drifted far
  // from the last-known real meter value DURING an OAuth outage.
  describe("detectEstimateOAuthDivergence — pure detector (issue #2832 AC3)", () => {
    let warnings: string[];
    let origWarn: typeof console.warn;
    beforeEach(() => {
      warnings = [];
      origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(" "));
      };
    });
    afterEach(() => {
      console.warn = origWarn;
    });

    function divergenceWarnings(): string[] {
      return warnings.filter((w) => w.includes("estimate/OAuth divergence"));
    }

    test("inert while the headline is on OAuth (never fires with a live/stale meter)", () => {
      detectEstimateOAuthDivergence({
        usageSource: "oauth",
        estimatePercentLast7d: 95,
        lastKnownOAuthPercent: 10, // wildly divergent, but usageSource is oauth
        divergenceFactor: 1.5,
      });
      assert.equal(divergenceWarnings().length, 0);
    });

    test("inert when no last-known OAuth value exists (null baseline — #1083 silent-0 trap)", () => {
      detectEstimateOAuthDivergence({
        usageSource: "estimate",
        estimatePercentLast7d: 95,
        lastKnownOAuthPercent: null,
        divergenceFactor: 1.5,
      });
      assert.equal(divergenceWarnings().length, 0);
    });

    test("inert when the last-known OAuth baseline is 0 (undefined ratio)", () => {
      detectEstimateOAuthDivergence({
        usageSource: "estimate",
        estimatePercentLast7d: 40,
        lastKnownOAuthPercent: 0,
        divergenceFactor: 1.5,
      });
      assert.equal(divergenceWarnings().length, 0);
    });

    test("fires ONCE when the estimate is > factor ABOVE the last-known OAuth value", () => {
      // estimate 60% vs last-known 20% = 3x > 1.5x -> warn.
      detectEstimateOAuthDivergence({
        usageSource: "estimate",
        estimatePercentLast7d: 60,
        lastKnownOAuthPercent: 20,
        divergenceFactor: 1.5,
      });
      assert.equal(divergenceWarnings().length, 1);
    });

    test("fires when the estimate is > factor BELOW the last-known OAuth value", () => {
      // estimate 10% vs last-known 40% = 0.25x < 1/1.5 -> warn.
      detectEstimateOAuthDivergence({
        usageSource: "estimate",
        estimatePercentLast7d: 10,
        lastKnownOAuthPercent: 40,
        divergenceFactor: 1.5,
      });
      assert.equal(divergenceWarnings().length, 1);
    });

    test("does NOT fire when the estimate is within the factor band of the OAuth value", () => {
      // estimate 25% vs last-known 20% = 1.25x, inside 1.5x -> no warn.
      detectEstimateOAuthDivergence({
        usageSource: "estimate",
        estimatePercentLast7d: 25,
        lastKnownOAuthPercent: 20,
        divergenceFactor: 1.5,
      });
      assert.equal(divergenceWarnings().length, 0);
    });
  });

  // AC3 end-to-end through getUsage: the divergence detector wired into
  // assembleSnapshot fires exactly when the headline is on the estimate AND a
  // last-known OAuth value exists that the estimate has drifted far from.
  describe("estimate/OAuth divergence detector wired through getUsage (issue #2832 AC3)", () => {
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

    function divergenceWarnings(): string[] {
      return warnings.filter((w) => w.includes("estimate/OAuth divergence"));
    }

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

    test("fires ONCE after the OAuth meter goes too-stale and the estimate diverges > 1.5x from last-known", async () => {
      // 7d weekly quota 1000; transcript burns 900 -> estimate 90%. Last-known
      // OAuth 7d = 30% seeded, then a sustained outage takes it past TTL+maxStale
      // so the headline falls to the 90% estimate — 3x the last-known 30% -> warn.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "60000"; // 1 min grace
      const root = await mkdtemp(join(tmpdir(), "usage-2832-"));
      try {
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:30:00Z", { in: 900 }),
        ]);
        const m = countingMeter([
          { ok: true, five: 5, seven: 30 }, // seed last-good: real 7d = 30%
          { ok: false, code: "oauth-usage-non-2xx" }, // sustained outage
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        const first = await getUsage({
          now: t0,
          projectsRoot: root,
          force: true,
          useOAuthCache: true,
          readUsage: m.reader,
        });
        assert.equal(first.usageSource, "oauth"); // fresh meter backs the headline
        assert.equal(divergenceWarnings().length, 0, "no divergence while OAuth backs the headline");

        // 5 min later: age (300s) >= TTL(60s)+maxStale(60s) => too stale, falls
        // to the 90% estimate; last-known 30% rides in on lastKnownOAuth.
        const tFar = new Date(t0.getTime() + 300_000);
        const second = await getUsage({
          now: tFar,
          projectsRoot: root,
          force: true,
          useOAuthCache: true,
          readUsage: m.reader,
        });
        assert.equal(second.usageSource, "estimate", "too-stale meter falls to the estimate");
        assert.equal(second.percentLast7d, 90, "estimate gauge stands (never silently 0)");
        assert.equal(divergenceWarnings().length, 1, "fires once on the estimate/last-known divergence");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("does NOT fire when the estimate stays within 1.5x of the last-known OAuth value", async () => {
      // estimate 40% vs last-known 7d 35% = ~1.14x, inside 1.5x -> no warn.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000";
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "60000";
      const root = await mkdtemp(join(tmpdir(), "usage-2832-"));
      try {
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:30:00Z", { in: 400 }),
        ]);
        const m = countingMeter([
          { ok: true, five: 5, seven: 35 },
          { ok: false, code: "oauth-usage-non-2xx" },
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        const tFar = new Date(t0.getTime() + 300_000);
        const snap = await getUsage({ now: tFar, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(snap.usageSource, "estimate");
        assert.equal(snap.percentLast7d, 40);
        assert.equal(divergenceWarnings().length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
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

    test("HARD INVARIANT: a FAILED meter read falls back to the estimate gauge, NEVER 0", async () => {
      // The GAUGE invariant (the only one this test still guards): the estimate
      // computes 95% and a failed OAuth read keeps that headline, NOT a silent 0.
      // Since #1124 the STOP decision is decoupled from this estimate — the
      // headline staying 95 no longer implies a stop (see the dedicated #1124
      // "estimate never stops" test). emergencyStop is now false on the estimate
      // path; the gauge invariant is unchanged.
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
        assert.equal(snap.percentLast5h, 95); // estimate gauge stands — NOT 0
        // #1124: the estimate gauge no longer drives the stop.
        assert.equal(snap.emergencyStop, false);
        assert.equal(projectEligibility(snap).allow, true);
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

  // Hard-stop fires ONLY on the real OAuth meter, never on the transcript
  // estimate (issue #1124). The estimate is a ~half-of-real guess (#1083) whose
  // false stops during OAuth outages this decouples — the gauge still shows it
  // (#1090), but the STOP decision is gated on `usageSource === "oauth"`.
  describe("hard-stop gated on real OAuth, never the estimate (issue #1124)", () => {
    let restoreEnv: () => void;
    beforeEach(() => {
      restoreEnv = withEnvSnapshot();
      clearUsageCache();
    });
    afterEach(() => {
      restoreEnv();
      clearUsageCache();
    });

    const meterFail = (code: any) => async () => ({ ok: false as const, code });

    test("AC: usageSource=estimate @95% → emergencyStop=false AND projectEligibility().allow=true", async () => {
      // Calibrated so the estimate computes a concrete 95% (>=90); a FAILED
      // OAuth read flips usageSource to 'estimate'. Pre-#1124 this stopped
      // autopilot on a guess; now the estimate never stops.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      const root = await mkdtemp(join(tmpdir(), "usage-1124-"));
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
        // Gauge preserved (#1090): the headline still reads the estimate, NOT 0.
        assert.equal(snap.percentLast5h, 95);
        // But the STOP decision is decoupled: the estimate never stops.
        assert.equal(snap.emergencyStop, false);
        assert.equal(snap.weeklyEmergencyStop, false);
        assert.equal(projectEligibility(snap).allow, true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("AC: usageSource=oauth @95% → emergencyStop=true, allow=false (real cap still stops)", async () => {
      // Uncalibrated estimate (no quota env) — proves the OAuth meter ALONE
      // trips the stop independent of any transcript calibration.
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      const root = await mkdtemp(join(tmpdir(), "usage-1124-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 10 })]);
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: async () => ({
            ok: true as const,
            data: {
              fiveHour: { utilization: 95, resetsAt: null },
              sevenDay: { utilization: 40, resetsAt: null },
            },
          }),
        });
        assert.equal(snap.usageSource, "oauth");
        assert.equal(snap.percentLast5h, 95);
        assert.equal(snap.emergencyStop, true);
        assert.equal(projectEligibility(snap).allow, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("AC: weekly hard-stop rides OAuth percentLast7d — fires @90%+ on the meter path", async () => {
      delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
      delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
      const root = await mkdtemp(join(tmpdir(), "usage-1124-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 10 })]);
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: async () => ({
            ok: true as const,
            data: {
              fiveHour: { utilization: 40, resetsAt: null }, // 5h well under cap
              sevenDay: { utilization: 91, resetsAt: null }, // 7d over the cap
            },
          }),
        });
        assert.equal(snap.usageSource, "oauth");
        assert.equal(snap.emergencyStop, false, "5h is under the cap");
        assert.equal(snap.weeklyEmergencyStop, true, "OAuth 7d >=90 trips the weekly stop");
        assert.equal(projectEligibility(snap).allow, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("AC: weekly hard-stop SUPPRESSED on the estimate path even when since-reset is high", async () => {
      // Pre-#1124 weeklyEmergencyStop rode percentSinceReset (a calibration
      // estimate). Seed the anchor + enough burn to drive percentSinceReset
      // >=90, then FAIL the OAuth read so usageSource='estimate'. The weekly
      // stop must NOT fire on that guess.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000000"; // 5h huge => no 5h stop
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-25T00:00:00Z";
      const root = await mkdtemp(join(tmpdir(), "usage-1124-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        // 950 tokens since the anchor against a 1000 weekly quota => 95%.
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T06:00:00Z", { in: 900, out: 50 })]);
        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: meterFail("oauth-usage-network"),
        });
        assert.equal(snap.usageSource, "estimate");
        assert.ok(snap.percentSinceReset >= 90, "since-reset estimate is high (would have stopped pre-#1124)");
        assert.equal(snap.weeklyEmergencyStop, false, "estimate never trips the weekly stop");
        assert.equal(projectEligibility(snap).allow, true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("AC: a served-stale last-good OAuth value @95% STILL stops (stale-but-real)", async () => {
      // usageSource stays 'oauth' (oauthStale=true) when a 429 serves last-good.
      // A stale-but-REAL meter value at >=90 must still trigger emergencyStop —
      // only the (non-OAuth) estimate path is decoupled.
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "300000"; // 5 min grace
      const root = await mkdtemp(join(tmpdir(), "usage-1124-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 10 })]);
        // First read seeds last-good = 95%; second (post-TTL) 429s → served stale.
        let calls = 0;
        const reader = async (): Promise<OAuthUsageResult> => {
          const seed = calls === 0;
          calls++;
          if (seed) {
            return {
              ok: true as const,
              data: {
                fiveHour: { utilization: 95, resetsAt: null },
                sevenDay: { utilization: 40, resetsAt: null },
              },
            };
          }
          return { ok: false as const, code: "oauth-usage-non-2xx" };
        };
        const t0 = new Date("2026-05-25T12:00:00Z");
        const first = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: reader });
        assert.equal(first.usageSource, "oauth");
        assert.equal(first.emergencyStop, true);

        // 90s later (> 60s TTL, < TTL+grace): serve last-good as STALE oauth.
        const t1 = new Date(t0.getTime() + 90_000);
        const second = await getUsage({ now: t1, projectsRoot: root, force: true, useOAuthCache: true, readUsage: reader });
        assert.equal(second.usageSource, "oauth", "served-stale is still oauth, not estimate");
        assert.equal(second.oauthStale, true);
        assert.equal(second.percentLast5h, 95);
        assert.equal(second.emergencyStop, true, "stale-but-real still stops");
        assert.equal(projectEligibility(second).allow, false);
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

    test("getOAuthUsageMaxStaleMs: defaults to the DECOUPLED constant (NOT the TTL), honours override (issue #2574)", () => {
      // Decoupled from the TTL (#2574): an unset max-stale falls back to its own
      // DEFAULT_OAUTH_USAGE_MAX_STALE_MS constant, independent of the TTL value.
      delete process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS;
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "90000";
      assert.equal(
        getOAuthUsageMaxStaleMs(),
        DEFAULT_OAUTH_USAGE_MAX_STALE_MS,
        "unset max-stale uses its own default, not the TTL",
      );
      assert.notEqual(
        getOAuthUsageMaxStaleMs(),
        90000,
        "the max-stale default is decoupled from the TTL — must not track it",
      );
      // An explicit override is still honoured verbatim.
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "30000";
      assert.equal(getOAuthUsageMaxStaleMs(), 30000);
      // A non-empty-but-invalid value falls back to the decoupled constant (not the TTL).
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "bad";
      assert.equal(getOAuthUsageMaxStaleMs(), DEFAULT_OAUTH_USAGE_MAX_STALE_MS);
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "-5";
      assert.equal(getOAuthUsageMaxStaleMs(), DEFAULT_OAUTH_USAGE_MAX_STALE_MS);
    });

    test("DEFAULT_OAUTH_USAGE_MAX_STALE_MS is 30min and decoupled from the TTL default (issue #2574)", () => {
      // The constant value is load-bearing: it sets the too-stale cliff at
      // TTL+maxStale. At the 5min TTL default + 30min max-stale this gives a
      // ~35min servable window that rides through the 2026-06-30 multi-minute
      // 429 burst (which ran past the old 10min cliff and flipped to estimate).
      assert.equal(DEFAULT_OAUTH_USAGE_MAX_STALE_MS, 1_800_000);
      assert.notEqual(
        DEFAULT_OAUTH_USAGE_MAX_STALE_MS,
        DEFAULT_OAUTH_USAGE_TTL_MS,
        "the two defaults are independent levers, not the same number",
      );
      assert.ok(
        DEFAULT_OAUTH_USAGE_TTL_MS + DEFAULT_OAUTH_USAGE_MAX_STALE_MS > 600_000,
        "default servable window exceeds the old 10min cliff that the incident breached",
      );
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
        // Estimate = (950 / 1000) * 100 = 95% (the gauge stands; #1124 decouples
        // the STOP from it so emergencyStop is false on this estimate path).
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
        assert.equal(snap.percentLast5h, 95, "estimate gauge stands — never silently 0");
        // #1124: the estimate gauge no longer drives the stop.
        assert.equal(snap.emergencyStop, false, "estimate path never trips the hard-stop");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("issue #2574: a multi-minute 429 burst rides through on stale-but-real OAuth with the DEFAULT max-stale (env UNSET)", async () => {
      // Reproduces the 2026-06-30 incident shape against the NEW decoupled
      // default: TTL stays 5min, max-stale is left UNSET so it uses the 30min
      // DEFAULT_OAUTH_USAGE_MAX_STALE_MS (servable window ~35min). A meter that
      // 429s for ~10 minutes past the seeding read — the exact window that
      // breached the OLD 10min cliff (TTL+TTL) and flipped to estimate — must
      // now STILL serve the stale-but-real OAuth value and keep enforcing the
      // ceiling, never degrading to the fail-open transcript estimate.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "300000"; // 5min — production default
      delete process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS; // rely on the 30min decoupled default
      const root = await mkdtemp(join(tmpdir(), "usage-2574-"));
      try {
        // Estimate would read 95% — proving we stay on the OAuth 92%, not the estimate.
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:30:00Z", { in: 900, out: 50 })]);
        const m = countingMeter([
          { ok: true, five: 92, seven: 60 }, // seed last-good = real 92%
          { ok: false, code: "oauth-usage-non-2xx" }, // sustained 429 burst
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        const first = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(first.usageSource, "oauth");
        assert.equal(first.percentLast5h, 92);

        // ~10.5 min later — PAST the old 10min (TTL+TTL) cliff, but well inside
        // the new ~35min window. Under the old coupled default this fell to
        // estimate; now it rides through as stale-but-real oauth.
        const tBurst = new Date(t0.getTime() + 630_000); // 10.5 min — the 601371ms-shaped breach
        const second = await getUsage({ now: tBurst, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(second.usageSource, "oauth", "rides the 429 burst on stale-but-real OAuth (was 'estimate' pre-#2574)");
        assert.equal(second.percentLast5h, 92, "serves the last-good real 92%, not the 95% estimate");
        assert.equal(second.oauthStale, true);
        assert.equal(second.oauthAgeMs, 630_000, "surfaces the served value's age for observability");
        // Ceiling enforcement stays on ground truth through the burst.
        assert.equal(second.emergencyStop, true, "stale-but-real >=90% still trips the hard stop");
        assert.equal(projectEligibility(second).allow, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("issue #2574: a multi-HOUR outage still falls through to the estimate with the DEFAULT max-stale (env UNSET)", async () => {
      // The decoupled default widens — but does NOT remove — the eventual
      // fall-through. A genuine multi-hour outage (age past TTL+30min) is still
      // too stale to trust, so the headline correctly degrades to the fail-open
      // estimate (#1124: the estimate never trips the hard stop).
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "300000"; // 5min
      delete process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS; // 30min default → ~35min cliff
      const root = await mkdtemp(join(tmpdir(), "usage-2574-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:30:00Z", { in: 900, out: 50 })]);
        const m = countingMeter([
          { ok: true, five: 92, seven: 60 },
          { ok: false, code: "oauth-usage-non-2xx" },
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        // 2 hours later: age (7200s) >= TTL(300s)+maxStale(1800s) = 2100s → too stale.
        const tHours = new Date(t0.getTime() + 2 * 60 * 60_000);
        const snap = await getUsage({ now: tHours, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(snap.usageSource, "estimate", "a multi-hour outage past TTL+30min still falls to the estimate");
        assert.equal(snap.oauthStale, false);
        assert.equal(snap.oauthAgeMs, null);
        assert.equal(snap.percentLast5h, 95, "estimate gauge stands — never silently 0 (#1083)");
        assert.equal(snap.emergencyStop, false, "estimate path never trips the hard stop (#1124 fail-open)");
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

  // Exponential backoff on the OAuth meter GET (issue #2619). Before this, once
  // the OAuth TTL expired every scan UNCONDITIONALLY re-attempted the external
  // GET, so a sustained 429 produced ~1–2 GETs/min (~90–100 failed reads/hour)
  // that kept hammering the rate-limited endpoint. Backoff now SKIPS the GET
  // while inside an exponentially-growing window after a failure, and resets to
  // the healthy fixed-TTL cadence on the first success.
  describe("OAuth meter exponential backoff (issue #2619)", () => {
    let restoreEnv: () => void;
    beforeEach(() => {
      restoreEnv = withEnvSnapshot();
      clearUsageCache();
    });
    afterEach(() => {
      restoreEnv();
      clearUsageCache();
    });

    // Counting meter identical in shape to the #1090 block's — local so this
    // sibling describe is self-contained.
    function countingMeter(
      results: Array<{ ok: boolean; five?: number; seven?: number; code?: any }>,
    ) {
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

    test("getOAuthUsageBackoffBaseMs / MaxMs: default, override, and invalid fall-back", () => {
      delete process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS;
      assert.equal(getOAuthUsageBackoffBaseMs(), DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS);
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "45000";
      assert.equal(getOAuthUsageBackoffBaseMs(), 45000);
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "not-a-number";
      assert.equal(getOAuthUsageBackoffBaseMs(), DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS);
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "-5";
      assert.equal(getOAuthUsageBackoffBaseMs(), DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS);

      delete process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS;
      assert.equal(getOAuthUsageBackoffMaxMs(), DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS);
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = "600000";
      assert.equal(getOAuthUsageBackoffMaxMs(), 600000);
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = "bad";
      assert.equal(getOAuthUsageBackoffMaxMs(), DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS);
    });

    test("oauthBackoffDelayMs: doubles per consecutive failure and clamps to the ceiling", () => {
      // base * 2^(failures-1), clamped to maxMs.
      assert.equal(oauthBackoffDelayMs(1, 30_000, 900_000), 30_000);
      assert.equal(oauthBackoffDelayMs(2, 30_000, 900_000), 60_000);
      assert.equal(oauthBackoffDelayMs(3, 30_000, 900_000), 120_000);
      assert.equal(oauthBackoffDelayMs(4, 30_000, 900_000), 240_000);
      // Grows to but never past the ceiling.
      assert.equal(oauthBackoffDelayMs(6, 30_000, 900_000), 900_000, "clamped at ceiling");
      assert.equal(oauthBackoffDelayMs(50, 30_000, 900_000), 900_000, "no overflow past ceiling");
    });

    test("backoff ENGAGES: a 429 suppresses the next GET while inside the window", async () => {
      // Seed a good read, let the TTL expire, 429 once (arms backoff), then scan
      // AGAIN inside the backoff window — the endpoint must NOT be re-GET.
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "600000"; // 10 min grace (serve stale)
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "120000"; // 2 min backoff
      const root = await mkdtemp(join(tmpdir(), "usage-2619-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
        const m = countingMeter([
          { ok: true, five: 55, seven: 33 }, // scan 1: seeds last-good
          { ok: false, code: "oauth-usage-non-2xx" }, // scan 2: 429 → arms backoff
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        // Scan 1: fresh success. GET #1.
        const first = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(first.usageSource, "oauth");
        assert.equal(m.calls(), 1);

        // Scan 2 at +90s (> 60s TTL): 429. The GET fires (GET #2), backoff armed
        // for 2 min → nextAttempt = t0+90s+120s = t0+210s. Serves stale last-good.
        const t1 = new Date(t0.getTime() + 90_000);
        const second = await getUsage({ now: t1, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(second.usageSource, "oauth", "429 serves stale last-good");
        assert.equal(second.oauthStale, true);
        assert.equal(m.calls(), 2, "the first failure still attempts a GET");

        // Scan 3 at +150s: still > TTL (would GET pre-#2619) but INSIDE the backoff
        // window (< t0+210s). The GET MUST be suppressed — call count stays 2.
        const t2 = new Date(t0.getTime() + 150_000);
        const third = await getUsage({ now: t2, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 2, "backoff engaged: no GET spent while inside the window");
        assert.equal(third.usageSource, "oauth", "still serves stale last-good during backoff");
        assert.equal(third.oauthStale, true);

        // Scan 4 at +250s: PAST the backoff window (> t0+210s). A GET is attempted
        // again (GET #3) — the reader keeps 429ing, so backoff re-arms (now doubled).
        const t3 = new Date(t0.getTime() + 250_000);
        await getUsage({ now: t3, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 3, "past the window a re-probe GET fires");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("backoff RESETS on success: cadence returns to the fixed TTL", async () => {
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "600000"; // 10 min grace
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "120000"; // 2 min backoff
      const root = await mkdtemp(join(tmpdir(), "usage-2619-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
        const m = countingMeter([
          { ok: true, five: 40, seven: 20 }, // scan 1: seed
          { ok: false, code: "oauth-usage-non-2xx" }, // scan 2: 429 → arms backoff
          { ok: true, five: 70, seven: 50 }, // scan 3 (post-window): recovers
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        // +90s: 429 arms backoff until t0+210s. GET #2.
        await getUsage({ now: new Date(t0.getTime() + 90_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 2);
        // +150s: inside backoff window → GET suppressed.
        await getUsage({ now: new Date(t0.getTime() + 150_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 2, "still backing off");
        // +250s: past window → GET #3 succeeds → backoff CLEARED, cache refreshed.
        const recovered = await getUsage({ now: new Date(t0.getTime() + 250_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 3);
        assert.equal(recovered.usageSource, "oauth");
        assert.equal(recovered.percentLast5h, 70, "fresh recovered reading");
        assert.equal(recovered.oauthStale, false, "fresh, not stale, after recovery");

        // Post-recovery the cadence is the plain fixed TTL again: a scan just past
        // the TTL re-GETs normally (no lingering backoff suppression). +320s is
        // 70s after the +250s success (> 60s TTL).
        const post = await getUsage({ now: new Date(t0.getTime() + 320_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 4, "healthy fixed-TTL cadence restored — a post-TTL scan re-GETs");
        assert.equal(post.usageSource, "oauth");
        assert.equal(post.percentLast5h, 70, "reader pinned at its last programmed value");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("backoff with NO trustworthy last-good falls to the estimate without a GET", async () => {
      // If the last-good has aged past TTL+maxStale during the backoff window,
      // the suppressed scan degrades to the estimate (never a silent 0) — and
      // still spends no GET.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
      process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "60000"; // 1 min grace (short)
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "600000"; // 10 min backoff (long)
      const root = await mkdtemp(join(tmpdir(), "usage-2619-"));
      try {
        // Estimate = (300/1000)*100 = 30%.
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:30:00Z", { in: 300 })]);
        const m = countingMeter([
          { ok: true, five: 55, seven: 33 }, // seed
          { ok: false, code: "oauth-usage-non-2xx" }, // 429 arms a 10-min backoff
        ]);
        const t0 = new Date("2026-05-25T12:00:00Z");
        await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        // +90s: 429 → last-good still fresh enough to serve stale (age 90s < TTL+grace 120s). GET #2.
        await getUsage({ now: new Date(t0.getTime() + 90_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 2);
        // +180s: inside the 10-min backoff window, but last-good age (180s) >=
        // TTL+maxStale (120s) → too stale. Falls to estimate, still NO GET.
        const snap = await getUsage({ now: new Date(t0.getTime() + 180_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
        assert.equal(m.calls(), 2, "backoff still suppresses the GET even when serving the estimate");
        assert.equal(snap.usageSource, "estimate", "too-stale-during-backoff falls to estimate");
        assert.equal(snap.oauthStale, false);
        assert.equal(snap.oauthAgeMs, null);
        assert.equal(snap.percentLast5h, 30, "estimate gauge stands — never silently 0");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  // Single-flight + Retry-After honor on the OAuth meter GET (issue #2666).
  // Journalctl 2026-07-02 showed every 429 as a SAME-SECOND DUPLICATE PAIR: two
  // concurrent scans past TTL expiry each fired their own GET, burning two
  // rate-limit bucket slots and double-arming the #2619 backoff. The fix: the
  // first post-TTL caller launches the GET; concurrent callers share its
  // in-flight promise. And a 429's parsed Retry-After hint may only LENGTHEN
  // the exponential backoff, never shorten it. These tests drive the production
  // cached path directly via makeReadOAuth (bypassOAuthCache: false) with
  // pinned nowMs values — the same seam getUsage wires in.
  describe("OAuth single-flight + Retry-After honor (issue #2666)", () => {
    let restoreEnv: () => void;
    beforeEach(() => {
      restoreEnv = withEnvSnapshot();
      clearUsageCache();
    });
    afterEach(() => {
      restoreEnv();
      clearUsageCache();
    });

    const okData = {
      fiveHour: { utilization: 42, resetsAt: null },
      sevenDay: { utilization: 21, resetsAt: null },
    };

    test("single-flight: two concurrent post-TTL reads share ONE GET and one outcome", async () => {
      let resolveGate!: () => void;
      const gate = new Promise<void>((r) => (resolveGate = r));
      let calls = 0;
      const reader = async () => {
        calls++;
        await gate; // hold the GET open so the second read arrives mid-flight
        return { ok: true as const, data: okData };
      };
      const t0 = Date.parse("2026-07-02T12:00:00Z");
      const read = makeReadOAuth({ readUsage: reader, nowMs: t0, bypassOAuthCache: false });

      // Both fired before the first resolves — the second MUST NOT launch a GET.
      const p1 = read();
      const p2 = read();
      resolveGate();
      const [r1, r2] = await Promise.all([p1, p2]);

      assert.equal(calls, 1, "concurrent post-TTL reads must share a single GET");
      assert.equal(r1.result.ok, true);
      assert.equal(r2.result.ok, true);
      assert.equal(r1.result.ok && r1.result.data.fiveHour.utilization, 42);
      assert.equal(r2.result.ok && r2.result.data.fiveHour.utilization, 42);
      assert.equal(r1.stale, false);
      assert.equal(r2.stale, false);
    });

    test("single-flight: a concurrent 429 pair arms backoff ONCE (failure #1, not #2)", async () => {
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "30000"; // 30s
      let resolveGate!: () => void;
      const gate = new Promise<void>((r) => (resolveGate = r));
      let calls = 0;
      const reader = async (): Promise<OAuthUsageResult> => {
        calls++;
        await gate;
        return { ok: false, code: "oauth-usage-rate-limited" };
      };
      const t0 = Date.parse("2026-07-02T12:00:00Z");
      const read0 = makeReadOAuth({ readUsage: reader, nowMs: t0, bypassOAuthCache: false });
      const p1 = read0();
      const p2 = read0();
      resolveGate();
      await Promise.all([p1, p2]);
      assert.equal(calls, 1, "the duplicate-pair GET is gone");

      // Had the pair double-armed backoff (failures=2), the gate would run to
      // t0+60s. Single-armed (failures=1) it runs to t0+30s — so a read at
      // t0+31s must attempt a fresh GET.
      const read31 = makeReadOAuth({
        readUsage: reader,
        nowMs: t0 + 31_000,
        bypassOAuthCache: false,
      });
      await read31();
      assert.equal(calls, 2, "backoff armed once: the t0+31s read re-probes past the 30s gate");
    });

    test("Retry-After LENGTHENS the backoff gate past the exponential delay", async () => {
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "30000"; // exponential #1 = 30s
      let calls = 0;
      const reader = async (): Promise<OAuthUsageResult> => {
        calls++;
        return { ok: false, code: "oauth-usage-rate-limited", retryAfterMs: 120_000 };
      };
      const t0 = Date.parse("2026-07-02T12:00:00Z");
      await makeReadOAuth({ readUsage: reader, nowMs: t0, bypassOAuthCache: false })();
      assert.equal(calls, 1);

      // t0+60s: PAST the 30s exponential delay but INSIDE the 120s server hint —
      // the GET must stay suppressed (the hint lengthened the gate).
      const mid = await makeReadOAuth({
        readUsage: reader,
        nowMs: t0 + 60_000,
        bypassOAuthCache: false,
      })();
      assert.equal(calls, 1, "server hint honored: no GET inside the Retry-After window");
      assert.equal(mid.result.ok, false, "no last-good → backoff-suppressed failure passthrough");

      // t0+121s: past the hint — the re-probe fires.
      await makeReadOAuth({
        readUsage: reader,
        nowMs: t0 + 121_000,
        bypassOAuthCache: false,
      })();
      assert.equal(calls, 2, "past the Retry-After window the re-probe GET fires");
    });

    test("a lying `Retry-After: 0` cannot SHORTEN the exponential backoff", async () => {
      process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "30000";
      let calls = 0;
      const reader = async (): Promise<OAuthUsageResult> => {
        calls++;
        return { ok: false, code: "oauth-usage-rate-limited", retryAfterMs: 0 };
      };
      const t0 = Date.parse("2026-07-02T12:00:00Z");
      await makeReadOAuth({ readUsage: reader, nowMs: t0, bypassOAuthCache: false })();
      assert.equal(calls, 1);

      // t0+1s: the hint said "retry now", but the exponential curve says 30s —
      // max(0, 30s) keeps the gate at 30s. No GET.
      await makeReadOAuth({ readUsage: reader, nowMs: t0 + 1_000, bypassOAuthCache: false })();
      assert.equal(calls, 1, "retry-after: 0 must not restore hammering");

      // t0+31s: past the exponential gate — re-probe fires.
      await makeReadOAuth({ readUsage: reader, nowMs: t0 + 31_000, bypassOAuthCache: false })();
      assert.equal(calls, 2);
    });

    test("bypassOAuthCache path keeps the #1083 fresh-each-call contract (no single-flight)", async () => {
      let calls = 0;
      const reader = async () => {
        calls++;
        return { ok: true as const, data: okData };
      };
      const t0 = Date.parse("2026-07-02T12:00:00Z");
      const read = makeReadOAuth({ readUsage: reader, nowMs: t0, bypassOAuthCache: true });
      await read();
      await read();
      assert.equal(calls, 2, "injected/fixture readers stay deterministic fresh-each-call");
    });

    test("getUsage surfaces the new code: a 429 with no last-good reads oauthError=oauth-usage-rate-limited", async () => {
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
      const root = await mkdtemp(join(tmpdir(), "usage-2666-"));
      try {
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 300 })]);
        const reader = async (): Promise<OAuthUsageResult> => ({
          ok: false,
          code: "oauth-usage-rate-limited",
          retryAfterMs: 60_000,
        });
        const snap = await getUsage({
          now: new Date("2026-05-25T12:00:00Z"),
          projectsRoot: root,
          force: true,
          useOAuthCache: true,
          readUsage: reader,
        });
        assert.equal(snap.usageSource, "estimate", "no last-good → gate-safe estimate fallback");
        assert.equal(
          snap.oauthError,
          "oauth-usage-rate-limited",
          "operator-diagnosable: rate-limited is distinct from endpoint-sick",
        );
        assert.equal(snap.percentLast5h, 30, "estimate gauge stands — never silently 0");
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
        fiveHourThrottleShed: false,
        calibrated: true,
        paused: false,
        sessionBlockedUntil: null,
        worklessUntil: null,
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

// OAuth-meter backoff PERSISTENCE across restart (issue #2840). The #2619
// exponential-backoff gate lived only in process memory, so every service
// restart reset the consecutive-failure counter to #1 — the next scan
// immediately re-GET the still-rate-limited endpoint and re-armed the ladder
// from 30s (the 429 recurrence #2840 reports despite the #2669 single-flight
// fix). The gate is now HYDRATED from a Redis side-channel on the first
// cached-path read after a process start and MIRRORED on every change, so a
// restart RESUMES the ladder. A top-level describe with its own lifecycle (per
// the shared-teardown authoring rule) that injects a FAKE store — no live Redis.
describe("OAuth meter backoff persistence across restart (issue #2840)", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = withEnvSnapshot();
    clearUsageCache();
  });
  afterEach(() => {
    restoreEnv();
    clearUsageCache();
    // Always restore the production Redis seam so a leaked fake store cannot
    // contaminate a sibling suite that drives the cached path.
    setOAuthBackoffPersistence();
  });

  // An in-memory fake of the persistence side-channel that records every call,
  // so a test can assert write-on-change / clear-on-recovery AND pre-seed a
  // persisted gate to simulate a restart mid-outage. Mirrors the never-throw
  // contract of the real ../src/redis/oauth-backoff.ts seam.
  function fakeStore(initial: PersistedOAuthBackoff | null = null): {
    persistence: OAuthBackoffPersistence;
    reads: () => number;
    writes: PersistedOAuthBackoff[];
    clears: () => number;
    current: () => PersistedOAuthBackoff | null;
  } {
    let value: PersistedOAuthBackoff | null = initial;
    // Live counters exposed via getters — never spread by value, so an assertion
    // reads the count AT assertion time, not a frozen snapshot from return time.
    const state = { reads: 0, writes: [] as PersistedOAuthBackoff[], clears: 0 };
    const persistence: OAuthBackoffPersistence = {
      read: async () => {
        state.reads++;
        return value;
      },
      write: async (s) => {
        state.writes.push(s);
        value = s;
      },
      clear: async () => {
        state.clears++;
        value = null;
      },
    };
    return {
      persistence,
      reads: () => state.reads,
      writes: state.writes,
      clears: () => state.clears,
      current: () => value,
    };
  }

  function countingMeter(
    results: Array<{ ok: boolean; five?: number; seven?: number; code?: any }>,
  ) {
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

  test("a restart mid-outage RESUMES the ladder (no immediate re-GET, no reset to #1)", async () => {
    // Simulate a restart: a persisted gate is present, its window still open.
    // The FIRST cached-path read of the "new process" must hydrate that gate and
    // SUPPRESS the GET (the whole point of #2840) rather than re-hammer the
    // endpoint and reset the ladder to failure #1.
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "600000"; // 10 min grace
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = "900000"; // 15 min ceiling
    const root = await mkdtemp(join(tmpdir(), "usage-2840-"));
    try {
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
      const t0 = new Date("2026-05-25T12:00:00Z");
      // Persisted: consecutive failure #4, next GET not until t0+120s (still open).
      const store = fakeStore({ failures: 4, nextAttemptMs: t0.getTime() + 120_000 });
      setOAuthBackoffPersistence(store.persistence);
      clearUsageCache(); // re-arm hydrate so the next read re-seeds from the store

      const m = countingMeter([{ ok: false, code: "oauth-usage-non-2xx" }]);
      // First read of the "restarted" process, INSIDE the resumed window.
      const snap = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(store.reads(), 1, "hydrated from the persistence side-channel exactly once");
      assert.equal(m.calls(), 0, "resumed gate SUPPRESSES the GET — no immediate re-hammer after restart");
      assert.equal(snap.usageSource, "estimate", "no last-good in the fresh process → estimate, never a silent 0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("arming the backoff WRITES the gate through to persistence", async () => {
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000"; // 1 min
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "600000";
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "120000"; // 2 min
    const root = await mkdtemp(join(tmpdir(), "usage-2840-"));
    try {
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
      const store = fakeStore(null); // fresh process, nothing persisted yet
      setOAuthBackoffPersistence(store.persistence);
      clearUsageCache();
      const m = countingMeter([
        { ok: true, five: 55, seven: 33 }, // scan 1 seeds last-good
        { ok: false, code: "oauth-usage-non-2xx" }, // scan 2 429 → arms backoff
      ]);
      const t0 = new Date("2026-05-25T12:00:00Z");
      await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(store.writes.length, 0, "a healthy read writes no backoff gate");
      // +90s (> TTL): 429 arms the 2-min backoff → written through.
      await getUsage({ now: new Date(t0.getTime() + 90_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(store.writes.length, 1, "arming the backoff writes it through to persistence");
      assert.equal(store.writes[0].failures, 1, "consecutive failure #1 persisted");
      assert.equal(
        store.writes[0].nextAttemptMs,
        t0.getTime() + 90_000 + 120_000,
        "persisted nextAttemptMs = failure instant + exponential delay",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovery CLEARS the persisted gate", async () => {
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000";
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "600000";
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = "120000";
    const root = await mkdtemp(join(tmpdir(), "usage-2840-"));
    try {
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
      const store = fakeStore(null);
      setOAuthBackoffPersistence(store.persistence);
      clearUsageCache();
      const m = countingMeter([
        { ok: true, five: 40, seven: 20 }, // seed
        { ok: false, code: "oauth-usage-non-2xx" }, // 429 → arms + persists
        { ok: true, five: 70, seven: 50 }, // recovers
      ]);
      const t0 = new Date("2026-05-25T12:00:00Z");
      await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      // +90s: 429 arms + persists.
      await getUsage({ now: new Date(t0.getTime() + 90_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(store.writes.length, 1, "backoff armed + persisted");
      assert.ok(store.current() !== null, "gate is present in the store while backing off");
      // +250s: past the 90s+120s=210s window → re-GET succeeds → clears persisted gate.
      const recovered = await getUsage({ now: new Date(t0.getTime() + 250_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(recovered.usageSource, "oauth");
      assert.equal(recovered.oauthStale, false, "fresh recovered reading");
      assert.ok(store.clears() >= 1, "recovery cleared the persisted gate");
      assert.equal(store.current(), null, "persisted gate is gone after recovery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a persisted nextAttemptMs beyond the MAX ceiling is CLAMPED on hydrate (no extended staleness)", async () => {
    // Invariant 8: persistence must not extend the staleness ceiling. A hostile /
    // stale stored gate parked hours out is clamped down to now + backoff MAX,
    // so the meter re-probes within one ceiling interval regardless.
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000";
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = "600000";
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = "900000"; // 15 min ceiling
    const root = await mkdtemp(join(tmpdir(), "usage-2840-"));
    try {
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
      const t0 = new Date("2026-05-25T12:00:00Z");
      // Persisted gate parked 6h out — far past the 15-min ceiling.
      const store = fakeStore({ failures: 9, nextAttemptMs: t0.getTime() + 6 * 60 * 60_000 });
      setOAuthBackoffPersistence(store.persistence);
      clearUsageCache();
      const m = countingMeter([{ ok: true, five: 12, seven: 8 }]); // recovers on the post-ceiling probe
      // Scan 1 at t0: hydrates the persisted gate. The clamp caps the resumed
      // nextAttemptMs at (hydrate instant t0) + backoff MAX = t0 + 900s — NOT the
      // raw persisted t0 + 6h. Inside the clamped window → GET suppressed.
      const first = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(m.calls(), 0, "inside the CLAMPED window the GET is still suppressed");
      assert.equal(first.usageSource, "estimate", "no last-good in the fresh process → estimate");
      // Scan 2 at t0 + 900s + 1s: past the CLAMPED ceiling but NOWHERE near the raw
      // persisted 6h. A re-probe MUST fire — proving the clamp took hold (invariant 8).
      const afterCeiling = new Date(t0.getTime() + 900_000 + 1000);
      const snap = await getUsage({ now: afterCeiling, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(m.calls(), 1, "clamped gate lets the meter re-probe within one ceiling interval, not 6h");
      assert.equal(snap.usageSource, "oauth", "the post-ceiling probe recovered onto the meter");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hydrate FAILS OPEN: a throwing store degrades to in-memory-only, meter still reads", async () => {
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000";
    const root = await mkdtemp(join(tmpdir(), "usage-2840-"));
    try {
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
      let reads = 0;
      const throwing: OAuthBackoffPersistence = {
        read: async () => {
          reads++;
          throw new Error("redis down");
        },
        write: async () => {},
        clear: async () => {},
      };
      setOAuthBackoffPersistence(throwing);
      clearUsageCache();
      const m = countingMeter([{ ok: true, five: 21, seven: 9 }]);
      const t0 = new Date("2026-05-25T12:00:00Z");
      // A hydrate throw must NOT break the read — the scan degrades to
      // in-memory-only (pre-#2840 behaviour) and the meter still succeeds.
      const snap = await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(reads, 1, "hydrate attempted exactly once");
      assert.equal(snap.usageSource, "oauth", "meter read succeeds despite the persistence outage");
      assert.equal(snap.percentLast5h, 21);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hydrate runs at most ONCE per process (subsequent cached-path reads do not re-read the store)", async () => {
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = "60000";
    const root = await mkdtemp(join(tmpdir(), "usage-2840-"));
    try {
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 5 })]);
      const store = fakeStore(null);
      setOAuthBackoffPersistence(store.persistence);
      clearUsageCache();
      const m = countingMeter([{ ok: true, five: 5, seven: 5 }]);
      const t0 = new Date("2026-05-25T12:00:00Z");
      await getUsage({ now: t0, projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      // A second post-TTL scan in the SAME process must NOT re-hydrate.
      await getUsage({ now: new Date(t0.getTime() + 90_000), projectsRoot: root, force: true, useOAuthCache: true, readUsage: m.reader });
      assert.equal(store.reads(), 1, "hydrate is once-per-process, not once-per-scan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Issue #2041: the hard-stop derivation moved out of usage-tracker.ts's
// snapshot-assembly function into the pure `deriveHardStop` predicate in
// eligibility.ts. These tests exercise the threshold POLICY with plain scalar
// literals — no ScanResult fixture, no OAuth mock, no quota-weight config, no
// weekly-reset-anchor math — which was the whole point of the extraction.
describe("deriveHardStop (pure threshold predicate, issue #2041)", () => {
  test("EMERGENCY_STOP_PERCENT is the single shared 90% threshold", () => {
    assert.equal(EMERGENCY_STOP_PERCENT, 90);
  });

  test("at 91% 5h OAuth usage the 5h stop is true (the issue's acceptance core)", () => {
    const { emergencyStop, weeklyEmergencyStop } = deriveHardStop({
      percentLast5h: 91,
      percentLast7d: 10,
      usageSource: "oauth",
    });
    assert.equal(emergencyStop, true);
    assert.equal(weeklyEmergencyStop, false);
  });

  test("exactly at the 90% threshold both windows stop (>= boundary, OAuth)", () => {
    const r = deriveHardStop({
      percentLast5h: EMERGENCY_STOP_PERCENT,
      percentLast7d: EMERGENCY_STOP_PERCENT,
      usageSource: "oauth",
    });
    assert.equal(r.emergencyStop, true);
    assert.equal(r.weeklyEmergencyStop, true);
  });

  test("just under 90% (89.9%) neither window stops", () => {
    const r = deriveHardStop({
      percentLast5h: 89.9,
      percentLast7d: 89.9,
      usageSource: "oauth",
    });
    assert.equal(r.emergencyStop, false);
    assert.equal(r.weeklyEmergencyStop, false);
  });

  test("the weekly window stops independently of the 5h window", () => {
    const r = deriveHardStop({
      percentLast5h: 10,
      percentLast7d: 95,
      usageSource: "oauth",
    });
    assert.equal(r.emergencyStop, false);
    assert.equal(r.weeklyEmergencyStop, true);
  });

  test("the estimate source NEVER triggers either stop, even at 100% (#1124 fail-open)", () => {
    const r = deriveHardStop({
      percentLast5h: 100,
      percentLast7d: 100,
      usageSource: "estimate",
    });
    assert.equal(r.emergencyStop, false);
    assert.equal(r.weeklyEmergencyStop, false);
  });

  test("is a pure fold — same scalars in, same booleans out, no side effects", () => {
    const input = {
      percentLast5h: 91,
      percentLast7d: 50,
      usageSource: "oauth" as const,
    };
    const frozen = JSON.stringify(input);
    const a = deriveHardStop(input);
    const b = deriveHardStop(input);
    assert.deepEqual(a, b);
    // input untouched
    assert.equal(JSON.stringify(input), frozen);
  });
});

// ---------------------------------------------------------------------------
// Issue #2188: the four pure snapshot-assembly helpers extracted out of
// assembleSnapshot. Each takes already-computed scalars/sub-accumulators and
// returns its slice — testable without a ScanResult fixture or the full build.
// ---------------------------------------------------------------------------

describe("derivePacingState (pure fold, issue #2188)", () => {
  test("uncalibrated is always 'under', regardless of projection", () => {
    assert.equal(derivePacingState(false, 9999), "under");
    assert.equal(derivePacingState(false, 0), "under");
  });

  test("'over' when projection exceeds 100% (calibrated)", () => {
    assert.equal(derivePacingState(true, 100.01), "over");
    assert.equal(derivePacingState(true, 250), "over");
  });

  test("'on' in the 80–100% informational band (inclusive of 80, of 100)", () => {
    assert.equal(derivePacingState(true, 80), "on");
    assert.equal(derivePacingState(true, 90), "on");
    assert.equal(derivePacingState(true, 100), "on");
  });

  test("'under' below 80% (calibrated)", () => {
    assert.equal(derivePacingState(true, 79.99), "under");
    assert.equal(derivePacingState(true, 0), "under");
  });

  test("byte-for-byte the inline branch: 100 is 'on', 100.0001 is 'over'", () => {
    assert.equal(derivePacingState(true, 100), "on");
    assert.equal(derivePacingState(true, 100.0001), "over");
  });
});

describe("rebaseOnOAuth (pure headline-rebase helper, issue #2188)", () => {
  const freshOk = (fiveHourPct: number, sevenDayPct: number): ScanResultOAuth => ({
    result: {
      ok: true,
      data: {
        fiveHour: { utilization: fiveHourPct, resetsAt: "2026-06-19T12:00:00.000Z" },
        sevenDay: { utilization: sevenDayPct, resetsAt: "2026-06-25T12:00:00.000Z" },
      },
    },
    stale: false,
    ageMs: 0,
    lastKnownOAuth: {
      fiveHour: { utilization: fiveHourPct, resetsAt: "2026-06-19T12:00:00.000Z" },
      sevenDay: { utilization: sevenDayPct, resetsAt: "2026-06-25T12:00:00.000Z" },
    },
  });

  test("a FRESH OAuth read rebases the headline onto real utilization", () => {
    const r = rebaseOnOAuth(freshOk(42, 71), 5, 6);
    assert.equal(r.percentLast5h, 42);
    assert.equal(r.percentLast7d, 71);
    assert.equal(r.usageSource, "oauth");
    assert.equal(r.oauthError, null);
    assert.equal(r.oauthStale, false);
    assert.equal(r.oauthAgeMs, 0);
    assert.equal(r.oauthFiveHourResetsAt, "2026-06-19T12:00:00.000Z");
    assert.equal(r.oauthSevenDayResetsAt, "2026-06-25T12:00:00.000Z");
  });

  test("a STALE last-good (#1090) stays usageSource:'oauth' but flags stale", () => {
    const stale: ScanResultOAuth = {
      result: {
        ok: true,
        data: {
          fiveHour: { utilization: 30, resetsAt: null },
          sevenDay: { utilization: 55, resetsAt: null },
        },
      },
      stale: true,
      ageMs: 123_456,
      lastKnownOAuth: {
        fiveHour: { utilization: 30, resetsAt: null },
        sevenDay: { utilization: 55, resetsAt: null },
      },
    };
    const r = rebaseOnOAuth(stale, 9, 9);
    assert.equal(r.usageSource, "oauth"); // stale-but-real still backs the headline
    assert.equal(r.percentLast5h, 30);
    assert.equal(r.percentLast7d, 55);
    assert.equal(r.oauthError, "oauth-usage-stale");
    assert.equal(r.oauthStale, true);
    assert.equal(r.oauthAgeMs, 123_456);
  });

  test("a FAILED read NEVER reads 0 — falls back to the estimate (#1083 never-silently-0)", () => {
    const failed: ScanResultOAuth = {
      result: { ok: false, code: "oauth-usage-token-expired" },
      stale: false,
      ageMs: null,
      lastKnownOAuth: null,
    };
    const r = rebaseOnOAuth(failed, 17, 23);
    assert.equal(r.usageSource, "estimate");
    assert.equal(r.percentLast5h, 17); // the estimate stands, NOT 0
    assert.equal(r.percentLast7d, 23);
    assert.equal(r.oauthError, "oauth-usage-token-expired");
    assert.equal(r.oauthStale, false);
    assert.equal(r.oauthAgeMs, null);
    assert.equal(r.oauthFiveHourResetsAt, null);
    assert.equal(r.oauthSevenDayResetsAt, null);
  });

  test("does not mutate its inputs (pure)", () => {
    const oauth = freshOk(10, 20);
    const frozen = JSON.stringify(oauth);
    rebaseOnOAuth(oauth, 1, 2);
    assert.equal(JSON.stringify(oauth), frozen);
  });
});

describe("deriveSinceReset (pure fixed-window helper, issue #2188)", () => {
  const NOW = Date.UTC(2026, 5, 19, 12, 0, 0); // 2026-06-19T12:00Z
  const baseInput = {
    mostRecentObservedResetMs: null as number | null,
    nowMs: NOW,
    sinceResetEntries: [] as { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[],
    cacheReadWeight: 1,
    burnWeights: { opus: 1, sonnet: 1, haiku: 1 },
    calibrated: true,
    weeklyQuota: 1000,
  };

  test("Anchor unset (null) returns the neutral all-zero slice", () => {
    const r = deriveSinceReset({ ...baseInput, anchorEnvMs: null });
    assert.equal(r.percentSinceReset, 0);
    assert.equal(r.weeklyResetAnchor, null);
    assert.equal(r.tokensSinceReset.total, 0);
  });

  // Anchor 10 days before now: k = floor(10/7) = 1, so the projected current
  // boundary is anchor + 7d = 3 days before now (NOT 7 — the 7d*k floor lands
  // on the most recent boundary at-or-before now, which is why a 14d anchor
  // would put the boundary exactly on now).
  const ANCHOR_10D = NOW - 10 * 86_400_000;
  const BOUNDARY_3D = ANCHOR_10D + 7 * 86_400_000; // NOW - 3d

  test("sums only entries at/after the projected current-window boundary", () => {
    // Tokens carried as `input` so the weighted burn numerator (which folds over
    // the token-TYPE fields, not the raw `.total`) is non-zero with all weights
    // at identity 1.0 — `percentSinceReset` then reduces to total/quota*100.
    const r = deriveSinceReset({
      ...baseInput,
      anchorEnvMs: ANCHOR_10D,
      sinceResetEntries: [
        { tsMs: BOUNDARY_3D - 1000, tokens: breakdown({ input: 100 }), family: "opus" }, // before boundary => excluded
        { tsMs: BOUNDARY_3D + 1000, tokens: breakdown({ input: 200 }), family: "opus" }, // after boundary => included
        { tsMs: NOW - 1000, tokens: breakdown({ input: 300 }), family: "sonnet" }, // included
      ],
    });
    assert.equal(r.tokensSinceReset.total, 500); // 200 + 300
    assert.equal(r.percentSinceReset, 50); // weighted burn 500 / 1000 * 100 (identity weights)
    assert.equal(r.weeklyResetAnchor, new Date(BOUNDARY_3D).toISOString());
  });

  test("an observed reset more recent than the env boundary (and <= now) auto-corrects the boundary", () => {
    const observed = NOW - 2 * 86_400_000; // newer than BOUNDARY_3D (NOW-3d), before now
    const r = deriveSinceReset({
      ...baseInput,
      anchorEnvMs: ANCHOR_10D,
      mostRecentObservedResetMs: observed,
      sinceResetEntries: [
        { tsMs: BOUNDARY_3D + 1000, tokens: breakdown({ total: 999 }), family: "opus" }, // before observed => now excluded
        { tsMs: observed + 1000, tokens: breakdown({ total: 400 }), family: "opus" }, // after observed => included
      ],
    });
    assert.equal(r.weeklyResetAnchor, new Date(observed).toISOString());
    assert.equal(r.tokensSinceReset.total, 400);
  });

  test("an observed reset in the FUTURE (> now) is ignored — env boundary stands", () => {
    const r = deriveSinceReset({
      ...baseInput,
      anchorEnvMs: ANCHOR_10D,
      mostRecentObservedResetMs: NOW + 86_400_000, // in the future => ignored
    });
    assert.equal(r.weeklyResetAnchor, new Date(BOUNDARY_3D).toISOString());
  });

  test("uncalibrated => percentSinceReset 0 but raw tokensSinceReset still summed", () => {
    const r = deriveSinceReset({
      ...baseInput,
      calibrated: false,
      anchorEnvMs: ANCHOR_10D,
      sinceResetEntries: [
        { tsMs: BOUNDARY_3D + 1000, tokens: breakdown({ total: 250 }), family: "opus" },
      ],
    });
    assert.equal(r.percentSinceReset, 0);
    assert.equal(r.tokensSinceReset.total, 250); // honest raw count regardless of calibration
  });
});

describe("detectCalibrationDrift (pure fail-loud detector, issue #2188)", () => {
  // Capture console.warn so we can assert it fires exactly once (or not at all).
  function withWarnCapture(fn: () => void): string[] {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.warn = orig;
    }
    return warns;
  }

  const base = {
    driftFactor: 2,
    calibrated: true,
    anchorEnvMs: 1_700_000_000_000,
    cacheReadWeight: 1,
    weeklyQuota: 1000,
  };

  test("inert when the reference is unset (null) — no warn", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: null, percentSinceReset: 999 }),
    );
    assert.equal(warns.length, 0);
  });

  test("inert when uncalibrated — no warn even on wild divergence", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, calibrated: false, driftReference: 10, percentSinceReset: 999 }),
    );
    assert.equal(warns.length, 0);
  });

  test("inert when the Anchor is unset (null) — no warn", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, anchorEnvMs: null, driftReference: 10, percentSinceReset: 999 }),
    );
    assert.equal(warns.length, 0);
  });

  test("warns exactly once when percentSinceReset is more than driftFactor ABOVE reference", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: 10, percentSinceReset: 21 }), // > 10*2
    );
    assert.equal(warns.length, 1);
    assert.match(warns[0], /calibration drift/);
  });

  test("warns exactly once when percentSinceReset is more than driftFactor BELOW reference", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: 10, percentSinceReset: 4 }), // < 10/2
    );
    assert.equal(warns.length, 1);
  });

  test("silent inside the band (no divergence beyond driftFactor)", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: 10, percentSinceReset: 15 }), // within [5, 20]
    );
    assert.equal(warns.length, 0);
  });
});

// Small fixture helpers for the scalar-math suites below (issue #2247): a flat
// breakdown and a per-family accumulator with one family pre-filled.
function bd(over: Partial<TokenBreakdown> = {}): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, ...over };
}
function byModelWith(over: Partial<Record<ModelFamily, TokenBreakdown>> = {}): Record<ModelFamily, TokenBreakdown> {
  return { opus: bd(), sonnet: bd(), haiku: bd(), unknown: bd(), ...over };
}

describe("deriveWeightedBurns (pure burn-numerator triple, issue #2247)", () => {
  const IDENTITY = { opus: 1, sonnet: 1, haiku: 1 };

  test("identity weights (w_cache=1, all families 1.0) reduce to raw .total sums", () => {
    // weightedTokens at w_cache=1 == input+output+cacheCreation+cacheRead == .total.
    const m5 = byModelWith({ opus: bd({ total: 100, input: 100 }) });
    const m7 = byModelWith({ sonnet: bd({ total: 250, output: 250 }) });
    const m24 = byModelWith({ haiku: bd({ total: 40, input: 40 }) });
    const r = deriveWeightedBurns(m5, m7, m24, 1, IDENTITY);
    assert.equal(r.weightedBurn5h, 100);
    assert.equal(r.weightedBurn7d, 250);
    assert.equal(r.weightedBurn24h, 40);
  });

  test("per-family Quota Weight (Axis B) scales OUTSIDE each family", () => {
    const m = byModelWith({
      opus: bd({ total: 10, input: 10 }),
      sonnet: bd({ total: 10, input: 10 }),
      haiku: bd({ total: 10, input: 10 }),
    });
    const r = deriveWeightedBurns(m, m, m, 1, { opus: 5, sonnet: 2, haiku: 1 });
    // 10*5 + 10*2 + 10*1 + unknown(0)*1 = 80 for every window.
    assert.equal(r.weightedBurn5h, 80);
    assert.equal(r.weightedBurn7d, 80);
    assert.equal(r.weightedBurn24h, 80);
  });

  test("cache-read weight (Axis A) reshapes the mix INSIDE the family", () => {
    // 100 input + 100 cacheRead; at w_cache=0.1 the burn is 100 + 0.1*100 = 110.
    const m = byModelWith({ opus: bd({ input: 100, cacheRead: 100, total: 200 }) });
    const r = deriveWeightedBurns(m, m, m, 0.1, IDENTITY);
    assert.equal(r.weightedBurn5h, 110);
  });

  test("composes both axes (familyWeight * weightedTokens) without double-counting", () => {
    // opus: input 100 + cacheRead 100 -> weightedTokens(0.1)=110; *w_opus=5 => 550.
    const m = byModelWith({ opus: bd({ input: 100, cacheRead: 100, total: 200 }) });
    const r = deriveWeightedBurns(m, m, m, 0.1, { opus: 5, sonnet: 2, haiku: 3 });
    assert.equal(r.weightedBurn7d, 550);
  });
});

describe("deriveEstimatePercents (pure estimate %, issue #2247)", () => {
  const burns = { weightedBurn5h: 50, weightedBurn7d: 200, weightedBurn24h: 100 };

  test("uncalibrated short-circuits all three to 0", () => {
    const r = deriveEstimatePercents(burns, 1000, 500, false);
    assert.equal(r.estimatePercentLast5h, 0);
    assert.equal(r.estimatePercentLast7d, 0);
    assert.equal(r.projectedWeeklyPercent, 0);
  });

  test("calibrated: 5h and 7d divide by their quotas; projection extends 24h * 7", () => {
    const r = deriveEstimatePercents(burns, 1000, 500, true);
    assert.equal(r.estimatePercentLast5h, (50 / 500) * 100); // 10
    assert.equal(r.estimatePercentLast7d, (200 / 1000) * 100); // 20
    assert.equal(r.projectedWeeklyPercent, ((100 * 7) / 1000) * 100); // 70
  });

  test("projectedWeeklyPercent crosses 100 when the 24h rate would overrun the week", () => {
    // 24h burn 200 -> *7 = 1400 over a 1000 quota -> 140%.
    const r = deriveEstimatePercents(
      { weightedBurn5h: 0, weightedBurn7d: 0, weightedBurn24h: 200 },
      1000,
      500,
      true,
    );
    assert.ok(r.projectedWeeklyPercent > 100);
    assert.equal(r.projectedWeeklyPercent, 140);
    // and that feeds derivePacingState 'over'
    assert.equal(derivePacingState(true, r.projectedWeeklyPercent), "over");
  });
});

describe("deriveQuotaWeightTotals (pure Quota-Weight totals, issue #2247)", () => {
  const weights = { opus: 5, sonnet: 2, haiku: 1 };

  test("uncalibrated (gate false) returns both totals as exactly 0", () => {
    const m = byModelWith({ opus: bd({ total: 1000 }) });
    const r = deriveQuotaWeightTotals(m, m, weights, false);
    assert.equal(r.quotaWeightLast5h, 0);
    assert.equal(r.quotaWeightLast7d, 0);
  });

  test("calibrated: sums raw .total per family scaled by familyWeight (no cache axis)", () => {
    const m5 = byModelWith({
      opus: bd({ total: 10 }),
      sonnet: bd({ total: 10 }),
      haiku: bd({ total: 10 }),
      unknown: bd({ total: 10 }), // unknown is implicit 1.0
    });
    const m7 = byModelWith({ opus: bd({ total: 100 }) });
    const r = deriveQuotaWeightTotals(m5, m7, weights, true);
    // 10*5 + 10*2 + 10*1 + 10*1(unknown implicit) = 90
    assert.equal(r.quotaWeightLast5h, 90);
    // 100*5 = 500
    assert.equal(r.quotaWeightLast7d, 500);
  });

  test("ignores the cache-read axis — uses .total verbatim, not a cache-weighted mix", () => {
    // A family with a heavy cacheRead share but the SAME .total as a plain one
    // produces the same Quota-Weight total (Axis A does not apply here).
    const heavy = byModelWith({ opus: bd({ cacheRead: 90, input: 10, total: 100 }) });
    const plain = byModelWith({ opus: bd({ input: 100, total: 100 }) });
    const rHeavy = deriveQuotaWeightTotals(heavy, heavy, weights, true);
    const rPlain = deriveQuotaWeightTotals(plain, plain, weights, true);
    assert.equal(rHeavy.quotaWeightLast5h, rPlain.quotaWeightLast5h);
    assert.equal(rHeavy.quotaWeightLast5h, 500); // 100 * 5
  });
});

describe("deriveBySkillWoW (pure per-skill week-over-week trend, issue #2404)", () => {
  test("no prior snapshot → every skill is 'new' (prior/deltaPct null)", () => {
    const cur = {
      "hydra-dev": byModelWith({ opus: bd({ total: 100, input: 100 }) }),
      "hydra-qa": byModelWith({ sonnet: bd({ total: 40, output: 40 }) }),
    };
    const r = deriveBySkillWoW(cur, null);
    assert.equal(r["hydra-dev"].current, 100);
    assert.equal(r["hydra-dev"].prior, null);
    assert.equal(r["hydra-dev"].deltaPct, null);
    assert.equal(r["hydra-qa"].current, 40);
    assert.equal(r["hydra-qa"].prior, null);
    assert.equal(r["hydra-qa"].deltaPct, null);
  });

  test("computes signed deltaPct vs the prior week's per-skill total", () => {
    const cur = {
      "hydra-dev": byModelWith({ opus: bd({ total: 150, input: 150 }) }),
      "hydra-qa": byModelWith({ sonnet: bd({ total: 50, output: 50 }) }),
    };
    const prior = { "hydra-dev": 100, "hydra-qa": 100 };
    const r = deriveBySkillWoW(cur, prior);
    // +50% up
    assert.equal(r["hydra-dev"].prior, 100);
    assert.equal(r["hydra-dev"].deltaPct, 50);
    // -50% down
    assert.equal(r["hydra-qa"].prior, 100);
    assert.equal(r["hydra-qa"].deltaPct, -50);
  });

  test("a skill present this week but absent from prior is 'new' (deltaPct null)", () => {
    const cur = { "hydra-research": byModelWith({ opus: bd({ total: 10, input: 10 }) }) };
    const prior = { "hydra-dev": 100 };
    const r = deriveBySkillWoW(cur, prior);
    assert.equal(r["hydra-research"].current, 10);
    assert.equal(r["hydra-research"].prior, null);
    assert.equal(r["hydra-research"].deltaPct, null);
  });

  test("prior total of 0 yields deltaPct null (no divide-by-zero / Infinity)", () => {
    const cur = { "hydra-dev": byModelWith({ opus: bd({ total: 100, input: 100 }) }) };
    const prior = { "hydra-dev": 0 };
    const r = deriveBySkillWoW(cur, prior);
    assert.equal(r["hydra-dev"].prior, 0);
    assert.equal(r["hydra-dev"].deltaPct, null);
  });

  test("the trend is keyed off CURRENT-week skills — a dropped skill is absent", () => {
    const cur = { "hydra-dev": byModelWith({ opus: bd({ total: 100, input: 100 }) }) };
    const prior = { "hydra-dev": 100, "hydra-qa": 200 };
    const r = deriveBySkillWoW(cur, prior);
    assert.deepEqual(Object.keys(r), ["hydra-dev"]);
    assert.equal(r["hydra-qa"], undefined);
  });

  test("current total sums over ALL model families (raw .total)", () => {
    const cur = {
      "hydra-dev": byModelWith({
        opus: bd({ total: 100, input: 100 }),
        sonnet: bd({ total: 25, output: 25 }),
        haiku: bd({ total: 5, input: 5 }),
      }),
    };
    const r = deriveBySkillWoW(cur, null);
    assert.equal(r["hydra-dev"].current, 130);
  });
});

describe("isoWeekLabel (pure ISO-8601 week math, issue #2404)", () => {
  test("a mid-week date maps to the correct ISO week", () => {
    // 2026-06-23 is a Tuesday in ISO week 26 of 2026.
    assert.equal(isoWeekLabel(new Date("2026-06-23T12:00:00.000Z")), "2026-W26");
  });

  test("zero-pads the week number to two digits", () => {
    // 2026-01-05 is a Monday — ISO week 2 of 2026.
    assert.equal(isoWeekLabel(new Date("2026-01-05T00:00:00.000Z")), "2026-W02");
  });

  test("year-boundary day belongs to the prior ISO year's last week", () => {
    // 2027-01-01 is a Friday; ISO-8601 places it in 2026-W53.
    assert.equal(isoWeekLabel(new Date("2027-01-01T00:00:00.000Z")), "2026-W53");
  });

  test("is stable regardless of host timezone (UTC-based)", () => {
    // Same instant, expressed as a Date — the label is derived in UTC.
    const a = isoWeekLabel(new Date("2026-06-23T23:59:59.000Z"));
    const b = isoWeekLabel(new Date("2026-06-23T00:00:01.000Z"));
    assert.equal(a, b);
  });
});
