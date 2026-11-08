/**
 * Lifecycle builder-health fields (issue #5324, ADR-0047 Decision 9, ADR-0028).
 *
 * Three permanent Builder-Health Scorecard slots that `builder-health.ts`
 * composes under its `Promise.allSettled` contract (each degrades to `null`
 * on its own; a dark field is never a fabricated 0):
 *
 *   - `parentExceptionRate` — exception turns / total turns, by cause, read
 *     from the per-turn `parent_exceptions` mirror heartbeat.py posts onto the
 *     Autopilot Run turn rows. The live window is bounded by the run TTL (7d);
 *     the 30d baseline is the git-tracked replay record
 *     (`scripts/lifecycle-parent-exception-baseline.ts`).
 *   - `firstPassQaYield` — PRs whose earliest in-window `QA-Verdict:` trailer
 *     is round 1 and PASS, from trailers only (never labels).
 *   - `parkRatePerArm` — parks / claims opened per cap arm from the
 *     `hydra:lifecycle:cap-events:<repo>` index, plus would-park counts and the
 *     rollout mode (shadow-era parks are 0 by construction).
 *
 * The folds are pure and exported for tests; the readers are overridable via
 * `LifecycleHealthDeps` so tests need no Redis and no gh (STD-VERIFY-NEVER-THROW:
 * readers return result objects).
 */

import { readFile as fsReadFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { CAP_ARMS, type CapArm } from "../lifecycle/caps.ts";
import { loadLifecycleMode, type LifecycleMode } from "../lifecycle/seam.ts";
import { listCapEvents, type CapEventRecord, type ListCapEventsResult } from "../redis/lifecycle-journal.ts";
import {
  listAutopilotRunTurnsDesc,
  listAutopilotRunsSince,
} from "../redis/autopilot-runs.ts";
import { listQaVerdictCommentsSince, resolveGithubRepo, type QaVerdictCommentsResult } from "../github/issues.ts";
import { isPassVerdict, parseQaVerdictTrailers } from "../qa/verdict-trailer.ts";
import { logger } from "../logger.ts";
import { InvariantViolationError, RedisSeamError } from "../errors.ts";

export const BUILDER_HEALTH_BASELINES_PATH = "config/orchestrator/builder-health-baselines.json";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Per-run turn read cap — far above any real run's turn count. */
const TURN_READ_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recorded baseline, echoed verbatim from the git-tracked baselines file. */
export interface BaselineEcho {
  value: number | null;
  source: string;
  method?: string | null;
  coveredFrom?: string | null;
  coveredTo?: string | null;
  computedAt?: string | null;
}

export interface ParentExceptionRateMetric {
  /** exceptionTurns / turns; `null` when there are no turns. */
  rate: number | null;
  turns: number;
  exceptionTurns: number;
  /** EVENTS per cause (may sum to more than exceptionTurns). */
  byCause: Record<string, number>;
  runs: number;
  windowDays: number;
  baseline: BaselineEcho | null;
}

export interface FirstPassQaYieldMetric {
  /** firstPass / population; `null` when the population is empty. */
  yield: number | null;
  population: number;
  firstPass: number;
  windowDays: number;
  baseline: BaselineEcho | null;
}

export interface ParkArmCounts {
  parks: number;
  wouldPark: number;
  /** parks / claimsOpened; `null` when no claim was opened. */
  rate: number | null;
}

export interface ParkRatePerArmMetric {
  mode: LifecycleMode;
  claimsOpened: number;
  arms: Record<CapArm, ParkArmCounts>;
  windowDays: number;
  baseline: BaselineEcho | null;
}

export interface BuilderHealthBaselines {
  parentExceptionRate: BaselineEcho | null;
  firstPassQaYield: BaselineEcho | null;
  parkRatePerArm: BaselineEcho | null;
}

/** One Autopilot Run's raw inputs for the parent-exception fold. */
export interface RunTurns {
  runId: string;
  startedEpoch: number;
  /** Raw turn-row JSON members (as stored in the turns ZSET). */
  members: string[];
}

export interface ParentExceptionFold {
  turns: number;
  exceptionTurns: number;
  byCause: Record<string, number>;
}

export interface LifecycleHealthDeps {
  now?: Date;
  /** Repo root for the baselines + rollout config files. */
  repoRoot?: string;
  readFile?: (path: string) => Promise<string>;
  githubRepo?: string;
  readRunTurns?: (sinceEpochSeconds: number) => Promise<RunTurns[]>;
  readQaVerdictComments?: (sinceIso: string) => Promise<QaVerdictCommentsResult>;
  readCapEvents?: (sinceMs: number) => Promise<ListCapEventsResult>;
  readMode?: () => Promise<LifecycleMode>;
}

// ---------------------------------------------------------------------------
// Pure folds
// ---------------------------------------------------------------------------

interface MirroredEvent {
  cause: string;
  turn: number;
  ts_epoch: number;
}

function memberEvents(member: string): { events: MirroredEvent[]; ok: boolean; turnN: number | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(member);
  } catch (err) {
    logger.warn({ err }, "[lifecycle-health] skipping malformed turn row");
    return { events: [], ok: false, turnN: null };
  }
  const rawTurnN = (parsed as { turn_n?: unknown } | null)?.turn_n;
  const turnN = Number.isInteger(rawTurnN) ? (rawTurnN as number) : null;
  const raw = (parsed as { parent_exceptions?: unknown } | null)?.parent_exceptions;
  const events: MirroredEvent[] = [];
  if (Array.isArray(raw)) {
    for (const e of raw as Array<Partial<MirroredEvent> | null>) {
      if (e && typeof e.cause === "string" && Number.isInteger(e.turn) && Number.isInteger(e.ts_epoch)) {
        events.push({ cause: e.cause, turn: e.turn as number, ts_epoch: e.ts_epoch as number });
      }
    }
  }
  return { events, ok: true, turnN };
}

