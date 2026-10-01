// Shared fixtures for the Cost/usage-tracker suites live in
// ./_helpers/cost-fixtures.mts (issue #4784) — imported alongside the seam
// under test below.
//
// This file is the test half of the test-topology split of ADR-0042
// Decision 8 (issue #4784, epic #4780): a suite belongs in the test file of
// the source file that DEFINES its function under test, not the file that
// re-exports it. Everything below was moved VERBATIM from
// test/usage-tracker.test.mts:
//
//   - firstUserMessageText — defined on src/cost/transcript-scan.ts
//   - makeReadOAuth (OAuth single-flight + Retry-After) — same file
//   - the transcript-parse-memo seam round-trip — src/redis/transcript-parse-memo.ts
//   - the memo degrade paths via transcriptScan() — src/cost/transcript-scan.ts
//
// The basename match matters concretely: since #4504 the mutation gate runs a
// mutant's related tests (direct importers plus basename matches, capped at 8),
// so a suite homed next to its function's owner is ALWAYS in that set — a
// suite homed in the large usage-tracker integration file could fall out of
// it. `getUsage()`-level integration suites stay in test/usage-tracker.test.mts.
//
// Each top-level describe below carries its own lifecycle hooks per the
// CLAUDE.md authoring rules (no piggybacking on a sibling suite's teardown;
// state a test mutates is reset per-case) — the two parse-memo suites clear
// the shared memo hash in their own beforeEach, exactly as their former parent
// describe did.

import { test, describe, afterEach, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearUsageCache,
  getUsage,
  type OAuthUsageResult,
} from "../src/cost/index.ts";
// In-transcript skill derivation (issue #2402): the pure resolver + the
// first-user-message extractor live on the TranscriptScan seam. Imported
// directly to unit-test the derivation grammar without the JSONL-scan machinery.
import {
  deriveSkill,
  firstUserMessageText,
  makeReadOAuth,
  transcriptScan,
} from "../src/cost/transcript-scan.ts";
// `stubReadOAuth` below types its return as `ScanResult["oauth"]`
// (= CachedOAuthRead). Alias it here so the fixture names the shape the
// helper expects without importing the whole ScanResult boundary type.
import type { CachedOAuthRead as ScanResultOAuth } from "../src/cost/transcript-scan.ts";
// Per-file parse memo seam (issue #3805): imported directly for the
// low-level load/write-round-trip + corrupt-entry unit tests, and
// `getRedisConnection` for the ONE test that hand-writes a structurally-corrupt
// field to prove the load path degrades to a clean miss rather than throwing.
import {
  loadTranscriptParseMemo,
  writeTranscriptParseMemoBatch,
  countTranscriptParseMemoEntries,
} from "../src/redis/transcript-parse-memo.ts";
import type { FileParseMemoEntry } from "../src/redis/transcript-parse-memo.ts";
import { getRedisConnection } from "../src/redis/connection.ts";
import {
  assistantLine,
  breakdown,
  userLine,
  withEnvSnapshot,
  writeFixture,
} from "./_helpers/cost-fixtures.mts";

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

