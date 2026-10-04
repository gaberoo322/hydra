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
  sentinelLine,
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

// Walk-level characterization of transcriptScan (issue #4790, epic #4780).
// Sets the behaviour floor for the walk-refactor slices (#4791/#4792): each of
// the phase map's four walk-level gaps is asserted on BOTH the fresh-parse path
// and the memo-replay path, against the walk's own ScanResult (not a hand-built
// one). The replay is driven capture-then-replay: pass 1 captures the upserts
// handed to memoIo.write; pass 2 serves them back through memoIo.load over the
// UNCHANGED files. Redis-free by construction — memoIo.load AND memoIo.write
// are always injected, so this suite never touches the shared memo hash.
describe("transcriptScan walk-level characterization (issue #4790)", () => {
  const NOW = new Date("2026-05-25T12:00:00Z");
  const FIELDS = ["input", "output", "cacheRead", "cacheCreation", "total"] as const;
  let restoreEnv: () => void;
  const roots: string[] = [];

  beforeEach(() => {
    restoreEnv = withEnvSnapshot();
    delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
  });
  afterEach(async () => {
    restoreEnv();
    while (roots.length > 0) {
      await rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "transcript-walk-char-"));
    roots.push(root);
    return root;
  }

  async function stubReadOAuth(): Promise<ScanResultOAuth> {
    return {
      result: { ok: false, code: "oauth-usage-no-credentials" },
      stale: false,
      ageMs: null,
      lastKnownOAuth: null,
      consecutiveFailures: 0,
    };
  }

  /** A line carrying ONLY a rate-limit reset (no usage) — parseObservedResetMs
   * probes it; parseUsageLine skips it. Local to this suite on purpose. */
  function resetLine(ts: string, resetsAt: string): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { rate_limit: { resets_at: resetsAt } },
    });
  }

  async function freshScan(root: string) {
    let captured = new Map<string, FileParseMemoEntry>();
    const scan = await transcriptScan(root, NOW, deriveSkill, stubReadOAuth, {
      load: async () => new Map(),
      write: async (upserts) => {
        captured = new Map(upserts);
      },
    });
    return { scan, captured };
  }

  async function replayScan(root: string, memo: Map<string, FileParseMemoEntry>) {
    return transcriptScan(root, NOW, deriveSkill, stubReadOAuth, {
      load: async () => memo,
      write: async () => {},
    });
  }

  /** Σ over skills of `table[skill][family][field]`. */
  function sumSkills(table: Record<string, any>, family: string, field: string): number {
    let sum = 0;
    for (const skill of Object.keys(table)) sum += table[skill][family][field];
    return sum;
  }

  function assertReplayMatches(
    fresh: Awaited<ReturnType<typeof freshScan>>["scan"],
    replay: Awaited<ReturnType<typeof freshScan>>["scan"],
    fileCount: number,
  ) {
    assert.equal(fresh.filesServedFromMemo, 0);
    assert.equal(replay.filesServedFromMemo, fileCount);
    assert.deepEqual(replay.bySkillByModel24h, fresh.bySkillByModel24h);
    assert.deepEqual(replay.byDispatchKind, fresh.byDispatchKind);
    assert.deepEqual(replay.foreign7d, fresh.foreign7d);
    assert.equal(replay.mostRecentObservedResetMs, fresh.mostRecentObservedResetMs);
    assert.deepEqual(replay.acc7d, fresh.acc7d);
    assert.deepEqual(replay.byModel7d, fresh.byModel7d);
    assert.deepEqual(replay.byModel24h, fresh.byModel24h);
    assert.equal(replay.tokens24h, fresh.tokens24h);
    assert.deepEqual(replay.bySkillByModel, fresh.bySkillByModel);
  }

  async function writeReconciliationFixture(root: string) {
    // A: opus in 24h + sonnet in 7d-but-outside-24h. B: haiku in 24h.
    // C: opus only in 7d-but-outside-24h (so hydra-sweep has NO 24h row).
    await writeFixture(root, "p/a.jsonl", [
      sentinelLine("hydra-dev"),
      assistantLine("2026-05-25T11:00:00Z", { in: 100, out: 10 }, "claude-opus-4-7"),
      assistantLine("2026-05-24T06:00:00Z", { in: 200 }, "claude-sonnet-4-6"),
    ]);
    await writeFixture(root, "p/b.jsonl", [
      sentinelLine("hydra-qa"),
      assistantLine("2026-05-25T10:00:00Z", { in: 50, cacheRead: 5 }, "claude-haiku-4-5"),
    ]);
    await writeFixture(root, "p/c.jsonl", [
      sentinelLine("hydra-sweep"),
      assistantLine("2026-05-23T12:00:00Z", { in: 300 }, "claude-opus-4-7"),
    ]);
  }

  test("gap 1 (fresh): bySkillByModel24h reconciles to byModel24h/tokens24h per family and field (#3752)", async () => {
    const root = await makeRoot();
    await writeReconciliationFixture(root);
    const { scan } = await freshScan(root);

    assert.equal(scan.tokens24h, 165);
    assert.equal(scan.bySkillByModel24h["hydra-dev"].opus.total, 110);
    assert.equal(scan.bySkillByModel24h["hydra-qa"].haiku.total, 55);
    for (const family of Object.keys(scan.byModel24h)) {
      for (const field of FIELDS) {
        assert.equal(
          sumSkills(scan.bySkillByModel24h, family, field),
          (scan.byModel24h as any)[family][field],
          `Σ_skill bySkillByModel24h[${family}].${field} === byModel24h[${family}].${field}`,
        );
      }
    }
    let grand = 0;
    for (const skill of Object.keys(scan.bySkillByModel24h)) {
      for (const family of Object.keys(scan.byModel24h)) {
        grand += (scan.bySkillByModel24h as any)[skill][family].total;
      }
    }
    assert.equal(grand, scan.tokens24h);
  });

  test("gap 1 (row gate): a skill with only out-of-24h lines has a 7d row but NO 24h row, on both paths", async () => {
    const root = await makeRoot();
    await writeReconciliationFixture(root);
    const { scan: fresh, captured } = await freshScan(root);
    const replay = await replayScan(root, captured);

    for (const scan of [fresh, replay]) {
      assert.ok(scan.bySkillByModel["hydra-sweep"], "hydra-sweep has a 7d row");
      assert.equal(scan.bySkillByModel["hydra-sweep"].opus.total, 300);
      assert.equal("hydra-sweep" in scan.bySkillByModel24h, false);
    }
  });

  test("gap 1 (replay): the reconciliation fixture replays identically from the memo", async () => {
    const root = await makeRoot();
    await writeReconciliationFixture(root);
    const { scan: fresh, captured } = await freshScan(root);
    const replay = await replayScan(root, captured);
    assertReplayMatches(fresh, replay, 3);
    assert.equal(replay.tokens24h, 165);
    assert.equal(replay.bySkillByModel24h["hydra-dev"].opus.total, 110);
  });

  test("gap 2 (fresh + replay): mostRecentObservedResetMs is the max reset across files when the anchor is set", async () => {
    process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-18T00:00:00Z";
    const root = await makeRoot();
    await writeFixture(root, "p/r1.jsonl", [
      resetLine("2026-05-25T09:00:00Z", "2026-05-20T00:00:00Z"),
      resetLine("2026-05-25T09:30:00Z", "2026-05-24T00:00:00Z"),
      assistantLine("2026-05-25T10:00:00Z", { in: 10 }, "claude-opus-4-7"),
    ]);
    await writeFixture(root, "p/r2.jsonl", [
      resetLine("2026-05-25T09:00:00Z", "2026-05-22T00:00:00Z"),
      assistantLine("2026-05-25T10:00:00Z", { in: 10 }, "claude-opus-4-7"),
    ]);
    const { scan, captured } = await freshScan(root);
    assert.equal(scan.mostRecentObservedResetMs, Date.parse("2026-05-24T00:00:00Z"));

    const replay = await replayScan(root, captured);
    assert.equal(replay.filesServedFromMemo, 2);
    assert.equal(replay.mostRecentObservedResetMs, Date.parse("2026-05-24T00:00:00Z"));
  });

  test("gap 2 (memo write): the captured entry carries observedResetMs even when the anchor env is UNSET (#3805)", async () => {
    const root = await makeRoot();
    await writeFixture(root, "p/r1.jsonl", [
      resetLine("2026-05-25T09:00:00Z", "2026-05-20T00:00:00Z"),
      resetLine("2026-05-25T09:30:00Z", "2026-05-24T00:00:00Z"),
      assistantLine("2026-05-25T10:00:00Z", { in: 10 }, "claude-opus-4-7"),
    ]);
    const { scan, captured } = await freshScan(root);
    assert.equal(scan.mostRecentObservedResetMs, null);
    const entry = captured.get(join(root, "p/r1.jsonl"));
    assert.ok(entry, "an upsert was captured for the file");
    assert.equal(entry.observedResetMs, Date.parse("2026-05-24T00:00:00Z"));
  });

  test("gap 2 (memo replay gate): a seeded observedResetMs promotes only when the anchor is set, independent of skill", async () => {
    const root = await makeRoot();
    await writeFixture(root, "p/s.jsonl", [
      assistantLine("2026-05-25T11:00:00Z", { in: 500 }, "claude-opus-4-7"),
    ]);
    const filePath = join(root, "p/s.jsonl");
    const st = await stat(filePath);
    const X = Date.parse("2026-05-23T00:00:00Z");
    const seeded: FileParseMemoEntry = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      entries: [
        {
          tsMs: Date.parse("2026-05-25T11:00:00Z"),
          tokens: breakdown({ input: 500 }),
          foreign: false,
          family: "opus",
        },
      ],
      skill: null, // the promotion sits outside the cachedSkill !== null branch
      dispatchKind: null,
      observedResetMs: X,
      linesParsed: 1,
      linesWithUsage: 1,
      parseErrors: 0,
    };

    process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-05-18T00:00:00Z";
    const withAnchor = await replayScan(root, new Map([[filePath, seeded]]));
    assert.equal(withAnchor.filesServedFromMemo, 1);
    assert.equal(withAnchor.mostRecentObservedResetMs, X);

    delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
    const withoutAnchor = await replayScan(root, new Map([[filePath, seeded]]));
    assert.equal(withoutAnchor.filesServedFromMemo, 1);
    assert.equal(withoutAnchor.mostRecentObservedResetMs, null);
  });

  async function writeForeignFixture(root: string) {
    await writeFixture(root, "p/mixed.jsonl", [
      sentinelLine("hydra-dev"),
      assistantLine("2026-05-25T10:00:00Z", { in: 700 }, "glm-4.5"),
      assistantLine("2026-05-25T11:00:00Z", { in: 100 }, "claude-opus-4-7"),
    ]);
    await writeFixture(root, "p/foreign-only.jsonl", [
      sentinelLine("hydra-qa"),
      assistantLine("2026-05-25T10:30:00Z", { in: 400 }, "glm-4.5"),
    ]);
  }

  test("gap 3 (fresh): foreign tokens land only in foreign7d; the memo entry marks them foreign/unknown", async () => {
    const root = await makeRoot();
    await writeForeignFixture(root);
    const { scan, captured } = await freshScan(root);

    assert.equal(scan.foreign7d.total, 1100);
    assert.equal(scan.acc7d.total, 100);
    assert.equal(scan.byModel7d.opus.total, 100);
    assert.equal(scan.byModel24h.opus.total, 100);
    assert.equal(scan.tokens24h, 100);
    assert.equal(scan.bySkillByModel["hydra-dev"].opus.total, 100);
    assert.equal("hydra-qa" in scan.bySkillByModel, false, "foreign-only file conjures no skill row");
    assert.equal("hydra-qa" in scan.bySkillByModel24h, false);
    assert.equal(scan.byDispatchKind["autopilot-dispatched"].opus.total, 100);
    for (const family of Object.keys(scan.byModel7d)) {
      if (family === "opus") continue;
      assert.equal((scan.byModel7d as any)[family].total, 0, `${family} untouched by foreign tokens`);
    }

    const mixed = captured.get(join(root, "p/mixed.jsonl"));
    assert.ok(mixed);
    const glmEntry = mixed.entries.find((e) => e.foreign);
    assert.ok(glmEntry, "the glm line is memoized as a foreign entry");
    assert.equal(glmEntry.family, "unknown");
    assert.equal(glmEntry.tokens.total, 700);
  });

  test("gap 3 (replay): foreign entries replay into foreign7d with every other accumulator unchanged", async () => {
    const root = await makeRoot();
    await writeForeignFixture(root);
    const { scan: fresh, captured } = await freshScan(root);
    const replay = await replayScan(root, captured);

    assertReplayMatches(fresh, replay, 2);
    assert.equal(replay.foreign7d.total, 1100);
    assert.equal(replay.acc7d.total, 100);
    assert.equal("hydra-qa" in replay.bySkillByModel, false);
  });

  async function writeDispatchKindFixture(root: string) {
    await writeFixture(root, "p/auto.jsonl", [
      sentinelLine("hydra-dev"),
      assistantLine("2026-05-25T10:00:00Z", { in: 100 }, "claude-opus-4-7"),
    ]);
    await writeFixture(root, "p/operator.jsonl", [
      userLine("<command-name>/hydra-qa</command-name>"),
      assistantLine("2026-05-25T10:00:00Z", { in: 200 }, "claude-sonnet-4-6"),
    ]);
    await writeFixture(root, "p/interactive.jsonl", [
      userLine("hello"),
      assistantLine("2026-05-25T10:00:00Z", { in: 300 }, "claude-haiku-4-5"),
    ]);
  }

  test("gap 4 (fresh): byDispatchKind rows carry exactly their file's tokens and reconcile to byModel7d", async () => {
    const root = await makeRoot();
    await writeDispatchKindFixture(root);
    const { scan } = await freshScan(root);

    assert.deepEqual(Object.keys(scan.byDispatchKind).sort(), [
      "autopilot-dispatched",
      "interactive",
      "operator-invoked",
    ]);
    assert.equal(scan.byDispatchKind["autopilot-dispatched"].opus.total, 100);
    assert.equal(scan.byDispatchKind["operator-invoked"].sonnet.total, 200);
    assert.equal(scan.byDispatchKind["interactive"].haiku.total, 300);
    assert.equal(scan.byDispatchKind["autopilot-dispatched"].sonnet.total, 0);
    assert.equal(scan.byDispatchKind["operator-invoked"].opus.total, 0);
    assert.equal(scan.byDispatchKind["interactive"].opus.total, 0);
    for (const family of Object.keys(scan.byModel7d)) {
      for (const field of FIELDS) {
        let sum = 0;
        for (const kind of Object.keys(scan.byDispatchKind)) {
          sum += (scan.byDispatchKind as any)[kind][family][field];
        }
        assert.equal(sum, (scan.byModel7d as any)[family][field], `Σ_kind ${family}.${field}`);
      }
    }
  });

  test("gap 4 (replay): byDispatchKind replays deep-equal, and all kind keys are present even when empty", async () => {
    const root = await makeRoot();
    await writeDispatchKindFixture(root);
    const { scan: fresh, captured } = await freshScan(root);
    const replay = await replayScan(root, captured);
    assertReplayMatches(fresh, replay, 3);

    // Empty corpus: all three kind keys still pre-seeded on the walk output.
    const emptyRoot = await makeRoot();
    const { scan: empty } = await freshScan(emptyRoot);
    assert.deepEqual(Object.keys(empty.byDispatchKind).sort(), [
      "autopilot-dispatched",
      "interactive",
      "operator-invoked",
    ]);
  });
});
