import { Routes, Route, useSearchParams } from "react-router-dom";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { ToastProvider } from "./hooks/useToast.jsx";
import Layout from "./components/Layout.jsx";
import Today from "./pages/Today.jsx";
import NowConsole from "./pages/now-console/NowConsole.jsx";
import NowPixel from "./pages/now-pixel/NowPixel.jsx";
import NowClassic from "./pages/NowClassic.jsx";
import Outcomes from "./pages/Outcomes.jsx";
import Explore from "./pages/Explore.jsx";
import Autopilot from "./pages/Autopilot.jsx";
import DispatchTranscript from "./pages/DispatchTranscript.jsx";
import {
  NOW_VIEW_QUERY_KEY,
  VIEW_CONSOLE,
  VIEW_HABITAT,
  resolveNowView,
  writeStoredNowView,
} from "./pages/now-console/console-state.ts";

// Dashboard atomic swap #2 (epic #642 — /now-pixel). PR2 of slice 7
// (#649) made the pixel-habitat view the canonical /now. The /now Console
// redesign (epic #887, issue #891) then made /now a mode-toggled shell:
// the diagnostics Console is the default surface and the pixel Habitat is
// the preserved alternate. The /now-classic route lingers as a fallback
// through 2026-06-10 (PRD #615 window).
//
// /now-pixel is retained as a direct-to-Habitat alias for old bookmarks.

/**
 * NowRoute — /now mode-toggle shell (issue #891, now-console-4).
 *
 * Resolves the active view from the `?view=` deep-link first, then
 * localStorage, then the Console default (console-state.resolveNowView).
 * Selecting a mode writes BOTH the query param (shareable URL) and
 * localStorage (survives reloads).
 */
function NowRoute({ ws }) {
  const [params, setParams] = useSearchParams();
  const view = resolveNowView(
    params.get(NOW_VIEW_QUERY_KEY),
    typeof window !== "undefined" ? window.localStorage : null,
  );

  const select = (next) => {
    writeStoredNowView(
      typeof window !== "undefined" ? window.localStorage : null,
      next,
    );
    const p = new URLSearchParams(params);
    p.set(NOW_VIEW_QUERY_KEY, next);
    setParams(p, { replace: true });
  };

  const tab = (mode, label) => (
    <button
      type="button"
      data-testid={`now-view-toggle-${mode}`}
      data-active={view === mode ? "true" : "false"}
      aria-pressed={view === mode}
      onClick={() => select(mode)}
      className={`px-3 py-1 text-xs rounded-md border transition-colors ${
        view === mode
          ? "bg-zinc-100 text-zinc-900 border-zinc-100 font-semibold"
          : "bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4" data-testid="now-route" data-view={view}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Now</h1>
        <div className="flex gap-1" role="group" aria-label="Now view mode">
          {tab(VIEW_CONSOLE, "Console")}
          {tab(VIEW_HABITAT, "Habitat")}
        </div>
      </div>
      {view === VIEW_HABITAT ? <NowPixel ws={ws} /> : <NowConsole />}
    </div>
  );
}

export default function App() {
  const ws = useWebSocket();

  return (
    <ToastProvider>
      <Layout connected={ws.connected}>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/now" element={<NowRoute ws={ws} />} />
          <Route path="/now-classic" element={<NowClassic ws={ws} />} />
          {/* /now-pixel — direct-to-Habitat alias (skips the Console default). */}
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
