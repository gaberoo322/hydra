/**
 * Unit coverage for the wiring-liveness DARK-OUTCOME check (issue #2753).
 *
 * Self-contained top-level describe with no shared teardown (CLAUDE.md
 * no-nested-shared-teardown rule). Touches no Redis, no filesystem — the
 * outcomes loader and per-outcome value reader are both injected as fakes, so
 * dark vs live cases are deterministic. Mirrors the focused-module test split of
 * test/wiring-liveness-output.test.mts (#2456): the pure evaluator lives here;
 * the coordinator fan-out is covered in test/wiring-liveness.test.mts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateDarkOutcomes,
  producerHintFor,
  DEFAULT_OUTCOME_MAX_STALE_MS,
} from "../src/scheduler/chores/wiring-liveness-outcomes.ts";
import type { Outcome } from "../src/outcomes.ts";

// A fixed clock so the DARK/STALE/LIVE boundary is deterministic. `fresh`/`old`
// helpers produce mtimes on either side of the default grace window.
const NOW_MS = Date.parse("2026-07-03T12:00:00.000Z");
const now = () => NOW_MS;
const freshTs = new Date(NOW_MS - 60_000).toISOString(); // 1 min old — LIVE
const staleTs = new Date(NOW_MS - DEFAULT_OUTCOME_MAX_STALE_MS - 60_000).toISOString(); // >1d — STALE

function outcome(
  name: string,
  kind: "leading" | "terminal",
  query = `metrics/${name}.txt`,
): Outcome {
  return {
    name,
    kind,
    direction: "up",
    source: "file",
    query,
    baseline: 0,
    target: 1,
    noise_epsilon: 0,
  };
}

describe("wiring-liveness dark-outcome: evaluateDarkOutcomes", () => {
  test("flags a leading outcome whose reading is null as DARK", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("brier", "leading")] }),
      readOutcomeValue: async () => null,
    });
    assert.deepEqual(res.darkOutcomes, ["brier"]);
    assert.equal(res.outcomeVerdicts.length, 1);
    const v = res.outcomeVerdicts[0];
    assert.equal(v.status, "dark");
    assert.equal(v.name, "brier");
    assert.equal(v.status === "dark" && v.query, "metrics/brier.txt");
    assert.equal(v.status === "dark" && v.producerHint.length > 0, true);
  });

  test("a leading outcome with a fresh finite reading is LIVE (not flagged)", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("share", "leading")] }),
      readOutcomeValue: async () => ({ value: 0.12, ts: freshTs }),
      now,
    });
    assert.deepEqual(res.darkOutcomes, []);
    assert.deepEqual(res.staleOutcomes, []);
    const v = res.outcomeVerdicts[0];
    assert.equal(v.status, "live");
    assert.equal(v.status === "live" && v.value, 0.12);
  });

  test("a non-finite reading (NaN) is treated as DARK", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("weird", "leading")] }),
      readOutcomeValue: async () => ({ value: Number.NaN, ts: freshTs }),
      now,
    });
    assert.deepEqual(res.darkOutcomes, ["weird"]);
    assert.deepEqual(res.staleOutcomes, []);
    assert.equal(res.outcomeVerdicts[0].status, "dark");
  });

  test("terminal outcomes are skipped entirely (neither dark nor live)", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({
        ok: true,
        outcomes: [outcome("terminal-thing", "terminal"), outcome("leading-thing", "leading")],
      }),
      // Both would read null, but only the leading one is evaluated.
      readOutcomeValue: async () => null,
      now,
    });
    assert.deepEqual(res.darkOutcomes, ["leading-thing"]);
    assert.equal(res.outcomeVerdicts.length, 1);
    assert.equal(res.outcomeVerdicts[0].name, "leading-thing");
  });

  test("mixed live + dark leading outcomes are reported distinctly", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({
        ok: true,
        outcomes: [outcome("live-a", "leading"), outcome("dark-b", "leading")],
      }),
      readOutcomeValue: async (o) => (o.name === "live-a" ? { value: 1, ts: freshTs } : null),
      now,
    });
    assert.deepEqual(res.darkOutcomes, ["dark-b"]);
    const statuses = Object.fromEntries(res.outcomeVerdicts.map((v) => [v.name, v.status]));
    assert.deepEqual(statuses, { "live-a": "live", "dark-b": "dark" });
  });

  test("an outcomes-load failure never throws and flags nothing", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: false, errors: ["schema validation failed"] }),
      now,
    });
    assert.deepEqual(res.darkOutcomes, []);
    assert.deepEqual(res.staleOutcomes, []);
    assert.deepEqual(res.outcomeVerdicts, []);
  });

  test("producerHintFor names the forecast-calibration-brier producer chain", () => {
    const hint = producerHintFor(outcome("forecast-calibration-brier", "leading"));
    assert.match(hint, /directional/i);
    assert.match(hint, /forecast-outcomes/);
    assert.match(hint, /metrics\/forecast-calibration-brier\.txt/);
  });

  test("producerHintFor gives a generic file hint for other outcomes", () => {
    const hint = producerHintFor(outcome("orchestrator-share", "leading", "metrics/x.txt"));
    assert.match(hint, /metrics\/x\.txt/);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 (approved design concept, issue #2753): DARK (null reading, no
// data) and STALE (a finite reading whose file mtime is older than the grace
// window) are DISTINCT verdicts — a present-but-old value is never conflated
// with a never-produced one. Own top-level describe (no shared teardown).
// ---------------------------------------------------------------------------
describe("wiring-liveness dark-outcome: DARK / STALE / LIVE trichotomy (Invariant 3)", () => {
  test("a finite reading with an OLD mtime is STALE, not LIVE and not DARK", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("brier", "leading")] }),
      readOutcomeValue: async () => ({ value: 0.2, ts: staleTs }),
      now,
    });
    // Distinct from DARK: the reading exists, so darkOutcomes stays empty.
    assert.deepEqual(res.darkOutcomes, []);
    assert.deepEqual(res.staleOutcomes, ["brier"]);
    const v = res.outcomeVerdicts[0];
    assert.equal(v.status, "stale");
    assert.equal(v.status === "stale" && v.value, 0.2);
    assert.equal(v.status === "stale" && v.maxStaleMs, DEFAULT_OUTCOME_MAX_STALE_MS);
    assert.equal(v.status === "stale" && v.ageMs > DEFAULT_OUTCOME_MAX_STALE_MS, true);
    assert.equal(v.status === "stale" && v.producerHint.length > 0, true);
  });

  test("a finite reading with a FRESH mtime is LIVE (inside the grace window)", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("brier", "leading")] }),
      readOutcomeValue: async () => ({ value: 0.2, ts: freshTs }),
      now,
    });
    assert.deepEqual(res.darkOutcomes, []);
    assert.deepEqual(res.staleOutcomes, []);
    assert.equal(res.outcomeVerdicts[0].status, "live");
  });

  test("a null reading is DARK even when a sibling reading is STALE — the two are separate", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({
        ok: true,
        outcomes: [
          outcome("dark-one", "leading"),
          outcome("stale-one", "leading"),
          outcome("live-one", "leading"),
        ],
      }),
      readOutcomeValue: async (o) => {
        if (o.name === "dark-one") return null;
        if (o.name === "stale-one") return { value: 5, ts: staleTs };
        return { value: 7, ts: freshTs };
      },
      now,
    });
    // The trichotomy is fully separated across the three lists / verdicts.
    assert.deepEqual(res.darkOutcomes, ["dark-one"]);
    assert.deepEqual(res.staleOutcomes, ["stale-one"]);
    const statuses = Object.fromEntries(res.outcomeVerdicts.map((v) => [v.name, v.status]));
    assert.deepEqual(statuses, {
      "dark-one": "dark",
      "stale-one": "stale",
      "live-one": "live",
    });
  });

  test("a custom maxStaleMs shifts the STALE boundary", async () => {
    // With a 10-minute window, a 1-minute-old reading is LIVE and a
    // 20-minute-old one is STALE.
    const tenMin = 10 * 60_000;
    const live = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("m", "leading")] }),
      readOutcomeValue: async () => ({ value: 1, ts: new Date(NOW_MS - 60_000).toISOString() }),
      maxStaleMs: tenMin,
      now,
    });
    assert.deepEqual(live.staleOutcomes, []);
    assert.equal(live.outcomeVerdicts[0].status, "live");

    const stale = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("m", "leading")] }),
      readOutcomeValue: async () => ({ value: 1, ts: new Date(NOW_MS - 20 * 60_000).toISOString() }),
      maxStaleMs: tenMin,
      now,
    });
    assert.deepEqual(stale.staleOutcomes, ["m"]);
    assert.equal(stale.outcomeVerdicts[0].status, "stale");
  });

  test("an unparseable ts degrades to LIVE (value is load-bearing, not the ts)", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("m", "leading")] }),
      readOutcomeValue: async () => ({ value: 1, ts: "not-a-date" }),
      now,
    });
    assert.deepEqual(res.darkOutcomes, []);
    assert.deepEqual(res.staleOutcomes, []);
    assert.equal(res.outcomeVerdicts[0].status, "live");
  });
});
