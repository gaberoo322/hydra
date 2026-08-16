/**
 * Pure derivation helpers for the /runs page (issue #4009, dashboard v3
 * slice delta, ADR-0034 §2 — "why did that fail?").
 *
 * React-free on purpose — the same lane as components/pages/today's
 * cross-tab-families.js — so test/runs-page.test.mts can import and pin
 * them directly (the dashboard ships no JSX test runner and the worktree
 * resolves no `react`; every load-bearing derivation must live in a module
 * like this one to be testable at all).
 *
 * Three derivations live here:
 *
 *   1. classifyRunOutcome — the outcome classifier absorbed from the retired
 *      Explore › Behavior tab (a client mirror of src/aggregators/
 *      behavior-gallery.ts's classifyOutcome, which stays the server-side
 *      authority for /explore/behavior). /autopilot/runs serves raw run
 *      digests (`status` / `exit_code` / `term_reason`); the runs list
 *      derives the closed outcome set client-side so the two surfaces never
 *      disagree.
 *   2. findFailingTurn — which turn of a failed run the detail page must
 *      land on (the GitHub-Actions "failed step auto-expands" affordance,
 *      ADR-0034 §2 /runs contract).
 *   3. describeDispatchTrigger — Temporal-style attribution ("who or what
 *      triggered this event?") for a dispatch row. Where the dispatch→issue
 *      join is missing the row is explicitly UNATTRIBUTED — never a
 *      fabricated source (design-concept a4cc4156, INV-8).
 */

/**
 * The closed outcome set (mirrors AutopilotRunOutcome in
 * src/schemas/explore-page.ts). "unknown" is a member on purpose: a digest
 * the classifier cannot place renders as unknown, never as a guess.
 *
 * @typedef {"success"|"failure"|"aborted"|"in-progress"|"unknown"} RunOutcome
 */

/**
 * Map a run digest's `status` + `exit_code` + `term_reason` onto the outcome
 * set. Field-for-field the same decision table as the server-side
 * behavior-gallery classifier (the absorbed Behavior-tab derivation):
 *
 *   running                            → in-progress
 *   aborted / cancelled (either field) → aborted
 *   failed (server-side sweep verdict) → failure
 *   completed, exit_code 0             → success
 *   completed, finite exit_code ≠ 0    → failure
 *   completed, no exit code recorded   → success (pre-#498 schema)
 *   anything else                      → unknown
 *
 * @param {string} status
 * @param {number|null} exitCode
 * @param {string|null} termReason
 * @returns {RunOutcome}
 */
export function classifyRunOutcome(status, exitCode, termReason) {
  const s = String(status || "").toLowerCase();
  const reason = String(termReason || "").toLowerCase();
  if (s === "running") return "in-progress";
  if (s === "aborted" || s === "cancelled" || reason === "aborted" || reason === "cancelled") {
    return "aborted";
  }
  if (s === "failed") return "failure";
  if (s === "completed") {
    if (exitCode === 0) return "success";
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) return "failure";
    return "success";
  }
  return "unknown";
}

/** A turn "failed" when any of its dispatch actions carries a failed outcome. */
function turnHasFailedAction(turn) {
  const actions = Array.isArray(turn?.actions) ? turn.actions : [];
  return actions.some((a) => a?.outcome?.status === "failed");
}

/**
 * @typedef {Object} TurnRow a run-detail turn row (newest-first projection).
 * @property {number} turn_n
 * @property {number} [epoch]
 * @property {Array<Object>} [actions]
 * @property {Array<string>} [reasons]
 */

/**
 * Which turn of a failed run the detail page lands on (INV-4 — the failed
 * step auto-expands; the operator must not hunt for the red thing).
 *
 * Turns arrive NEWEST-FIRST (the /autopilot/runs/:id projection order, which
 * TurnTimeline renders as-is). Decision table:
 *
 *   - the most recent turn with a failed dispatch action → that turn
 *     (where the failure actually happened; if several turns failed, the
 *     newest is where the run stood when it died)
 *   - a failed run with no failed action (run-level death: crash, budget
 *     exhaustion, kill) → the newest turn, i.e. where it stopped
 *   - a non-failed run, or no turns at all → null (no landing target)
 *
 * @param {Array<Object>} turns newest-first turn rows, each with turn_n +
 *   actions[] (actions[].outcome.status carries the dispatch verdict).
 * @param {boolean} runFailed whether classifyRunOutcome(run) === "failure".
 * @returns {TurnRow|null} the landing turn, or null.
 */
export function findFailingTurn(turns, runFailed) {
  const list = Array.isArray(turns) ? turns : [];
  if (!runFailed || list.length === 0) return null;
  return list.find(turnHasFailedAction) ?? list[0];
}

/**
 * Attribution for one dispatch row — "who or what triggered it" (Temporal's
 * principal attribution, adopted by ADR-0034 §2 for /runs).
 *
 * The active-dispatches payload (/now/active-dispatches) names the TRIGGER
 * (`source`: autopilot | operator | subagent, plus `classLabel`) and carries
 * the dispatch→issue join (`issueRef`). The join is the known-weak field
 * (~4.97% attribution, ADR-0034 §2): when it is absent the row MUST render
 * an explicit unattributed state — a fabricated source would poison the one
 * page whose whole value is reading ground truth.
 *
 * @param {{source?: string, classLabel?: string, issueRef?: string|null}} dispatch
 * @returns {{attributed: boolean, trigger: string, target: string}} trigger =
 *   who/what fired it (always real payload fields); target = the joined
 *   issue ref, or the literal "unattributed" when the join is missing.
 */
export function describeDispatchTrigger(dispatch) {
  const source = String(dispatch?.source || "").toLowerCase();
  const who =
    source === "operator"
      ? "operator"
      : source === "subagent"
        ? "subagent"
        : source === "autopilot"
          ? "autopilot"
          : "unknown source";
  const classLabel = typeof dispatch?.classLabel === "string" && dispatch.classLabel
    ? dispatch.classLabel
    : null;
  const trigger = classLabel ? `${who} · ${classLabel}` : who;
  const issueRef =
    typeof dispatch?.issueRef === "string" && dispatch.issueRef.trim() ? dispatch.issueRef : null;
  return { attributed: issueRef !== null, trigger, target: issueRef ?? "unattributed" };
}

/**
 * Compact duration formatter (absorbed from the retired Behavior tab's
 * fmtDuration): whole minutes under an hour, `Hh Mm` above. Null/invalid →
 * the em-dash placeholder, never a confident "0m".
 *
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatRunDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
