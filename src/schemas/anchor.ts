/**
 * Query schema for `GET /api/anchor/candidates` (ADR-0022, slice 4 / issue #1037).
 *
 * Migrates the three raw `req.query.<field>` reads in `src/api/anchor.ts` into
 * the **Schemas** Seam so the route reads a typed, always-present result off a
 * single zod parse instead of hand-rolling `parseInt` + `String(...).toLowerCase()`.
 *
 * The two default-true exclusion flags (`excludeInFlight`, `excludeMerged`) use
 * `booleanFlag(true)` from `common.ts`: absent → `true`, and the canonical
 * opt-out value `"false"` → `false` (also `"0"`/`"no"`/`"off"`), matching the
 * documented opt-out behaviour on issues #640 / #882. This is lenient on
 * non-canonical garbage exactly as ADR-0022 §3 prescribes — a value like
 * `?excludeMerged=foo` now collapses to `false` rather than the legacy
 * `!== "false"` truthiness, which the read surface treats as a client choice,
 * never an error.
 */
import { z } from "zod";
import { booleanFlag, countQuerySchema } from "./common.ts";

const DEFAULT_LIMIT = 10;

/**
 * `GET /api/anchor/candidates?limit=N&excludeInFlight=…&excludeMerged=…`.
 *
 * `limit` reuses `countQuerySchema(DEFAULT_LIMIT)` with the factory's default
 * 1000 cap (NOT the route's 50 ceiling): the legacy route passed the raw
 * positive integer straight to `getCandidateFeed`, which itself clamps to
 * `MAX_LIMIT` (50). Reproducing that here — pass the parsed number through and
 * let `getCandidateFeed` clamp — keeps `?limit=100` collapsing to 50 (a clamp,
 * not a reject-to-default), while absent/non-numeric still collapses to 10
 * (= `DEFAULT_LIMIT`). Non-strict so the two flag params parse alongside it.
 */
export const AnchorCandidatesQuerySchema = z.object({
  ...countQuerySchema(DEFAULT_LIMIT).shape,
  excludeInFlight: booleanFlag(true),
  excludeMerged: booleanFlag(true),
  // `inlineMode` (issue #2075) defaults FALSE: a spawn-capable dispatch (and the
  // raw operator view) sees every candidate. An inline-mode caller passes
  // `?inlineMode=true` to suppress anchors flagged `dispatch-spawn-capable`
  // (not inline-buildable). Uses `booleanFlag(false)` so absent → false and the
  // canonical opt-in value `"true"` → true, the mirror of the two exclusion
  // flags' default-true opt-out shape.
  inlineMode: booleanFlag(false),
  // `excludeNonPrDeliverable` (issue #2282) defaults TRUE: an anchor that is
  // host-systemd-only / operator-gated / live-data is deliverable by no
  // code-writing dispatch, so the feed hides it for every caller. The raw
  // operator view opts out with `?excludeNonPrDeliverable=false`. Uses
  // `booleanFlag(true)` — the same default-true opt-out shape as the two
  // exclusion flags above.
  excludeNonPrDeliverable: booleanFlag(true),
});