describe("src/redis/transcript-parse-memo.ts — seam round-trip", () => {
  const MEMO_KEY = "hydra:metrics:transcript-parse-memo";

  beforeEach(async () => {
    clearUsageCache();
    await getRedisConnection().del(MEMO_KEY);
  });

  test("write → load round-trips a per-file entry", async () => {
    const entry: FileParseMemoEntry = {
      size: 123,
      mtimeMs: 456,
      entries: [
        { tsMs: 1000, tokens: breakdown({ total: 10 }), foreign: false, family: "opus" },
      ],
      skill: "hydra-dev",
      dispatchKind: "autopilot-dispatched",
      observedResetMs: null,
      linesParsed: 1,
      linesWithUsage: 1,
      parseErrors: 0,
    };
    await writeTranscriptParseMemoBatch(new Map([["/tmp/fixture-a.jsonl", entry]]), []);
    const loaded = await loadTranscriptParseMemo();
    assert.deepEqual(loaded.get("/tmp/fixture-a.jsonl"), entry);
  });

  test("a structurally-corrupt hash field is dropped, not thrown", async () => {
    await getRedisConnection().hset(MEMO_KEY, "/tmp/bad.jsonl", "{not json");
    const loaded = await loadTranscriptParseMemo();
    assert.equal(loaded.has("/tmp/bad.jsonl"), false);
    assert.equal(loaded.size, 0);
  });

  test("writeTranscriptParseMemoBatch evicts a path via the deletes list", async () => {
    const entry: FileParseMemoEntry = {
      size: 1,
      mtimeMs: 1,
      entries: [],
      skill: null,
      dispatchKind: null,
      observedResetMs: null,
      linesParsed: 0,
      linesWithUsage: 0,
      parseErrors: 0,
    };
    await writeTranscriptParseMemoBatch(new Map([["/tmp/evict-me.jsonl", entry]]), []);
    assert.equal(await countTranscriptParseMemoEntries(), 1);
    await writeTranscriptParseMemoBatch(new Map(), ["/tmp/evict-me.jsonl"]);
    assert.equal(await countTranscriptParseMemoEntries(), 0);
  });
});

describe("degrade paths via transcriptScan() (injected memoIo)", () => {
  const MEMO_KEY = "hydra:metrics:transcript-parse-memo";

  beforeEach(async () => {
    clearUsageCache();
    await getRedisConnection().del(MEMO_KEY);
  });

  /** A `CachedOAuthRead` that always reports "no credentials" — the same
   * estimate-forcing stub `getUsage()` defaults to for a fixture root, reused
   * here for the tests that call `transcriptScan()` directly. */
  async function stubReadOAuth(): Promise<ScanResultOAuth> {
    return {
      result: { ok: false, code: "oauth-usage-no-credentials" },
      stale: false,
      ageMs: null,
      lastKnownOAuth: null,
      consecutiveFailures: 0,
    };
  }

  test("a rejecting memo load degrades to a full parse — never throws, totals still correct", async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-memo-loadfail-"));
    try {
      const now = new Date("2026-05-25T12:00:00Z");
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 500 })]);

      const scan = await transcriptScan(root, now, deriveSkill, stubReadOAuth, {
        load: async () => {
          throw new Error("redis unreachable");
        },
      });
      assert.equal(scan.filesServedFromMemo, 0);
      assert.equal(scan.acc7d.total, 500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a rejecting memo write is swallowed — the already-computed scan is still returned correctly", async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-memo-writefail-"));
    try {
      const now = new Date("2026-05-25T12:00:00Z");
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 500 })]);

      const scan = await transcriptScan(root, now, deriveSkill, stubReadOAuth, {
        write: async () => {
          throw new Error("redis unreachable");
        },
      });
      assert.equal(scan.acc7d.total, 500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a cached entry with an unrecognised family degrades to a full parse of that file", async () => {
    const root = await mkdtemp(join(tmpdir(), "usage-memo-badvocab-"));
    try {
      const now = new Date("2026-05-25T12:00:00Z");
      await writeFixture(root, "p/s.jsonl", [assistantLine("2026-05-25T11:00:00Z", { in: 500 })]);
      const filePath = join(root, "p/s.jsonl");
      const st = await stat(filePath);

      const badEntry: FileParseMemoEntry = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        entries: [
          {
            tsMs: new Date("2026-05-25T11:00:00Z").getTime(),
            tokens: breakdown({ total: 999_999 }), // would be wrong if replayed
            foreign: false,
            family: "not-a-real-family",
          },
        ],
        skill: "hydra-dev",
        dispatchKind: "autopilot-dispatched",
        observedResetMs: null,
        linesParsed: 1,
        linesWithUsage: 1,
        parseErrors: 0,
      };

      const scan = await transcriptScan(root, now, deriveSkill, stubReadOAuth, {
        load: async () => new Map([[filePath, badEntry]]),
        write: async () => {},
      });
      // Fell through to a full parse of the real file content, not the
      // poisoned cached total.
      assert.equal(scan.filesServedFromMemo, 0);
      assert.equal(scan.acc7d.total, 500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
