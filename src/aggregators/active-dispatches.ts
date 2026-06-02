/**
 * Active-dispatches aggregator (issue #618, PRD #615).
 *
 * Returns every live Claude Code session the orchestrator knows about,
 * across two sources:
 *
 *   1. Autopilot runs — `hydra:autopilot:run:{id}` hashes with
 *      `status: running`. Indexed by `hydra:autopilot:runs:index`.
 *   2. Operator dispatches — `hydra:dispatches:operator:*` (new in this
 *      PR, see `src/redis/dispatches.ts`).
 *
 * Each `Dispatch` carries a `source: "autopilot" | "operator"` discriminator
 * so the dashboard can render a small badge next to the row.
 *
 * # Design contract — same as overnight-summary.ts
 *
 * - **Pure aggregator.** Every external touchpoint lives in `deps`.
 * - **Never throws.** Each sub-source is wrapped via `Promise.allSettled`;
 *   a failed sub-source returns `[]` for itself and the rest still ship.
 * - **Newest first.** Both sub-sources are queried newest-first, then
 *   re-sorted by `startedAt` descending at the merge point so a slower
 *   sub-source can't poison the order.
 */

import {
  listActiveOperatorDispatches,
  listActiveSubagentDispatches,
  type OperatorDispatch,
  type SubagentDispatch,
} from "../redis/dispatches.ts";
import {
  listRecentAutopilotRunIds,
  getAutopilotRun,
} from "../redis/autopilot-runs.ts";
import { sweepRunIfDead } from "../autopilot/runs.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DispatchSource = "autopilot" | "operator" | "subagent";

export interface Dispatch {
  id: string;
  classLabel: string;
  source: DispatchSource;
  startedAt: string;
  currentStep?: string;
  issueRef?: string;
  prRef?: string;
}

