/**
 * Query schemas for the tool-scout read routes (ADR-0022, slice 4 / issue #1037).
 *
 * Migrates the two raw `parseInt(req.query.x)` reads in `src/api/scout.ts`:
 *   - `GET /scout/stats?window=N`     → `ScoutStatsQuerySchema`
 *   - `GET /scout/dispatches?limit=N` → `ScoutDispatchesQuerySchema`
 *
 * Both reuse `countQuerySchema` from `common.ts`; the legacy default-on-garbage
 * (`parseInt("abc") || N`) and the `window` clamp to the rollup max are folded
 * into the schema's `.catch(default)` + `max` clamp, so the routes read a
 * typed, always-present number without re-implementing the coercion.
 */
import { z } from "zod";
import { countQuerySchema } from "./common.ts";

const DEFAULT_STATS_WINDOW_DAYS = 7;
const DEFAULT_DISPATCHES_LIMIT = 50;

/**
 * `GET /scout/stats?window=N` — days of rollup. Absent/non-numeric → 7.
 *
 * Uses the factory's default 1000 cap rather than passing
 * `MAX_ROLLUP_WINDOW_DAYS` as the schema `max`: the legacy route *clamped*
 * an over-range value (`Math.min(MAX_ROLLUP_WINDOW_DAYS, rawWindow)`), whereas
 * the factory's `max` *rejects* (collapsing to the default). To preserve the
 * clamp-not-reject semantics, the route applies `Math.min(..., window)` after
 * the parse; the schema only owns the seam read + default-on-garbage.
 */
export const ScoutStatsQuerySchema = z.object({
  window: countQuerySchema(DEFAULT_STATS_WINDOW_DAYS).shape.count,
});

/**
 * `GET /scout/dispatches?limit=N` — newest-first audit page size.
 * Absent/non-numeric → 50; exposed under the `limit` key.
 */
export const ScoutDispatchesQuerySchema = z.object({
  limit: countQuerySchema(DEFAULT_DISPATCHES_LIMIT).shape.count,
});
