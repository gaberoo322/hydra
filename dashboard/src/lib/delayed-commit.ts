/**
 * Delayed-commit controller — the framework-free core of the ~5 s undo
 * window behind every immediate-tier action AND the Today feed's typed
 * dismiss (issue #4628, ADR-0034 §7/§8.4; design-concept INV-7/INV-14).
 *
 * No undo/inverse route exists in the registry vocabulary, so "immediate,
 * with undo" is a delayed commit: `start(label, fire)` arms the window,
 * `undo()` cancels before ANY request is sent, expiry fires the captured
 * closure. Extracted from the React hook (useDelayedCommit) so the window's
 * rules are unit-tested behaviourally with fake timers
 * (test/operator-actions-affordance.test.mts) — the dashboard ships no JSX
 * test runner.
 *
 * The rules:
 *   - ONE commit per window. `start()` while a commit is pending is REFUSED
 *     (returns false) — it never flushes or replaces the pending commit, so a
 *     second click can never break the first click's Undo. Callers also
 *     disable their trigger buttons while `pending` is set; the refusal is
 *     the backstop.
 *   - `undo()` cancels the pending commit; nothing fires.
 *   - `flush()` (the owning host unmounting) COMMITS the pending action
 *     at once — the operator clicked it and only Undo may cancel it, so a
 *     window never silently drops an action the toast promised.
 *
 * Hosting (QA round 4, PR #4976): windows are NOT owned by the feed row that
 * started them. `createUndoWindowRegistry` keeps every pending window at
 * FEED level, keyed by a caller-chosen id (one window per id, any number of
 * ids at once), so two concurrent windows are each undoable from their own
 * toast, and a row unmounting on a poll refresh neither commits its window
 * early nor loses its Undo. Only the host (the feed) unmounting flushes.
 */

export const UNDO_WINDOW_MS = 5_000;

export type PendingCommit = { label: string } | null;

export interface DelayedCommitController {
  /** Arm the window. Returns false (and does nothing) when one is pending. */
  start(label: string, fire: () => unknown): boolean;
  /** Cancel the pending commit before anything is sent. */
  undo(): void;
  /** Commit the pending action immediately (unmount). No-op when idle. */
  flush(): void;
  /** The pending commit's toast label, or null when idle. */
  pending(): PendingCommit;
}

export function createDelayedCommit(
  onPendingChange: (pending: PendingCommit) => void,
  delayMs: number = UNDO_WINDOW_MS,
): DelayedCommitController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firePending: (() => unknown) | null = null;
  let current: PendingCommit = null;

  function settle(): (() => unknown) | null {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const fire = firePending;
    firePending = null;
    if (current !== null) {
      current = null;
      onPendingChange(null);
    }
    return fire;
  }

  return {
    start(label, fire) {
      if (firePending !== null) return false;
      firePending = fire;
      current = { label };
      onPendingChange(current);
      timer = setTimeout(() => {
        const due = settle();
        if (due) due();
      }, delayMs);
      return true;
    },
    undo() {
      settle();
    },
    flush() {
      const due = settle();
      if (due) due();
    },
    pending() {
      return current;
    },
  };
}

/** One pending window as the toast stack renders it. */
export type PendingWindow = { id: string; label: string };

export interface UndoWindowRegistry {
  /** Arm the window for `id`. Returns false (and does nothing) when that id
   * already holds a pending commit; other ids are unaffected. */
  start(id: string, label: string, fire: () => unknown): boolean;
  /** Cancel `id`'s pending commit before anything is sent. No-op when idle. */
  undo(id: string): void;
  /** Every pending window, in start order. */
  pending(): PendingWindow[];
  /** Commit every pending window at once (the HOST unmounting — never a row). */
  flushAll(): void;
}

/**
 * The feed-level registry of undo windows: one `createDelayedCommit`
 * controller per pending id. `onChange` receives the full pending list on
 * every arm/settle, so a single toast host renders each window stacked with
 * its own Undo.
 */
export function createUndoWindowRegistry(
  onChange: (windows: PendingWindow[]) => void,
  delayMs: number = UNDO_WINDOW_MS,
): UndoWindowRegistry {
  const windows = new Map<string, { label: string; ctl: DelayedCommitController }>();

  function snapshot(): PendingWindow[] {
    return [...windows].map(([id, w]) => ({ id, label: w.label }));
  }

  return {
    start(id, label, fire) {
      if (windows.has(id)) return false;
      const ctl = createDelayedCommit((p) => {
        // The controller settles (expiry, undo, flush) by emitting null —
        // drop the window from the registry BEFORE its closure fires.
        if (p === null && windows.get(id)?.ctl === ctl) {
          windows.delete(id);
          onChange(snapshot());
        }
      }, delayMs);
      windows.set(id, { label, ctl });
      ctl.start(label, fire);
      onChange(snapshot());
      return true;
    },
    undo(id) {
      windows.get(id)?.ctl.undo();
    },
    pending() {
      return snapshot();
    },
    flushAll() {
      for (const { ctl } of [...windows.values()]) ctl.flush();
    },
  };
}

/** Pure trigger-state rule: a trigger is disabled while its request is in
 * flight OR while its own window holds a pending commit. */
export function triggerDisabled(busy: boolean, windows: PendingWindow[], id: string): boolean {
  return busy || windows.some((w) => w.id === id);
}

/**
 * In-flight request ids (QA round 5, PR #4976). A window's expiry drops it
 * from the registry BEFORE its closure's request settles, so the window alone
 * cannot keep a trigger disabled for the request's lifetime. The feed marks
 * an id in flight when the expired closure starts its request and clears it
 * in that closure's `finally`; the trigger reads `has(id)` as its `busy`
 * input to `triggerDisabled`. `onChange` receives a fresh Set on every
 * change so a React state setter re-renders.
 */
export interface InFlightTracker {
  /** Mark `id` in flight. */
  begin(id: string): void;
  /** Clear `id` (idempotent). */
  end(id: string): void;
  /** Is `id` in flight? */
  has(id: string): boolean;
}

export function createInFlightTracker(onChange: (ids: ReadonlySet<string>) => void): InFlightTracker {
  const ids = new Set<string>();
  return {
    begin(id) {
      if (ids.has(id)) return;
      ids.add(id);
      onChange(new Set(ids));
    },
    end(id) {
      if (!ids.delete(id)) return;
      onChange(new Set(ids));
    },
    has(id) {
      return ids.has(id);
    },
  };
}

/** The toast label's window length, derived from the actual delay so the
 * text can never drift from the timer (e.g. 5000 ms → "5s"). */
export function undoWindowSeconds(delayMs: number = UNDO_WINDOW_MS): string {
  return `${Math.round(delayMs / 1000)}s`;
}
