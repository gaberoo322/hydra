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
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/7";
process.env.REDIS_URL = REDIS_URL;

import { publishForecastCalibrationBrierMetric } from "../src/metrics/publish.ts";
import { getOutcomeValue, loadOutcomes } from "../src/outcomes.ts";
import type { Outcome } from "../src/outcomes.ts";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";

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
// Per-league sibling files (issue #4247, hydra-betting ADR-0007 D5)
//
// The aggregate is sport-blind: admitting a more-predictable sport (538: NFL
// Brier 0.208 vs MLB 0.243) moves the blended number toward its 0.18 target
// with zero edge improvement, so it left the Outcome Holdback decision set
// (src/holdback-policy.ts) and per-league siblings carry the honest signal.
// The producer derives them from the SAME fetch's `bySourceLeague` map (keys
// "<source>:<league>", e.g. "paper_llm:baseball_mlb") by pooling each league's
// entries with a count-weighted average of brierScore — mathematically exact
// for a mean-of-squared-errors, so sum(count_i * brier_i) / sum(count_i)
// recovers the pooled per-league Brier over identical rows.
// ---------------------------------------------------------------------------

describe("publishForecastCalibrationBrierMetric — per-league sibling files (#4247)", () => {
  test("pools bySourceLeague entries per league and writes one sibling file per league", async () => {
    const filePath = join(tmpDir, "brier-league1.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({
        brierScore: 0.22,
        bySourceLeague: {
          "paper_llm:baseball_mlb": { count: 40, brierScore: 0.21 },
          "sportsbook_fair_line:baseball_mlb": { count: 10, brierScore: 0.26 },
        },
      }),
    });
    assert.equal(result.ok, true);
    // (40*0.21 + 10*0.26) / 50 = 0.22 — the count-weighted pooled league Brier.
    const sibling = join(tmpDir, "brier-league1-baseball-mlb.txt");
    const raw = await readFile(sibling, "utf-8");
    assert.equal(Number(raw.trim()), 0.22);
    assert.ok(raw.endsWith("\n"), "trailing newline expected (file-adapter contract)");
    assert.ok(result.leagues, "per-league results must be reported");
    assert.equal(result.leagues!.length, 1);
    assert.equal(result.leagues![0].slug, "baseball-mlb");
    assert.equal(result.leagues![0].value, 0.22);
    assert.equal(result.leagues![0].ok, true);
  });

  test("each sibling file holds ONE numeric value that round-trips the outcomes file adapter (INV-1)", async () => {
    const filePath = join(tmpDir, "brier-league2.txt");
    await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({
        brierScore: 0.25,
        bySourceLeague: {
          "paper_llm:baseball_mlb": { count: 7, brierScore: 0.2 },
          "paper_llm:basketball_nba": { count: 3, brierScore: 0.3 },
        },
      }),
    });
    for (const slug of ["baseball-mlb", "basketball-nba"]) {
      const sibling = join(tmpDir, `brier-league2-${slug}.txt`);
      const outcome: Outcome = {
        name: `forecast-calibration-brier-${slug}`,
        kind: "leading",
        direction: "down",
        source: "file",
        query: sibling,
        baseline: 0.25,
        target: 0.18,
        noise_epsilon: 0.005,
      };
      const reading = await getOutcomeValue(outcome);
      assert.ok(reading, `${slug} sibling must parse as a single finite number`);
      assert.ok(Number.isFinite(reading!.value));
    }
  });

  test("slug rule: lowercase, non-alphanumerics collapse to dashes; case-variants pool together", async () => {
    const filePath = join(tmpDir, "brier-league3.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({
        brierScore: 0.25,
        bySourceLeague: {
          "paper_llm:MLB": { count: 3, brierScore: 0.2 },
          "paper_llm:baseball_mlb": { count: 3, brierScore: 0.4 },
        },
      }),
    });
    // "MLB" and "baseball_mlb" slug differently, so they stay separate files —
    // but the SAME league in two spellings ("MLB" vs "mlb") pools into one.
    const slugs = result.leagues!.map((l) => l.slug).sort();
    assert.deepEqual(slugs, ["baseball-mlb", "mlb"]);
  });

  test("same league different spellings differing only in case pool into one sibling", async () => {
    const filePath = join(tmpDir, "brier-league4.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({
        brierScore: 0.25,
        bySourceLeague: {
          "paper_llm:MLB": { count: 3, brierScore: 0.2 },
          "sportsbook_fair_line:mlb": { count: 1, brierScore: 0.4 },
        },
      }),
    });
    assert.equal(result.leagues!.length, 1);
    assert.equal(result.leagues![0].slug, "mlb");
    // (3*0.2 + 1*0.4) / 4 = 0.25
    assert.equal(result.leagues![0].value, 0.25);
  });

  test("never fabricates: null-brier entries are skipped; an all-invalid league writes no file", async () => {
    const filePath = join(tmpDir, "brier-league5.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({
        brierScore: 0.25,
        bySourceLeague: {
          "paper_llm:baseball_mlb": { count: 5, brierScore: null },
          "paper_llm:basketball_nba": { count: 2, brierScore: 0.3 },
        },
      }),
    });
    assert.equal(result.ok, true, "aggregate write is independent of per-league no-data");
    assert.deepEqual(
      result.leagues!.map((l) => l.slug),
      ["basketball-nba"],
      "a league with no finite Brier must produce no sibling (INV-2/INV-7)",
    );
    await assert.rejects(
      stat(join(tmpDir, "brier-league5-baseball-mlb.txt")),
      /ENOENT/,
      "no sibling file for a no-data league",
    );
  });

  test("missing or empty bySourceLeague writes no siblings and keeps the aggregate ok", async () => {
    for (const body of [
      { brierScore: 0.25 }, // field absent (older target build)
      { brierScore: 0.25, bySourceLeague: {} }, // live shape today: no league-tagged rows
    ]) {
      const filePath = join(tmpDir, `brier-league6-${body.bySourceLeague ? "empty" : "absent"}.txt`);
      const result = await publishForecastCalibrationBrierMetric({
        filePath,
        fetchImpl: fetchOk(body),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.leagues ?? [], [], "no per-league data -> no sibling files");
      // The two aggregate files themselves are the only brier-league6-* files
      // allowed in the directory — any third one would be a phantom sibling.
      const knownAggregates = new Set(["brier-league6-absent.txt", "brier-league6-empty.txt"]);
      const strays = (await readdir(tmpDir)).filter(
        (f) => f.startsWith("brier-league6-") && !knownAggregates.has(f),
      );
      assert.deepEqual(strays, [], "no sibling files may appear for a league-less response");
    }
  });

  test("malformed bySourceLeague keys (no source:league separator) are skipped, not fatal", async () => {
    const filePath = join(tmpDir, "brier-league7.txt");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({
        brierScore: 0.25,
        bySourceLeague: {
          "paper_llm:baseball_mlb": { count: 4, brierScore: 0.2 },
          "not-a-source-league-key": { count: 4, brierScore: 0.9 },
        },
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.leagues!.map((l) => l.slug), ["baseball-mlb"]);
  });

  test("a failed fetch leaves previously-written sibling files untouched (INV-2)", async () => {
    const filePath = join(tmpDir, "brier-league8.txt");
    await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: fetchOk({
        brierScore: 0.25,
        bySourceLeague: { "paper_llm:baseball_mlb": { count: 4, brierScore: 0.2 } },
      }),
    });
    const sibling = join(tmpDir, "brier-league8-baseball-mlb.txt");
    const before = await readFile(sibling, "utf-8");
    const result = await publishForecastCalibrationBrierMetric({
      filePath,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed: timeout");
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(await readFile(sibling, "utf-8"), before, "sibling must survive a failed fetch verbatim");
  });
});

