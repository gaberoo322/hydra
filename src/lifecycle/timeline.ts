/**
 * Pure timeline readers for the reconcile pass (ADR-0047 D1/D5, issue #5316).
 *
 * The lazy fallback reader the seam and the reconcile share: given the issue's
 * `labeled` / `unlabeled` events (the same {@link TimelineLabelEvent} shape
 * `fetchLabelTimeline` returns for the cap check) it replays the state-label
 * set over time and names every state move that happened AFTER the journal's
 * last known state. No I/O: the fetch lives behind `SeamDeps.fetch.timeline`.
 */
import type { LifecycleJournalEntry } from "../redis/lifecycle-journal.ts";
import type { TimelineLabelEvent } from "./caps.ts";
import { OPEN_STATES } from "./transitions.ts";

/**
 * The journal's notion of the issue's current state: the `to` of the latest
 * entry that is `written` and has a non-null `to`. Null when no entry carries
 * state (ADR-0047 D5: an empty journal is never bulk-rebuilt from GitHub).
 */
export function lastKnownState(entries: readonly LifecycleJournalEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.written === true && typeof e.to === "string" && e.to !== "") return e.to;
  }
  return null;
}

/** One replayed point in time at which the issue's state-label set changed. */
export interface StateSnapshot {
  tsMs: number;
  /** The state labels present after this instant, in OPEN_STATES order. */
  states: string[];
}

/**
 * Replay label events into state-label snapshots. Events sharing one timestamp
 * (one `gh issue edit` removing and adding labels) collapse into one snapshot.
 * Non-state labels are ignored. A snapshot is emitted only when the set changed.
 */
export function replayStateSnapshots(events: readonly TimelineLabelEvent[]): StateSnapshot[] {
  const isState = (l: string): boolean => (OPEN_STATES as readonly string[]).includes(l);
  const sorted = events.filter((e) => isState(e.label)).sort((a, b) => a.tsMs - b.tsMs);
  const current = new Set<string>();
  const out: StateSnapshot[] = [];
  let i = 0;
  while (i < sorted.length) {
    const ts = sorted[i].tsMs;
    const before = [...current].sort().join(",");
    while (i < sorted.length && sorted[i].tsMs === ts) {
      if (sorted[i].event === "labeled") current.add(sorted[i].label);
      else current.delete(sorted[i].label);
      i++;
    }
    if ([...current].sort().join(",") !== before) {
      out.push({ tsMs: ts, states: OPEN_STATES.filter((s) => current.has(s)) });
    }
  }
  return out;
}

/** One out-of-seam state move recovered from the timeline. */
export interface ExternalMove {
  tsMs: number;
  from: string;
  to: string;
}

/**
 * State moves that happened after the journal's `lastState`, oldest first. The
 * anchor is the LAST snapshot whose single state equals `lastState`; every later
 * single-state snapshot is one move. When no snapshot matches the anchor, ONE
 * move `lastState -> <current single state>` stands in (the timeline cannot say
 * how it got there). Snapshots with zero or 2+ state labels are not moves: the
 * invalid / zero-state paths own them.
 */
export function externalMoves(
  events: readonly TimelineLabelEvent[],
  lastState: string,
  currentState: string,
): ExternalMove[] {
  const snaps = replayStateSnapshots(events);
  let anchor = -1;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].states.length === 1 && snaps[i].states[0] === lastState) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) {
    const last = snaps.length > 0 ? snaps[snaps.length - 1].tsMs : 0;
    return lastState === currentState ? [] : [{ tsMs: last, from: lastState, to: currentState }];
  }
  const moves: ExternalMove[] = [];
  let prev = lastState;
  for (let i = anchor + 1; i < snaps.length; i++) {
    if (snaps[i].states.length !== 1) continue;
    const to = snaps[i].states[0];
    if (to === prev) continue;
    moves.push({ tsMs: snaps[i].tsMs, from: prev, to });
    prev = to;
  }
  if (prev !== currentState) {
    moves.push({ tsMs: snaps[snaps.length - 1].tsMs, from: prev, to: currentState });
  }
  return moves;
}
