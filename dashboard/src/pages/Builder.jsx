import { OutcomeCards } from "../components/pages/outcomes/OutcomeCards.jsx";
import { BuilderHealth } from "../components/pages/outcomes/BuilderHealth.jsx";
import { LessonsTrend } from "../components/pages/outcomes/LessonsTrend.jsx";
import { LessonsTab } from "../components/pages/explore/LessonsTab.jsx";
import { QualityGates } from "../components/pages/builder/QualityGates.jsx";
import { TangledModules } from "../components/pages/builder/TangledModules.jsx";
import { DeclaredOutcomes } from "../components/pages/builder/DeclaredOutcomes.jsx";
import { ImpactRanking } from "../components/pages/builder/ImpactRanking.jsx";
import { UnclassifiedResidue } from "../components/pages/builder/UnclassifiedResidue.jsx";
import { DesignConceptGreenLight } from "../components/pages/builder/DesignConceptGreenLight.jsx";
import { FeedCalibration } from "../components/pages/builder/FeedCalibration.jsx";

/**
 * Dashboard v3 — `/builder` page (issue #4011, ADR-0034 §2; slice "zeta" of
 * the cockpit epic #4005).
 *
 * The one question: *is the system actually getting better?* The weekly
 * journey — builder health, quality-gate trends, lesson throughput, and the
 * ranked maintainability view (architecture as most-tangled modules, not the
 * 363-node / 1004-edge node soup). Absorbs the quality half of the retired
 * Outcomes page and the Lessons content folded from Explore.
 *
 * Anti-scope (ADR-0034 §2): NOTHING actionable — this page changes decisions
 * weekly, not hourly, and carries no action controls. Read-only rendering.
 *
 * Reuse over rebuild (per the approved #4011 design concept): OutcomeCards,
 * BuilderHealth and LessonsTrend are the already-shipped quality-half panels
 * of the dying Outcomes page, imported here unmodified; LessonsTab is the
 * Explore lessons fold ADR-0034 §3 names explicitly. Only TangledModules
 * (the re-rendered architecture view) and QualityGates (the one endpoint
 * with no trust timestamp) are new, under components/pages/builder/.
 *
 * Issue #4634 (design-concept a7e7fedb, ADR-0034 §9.4) homes five dark reads
 * here, one panel file per route — DeclaredOutcomes (/outcomes),
 * ImpactRanking (/attribution/impact), UnclassifiedResidue
 * (/metrics/unclassified), DesignConceptGreenLight (/design-concepts/snapshots)
 * and FeedCalibration (/attention/counts). This shell only mounts them: it
 * owns no route literal and no fetch, and every panel stays read-only.
 */
export default function Builder() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Builder</h1>
        <p className="text-sm text-zinc-400">
          Weekly review — is the system actually getting better? Outcome trends, builder
          health, quality gates, lesson throughput, and what to refactor next.
        </p>
      </div>

      <OutcomeCards />
      <BuilderHealth />
      <QualityGates />
      <TangledModules />
      <LessonsTrend />
      <LessonsTab />
      <DeclaredOutcomes />
      <ImpactRanking />
      <UnclassifiedResidue />
      <DesignConceptGreenLight />
      <FeedCalibration />
    </div>
  );
}