// ---------------------------------------------------------------------------
// The live config manifest (config/direction/outcomes.yaml) — pinned against
// regressions of the #4247 design-contract invariants. Resolved relative to
// THIS test file (the worktree checkout), never HYDRA_ROOT, so the assertions
// read the same tree the `test` job checks out.
// ---------------------------------------------------------------------------

describe("outcomes.yaml — per-league declarations (#4247)", () => {
  const manifestPath = pathResolve(
    pathDirname(fileURLToPath(import.meta.url)),
    "../config/direction/outcomes.yaml",
  );

  async function loadManifest(): Promise<Outcome[]> {
    const loaded = await loadOutcomes(manifestPath);
    assert.equal(loaded.ok, true, `live outcomes.yaml must parse: ${JSON.stringify((loaded as any).errors)}`);
    return loaded.outcomes;
  }

  test("live outcomes.yaml keeps the sport-blind aggregate as kind: leading with its query unchanged (INV-3)", async () => {
    const outcomes = await loadManifest();
    const aggregate = outcomes.find((o) => o.name === "forecast-calibration-brier");
    assert.ok(aggregate, "the sport-blind aggregate outcome must stay declared");
    // INV-3: unchanged entry — still leading, still reading the aggregate file,
    // so the dashboard and the outcome-attribution ledger keep their display
    // number while holdback excludes it by NAME (holdback-policy.ts).
    assert.equal(aggregate.kind, "leading");
    assert.equal(aggregate.direction, "down");
    assert.equal(aggregate.query, "metrics/forecast-calibration-brier.txt");
    assert.equal(aggregate.baseline, 0.25);
    assert.equal(aggregate.target, 0.18);
    assert.equal(aggregate.noise_epsilon, 0.005);
  });

  test("every forecast-calibration-brier outcome shares the aggregate's baseline/target/noise_epsilon (INV-6)", async () => {
    const outcomes = await loadManifest();
    const brierOutcomes = outcomes.filter((o) => o.name.startsWith("forecast-calibration-brier"));
    assert.ok(brierOutcomes.length >= 5, "aggregate + at least the four declared leagues");
    for (const o of brierOutcomes) {
      assert.equal(o.kind, "leading", `${o.name} must be leading`);
      assert.equal(o.direction, "down", `${o.name} must be direction down`);
      assert.equal(o.source, "file", `${o.name} must be source file`);
      assert.equal(o.baseline, 0.25, `${o.name} baseline must stay 0.25 (no per-sport skill score)`);
      assert.equal(o.target, 0.18, `${o.name} target must stay 0.18`);
      assert.equal(o.noise_epsilon, 0.005, `${o.name} noise_epsilon must stay 0.005`);
    }
  });

  test("each per-league outcome's query is mechanically derived from its name (one file per league)", async () => {
    const outcomes = await loadManifest();
    const perLeague = outcomes.filter((o) => o.name.startsWith("forecast-calibration-brier-"));
    assert.deepEqual(
      perLeague.map((o) => o.name).sort(),
      [
        "forecast-calibration-brier-americanfootball-ncaaf",
        "forecast-calibration-brier-americanfootball-nfl",
        "forecast-calibration-brier-baseball-mlb",
        "forecast-calibration-brier-basketball-nba",
      ],
      "the four ADR-0007 D3 lanes: MLB live + NBA/NFL/NCAAF admitted next",
    );
    for (const o of perLeague) {
      assert.equal(
        o.query,
        `metrics/${o.name}.txt`,
        `${o.name}: query must be the one-numeric-value file the producer writes for that league`,
      );
    }
  });
});

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
