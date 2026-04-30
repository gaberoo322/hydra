import { Routes, Route } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { ToastProvider } from "./hooks/useToast.jsx";
import Layout from "./components/Layout.jsx";
import Overview from "./pages/Overview.jsx";
import CycleStatus from "./pages/CycleStatus.jsx";
import Backlog from "./pages/Backlog.jsx";
import Metrics from "./pages/Metrics.jsx";
import Proposals from "./pages/Proposals.jsx";
import Queue from "./pages/Queue.jsx";
import Search from "./pages/Search.jsx";
import Health from "./pages/Health.jsx";
import Agents from "./pages/Agents.jsx";
import Vision from "./pages/Vision.jsx";
import Alerts from "./pages/Alerts.jsx";
import Config from "./pages/Config.jsx";
import Roadmap from "./pages/Roadmap.jsx";
import AgentStream from "./pages/AgentStream.jsx";
import Architecture from "./pages/Architecture.jsx";
import EnvVars from "./pages/EnvVars.jsx";
import Calibration from "./pages/Calibration.jsx";

export default function App() {
  const ws = useWebSocket();

  return (
    <ToastProvider>
      <Layout connected={ws.connected}>
        <Routes>
          <Route path="/" element={<Overview ws={ws} />} />
          <Route path="/alerts" element={<Alerts ws={ws} />} />
          <Route path="/vision" element={<Vision />} />
          <Route path="/roadmap" element={<Roadmap />} />
          <Route path="/cycles" element={<CycleStatus ws={ws} />} />
          <Route path="/backlog" element={<Backlog />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/proposals" element={<Proposals />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/search" element={<Search />} />
          <Route path="/health" element={<Health />} />
          <Route path="/agents/live" element={<AgentStream ws={ws} />} />
          <Route path="/config" element={<Config />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="/env" element={<EnvVars />} />
          <Route path="/calibration" element={<Calibration />} />
        </Routes>
      </Layout>
    </ToastProvider>
  );
}
