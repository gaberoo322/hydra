/**
 * Regression tests for the per-line calibration ledger (issue #4627,
 * ADR-0034 §8.4) — the pure verdict policy in src/attention-calibration.ts
 * and the episode-ledger Redis ops in src/redis/attention.ts.
 *
 * The episode is the (admission-line key, item id) pair. These tests pin the
 * three §8.4 behaviours the feed depends on:
 *
 *   - record-once surfaced (the 30s dashboard poll cannot inflate a line),
 *   - prune-on-absence gated by source health (a re-crossing after a clear
 *     is a NEW episode that recounts; a dead source proves nothing),
 *   - the verdict fold — only not-a-problem can falsify a line, and only
 *     with >= 5 surfaced episodes in the rolling 30-day window.
 *
 * Top-level describes with their own before/after Redis lifecycle (never
 * nested under a sibling suite's teardown) and a beforeEach keyspace wipe —
 * every case here mutates shared ledger state.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";

import {
  CALIBRATION_MIN_SURFACED,
  CALIBRATION_TTL_DAYS,
  CALIBRATION_TTL_SECONDS,
  CALIBRATION_WINDOW_DAYS,
  MISCALIBRATED_NOT_A_PROBLEM_RATIO,
  calibrationDayDate,
  calibrationDayDates,
  calibrationRows,
  foldCalibrationWindow,
  verdictFor,
} from "../src/attention-calibration.ts";
import {
  dismissAttentionItem,
  loadDismissed,
  reconcileLedgers,
  readCalibrationLines,
  type AdmittedLine,
} from "../src/redis/attention.ts";
import { redisKeys } from "../src/redis/keys.ts";
import { ADMISSION_LINE_KEYS } from "../src/schemas/operator-actions.ts";

const NOW = new Date("2026-10-11T09:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The line these tests write through (repetition is the quiet default). */
const KEY = "repetition:hits";
const OTHER_KEY = "waiting-on-you:blocked-live";

// ---------------------------------------------------------------------------
// Pure policy — src/attention-calibration.ts (no Redis)
// ---------------------------------------------------------------------------

