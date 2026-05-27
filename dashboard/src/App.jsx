import { Routes, Route } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { ToastProvider } from "./hooks/useToast.jsx";
import Layout from "./components/Layout.jsx";
import Today from "./pages/Today.jsx";
import Now from "./pages/Now.jsx";
import NowPixel from "./pages/now-pixel/NowPixel.jsx";
import Outcomes from "./pages/Outcomes.jsx";
import Explore from "./pages/Explore.jsx";
import Autopilot from "./pages/Autopilot.jsx";

// Dashboard atomic swap (issue #621 / PRD #615). The legacy top-level
// routes (Overview, Backlog, Metrics, Vision, Roadmap, Config, EnvVars,
// Checklist, Agents, AgentStream, Calibration, Queue, Alerts, CycleStatus,
// Search, Architecture, Health) were retired in slice 6 along with the
// dashboard-v2 incremental-delivery URL prefix. Today, Now, Outcomes,
// Explore are now the only top-level pages; the only other surface is
// the per-run autopilot detail at `/autopilot/:runId`.
export default function App() {
  const ws = useWebSocket();

  return (
    <ToastProvider>
      <Layout connected={ws.connected}>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/now" element={<Now ws={ws} />} />
          {/* /now-pixel — Pokemon-habitat preview (epic #642, slice 2).
              Reachable by direct URL only; the nav link arrives in slice 7
              and the atomic swap to /now ships after that. */}
          <Route path="/now-pixel" element={<NowPixel ws={ws} />} />
          <Route path="/outcomes" element={<Outcomes />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/explore/:tab" element={<Explore />} />
          {/* Slice 4 (issue #500) — per-run autopilot detail page. The list
              view was retired with the legacy /autopilot top-level route. */}
          <Route path="/autopilot/:runId" element={<Autopilot />} />
        </Routes>
      </Layout>
    </ToastProvider>
  );
}
