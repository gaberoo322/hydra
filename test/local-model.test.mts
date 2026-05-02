/**
 * Integration tests for the local Ollama model tier.
 *
 * Regression: verifies that runLocalAgent returns the correct shape,
 * isOllamaAvailable caches correctly, and the fallback path works.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test the exported functions directly
import { runLocalAgent, isOllamaAvailable, MODEL_TIERS, MODEL_PRICING } from "../src/codex-runner.ts";

describe("local model tier configuration", () => {
  it("MODEL_TIERS includes local tier", () => {
    assert.equal(MODEL_TIERS.local, "gemma-4-26b");
  });

  it("MODEL_PRICING has zero cost for gemma-4-26b", () => {
    const pricing = MODEL_PRICING["gemma-4-26b"];
    assert.ok(pricing, "gemma-4-26b should have a pricing entry");
    assert.equal(pricing.input, 0);
    assert.equal(pricing.output, 0);
  });
});

describe("runLocalAgent return shape", () => {
  it("returns all expected fields with correct types", async () => {
    // This test hits the real Ollama if available, or verifies error shape if not
    const result = await runLocalAgent({
      agentName: "test-agent",
      personality: null,
      prompt: 'Respond with ONLY: {"findings": []}',
      workDir: null,
      timeout: 30_000,
    });

    // Verify return shape matches runAgent contract
    assert.equal(typeof result.output, "string");
    assert.equal(typeof result.exitCode, "number");
    assert.equal(result.signal, null);
    assert.equal(typeof result.timedOut, "boolean");
    assert.equal(typeof result.timeout, "number");
    assert.equal(result.killSignal, null);
    assert.equal(typeof result.duration, "number");
    assert.deepEqual(typeof result.usage, "object");
    assert.equal(typeof result.usage.inputTokens, "number");
    assert.equal(typeof result.usage.outputTokens, "number");
    assert.equal(typeof result.usage.cachedInputTokens, "number");
    assert.equal(result.costUsd, 0);
    assert.equal(result.model, "gemma-4-26b");
    assert.equal(result.stderr, "");
    assert.equal(result.usageLimitHit, false);
    assert.equal(result.threadReused, false);
    assert.equal(result.promptCacheRate, 0);
  });
});

describe("isOllamaAvailable", () => {
  it("returns a boolean", async () => {
    const result = await isOllamaAvailable();
    assert.equal(typeof result, "boolean");
  });

  it("caches result on repeated calls", async () => {
    const first = await isOllamaAvailable();
    const start = Date.now();
    const second = await isOllamaAvailable();
    const elapsed = Date.now() - start;
    // Second call should be nearly instant (cached)
    assert.equal(first, second);
    assert.ok(elapsed < 100, `Cached call took ${elapsed}ms, expected <100ms`);
  });
});

describe("runLocalAgent JSON parsing (adversarial-style prompt)", () => {
  it("produces parseable JSON output when Ollama is available", async () => {
    const available = await isOllamaAvailable();
    if (!available) {
      // Skip if Ollama is offline — not a failure
      console.log("  [skipped] Ollama not available");
      return;
    }

    const result = await runLocalAgent({
      agentName: "test-adversary",
      personality: null,
      prompt: [
        "You are a code reviewer. Examine this function:",
        "```typescript",
        "function add(a: number, b: number): number { return a + b; }",
        "```",
        "Output ONLY valid JSON:",
        '{ "findings": [{ "file": "math.ts", "issue": "description", "severity": "low" }] }',
        "If no real issues found, output: { \"findings\": [] }",
      ].join("\n"),
      workDir: null,
      timeout: 60_000,
    });

    assert.equal(result.exitCode, 0, "Should succeed");
    assert.ok(result.output.length > 0, "Should produce output");

    // Try to parse the JSON (same logic as adversarial-validation.ts)
    let parsed;
    try {
      parsed = JSON.parse(result.output);
    } catch {
      const match = result.output.match(/\{[\s\S]*\}/);
      assert.ok(match, `Output should contain JSON object, got: ${result.output.slice(0, 200)}`);
      parsed = JSON.parse(match[0]);
    }

    assert.ok(Array.isArray(parsed.findings), "Should have findings array");
  });
});
