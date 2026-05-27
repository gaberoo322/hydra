import { useParams, useNavigate, Navigate } from "react-router-dom";
import { FrictionTab } from "../../components/v2/explore/FrictionTab.jsx";
import { BehaviorTab } from "../../components/v2/explore/BehaviorTab.jsx";
import { FlowTab } from "../../components/v2/explore/FlowTab.jsx";
import { LessonsTab } from "../../components/v2/explore/LessonsTab.jsx";
import { AnomaliesTab } from "../../components/v2/explore/AnomaliesTab.jsx";
import { ArchitectureTab } from "../../components/v2/explore/ArchitectureTab.jsx";
import { SearchTab } from "../../components/v2/explore/SearchTab.jsx";

/**
 * Dashboard v2 — `/v2/explore/:tab` page (issue #620, PRD #615).
 *
 * Tabbed sense-making hub. Seven tabs, default = `friction`. Each tab is a
 * full sub-page that owns its own data lifecycle (the tabs don't share
 * polling state, on purpose — switching tabs shouldn't tear down the
 * Friction tab's near-promotion cache, but it also shouldn't poll Lessons
 * data while the operator is staring at the Architecture graph).
 *
 * Routing — `/v2/explore/:tab` (deep-linkable). The parent `App.jsx` mounts
 * three routes pointing at this component:
 *   /v2/explore                — redirect to /v2/explore/friction
 *   /v2/explore/:tab           — render the matching tab
 *   /v2/explore/* (unknown)    — fall back to /v2/explore/friction
 */

const TABS = [
  { id: "friction", label: "Friction", Component: FrictionTab },
  { id: "behavior", label: "Behavior", Component: BehaviorTab },
  { id: "flow", label: "Flow", Component: FlowTab },
  { id: "lessons", label: "Lessons", Component: LessonsTab },
  { id: "anomalies", label: "Anomalies", Component: AnomaliesTab },
  { id: "architecture", label: "Architecture", Component: ArchitectureTab },
  { id: "search", label: "Search", Component: SearchTab },
];

const DEFAULT_TAB = "friction";

export default function Explore() {
  const { tab } = useParams();
  const navigate = useNavigate();

  if (!tab) {
    return <Navigate to={`/v2/explore/${DEFAULT_TAB}`} replace />;
  }

  const active = TABS.find((t) => t.id === tab);
  if (!active) {
    return <Navigate to={`/v2/explore/${DEFAULT_TAB}`} replace />;
  }

  const ActiveComponent = active.Component;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Explore</h1>
        <p className="text-sm text-zinc-400">
          Sense-making hub — gaps, patterns, and "what should I think about?".
        </p>
      </div>

      <nav className="border-b border-zinc-700 flex gap-1 overflow-x-auto" role="tablist">
        {TABS.map((t) => {
          const isActive = t.id === active.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => navigate(`/v2/explore/${t.id}`)}
              className={
                "px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors " +
                (isActive
                  ? "border-amber-400 text-amber-300"
                  : "border-transparent text-zinc-400 hover:text-zinc-200")
              }
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      <div role="tabpanel">
        <ActiveComponent />
      </div>
    </div>
  );
}
