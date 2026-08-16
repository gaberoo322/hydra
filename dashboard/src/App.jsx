import { Routes, Route, useParams, Navigate } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { ToastProvider } from "./hooks/useToast.jsx";
import Layout from "./components/Layout.jsx";
import Today from "./pages/Today.jsx";
import Health from "./pages/Health.jsx";
import Runs from "./pages/Runs.jsx";
import Work from "./pages/Work.jsx";
import NowConsole from "./pages/now-console/NowConsole.jsx";
import Builder from "./pages/Builder.jsx";
import Autopilot from "./pages/Autopilot.jsx";
import DispatchTranscript from "./pages/DispatchTranscript.jsx";

// Dashboard v3 slice eta (#4012, ADR-0034 §3 "What dies"): the Orchestrator
// Map, Anomalies tab, Now Habitat, Outcomes page, and the Explore container
// are retired. Their deep links redirect to the pages that absorbed their
// content (client-side <Navigate replace>, the #4009 LegacyRunRedirect
// precedent); every leaf component they rendered stays on disk, unrouted,
// for a follow-up hydra-cleanup/knip pass.

/**
 * NowRoute — /now shell. The Console/Habitat mode toggle collapsed with the
 * Habitat (ADR-0034 §3): the `?view=` deep-link param and the localStorage
 * view-mode machinery are gone, and /now renders the surviving diagnostics
 * Console unconditionally — an old `/now?view=habitat` deep link degrades
 * to Console content in place rather than 404ing.
 */
function NowRoute() {
  return (
    <div className="space-y-4" data-testid="now-route">
      <h1 className="text-2xl font-bold">Now</h1>
      <NowConsole />
    </div>
  );
}

/**
 * LegacyRunRedirect — `/autopilot/:runId` → `/runs/:runId` (issue #4009,
 * INV-5). ADR-0034's consequence: "deep links break … redirects map to the
 * pages that absorbed their content." The run detail now lives in the /runs
 * forensics spine; the old deep link (HistoryTable rows, bookmarks, chat
 * references) must still resolve, so it redirects rather than 404s. Parameter
 * is forwarded verbatim — a redirect that dropped it would break the link it
 * exists to preserve.
 */
function LegacyRunRedirect() {
  const { runId } = useParams();
  return <Navigate replace to={runId ? `/runs/${runId}` : "/runs"} />;
}

/**
 * Where each retired `/explore/:tab` deep link lands — the page that
 * absorbed that tab's content (ADR-0034 §3). Friction and Behavior folded
 * into the /runs forensics spine, Flow into the / attention feed, Lessons
 * into /builder; Architecture follows Lessons to /builder (Builder.jsx
 * already renders the re-rendered architecture view as TangledModules).
 * Anomalies and the Orchestrator Map have no named successor anywhere —
 * their endpoints are dead — so they fall back to /.
 */
const EXPLORE_TAB_REDIRECTS = {
  friction: "/runs",
  behavior: "/runs",
  flow: "/",
  lessons: "/builder",
  architecture: "/builder",
  anomalies: "/",
  "orchestrator-map": "/",
};

// Explore.jsx previously sent bare /explore and unrecognized tabs to its
// default tab (friction); friction's successor is /runs, so the fallback
// folds there too.
const EXPLORE_DEFAULT_TAB = "friction";

/**
 * ExploreRedirect — `/explore` and `/explore/:tab` retired-route handler
 * (issue #4012, INV-2). A replace-redirect, never a 404: bookmarks and chat
 * references still pointing at a dead tab land on the page that owns its
 * content now.
 */
function ExploreRedirect() {
  const { tab } = useParams();
  const to = EXPLORE_TAB_REDIRECTS[tab ?? ""] ?? EXPLORE_TAB_REDIRECTS[EXPLORE_DEFAULT_TAB];
  return <Navigate replace to={to} />;
}

export default function App() {
  const ws = useWebSocket();

  return (
    <ToastProvider>
      <Layout connected={ws.connected}>
        <Routes>
          <Route path="/" element={<Today />} />
          {/* Dashboard v3 slice gamma (#4008, ADR-0034) — the phone-grade
              is-it-on-fire / burning-money surface. */}
          <Route path="/health" element={<Health />} />
          <Route path="/now" element={<NowRoute />} />
          {/* Dashboard v3 (ADR-0034 §2) — the weekly journey, slice zeta (#4011). */}
          <Route path="/builder" element={<Builder />} />
          {/* Dashboard v3 (ADR-0034 §2) — the forensics journey, slice delta
              (#4009): runs list → run detail → transcript. */}
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:runId" element={<Autopilot />} />
          {/* Dashboard v3 (ADR-0034 §2) — the acting surface, slice epsilon
              (#4010): board state + ready-for-agent queue + actions + the
              anchor-distribution rationale. */}
          <Route path="/work" element={<Work />} />
          {/* Legacy deep link (was the run detail's only home until #4009) —
              redirect, never 404 (INV-5). */}
          <Route path="/autopilot/:runId" element={<LegacyRunRedirect />} />
          {/* Issue #695 — subagent transcript viewer (deep-linkable). */}
          <Route path="/dispatch/:dispatchId/transcript" element={<DispatchTranscript />} />
          {/* Retired surfaces (issue #4012, ADR-0034 §3) — redirects, never
              404s. /outcomes content was re-homed by question: cost → /health,
              quality → /builder; the quality majority lives on /builder. */}
          <Route path="/outcomes" element={<Navigate replace to="/builder" />} />
          <Route path="/explore" element={<Navigate replace to="/runs" />} />
          <Route path="/explore/:tab" element={<ExploreRedirect />} />
        </Routes>
      </Layout>
    </ToastProvider>
  );
}
