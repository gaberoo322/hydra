/**
 * /health verdict tables for the alert, scheduler and housekeeping controls
 * (issue #4631, ADR-0034 §8.3; design-concept 5ae4b72c INV-5/INV-9/INV-11).
 *
 * A pure leaf, sibling of lib/control-verdicts.ts: each function maps facts a
 * /health panel ALREADY reads onto one boolean per CONTROL_CHECKS id
 * (src/schemas/operator-actions.ts); lib/preconditions.ts joins them to the
 * registry's `{text, check}` lines. A read that is loading, errored or UNKNOWN,
 * or a payload missing the field a check needs, yields NO verdict for that
 * check — preconditions.ts renders a missing verdict ✗ (fail closed), so a
 * panel never passes a guessed boolean. Unit-tested with node:test
 * (test/health-page.test.mts); the dashboard ships no JSX test runner.
 */

export type Verdicts = Record<string, boolean>;

/** One GET /alerts entry — the fields the per-row check reads. */
export interface AlertFacts {
  id?: unknown;
  dismissed?: unknown;
}

/** Per-row Dismiss: the row is still open. No alert → no verdict. */
export function alertVerdicts(alert: AlertFacts | null | undefined): Verdicts {
  if (alert === null || alert === undefined || typeof alert !== "object") return {};
  return { "alert-open": alert.dismissed !== true };
}

/**
 * Dismiss all: at least one open alert. The caller passes the undismissed
 * count only while the /alerts read is trusted; anything that is not a
 * finite, non-negative number (loading, UNKNOWN, a malformed payload) yields
 * no verdict.
 */
export function alertsVerdicts(undismissedCount: number | null | undefined): Verdicts {
  if (typeof undismissedCount !== "number" || !Number.isFinite(undismissedCount) || undismissedCount < 0) {
    return {};
  }
  return { "alerts-any-open": undismissedCount >= 1 };
}

/** The GET /scheduler/status fields the scheduler checks read. */
export interface SchedulerStatusFacts {
  running?: unknown;
  stopReason?: unknown;
  checks?: unknown;
}

/**
 * Scheduler Stop / Start. The caller passes the status payload only while the
 * /scheduler/status read is trusted (null otherwise → no verdicts).
 *   - scheduler-running / scheduler-not-running need a boolean `running`.
 *   - no-fresh-deliberate-stop is SERVER-evaluated (issue #5452, ADR-0034
 *     §8.3): copied from `status.checks` when the server delivered a boolean;
 *     absent (no verdict, fail closed) otherwise. No clock, no TTL here.
 */
export function schedulerVerdicts(status: SchedulerStatusFacts | null | undefined): Verdicts {
  if (status === null || status === undefined || typeof status !== "object") return {};
  const out: Verdicts = {};
  if (typeof status.running === "boolean") {
    out["scheduler-running"] = status.running === true;
    out["scheduler-not-running"] = status.running === false;
  }
  const checks = status.checks;
  if (checks !== null && typeof checks === "object") {
    for (const [id, verdict] of Object.entries(checks as Record<string, unknown>)) {
      if (typeof verdict === "boolean") out[id] = verdict;
    }
  }
  return out;
}

/**
 * Resolve a control route's `{name}` placeholders from `params` (the alert
 * id, issue #4631 INV-9) BEFORE the action reaches ActionAffordance, which
 * matches only resolved routes. Each value is URI-encoded into its one
 * segment. A placeholder with no non-empty value THROWS — never a route that
 * still carries `{` and never a fire against a guessed segment.
 */
export function resolveControlRoute(
  route: string,
  params: Readonly<Record<string, unknown>>,
): string {
  return route.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(params ?? {}, name) ? params[name] : undefined;
    if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
      throw new Error(`unresolved route placeholder {${name}} in ${route}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** The lifted affordance result the housekeeping section reads. */
export interface HousekeepingResult {
  ok?: boolean;
  body?: unknown;
}

/**
 * The verified housekeeping summary line (INV-11), rendered under the control
 * only after the request settled: `ran (n): a, b · skipped (m): c`. Returns
 * null when there is no result or the request failed — the affordance's own
 * persistent ✗ line is the failure surface. A 2xx body without `ran` /
 * `skipped` string arrays renders `✓ accepted · summary missing`, never an
 * empty list.
 */
export function housekeepingSummary(result: HousekeepingResult | null | undefined): string | null {
  if (!result || result.ok !== true) return null;
  const body = result.body as { ran?: unknown; skipped?: unknown } | null | undefined;
  const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!body || typeof body !== "object" || !isNames(body.ran) || !isNames(body.skipped)) {
    return "✓ accepted · summary missing";
  }
  const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "none");
  return `ran (${body.ran.length}): ${list(body.ran)} · skipped (${body.skipped.length}): ${list(body.skipped)}`;
}
