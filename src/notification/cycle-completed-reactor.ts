// ---------------------------------------------------------------------------
// CycleCompletedReactor Module (issue #1983) — the single owner of the
// `cycle:completed` domain reaction lifted out of src/notification-consumer.ts.
//
// This Module concentrates one concern: "react to a completed cycle by updating
// the self-improvement share history." Given a `cycle:completed` notification
// event it classifies the merged files as orchestrator/target/idle, stamps the
// rolling capacity-floor history (issue #245), and publishes the orchestrator-
// share metric to disk (issue #315). None of that is notification routing — it
// is a distinct domain reaction that deserves its own Seam, the same pattern
// the sibling alert-grammar extraction follows (issue #1979).
//
// The two domain imports that used to couple notification-consumer.ts to
// capacity-floor logic (`recordCycleSide`, `classifySide`) and to the metrics
// publisher (`publishOrchestratorShareMetric`) now live here. The notification
// consumer imports only `reactToCycleCompleted` and delegates — its remaining
// imports all belong to the notification-routing domain.
//
// Import direction is one-way: this module imports the shared
// NotificationEventPayload vocabulary from event-bus-vocabulary.ts (issue #1985
// — the zero-Redis-side-effect Seam) plus the two domain modules;
// notification-consumer.ts imports `reactToCycleCompleted` from here. No cycle.
//
// The extraction is behaviour-neutral — the same `cycle:completed` event
// produces the same capacity-floor side record and the same on-disk share
// metric as the pre-extraction inline arm.
// ---------------------------------------------------------------------------

import { type NotificationEventPayload } from "../event-bus-vocabulary.ts";
import { recordCycleSide, classifySide } from "../capacity-floor.ts";
import { publishOrchestratorShareMetric } from "../metrics/publish.ts";

/**
 * The event shape the cycle-completed reactor reads (issue #1983).
 *
 * This names exactly the payload fields `reactToCycleCompleted` dereferences
 * — mirroring `AlertGrammarEvent` (alert-grammar.ts, issue #1889): a renamed
 * read field (e.g. `cycleId` → `id`, `filesChanged` → `files`) becomes a
 * compile error at the access site rather than a silent runtime miss in the
 * capacity-floor history.
 *
 * `payload` stays OPEN (`Record<string, unknown> & Pick<…>`) because the bus
 * carries the full event vocabulary; the picked fields are only the subset the
 * reactor narrows on. `CycleCompletedEvent` is structurally a subset of the
 * `NotificationEvent` the notification consumer carries, so the bus-fed event
 * remains assignable at the delegating call site.
 */
export interface CycleCompletedEvent {
  type: string;
  correlationId?: string;
  payload?: Record<string, unknown> &
    Pick<
      NotificationEventPayload,
      "cycleId" | "task" | "filesChanged" | "rolledBack" | "commitSha" | "merged"
    >;
}

/**
 * Injectable writers for the cycle-completed reaction (issue #1983).
 *
 * Production passes nothing (the real capacity-floor + metrics writers, so
 * behaviour is unchanged); tests inject stubs to assert the reaction
 * classifies `filesChanged` and calls `recordCycleSide` with the right side
 * without constructing a notification-bus fixture. The default delegates to
 * the same module functions the inline arm used to call directly.
 */
export interface CycleCompletedReactorDeps {
  classifySide: typeof classifySide;
  recordCycleSide: typeof recordCycleSide;
  publishOrchestratorShareMetric: typeof publishOrchestratorShareMetric;
}

const defaultDeps: CycleCompletedReactorDeps = {
  classifySide,
  recordCycleSide,
  publishOrchestratorShareMetric,
};

/**
 * React to a single `cycle:completed` notification event by recording the
 * cycle's "side" in the capacity-floor history and publishing the
 * orchestrator-share metric to disk.
 *
 * Issue #245: stamp each completed cycle's "side" in the capacity-floor
 * history so autopilot can enforce the 25% orchestrator self-improvement
 * floor. Best-effort — recordCycleSide swallows its own errors so
 * digest/alerting can never break a cycle.
 *
 * Issue #4299: "idle" means *no merge happened* — it must never be the side
 * recorded for a merged cycle whose payload simply omitted `filesChanged`.
 * The only live publisher of this event (the target-build merge flow) sends
 * `merged:true` + `commitSha` with NO file list, and the pre-#4299 reactor
 * forwarded that empty list to `classifySide`, whose empty-files→"idle"
 * contract then recorded EVERY merged cycle as idle (the 100%-idle, 20-day
 * capacity window). Classification order:
 *   1. not merged (or rolled back) → "idle";
 *   2. merged + file list → `classifySide` (tier-classifier votes);
 *   3. merged + no file list → the workspace hint (below).
 *
 * The workspace hint is derived from the event payload (`workspace:
 * "orchestrator"`), defaulting to "target" — the sole live publisher merges
 * against the target workspace. (Orchestrator-repo merges are recorded by the
 * in-process merge-watch chore stamping `recordOrchestratorSideMerge` —
 * `src/scheduler/chores/holdback-merge-watch.ts` — not by this event path.)
 *
 * Issue #315: publish the current self-improvement share to disk so the
 * outcomes file adapter (config/direction/outcomes.yaml ->
 * metrics/orchestrator-share.txt) has a real value to read. Without this, the
 * only seeded Target Outcome is permanently unobservable. (The stuckness
 * detector + 25% capacity floor that originally consumed this signal were
 * retired in ADR-0010.) Best-effort — publisher logs and never throws.
 *
 * The `deps` parameter is injectable (defaults to the real writers) so the
 * reaction can be unit-tested with a plain event-payload object and stubs.
 */
export async function reactToCycleCompleted(
  event: CycleCompletedEvent,
  deps: CycleCompletedReactorDeps = defaultDeps,
): Promise<void> {
  const p = event.payload || {};
  const finalState = p.task?.finalState;
  // `filesChanged` is typed `unknown[]` in the shared vocabulary
  // (`NotificationEventPayload`, #1915); keep the string paths the
  // capacity-floor side classifier expects and drop any non-string entry.
  const files: string[] = Array.isArray(p.filesChanged)
    ? p.filesChanged.filter((f): f is string => typeof f === "string")
    : [];
  const isMerged = (p.merged === true || finalState === "merged") && !p.rolledBack;
  // Issue #4299: the workspace hint is a payload passthrough (the vocabulary
  // does not declare it — `payload` stays OPEN by design), narrowed here so a
  // publisher can declare its side. Unknown/absent → "target", the default of
  // the sole live publisher.
  const workspaceHint: "orchestrator" | "target" =
    p.workspace === "orchestrator" ? "orchestrator" : "target";
  const side = !isMerged
    ? "idle"
    : files.length > 0
      ? deps.classifySide(files, { workspaceHint })
      : workspaceHint;
  await deps.recordCycleSide(p.cycleId || event.correlationId || `evt-${Date.now()}`, side, {
    commitSha: p.commitSha || undefined,
    filesChanged: files.length > 0 ? files.slice(0, 50) : undefined,
    source: "cycle-completed-listener",
  });

  await deps.publishOrchestratorShareMetric();
}