/**
 * Fold one set of runs into turn / exception-turn / by-cause counts. A turn is
 * a distinct turn number of the run: every posted row's `turn_n` UNION every
 * event's own `turn` — a turn aborted before its Phase 5 heartbeat (invariant
 * reject, script error) posts no row, but the next turn mirrors its event as
 * turn_n-1, so it still counts as a turn. An exception turn is a distinct
 * `(runId, event.turn)` with at least one event (INV-2: the event's own `turn`
 * keys it, NOT the row it rode in on), so exceptionTurns <= turns always holds
 * without dropping events, and the live Redis rows fold identically to the Run
 * Ledger replay (INV-4). A row with no integer `turn_n` counts as one turn.
 * Events de-duplicate on `(runId, turn, cause, ts_epoch)` because the heartbeat
 * mirrors turn_n and turn_n-1.
 */
export function foldParentExceptions(runs: readonly RunTurns[]): ParentExceptionFold {
  let turns = 0;
  const exceptionTurns = new Set<string>();
  const seen = new Set<string>();
  const byCause: Record<string, number> = {};
  for (const run of runs) {
    const runTurns = new Set<number>();
    let unnumberedRows = 0;
    for (const { events, ok, turnN } of run.members.map(memberEvents)) {
      if (!ok) continue;
      if (turnN === null) unnumberedRows += 1;
      else runTurns.add(turnN);
      for (const ev of events) {
        const dedupe = `${run.runId}|${ev.turn}|${ev.cause}|${ev.ts_epoch}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        byCause[ev.cause] = (byCause[ev.cause] ?? 0) + 1;
        runTurns.add(ev.turn);
        exceptionTurns.add(`${run.runId}|${ev.turn}`);
      }
    }
    turns += runTurns.size + unnumberedRows;
  }
  return { turns, exceptionTurns: exceptionTurns.size, byCause };
}

/** `foldParentExceptions` shaped as the scorecard field (rate null when turns=0). */
export function parentExceptionMetric(
  runs: readonly RunTurns[],
  windowDays: number,
  baseline: BaselineEcho | null,
): ParentExceptionRateMetric {
  const f = foldParentExceptions(runs);
  return {
    rate: f.turns === 0 ? null : f.exceptionTurns / f.turns,
    turns: f.turns,
    exceptionTurns: f.exceptionTurns,
    byCause: f.byCause,
    runs: runs.length,
    windowDays,
    baseline,
  };
}

/**
 * First-pass QA yield from `QA-Verdict:` trailers only. Per PR, the EARLIEST
 * trailer whose comment was created inside the window decides: it counts in the
 * population only when `round=1`, and as first-pass when PASS or
 * PASS-pending-CI (FAIL-pending-CI is not first-pass).
 */
export function foldFirstPassQaYield(
  comments: ReadonlyArray<{ body: string; created_at: string }>,
  windowStartMs: number,
): { population: number; firstPass: number } {
  const earliest = new Map<number, { at: number; round: number; pass: boolean }>();
  for (const c of comments) {
    const at = Date.parse(c.created_at);
    if (!Number.isFinite(at) || at < windowStartMs) continue;
    for (const t of parseQaVerdictTrailers(c.body)) {
      const prior = earliest.get(t.pr);
      if (!prior || at < prior.at || (at === prior.at && t.round < prior.round)) {
        earliest.set(t.pr, { at, round: t.round, pass: isPassVerdict(t.verdict) });
      }
    }
  }
  let population = 0;
  let firstPass = 0;
  for (const v of earliest.values()) {
    if (v.round !== 1) continue;
    population += 1;
    if (v.pass) firstPass += 1;
  }
  return { population, firstPass };
}

/** Per-arm park counts over one window of cap events (zero-filled over CAP_ARMS). */
export function foldParkRate(
  events: readonly CapEventRecord[],
): { claimsOpened: number; arms: Record<CapArm, ParkArmCounts> } {
  const arms = {} as Record<CapArm, ParkArmCounts>;
  for (const arm of CAP_ARMS) arms[arm] = { parks: 0, wouldPark: 0, rate: null };
  let claimsOpened = 0;
  for (const e of events) {
    if (e.kind === "claim") {
      claimsOpened += 1;
      continue;
    }
    const slot = e.arm !== undefined ? arms[e.arm as CapArm] : undefined;
    if (!slot) continue;
    if (e.kind === "park") slot.parks += 1;
    else if (e.kind === "would-park") slot.wouldPark += 1;
  }
  for (const arm of CAP_ARMS) {
    arms[arm].rate = claimsOpened === 0 ? null : arms[arm].parks / claimsOpened;
  }
  return { claimsOpened, arms };
}

// ---------------------------------------------------------------------------
// Baselines (git-tracked, read-only here)
// ---------------------------------------------------------------------------

/** The repo root two levels above `src/aggregators/`. */
function defaultRepoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

function asBaseline(v: unknown): BaselineEcho | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.source !== "string") return null;
  if (o.value !== null && typeof o.value !== "number") return null;
  return o as unknown as BaselineEcho;
}

/** A missing or unparseable file yields all-null baselines, never a throw. */
export async function loadBuilderHealthBaselines(
  deps: Pick<LifecycleHealthDeps, "repoRoot" | "readFile"> = {},
): Promise<BuilderHealthBaselines> {
  const none: BuilderHealthBaselines = { parentExceptionRate: null, firstPassQaYield: null, parkRatePerArm: null };
  const read = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  let doc: unknown;
  try {
    doc = JSON.parse(await read(join(deps.repoRoot ?? defaultRepoRoot(), BUILDER_HEALTH_BASELINES_PATH)));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "ENOENT") {
      logger.warn({ err }, "[lifecycle-health] baselines file unreadable; baselines null");
    }
    /* intentional: a missing baselines file (ENOENT) is the documented "no baseline recorded yet" state, so it degrades to null baselines without a log */
    return none;
  }
  if (doc === null || typeof doc !== "object") return none;
  const d = doc as Record<string, { baseline?: unknown } | undefined>;
  return {
    parentExceptionRate: asBaseline(d.parentExceptionRate?.baseline),
    firstPassQaYield: asBaseline(d.firstPassQaYield?.baseline),
    parkRatePerArm: asBaseline(d.parkRatePerArm?.baseline),
  };
}

// ---------------------------------------------------------------------------
// Default readers
// ---------------------------------------------------------------------------

/**
 * A run counts toward parentExceptionRate only if at least one of its turn rows
 * carries a `parent_exceptions` ARRAY (heartbeat.py always forwards the list,
 * `[]` when clean). Runs from before the mirror shipped have no such field, and
 * counting their turns would dilute the rate toward a fabricated low value.
 * Data-driven, so no ship-date constant to rot. Shared with the replay script.
 */
export function runCarriesMirror(run: RunTurns): boolean {
  for (const member of run.members) {
    try {
      const parsed = JSON.parse(member) as { parent_exceptions?: unknown } | null;
      if (Array.isArray(parsed?.parent_exceptions)) return true;
    } catch (err) {
      logger.warn({ err, runId: run.runId }, "[lifecycle-health] skipping malformed turn row in mirror check");
    }
  }
  return false;
}

/** Drop runs that predate the per-turn mirror. */
export function filterMirrorRuns(runs: readonly RunTurns[]): RunTurns[] {
  return runs.filter(runCarriesMirror);
}

async function defaultReadRunTurns(sinceEpochSeconds: number): Promise<RunTurns[]> {
  const runs = await listAutopilotRunsSince(sinceEpochSeconds);
  const out: RunTurns[] = [];
  for (const run of runs) {
    out.push({
      runId: run.runId,
      startedEpoch: run.startedEpoch,
      members: await listAutopilotRunTurnsDesc(run.runId, TURN_READ_LIMIT),
    });
  }
  return filterMirrorRuns(out);
}

// ---------------------------------------------------------------------------
// Computations (throw on a source failure so the caller's allSettled degrades
// the field to null)
// ---------------------------------------------------------------------------

export async function computeParentExceptionRate(
  windowDays: number,
  deps: LifecycleHealthDeps = {},
): Promise<ParentExceptionRateMetric> {
  const now = (deps.now ?? new Date()).getTime();
  const [runs, baselines] = await Promise.all([
    (deps.readRunTurns ?? defaultReadRunTurns)(Math.floor((now - windowDays * DAY_MS) / 1000)),
    loadBuilderHealthBaselines(deps),
  ]);
  return parentExceptionMetric(runs, windowDays, baselines.parentExceptionRate);
}

export async function computeFirstPassQaYield(
  windowDays: number,
  deps: LifecycleHealthDeps = {},
): Promise<FirstPassQaYieldMetric> {
  const now = (deps.now ?? new Date()).getTime();
  const windowStart = now - windowDays * DAY_MS;
  const reader =
    deps.readQaVerdictComments ??
    ((since: string) => listQaVerdictCommentsSince(since, { repo: resolveGithubRepo(deps.githubRepo) }));
  const [res, baselines] = await Promise.all([reader(new Date(windowStart).toISOString()), loadBuilderHealthBaselines(deps)]);
  if (res.ok === false) throw new InvariantViolationError(`qa-verdict comment read failed: ${res.code}`);
  const { population, firstPass } = foldFirstPassQaYield(res.comments, windowStart);
  return {
    yield: population === 0 ? null : firstPass / population,
    population,
    firstPass,
    windowDays,
    baseline: baselines.firstPassQaYield,
  };
}

export async function computeParkRatePerArm(
  windowDays: number,
  deps: LifecycleHealthDeps = {},
): Promise<ParkRatePerArmMetric> {
  const now = (deps.now ?? new Date()).getTime();
  const repo = resolveGithubRepo(deps.githubRepo);
  const repoRoot = deps.repoRoot ?? defaultRepoRoot();
  const [res, mode, baselines] = await Promise.all([
    (deps.readCapEvents ?? ((since: number) => listCapEvents(repo, since)))(now - windowDays * DAY_MS),
    (deps.readMode ?? (async () => (await loadLifecycleMode(repoRoot)).mode))(),
    loadBuilderHealthBaselines(deps),
  ]);
  if (res.ok === false) throw new RedisSeamError(res.error);
  const { claimsOpened, arms } = foldParkRate(res.events);
  return { mode, claimsOpened, arms, windowDays, baseline: baselines.parkRatePerArm };
}

// ---------------------------------------------------------------------------
// Baseline replay (used by scripts/lifecycle-parent-exception-baseline.ts)
// ---------------------------------------------------------------------------

/** One recorded per-run row of the parent-exception baseline file. */
export interface BaselineRunRow {
  started_epoch: number;
  turns: number;
  exceptionTurns: number;
  byCause: Record<string, number>;
}

/**
 * Recompute the baseline `summary` over rows whose started_epoch is within 30d
 * of the NEWEST row. `coveredFrom`/`coveredTo` are the real span of the rows
 * used, so a baseline that covers 3 days says 3 days.
 */
export function summarizeBaselineRows(
  rows: Record<string, BaselineRunRow>,
  computedAt: string,
): BaselineEcho & { runs: number; turns: number; exceptionTurns: number } {
  const entries = Object.values(rows);
  const newest = entries.reduce((m, r) => Math.max(m, r.started_epoch), 0);
  const inWindow = entries.filter((r) => r.started_epoch >= newest - 30 * 86400);
  const turns = inWindow.reduce((s, r) => s + r.turns, 0);
  const exceptionTurns = inWindow.reduce((s, r) => s + r.exceptionTurns, 0);
  const from = inWindow.reduce((m, r) => Math.min(m, r.started_epoch), Number.POSITIVE_INFINITY);
  return {
    value: turns === 0 ? null : exceptionTurns / turns,
    source: "replay: scripts/lifecycle-parent-exception-baseline.ts",
    method: "exception turns / turns over recorded Autopilot Runs",
    coveredFrom: inWindow.length === 0 ? null : new Date(from * 1000).toISOString().slice(0, 10),
    coveredTo: inWindow.length === 0 ? null : new Date(newest * 1000).toISOString().slice(0, 10),
    computedAt,
    runs: inWindow.length,
    turns,
    exceptionTurns,
  };
}

/**
 * Merge a re-seen run's fresh row into its stored row: keep the one with more
 * turns (a run near the 7d TTL has lost early turn rows, so the fresh replay
 * can be smaller than what was recorded earlier).
 */
export function mergeBaselineRow(prev: BaselineRunRow | undefined, next: BaselineRunRow): BaselineRunRow {
  return prev !== undefined && prev.turns > next.turns ? prev : next;
}

/** One run's recorded baseline row (the same fold the live field uses). */
export function baselineRowFor(run: RunTurns): BaselineRunRow {
  const f = foldParentExceptions([run]);
  return { started_epoch: run.startedEpoch, turns: f.turns, exceptionTurns: f.exceptionTurns, byCause: f.byCause };
}

/**
 * Shape a Run Ledger `state.json` document as `RunTurns` (one synthetic turn
 * row per turn 1..state.turn carrying that turn's parent_exceptions), so the
 * live run — whose Redis rows may not exist yet — replays through the SAME fold.
 */
export function ledgerToRunTurns(state: unknown): RunTurns | null {
  const s = state as { run_id?: unknown; started_epoch?: unknown; turn?: unknown; parent_exceptions?: unknown } | null;
  if (!s || typeof s.run_id !== "string" || !Number.isInteger(s.started_epoch) || !Number.isInteger(s.turn)) return null;
  const events = Array.isArray(s.parent_exceptions) ? (s.parent_exceptions as Array<{ turn?: unknown }>) : [];
  const members: string[] = [];
  for (let t = 1; t <= (s.turn as number); t++) {
    const mine = events.filter((e) => e && e.turn === t);
    // The live ledger is mirror-era by definition: `[]` marks a clean turn.
    members.push(JSON.stringify({ turn_n: t, parent_exceptions: mine }));
  }
  return { runId: s.run_id, startedEpoch: s.started_epoch as number, members };
}
