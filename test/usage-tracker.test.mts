/**
 * Integration test for the usage-tracker.ts coordinator (`getUsage`).
 *
 * Every suite below drives `getUsage` end to end. The pure-leaf unit suites that
 * used to live here moved to their defining modules' test files (epic #4780,
 * ADR-0042 Decision 8): transcript-scan, token-math, cost-config, eligibility,
 * snapshot-assembly, token-breakdown (deriveSkill / deriveDispatchKind),
 * transcript-store (sessionIdFromPath) and usage-weekly-snapshot (isoWeekLabel).
 * A few incidental pure cases (oauthBackoffDelayMs, isForeignProviderModel) stay
 * inside getUsage-driven suites; they are not separate unit suites.
 */
import { test, describe, afterEach, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearUsageCache,
  getUsage,
  getOAuthUsageTtlMs,
  getOAuthUsageMaxStaleMs,
  getOAuthUsageBackoffBaseMs,
  getOAuthUsageBackoffMaxMs,
  DEFAULT_OAUTH_USAGE_TTL_MS,
  DEFAULT_OAUTH_USAGE_MAX_STALE_MS,
  DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS,
  DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS,
  INTERACTIVE_SKILL,
  type SkillResolver,
  type OAuthUsageResult,
} from "../src/cost/index.ts";
// The extractor, OAuth-read single-flight, and direct-scan unit suites moved to
// test/transcript-scan.test.mts (issue #4784, ADR-0042 Decision 8); the
// deriveSkill / deriveDispatchKind precedence suites moved to
// test/token-breakdown.test.mts and sessionIdFromPath to
// test/transcript-store.test.mts (issue #4789).
import {
  oauthBackoffDelayMs,
  DISPATCH_KINDS,
  setOAuthBackoffPersistence,
} from "../src/cost/transcript-scan.ts";
import type { OAuthBackoffPersistence } from "../src/cost/transcript-scan.ts";
import type { PersistedOAuthBackoff } from "../src/redis/oauth-backoff.ts";
// Per-file parse memo seam (issue #3805): `countTranscriptParseMemoEntries`
// for the end-to-end eviction test below, and `getRedisConnection` for the
// suite-level MEMO_KEY clear. The load/write round-trip + corrupt-entry unit
// tests moved to test/transcript-scan.test.mts (issue #4784).
import { countTranscriptParseMemoEntries } from "../src/redis/transcript-parse-memo.ts";
import { getRedisConnection } from "../src/redis/connection.ts";
// The pure token-math functions live in their own leaf (issue #1909); the ones
// still exercised here — `isForeignProviderModel` (unit) and
// `projectResetWindow` (the since-reset getUsage suite's boundary sanity
// assertion) — are imported directly from cost/token-math.ts to prove the seam
// is importable without pulling in the JSONL-scan machinery, mirroring the
// eligibility.ts import below. The pure token-math UNIT suites moved to
// test/token-math.test.mts (issue #4785).
import {
  isForeignProviderModel,
  projectResetWindow,
} from "../src/cost/token-math.ts";
// The pure eligibility-projection fold lives in cost/eligibility.ts (issue
// #1377). Only `projectEligibility` is still used here, by the getUsage
// integration assertions (#1124 / #1090); the eligibility-fold unit suites
// moved to test/eligibility.test.mts in #4787. The env-config reader suites
// moved to test/cost-config.test.mts in #4786. The pure snapshot-assembly helper
// suites moved to test/snapshot-assembly.test.mts (#4788).
import { projectEligibility } from "../src/cost/eligibility.ts";
// The isoWeekLabel week-math suite moved to test/usage-weekly-snapshot.test.mts
// (issue #4789).
// Shared Cost-module test fixtures (captureLoggerLines, breakdown,
// assistantLine, userLine, sentinelLine, writeFixture, withEnvSnapshot) were
// extracted to ./_helpers/cost-fixtures.mts in issue #4784 so this file and
// test/transcript-scan.test.mts share one definition.
import {
  assistantLine,
  breakdown,
  captureLoggerLines,
  sentinelLine,
  userLine,
  withEnvSnapshot,
  writeFixture,
} from "./_helpers/cost-fixtures.mts";

