import { Router } from "express";
import { getAllReflections, getReflectionEffectiveness } from "../reflections/reflections.ts";
import { getTargetName } from "../target-config.ts";

/**
 * Reflections + calibration proxy routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Calibration outcomes are
 * proxied from the target project (hydra-betting); reflections are the
 * episodic learning surface (`hydra:reflections:{anchor}`).
 */
export function createReflectionsRouter() {
  const router = Router();

  const HYDRA_BETTING_URL = process.env.HYDRA_BETTING_URL || "http://localhost:3333";

  // GET /reflections — All recent episodic reflections
  router.get("/reflections", async (req, res) => {
    try {
      const reflections = await getAllReflections();
      res.json({ reflections, count: reflections.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /reflections/effectiveness — Per-anchor effectiveness scores (issue #150)
  router.get("/reflections/effectiveness", async (req, res) => {
    try {
      const result = await getReflectionEffectiveness();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /calibration/outcomes — Proxy to target project's calibration API
  router.get("/calibration/outcomes", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      const url = `${HYDRA_BETTING_URL}/api/calibration/outcomes${qs ? `?${qs}` : ""}`;
      const response = await fetch(url);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: `${getTargetName()} unavailable: ${err.message}` });
    }
  });

  router.post("/calibration/outcomes/sync", async (req, res) => {
    try {
      const response = await fetch(`${HYDRA_BETTING_URL}/api/calibration/outcomes/sync`, { method: "POST" });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: `${getTargetName()} unavailable: ${err.message}` });
    }
  });

  return router;
}
