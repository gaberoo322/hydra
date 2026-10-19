/**
 * stale-chunk-reload.ts — recover a long-lived dashboard tab after a deploy.
 *
 * Every master merge redeploys and `vite build` empties `dist/assets/`, so a
 * tab loaded before the deploy still holds an index chunk whose lazy imports
 * (the per-doc `virtual:hydra-docs/doc/<n>` chunks) name hashed files that no
 * longer exist. The import 404s and the page shows "Failed to fetch dynamically
 * imported module". The fix is the one Vite documents: listen for
 * `vite:preloadError` (its `__vitePreload` wrapper dispatches it for both
 * preload and import failures) and reload once to pick up the new index.
 *
 * The reload is guarded by a sessionStorage timestamp: a chunk that is still
 * missing right after a reload is a genuinely broken build, not a stale tab,
 * so we stop and let the caller surface the error instead of looping.
 */

export const RELOAD_KEY = "hydra:stale-chunk-reload-at";
export const RELOAD_COOLDOWN_MS = 10_000;

// Chrome / Firefox / Safari phrasings of a failed dynamic import, plus Vite's
// own CSS-preload failure.
const STALE_CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

export function isStaleChunkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return STALE_CHUNK_PATTERNS.some((re) => re.test(message));
}

export interface ReloadEnv {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now: () => number;
  reload: () => void;
}

let reloadTriggered = false;

/** True once this tab has started a stale-chunk reload. */
export function staleReloadTriggered(): boolean {
  return reloadTriggered;
}

/**
 * Reload the page unless one already happened within the cooldown.
 * Returns whether a reload was started.
 */
export function reloadForStaleChunk(env: ReloadEnv): boolean {
  // No storage means no loop guard; refuse rather than risk reloading forever.
  if (!env.storage) return false;
  const now = env.now();
  let last = 0;
  try {
    last = Number(env.storage.getItem(RELOAD_KEY)) || 0;
  } catch (err) {
    console.error("[stale-chunk-reload] sessionStorage read failed", err);
  }
  if (now - last < RELOAD_COOLDOWN_MS) return false;
  try {
    env.storage.setItem(RELOAD_KEY, String(now));
  } catch (err) {
    // Without the guard a broken build could loop; refuse rather than risk it.
    console.error("[stale-chunk-reload] sessionStorage write failed; not reloading", err);
    return false;
  }
  reloadTriggered = true;
  env.reload();
  return true;
}

function browserEnv(win: Window): ReloadEnv {
  let storage: Storage | null = null;
  try {
    storage = win.sessionStorage;
  } catch (err) {
    console.error("[stale-chunk-reload] sessionStorage unavailable", err);
  }
  return { storage, now: () => Date.now(), reload: () => win.location.reload() };
}

/** Install the `vite:preloadError` listener. Call once at startup. */
export function installStaleChunkReload(win: Window = window): void {
  win.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    console.warn("[stale-chunk-reload] lazy chunk failed to load; reloading for the current build", payload);
    reloadForStaleChunk(browserEnv(win));
  });
}
