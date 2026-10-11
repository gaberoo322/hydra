/**
 * Autopilot-state fixture helper for the Turn Snapshot (ADR-0043 Decision 5,
 * issue #4934).
 *
 * decide.py reads every collector-produced signal from `state.turn_snapshot`
 * through scripts/autopilot/turn_snapshot.py — there is no `state.signals`
 * form any more, and a state WITHOUT a usable snapshot reads as the
 * all-degraded one (health_fail, every producer cap saturated). Tests that
 * author a handful of signals therefore wrap them in a v1 snapshot here.
 *
 * Signal values may be written in their typed JSON form or in the wire form
 * signal EVENTS carry (`"4801 4802"` lists, `issue-N:PR:branch` pins,
 * `pr:issue|none` dirty-surface tokens) — the accessor parses both. The one
 * exception is an anchor (`orch_pending_grill_anchor`, `orch_dev_ready_anchor`,
 * `wayfinder_orch_frontier`, `tickets_orch_pending_spec`), which the snapshot
 * holds only as an int: `"issue-N"` is converted to `N`, and `"none"` / `""`
 * to `null`, so tests can keep the Anchor reference spelling.
 */

const ANCHORS = new Set(["orch_pending_grill_anchor", "orch_dev_ready_anchor", "wayfinder_orch_frontier", "tickets_orch_pending_spec", "orch_dev_resume_nopr_pick"]);

function anchorValue(name: string, raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const s = raw.trim();
  if (s === "" || s === "none") return null;
  const m = /^issue-([1-9]\d*)$/.exec(s);
  if (m) return Number(m[1]);
  throw new Error(`turn-snapshot fixture: ${name}=${JSON.stringify(raw)} is not an issue-N anchor`);
}

/** A v1 Turn Snapshot carrying exactly `signals` (no blobs: the state's blob fields are read instead). */
export function turnSnapshot(signals: Record<string, unknown> = {}): Record<string, unknown> {
  const typed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(signals)) typed[name] = ANCHORS.has(name) ? anchorValue(name, value) : value;
  return { schema_version: 1, generated_at: "test-fixture", signals: typed, blobs: {}, degraded: [], validation: { ok: true } };
}

/**
 * `state` with its `signals` (if any) moved into `state.turn_snapshot` — the
 * write-boundary wrap for a test that authors signals the old way. A state
 * that already carries a `turn_snapshot` (and no `signals`), or that is not
 * an object at all, is returned unchanged. Other fields are untouched.
 */
export function withTurnSnapshot<T>(state: T): T {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return state;
  const s = state as Record<string, unknown>;
  if (!("signals" in s) && "turn_snapshot" in s) return state;
  const { signals, ...rest } = s;
  const sig = signals && typeof signals === "object" && !Array.isArray(signals) ? (signals as Record<string, unknown>) : {};
  return { ...rest, turn_snapshot: turnSnapshot(sig) } as T;
}