export interface ActiveDispatchesDeps {
  /**
   * Reader for operator-launched dispatches. Defaults to the Redis Module
   * accessor; tests stub this with a fixture list.
   */
  listOperatorDispatches?: () => Promise<OperatorDispatch[]>;
  /**
   * Reader for subagent (Agent-tool) dispatches (issue #692). Defaults to
   * the Redis Module accessor; tests stub this with a fixture list.
   */
  listSubagentDispatches?: () => Promise<SubagentDispatch[]>;
  /**
   * Reader for the autopilot run-IDs index, newest first. Defaults to
   * `listRecentAutopilotRunIds(50)`.
   */
  listAutopilotRunIds?: (limit: number) => Promise<string[]>;
  /**
   * Reader for an individual autopilot run hash. Defaults to
   * `getAutopilotRun(id)`. Tests provide an in-memory map.
   */
  getAutopilotRunRow?: (id: string) => Promise<Record<string, string>>;
  /**
   * Liveness sweeper for a `running` autopilot run row. Defaults to
   * `sweepRunIfDead` — the same read-time sweeper the run readers use, so
   * the autopilot sub-source applies the canonical dead-pid rule instead
   * of trusting `status: running` verbatim (issue #888). A `running` row
   * whose recorded pid is dead is promoted to `killed`/`crash` (and never
   * counted as in-flight), so a crashed run that never POSTed its run-end
   * stops accumulating as a phantom zombie while idle. Tests stub this to
   * exercise the liveness gate without a real pid probe.
   */
  sweepAutopilotRun?: (
    id: string,
    row: Record<string, string>,
  ) => Promise<{ row: Record<string, string>; swept: boolean }>;
  /**
   * Cap on autopilot run-IDs fetched. Defaults to 50 — well above the
   * realistic ceiling of concurrent autopilot runs (autopilot is a single
   * long session, so at most 1-2 are live at once in practice).
   */
  autopilotLimit?: number;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getActiveDispatches(
  deps: ActiveDispatchesDeps = {},
): Promise<Dispatch[]> {
  const [autoResult, opResult, subResult] = await Promise.allSettled([
    fetchAutopilotDispatches(deps),
    fetchOperatorDispatches(deps),
    fetchSubagentDispatches(deps),
  ]);

  const auto = settledOrEmpty(autoResult, "active-dispatches/autopilot");
  const op = settledOrEmpty(opResult, "active-dispatches/operator");
  const sub = settledOrEmpty(subResult, "active-dispatches/subagent");

  // Higher-fidelity source first (autopilot rows have the richest metadata),
  // then operator, then subagent — mergeDispatches dedupes by id keeping the
  // first occurrence.
  return mergeDispatches([...auto, ...op, ...sub]);
}

function settledOrEmpty<T>(result: PromiseSettledResult<T[]>, label: string): T[] {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `[active-dispatches] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return [];
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Merge dispatches from multiple sources, dedupe by `id`, sort by
 * `startedAt` descending. Exported for tests so the merge contract can
 * be exercised without the Redis stub plumbing.
 *
 * Dedupe policy: first occurrence wins. Callers should pass the
 * higher-fidelity source first (autopilot rows have richer metadata).
 */
export function mergeDispatches(items: Dispatch[]): Dispatch[] {
  const byId = new Map<string, Dispatch>();
  for (const item of items) {
    if (!item || typeof item.id !== "string") continue;
    if (byId.has(item.id)) continue;
    byId.set(item.id, item);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aMs = Date.parse(a.startedAt);
    const bMs = Date.parse(b.startedAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs;
    // Stable fallback: keep insertion order when timestamps are unparseable.
    return 0;
  });
}

/**
 * Project an autopilot run hash into the public `Dispatch` shape.
 * Exported for tests.
 *
 * The autopilot row uses snake_case fields (`started_epoch`, `run_id`)
 * and represents the *long-running session*, not a leaf task. The
 * dashboard treats it as a class label of `autopilot` plus the trigger
 * (manual / scheduled) appended so the operator can tell them apart.
 */
export function projectAutopilotRow(row: Record<string, string>): Dispatch | null {
  const id = row.run_id || row.id || "";
  if (!id) return null;
  // Default to "autopilot" — the trigger is informative but not the
  // class label per se; the dashboard renders trigger alongside the row.
  const trigger = row.trigger ? `autopilot (${row.trigger})` : "autopilot";

  // startedAt: prefer the ISO `started` field; if absent, synthesise from
  // `started_epoch` so the merge sort still gets a usable value.
  let startedAt = row.started || "";
  if (!startedAt) {
    const ep = Number(row.started_epoch || "0");
    if (Number.isFinite(ep) && ep > 0) {
      startedAt = new Date(ep * 1000).toISOString();
    }
  }
  if (!startedAt) return null;

  const dispatch: Dispatch = {
    id,
    classLabel: trigger,
    source: "autopilot",
    startedAt,
  };
  // Autopilot rows don't carry an issue/PR ref or a currentStep on the row
  // itself (those live on turn records). Leave them undefined so the
  // dashboard can render the row without spurious "step: undefined" text.
  return dispatch;
}

// ---------------------------------------------------------------------------
// Sub-source: autopilot runs (status === "running", liveness-aware — #888)
// ---------------------------------------------------------------------------

/**
 * An autopilot run is in-flight only when its row reports `status:
 * running` AND its recorded pid is alive. We don't trust `status:
 * running` verbatim: a crashed run that never POSTed its run-end leaves a
 * stale `running` row with a dead pid, which would otherwise count as a
 * phantom in-flight dispatch until the 7-day TTL (observed: ~12 zombie
 * runs accumulating while idle). For every `running` row we apply the
 * canonical read-time sweeper (`sweepRunIfDead`), which promotes a
 * dead-pid row to `killed`/`crash` in Redis; the row only survives as a
 * dispatch if it is STILL `running` after the sweep (i.e. pid alive).
 */
async function fetchAutopilotDispatches(
  deps: ActiveDispatchesDeps,
): Promise<Dispatch[]> {
  const limit = deps.autopilotLimit ?? 50;
  const listIds = deps.listAutopilotRunIds ?? listRecentAutopilotRunIds;
  const getRow = deps.getAutopilotRunRow ?? getAutopilotRun;
  const sweep = deps.sweepAutopilotRun ?? sweepRunIfDead;

  const ids = await listIds(limit);
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const out: Dispatch[] = [];
  for (const id of ids) {
    const row = await getRow(id);
    if (!row || !row.status) continue;
    if (row.status !== "running") continue;
    // Liveness gate: sweep dead-pid running rows. A row whose pid is dead
    // comes back as killed/crash and is dropped here; a live row survives.
    const { row: swept } = await sweep(id, row);
    if (swept.status !== "running") continue;
    const projected = projectAutopilotRow(swept);
    if (projected) out.push(projected);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-source: operator-launched dispatches
// ---------------------------------------------------------------------------

async function fetchOperatorDispatches(
  deps: ActiveDispatchesDeps,
): Promise<Dispatch[]> {
  const list = deps.listOperatorDispatches ?? listActiveOperatorDispatches;
  const rows = await list();
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => projectOperatorRow(row));
}

/**
 * Pure helper — exported for tests. Projects an operator-dispatch row
 * into the unified `Dispatch` shape.
 */
export function projectOperatorRow(row: OperatorDispatch): Dispatch {
  const dispatch: Dispatch = {
    id: row.id,
    classLabel: row.classLabel,
    source: "operator",
    startedAt: row.startedAt,
  };
  if (row.currentStep) dispatch.currentStep = row.currentStep;
  if (row.issueRef) dispatch.issueRef = row.issueRef;
  if (row.prRef) dispatch.prRef = row.prRef;
  return dispatch;
}

// ---------------------------------------------------------------------------
// Sub-source: subagent (Agent-tool) dispatches — issue #692
// ---------------------------------------------------------------------------

async function fetchSubagentDispatches(
  deps: ActiveDispatchesDeps,
): Promise<Dispatch[]> {
  const list = deps.listSubagentDispatches ?? listActiveSubagentDispatches;
  const rows = await list();
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => projectSubagentDispatchRow(row));
}

/**
 * Pure helper — exported for tests. Projects a subagent-dispatch row into the
 * unified `Dispatch` shape.
 *
 * The unified row is keyed on `id`; we use the harness `sessionId` as that id
 * so the dedupe-by-id contract in `mergeDispatches` works across sources. The
 * `classLabel` is the dispatched `skill` (e.g. "hydra-dev") so the dashboard
 * renders the same label it shows for an autopilot dispatch of that skill.
 */
export function projectSubagentDispatchRow(row: SubagentDispatch): Dispatch {
  const dispatch: Dispatch = {
    id: row.sessionId,
    classLabel: row.skill,
    source: "subagent",
    startedAt: row.startedAt,
  };
  if (row.currentStep) dispatch.currentStep = row.currentStep;
  if (row.issueRef) dispatch.issueRef = row.issueRef;
  if (row.prRef) dispatch.prRef = row.prRef;
  return dispatch;
}
