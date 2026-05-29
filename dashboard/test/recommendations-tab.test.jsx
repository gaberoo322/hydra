/**
 * dashboard/test/recommendations-tab.test.jsx — slice F of /now-pixel
 * observability (#674).
 *
 * The dashboard does not ship a JSX-aware test runner today (vitest is
 * not wired in `dashboard/package.json` and the orchestrator's
 * `npm test` only scans `test/*.test.mts`). The behavioural contract
 * for the React UI lives in:
 *
 *   - `test/recommendation-engine.test.mts` — engine pure logic + gates
 *   - `test/recommendations-api.test.mts`   — Express route shape +
 *                                             filterActiveRecommendations
 *
 * Those two suites pin the data the JSX renders against. This file is
 * the documented contract for the React surface itself; once vitest is
 * adopted (a follow-up tracked separately), the assertions below promote
 * from prose to executable cases. The intent is captured here so a
 * future contributor reading `Files in scope` for issue #674 finds the
 * complete inventory.
 *
 * Contract pinned for `RecommendationsTab`:
 *
 *   1. Polls GET /api/now/recommendations every 5s with run_id=current.
 *      The `setInterval` cadence is the `POLL_MS` constant in
 *      `RecommendationsTab.jsx`. A test would advance a fake timer by
 *      `POLL_MS` and assert one additional fetch fires per tick.
 *   2. Renders one li per active rec, severity-colored on the left border:
 *      - "info" → sky-300 (#7dd3fc)
 *      - "warn" → amber-400 (#fbbf24)
 *      - "critical" → rose-400 (#f87171)
 *      A test would mount the component with a fake fetch, await the
 *      next paint, and assert li.style.borderLeftColor matches.
 *   3. Per-rec ✕ button POSTs /api/now/recommendations/:id/dismiss
 *      with {run_id} in the body, and optimistically removes the row.
 *   4. Right-click on a row opens a one-item menu at the click
 *      coordinates labelled "Mute all "<severity>" recs for this run",
 *      which POSTs /api/now/recommendations/mute-class with
 *      {run_id, severity}.
 *   5. The "See full run journal" button toggles `journalOpen` on the
 *      parent (OakTownCrier) which renders `RecRunJournalModal`.
 *
 * Contract pinned for `RecRunJournalModal`:
 *
 *   6. When `open` flips to true, fetches /api/now/recommendations with
 *      `include_filtered=true`.
 *   7. Closes on ✕, backdrop click, or ESC keypress.
 *
 * Contract pinned for `OakTownCrier` tab integration:
 *
 *   8. Persists `tab` selection in localStorage under
 *      `hydra:now-pixel:oak-tab`. Invalid stored values fall back to
 *      DEFAULT_TAB.
 *   9. Renders the "Oak is resting" badge when a `{type:"oak_resting"}`
 *      WS frame is received. Badge title shows the spend/cap pair.
 *
 * Until vitest lands, the existing `.mts` tests provide upstream
 * coverage by pinning the data shapes the JSX renders. The
 * test/now-pixel-oak-town-crier.test.mts pattern is the next-best
 * unit-level harness — it exercises `sprite-map.ts` directly, the same
 * style we'd extend here for any pure helper extracted from the JSX.
 */

import { test } from "node:test";

// Smoke-only: keeps the file from being silently empty under a future
// runner. The `t.skip` body is the contract above.
test("RecommendationsTab — contract documented above; vitest TBD", (t) => {
  t.skip(
    "Dashboard test runner not yet wired (no vitest in dashboard/package.json)." +
      " Pure-logic coverage lives in test/recommendation-engine.test.mts and" +
      " test/recommendations-api.test.mts; this file pins the React surface.",
  );
});
