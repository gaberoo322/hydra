import { useState, useEffect } from "react";
import { API_BASE } from "../lib/autopilot-format.js";

// The dispatch-class alphabet drives the pipeline-snapshot grid layout. It is
// owned by the Dispatch-Class Taxonomy (scripts/autopilot/classes.json) and
// served by GET /api/taxonomy/classes (issue #2524).
//
// Issue #4637 (ADR-0034 §5 trust contract): there is NO built-in fallback
// alphabet any more. The old FALLBACK_* arrays had drifted (6 slots / 5
// signals against a live 7 / 15) and rendered a confident wrong grid whenever
// the fetch had not landed or failed. Unverifiable now renders UNKNOWN: until
// the route answers with a non-empty, non-degraded alphabet the hook reports
// `status: "loading" | "unknown"` with `taxonomy: null`, and callers render an
// UNKNOWN placeholder instead of a fabricated grid.
//
// Extracted from dashboard/src/pages/Autopilot.jsx (issue #3589) into a named,
// reusable hook module so a future page that wants the taxonomy can import it.

/**
 * Fetch the live dispatch-class alphabet from GET /api/taxonomy/classes.
 *
 * @returns {{
 *   taxonomy: null | { pipelineSlots: string[], signalClasses: string[] },
 *   status: "loading" | "ready" | "unknown",
 * }}
 *   `ready` only when the route answered ok, not degraded, with BOTH lists
 *   non-empty. A non-ok, degraded:true, empty or thrown fetch yields
 *   `unknown` with `taxonomy: null` — never a fabricated alphabet. Never
 *   throws.
 */
export function useTaxonomy() {
  const [state, setState] = useState({ taxonomy: null, status: "loading" });
  useEffect(() => {
    let cancelled = false;
    const unknown = () => {
      if (!cancelled) setState({ taxonomy: null, status: "unknown" });
    };
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/taxonomy/classes`);
        if (!res.ok) {
          console.error(`[useTaxonomy] GET /taxonomy/classes answered ${res.status} — alphabet UNKNOWN`);
          unknown();
          return;
        }
        const body = await res.json();
        if (cancelled) return;
        const pipelineSlots = Array.isArray(body?.pipelineSlots) ? body.pipelineSlots : [];
        const signalClasses = Array.isArray(body?.signalClasses) ? body.signalClasses : [];
        if (!body || body.degraded || pipelineSlots.length === 0 || signalClasses.length === 0) {
          console.error("[useTaxonomy] GET /taxonomy/classes degraded or empty — alphabet UNKNOWN");
          unknown();
          return;
        }
        setState({ taxonomy: { pipelineSlots, signalClasses }, status: "ready" });
      } catch (err) {
        console.error("[useTaxonomy] GET /taxonomy/classes failed — alphabet UNKNOWN", err);
        unknown();
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return state;
}
