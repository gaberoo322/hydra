/**
 * src/llm/pricing.ts — Model pricing table for cost reconciliation.
 *
 * Extracted from the (now deleted) `src/codex-runner.ts` during the codex
 * cut-over (issue #383). The codex CLI integration is gone, but autopilot
 * still tracks per-cycle spend and the reconciliation report needs a
 * lookup table mapping `model` → `(input, output)` USD-per-million-tokens
 * rates. Keep this in sync with `MODEL_NAME_TO_TIER` in
 * `src/cost-attribution.ts` — both tables describe the same set of models
 * from different angles.
 *
 * Rates mirror CLAUDE.md "Model Tiers": frontier (gpt-5.4/5.5), codex
 * (gpt-5.3-codex, the legacy executor tier — still referenced by
 * autopilot subagents that use the same model name), and mini
 * (gpt-5.4-mini). Local Ollama models price at 0.
 */

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-5.5":             { input: 3.00, output: 15.00 },
  "gpt-5.4":             { input: 2.50, output: 15.00 },
  "gpt-5.3-codex":       { input: 1.75, output: 14.00 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14.00 },
  "gpt-5.4-mini":        { input: 0.75, output: 4.50 },
  "gemma-4-26b":         { input: 0, output: 0 },
};
