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
 *   - `wait(refresh)` queues a waiter and resolves it once a read that
 *     STARTED AFTER the waiter was queued settles (#5162). If the owner last
 *     reported a read in flight (loading=true), that read began before the
 *     write's waiter and its verdict says nothing about the write, so the
 *     core DEFERS `refresh()` until that read settles, then starts the checked
 *     read and arms the waiter on it. It never counts settles or guesses which
 *     fetch finished: with useApi.js fenced, the loading edge is the only
 *     honest signal, and a deferred read always yields a fresh true -> false
 *     edge;
 *   - `observe(loading, ok)` (the owner's effect, on EVERY render where
 *     loading/error/data changed) reports the read state: loading=true marks
 *     a read in flight; loading=false settles armed waiters with `ok` (true
 *     when that render carries no read error) and then starts the deferred
 *     read, if any;
 *   - `close()` (unmount) resolves every armed AND deferred waiter `false`
 *     and makes later `wait()`s resolve `false` immediately, so a caller never
 *     hangs on a read nothing will settle; `open()` (mount) re-arms it, so a
 *     StrictMode mount -> unmount -> mount cycle does not leave it closed.
 *
 * Unit-tested with node:test (test/operator-actions-affordance.test.mts).
 */

export interface RereadWaiters {
  /** Queue a waiter, start (or defer) the read, resolve with the read's verdict. */
  wait(refresh: () => unknown): Promise<boolean>;
  /** Owner report of the read state on every render; see the module header. */
  observe(loading: boolean, ok: boolean): void;
  /** Mount: accept waiters. */
  open(): void;
  /** Unmount: resolve every waiter `false`; later waits resolve `false`. */
  close(): void;
  /** How many waiters are queued, armed or deferred (test seam). */
  pending(): number;
}

interface Deferred {
  resolve: (ok: boolean) => void;
  refresh: () => unknown;
}

export function createRereadWaiters(): RereadWaiters {
  let armed: Array<(ok: boolean) => void> = [];
  let deferred: Deferred[] = [];
  let inFlight = false;
  let closed = false;

  function drainArmed(ok: boolean): void {
    const queued = armed;
    armed = [];
    for (const resolve of queued) resolve(ok);
  }

  // Start the checked read on behalf of `entries`; a synchronous throw
  // resolves them all false (fail loud, never a hang).
  function startRead(entries: Deferred[]): void {
    if (entries.length === 0) return;
    armed.push(...entries.map((e) => e.resolve));
    try {
      entries[0].refresh();
    } catch (err) {
      console.error("[reread] refresh threw synchronously — re-read FAILED", err);
      drainArmed(false);
    }
  }

  return {
    wait(refresh) {
      if (closed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const entry: Deferred = { resolve, refresh };
        if (inFlight) {
          deferred.push(entry);
          return;
        }
        startRead([entry]);
      });
    },
    observe(loading, ok) {
      if (loading) {
        inFlight = true;
        return;
      }
      inFlight = false;
      drainArmed(ok === true);
      const queued = deferred;
      deferred = [];
      startRead(queued);
    },
    open() {
      closed = false;
    },
    close() {
      closed = true;
      inFlight = false; // a remount starts from a clean read state
      drainArmed(false);
      const queued = deferred;
      deferred = [];
      for (const { resolve } of queued) resolve(false);
    },
    pending() {
      return armed.length + deferred.length;
    },
  };
}
