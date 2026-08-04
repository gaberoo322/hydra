/**
 * test/dashboard-response-contract.test.mts — compile-time drift guard for
 * the hand-mirrored dashboard response-shape types (issue #3707).
 *
 * The dashboard deliberately does NOT import from src/ at runtime — it is a
 * separately deployed bundle (dashboard/src/pages/now-pixel/derive-sprite-state.ts
 * says so explicitly) — so response shapes it depends on (the autopilot-tick
 * payload, the active-dispatches payload) are hand-retyped at the consumer
 * site with no compiler check tying them back to the real route's response
 * shape in src/schemas/now-page.ts. Every other external boundary in this
 * codebase (Redis, GitHub, OpenViking, Anthropic, host-probe, journal) is
 * guarded by a shrink-only CI ratchet or a typed accessor seam; this was the
 * one network boundary with none.
 *
 * This TEST file lives outside the deployed dashboard bundle, so it CAN cross
 * that boundary — it is never imported by dashboard/ production code or the
 * Vite build, only by `tsc` (via tsconfig.test.json, issue #750's shrink-only
 * test-typecheck ratchet) and `node --experimental-strip-types` at test time.
 *
 * The technique: assign a value of the REAL response type (inferred from the
 * zod schema — the source of truth) into a variable typed as the dashboard's
 * mirrored interface. TypeScript's structural typing allows the mirrored type
 * to be a narrower VIEW of the real response (declaring fewer fields is
 * fine — e.g. `AutopilotTickPayload` intentionally omits `lifecycle`), but if
 * the API drops/renames a field the mirrored type still declares, or narrows/
 * widens a field's type incompatibly (this caught a REAL drift: the
 * dashboard's `source` union was missing `"subagent"`, added to the API by
 * issue #692 — see the `derive-sprite-state.ts` / `battle-card-state.ts` fixes
 * alongside this test), the assignment fails to compile. That turns a silent
 * runtime rendering bug into a loud `tsc` failure.
 *
 * `DeepRequired` below exists ONLY to work around a zod 4.4.3 z.infer quirk
 * unrelated to this contract: `.nullable()` fields (used throughout
 * now-page.ts, e.g. `lastTickAt`, `currentRun`) infer as an OPTIONAL key
 * (`lastTickAt?: string`) rather than a required `string | null` key. Left
 * unnormalized, every nullable field would fail the assignment against the
 * dashboard's required, explicitly-`| null`-typed mirror — a false positive
 * with nothing to do with real drift. `DeepRequired` strips that spurious
 * optionality so the check tests what actually matters: a field's PRESENCE
 * and its non-null value type. A real drift (field removed/renamed, or a
 * value type narrowed/widened incompatibly) still fails to compile; only the
 * zod-version artifact is neutralized.
 *
 * COMPILE-TIME ONLY: the runtime assertion below just proves the module
 * loaded. The actual guard is the type annotations on the two `as unknown as
 * DeepRequired<...>` fixtures below (an empty object cast to the real
 * response type — a value that only needs to exist for the ASSIGNMENT that
 * follows it to be checked; its runtime shape is irrelevant, nothing reads
 * through it). `tsc` type-checks the assignment fully; `node
 * --experimental-strip-types` erases the type annotations and casts, leaving
 * two harmless `const x = {};` literals, so this file is also a normal
 * (trivially passing) runtime test. Trust `npm run typecheck:test`, not
 * `npm test`, to catch a real drift here.
 *
 * Turn-record shapes (`oak-tab-state.ts`'s `TurnAction`/`TurnRecord`,
 * mirrored from `/api/autopilot/runs/current` `turns[]`) are deliberately
 * NOT covered here: the upstream shape is `Array<Record<string, unknown>>`
 * end to end (src/autopilot/run-projections.ts's `fetchTurnsWithJoins`, fed
 * by the intentionally loose/passthrough `TurnActionSchema` in
 * src/autopilot/schemas.ts, which types only `{ type?: string }` and lets
 * the autopilot's Python dispatcher attach arbitrary extra fields). There is
 * no canonical src/ type to assign FROM for that boundary, so a compile-time
 * contract there would vacuously pass regardless of drift — a real guard
 * would need a runtime shape probe against a live example, out of scope here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AutopilotTickResponse,
  ActiveDispatchesResponse,
} from "../src/schemas/now-page.ts";
import type {
  AutopilotTickPayload,
  ActiveDispatchesPayload,
} from "../dashboard/src/pages/now-pixel/derive-sprite-state.ts";

/**
 * Recursively strip optionality (`?:`) from every key so a zod-inferred
 * "optional-because-nullable" field (see file header) compares as present.
 * Leaves the underlying value type untouched — a genuinely removed/renamed
 * field, or an incompatibly-retyped one, still fails the assignment below.
 */
type DeepRequired<T> = T extends readonly (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T;

// ---------------------------------------------------------------------------
// Contract 1 — GET /api/v2/now/autopilot-tick
// ---------------------------------------------------------------------------
//
// `AutopilotTickPayload` (dashboard) intentionally omits `lifecycle` — the
// widget derives everything it needs from `running`/`currentRun`/`lastTickAt`.
// Structural typing allows that narrowing; what it CANNOT allow is the
// dashboard type requiring a field the real response no longer has, or typing
// a shared field incompatibly (e.g. `currentRun.turns` becoming a string).
const apiAutopilotTick = {} as unknown as DeepRequired<AutopilotTickResponse>;
const _autopilotTickContract: AutopilotTickPayload = apiAutopilotTick;

// ---------------------------------------------------------------------------
// Contract 2 — GET /api/v2/now/active-dispatches
// ---------------------------------------------------------------------------
const apiActiveDispatches = {} as unknown as DeepRequired<ActiveDispatchesResponse>;
const _activeDispatchesContract: ActiveDispatchesPayload = apiActiveDispatches;

test("dashboard response-shape contract compiles (see type-level checks above)", () => {
  // The real assertion lives at compile time: `npm run typecheck:test` fails
  // loud the moment either assignment above stops type-checking. This runtime
  // test only confirms the module graph (src/schemas + dashboard/src) loads
  // cleanly under `node --experimental-strip-types`, where the type-only
  // imports and annotations above erase to nothing.
  assert.ok(true, "module loaded; the drift guard is the two assignments above");
});
