import { Routes, Route } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { ToastProvider } from "./hooks/useToast.jsx";
import Layout from "./components/Layout.jsx";
import Today from "./pages/Today.jsx";
import NowPixel from "./pages/now-pixel/NowPixel.jsx";
import NowClassic from "./pages/NowClassic.jsx";
import Outcomes from "./pages/Outcomes.jsx";
import Explore from "./pages/Explore.jsx";
import Autopilot from "./pages/Autopilot.jsx";
import DispatchTranscript from "./pages/DispatchTranscript.jsx";

// Dashboard atomic swap #2 (epic #642 — /now-pixel). PR2 of slice 7
// (#649) makes the pixel-habitat view the canonical /now and renames
// the legacy six-widget view to /now-classic. The classic route lingers
// as a fallback through 2026-06-10, matching the 2-week window used
// for the original dashboard-v2 swap (PRD #615).
//
// /now-pixel is retained as an alias so any operator bookmarks from the
// preview window keep working until the cleanup PR.
export default function App() {
  const ws = useWebSocket();

  return (
    <ToastProvider>
      <Layout connected={ws.connected}>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/now" element={<NowPixel ws={ws} />} />
          <Route path="/now-classic" element={<NowClassic ws={ws} />} />
          {/* /now-pixel — preview URL retained as alias for 2 weeks. */}
          <Route path="/now-pixel" element={<NowPixel ws={ws} />} />
          <Route path="/outcomes" element={<Outcomes />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/explore/:tab" element={<Explore />} />
          {/* Slice 4 (issue #500) — per-run autopilot detail page. */}
          <Route path="/autopilot/:runId" element={<Autopilot />} />
          {/* Issue #695 — subagent transcript viewer (deep-linkable). */}
          <Route path="/dispatch/:dispatchId/transcript" element={<DispatchTranscript />} />
        </Routes>
      </Layout>
    </ToastProvider>
  );
}
