/**
 * Structural source pins for the extracted server-confirmed write hook
 * (issue #4335, ADR-0034 §7, design-concept d4003bea).
 *
 * The dashboard ships no JSX test runner and the worktree resolves no
 * `react`, so — exactly like test/dashboard-routes.test.mts and
 * test/runs-page.test.mts — the slice is pinned at the boundaries that ARE
 * mechanically checkable:
 *
 *   1. useApi.js owns exactly one write-side hook, `useServerConfirmedWrite`
 *      (INV-1), whose `write(path, body)` POSTs a JSON body through the
 *      module's own apiFetch and resolves a result object — never throws.
 *   2. Health.jsx and NowConsole.jsx delegate to it and keep ZERO direct
 *      apiFetch calls (INV-2/INV-3); the hand-rolled pending/error trios
 *      are deleted, not wrapped.
 *   3. The hook owns only `pending` and `error` and awaits `refresh()`
 *      inside the try before resolving ok — server-confirmed, never
 *      optimistic (INV-4, a MUST-NEVER: discharged by this named subtest).
 *   4. The read side (apiFetch/useApi) keeps its exported signatures, and
 *      pending resets in a finally on both paths (INV-5/INV-8).
 *   5. The brake's two-step confirm arm stays local page state (INV-6).
 *   6. The differently-shaped write sites (BoardState, HitlGrillLane,
 *      AttentionFeed) stay unmigrated with their own apiFetch calls (INV-7).
 *
 * Lifecycle: top-level describes with no shared mutable state and no Redis
 * seam (per the CLAUDE.md shared-teardown authoring rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const USE_API = "../dashboard/src/hooks/useApi.js";
const HEALTH = "../dashboard/src/pages/Health.jsx";
const NOW_CONSOLE = "../dashboard/src/pages/now-console/NowConsole.jsx";

async function readSource(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/**
 * The source span of ONE top-level export: from its `export …` marker line
 * to the next top-level `export ` (or EOF). Scoped so whole-file counts
 * (useState, setters, finally) can be asserted about the write hook without
 * the read hook's identical machinery contaminating them.
 */
function sliceExport(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `marker not found in source: ${marker}`);
  const rest = src.slice(start);
  const next = rest.indexOf("\nexport ", marker.length);
  return next === -1 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// INV-1 — exactly one write-side home
// ---------------------------------------------------------------------------

