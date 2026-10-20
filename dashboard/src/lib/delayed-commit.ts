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
 *   - `flush()` (the owning component unmounting) COMMITS the pending action
 *     at once — the operator clicked it and only Undo may cancel it, so a
 *     window never silently drops an action the toast promised.
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
