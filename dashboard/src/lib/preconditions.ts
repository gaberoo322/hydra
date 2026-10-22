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
