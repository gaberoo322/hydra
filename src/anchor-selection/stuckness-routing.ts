// ---------------------------------------------------------------------------
// Stuckness-driven anchor (issue #253, ADR-0003 vision vector 1)
// ---------------------------------------------------------------------------
//
// When a Target Outcome fires stuckness (no sustained favorable move for N
// cycles), the next anchor must be research into *why* — not another pull
// from the kanban queue. Inserted between (1) explicit operator request and
// (2) kanban queued lane.
//
// Cooldown: once we pick a stuckness anchor for outcome X, we suppress X for
// the next STUCKNESS_COOLDOWN_CYCLES cycles so the research-driven change
// has time to land before we re-pick the same stuck outcome. Cycle-based,
// not wall-clock — orchestrator cycles are highly variable in duration.
//
// We approximate "5 cycles" with a 5 * estimated-cycle-duration TTL. Cycle
// duration varies from ~30s (quick-fix) to ~10min (complex builds); we use
// a conservative 30-minute TTL which is roughly 5 standard cycles. Combined
// with the fact that stuckness itself only fires after N cycles, this gives
// any in-flight research time to take effect.

import { getString, setString } from "../redis-adapter.ts";
import { type StucknessResult } from "../stuckness.ts";
import { STREAMS } from "../event-bus.ts";
import {
  STUCKNESS_COOLDOWN_TTL_SECONDS,
  stucknessCooldownKey,
} from "./constants.ts";

/**
 * Decide which fired-stuckness outcome (if any) should drive the next anchor.
 *
 * Ordering rules per #253 acceptance criteria:
 *   - Leading outcomes win over terminal (terminal is too slow per ADR-0003).
 *   - Within a kind, most-stuck (highest cyclesStuck) wins.
 *   - Tiebreak: lexicographic name.
 *   - Outcomes in cooldown are skipped.
 *
 * Pure with respect to Redis writes: this only READS the cooldown keys; the
 * caller writes the cooldown once it commits to returning the anchor.
 *
 * Returns `null` when nothing fired or every fired outcome is in cooldown.
 */
export async function pickStuckOutcome(
  rows: StucknessResult[],
): Promise<StucknessResult | null> {
  // Filter to fired outcomes and check cooldowns. Skipping a cooled-down
  // outcome lets the fall-through behaviour kick in — the orchestrator
  // resumes pulling other work instead of starving on a single stuck signal.
  const eligible: StucknessResult[] = [];
  for (const row of rows) {
    if (!row.fired) continue;
    try {
      const cooled = await getString(stucknessCooldownKey(row.name));
      if (cooled === "1") {
        console.log(`[AnchorSelection] stuckness: skipping "${row.name}" — in cooldown`);
        continue;
      }
    } catch (err: any) {
      console.error(`[AnchorSelection] stuckness cooldown read failed for '${row.name}': ${err.message}`);
      // Be permissive: if the cooldown check fails, we'd rather act on the
      // signal than swallow it silently.
    }
    eligible.push(row);
  }
  if (eligible.length === 0) return null;

  const sortKey = (a: StucknessResult, b: StucknessResult): number => {
    // Most-stuck first, then lex by name for determinism.
    if (b.cyclesStuck !== a.cyclesStuck) return b.cyclesStuck - a.cyclesStuck;
    return a.name.localeCompare(b.name);
  };

  // Leading preferred over terminal per vision vector 1. "kind" is optional
  // on the type for legacy unknown-outcome rows; we treat missing kind as
  // leading (the common case) to avoid silently de-prioritising a real signal.
  const leading = eligible.filter((r) => (r.kind ?? "leading") === "leading").sort(sortKey);
  if (leading.length > 0) return leading[0];

  const terminal = eligible.filter((r) => r.kind === "terminal").sort(sortKey);
  if (terminal.length > 0) return terminal[0];

  return null;
}

/**
 * Build the research-type anchor for a fired-stuckness outcome and record
 * the cooldown so we don't re-pick the same outcome every cycle.
 *
 * Per #253: anchor.domain = "orchestrator-self-improvement" so when #245
 * (capacity floor) lands, this work counts toward the 25% builder-floor.
 * Per ADR-0005: the autonomous response is research, not operator escalation.
 *
 * Emits `anchor.selected.stuckness` telemetry on the provided event bus.
 */
export async function buildStucknessAnchor(
  row: StucknessResult,
  eventBus: any,
): Promise<any> {
  // Set cooldown FIRST so a transient eventBus failure can't cause us to
  // re-pick the same outcome next cycle.
  try {
    await setString(stucknessCooldownKey(row.name), "1", STUCKNESS_COOLDOWN_TTL_SECONDS);
  } catch (err: any) {
    console.error(`[AnchorSelection] failed to set stuckness cooldown for '${row.name}': ${err.message}`);
    // Continue — the cooldown is a soft guard, not load-bearing.
  }

  const kind = row.kind ?? "leading";
  const terminalNote = kind === "terminal"
    ? " (terminal outcome — calibration cycles are slow, this research may be exploratory)"
    : "";
  const description =
    `Outcome "${row.name}" has not moved favorably for ${row.cyclesStuck} cycles ` +
    `(threshold ${row.threshold}). Vision vector 1: research why this outcome ` +
    `isn't moving before pulling further backlog work.${terminalNote}`;

  console.log(`[AnchorSelection] stuckness anchor: "${row.name}" stuck for ${row.cyclesStuck} cycles (kind: ${kind})`);

  if (eventBus && typeof eventBus.publish === "function") {
    try {
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "anchor.selected.stuckness",
        source: "anchor-selection",
        payload: {
          outcomeName: row.name,
          cycles: row.cyclesStuck,
          threshold: row.threshold,
          kind,
        },
      });
    } catch (err: any) {
      console.error(`[AnchorSelection] failed to emit anchor.selected.stuckness: ${err.message}`);
    }
  }

  return {
    type: "research",
    reference: `outcome-stuckness:${row.name}`,
    domain: "orchestrator-self-improvement",
    priority: 0,
    whyNow:
      `Outcome "${row.name}" stuck for ${row.cyclesStuck}/${row.threshold} cycles ` +
      `(${kind}). Vision vector 1: research the cause before pulling more backlog.`,
    description,
    context: description,
  };
}
