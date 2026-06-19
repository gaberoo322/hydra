/**
 * Schema for POST /backlog/claim and PATCH /backlog/:id/move request bodies.
 *
 * Why this exists: the claim route used to read only `claimedBy` from the raw
 * body and silently discarded everything else — including the `itemId` hint
 * agents already send for targeted claims (run 60a0624c claimed the queue
 * head instead of the requested item). Silent discard of a meaningful field
 * is exactly the contract-drift class the Schemas seam targets, so the body
 * now parses through zod with `.strict()` (mirroring `schemas/queue.ts`,
 * #562/#1140): legitimate fields are enumerated, and a typo'd key such as
 * `itemID` fails loudly with a 400 instead of degrading to a pop-head claim.
 *
 * Issue #2164: BacklogMoveBodySchema added — the PATCH /backlog/:id/move
 * handler previously dropped the `reason` field, making it impossible to
 * move an item to the blocked lane over HTTP (moveItemToLane requires a
 * reason for unexplained blocked moves and returns {ok:false,
 * error:"missing-blocked-reason"} without one).
 */
import { z } from "zod";

/**
 * Body accepted by `PATCH /backlog/:id/move` (issue #2164).
 *
 * - `lane` is required — the target lane name.
 * - `claimedBy` is optional consumer identity tag (forwarded to moveItemToLane).
 * - `reason` is required by moveItemToLane when moving to the `blocked` lane
 *   and the item has no pre-existing `meta.blockedReason`. Omitting it from
 *   the HTTP boundary caused silent {ok:false} on blocked-lane moves (#2164).
 * - Not `.strict()` — unknown fields are ignored so the endpoint degrades
 *   gracefully if a caller sends extra context keys.
 */
export const BacklogMoveBodySchema = z.object({
  lane: z.string().min(1, { message: "lane must be a non-empty string" }),
  claimedBy: z
    .string({ message: "claimedBy must be a string" })
    .optional(),
  reason: z
    .string({ message: "reason must be a string" })
    .optional(),
});

/**
 * Body accepted by `POST /backlog/claim`.
 *
 * - `claimedBy` is optional consumer identity; the route defaults it to
 *   "claude" when omitted (pre-#1682 behavior, byte-compatible).
 * - `itemId` is optional. When present, the claim targets that specific
 *   queued item instead of popping the queue head. Trimmed, >=1 char, so a
 *   whitespace-only id can't masquerade as a pop-head request.
 * - `.strict()`: an empty/absent body still parses to `{}`, but unknown keys
 *   400 with `schema-validation-failed` rather than being silently ignored.
 */
export const BacklogClaimBodySchema = z
  .object({
    claimedBy: z
      .string({ message: "claimedBy must be a string" })
      .trim()
      .min(1, { message: "claimedBy must be a non-empty string" })
      .optional(),
    itemId: z
      .string({ message: "itemId must be a string" })
      .trim()
      .min(1, { message: "itemId must be a non-empty string" })
      .optional(),
  })
  .strict();
