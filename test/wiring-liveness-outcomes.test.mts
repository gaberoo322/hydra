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
} from "../src/scheduler/chores/wiring-liveness-outcomes.ts";
import type { Outcome } from "../src/outcomes.ts";

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

  test("a leading outcome with a finite reading is LIVE (not flagged)", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("share", "leading")] }),
      readOutcomeValue: async () => ({ value: 0.12 }),
    });
    assert.deepEqual(res.darkOutcomes, []);
    const v = res.outcomeVerdicts[0];
    assert.equal(v.status, "live");
    assert.equal(v.status === "live" && v.value, 0.12);
  });

  test("a non-finite reading (NaN) is treated as DARK", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: true, outcomes: [outcome("weird", "leading")] }),
      readOutcomeValue: async () => ({ value: Number.NaN }),
    });
    assert.deepEqual(res.darkOutcomes, ["weird"]);
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
      readOutcomeValue: async (o) => (o.name === "live-a" ? { value: 1 } : null),
    });
    assert.deepEqual(res.darkOutcomes, ["dark-b"]);
    const statuses = Object.fromEntries(res.outcomeVerdicts.map((v) => [v.name, v.status]));
    assert.deepEqual(statuses, { "live-a": "live", "dark-b": "dark" });
  });

  test("an outcomes-load failure never throws and flags nothing", async () => {
    const res = await evaluateDarkOutcomes({
      loadOutcomes: async () => ({ ok: false, errors: ["schema validation failed"] }),
    });
    assert.deepEqual(res.darkOutcomes, []);
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
