import { Routes, Route } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { ToastProvider } from "./hooks/useToast.jsx";
import Layout from "./components/Layout.jsx";
import Overview from "./pages/Overview.jsx";
import Backlog from "./pages/Backlog.jsx";
import Metrics from "./pages/Metrics.jsx";
import Proposals from "./pages/Proposals.jsx";
import Queue from "./pages/Queue.jsx";
import Search from "./pages/Search.jsx";
import Health from "./pages/Health.jsx";
import Agents from "./pages/Agents.jsx";
import Vision from "./pages/Vision.jsx";
import Config from "./pages/Config.jsx";
import Roadmap from "./pages/Roadmap.jsx";
import Architecture from "./pages/Architecture.jsx";
import EnvVars from "./pages/EnvVars.jsx";
import Calibration from "./pages/Calibration.jsx";
import Checklist from "./pages/Checklist.jsx";
import Outcomes from "./pages/Outcomes.jsx";
import Autopilot from "./pages/Autopilot.jsx";
import AgentStream from "./pages/AgentStream.jsx";

export default function App() {
  const ws = useWebSocket();

  return (
    <ToastProvider>
      <Layout connected={ws.connected}>
        <Routes>
          <Route path="/" element={<Overview ws={ws} />} />
          <Route path="/vision" element={<Vision />} />
          <Route path="/roadmap" element={<Roadmap />} />
          <Route path="/backlog" element={<Backlog />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/proposals" element={<Proposals />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/search" element={<Search />} />
          <Route path="/health" element={<Health />} />
          <Route path="/config" element={<Config />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="/env" element={<EnvVars />} />
          <Route path="/outcomes" element={<Outcomes />} />
          <Route path="/calibration" element={<Calibration />} />
          <Route path="/checklist" element={<Checklist />} />
          <Route path="/autopilot" element={<Autopilot />} />
          {/* Slice 4 (issue #500) — per-run detail page. */}
          <Route path="/autopilot/:runId" element={<Autopilot />} />
          {/* Slice 4 (issue #500) — AgentStream subroute for the `?agent=`
              cross-link filter. The bare /agents route still maps to the
              memory page. */}
          <Route path="/agents/stream" element={<AgentStream ws={ws} />} />
        </Routes>
      </Layout>
    </ToastProvider>
  );
}
