/**
 * Re-read waiters — the framework-free core of a CHECKED refresh (issue
 * #4629 review follow-up; ADR-0034 §7 "no action may render success it has
 * not verified").
 *
 * `useApi().refresh` swallows its error into hook state and resolves
 * `undefined`, so awaiting it cannot tell a write's caller whether the
 * follow-up read succeeded — and useApi.js is fenced (#4629 INV-15). This is
 * the AttentionFeed `refreshChecked` waiter pattern, extracted so a page can
 * resolve a real verdict without widening useApi:
 *
 *   - `wait(refresh)` queues a waiter BEFORE calling `refresh()`, and
 *     resolves once the owner reports the read settled;
 *   - `settle(ok)` (the owner's effect, on a render where the read is no
 *     longer loading) resolves every queued waiter with `ok` — true when that
 *     render carries no read error, false when it does;
 *   - `close()` (unmount) resolves every waiter `false` and makes later
 *     `wait()`s resolve `false` immediately, so a caller never hangs on a
 *     read nothing will settle; `open()` (mount) re-arms it, so a StrictMode
 *     mount → unmount → mount cycle does not leave it closed.
 *
 * Unit-tested with node:test (test/operator-actions-affordance.test.mts).
 */

export interface RereadWaiters {
  /** Queue a waiter, start the read, resolve with the read's verdict. */
  wait(refresh: () => unknown): Promise<boolean>;
  /** Resolve every queued waiter with `ok`. No-op when none are queued. */
  settle(ok: boolean): void;
  /** Mount: accept waiters. */
  open(): void;
  /** Unmount: resolve every waiter `false`; later waits resolve `false`. */
  close(): void;
  /** How many waiters are queued (test seam). */
  pending(): number;
}

export function createRereadWaiters(): RereadWaiters {
  let waiters: Array<(ok: boolean) => void> = [];
  let closed = false;

  function drain(ok: boolean): void {
    const queued = waiters;
    waiters = [];
    for (const resolve of queued) resolve(ok);
  }

  return {
    wait(refresh) {
      if (closed) return Promise.resolve(false);
      const settled = new Promise<boolean>((resolve) => waiters.push(resolve));
      try {
        refresh();
      } catch (err) {
        console.error("[reread] refresh threw synchronously — re-read FAILED", err);
        drain(false);
      }
      return settled;
    },
    settle(ok) {
      drain(ok === true);
    },
    open() {
      closed = false;
    },
    close() {
      closed = true;
      drain(false);
    },
    pending() {
      return waiters.length;
    },
  };
}
