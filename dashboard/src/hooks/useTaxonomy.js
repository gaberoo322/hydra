import { useState, useEffect } from "react";
import { API_BASE } from "../lib/autopilot-format.js";

// The dispatch-class alphabet drives the pipeline-snapshot grid layout. It is
// owned by the Dispatch-Class Taxonomy (scripts/autopilot/classes.json) and
// served by GET /api/taxonomy/classes (issue #2524). The constants below are
// now only the BUILT-IN FALLBACK used until the fetch lands (or if the endpoint
// is unreachable) — `useTaxonomy()` substitutes the live alphabet at runtime so
// adding/retiring a class no longer requires editing this file.
//
// Extracted from dashboard/src/pages/Autopilot.jsx (issue #3589) into a named,
// reusable hook module so a future page that wants the taxonomy can import it.
const FALLBACK_PIPELINE_SLOTS = ["dev_orch", "qa_orch", "research_orch", "dev_target", "qa_target", "research_target"];
const FALLBACK_SIGNAL_CLASSES = ["health", "sweep_orch", "sweep_target", "discover_orch", "discover_target"];
const FALLBACK_SIGNAL_COOLDOWN_SEC = {
  health: 0,
  sweep_orch: 900,
  sweep_target: 900,
  discover_orch: 1800,
  discover_target: 1800,
};

/**
 * Fetch the live dispatch-class alphabet from GET /api/taxonomy/classes,
 * falling back to the built-in constants until the fetch resolves or if the
 * endpoint is unreachable / degraded. Never throws — a failed or degraded
 * response keeps the built-in defaults so the page renders regardless (the
 * load-bearing tolerate-unreachable-endpoint invariant from issue #2524).
 */
export function useTaxonomy() {
  const [taxonomy, setTaxonomy] = useState({
    pipelineSlots: FALLBACK_PIPELINE_SLOTS,
    signalClasses: FALLBACK_SIGNAL_CLASSES,
    signalCooldowns: FALLBACK_SIGNAL_COOLDOWN_SEC,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/taxonomy/classes`);
        if (!res.ok) return; // keep fallback
        const body = await res.json();
        if (cancelled || !body || body.degraded) return; // keep fallback
        const pipelineSlots = Array.isArray(body.pipelineSlots) && body.pipelineSlots.length > 0
          ? body.pipelineSlots : FALLBACK_PIPELINE_SLOTS;
        const signalClasses = Array.isArray(body.signalClasses) && body.signalClasses.length > 0
          ? body.signalClasses : FALLBACK_SIGNAL_CLASSES;
        const signalCooldowns = body.signalCooldowns && typeof body.signalCooldowns === "object"
          ? body.signalCooldowns : FALLBACK_SIGNAL_COOLDOWN_SEC;
        setTaxonomy({ pipelineSlots, signalClasses, signalCooldowns });
      } catch {
        // Unreachable endpoint — keep the built-in fallback alphabet.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return taxonomy;
}
