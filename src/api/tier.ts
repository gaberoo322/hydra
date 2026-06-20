import { Router } from "express";
import { classifyChange } from "../tier-classifier.ts";
import { TierQuerySchema } from "../schemas/tier.ts";

/**
 * Tier-classification HTTP surface (issue #2183).
 *
 * `GET /tier?files=a,b,c` is the HTTP wrapper for `classifyChange()` from
 * `src/tier-classifier.ts` — the same domain. It was previously an "orphan
 * operational" route in `src/api/misc.ts`; issue #2183 moved it next to its
 * domain so a caller adding a new tier-classification endpoint has a natural
 * landing place, and so the query schema lives in `src/schemas/tier.ts` like
 * every other API boundary contract.
 *
 * The HTTP path is unchanged (`/tier`); only the owning Module moved.
 */
export function createTierRouter() {
  const router = Router();

  // GET /tier?files=a,b,c — Modification tier classification (issue #243,
  // ADR-0004 work-order step 3). Used by autopilot/dashboard to know
  // which merge policy applies to a proposed change.
  router.get("/tier", (req, res) => {
    // ADR-0022: read `files` through the Schemas seam. Required-present (string
    // or array) but may be empty; the route owns its bespoke 400 on absence.
    const parsed = TierQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Missing query parameter 'files' (comma-separated)" });
    }
    const raw = parsed.data.files;
    const list = Array.isArray(raw) ? raw.flatMap(s => String(s).split(",")) : String(raw).split(",");
    const files = list.map(s => s.trim()).filter(s => s.length > 0);
    const result = classifyChange(files);
    res.json(result);
  });

  return router;
}
