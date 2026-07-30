/**
 * test/now-pixel-recommendations-tab-state.test.mts — pins the pure folds
 * extracted out of RecommendationsTab.jsx (issue #3706).
 *
 * This file replaces `dashboard/test/recommendations-tab.test.jsx`, which was
 * 73 lines of prose wrapped around a single `t.skip(…)` and which never ran at
 * all: the root `npm test` globs `test/*.test.mts`, so a `.test.jsx` under
 * `dashboard/test/` was invisible to every runner in the repo.
 *
 * Of that file's nine prose contracts, these are now executable:
 *   1. Poll cadence + run_id=current path        → RECS_POLL_MS / RECS_PATH
 *   2. Severity → left-border hex                → severityColor
 *   3. Dismiss POSTs :id/dismiss with {run_id}, optimistically removing the row
 *   4. Mute-class POSTs mute-class with {run_id, severity}
 *   8. Tab persistence — already pinned by now-pixel-oak-tab-state.test.mts,
 *      and the component now calls those helpers instead of re-implementing them
 *   9. oak_resting badge parse → now-pixel-oak-crier-state.test.mts
 *
 * Contracts 5, 6 and 7 (the journal modal opens, closes on backdrop click,
 * closes on ESC) are DECLINED ON PURPOSE, not overlooked: they are browser
 * plumbing, and a test over them asserts that React and the DOM work. Adopting
 * a JSX runner to reach them would need four new devDeps behind the ADR-0005
 * allowlist and would land in an advisory workflow that cannot block a merge,
 * because the only required job running inside dashboard/ is `dashboard-build`
 * — `npm ci` then `npm run build`, with no test step to hook.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SEVERITY_COLOR,
  MUTE_CLASS_PATH,
  NO_PENDING_REMOVALS,
  RECS_PATH,
  RECS_POLL_MS,
  RUN_ID_PARAM,
  SEVERITY_COLORS,
  applyPendingRemovals,
  dismissBody,
  dismissPath,
  muteClassBody,
  normaliseRecsResponse,
  runLabel,
  severityColor,
  withDismissedId,
  withMutedSeverity,
} from "../dashboard/src/pages/now-pixel/recommendations-tab-state.ts";

const RECS = [
  { id: "r1", severity: "critical", message: "quota nearly spent" },
  { id: "r2", severity: "warn", message: "board is thin" },
  { id: "r3", severity: "info", message: "all clear" },
  { id: "r4", severity: "warn", message: "second warning" },
];

// --- contract 1: poll cadence + path -----------------------------------

test("RECS_POLL_MS is the documented 5s cadence", () => {
  assert.equal(RECS_POLL_MS, 5000);
});

test("RECS_PATH asks for the live run and carries no /api prefix", () => {
  assert.equal(RECS_PATH, "/now/recommendations?run_id=current");
  assert.equal(RUN_ID_PARAM, "current");
  // The prefix belongs to apiFetch, which honours VITE_API_BASE. Hardcoding
  // "/api" here is the latent bug this extraction removed.
  assert.ok(!RECS_PATH.startsWith("/api"));
});

// --- contract 2: severity colours ---------------------------------------

test("severityColor maps each known severity to its documented hex", () => {
  assert.equal(severityColor("critical"), "#f87171"); // rose-400
  assert.equal(severityColor("warn"), "#fbbf24"); // amber-400
  assert.equal(severityColor("info"), "#7dd3fc"); // sky-300
});

test("severityColor falls back to info for unknown or absent severities", () => {
  assert.equal(severityColor("nonsense"), DEFAULT_SEVERITY_COLOR);
  assert.equal(severityColor(undefined), DEFAULT_SEVERITY_COLOR);
  assert.equal(severityColor(null), DEFAULT_SEVERITY_COLOR);
  assert.equal(DEFAULT_SEVERITY_COLOR, SEVERITY_COLORS.info);
});

// --- contract 3 + 4: POST paths and bodies ------------------------------

test("dismissPath targets the per-rec dismiss route and encodes the id", () => {
  assert.equal(dismissPath("r1"), "/now/recommendations/r1/dismiss");
  assert.equal(
    dismissPath("weird/id?x"),
    "/now/recommendations/weird%2Fid%3Fx/dismiss",
  );
  assert.ok(!dismissPath("r1").startsWith("/api"));
});

test("MUTE_CLASS_PATH targets the mute-class route with no /api prefix", () => {
  assert.equal(MUTE_CLASS_PATH, "/now/recommendations/mute-class");
});

test("dismissBody sends the resolved run id, falling back to 'current'", () => {
  assert.deepEqual(dismissBody("run-abc"), { run_id: "run-abc" });
  assert.deepEqual(dismissBody(null), { run_id: RUN_ID_PARAM });
  assert.deepEqual(dismissBody(undefined), { run_id: RUN_ID_PARAM });
});

test("muteClassBody sends the run id plus the severity class", () => {
  assert.deepEqual(muteClassBody("run-abc", "warn"), {
    run_id: "run-abc",
    severity: "warn",
  });
  assert.deepEqual(muteClassBody(null, "critical"), {
    run_id: RUN_ID_PARAM,
    severity: "critical",
  });
});

// --- response normalisation ---------------------------------------------

test("normaliseRecsResponse reads items and run_id off a well-formed body", () => {
  const snap = normaliseRecsResponse({ items: RECS, run_id: "run-abc" });
  assert.equal(snap.items.length, 4);
  assert.equal(snap.runId, "run-abc");
});

test("normaliseRecsResponse yields an empty snapshot for junk or a pre-fetch null", () => {
  for (const body of [null, undefined, {}, { items: "nope" }, { items: null }, 42]) {
    const snap = normaliseRecsResponse(body);
    assert.deepEqual(snap.items, [], `items for ${JSON.stringify(body)}`);
    assert.equal(snap.runId, null, `runId for ${JSON.stringify(body)}`);
  }
});

test("normaliseRecsResponse ignores a non-string run_id", () => {
  assert.equal(normaliseRecsResponse({ items: [], run_id: 7 }).runId, null);
});

// --- optimistic removal overlay ------------------------------------------

test("applyPendingRemovals is the identity when nothing is pending", () => {
  assert.deepEqual(applyPendingRemovals(RECS, NO_PENDING_REMOVALS), RECS);
  assert.deepEqual(NO_PENDING_REMOVALS, { ids: [], severities: [] });
});

test("withDismissedId hides exactly that row, leaving the rest", () => {
  const pending = withDismissedId(NO_PENDING_REMOVALS, "r2");
  const visible = applyPendingRemovals(RECS, pending);
  assert.deepEqual(
    visible.map((r) => r.id),
    ["r1", "r3", "r4"],
  );
});

test("withMutedSeverity hides every row of that class in one action", () => {
  const pending = withMutedSeverity(NO_PENDING_REMOVALS, "warn");
  const visible = applyPendingRemovals(RECS, pending);
  assert.deepEqual(
    visible.map((r) => r.id),
    ["r1", "r3"],
  );
});

test("dismissals and mutes compose", () => {
  let pending = withMutedSeverity(NO_PENDING_REMOVALS, "warn");
  pending = withDismissedId(pending, "r1");
  assert.deepEqual(
    applyPendingRemovals(RECS, pending).map((r) => r.id),
    ["r3"],
  );
});

test("the overlay is immutable and de-duplicates repeat actions", () => {
  const once = withDismissedId(NO_PENDING_REMOVALS, "r1");
  const twice = withDismissedId(once, "r1");
  assert.equal(twice, once, "a repeat dismiss must not grow the overlay");
  assert.deepEqual(NO_PENDING_REMOVALS.ids, [], "the shared empty overlay stays empty");

  const muted = withMutedSeverity(NO_PENDING_REMOVALS, "warn");
  assert.equal(withMutedSeverity(muted, "warn"), muted);
  assert.deepEqual(NO_PENDING_REMOVALS.severities, []);
});

test("the overlay keeps hiding a row across a poll that still returns it", () => {
  // The POST is in flight; the next 5s poll has not caught up yet. The row
  // must stay hidden rather than flickering back in.
  const pending = withDismissedId(NO_PENDING_REMOVALS, "r2");
  const secondPoll = normaliseRecsResponse({ items: RECS, run_id: "run-abc" });
  assert.ok(!applyPendingRemovals(secondPoll.items, pending).some((r) => r.id === "r2"));
});

test("applyPendingRemovals tolerates a null item list", () => {
  assert.deepEqual(applyPendingRemovals(null, NO_PENDING_REMOVALS), []);
  assert.deepEqual(applyPendingRemovals(undefined, NO_PENDING_REMOVALS), []);
});

// --- header label ---------------------------------------------------------

test("runLabel shows a short run hash, or 'no run' before one starts", () => {
  assert.equal(runLabel("0a7fef6b-9028-400d"), "run 0a7fef6b");
  assert.equal(runLabel("short"), "run short");
  assert.equal(runLabel(null), "no run");
  assert.equal(runLabel(undefined), "no run");
  assert.equal(runLabel(""), "no run");
});
