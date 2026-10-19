/**
 * test/stale-chunk-reload.test.mts — dashboard recovery from lazy chunks a
 * redeploy deleted ("Failed to fetch dynamically imported module" on /docs).
 *
 * dashboard/src/lib/stale-chunk-reload.ts is DOM-free behind an injected env,
 * so it is pinned here in the orchestrator suite — same pattern as
 * display-format.test.mts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStaleChunkError,
  reloadForStaleChunk,
  staleReloadTriggered,
  RELOAD_KEY,
  RELOAD_COOLDOWN_MS,
} from "../dashboard/src/lib/stale-chunk-reload.ts";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

test("isStaleChunkError: matches each browser's failed-dynamic-import message", () => {
  assert.ok(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/3-43NAY2Xd.js")));
  assert.ok(isStaleChunkError(new TypeError("error loading dynamically imported module: https://x/assets/a.js")));
  assert.ok(isStaleChunkError(new TypeError("Importing a module script failed.")));
  assert.ok(isStaleChunkError(new Error("Unable to preload CSS for /assets/a.css")));
  assert.ok(isStaleChunkError("Failed to fetch dynamically imported module: x"));
});

test("isStaleChunkError: ignores unrelated errors", () => {
  assert.equal(isStaleChunkError(new TypeError("Cannot read properties of undefined")), false);
  assert.equal(isStaleChunkError(null), false);
  assert.equal(isStaleChunkError(undefined), false);
});

test("reloadForStaleChunk: refuses inside the cooldown so a broken build cannot loop", () => {
  const now = 1_000_000;
  const storage = memoryStorage({ [RELOAD_KEY]: String(now - RELOAD_COOLDOWN_MS + 1) });
  let reloads = 0;
  assert.equal(reloadForStaleChunk({ storage, now: () => now, reload: () => reloads++ }), false);
  assert.equal(reloads, 0);
});

test("reloadForStaleChunk: refuses when the guard cannot be written", () => {
  let reloads = 0;
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(reloadForStaleChunk({ storage, now: () => 5, reload: () => reloads++ }), false);
  assert.equal(reloads, 0);
});

test("reloadForStaleChunk: reloads once the cooldown has passed and stamps the guard", () => {
  const now = 2_000_000;
  const storage = memoryStorage({ [RELOAD_KEY]: String(now - RELOAD_COOLDOWN_MS) });
  let reloads = 0;
  assert.equal(staleReloadTriggered(), false);
  assert.equal(reloadForStaleChunk({ storage, now: () => now, reload: () => reloads++ }), true);
  assert.equal(reloads, 1);
  assert.equal(storage.map.get(RELOAD_KEY), String(now));
  assert.equal(staleReloadTriggered(), true);
});

test("reloadForStaleChunk: refuses without sessionStorage (no loop guard)", () => {
  let reloads = 0;
  assert.equal(reloadForStaleChunk({ storage: null, now: () => 5, reload: () => reloads++ }), false);
  assert.equal(reloads, 0);
});
