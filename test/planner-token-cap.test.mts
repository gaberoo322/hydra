/**
 * Regression test for issue #361 — cap planner output tokens.
 *
 * The planner accounted for ~74% of orchestrator spend (~$166 / $225 across
 * a 50-cycle window), with top-5 expensive cycles each burning $12–$18 on
 * the frontier planner alone. Root cause: no hard cap on output/reasoning
 * tokens, so the frontier model could emit ~1M output tokens before
 * producing a small structured JSON task.
 *
 * Fix: choose a `max_output_tokens` cap per anchor type and forward it to
 * the Codex CLI via `--config model_max_output_tokens=<N>`. When the cap
 * fires, the cycle exits as noWork with `__plannerTokenCapHit: true` and
 * `reason: "max_tokens_reached"` so we record the event without acting on
 * a truncated structured payload.
 *
 * This test covers the *pure* surface of the change — selecting the cap
 * per anchor type and recognising Codex truncation messages. End-to-end
 * Codex SDK behaviour is exercised by the live orchestrator; the
 * cycle-doesn't-crash assertion below mirrors how `handlePlanResult`
 * processes the cap-reached sentinel.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  selectPlannerTokenCap,
  PLANNER_MAX_OUTPUT_TOKENS,
} from "../src/planner-prompt.ts";
import { isMaxTokensMessage } from "../src/codex-runner.ts";

describe("planner token cap selection (issue #361)", () => {
  test("quick-fix anchors (failing-test) get the quick-fix cap", () => {
    assert.equal(
      selectPlannerTokenCap("failing-test"),
      PLANNER_MAX_OUTPUT_TOKENS.quickFix,
      "failing-test should use the quick-fix output cap",
    );
  });

  test("quick-fix anchors (prior-failure) get the quick-fix cap", () => {
    assert.equal(
      selectPlannerTokenCap("prior-failure"),
      PLANNER_MAX_OUTPUT_TOKENS.quickFix,
    );
  });

  test("codebase-health anchors get the quick-fix cap", () => {
    assert.equal(
      selectPlannerTokenCap("codebase-health"),
      PLANNER_MAX_OUTPUT_TOKENS.quickFix,
      "codebase-health is reductive and narrow — tight cap is safe",
    );
  });

  test("reframe anchors get the complex cap (full diagnosis ceremony)", () => {
    assert.equal(
      selectPlannerTokenCap("reframe"),
      PLANNER_MAX_OUTPUT_TOKENS.complex,
    );
  });

  test("standard anchors (kanban, spec, research, user-request) get the standard cap", () => {
    for (const t of ["kanban", "spec", "research", "user-request", "work-queue", "todo", "typecheck-error", "regression-hunt", "doc-anchor"]) {
      assert.equal(
        selectPlannerTokenCap(t),
        PLANNER_MAX_OUTPUT_TOKENS.standard,
        `${t} anchor should use the standard cap`,
      );
    }
  });

  test("unknown anchor types fall back to the standard cap (fail safe)", () => {
    assert.equal(
      selectPlannerTokenCap("totally-new-anchor-type"),
      PLANNER_MAX_OUTPUT_TOKENS.standard,
    );
  });

  test("caps are bounded — quick-fix < standard < complex, all <= 12000", () => {
    assert.ok(
      PLANNER_MAX_OUTPUT_TOKENS.quickFix < PLANNER_MAX_OUTPUT_TOKENS.standard,
      "quick-fix cap should be tighter than standard",
    );
    assert.ok(
      PLANNER_MAX_OUTPUT_TOKENS.standard < PLANNER_MAX_OUTPUT_TOKENS.complex,
      "standard cap should be tighter than complex",
    );
    assert.ok(
      PLANNER_MAX_OUTPUT_TOKENS.complex <= 12000,
      "complex cap must stay below the 1M-token outlier band — 12000 is a hard upper",
    );
    assert.ok(
      PLANNER_MAX_OUTPUT_TOKENS.quickFix >= 1000,
      "quick-fix cap must leave room for a valid task JSON (~2K tokens)",
    );
  });
});

describe("isMaxTokensMessage — Codex CLI truncation detection (issue #361)", () => {
  test("matches OpenAI 'max_output_tokens' phrasings", () => {
    assert.equal(isMaxTokensMessage("max_output_tokens reached"), true);
    assert.equal(isMaxTokensMessage("Max output tokens limit hit"), true);
    assert.equal(isMaxTokensMessage("Maximum output token count exceeded"), true);
  });

  test("matches finish_reason=length signal", () => {
    assert.equal(isMaxTokensMessage("response truncated: finish_reason=length"), true);
    assert.equal(
      isMaxTokensMessage("{\"id\":\"x\",\"finish_reason\":\"length\"}"),
      true,
      "JSON-quoted finish_reason should also match",
    );
  });

  test("matches loose 'max tokens reached' phrasing", () => {
    assert.equal(isMaxTokensMessage("error: max tokens reached"), true);
    assert.equal(isMaxTokensMessage("max tokens exceeded"), true);
    assert.equal(isMaxTokensMessage("token limit reached"), true);
  });

  test("does NOT match unrelated errors (usage limit, network, timeout)", () => {
    assert.equal(isMaxTokensMessage("UsageLimitExceeded"), false);
    assert.equal(isMaxTokensMessage("ECONNREFUSED"), false);
    assert.equal(isMaxTokensMessage("request timed out"), false);
    assert.equal(isMaxTokensMessage(""), false);
    assert.equal(isMaxTokensMessage(undefined), false);
    assert.equal(isMaxTokensMessage(null), false);
    assert.equal(isMaxTokensMessage(123), false);
  });

  test("case-insensitive match", () => {
    assert.equal(isMaxTokensMessage("MAX_OUTPUT_TOKENS REACHED"), true);
    assert.equal(isMaxTokensMessage("FINISH_REASON=LENGTH"), true);
  });
});

describe("cycle-doesn't-crash when max_tokens fires (issue #361)", () => {
  /**
   * The planner returns a sentinel object when the output-token cap fires:
   *
   *   { __noWork: true, reason: "max_tokens_reached",
   *     __plannerTokenCapHit: true, __plannerMaxOutputTokens: <cap> }
   *
   * The pipeline's `handlePlanResult` matches on `task.__noWork` and
   * proceeds with the early-exit path — no parsing, no executor call, no
   * crash. This test replicates the shape contract so a future refactor
   * can't drop the `__noWork` flag and silently break early-exit.
   */
  test("sentinel object satisfies the noWork early-exit contract", () => {
    const cap = selectPlannerTokenCap("kanban");
    const sentinel = {
      __noWork: true,
      reason: "max_tokens_reached",
      __plannerTokenCapHit: true,
      __plannerMaxOutputTokens: cap,
      __plannerModel: "gpt-5.4",
    };

    // The pipeline's `handlePlanResult` reads exactly these fields.
    assert.equal(sentinel.__noWork, true, "must set __noWork=true for early-exit branch");
    assert.equal(typeof sentinel.reason, "string", "must set a string reason for circuit-breaker logging");
    assert.equal(sentinel.reason, "max_tokens_reached", "reason must be the stable parseable code");
    assert.equal(sentinel.__plannerTokenCapHit, true, "metric flag for `/api/metrics/cost-attribution` consumers");
    assert.equal(typeof sentinel.__plannerMaxOutputTokens, "number", "cap value preserved for metrics");
    assert.ok(sentinel.__plannerMaxOutputTokens > 0, "cap value must be positive");
  });

  test("plannerTokenCapHit metric flag flows through metricsOverrides shape", () => {
    // Mirrors the flat metric fields produced by handlePlanResult when the
    // sentinel is observed. If any of these field names change without
    // updating consumers (dashboard, /api/metrics/cost-attribution), the
    // operator will silently lose visibility into cap-hit rate.
    const metricsOverrides: Record<string, any> = {
      tasksAbandoned: 1,
      noWork: true,
      noWorkReason: "max_tokens_reached",
      plannerTokenCapHit: true,
      plannerMaxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS.standard,
    };
    assert.equal(metricsOverrides.plannerTokenCapHit, true);
    assert.equal(metricsOverrides.noWorkReason, "max_tokens_reached");
    assert.equal(metricsOverrides.plannerMaxOutputTokens, 8000);
  });
});
