import { Router } from "express";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Operational-command HTTP surface (issue #2183).
 *
 * `POST /kill` is an emergency-stop command — it writes the kill file that
 * `health.ts` and `service-strip.ts` poll (`~/hydra/.kill`). It was previously
 * an "orphan operational" route in `src/api/misc.ts`; issue #2183 gave the
 * emergency-stop commands their own minimal Module so future operational-only
 * endpoints have a domain home rather than re-creating the catch-all.
 *
 * The HTTP path is unchanged (`/kill`); only the owning Module moved.
 */
export function createOperationalRouter() {
  const router = Router();

  const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
  const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

  // POST /kill — Emergency stop. Writes the kill file that health.ts and
  // service-strip.ts poll (~/hydra/.kill). The in-process control loop was
  // removed in #383; the dead killCycle() call was stripped in #701.
  router.post("/kill", async (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    res.json({ killed: true, killFile: KILL_FILE });
  });

  return router;
}
