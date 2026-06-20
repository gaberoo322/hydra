/**
 * Recommendation prompt grammar (issue #2240).
 *
 * Extracted from `src/autopilot/recommendation-engine.ts` — the two pure,
 * side-effect-free halves of the recs engine's grammar: the prompt builder
 * (`buildPrompt`) and the response parser (`parseLlmResponse`). Mirrors the
 * `digest.ts` / `digest-format.ts` split: the engine factory composes Redis
 * reads, the LLM client, daily-spend accounting and the cool-down/dedup
 * policy; this Module owns ONLY the template-and-parse grammar.
 *
 * Everything here is pure: no Redis, no network, no clock, no import-time
 * side effects. `buildPrompt` is a total function of an `EnginePromptInput`
 * literal; `parseLlmResponse` is a total function of a raw completion string
 * plus the engine-derived stamping context. That lets a future promptfoo A/B
 * eval (CONTEXT.md / `evals/`) import `buildPrompt` without standing up the
 * engine fixture, and lets the JSON-schema parser be exercised at its own
 * named seam.
 *
 * Type home stays in `recommendation-engine.ts` (mirroring the materiality
 * split, issue #1986): the public `EnginePromptInput` / `Recommendation`
 * types are imported here, not re-declared.
 */

import type { EnginePromptInput, Recommendation } from "./recommendation-engine.ts";

/**
 * Prompt-size budget in bytes. The "small prompt" AC is that the engine
 * never has to truncate at the call site — `buildPrompt` is bounded by
 * construction (turn/wait/slot/signal clipping), so any reasonable input
 * produces a prompt at or under this budget. Tests assert it.
 */
export const PROMPT_SIZE_BUDGET_BYTES = 4 * 1024;

/** Hard ceiling on recommendations stamped per LLM call. */
export const MAX_RECS_PER_CALL = 3;

/**
 * Build the prompt text that the LLM receives. The whole point of the
 * "small prompt" AC is that the engine never has to truncate at the
 * call site — the prompt is bounded by construction. We:
 *
 *   - keep at most 3 recent turns (older context is in past recs)
 *   - keep at most 5 recent permission-waits (older waits resolved or are stale)
 *   - keep the slot snapshot to one line per slot
 *   - emit signals as `key=value` lines with values clipped to 80 chars
 *
 * Tests assert that any reasonable input produces a prompt ≤ 4KB.
 */
export function buildPrompt(input: EnginePromptInput): string {
  const lines: string[] = [];
  lines.push(
    "You are Oak, the autopilot observability assistant. Given the latest" +
      " autopilot turn-end snapshot, emit 1-3 short recommendations for the" +
      " operator. Each recommendation MUST be a single English sentence.",
  );
  lines.push("");
  lines.push(`# Turn ${input.turn_end.turn_n} (run ${input.turn_end.run_id})`);
  lines.push(
    `dispatches=${input.turn_end.dispatches} skipped=${input.turn_end.skipped}` +
      ` idle=${input.turn_end.idle} tokens=${input.turn_end.tokens_after}` +
      ` daily_spend_usd=${input.daily_spend_usd.toFixed(4)}`,
  );

  lines.push("");
  lines.push("# Recent turns (newest first)");
  for (const t of input.recent_turns.slice(0, 3)) {
    lines.push(
      `- turn_n=${t.turn_n} dispatches=${t.dispatches} skipped=${t.skipped}` +
        ` idle=${t.idle} ts_epoch=${t.ts_epoch}`,
    );
  }

  lines.push("");
  lines.push("# Slot snapshot");
  const slotEntries = Object.entries(input.slot_snapshot).slice(0, 12);
  for (const [slot, info] of slotEntries) {
    const since = info?.since_epoch ? ` since=${info.since_epoch}` : "";
    lines.push(`- ${slot}: ${info?.status ?? "?"}${since}`);
  }

  lines.push("");
  lines.push("# Signals");
  const signalEntries = Object.entries(input.signals_snapshot).slice(0, 12);
  for (const [k, v] of signalEntries) {
    const valStr = typeof v === "string" ? v : JSON.stringify(v);
    const clipped = valStr.length > 80 ? `${valStr.slice(0, 77)}...` : valStr;
    lines.push(`- ${k}=${clipped}`);
  }

  lines.push("");
  lines.push("# Recent permission-waits");
  for (const e of input.recent_permission_waits.slice(0, 5)) {
    const tool = e.tool ? ` tool=${e.tool}` : "";
    lines.push(`- ${e.slot} at ${e.ts_epoch}${tool}`);
  }

  lines.push("");
  lines.push(
    "Respond with a single JSON object: {\"recommendations\":[{\"severity\":" +
      "\"info|warn|critical\", \"message\":\"...\"} ...]}." +
      " Emit 1-3 recommendations. Keep each message under 140 characters.",
  );

  return lines.join("\n");
}

/**
 * Parse the LLM's JSON response into typed Recommendations. The LLM is
 * told to return `{recommendations: [...]}`; we extract that array, take
 * the first 3, and stamp ids/timestamps/evidence_id from the engine's
 * authoritative context. A malformed response yields an empty array (the
 * engine still charges the spend for the call — that's a defect on the
 * model side, not ours).
 *
 * `evidenceId` is the engine-derived evidence handle — typically the
 * turn_n of the triggering turn so the UI can link back to the journal row.
 */
export function parseLlmResponse(input: {
  rawJsonText: string;
  runId: string;
  evidenceId: string;
  nowIso: string;
  turnN: number;
}): Recommendation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawJsonText);
  } catch {
    /* intentional: malformed JSON returns empty recommendations */
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const recs = (parsed as any).recommendations;
  if (!Array.isArray(recs)) return [];

  const out: Recommendation[] = [];
  for (let i = 0; i < recs.length && out.length < MAX_RECS_PER_CALL; i++) {
    const raw = recs[i];
    if (!raw || typeof raw !== "object") continue;
    const severity = String(raw.severity ?? "info");
    if (severity !== "info" && severity !== "warn" && severity !== "critical") {
      continue;
    }
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    if (!message) continue;
    // Stable id: run + turn + index — retries collapse cleanly.
    const id = `${input.runId}:${input.turnN}:${i}`;
    out.push({
      id,
      severity,
      message: message.slice(0, 200),
      evidence_id: input.evidenceId,
      run_id: input.runId,
      created_at: input.nowIso,
    });
  }
  return out;
}
