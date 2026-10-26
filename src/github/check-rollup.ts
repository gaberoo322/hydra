/**
 * check-rollup — the ONE fold over a PR's `statusCheckRollup` (issue #5087,
 * slice 1 of epic #5086).
 *
 * Collapses a rollup to the latest entry per context, classifies each context
 * into a four-way status (green / pending / red / cancelled — CANCELLED is its
 * own status), optionally restricts to the required contexts, and exposes two
 * named predicates over the fold: {@link isRed} (the brain's forward-fix
 * contract, #4460 INV-4: CANCELLED never arms a dispatch) and
 * {@link blocksMerge} (red, cancelled or pending).
 *
 * Pure: no I/O, no dependencies beyond the `PrRow` type. src/github sits below
 * the autopilot and aggregator layers, so nothing here imports either.
 */
import type { PrRow } from "./prs.ts";

export type RollupEntry = PrRow["statusCheckRollup"][number];
export type RollupStatus = "green" | "pending" | "red" | "cancelled";

/**
 * Which timestamp decides "latest" within a context.
 *  - `completed-then-started` (default): plausible completedAt, else plausible
 *    startedAt, else -Infinity.
 *  - `started-only`: plausible startedAt, else -Infinity.
 */
export type RollupOrder = "completed-then-started" | "started-only";

export interface RollupContext {
  status: RollupStatus;
  /** The winning entry; `undefined` for a required context absent from the rollup. */
  entry: RollupEntry | undefined;
}

export interface RollupFold {
  contexts: Map<string, RollupContext>;
}

export interface FoldOptions {
  /** Required context names (from `parseRequiredStatusContexts`); omit to fold every context. */
  required?: readonly string[];
  order?: RollupOrder;
}

const RED_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);
const GREEN_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const RED_STATUS_STATES: ReadonlySet<string> = new Set(["FAILURE", "ERROR"]);

/** gh emits 0001-01-01T00:00:00Z for a not-yet-completed CheckRun; any pre-2000 stamp is "absent". */
const MIN_PLAUSIBLE_TS = Date.parse("2000-01-01T00:00:00Z");

function plausibleTs(raw: string | null | undefined): number {
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) && t >= MIN_PLAUSIBLE_TS ? t : NaN;
}

function entryTimestamp(entry: RollupEntry, order: RollupOrder): number {
  if (order === "completed-then-started") {
    const completed = plausibleTs(entry.completedAt);
    if (Number.isFinite(completed)) return completed;
  }
  const started = plausibleTs(entry.startedAt);
  return Number.isFinite(started) ? started : Number.NEGATIVE_INFINITY;
}

/** The context an entry reports under: CheckRun name, else StatusContext context, else `check`. */
function entryName(entry: RollupEntry): string {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  if (typeof entry.context === "string" && entry.context.length > 0) return entry.context;
  return "check";
}

/**
 * Classify one (winning) entry. A CheckRun is judged by `conclusion`, a
 * StatusContext by `state`; anything unrecognised or empty is pending.
 */
export function classifyRollupEntry(entry: RollupEntry | undefined): RollupStatus {
  if (!entry) return "pending";
  const conclusion = typeof entry.conclusion === "string" ? entry.conclusion.toUpperCase() : "";
  if (conclusion) {
    if (conclusion === "CANCELLED") return "cancelled";
    if (RED_CHECK_CONCLUSIONS.has(conclusion)) return "red";
    if (GREEN_CHECK_CONCLUSIONS.has(conclusion)) return "green";
    return "pending";
  }
  const state = typeof entry.state === "string" ? entry.state.toUpperCase() : "";
  if (RED_STATUS_STATES.has(state)) return "red";
  if (state === "SUCCESS") return "green";
  return "pending";
}

/** Latest entry per context; ties and untimestamped entries go to the later list index. */
export function collapseRollup(
  rollup: readonly RollupEntry[],
  order: RollupOrder = "completed-then-started",
): Map<string, RollupEntry> {
  const out = new Map<string, RollupEntry>();
  for (const entry of rollup) {
    const name = entryName(entry);
    const prev = out.get(name);
    if (!prev || entryTimestamp(entry, order) >= entryTimestamp(prev, order)) out.set(name, entry);
  }
  return out;
}

/** Fold a rollup into per-context statuses, restricted to `required` when supplied. */
export function foldRollup(
  rollup: readonly RollupEntry[] | null | undefined,
  opts: FoldOptions = {},
): RollupFold {
  const latest = collapseRollup(Array.isArray(rollup) ? rollup : [], opts.order);
  const contexts = new Map<string, RollupContext>();
  const names = opts.required ?? [...latest.keys()];
  for (const name of names) {
    const entry = latest.get(name);
    contexts.set(name, { status: classifyRollupEntry(entry), entry });
  }
  return { contexts };
}

function someStatus(fold: RollupFold, pred: (s: RollupStatus) => boolean): boolean {
  for (const c of fold.contexts.values()) if (pred(c.status)) return true;
  return false;
}

/** True iff some context is red. CANCELLED is never red (#4460 INV-4). */
export function isRed(fold: RollupFold): boolean {
  return someStatus(fold, (s) => s === "red");
}

/** True iff no context is pending (absent required contexts count as pending; CANCELLED is settled). */
export function isSettled(fold: RollupFold): boolean {
  return !someStatus(fold, (s) => s === "pending");
}

/** True iff some context is red, cancelled or pending. */
export function blocksMerge(fold: RollupFold): boolean {
  return someStatus(fold, (s) => s === "red" || s === "cancelled" || s === "pending");
}