describe("useApi.js owns exactly one write-side hook (INV-1)", () => {
  test("the module's exports are exactly apiFetch, useApi, useServerConfirmedWrite", async () => {
    const src = await readSource(USE_API);
    const names = Array.from(src.matchAll(/export (?:async )?function (\w+)/g), (m) => m[1]);
    assert.deepEqual(
      names,
      ["apiFetch", "useApi", "useServerConfirmedWrite"],
      "useApi.js must gain the write hook as its ONLY new export — a second write-side home is the duplication this issue deletes",
    );
  });

  test("write POSTs a JSON body through the module's own apiFetch", async () => {
    const hook = sliceExport(await readSource(USE_API), "export function useServerConfirmedWrite(");
    // Token-level pins — argument order and object layout are not the contract.
    assert.match(hook, /apiFetch\(path,/, "the write rides the module's own fetch seam");
    assert.match(hook, /method: "POST"/, "every dashboard write is a POST");
    assert.match(hook, /JSON\.stringify\(body\)/, "the body is JSON-encoded by the hook");
  });

  test("write resolves a result object and never throws to the caller", async () => {
    const hook = sliceExport(await readSource(USE_API), "export function useServerConfirmedWrite(");
    assert.match(hook, /return \{ ok: true, res \}/, "success carries the POST response");
    assert.match(hook, /return \{ ok: false, error/, "failure carries the surfaced message");
    assert.doesNotMatch(hook, /throw\b/, "the hook must never throw — callers decide how to report");
  });

  test("write's dependency array is [refresh] — the read hook's stable callback", async () => {
    const hook = sliceExport(await readSource(USE_API), "export function useServerConfirmedWrite(");
    // Comments may sit between the body's closing brace and the deps array.
    assert.match(hook, /\},(?:\s*\/\/[^\n]*)*\s*\[refresh\],\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// INV-4 — server-confirmed, never optimistic (MUST NEVER; discharged by
// this exact named subtest per the reconcile gate)
// ---------------------------------------------------------------------------

describe("useServerConfirmedWrite is server-confirmed, never optimistic (INV-4)", () => {
  test("useServerConfirmedWrite awaits refresh() inside the try block and owns no state beyond pending and error", async () => {
    const api = await readSource(USE_API);
    const hook = sliceExport(api, "export function useServerConfirmedWrite(");

    // The hook declares exactly two useState calls — pending and error. It
    // MUST NEVER own or flip a displayed value: that is what makes the
    // action server-confirmed rather than optimistic.
    assert.equal(
      (hook.match(/useState\(/g) ?? []).length,
      2,
      "the write hook may own only pending + error state",
    );
    assert.match(hook, /const \[pending, setPending\] = useState\(false\)/);
    assert.match(hook, /const \[error, setError\] = useState\(null\)/);
    const setters = new Set(hook.match(/set[A-Z][A-Za-z]*/g) ?? []);
    for (const setter of setters) {
      assert.ok(
        setter === "setPending" || setter === "setError",
        `unexpected state setter ${setter} — the hook must not flip displayed state`,
      );
    }

    // refresh() is awaited INSIDE the try, BEFORE the ok:true resolution —
    // the follow-up read must land before the caller treats the write as
    // confirmed.
    const tryAt = hook.indexOf("try {");
    const refreshAt = hook.indexOf("await refresh()");
    const okAt = hook.indexOf("{ ok: true");
    assert.ok(tryAt !== -1, "the hook body must contain a try block");
    assert.ok(refreshAt > tryAt, "await refresh() must sit inside the try block");
    assert.ok(okAt > refreshAt, "ok:true may only resolve after the follow-up read");

    // The rendered pause/brake value keeps deriving solely from the read
    // hook's data — never from the write's own success.
    const health = await readSource(HEALTH);
    assert.ok(health.includes("health.data?.autopilotPause"), "the pause chip still derives from health.data");
    assert.ok(health.includes("health.data?.emergencyBrake"), "the brake chip still derives from health.data");
    const console_ = await readSource(NOW_CONSOLE);
    assert.ok(console_.includes("paused.data"), "the /now verdict still derives from paused.data");
  });
});

// ---------------------------------------------------------------------------
// INV-2 — Health.jsx delegates both writes to the hook
// ---------------------------------------------------------------------------

describe("Health.jsx delegates both writes to the hook (INV-2)", () => {
  test("no direct apiFetch calls remain in Health.jsx", async () => {
    const src = await readSource(HEALTH);
    assert.ok(!src.includes("apiFetch("), "the pause and brake POSTs must both ride the shared hook");
  });

  test("pause and brake each ride their own useServerConfirmedWrite(health.refresh) instance", async () => {
    const src = await readSource(HEALTH);
    assert.equal(
      (src.match(/useServerConfirmedWrite\(health\.refresh\)/g) ?? []).length,
      2,
      "two instances — a shared one would cross-contaminate pending/error between the controls",
    );
  });

  test("the hand-rolled pending/error trios are deleted, not wrapped", async () => {
    const src = await readSource(HEALTH);
    for (const gone of ["setPausePending", "setPauseError", "setBrakePending", "setBrakeError"]) {
      assert.ok(!src.includes(gone), `Health.jsx must not re-declare ${gone} — the hook owns it`);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-3 — NowConsole.jsx delegates the pause write; StatusVerdict untouched
// ---------------------------------------------------------------------------

describe("NowConsole.jsx delegates the pause write to the hook (INV-3)", () => {
  test("no direct apiFetch calls remain in NowConsole.jsx", async () => {
    const src = await readSource(NOW_CONSOLE);
    assert.ok(!src.includes("apiFetch("), "the pause POST must ride the shared hook");
  });

  test("the pause write rides useServerConfirmedWrite(paused.refresh)", async () => {
    const src = await readSource(NOW_CONSOLE);
    assert.match(src, /useServerConfirmedWrite\(paused\.refresh\)/);
  });

  test("the StatusVerdict props keep their names and types", async () => {
    const src = await readSource(NOW_CONSOLE);
    for (const pin of ["onTogglePause=", "pausePending=", "pauseError="]) {
      assert.ok(src.includes(pin), `NowConsole must keep handing ${pin} to StatusVerdict`);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-5 / INV-8 — pending resets on both paths; the read side is untouched
// ---------------------------------------------------------------------------

describe("read side untouched; pending resets on both paths (INV-5/INV-8)", () => {
  test("useApi.js carries >= 2 finally blocks — the read hook's and the write hook's", async () => {
    const src = await readSource(USE_API);
    assert.ok(
      ((src.match(/finally \{/g) ?? []).length) >= 2,
      "the write hook must reset pending in a finally on both the success and failure paths",
    );
  });

  test("the write hook's own slice resets pending in a finally", async () => {
    // The whole-file count above mirrors the artifact's mandated discharge;
    // this scoped check pins that the write hook is one of the contributors.
    const hook = sliceExport(await readSource(USE_API), "export function useServerConfirmedWrite(");
    assert.ok(hook.includes("finally"), "the write hook must own a finally");
    assert.ok(
      hook.includes("setPending(false)"),
      "pending resets on both the success and failure paths",
    );
  });

  test("apiFetch and useApi keep their existing exported signatures", async () => {
    const src = await readSource(USE_API);
    assert.ok(src.includes("export async function apiFetch(path, options = {})"));
    assert.ok(src.includes("export function useApi(path, { poll = 0, skip = false } = {})"));
  });
});

// ---------------------------------------------------------------------------
// INV-6 — the brake's two-step confirm arm stays local page state
// ---------------------------------------------------------------------------

describe("the brake's confirm arm stays in the page (INV-6)", () => {
  test("brakeArmed remains local Health.jsx state, cleared only on an ok write", async () => {
    const src = await readSource(HEALTH);
    assert.ok(src.includes("brakeArmed"), "the hook knows nothing about arming — the arm is page state");
    assert.match(
      src,
      /\.ok[\s\S]{0,120}?setBrakeArmed\(false\)/,
      "the arm may clear only once write resolves ok — a failed POST keeps the confirm visible for a retry",
    );
  });
});

// ---------------------------------------------------------------------------
// INV-7 — the differently-shaped write sites stay unmigrated
// ---------------------------------------------------------------------------

describe("scope fence — the differently-shaped write sites stay unmigrated (INV-7)", () => {
  const fenced = [
    "../dashboard/src/components/pages/work/BoardState.jsx",
    "../dashboard/src/components/pages/work/HitlGrillLane.jsx",
    "../dashboard/src/components/pages/today/AttentionFeed.jsx",
  ];

  for (const rel of fenced) {
    test(`${rel} keeps its own apiFetch call`, async () => {
      const src = await readSource(rel);
      assert.ok(
        src.includes("apiFetch("),
        "these three keep a server result object / per-item pending map — their migration is a follow-up issue, not silent scope creep",
      );
    });
  }
});
