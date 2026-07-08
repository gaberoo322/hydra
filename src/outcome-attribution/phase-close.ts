/**
 * Outcome-attribution CLOSE phase (issue #3001, epic #2628). Extracted from the
 * former monolithic `subscribe.ts` chore coordinator as a focused single-concept
 * leaf.
 *
 * ## What this phase does
 *
 * CLOSE — for every OPEN window whose `closesAt` has elapsed, re-sample the
 * leading outcomes and append ONE observation row via the #2629 recorder
 * (`recordWindow`), then remove the window. Each metric closes on its own
 * duration (fast metric ≠ slow metric).
 *
 * The dark-metric skip (null baseline OR null current ⇒ NO row, never a
 * synthetic zero) is carried by the #2629 `recordWindow` this phase delegates
 * to, unchanged by the split. FAIL-LOUD is preserved: every failure
 * `console.error`'s with the `[attribution]` prefix and increments
 * `result.errors`; the phase never throws.
 */

import {
  type LeadingOutcomeSample,
} from "../outcome-regression.ts";
import {
  recordWindow,
  type WindowContext,
} from "./recorder.ts";
import {
  type AttributionLedger,
} from "../redis/attribution-ledger.ts";
import {
  listOpenWindows,
  closeWindow,
  type AttributionWindow,
} from "../redis/attribution-windows.ts";
import { dueWindows } from "./windows.ts";
import type { AttributionRecordResult } from "./subscribe.ts";

/** Context for the CLOSE phase ({@link closeDueWindows}). */
export interface CloseWindowsCtx {
  ledger: AttributionLedger;
  snapshot: (filePath?: string) => Promise<LeadingOutcomeSample[]>;
  listWindowsFn: typeof listOpenWindows;
  closeWindowFn: typeof closeWindow;
  outcomesFile: string;
  nowMs: number;
  result: AttributionRecordResult;
}

/** Per-window slice of {@link CloseWindowsCtx} used by {@link closeOneWindow}. */
type CloseOneWindowCtx = Pick<
  CloseWindowsCtx,
  "ledger" | "closeWindowFn" | "nowMs" | "result"
>;

export async function closeDueWindows(ctx: CloseWindowsCtx): Promise<void> {
  const openListed = await ctx.listWindowsFn();
  if (openListed.ok === false) {
    console.error(`[attribution] record: listOpenWindows failed (close phase): ${openListed.error}`);
    ctx.result.errors += 1;
    return;
  }

  const { due } = dueWindows(openListed.windows, ctx.nowMs);
  if (due.length === 0) return;

  // Re-sample once for this pass — all due windows close against the same
  // current snapshot (each compares to its OWN persisted baseline).
  let current: LeadingOutcomeSample[];
  try {
    current = await ctx.snapshot(ctx.outcomesFile);
  } catch (err: any) {
    console.error(
      `[attribution] record: snapshot (current) threw during close: ${err?.message || String(err)}`,
    );
    ctx.result.errors += 1;
    return;
  }
  const currentByName = new Map(current.map((c) => [c.name, c.value]));

  for (const window of due) {
    await closeOneWindow(window, currentByName, ctx);
  }
}

async function closeOneWindow(
  window: AttributionWindow,
  currentByName: Map<string, number | null>,
  ctx: CloseOneWindowCtx,
): Promise<void> {
  const curValue = currentByName.has(window.metric)
    ? currentByName.get(window.metric)!
    : null;

  // Reuse the #2629 recorder policy: it derives the raw row (dark-metric skip,
  // raw delta, no write-time split). We pass a single-metric baseline/current
  // pair so recordWindow handles exactly this window's metric. Attach the
  // merge-identity so a later revert can void this row.
  const baselineSample: LeadingOutcomeSample = {
    name: window.metric,
    // direction/noiseEpsilon are unused by recordWindow (it derives a raw delta,
    // not a regression decision) — carry safe defaults.
    direction: "up",
    noiseEpsilon: 0,
    value: window.baselineValue,
  };
  const winCtx: WindowContext = {
    classCounts: window.classCounts,
    scopeTouched: window.scopeTouched,
    tier: window.tier,
  };

  const rec = await recordWindow(
    ledgerWithIdentity(ctx.ledger, window),
    [baselineSample],
    [{ name: window.metric, value: curValue }],
    winCtx,
    ctx.nowMs,
  );

  if (rec.errors.length > 0) {
    for (const e of rec.errors) console.error(`[attribution] record: append failed for ${window.id}: ${e}`);
    ctx.result.errors += rec.errors.length;
    // Leave the window open so a later tick retries the append (idempotency is
    // by merge-identity at the estimator; a rare double-append is tolerable and
    // preferable to silently losing the row).
    return;
  }

  ctx.result.rowsAppended += rec.appended.length;
  ctx.result.windowsClosed += 1;
  await ctx.closeWindowFn(window.id);
}

/**
 * Wrap a ledger so each observation it appends carries this window's
 * merge-identity (`sourcePrNumbers`/`sourceCommitSha`). Keeps the #2629
 * `recordWindow` signature untouched — it appends whatever `WindowContext`
 * produces, and this wrapper enriches the row on the way through.
 */
function ledgerWithIdentity(ledger: AttributionLedger, window: AttributionWindow): AttributionLedger {
  return {
    getObservations: ledger.getObservations.bind(ledger),
    appendVoidMarker: ledger.appendVoidMarker.bind(ledger),
    appendObservation: (obs) =>
      ledger.appendObservation({
        ...obs,
        sourcePrNumbers: [...window.sourcePrNumbers],
        sourceCommitSha: window.sourceCommitSha,
      }),
  };
}
