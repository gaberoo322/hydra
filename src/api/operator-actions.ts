/**
 * Operator-action registry read surface (issue #4620, ADR-0034 §8.2 — slice 1
 * of the guidance-epic #4619).
 *
 *   GET /api/operator-actions → { entries: OperatorActionEntry[] }
 *
 * Pure read over the already-validated, import-time-frozen
 * `src/operator-actions/registry.ts` REGISTRY — no Redis, no query params, no
 * writes, no `eventBus` (this router emits nothing). Templates are served
 * UNRESOLVED (`{repo}`/`{number}` placeholders intact); resolving them against
 * a specific item's context is the feed composer's job (a later slice), not
 * this read surface's.
 *
 * Always 200: the registry either loaded (in which case it is valid, by the
 * fail-loud-at-import contract in registry.ts) or the module import itself
 * threw and the process never reached a point where this router could be
 * mounted. There is no partial-load state to report as a 500 here.
 */

import { Router } from "express";
import { REGISTRY } from "../operator-actions/registry.ts";
import type { OperatorActionsResponse } from "../schemas/operator-actions.ts";

export function createOperatorActionsRouter() {
  const router = Router();

  router.get("/operator-actions", (_req, res) => {
    const body: OperatorActionsResponse = { entries: [...REGISTRY] };
    res.json(body);
  });

  return router;
}
