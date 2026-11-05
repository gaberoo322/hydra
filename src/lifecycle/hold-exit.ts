/**
 * Unsanctioned human-hold exit predicate (ADR-0047 Decision 3, issue #5313).
 *
 * Pure: no I/O. The operator's sanctioned path out of a human-hold state is the
 * board route (`source: "operator-route"`); an exit journaled from any other
 * source is surfaced on the attention feed (`waiting-on-you:hold-exit`).
 */
import type { LifecycleJournalEntry } from "../redis/lifecycle-journal.ts";
import { isHumanHold } from "./transitions.ts";

/** How far back the attention line looks for an unsanctioned hold exit. */
export const HOLD_EXIT_ALERT_WINDOW_DAYS = 7;

/**
 * True iff the entry records a WRITTEN transition (or external observation)
 * that left a human-hold state via anything other than the operator route.
 * `cli` and `workflow` count too: cli exits are refused by construction, so a
 * cli hit means a seam bug.
 */
export function isUnsanctionedHoldExit(
  entry: Pick<LifecycleJournalEntry, "kind" | "written" | "source" | "from" | "to">,
): boolean {
  // A shadow-mode write is journaled `refused` yet really moved the labels.
  const wroteLabels = entry.kind === "transition" || entry.kind === "external" || entry.kind === "refused";
  if (!wroteLabels) return false;
  if (entry.written !== true) return false;
  if (entry.source === "operator-route") return false;
  if (entry.from === null) return false;
  return entry.from
    .split(",")
    .some((state) => isHumanHold(state) && state !== entry.to);
}
