/**
 * Regression tests for the forecast-calibration-brier producer (issue #1657).
 *
 * The 2026-06-10 direction refresh (PR #1658) declared a new leading outcome
 * `forecast-calibration-brier` backed by `source: file` reading
 * `metrics/forecast-calibration-brier.txt`. The producer
 * (`publishForecastCalibrationBrierMetric`, src/metrics/publish.ts) samples
 * the target's aggregate Brier score from hydra-betting
 * `GET /api/calibration/forecast-metrics` and writes the single numeric value
 * to disk; it runs as a Housekeeping chore (src/scheduler/housekeeping.ts).
 *
 * Bug classes guarded:
 *   - Fabricated values: any failure path (unreachable target, non-200,
 *     malformed JSON, null/non-finite brierScore) must leave the metric file
 *     UNTOUCHED — stale mtime is the staleness signal, and a fabricated value
 *     would poison the Outcome Holdback regression check.
 *   - Round-trip break: the written file must parse through the outcomes
 *     file adapter (`getOutcomeValue`) as the same finite number.
 *   - Wiring rot: the Housekeeping summary must report the chore so an
 *     operator can see it sampled (ran) vs threw unexpectedly (skipped).
 *
 * Uses real Redis (DB 7) for the runHousekeeping wiring tests only — the
 * sibling chores read/write guard keys (mirrors api-maintenance.test.mts,
 * issue #948 dedicated-DB convention). The producer tests themselves are
 * hermetic: injectable fetchImpl + tmpdir filePath, no live target.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/7";
process.env.REDIS_URL = REDIS_URL;

import { publishForecastCalibrationBrierMetric } from "../src/metrics/publish.ts";
import { getOutcomeValue, type Outcome } from "../src/outcomes.ts";

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-brier-producer-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

/** Build a fetch stub returning a canned response. */
function fetchOk(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("publishForecastCalibrationBrierMetric — successful sample", () => {
  test("writes the fetched brierScore and reports ok", async () => {
    const filePath = join(tmpDir, "brier-ok.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: 0.21, sampleCount: 40 }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.value, 0.21);
    assert.equal(result.reason, undefined);
    const raw = await readFile(filePath, "utf-8");
    assert.equal(Number(raw.trim()), 0.21);
    assert.ok(raw.endsWith("\n"), "trailing newline expected (file-adapter contract)");
  });

  test("written value round-trips through the outcomes file adapter", async () => {
    const filePath = join(tmpDir, "brier-roundtrip.txt");
    const written = 0.183;
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: written }),
    });
    assert.equal(result.ok, true);

    const outcome: Outcome = {
      name: "forecast-calibration-brier",
      kind: "leading",
      direction: "down",
      source: "file",
      // Absolute path so resolveFilePath() doesn't append HYDRA_ROOT.
      query: filePath,
      baseline: 0.25,
      target: 0.18,
      noise_epsilon: 0.01,
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "outcomes file adapter should return a reading, not null");
    assert.equal(reading!.value, written);
  });

  test("re-publish overwrites with the current value (hourly idempotency)", async () => {
    const filePath = join(tmpDir, "brier-rolling.txt");
    await publishForecastCalibrationBrierMetric({ filePath, fetchImpl: fetchOk({ brierScore: 0.3 }) });
    const second = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: 0.22 }),
    });
    assert.equal(second.ok, true);
    assert.equal(Number((await readFile(filePath, "utf-8")).trim()), 0.22);
  });
});