describe("usage-tracker", () => {

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

    test("calibrated, no window reference: pacingState falls back to the legacy projection thresholds (issue #4121 INV-4)", async () => {
      // Estimate path (no OAuth read) AND no Weekly Reset Anchor: there is no
      // window position to pace against, so pacingState keeps the pre-#4121
      // derivation — 24h tokens × 7 = 14k over a 7k weekly quota projects
      // 200% → "over" — preserving the status quo for un-Anchor'd accounts
      // rather than pinning a fixed state.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "7000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";
      delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 1000, out: 1000 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.tokensLast24h, 2000);
        assert.equal(snap.projectedWeeklyPercent, 200);
        assert.equal(snap.usageSource, "estimate");
        assert.equal(snap.windowElapsedFraction, null);
        assert.equal(snap.paceRatio, null);
        assert.equal(snap.pacingState, "over"); // legacy threshold, unchanged
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated, Anchor available: window position beats the 24h burst projection (issue #4121 INV-3)", async () => {
      // Same burst fixture (projected 200%), but the Weekly Reset Anchor seeds
      // a window position 0.7 elapsed — the Anchor boundary 0.7*7d ago
      // projects to itself as the current window start. The estimate headline
      // is 2000/7000 ≈ 28.6% consumed vs a 70% linear target → "under", NOT
      // the "over" the projection alone would read.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "7000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";
      process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = new Date(
        Date.parse("2026-05-25T12:00:00Z") - Math.round(0.7 * 7 * 86_400_000),
      ).toISOString();

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 1000, out: 1000 }),
        ]);

        const snap = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(snap.usageSource, "estimate");
        assert.equal(snap.projectedWeeklyPercent, 200); // burst projection retained
        assert.ok(snap.windowElapsedFraction !== null);
        assert.ok(Math.abs(snap.windowElapsedFraction - 0.7) < 1e-9);
        assert.ok(snap.percentLast7d > 0 && snap.percentLast7d < 30);
        assert.ok(snap.paceRatio !== null && snap.paceRatio < 0.5);
        assert.equal(snap.pacingState, "under");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: 67% consumed at 70% window-elapsed is NOT 'over' (issue #4121 regression)", async () => {
      // The observed 2026-08-17 reading: percentLast7d 67 with 70% of the
      // weekly window elapsed is UNDER linear pace (paceRatio ≈ 0.96), yet the
      // pre-#4121 24h projection read it "over". Fixed clock + fixed
      // sevenDayResetsAt keep the window position deterministic: resetsAt
      // 0.3*7d out ⇒ the window started 0.7*7d ago. The transcript fixture
      // keeps the burst (projected 200%) to prove the verdict ignores it.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "7000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 1000, out: 1000 }),
        ]);
        const sevenDayResetsAt = new Date(
          now.getTime() + Math.round(0.3 * 7 * 86_400_000),
        ).toISOString();

        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: async () => ({
            ok: true as const,
            data: {
              fiveHour: { utilization: 10, resetsAt: null },
              sevenDay: { utilization: 67, resetsAt: sevenDayResetsAt },
            },
          }),
        });
        assert.equal(snap.usageSource, "oauth");
        assert.equal(snap.percentLast7d, 67);
        assert.equal(snap.projectedWeeklyPercent, 200); // burst projection retained
        assert.ok(snap.windowElapsedFraction !== null);
        assert.ok(Math.abs(snap.windowElapsedFraction - 0.7) < 1e-9);
        assert.ok(snap.paceRatio !== null);
        assert.ok(Math.abs(snap.paceRatio - 67 / 70) < 1e-9);
        assert.notEqual(snap.pacingState, "over");
        assert.equal(snap.pacingState, "under");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: 80% consumed at 40% window-elapsed IS over pace", async () => {
      // Genuinely ahead of linear pace: paceRatio = 80 / 40 = 2.0 → "over",
      // even though the 24h burst projection here is far below 100%.
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "7000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 100, out: 100 }),
        ]);
        const sevenDayResetsAt = new Date(
          now.getTime() + Math.round(0.6 * 7 * 86_400_000),
        ).toISOString();

        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: async () => ({
            ok: true as const,
            data: {
              fiveHour: { utilization: 10, resetsAt: null },
              sevenDay: { utilization: 80, resetsAt: sevenDayResetsAt },
            },
          }),
        });
        assert.equal(snap.percentLast7d, 80);
        assert.ok(snap.windowElapsedFraction !== null);
        assert.ok(Math.abs(snap.windowElapsedFraction - 0.4) < 1e-9);
        assert.ok(snap.paceRatio !== null);
        assert.ok(Math.abs(snap.paceRatio - 2) < 1e-9);
        assert.equal(snap.pacingState, "over");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("calibrated: 40% consumed at 70% window-elapsed reads 'under'", async () => {
      // Comfortably behind linear pace: paceRatio = 40 / 70 ≈ 0.57 → "under".
      process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "7000";
      process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "10000000";

      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 100, out: 100 }),
        ]);
        const sevenDayResetsAt = new Date(
          now.getTime() + Math.round(0.3 * 7 * 86_400_000),
        ).toISOString();

        const snap = await getUsage({
          now,
          projectsRoot: root,
          force: true,
          readUsage: async () => ({
            ok: true as const,
            data: {
              fiveHour: { utilization: 5, resetsAt: null },
              sevenDay: { utilization: 40, resetsAt: sevenDayResetsAt },
            },
          }),
        });
        assert.equal(snap.percentLast7d, 40);
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

    test("unknown-family records trigger a once-per-scan logger.warn (not per-line)", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      const cap = captureLoggerLines();
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

        const trackerWarnings = cap
          .lines()
          .filter((w) => w.includes("[usage-tracker]") && w.includes("unrecognised model"));
        assert.equal(trackerWarnings.length, 1, "expected exactly one warn per scan");
      } finally {
        cap.restore();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("no unknown-model warn fires when every model string is recognised", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-test-"));
      const cap = captureLoggerLines();
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 5 }, "claude-opus-4-7"),
          assistantLine("2026-05-25T11:00:00Z", { in: 5 }, "claude-sonnet-4-6"),
        ]);

        await getUsage({ now, projectsRoot: root, force: true });
        const trackerWarnings = cap.lines().filter((w) => w.includes("unrecognised model"));
        assert.equal(trackerWarnings.length, 0);
      } finally {
        cap.restore();
        await rm(root, { recursive: true, force: true });
      }
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

  // AC3 end-to-end through getUsage: the divergence detector wired into
  // assembleSnapshot fires exactly when the headline is on the estimate AND a
  // last-known OAuth value exists that the estimate has drifted far from.
  describe("estimate/OAuth divergence detector wired through getUsage (issue #2832 AC3)", () => {
    let restore: () => void;
    let cap: ReturnType<typeof captureLoggerLines>;
    beforeEach(() => {
      restore = withEnvSnapshot();
      clearUsageCache();
      cap = captureLoggerLines();
    });
    afterEach(() => {
      cap.restore();
      restore();
      clearUsageCache();
    });

    function divergenceWarnings(): string[] {
      return cap.lines().filter((w) => w.includes("estimate/OAuth divergence"));
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
    let cap: ReturnType<typeof captureLoggerLines>;
    beforeEach(() => {
      restore = withEnvSnapshot();
      clearUsageCache();
      cap = captureLoggerLines();
    });
    afterEach(() => {
      cap.restore();
      restore();
      clearUsageCache();
    });

    function driftWarnings(): string[] {
      return cap.lines().filter((w) => w.includes("calibration drift"));
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

// ---------------------------------------------------------------------------
// Foreign-provider quota exclusion (issue #3769).
//
// The GLM dev-drainer lane (ADR-0032) authors on z.ai's quota, costing ZERO
// Anthropic quota. Before this fix, `glm-*` model strings fell through
// `modelToFamily` into the `unknown` bucket at an implicit Quota-Weight of 1.0
// and were summed into the Anthropic totals — so the lane built to RELIEVE
// `percentLast7d` raised it instead, throttling Opus harder the more GLM
// worked. Measured 2026-07-27: two GLM runs moved `unknown` 73k -> 27.4M and
// `percentLast7d` 94% -> 95%, against a 90% hard-stop cap.
//
// New top-level describe with its own lifecycle (no shared-Redis teardown to
// piggyback on).
// ---------------------------------------------------------------------------
describe("foreign-provider tokens are excluded from Anthropic quota (issue #3769)", () => {
  beforeEach(() => {
    clearUsageCache();
  });

  test("a glm-* transcript moves NO Anthropic aggregate", async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-foreign-"));
    try {
      const now = new Date("2026-05-25T12:00:00Z");
      const oneHourAgo = "2026-05-25T11:00:00Z";

      await writeFixture(root, "proj-a/session-1.jsonl", [
        assistantLine(oneHourAgo, { in: 1_000_000, out: 500_000 }, "glm-5.2"),
        assistantLine(oneHourAgo, { in: 250_000, out: 250_000 }, "glm-4.7"),
      ]);

      const snap = await getUsage({ now, projectsRoot: root, force: true });

      // The load-bearing assertion: every Anthropic-meter quantity is zero.
      assert.equal(snap.tokensLast5h.total, 0);
      assert.equal(snap.tokensLast7d.total, 0);
      assert.equal(snap.tokensLast24h, 0);
      // Critically, NOT parked in `unknown` (weight 1.0) — that was the defect.
      assert.equal(snap.byModel.unknown.total, 0);
      assert.equal(snap.byModel.opus.total, 0);
      assert.equal(snap.byModel.sonnet.total, 0);
      assert.equal(snap.byModel.haiku.total, 0);

      // But the spend is NOT discarded — it is reported on its own axis.
      assert.equal(snap.tokensForeignLast7d, 2_000_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Anthropic tokens are unaffected when a glm-* line sits beside them", async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-foreign-mixed-"));
    try {
      const now = new Date("2026-05-25T12:00:00Z");
      const oneHourAgo = "2026-05-25T11:00:00Z";

      await writeFixture(root, "proj-a/session-1.jsonl", [
        assistantLine(oneHourAgo, { in: 100, out: 200 }, "claude-opus-4-7"),
        assistantLine(oneHourAgo, { in: 900_000, out: 900_000 }, "glm-5.2"),
      ]);

      const snap = await getUsage({ now, projectsRoot: root, force: true });

      // The Anthropic side reads exactly as if the glm line were not there.
      assert.equal(snap.tokensLast7d.total, 300);
      assert.equal(snap.byModel.opus.total, 300);
      assert.equal(snap.byModel.unknown.total, 0);
      assert.equal(snap.tokensForeignLast7d, 1_800_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a glm-* line does not reach the per-skill or per-dispatch-kind cross-tabs", async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-foreign-xtab-"));
    try {
      const now = new Date("2026-05-25T12:00:00Z");
      const oneHourAgo = "2026-05-25T11:00:00Z";

      await writeFixture(root, "proj-a/session-1.jsonl", [
        assistantLine(oneHourAgo, { in: 500_000, out: 500_000 }, "glm-5.2"),
      ]);

      const snap = await getUsage({ now, projectsRoot: root, force: true });

      // Σ over every skill row must be zero — a foreign line must not create
      // or inflate a skill bucket, or `costByClass` inherits the same inversion.
      let skillTotal = 0;
      for (const row of Object.values(snap.bySkillByModel ?? {})) {
        for (const fam of Object.values(row)) skillTotal += fam.total;
      }
      assert.equal(skillTotal, 0);

      let kindTotal = 0;
      for (const row of Object.values(snap.byDispatchKind ?? {})) {
        for (const fam of Object.values(row)) kindTotal += fam.total;
      }
      assert.equal(kindTotal, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isForeignProviderModel classifies by prefix, case-insensitively", () => {
    assert.equal(isForeignProviderModel("glm-5.2"), true);
    assert.equal(isForeignProviderModel("glm-4.7"), true);
    assert.equal(isForeignProviderModel("GLM-5.2"), true);
    // Anthropic models and the genuine unknown-drift case stay non-foreign, so
    // the `unknown` bucket keeps doing its real job (surfacing a missing prefix).
    assert.equal(isForeignProviderModel("claude-opus-4-7"), false);
    assert.equal(isForeignProviderModel("claude-sonnet-5"), false);
    assert.equal(isForeignProviderModel("gpt-5"), false);
    assert.equal(isForeignProviderModel(""), false);
    assert.equal(isForeignProviderModel(null), false);
    assert.equal(isForeignProviderModel(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// Per-file transcript parse memo (issue #3805)
// ---------------------------------------------------------------------------
//
// The transcript scan re-derived the rolling 7d aggregate from raw transcripts on
// EVERY cold call, reading + JSON-parsing every in-window file's bytes even
// though transcripts are append-only and immutable once a session ends
// (measured 2026-07-30: 1,875 MB re-read per call, which blew the Pace Gate's
// 10s probe budget). This suite covers the end-to-end behaviour of the durable
// per-file memo that fixes it through `getUsage()` — a memo hit skips the read
// entirely, an appended file is never served stale, and an aged-out file has
// its memo entry evicted. The low-level seam round-trip and the injected-memoIo
// degrade paths moved to test/transcript-scan.test.mts with the rest of the
// transcript-scan seam unit suites (issue #4784, ADR-0042 Decision 8: a suite
// lives in the test file of the source file that defines its function under
// test).
//
// This suite touches the shared parse-memo Redis hash directly (to count/clear
// it), so — per the CLAUDE.md authoring rule about not piggybacking on a
// sibling suite's teardown timing — it lives in its OWN top-level `describe`
// with its own `beforeEach` lifecycle, distinct from the `getUsage()`-only
// suites above it.
describe("transcript parse memo (issue #3805)", () => {
  const MEMO_KEY = "hydra:metrics:transcript-parse-memo";

  beforeEach(async () => {
    clearUsageCache();
    await getRedisConnection().del(MEMO_KEY);
  });

  describe("end-to-end via getUsage()", () => {
    test("an unchanged file is served from the memo on the second call, with identical totals", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-memo-hit-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 500, out: 100 }),
        ]);

        const first = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(first.filesServedFromMemo, 0, "nothing memoized yet on the cold call");
        assert.equal(first.tokensLast7d.total, 600);

        const second = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(second.filesServedFromMemo, 1, "the unchanged file was replayed from the memo");
        // The load-bearing assertion (design-concept invariant #1): a memo hit
        // reproduces byte-identical totals to the fresh parse.
        assert.deepEqual(second.tokensLast7d, first.tokensLast7d);
        assert.deepEqual(second.byModel, first.byModel);
        assert.deepEqual(second.bySkillByModel, first.bySkillByModel);
        assert.equal(second.filesScanned, first.filesScanned);
        assert.equal(second.linesParsed, first.linesParsed);
        assert.equal(second.linesWithUsage, first.linesWithUsage);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a shrinking 5h window drops a memoized line exactly like a fresh parse would (never a stale flat total)", async () => {
      // Design-concept invariant #2: the memo stores per-line events, not a
      // pre-aggregated window total, because the 5h/24h/7d windows move
      // against a shifting `now` on every call while a memoized file's
      // content is fixed. Prove it: a line 4h before t0 is inside the 5h
      // window at t0, but 3h later (t0+3h) it has aged past 5h — the SECOND
      // call (served from memo) must reflect that, not keep reporting it.
      const root = await mkdtemp(join(tmpdir(), "usage-memo-window-"));
      try {
        const t0 = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T08:00:00Z", { in: 1000 }), // t0 - 4h
        ]);

        const atT0 = await getUsage({ now: t0, projectsRoot: root, force: true });
        assert.equal(atT0.tokensLast5h.total, 1000, "inside the 5h window at t0");

        const t1 = new Date(t0.getTime() + 3 * 60 * 60 * 1000); // t0 + 3h => line is 7h old
        const atT1 = await getUsage({ now: t1, projectsRoot: root, force: true });
        assert.equal(atT1.filesServedFromMemo, 1, "unchanged file replayed from the memo");
        assert.equal(atT1.tokensLast5h.total, 0, "aged out of the 5h window on replay");
        assert.equal(atT1.tokensLast7d.total, 1000, "still inside the 7d window");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("an appended file is re-parsed (not served stale) and its totals include the appended line", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-memo-append-"));
      try {
        const now = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 500 }),
        ]);
        const first = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(first.tokensLast7d.total, 500);

        // Append a second line — changes the file's size, so the (size,
        // mtimeMs) validity pair can never match the stale memo entry.
        await writeFixture(root, "p/s.jsonl", [
          assistantLine("2026-05-25T11:00:00Z", { in: 500 }),
          assistantLine("2026-05-25T11:30:00Z", { in: 250 }),
        ]);
        const second = await getUsage({ now, projectsRoot: root, force: true });
        assert.equal(second.filesServedFromMemo, 0, "an appended file cannot be served from memo");
        assert.equal(second.tokensLast7d.total, 750, "totals include the newly-appended line");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a file that ages out of the 7d window has its memo entry evicted", async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-memo-evict-"));
      try {
        const t0 = new Date("2026-05-25T12:00:00Z");
        await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 500 })]);
        // Pin the file's REAL on-disk mtime to `t0` — otherwise it carries the
        // actual wall-clock write time, which (being the real "now") is always
        // newer than any fictional `now` these fixtures use, so it could never
        // actually go stale relative to a fictional `t1` below.
        const filePath = join(root, "p/s.jsonl");
        await utimes(filePath, t0, t0);

        await getUsage({ now: t0, projectsRoot: root, force: true });
        assert.equal(await countTranscriptParseMemoEntries(), 1);

        // 8 days later the file's mtime (pinned, unchanged) is outside the 7d
        // window — the walk's existing filesSkippedByMtime branch fires, which
        // now also evicts the stale memo entry (no separate sweep job).
        const t1 = new Date(t0.getTime() + 8 * 24 * 60 * 60 * 1000);
        const snap = await getUsage({ now: t1, projectsRoot: root, force: true });
        assert.equal(snap.filesSkippedByMtime, 1);
        assert.equal(await countTranscriptParseMemoEntries(), 0, "the aged-out file's memo entry was evicted");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
