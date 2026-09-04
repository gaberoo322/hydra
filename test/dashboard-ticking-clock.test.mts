/**
 * Structural source pins for the extracted ticking-clock hook (issue #4361,
 * design-concept issue-4361, INV-1 through INV-8).
 *
 * The dashboard ships no JSX test runner and the worktree resolves no
 * `react`, so — exactly like test/dashboard-server-confirmed-write.test.mts
 * and test/dashboard-routes.test.mts — the slice is pinned at the boundaries
 * that ARE mechanically checkable:
 *
 *   1. useTickingClock.js is a NEW file exporting exactly one function,
 *      useTickingClock(intervalMs) (INV-1).
 *   2. Its body seeds state lazily, starts exactly one setInterval inside a
 *      useEffect whose callback re-reads Date.now(), clears it on cleanup,
 *      and depends on [intervalMs] only (INV-2).
 *   3. NowConsole.jsx, StatusStrip.jsx and RunHistoryStrip.jsx contain zero
 *      setInterval / clearInterval calls and both StatusStrip.jsx copies
 *      collapse into one call each (INV-3).
 *   4. Each of the four call sites preserves its cadence, passed explicitly
 *      (INV-4).
 *   5. The hook returns a bare millisecond number, never seconds or an
 *      object; the two seconds-consumers derive nowSec locally (INV-5).
 *   6. useApi.js's export list is unchanged (INV-6).
 *   7. No pause-when-hidden / requestAnimationFrame / jitter / drift
 *      correction / fetch-poll migration sneaks into the hook (INV-7).
 *
 * Lifecycle: top-level describes with no shared mutable state and no Redis
 * seam (per the CLAUDE.md shared-teardown authoring rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const USE_TICKING_CLOCK = "../dashboard/src/hooks/useTickingClock.js";
const USE_API = "../dashboard/src/hooks/useApi.js";
const NOW_CONSOLE = "../dashboard/src/pages/now-console/NowConsole.jsx";
const STATUS_STRIP = "../dashboard/src/pages/now-console/StatusStrip.jsx";
const RUN_HISTORY_STRIP = "../dashboard/src/pages/now-console/RunHistoryStrip.jsx";

async function readSource(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/** The function body only — excludes the leading module doc-comment, which
 * legitimately narrates (in English) the same terms ("Math.floor",
 * "visibilitychange") that the negative assertions below must not find in
 * actual CODE. */
function functionBody(src: string): string {
  const start = src.indexOf("export function useTickingClock(");
  assert.ok(start >= 0, "useTickingClock export not found");
  return src.slice(start);
}

// ---------------------------------------------------------------------------
// INV-1 — exactly one export, the hook itself
// ---------------------------------------------------------------------------

