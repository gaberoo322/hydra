/**
 * test/now-pixel-oak-tab-state.test.mts — covers the OakTownCrier 3-tab
 * panel's pure plumbing (slice B of the autopilot-observability epic,
 * issue #669).
 *
 * The component-level rendering (tab switching, row expand-on-click) is
 * exercised in `now-pixel-turn-journal-tab.test.mts` against the same
 * helpers — this file pins the load-bearing data shape: turn
 * summarisation, token-delta computation, summary-line composition, and
 * localStorage round-trips.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OAK_TAB,
  OAK_TAB_IDS,
  OAK_TAB_STORAGE_KEY,
  TAB_JOURNAL,
  TAB_LIVE,
  TAB_RECS,
  buildSummaryLine,
  formatRelativeTime,
  formatTokenDelta,
  isOakTabId,
  readStoredOakTab,
  summariseTurns,
  writeStoredOakTab,
} from "../dashboard/src/pages/now-pixel/oak-tab-state.ts";

// Tiny in-memory storage shim that quacks like Web Storage well enough
// for these helpers (getItem/setItem only).
function makeMemoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    _dump: () => Object.fromEntries(map),
  };
}

test("OAK_TAB_IDS: exactly three tabs (live / journal / recs)", () => {
  assert.deepEqual([...OAK_TAB_IDS].sort(), [TAB_JOURNAL, TAB_LIVE, TAB_RECS].sort());
  assert.equal(OAK_TAB_IDS.length, 3);
});

test("DEFAULT_OAK_TAB: defaults to Live feed (preserves existing slice-5 behaviour)", () => {
  // If we ever flip the default, the operator's first impression of
  // /now-pixel changes — keep this test deliberate.
  assert.equal(DEFAULT_OAK_TAB, TAB_LIVE);
});

test("isOakTabId: accepts known ids, rejects everything else", () => {
  assert.equal(isOakTabId(TAB_LIVE), true);
  assert.equal(isOakTabId(TAB_JOURNAL), true);
  assert.equal(isOakTabId(TAB_RECS), true);
  assert.equal(isOakTabId(null), false);
  assert.equal(isOakTabId(undefined), false);
  assert.equal(isOakTabId(""), false);
  assert.equal(isOakTabId("recommendations"), false);
  assert.equal(isOakTabId(42), false);
});

test("readStoredOakTab: returns stored value when valid", () => {
  const storage = makeMemoryStorage({ [OAK_TAB_STORAGE_KEY]: TAB_JOURNAL });
  assert.equal(readStoredOakTab(storage), TAB_JOURNAL);
});

test("readStoredOakTab: returns default when nothing stored", () => {
  const storage = makeMemoryStorage();
  assert.equal(readStoredOakTab(storage), DEFAULT_OAK_TAB);
});

test("readStoredOakTab: returns default when stored value is bogus", () => {
  const storage = makeMemoryStorage({
    [OAK_TAB_STORAGE_KEY]: "totally-made-up",
  });
  assert.equal(readStoredOakTab(storage), DEFAULT_OAK_TAB);
});

test("readStoredOakTab: returns default when storage is null/undefined (SSR / disabled)", () => {
  assert.equal(readStoredOakTab(null), DEFAULT_OAK_TAB);
  assert.equal(readStoredOakTab(undefined), DEFAULT_OAK_TAB);
});

test("readStoredOakTab: swallows getItem throws (e.g. SecurityError in private mode)", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("SecurityError: storage disabled");
    },
  };
  assert.equal(readStoredOakTab(throwingStorage), DEFAULT_OAK_TAB);
});

test("writeStoredOakTab: persists the chosen tab id at the documented key", () => {
  const storage = makeMemoryStorage();
  writeStoredOakTab(storage, TAB_JOURNAL);
  assert.equal(storage._dump()[OAK_TAB_STORAGE_KEY], TAB_JOURNAL);
});

test("writeStoredOakTab: no-ops when storage missing (no throw)", () => {
  // The component calls this in a useEffect on every tab change; an SSR
  // render where window.localStorage is undefined must not blow up.
  writeStoredOakTab(null, TAB_RECS);
  writeStoredOakTab(undefined, TAB_RECS);
});

test("writeStoredOakTab: swallows setItem throws (storage quota / disabled)", () => {
  const throwingStorage = {
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  // Must not throw.
  writeStoredOakTab(throwingStorage, TAB_LIVE);
});

test("formatTokenDelta: human-friendly k/M units with sign", () => {
  assert.equal(formatTokenDelta(0), "+0");
  assert.equal(formatTokenDelta(500), "+500");
  assert.equal(formatTokenDelta(12_345), "+12.3k");
  assert.equal(formatTokenDelta(-12_345), "-12.3k");
  assert.equal(formatTokenDelta(2_500_000), "+2.5M");
});

test("buildSummaryLine: dispatched-only when no skips or token delta", () => {
  assert.equal(buildSummaryLine(2, 0, null), "dispatched 2");
});

test("buildSummaryLine: includes skip clause only when count > 0", () => {
  assert.equal(buildSummaryLine(1, 4, null), "dispatched 1, skipped 4");
  // 0 skips → clause hidden so the row stays terse.
  assert.equal(buildSummaryLine(1, 0, 12_300), "dispatched 1, tokens +12.3k");
});

test("buildSummaryLine: full ledger when all three fields present", () => {
  assert.equal(
    buildSummaryLine(2, 4, 12_300),
    "dispatched 2, skipped 4, tokens +12.3k",
  );
});

test("buildSummaryLine: tolerates non-finite token deltas by dropping the clause", () => {
  assert.equal(buildSummaryLine(1, 0, Number.NaN), "dispatched 1");
  assert.equal(buildSummaryLine(1, 0, Number.POSITIVE_INFINITY), "dispatched 1");
});

test("formatRelativeTime: seconds / minutes / hours / days bands", () => {
  const now = 1_000_000;
  assert.equal(formatRelativeTime(now - 12, now), "12s ago");
  assert.equal(formatRelativeTime(now - 240, now), "4m ago");
  assert.equal(formatRelativeTime(now - 7200, now), "2h ago");
  assert.equal(formatRelativeTime(now - 172_800, now), "2d ago");
});

test("formatRelativeTime: empty string for invalid input", () => {
  assert.equal(formatRelativeTime(null, 1_000_000), "");
  assert.equal(formatRelativeTime(undefined, 1_000_000), "");
  assert.equal(formatRelativeTime(0, 1_000_000), "");
  assert.equal(formatRelativeTime(Number.NaN, 1_000_000), "");
});

test("formatRelativeTime: future timestamps clamp to 0s ago (no negative diff)", () => {
  // Clock skew between the dashboard and the orchestrator process could
  // make a turn's epoch appear slightly in the future. Render "0s ago"
  // rather than "-3s ago" so the row stays readable.
  assert.equal(formatRelativeTime(1_000_010, 1_000_000), "0s ago");
});

test("summariseTurns: empty / null input → empty array", () => {
  assert.deepEqual(summariseTurns(null), []);
  assert.deepEqual(summariseTurns(undefined), []);
  assert.deepEqual(summariseTurns([]), []);
});

test("summariseTurns: produces one row per turn, newest-first", () => {
  const turns = [
    {
      turn_n: 1,
      epoch: 1_000,
      actions: [
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev", reason: "board has ready-for-agent" },
      ],
      tokens_after: 50_000,
    },
    {
      turn_n: 2,
      epoch: 2_000,
      actions: [
        { type: "dispatch", slot: "qa_orch", skill: "hydra-qa", reason: "needs-qa" },
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev", reason: "board has ready-for-agent" },
      ],
      tokens_after: 175_000,
    },
  ];
  const rows = summariseTurns(turns);
  assert.equal(rows.length, 2);
  // Newest first — turn 2 before turn 1.
  assert.equal(rows[0].turn_n, 2);
  assert.equal(rows[1].turn_n, 1);
});

test("summariseTurns: defensive sort works even when input is shuffled", () => {
  const turns = [
    { turn_n: 5, epoch: 5_000, actions: [], tokens_after: 100 },
    { turn_n: 1, epoch: 1_000, actions: [], tokens_after: 10 },
    { turn_n: 3, epoch: 3_000, actions: [], tokens_after: 30 },
  ];
  const rows = summariseTurns(turns);
  assert.deepEqual(
    rows.map((r) => r.turn_n),
    [5, 3, 1],
  );
});

test("summariseTurns: dispatchedClasses lists slots in action order", () => {
  const turns = [
    {
      turn_n: 7,
      epoch: 7_000,
      actions: [
        { type: "dispatch", slot: "qa_orch", skill: "hydra-qa", reason: "needs-qa" },
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev", reason: "board" },
        { type: "dispatch", slot: "dev_target", skill: "hydra-target-build", reason: "queue" },
      ],
      tokens_after: 400,
    },
  ];
  const [row] = summariseTurns(turns);
  assert.deepEqual(row.dispatchedClasses, ["qa_orch", "dev_orch", "dev_target"]);
});

test("summariseTurns: dispatchDetails preserve slot/skill/reason for the expand panel", () => {
  const turns = [
    {
      turn_n: 4,
      epoch: 4_000,
      actions: [
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev", reason: "ready-for-agent count > 0" },
      ],
      tokens_after: 200,
    },
  ];
  const [row] = summariseTurns(turns);
  assert.deepEqual(row.dispatchDetails, [
    { slot: "dev_orch", skill: "hydra-dev", reason: "ready-for-agent count > 0" },
  ]);
});

test("summariseTurns: ignores actions whose type isn't 'dispatch'", () => {
  const turns = [
    {
      turn_n: 1,
      epoch: 1_000,
      actions: [
        { type: "dispatch", slot: "dev_orch" },
        { type: "skip", slot: "research_orch", reason: "cooldown" },
        { type: "noop" },
        { type: "dispatch", slot: "" }, // bogus empty slot — drop it
      ],
      tokens_after: 50,
    },
  ];
  const [row] = summariseTurns(turns);
  assert.deepEqual(row.dispatchedClasses, ["dev_orch"]);
  assert.equal(row.skippedCount, 1);
});

test("summariseTurns: token delta = thisTurn.tokens_after - previousTurn.tokens_after", () => {
  const turns = [
    { turn_n: 1, epoch: 1_000, actions: [], tokens_after: 50_000 },
    { turn_n: 2, epoch: 2_000, actions: [], tokens_after: 175_000 },
    { turn_n: 3, epoch: 3_000, actions: [], tokens_after: 300_000 },
  ];
  const rows = summariseTurns(turns);
  // rows are newest-first; deltas measured against chronologically-prev turn.
  assert.equal(rows[0].turn_n, 3);
  assert.equal(rows[0].tokensDelta, 125_000); // 300k - 175k
  assert.equal(rows[1].turn_n, 2);
  assert.equal(rows[1].tokensDelta, 125_000); // 175k - 50k
  assert.equal(rows[2].turn_n, 1);
  assert.equal(rows[2].tokensDelta, 50_000); // first-ever turn: delta = cumulative
});

test("summariseTurns: missing tokens_after → null delta (don't fabricate)", () => {
  const turns = [
    { turn_n: 1, epoch: 1_000, actions: [] },
    { turn_n: 2, epoch: 2_000, actions: [], tokens_after: 100 },
  ];
  const rows = summariseTurns(turns);
  assert.equal(rows[0].turn_n, 2);
  assert.equal(rows[0].tokensDelta, null); // prev has no tokens_after
  assert.equal(rows[1].turn_n, 1);
  assert.equal(rows[1].tokensDelta, null); // self has no tokens_after
});

test("summariseTurns: stable row.id derives from turn_n (preferred) or epoch", () => {
  const rows = summariseTurns([
    { turn_n: 3, epoch: 3_000, actions: [], tokens_after: 100 },
    { epoch: 2_000, actions: [], tokens_after: 50 },
    { actions: [] },
  ]);
  assert.equal(rows[0].id, "turn-3");
  assert.equal(rows[1].id, "epoch-2000");
  // No turn_n, no epoch → falls back to a positional id so React keys
  // remain unique inside a single render.
  assert.equal(rows[2].id, "idx-2");
});

test("summariseTurns: summary string composed from dispatch/skip/token clauses", () => {
  const [row] = summariseTurns([
    {
      turn_n: 1,
      epoch: 1_000,
      actions: [
        { type: "dispatch", slot: "dev_orch" },
        { type: "dispatch", slot: "qa_orch" },
        { type: "skip", slot: "research_orch", reason: "cooldown" },
      ],
      tokens_after: 12_300,
    },
  ]);
  // First-ever turn → delta = cumulative tokens.
  assert.equal(row.summary, "dispatched 2, skipped 1, tokens +12.3k");
});