describe("attention-calibration — verdict policy (pure)", () => {
  test("surfaced below the minimum is insufficient-data; the ratio is never computed below it", () => {
    assert.equal(CALIBRATION_MIN_SURFACED, 5);
    const zero = verdictFor({ surfaced: 0, notAProblem: 0 });
    assert.equal(zero.verdict, "insufficient-data");
    assert.equal(zero.because, "0 surfaced < 5 minimum over 30d");

    // The strongest probe: 100% not-a-problem, but only 4 episodes — the
    // data is insufficient, NOT miscalibrated (§8.4).
    const four = verdictFor({ surfaced: 4, notAProblem: 4 });
    assert.equal(four.verdict, "insufficient-data");
    assert.equal(four.because, "4 surfaced < 5 minimum over 30d");
  });

  test("the 0.5 boundary falls on miscalibrated (>=, not >)", () => {
    const at = verdictFor({ surfaced: 10, notAProblem: 5 });
    assert.equal(at.verdict, "miscalibrated");
    assert.equal(at.because, "5 not-a-problem / 10 surfaced = 0.5 >= 0.5 over 30d");

    const under = verdictFor({ surfaced: 10, notAProblem: 4 });
    assert.equal(under.verdict, "calibrated");
    assert.equal(under.because, "4 not-a-problem / 10 surfaced = 0.4 < 0.5 over 30d");
    assert.equal(MISCALIBRATED_NOT_A_PROBLEM_RATIO, 0.5);
  });

  test("ratio formatting trims trailing zeros (1, 0.375)", () => {
    const whole = verdictFor({ surfaced: 8, notAProblem: 8 });
    assert.equal(whole.because, "8 not-a-problem / 8 surfaced = 1 >= 0.5 over 30d");
    const frac = verdictFor({ surfaced: 8, notAProblem: 3 });
    assert.equal(frac.because, "3 not-a-problem / 8 surfaced = 0.375 < 0.5 over 30d");
  });

  test("only the two verdict inputs are read — handled-elsewhere / later / resolved cannot falsify a line", () => {
    // Structural: verdictFor's parameter type admits exactly surfaced +
    // notAProblem, so no other counter can even be handed to it. The
    // compile-time contract is the assertion; the runtime probe below shows
    // a saturated non-falsifying row still reads calibrated.
    const row = calibrationRows([
      { [`${KEY}:surfaced`]: "10", [`${KEY}:handled-elsewhere`]: "10", [`${KEY}:later`]: "10" },
    ]).find((r) => r.key === KEY)!;
    assert.equal(row.verdict, "calibrated");
    assert.equal(row.handledElsewhere, 10);
    assert.equal(row.later, 10);
  });

  test("calibrationDayDates — 30 UTC day keys, newest first, ending today-29", () => {
    assert.equal(CALIBRATION_WINDOW_DAYS, 30);
    const dates = calibrationDayDates(NOW);
    assert.equal(dates.length, 30);
    assert.equal(dates[0], calibrationDayDate(NOW));
    assert.equal(dates[29], calibrationDayDate(new Date(NOW.getTime() - 29 * DAY_MS)));
    for (const d of dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("foldCalibrationWindow — fields parse at the LAST colon, unknown counters and foreign fields are ignored", () => {
    const totals = foldCalibrationWindow([
      {
        // `<bucket>:<line>:<counter>` — the key itself contains a colon.
        [`${KEY}:surfaced`]: "3",
        [`${KEY}:not-a-problem`]: "2",
        [`${KEY}:resolved`]: "1",
        [`${KEY}:garbage-counter`]: "9",
        "foreign-field": "7",
        [`${KEY}:later`]: "0", // non-positive is a no-op
        [`${OTHER_KEY}:handled-elsewhere`]: "4",
      },
    ]);
    const line = totals.get(KEY)!;
    assert.equal(line.surfaced, 3);
    assert.equal(line.notAProblem, 2);
    assert.equal(line.resolved, 1);
    assert.equal(line.later, 0);
    assert.equal(line.handledElsewhere, 0);
    assert.equal(totals.get(OTHER_KEY)!.handledElsewhere, 4);
    assert.equal(totals.has("foreign-field"), false);
    assert.equal(totals.has(`${KEY}:garbage`), false);
  });

  test("calibrationRows — one row per registry line in drain order, zeros asserted", () => {
    const rows = calibrationRows([{}]);
    assert.equal(rows.length, ADMISSION_LINE_KEYS.length);
    assert.deepEqual(
      rows.map((r) => r.key),
      [...ADMISSION_LINE_KEYS],
    );
    for (const r of rows) {
      assert.deepEqual(
        { surfaced: r.surfaced, resolved: r.resolved, notAProblem: r.notAProblem, handledElsewhere: r.handledElsewhere, later: r.later },
        { surfaced: 0, resolved: 0, notAProblem: 0, handledElsewhere: 0, later: 0 },
      );
      assert.equal(r.verdict, "insufficient-data");
      assert.equal(r.because, "0 surfaced < 5 minimum over 30d");
    }
  });

  test("calibrationRows — the verdict rides the folded totals", () => {
    const rows = calibrationRows([
      { [`${KEY}:surfaced`]: "10", [`${KEY}:not-a-problem`]: "5" },
    ]);
    const line = rows.find((r) => r.key === KEY)!;
    assert.equal(line.verdict, "miscalibrated");
    assert.equal(line.because, "5 not-a-problem / 10 surfaced = 0.5 >= 0.5 over 30d");
    assert.equal(rows.find((r) => r.key === OTHER_KEY)!.verdict, "insufficient-data");
  });
});

// ---------------------------------------------------------------------------
// Episode ledger — src/redis/attention.ts (real Redis; per-run DB isolation
// from scripts/test/redis-db-launch.mjs keeps this keyspace private to the run)
// ---------------------------------------------------------------------------

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) {
    testRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }
  return testRedis;
}

/**
 * Admitted ids per line — the composer's input shape: every registry line is
 * present (a quiet line is an empty admitted set), healthy by default.
 */
function admitted(
  byLine: Record<string, string[]>,
  healthy: Record<string, boolean> = {},
): ReadonlyMap<string, AdmittedLine> {
  const m = new Map<string, AdmittedLine>();
  for (const key of ADMISSION_LINE_KEYS) {
    m.set(key, {
      admitted: new Set(byLine[key] ?? []),
      healthy: healthy[key] ?? true,
    });
  }
  return m;
}

describe("redis/attention — per-line episode ledger + calibration counters", () => {
  before(async () => {
    getTestRedis();
  });

  after(() => {
    if (testRedis) testRedis.disconnect();
  });

  beforeEach(async () => {
    // Fresh attention keyspace per case — these tests mutate shared state.
    const r = getTestRedis();
    const keys = await r.keys("hydra:attention:*");
    if (keys.length > 0) await r.del(...keys);
  });

  const dayKey = (now: Date = NOW) =>
    redisKeys.attentionCalibrationDay(calibrationDayDate(now));

  test("surfaced is counted once per episode — the poll cadence cannot inflate it (INV-3)", async () => {
    // Two consecutive compose cycles admitting the same id (what the
    // dashboard's 30s poll produces) count ONE episode.
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW);
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW);
    assert.equal(
      await getTestRedis().hget(dayKey(), `${KEY}:surfaced`),
      "1",
    );
    assert.equal(await getTestRedis().hlen(redisKeys.attentionSurfaced(KEY)), 1);
  });

  test("surfaced counters are keyed by admission line, not by item (INV-1)", async () => {
    await reconcileLedgers(
      admitted({ [KEY]: ["pr-1", "pr-2"], [OTHER_KEY]: ["blocked-1"] }),
      NOW,
    );
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:surfaced`), "2");
    assert.equal(await getTestRedis().hget(dayKey(), `${OTHER_KEY}:surfaced`), "1");
  });

  test("absence from a healthy source clears the episode and counts it resolved (INV-4)", async () => {
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW);
    // The item cleared; the source is healthy, so the absence is proof.
    await reconcileLedgers(admitted({}), NOW);
    assert.equal(await getTestRedis().hlen(redisKeys.attentionSurfaced(KEY)), 0);
    assert.equal(await getTestRedis().hlen(redisKeys.attentionDismissed(KEY)), 0);
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:resolved`), "1");
    // surfaced is per-EPISODE — the clear does not un-count the episode.
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:surfaced`), "1");
  });

  test("an unhealthy source leaves the line's ledgers untouched (INV-4)", async () => {
    // Recording is unconditional (a crossed line surfaced even if its
    // bucket's other source is broken)…
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }, { [KEY]: false }), NOW);
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:surfaced`), "1");
    // …but pruning is health-gated: an id absent from an unhealthy source
    // proved nothing. Empty + unhealthy is skipped outright.
    await reconcileLedgers(admitted({}, { [KEY]: false }), NOW);
    assert.equal(await getTestRedis().hlen(redisKeys.attentionSurfaced(KEY)), 1);
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:resolved`), null);
  });

  test("a re-crossing after the item cleared resurfaces and recounts (INV-5)", async () => {
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW);
    await reconcileLedgers(admitted({}), NOW); // cleared + resolved
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW); // crosses again
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:surfaced`), "2");
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:resolved`), "1");
  });

  test("a snooze expiry resurfacing a still-crossing item does not recount it (INV-7 / INV-3)", async () => {
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW);
    // Dismissed 31 days ago — past the 30-day snooze, so the suppression
    // has lapsed; the surfaced hash field from the first crossing survives.
    await dismissAttentionItem("pr-1", KEY, "later", new Date(NOW.getTime() - 31 * DAY_MS));
    const active = await loadDismissed(NOW);
    assert.equal(active.get(KEY)!.size, 0, "snooze expired — no suppression");
    // Still crossing: the compose admits it again, but HSETNX sees the
    // surviving episode → surfaced does NOT increment a second time.
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW);
    assert.equal(await getTestRedis().hget(dayKey(), `${KEY}:surfaced`), "1");
    assert.equal(await getTestRedis().hlen(redisKeys.attentionSurfaced(KEY)), 1);
  });

  test("only not-a-problem moves a line toward miscalibrated (INV-9)", async () => {
    const r = getTestRedis();
    // Saturated with the non-falsifying reasons: still calibrated.
    await r.hset(dayKey(), {
      [`${KEY}:surfaced`]: "10",
      [`${KEY}:handled-elsewhere`]: "10",
      [`${KEY}:later`]: "10",
    });
    let rows = await readCalibrationLines(NOW);
    let line = rows.find((x) => x.key === KEY)!;
    assert.equal(line.verdict, "calibrated");
    assert.equal(line.because, "0 not-a-problem / 10 surfaced = 0 < 0.5 over 30d");
    assert.equal(line.handledElsewhere, 10);
    assert.equal(line.later, 10);
    // 5 not-a-problem / 10 surfaced = 0.5 — the boundary flips it.
    await r.hset(dayKey(), { [`${KEY}:not-a-problem`]: "5" });
    rows = await readCalibrationLines(NOW);
    line = rows.find((x) => x.key === KEY)!;
    assert.equal(line.verdict, "miscalibrated");
    assert.equal(line.because, "5 not-a-problem / 10 surfaced = 0.5 >= 0.5 over 30d");
  });

  test("readCalibrationLines lists every registry line with zeros asserted (INV-13)", async () => {
    const rows = await readCalibrationLines(NOW);
    assert.equal(rows.length, ADMISSION_LINE_KEYS.length);
    assert.deepEqual(
      rows.map((x) => x.key),
      [...ADMISSION_LINE_KEYS],
    );
    for (const row of rows) {
      assert.equal(row.surfaced, 0);
      assert.equal(row.verdict, "insufficient-data");
      assert.equal(row.because, "0 surfaced < 5 minimum over 30d");
    }
  });

  test("days outside the rolling 30-day window do not fold into the verdict", async () => {
    // A saturated OLD day (31 days back) — outside every window read from NOW.
    const oldDay = redisKeys.attentionCalibrationDay(
      calibrationDayDate(new Date(NOW.getTime() - 31 * DAY_MS)),
    );
    await getTestRedis().hset(oldDay, { [`${KEY}:surfaced`]: "100", [`${KEY}:not-a-problem`]: "100" });
    const line = (await readCalibrationLines(NOW)).find((x) => x.key === KEY)!;
    assert.equal(line.surfaced, 0);
    assert.equal(line.verdict, "insufficient-data");
  });

  test("the day hash carries the 35-day TTL, stamped on write", async () => {
    assert.equal(CALIBRATION_TTL_DAYS, 35);
    assert.equal(CALIBRATION_TTL_SECONDS, 35 * 24 * 60 * 60);
    await reconcileLedgers(admitted({ [KEY]: ["pr-1"] }), NOW);
    const ttl = await getTestRedis().ttl(dayKey());
    assert.ok(ttl > 0 && ttl <= CALIBRATION_TTL_SECONDS, `ttl=${ttl}`);
    assert.ok(ttl >= CALIBRATION_TTL_SECONDS - 5, `ttl=${ttl}`);
    // A dismiss stamps the same TTL on its day hash.
    await reconcileLedgers(admitted({ [OTHER_KEY]: ["pr-9"] }), NOW);
    await dismissAttentionItem("pr-9", OTHER_KEY, "not-a-problem", NOW);
    assert.ok((await getTestRedis().ttl(dayKey())) > 0);
  });

  test("the per-signal counter keys are retired — no builder or literal remains (INV-14)", async () => {
    // No builder: the typed accessor exposes nothing counter-shaped anymore.
    assert.deepEqual(
      Object.keys(redisKeys).filter((p) => p.startsWith("attentionCount")),
      [],
    );
    // No literal anywhere in src/: the retired key family and its two
    // builder names survive in no source file (test fixtures excluded —
    // this file is the scan's only legitimate mention).
    const retired = ["hydra:attention:counts:", "attentionCountSurfaced", "attentionCountDismissed"];
    const srcRoot = join(import.meta.dirname, "..", "src");
    const files = readdirSync(srcRoot, { recursive: true }).filter(
      (f) => typeof f === "string" && f.endsWith(".ts"),
    ) as string[];
    assert.ok(files.length > 50, `scan saw ${files.length} files`);
    for (const file of files) {
      const text = readFileSync(join(srcRoot, file), "utf8");
      for (const needle of retired) {
        assert.equal(text.includes(needle), false, `${needle} survives in src/${file}`);
      }
    }
  });
});
