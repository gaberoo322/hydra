/**
 * Regression tests for the Codex-log cost reconciliation module (issue #296).
 *
 * Bug classes guarded:
 *   - Mis-summing the cumulative `total_token_usage` field across the many
 *     `token_count` events per session (each event is cumulative — taking
 *     the LAST event is correct; summing them all would double-count).
 *   - Silently dropping sessions whose model name lives in
 *     `collaboration_mode.settings.model` instead of `payload.model`.
 *   - Crashing the daily run on a single malformed JSONL line.
 *   - Dollar figure leaking past the parser when MODEL_PRICING has no entry
 *     for a slug (must surface `pricingMissing: true`).
 *   - Reading the wrong sessions directory because of a malformed date.
 *   - Treating an absent sessions directory as an error (must fail-soft
 *     per the AC).
 *   - Reporting divergence between figures when only one figure is known.
 *
 * These tests are I/O-on-temp-dir; they never touch the real
 * `~/.codex/sessions/` tree.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSessionJsonl,
  priceTokens,
  pairwiseDivergence,
  aggregateByModel,
  scanCodexLogsForDate,
  sessionsDirForDate,
  codexSessionsRoot,
  reconcileDailyCosts,
  MAX_HISTORY_DAYS,
  RECONCILIATION_TTL_SECONDS,
  KILL_FLAG_KEY,
} from "../src/cost/reconciliation.ts";

// ---------------------------------------------------------------------------
// Constants / contract sanity
// ---------------------------------------------------------------------------

describe("cost-reconciliation constants", () => {
  test("Redis TTL is 90 days per AC", () => {
    assert.equal(RECONCILIATION_TTL_SECONDS, 60 * 60 * 24 * 90);
  });
  test("history cap is 30 days per AC", () => {
    assert.equal(MAX_HISTORY_DAYS, 30);
  });
  test("kill flag key is the documented one", () => {
    assert.equal(KILL_FLAG_KEY, "hydra:cost-reconciliation:disabled");
  });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("sessionsDirForDate", () => {
  test("composes the YYYY/MM/DD path against codexSessionsRoot()", () => {
    const root = codexSessionsRoot();
    assert.equal(sessionsDirForDate("2026-05-11", root), join(root, "2026", "05", "11"));
  });
  test("returns null on malformed date", () => {
    assert.equal(sessionsDirForDate("not-a-date"), null);
    assert.equal(sessionsDirForDate("2026-5-11"), null); // missing leading zero
  });
  test("honors CODEX_HOME env var via codexSessionsRoot", () => {
    const orig = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/var/codex-test";
      assert.equal(codexSessionsRoot(), "/var/codex-test/sessions");
    } finally {
      if (orig === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// priceTokens — matches the codex-runner.ts computeCost formula
// ---------------------------------------------------------------------------

describe("priceTokens", () => {
  test("known model: gpt-5.3-codex pricing matches MODEL_PRICING rates", () => {
    // 1M input + 1M output @ ($1.75 in, $14.00 out) = $15.75
    const { costUsd, pricingMissing } = priceTokens("gpt-5.3-codex", 1_000_000, 1_000_000);
    assert.equal(pricingMissing, false);
    assert.equal(costUsd, 15.75);
  });

  test("known model: gpt-5.4-mini pricing", () => {
    // 100k input + 10k output @ ($0.75 in, $4.50 out)
    //   input  = 0.1 * 0.75 = 0.075
    //   output = 0.01 * 4.50 = 0.045
    //   total  = 0.12
    const { costUsd, pricingMissing } = priceTokens("gpt-5.4-mini", 100_000, 10_000);
    assert.equal(pricingMissing, false);
    assert.equal(costUsd, 0.12);
  });

  test("unknown model: returns pricingMissing=true and 0 USD", () => {
    const { costUsd, pricingMissing } = priceTokens("gpt-7-not-real", 1_000_000, 1_000_000);
    assert.equal(pricingMissing, true);
    assert.equal(costUsd, 0);
  });

  test("zero tokens => zero cost (not NaN)", () => {
    const { costUsd } = priceTokens("gpt-5.3-codex", 0, 0);
    assert.equal(costUsd, 0);
  });
});

// ---------------------------------------------------------------------------
// pairwiseDivergence
// ---------------------------------------------------------------------------

describe("pairwiseDivergence", () => {
  test("three close figures => small divergence", () => {
    // worst pair is 10 vs 12 => (12-10)/12 = 0.166...
    const d = pairwiseDivergence([10, 12, 11]);
    assert.ok(d !== null && Math.abs(d - (2 / 12)) < 1e-9);
  });

  test("200x divergence (the actual QW#2 case)", () => {
    // 2100 vs 10 -> (2100-10)/2100 ~ 0.9952
    const d = pairwiseDivergence([2100, 10]);
    assert.ok(d !== null && d > 0.99);
  });

  test("single finite figure => null (cannot compare against itself)", () => {
    assert.equal(pairwiseDivergence([null, 100, null]), null);
  });

  test("zero with non-zero => 100% divergence", () => {
    assert.equal(pairwiseDivergence([0, 100]), 1);
  });

  test("all zeros => 0 divergence (not NaN)", () => {
    assert.equal(pairwiseDivergence([0, 0]), 0);
  });
});

// ---------------------------------------------------------------------------
// parseSessionJsonl — the JSONL contract documented at the top of the module
// ---------------------------------------------------------------------------

function jsonlLine(obj: any): string {
  return JSON.stringify(obj) + "\n";
}

function makeSession({
  model,
  totals,
  midEvents = [],
  modelInCollabMode = false,
}: {
  model: string;
  totals: { input: number; cached: number; output: number; reasoning?: number; total: number };
  midEvents?: Array<{ input: number; cached: number; output: number; total: number }>;
  modelInCollabMode?: boolean;
}): string {
  const turnContext = modelInCollabMode
    ? { type: "turn_context", payload: { collaboration_mode: { settings: { model } } } }
    : { type: "turn_context", payload: { model } };

  const pieces: string[] = [jsonlLine(turnContext)];

  // Intermediate (cumulative) token_count events — must NOT contribute extra.
  for (const m of midEvents) {
    pieces.push(jsonlLine({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: m.input,
            cached_input_tokens: m.cached,
            output_tokens: m.output,
            reasoning_output_tokens: 0,
            total_tokens: m.total,
          },
          last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          model_context_window: 200_000,
        },
      },
    }));
  }

  // Final token_count event — this is the one we count.
  pieces.push(jsonlLine({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: totals.input,
          cached_input_tokens: totals.cached,
          output_tokens: totals.output,
          reasoning_output_tokens: totals.reasoning ?? 0,
          total_tokens: totals.total,
        },
        last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        model_context_window: 200_000,
      },
    },
  }));
  return pieces.join("");
}

describe("parseSessionJsonl", () => {
  test("takes the LAST token_count event (cumulative), not the sum", () => {
    const content = makeSession({
      model: "gpt-5.3-codex",
      midEvents: [
        { input: 100, cached: 50, output: 10, total: 110 },
        { input: 250, cached: 120, output: 30, total: 280 },
      ],
      totals: { input: 500, cached: 240, output: 60, total: 560 },
    });
    const agg = parseSessionJsonl(content);
    assert.ok(agg !== null);
    assert.equal(agg.model, "gpt-5.3-codex");
    assert.equal(agg.inputTokens, 500);
    assert.equal(agg.outputTokens, 60);
    assert.equal(agg.cachedInputTokens, 240);
    assert.equal(agg.totalTokens, 560);
  });

  test("resolves model from collaboration_mode.settings when payload.model is absent", () => {
    const content = makeSession({
      model: "gpt-5.4-mini",
      totals: { input: 200, cached: 0, output: 20, total: 220 },
      modelInCollabMode: true,
    });
    const agg = parseSessionJsonl(content);
    assert.ok(agg !== null);
    assert.equal(agg.model, "gpt-5.4-mini");
  });

  test("malformed JSONL lines are skipped, not fatal", () => {
    const valid = makeSession({
      model: "gpt-5.3-codex",
      totals: { input: 100, cached: 0, output: 10, total: 110 },
    });
    const bad = "\nthis-is-not-json\n{not-json-either\n" + valid + "\n   \n";
    const agg = parseSessionJsonl(bad);
    assert.ok(agg !== null);
    assert.equal(agg.inputTokens, 100);
    assert.equal(agg.outputTokens, 10);
  });

  test("token_count events with info: null are skipped (early-session noise)", () => {
    const noInfo = jsonlLine({
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 5 } } },
    });
    const valid = makeSession({
      model: "gpt-5.3-codex",
      totals: { input: 100, cached: 0, output: 10, total: 110 },
    });
    const agg = parseSessionJsonl(noInfo + valid);
    assert.ok(agg !== null);
    assert.equal(agg.inputTokens, 100);
  });

  test("session with no usage events => returns null", () => {
    const onlyTurnContext = jsonlLine({ type: "turn_context", payload: { model: "gpt-5.3-codex" } });
    assert.equal(parseSessionJsonl(onlyTurnContext), null);
    assert.equal(parseSessionJsonl(""), null);
    assert.equal(parseSessionJsonl("\n\n"), null);
  });

  test("session with usage but unknown model gets 'unknown' bucket (not dropped)", () => {
    // Build a usage event with NO preceding turn_context.
    const content = jsonlLine({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 300,
            cached_input_tokens: 0,
            output_tokens: 40,
            reasoning_output_tokens: 0,
            total_tokens: 340,
          },
        },
      },
    });
    const agg = parseSessionJsonl(content);
    assert.ok(agg !== null);
    assert.equal(agg.model, "unknown");
    assert.equal(agg.inputTokens, 300);
  });
});

// ---------------------------------------------------------------------------
// aggregateByModel
// ---------------------------------------------------------------------------

describe("aggregateByModel", () => {
  test("groups by model, sums tokens, prices with MODEL_PRICING", () => {
    const out = aggregateByModel([
      {
        model: "gpt-5.3-codex",
        inputTokens: 500_000, cachedInputTokens: 250_000,
        outputTokens: 50_000, reasoningOutputTokens: 0, totalTokens: 550_000,
      },
      {
        model: "gpt-5.3-codex",
        inputTokens: 500_000, cachedInputTokens: 250_000,
        outputTokens: 50_000, reasoningOutputTokens: 0, totalTokens: 550_000,
      },
      {
        model: "gpt-5.4-mini",
        inputTokens: 100_000, cachedInputTokens: 0,
        outputTokens: 10_000, reasoningOutputTokens: 0, totalTokens: 110_000,
      },
    ]);
    assert.equal(out.length, 2);
    const codex = out.find((b) => b.model === "gpt-5.3-codex");
    const mini = out.find((b) => b.model === "gpt-5.4-mini");
    assert.ok(codex && mini);
    assert.equal(codex.inputTokens, 1_000_000);
    assert.equal(codex.outputTokens, 100_000);
    assert.equal(codex.sessions, 2);
    // gpt-5.3-codex: 1M in × $1.75 + 100k out × $14 = 1.75 + 1.40 = $3.15
    assert.equal(codex.costUsd, 3.15);
    assert.equal(mini.sessions, 1);
    // gpt-5.4-mini: 100k in × $0.75 + 10k out × $4.50 = 0.075 + 0.045 = $0.12
    assert.equal(mini.costUsd, 0.12);
  });

  test("unknown model: pricingMissing=true, costUsd=null", () => {
    const out = aggregateByModel([
      {
        model: "gpt-7-unknown",
        inputTokens: 1000, cachedInputTokens: 0,
        outputTokens: 100, reasoningOutputTokens: 0, totalTokens: 1100,
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].pricingMissing, true);
    assert.equal(out[0].costUsd, null);
  });
});

// ---------------------------------------------------------------------------
// scanCodexLogsForDate — temp-dir end-to-end
// ---------------------------------------------------------------------------

describe("scanCodexLogsForDate", () => {
  test("missing date directory => 0 sessions scanned, fail-soft with reason", async () => {
    // Point CODEX_HOME at a brand-new empty temp dir; the dated sub-dir
    // won't exist.
    const tmp = await mkdtemp(join(tmpdir(), "hydra-cost-recon-"));
    const orig = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmp;
    try {
      const r = await scanCodexLogsForDate("2026-05-11");
      assert.equal(r.sessionsScanned, 0);
      assert.equal(r.sessionsSkipped, 0);
      assert.equal(r.codexLogUsd, 0);
      assert.equal(r.byModel.length, 0);
      assert.ok(r.reason && r.reason.includes("no sessions directory"));
    } finally {
      if (orig === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = orig;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("malformed date => fail-soft", async () => {
    const r = await scanCodexLogsForDate("not-a-date");
    assert.equal(r.sessionsScanned, 0);
    assert.ok(r.reason && r.reason.includes("invalid date format"));
  });

  test("scans a synthetic sessions directory and prices correctly", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "hydra-cost-recon-"));
    const dateDir = join(tmp, "sessions", "2026", "05", "11");
    await mkdir(dateDir, { recursive: true });

    // Session 1: gpt-5.3-codex, 500k in / 50k out
    await writeFile(
      join(dateDir, "rollout-2026-05-11T00-00-00-aaa.jsonl"),
      makeSession({
        model: "gpt-5.3-codex",
        totals: { input: 500_000, cached: 250_000, output: 50_000, total: 550_000 },
      }),
    );

    // Session 2: gpt-5.3-codex again, 500k in / 50k out
    await writeFile(
      join(dateDir, "rollout-2026-05-11T00-01-00-bbb.jsonl"),
      makeSession({
        model: "gpt-5.3-codex",
        totals: { input: 500_000, cached: 250_000, output: 50_000, total: 550_000 },
      }),
    );

    // Session 3: gpt-5.4-mini, 100k in / 10k out
    await writeFile(
      join(dateDir, "rollout-2026-05-11T00-02-00-ccc.jsonl"),
      makeSession({
        model: "gpt-5.4-mini",
        totals: { input: 100_000, cached: 0, output: 10_000, total: 110_000 },
      }),
    );

    // Session 4: a totally broken JSONL file — counts as 1 scanned + 1 skipped.
    await writeFile(join(dateDir, "rollout-2026-05-11T00-03-00-ddd.jsonl"), "garbage\nnot json\n");

    // Non-jsonl file — must be ignored entirely.
    await writeFile(join(dateDir, "ignore-me.txt"), "noise");

    const orig = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmp;
    try {
      const r = await scanCodexLogsForDate("2026-05-11");
      assert.equal(r.sessionsScanned, 4);
      assert.equal(r.sessionsSkipped, 1);
      assert.equal(r.skipReasons[0].file, "rollout-2026-05-11T00-03-00-ddd.jsonl");

      assert.equal(r.byModel.length, 2);
      const codex = r.byModel.find((b) => b.model === "gpt-5.3-codex");
      const mini = r.byModel.find((b) => b.model === "gpt-5.4-mini");
      assert.ok(codex && mini);
      assert.equal(codex.sessions, 2);
      assert.equal(codex.inputTokens, 1_000_000);
      assert.equal(codex.outputTokens, 100_000);
      // codex: 1.75 + 1.40 = 3.15;  mini: 0.075 + 0.045 = 0.12  =>  total 3.27
      assert.equal(r.codexLogUsd, 3.27);
    } finally {
      if (orig === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = orig;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// reconcileDailyCosts — defensive contract (no-throw + bad-input handling)
// ---------------------------------------------------------------------------

describe("reconcileDailyCosts contract", () => {
  test("bad date format => ok=false with reason, never throws", async () => {
    const r = await reconcileDailyCosts("garbage");
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.includes("invalid date format"));
    assert.equal(r.codexLogUsd, 0);
    assert.equal(r.byModel.length, 0);
  });

  // We don't test the full Redis-write path here — it requires a live Redis
  // and is exercised by the manual sanity-check captured in the PR body.
});