describe("publishForecastCalibrationBrierMetric — never write a fabricated value", () => {
  test("unreachable target -> no file, fetch-failed", async () => {
    const filePath = join(tmpDir, "brier-unreachable.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "fetch-failed");
    await assert.rejects(stat(filePath), /ENOENT/, "file must not be created on fetch failure");
  });

  test("non-200 response -> no file, non-200", async () => {
    const filePath = join(tmpDir, "brier-500.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-200");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("malformed JSON body -> no file, malformed-response", async () => {
    const filePath = join(tmpDir, "brier-malformed.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      })) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "malformed-response");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("null brierScore (not enough resolved forecasts) -> no file, no-score", async () => {
    const filePath = join(tmpDir, "brier-null.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: null, sampleCount: 0 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-score");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("non-numeric brierScore -> no file, no-score", async () => {
    const filePath = join(tmpDir, "brier-string.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({ brierScore: "0.21" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-score");
    await assert.rejects(stat(filePath), /ENOENT/);
  });

  test("failure leaves a previously-written value untouched (stale mtime is the signal)", async () => {
    const filePath = join(tmpDir, "brier-stale.txt");
    await writeFile(filePath, "0.24\n", "utf-8");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed: timeout");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(
      (await readFile(filePath, "utf-8")),
      "0.24\n",
      "prior value must survive a failed sample verbatim",
    );
  });
});

// ---------------------------------------------------------------------------
// Per-league sibling files (issue #4247 / ADR-0007 D5). The aggregate stays a
// sport-blind scalar; the per-league slices are the honest per-sport signal.
// The league set is reconstructed client-side from the SAME
// /api/calibration/forecast-metrics response — `bySourceLeague` entries
// (keyed "<source>:<league>") grouped by their league segment and pooled with
// a count-weighted average, which is mathematically exact for Brier (a mean
// of squared errors): sum(count_i * brier_i) / sum(count_i).
// ---------------------------------------------------------------------------

describe("publishForecastCalibrationBrierMetric — per-league sibling files (#4247)", () => {
  function leagueDir(): string {
    return join(tmpDir, `league-${Math.random().toString(36).slice(2)}`);
  }

  test("writes one sibling file per league, count-weighted across sources", async () => {
    const dir = leagueDir();
    const result = await publishForecastCalibrationBrierMetric({
      filePath: join(tmpDir, "agg-weighted.txt"),
      leagueDirPath: dir,
      fetchImpl: fetchOk({
        brierScore: 0.24,
        bySourceLeague: {
          "paper_llm:mlb": { count: 100, brierScore: 0.2 },
          "sportsbook_fair_line:mlb": { count: 300, brierScore: 0.3 },
          "paper_llm:nba": { count: 50, brierScore: 0.21 },
        },
      }),
    });
    assert.equal(result.ok, true);
    // (100*0.20 + 300*0.30) / 400 = 0.275 — the pooled per-league Brier.
    assert.equal(Number((await readFile(join(dir, "mlb.txt"), "utf-8")).trim()), 0.275);
    assert.equal(Number((await readFile(join(dir, "nba.txt"), "utf-8")).trim()), 0.21);
    const leagues = (result.leagues ?? []).map((l: any) => l.league).sort();
    assert.deepEqual(leagues, ["mlb", "nba"]);
    for (const l of result.leagues ?? []) {
      assert.ok(l.path.startsWith(dir), "league paths live under the league dir");
      assert.ok(Number.isFinite(l.value), "reported league values are finite");
    }
  });

  test("league file values round-trip through the outcomes file adapter", async () => {
    const dir = leagueDir();
    const result = await publishForecastCalibrationBrierMetric({
      leagueDirPath: dir,
      fetchImpl: fetchOk({
        brierScore: 0.24,
        bySourceLeague: { "paper_llm:mlb": { count: 12, brierScore: 0.183 } },
      }),
    });
    assert.equal(result.ok, true);
    const outcome: Outcome = {
      name: "forecast-calibration-brier-mlb",
      kind: "leading",
      direction: "down",
      source: "file",
      query: join(dir, "mlb.txt"),
      baseline: 0.25,
      target: 0.18,
      noise_epsilon: 0.005,
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "per-league file should read back through the file adapter");
    assert.equal(reading!.value, 0.183);
  });

  test("normalizes league keys (trim + lowercase) before naming the file", async () => {
    const dir = leagueDir();
    const result = await publishForecastCalibrationBrierMetric({
      leagueDirPath: dir,
      fetchImpl: fetchOk({
        brierScore: 0.24,
        bySourceLeague: { "paper_llm: MLB ": { count: 10, brierScore: 0.22 } },
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(Number((await readFile(join(dir, "mlb.txt"), "utf-8")).trim()), 0.22);
    assert.equal((result.leagues ?? []).length, 1);
  });

  test("empty bySourceLeague writes the aggregate only, no league files (today's live shape)", async () => {
    const dir = leagueDir();
    const result = await publishForecastCalibrationBrierMetric({
      filePath: join(tmpDir, "agg-empty.txt"),
      leagueDirPath: dir,
      fetchImpl: fetchOk({ brierScore: 0.238, bySourceLeague: {} }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.leagues, []);
    await assert.rejects(stat(dir), /ENOENT/, "no league directory is created when no league has data");
  });

  test("a league whose slices all have null brierScore stays absent (no phantom zero file)", async () => {
    const dir = leagueDir();
    const result = await publishForecastCalibrationBrierMetric({
      leagueDirPath: dir,
      fetchImpl: fetchOk({
        brierScore: 0.24,
        bySourceLeague: { "paper_llm:mlb": { count: 5, brierScore: null } },
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.leagues, []);
    await assert.rejects(stat(join(dir, "mlb.txt")), /ENOENT/, "absent, never a phantom zero");
  });

  test("mixed null and finite slices: only finite slices contribute to the weighted average", async () => {
    const dir = leagueDir();
    const result = await publishForecastCalibrationBrierMetric({
      leagueDirPath: dir,
      fetchImpl: fetchOk({
        brierScore: 0.24,
        bySourceLeague: {
          "paper_llm:mlb": { count: 100, brierScore: null },
          "sportsbook_fair_line:mlb": { count: 100, brierScore: 0.3 },
        },
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(Number((await readFile(join(dir, "mlb.txt"), "utf-8")).trim()), 0.3);
  });

  test("unsafe league strings are skipped, not written", async () => {
    const dir = leagueDir();
    const result = await publishForecastCalibrationBrierMetric({
      leagueDirPath: dir,
      fetchImpl: fetchOk({
        brierScore: 0.24,
        bySourceLeague: {
          "paper_llm:../escape": { count: 10, brierScore: 0.2 },
          "paper_llm:ml/b": { count: 10, brierScore: 0.2 },
          "paper_llm:ok": { count: 10, brierScore: 0.21 },
        },
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(Number((await readFile(join(dir, "ok.txt"), "utf-8")).trim()), 0.21);
    const entries = await readdirSafe(dir);
    assert.deepEqual(entries.sort(), ["ok.txt"], "path-unsafe league keys are routed out, never bucketed");
  });
});

describe("publishForecastCalibrationBrierMetric — per-league never-fabricate posture (#4247)", () => {
  test("per-league fetch/parse failure leaves league files untouched", async () => {
    const dir = join(tmpDir, `league-stale-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mlb.txt"), "0.19\n", "utf-8");
    const result = await publishForecastCalibrationBrierMetric({
      leagueDirPath: dir,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "fetch-failed");
    assert.equal(
      (await readFile(join(dir, "mlb.txt"), "utf-8")),
      "0.19\n",
      "prior per-league value must survive a failed sample verbatim",
    );
    const entries = await readdirSafe(dir);
    assert.deepEqual(entries, ["mlb.txt"], "no partial/phantom files appear on failure");
  });
});

/** readdir that returns [] on ENOENT (the league dir may legitimately not exist). */
async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(dir);
  } catch {
    return [];
  }
}

describe("Housekeeping wiring (issue #1657 — seventh chore)", () => {
  // runHousekeeping's sibling chores read/write Redis guard keys, so these
  // tests need a live Redis (DB 7, dedicated per #948). The producer itself
  // is injected so no live target is required.
  test("chore reports 'ran' when the producer resolves", async () => {
    const { runHousekeeping } = await import("../src/scheduler/housekeeping.ts");
    let calls = 0;
    const summary = await runHousekeeping(
      { publish: async () => {} },
      {
        publishBrierMetric: async () => {
          calls++;
          return { ok: true };
        },
        // Issue #3756: stub the sweep so this composition test performs no live
        // GitHub write (the sweep mutates an external service).
        runGlmEligibilitySweep: async () => 0,
      },
    );
    assert.equal(calls, 1, "producer must be invoked exactly once per housekeeping run");
    assert.ok(
      summary.ran.includes("forecast-calibration-brier"),
      `forecast-calibration-brier should be in ran, got ran=${JSON.stringify(summary.ran)}`,
    );
  });

  test("chore reports 'ran' even when the sample failed (no-write is not a throw)", async () => {
    const { runHousekeeping } = await import("../src/scheduler/housekeeping.ts");
    const summary = await runHousekeeping(
      { publish: async () => {} },
      { publishBrierMetric: async () => ({ ok: false }), runGlmEligibilitySweep: async () => 0 },
    );
    assert.ok(
      summary.ran.includes("forecast-calibration-brier"),
      "a clean failed sample still counts as ran (producer never throws by contract)",
    );
  });

  test("chore reports 'skipped' on an unexpected throw", async () => {
    const { runHousekeeping } = await import("../src/scheduler/housekeeping.ts");
    const summary = await runHousekeeping(
      { publish: async () => {} },
      {
        publishBrierMetric: async () => {
          throw new Error("unexpected producer crash");
        },
        runGlmEligibilitySweep: async () => 0,
      },
    );
    assert.ok(
      summary.skipped.includes("forecast-calibration-brier"),
      "an unexpected throw must surface in skipped, not abort the run",
    );
    assert.ok(
      !summary.ran.includes("forecast-calibration-brier"),
      "a throwing chore must not also count as ran",
    );
  });
});
