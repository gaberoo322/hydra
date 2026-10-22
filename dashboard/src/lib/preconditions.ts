/**
 * Live precondition checklist — the framework-free rule behind every
 * action-bearing control's ✓/✗ lines (issue #4629, ADR-0034 §8.3;
 * design-concept 821e48ed INV-4).
 *
 * A registry precondition is either prose or a typed `{text, check}` pair
 * whose `check` is a closed CONTROL_CHECKS id (src/schemas/operator-actions.ts).
 * The page that renders the control evaluates the ids it owns from data it
 * already reads into a verdict table (`{ [check]: boolean }`); this module
 * joins the two:
 *
 *   - prose line            → `unverified` (☐) — never disables; the feed's
 *                             prose-only lines keep working unchanged.
 *   - `{check}`, verdict true → `ok` (✓).
 *   - `{check}`, verdict false, OR no verdict supplied → `fail` (✗). Fail
 *     closed: a check the page forgot to evaluate can never enable the
 *     button. Only a literal `true` passes — a truthy non-boolean does not.
 *
 * `anyFailed(lines)` is the disable rule: the trigger (arm, Confirm and
 * immediate fire alike) is disabled while any line is ✗. Extracted from
 * ActionAffordance.jsx so the rule is unit-tested with node:test
 * (test/operator-actions-affordance.test.mts) — the dashboard ships no JSX
 * test runner, same as lib/delayed-commit.ts.
 */

/** A registry precondition as served by GET /api/operator-actions. */
export type Precondition = string | { text: string; check: string };

/** ok → ✓, fail → ✗, unverified (prose) → ☐. */
export type PreconditionState = "ok" | "fail" | "unverified";

export interface ResolvedPrecondition {
  text: string;
  state: PreconditionState;
  /** The CONTROL_CHECKS id for a typed line; absent on prose. */
  check?: string;
}

/** A page's verdict table: one boolean per check id it evaluates. */
export type Verdicts = Readonly<Record<string, boolean | undefined>>;

/** The glyph each state renders as. */
export const PRECONDITION_GLYPH: Readonly<Record<PreconditionState, string>> = Object.freeze({
  ok: "✓",
  fail: "✗",
  unverified: "☐",
});

function verdictFor(verdicts: Verdicts | null | undefined, check: string): boolean {
  if (verdicts === null || verdicts === undefined) return false;
  // Own keys only — a check id can never resolve through the prototype.
  if (!Object.prototype.hasOwnProperty.call(verdicts, check)) return false;
  return verdicts[check] === true;
}

/**
 * Resolve each precondition against the page's verdicts, in order. A
 * malformed line (neither a string nor an object with string `text` and
 * `check`) resolves to `fail` with whatever text it carries — fail closed,
 * never a silent drop.
 */
export function resolvePreconditions(
  preconditions: readonly Precondition[] | null | undefined,
  verdicts?: Verdicts | null,
): ResolvedPrecondition[] {
  if (!Array.isArray(preconditions)) return [];
  return preconditions.map((line) => {
    if (typeof line === "string") return { text: line, state: "unverified" };
    const text = typeof line?.text === "string" ? line.text : String(line?.text ?? "");
    const check = typeof line?.check === "string" ? line.check : undefined;
    if (check === undefined) return { text, state: "fail" };
    return { text, check, state: verdictFor(verdicts, check) ? "ok" : "fail" };
  });
}

/** The disable rule: true while any resolved line is ✗. */
export function anyFailed(lines: readonly ResolvedPrecondition[]): boolean {
  return lines.some((line) => line.state === "fail");
}

/**
 * Control-route resolution (issue #4631 review follow-up; ADR-0034 §7). A
 * `control:` registry route may carry the one admitted placeholder (`{id}`,
 * BUCKET_CONTEXT.control); the page resolves it through `resolveRoute` before
 * the action reaches ActionAffordance, which never substitutes. This is the
 * pure core of ControlAffordance's resolution, and it is the runtime guard
 * that NO route still carrying `{` is ever handed to the affordance —
 * whether or not a resolver was passed (a page that renders a templated
 * control without one gets a disabled control, never a POST against a
 * literal `{id}` segment). A resolver that throws, or returns a non-string,
 * fails the same way. On failure, `error` is the reason the caller renders
 * (disabled, ✗) and logs.
 */
export type ControlActionResolution<A> = { action: A; error?: undefined } | { action?: undefined; error: string };

export function resolveControlAction<A extends { route?: unknown }>(
  action: A,
  resolveRoute?: (route: string) => string,
): ControlActionResolution<A> {
  let route: unknown = action.route;
  if (resolveRoute !== undefined && typeof route === "string") {
    try {
      route = resolveRoute(route);
    } catch (err) {
      return { error: `route did not resolve: ${(err as Error)?.message ?? String(err)}` };
    }
  }
  if (route === undefined) return { action };
  if (typeof route !== "string") return { error: "route did not resolve: resolver returned a non-string" };
  if (route.includes("{")) return { error: `route still carries a placeholder: ${route}` };
  return { action: route === action.route ? action : { ...action, route } };
}