describe("useTickingClock.js exports exactly one function (INV-1)", () => {
  test("the module's exports are exactly useTickingClock", async () => {
    const src = await readSource(USE_TICKING_CLOCK);
    const names = Array.from(src.matchAll(/^export (?:async )?function (\w+)/gm), (m) => m[1]);
    assert.doesNotMatch(src, /^export const use\w*/m, "no const-arrow hook exports either");
    assert.deepEqual(
      names,
      ["useTickingClock"],
      "useTickingClock.js must expose exactly one export — this is the sole new owner of the ticking-clock idiom",
    );
  });

  test("the signature is useTickingClock(intervalMs) with no default", async () => {
    const src = await readSource(USE_TICKING_CLOCK);
    assert.match(
      src,
      /export function useTickingClock\(intervalMs\)\s*\{/,
      "no default interval — every call site states its own cadence explicitly",
    );
  });
});

// ---------------------------------------------------------------------------
// INV-2 — the hook's internal shape: lazy seed, one interval, re-read
// Date.now(), cleanup, [intervalMs] deps
// ---------------------------------------------------------------------------

describe("useTickingClock's body matches the extracted idiom exactly (INV-2)", () => {
  test("seeds state lazily from Date.now()", async () => {
    const src = await readSource(USE_TICKING_CLOCK);
    assert.match(src, /useState\(\(\) => Date\.now\(\)\)/, "lazy initializer, not an eager Date.now() call");
  });

  test("starts exactly one setInterval whose callback re-reads Date.now()", async () => {
    const src = await readSource(USE_TICKING_CLOCK);
    assert.equal((src.match(/setInterval\(/g) ?? []).length, 1, "the hook owns exactly one interval");
    assert.match(
      src,
      /setInterval\(\(\) => set\w+\(Date\.now\(\)\), intervalMs\)/,
      "the callback re-reads Date.now() on every tick rather than incrementing the previous value — drift-free",
    );
  });

  test("clears the interval in the effect cleanup", async () => {
    const src = await readSource(USE_TICKING_CLOCK);
    assert.match(src, /return \(\) => clearInterval\(t\)/, "cleanup must clear the interval on unmount");
  });

  test("the effect's only dependency is [intervalMs]", async () => {
    const src = await readSource(USE_TICKING_CLOCK);
    assert.match(src, /\},\s*\[intervalMs\]\)/, "restarts the timer when intervalMs changes, nothing else in deps");
  });

  test("returns the raw millisecond number, not seconds or an object (INV-5)", async () => {
    const body = functionBody(await readSource(USE_TICKING_CLOCK));
    assert.match(body, /return nowMs;/, "the hook's return value is the bare ms number");
    assert.doesNotMatch(body, /Math\.floor/, "no seconds conversion inside the hook itself");
    assert.doesNotMatch(body, /return \{/, "no object wrapper — a bare number only");
  });

  test("adds no behaviour beyond the extracted idiom (INV-7)", async () => {
    const body = functionBody(await readSource(USE_TICKING_CLOCK));
    for (const forbidden of [
      "visibilitychange",
      "requestAnimationFrame",
      "Math.random",
      "jitter",
    ]) {
      assert.ok(!body.includes(forbidden), `useTickingClock must not add ${forbidden} — that is future scope`);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-3 — no more inline copies in the three consumer files
// ---------------------------------------------------------------------------

describe("the four call sites route through the shared hook, not inline copies (INV-3)", () => {
  test("NowConsole.jsx contains zero setInterval/clearInterval and imports the hook", async () => {
    const src = await readSource(NOW_CONSOLE);
    assert.ok(!src.includes("setInterval("), "NowConsole.jsx must not hand-roll an interval anymore");
    assert.ok(!src.includes("clearInterval("), "NowConsole.jsx must not hand-roll cleanup anymore");
    assert.match(src, /import \{ useTickingClock \} from "\.\.\/\.\.\/hooks\/useTickingClock\.js";/);
  });

  test("StatusStrip.jsx's two near-duplicate copies collapse into one call each", async () => {
    const src = await readSource(STATUS_STRIP);
    assert.ok(!src.includes("setInterval("), "StatusStrip.jsx must not hand-roll an interval anymore");
    assert.ok(!src.includes("clearInterval("), "StatusStrip.jsx must not hand-roll cleanup anymore");
    assert.match(src, /import \{ useTickingClock \} from "\.\.\/\.\.\/hooks\/useTickingClock\.js";/);
    assert.equal(
      (src.match(/useTickingClock\(1_000\)/g) ?? []).length,
      2,
      "both widgets call the hook once each — no shared instance across the two components",
    );
  });

  test("RunHistoryStrip.jsx contains zero setInterval/clearInterval and imports the hook", async () => {
    const src = await readSource(RUN_HISTORY_STRIP);
    assert.ok(!src.includes("setInterval("), "RunHistoryStrip.jsx must not hand-roll an interval anymore");
    assert.ok(!src.includes("clearInterval("), "RunHistoryStrip.jsx must not hand-roll cleanup anymore");
    assert.match(src, /import \{ useTickingClock \} from "\.\.\/\.\.\/hooks\/useTickingClock\.js";/);
  });
});

// ---------------------------------------------------------------------------
// INV-4 — cadences preserved exactly per call site
// ---------------------------------------------------------------------------

describe("tick cadences are preserved per call site, passed explicitly (INV-4)", () => {
  test("NowConsole.jsx's TurnJournal ticks at 1_000ms", async () => {
    const src = await readSource(NOW_CONSOLE);
    assert.match(src, /useTickingClock\(1_000\)/, "TurnJournal keeps its 1s cadence");
  });

  test("StatusStrip.jsx's default export and InflightSlotsWidget both tick at 1_000ms", async () => {
    const src = await readSource(STATUS_STRIP);
    assert.equal((src.match(/useTickingClock\(1_000\)/g) ?? []).length, 2);
  });

  test("RunHistoryStrip.jsx ticks at 30_000ms", async () => {
    const src = await readSource(RUN_HISTORY_STRIP);
    assert.match(src, /useTickingClock\(30_000\)/, "RunHistoryStrip keeps its 30s cadence");
  });
});

// ---------------------------------------------------------------------------
// INV-5 — seconds are derived locally at the two seconds-consumers
// ---------------------------------------------------------------------------

describe("seconds-consumers derive nowSec locally with Math.floor (INV-5)", () => {
  test("NowConsole.jsx's TurnJournal derives nowSec from the hook's nowMs", async () => {
    const src = await readSource(NOW_CONSOLE);
    assert.match(src, /const nowMs = useTickingClock\(1_000\);\s*\n\s*const nowSec = Math\.floor\(nowMs \/ 1000\);/);
  });

  test("RunHistoryStrip.jsx derives nowSec from the hook's nowMs", async () => {
    const src = await readSource(RUN_HISTORY_STRIP);
    assert.match(
      src,
      /const nowMs = useTickingClock\(30_000\);\s*\n\s*const nowSec = Math\.floor\(nowMs \/ 1000\);/,
    );
  });

  test("StatusStrip.jsx's widgets stay in milliseconds — no floor needed", async () => {
    const src = await readSource(STATUS_STRIP);
    assert.match(src, /formatNextDispatchCountdown\(data\?\.nextPaceGateCheck, nowMs\)/);
    assert.match(src, /deriveInflightSlots\(data\?\.slots, nowMs\)/);
  });
});

// ---------------------------------------------------------------------------
// INV-6 — useApi.js is untouched
// ---------------------------------------------------------------------------

describe("useApi.js's export list is unchanged (INV-6)", () => {
  test("useApi.js exports exactly apiFetch, useApi, useServerConfirmedWrite", async () => {
    const src = await readSource(USE_API);
    const names = Array.from(src.matchAll(/^export (?:async )?function (\w+)/gm), (m) => m[1]);
    assert.deepEqual(
      names,
      ["apiFetch", "useApi", "useServerConfirmedWrite"],
      "the clock hook is a sibling file, not a fourth export of the fetch seam",
    );
    assert.ok(!src.includes("useTickingClock"), "useApi.js must not reference the clock hook at all");
  });
});

// ---------------------------------------------------------------------------
// Orphaned-import hygiene (INV-8) — dashboard eslint's no-unused-vars is an
// error, so a migrated file must drop useEffect/useState it no longer needs.
// ---------------------------------------------------------------------------

describe("orphaned React imports are swept after migration (INV-8)", () => {
  test("StatusStrip.jsx and RunHistoryStrip.jsx no longer import useEffect or useState", async () => {
    for (const path of [STATUS_STRIP, RUN_HISTORY_STRIP]) {
      const src = await readSource(path);
      const reactImport = src.match(/^import \{([^}]*)\} from "react";/m);
      assert.ok(!reactImport, `${path} should need no bare React import at all after migration`);
    }
  });

  test("NowConsole.jsx keeps useState/useMemo (still used elsewhere) but drops useEffect", async () => {
    const src = await readSource(NOW_CONSOLE);
    const reactImport = src.match(/^import \{([^}]*)\} from "react";/m);
    assert.ok(reactImport, "NowConsole.jsx still imports from react");
    const imported = reactImport![1].split(",").map((s) => s.trim());
    assert.ok(!imported.includes("useEffect"), "useEffect is orphaned once the inline interval is gone");
    assert.ok(imported.includes("useState"), "useState is still used for selectedRunId");
    assert.ok(imported.includes("useMemo"), "useMemo is still used for the turn rows derivation");
  });
});
