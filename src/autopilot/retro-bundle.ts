/**
 * Run-tree retro-bundle — a never-throw, read-only assembler that, given an
 * autopilot `run_id`, joins the run's lifecycle data into one structured
 * "retro bundle" for the per-run retrospective system (issue #918, epic #917).
 *
 * The bundle composes, all read-only, from existing seams:
 *   - the **run record** (status, term_reason, turns, dispatches) and the
 *     per-turn **dispatch decisions + reasons** — `autopilot/runs.getRun`
 *   - per-**cycle records** (status / merged-failed counts / abandon_reason /
 *     regression) — `redis/cycle-tracking.getCycleHash` joined with the
 *     `redis/cycle-metrics.getCycleMetrics` sidecar (abandonReason,
 *     regressionIntroduced, anchorReference, prNumber live there)
 *   - **QA verdicts / failure narratives** — the per-anchor reflection blocks
 *     (`reflections/reflections.loadAnchorReflections`), the live record of
 *     "what was attempted, why it failed" a retry consumes (there is no
 *     separate QA-verdict store; QA posts verdicts as PR comments and the
 *     fixable signal is the reflection narrative)
 *   - the **#890 stuck-signals** — `aggregators/autopilot-health.getAutopilotHealth`
 *   - the **recommendation-engine recs** emitted during the run —
 *     `redis/recommendations.getAllRecommendations`
 *   - the **friction-pattern store** — `pattern-memory/agent-memory.listFrictionPatterns`
 *
 * Contracts (CLAUDE.md):
 *   - **Never throws.** Every sub-source is wrapped; a missing or failing
 *     source yields a partial bundle, a logged `console.error`, and a typed
 *     entry in `bundle.errors[]` — never a throw. Mirrors the
 *     merge/grounding/verification result-object convention.
 *   - **Read-only.** No Redis write, no run-state mutation.
 *
 * The pure {@link flagDispatchesForDrill} selector names the subset of
 * dispatches whose full transcript a downstream consumer should drill into
 * (failed QA, stalled, churned, or errored) so transcripts are read only for
 * the dispatches that went wrong — the signals-first / drill-on-flag input
 * strategy that bounds the retrospective's token cost (epic #917).
 */

import {
  getRun,
  MERGED_STATUSES,
  FAILED_STATUSES,
} from "./runs.ts";
import { getCycleHash } from "../redis/cycle-tracking.ts";
import { getCycleMetrics } from "../redis/cycle-metrics.ts";
import { getAllRecommendations } from "../redis/recommendations.ts";
import { loadAnchorReflections } from "../reflections/reflections.ts";
import { listFrictionPatterns } from "../pattern-memory/agent-memory.ts";
import { getAutopilotHealth } from "../aggregators/autopilot-health.ts";
import type { StuckSignal } from "../schemas/now-page.ts";
import type { MemoryPattern } from "../pattern-memory/agent-memory.ts";

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

/** One sub-source that failed to load — surfaced instead of thrown. */
export interface RetroBundleError {
  /** Stable, machine-readable source name, e.g. `"run-record"`, `"friction"`. */
  source: string;
  /** The error message (best-effort string coercion). */
  detail: string;
}

/**
 * One code-writing dispatch's outcome, projected from the run's turn timeline
 * joined to its cycle record + metrics sidecar. The unit
 * {@link flagDispatchesForDrill} operates on.
 */
export interface RetroDispatch {
  /** The cycle id this dispatch resolved to (or the synthesised turn key). */
  cycleId: string;
  /** Autopilot turn this dispatch was launched on, when known. */
  turn_n: number | null;
  /** Dispatched skill (`hydra-dev`, ...), when the action carried it. */
  skill: string | null;
  /** The dispatched anchor reference (`issue-918`, ...), when known. */
  anchorReference: string | null;
  /** PR number opened by the dispatch, when known. */
  prNumber: string | null;
  /** Cycle status (`merged`, `failed`, `abandoned`, ...) or `null` if pending. */
  status: string | null;
  /** Coarse bucket derived from `status`. `null` == still pending. */
  bucket: "merged" | "failed" | null;
  /** Abandon reason recorded on the cycle metrics sidecar, when present. */
  abandonReason: string | null;
  /** Whether the cycle introduced a regression (from the metrics sidecar). */
  regressionIntroduced: boolean;
}

/** A per-anchor reflection narrative attached to a flagged dispatch. */
export interface RetroReflection {
  anchorReference: string;
  /** Prompt-ready markdown narrative; `""` when no prior reflections exist. */
  formatted: string;
  /** Number of prior-failure reflections composed into `formatted`. */
  count: number;
}

/** The assembled retro bundle. Always returned — never thrown. */
export interface RetroBundle {
  run_id: string;
  /** ISO timestamp the bundle was assembled. */
  generatedAt: string;
  /**
   * `true` when the run record itself loaded; `false` means the run is
   * unknown / unreadable and every downstream join was skipped.
   */
  runFound: boolean;
  /** The projected run record (status, term_reason, turns, dispatches, ...). */
  run: Record<string, unknown> | null;
  /** Per-turn dispatch decisions + reasons (the run's turn timeline). */
  turns: Array<Record<string, unknown>>;
  /** Per-dispatch outcomes, projected + joined from the turn timeline. */
  dispatches: RetroDispatch[];
  /**
   * Per-anchor reflection narratives for the FLAGGED dispatches only — the
   * "QA verdict / why it failed" signal a retrospective acts on. Bounded to
   * the drill subset so we don't fan out a reflection read per dispatch.
   */
  reflections: RetroReflection[];
  /** The #890 stuck-signals (ranked) at bundle-assembly time. */
  stuckSignals: StuckSignal[];
  /** Recommendation-engine recs emitted during the run (raw hash values). */
  recommendations: unknown[];
  /** Friction-pattern store snapshot across the known dispatch skills. */
  frictionPatterns: MemoryPattern[];
  /** Sub-sources that failed to load. Empty on a fully-clean assembly. */
  errors: RetroBundleError[];
}

/**
 * Injectable readers — defaults wire the live Redis/aggregator seams. Tests
 * override individual readers to pin behavior (and to assert the never-throw
 * contract by making a reader reject). Mirrors `AutopilotHealthDeps`.
 */
export interface RetroBundleDeps {
  now?: Date;
  readRun?: typeof getRun;
  readCycleHash?: typeof getCycleHash;
  readCycleMetrics?: typeof getCycleMetrics;
  readRecommendations?: typeof getAllRecommendations;
  readAnchorReflections?: typeof loadAnchorReflections;
  readFrictionPatterns?: typeof listFrictionPatterns;
  readStuckSignals?: typeof getAutopilotHealth;
  /**
   * Skills whose friction stores are folded into the bundle. Defaults to the
   * code-writing + verification dispatch skills the autopilot runs.
   */
  frictionSkills?: string[];
}

const DEFAULT_FRICTION_SKILLS = [
  "hydra-dev",
  "hydra-qa",
  "hydra-target-build",
];

/**
 * `term_reason` values that mark a non-clean run termination — the run died
 * before its dispatches' terminal cycle status could be written. For a
 * dispatch left status-less on such a run, the assembler derives a
 * failure-leaning `abandonReason` (`run-<reason>`) so a stalled dispatch is
 * still flagged for drill (issue #975). `crash` / `killed` are the abnormal
 * exits; `failure_backstop` is the reap-on-exit cause for a run that stopped
 * on a failure. Clean stops (`budget` / `wall_clock` / `idle` /
 * `interrupted`) are NOT here — a status-less dispatch on a clean stop is
 * genuinely still pending and must stay unflagged.
 */
const CRASH_TERM_REASONS: ReadonlySet<string> = new Set([
  "crash",
  "killed",
  "failure_backstop",
]);

// ---------------------------------------------------------------------------
// Drill-flag selector (pure)
// ---------------------------------------------------------------------------

/**
 * Pure selector — names the subset of dispatches whose full transcript a
 * downstream consumer should deep-read. A dispatch is flagged when it shows a
 * failure/stall/churn/error signal:
 *
 *   - `bucket === "failed"` — abandoned / aborted / timed-out / PR closed
 *     unmerged (the QA-fail and stall outcomes)
 *   - `regressionIntroduced` — merged but auto-reverted on regression (churn)
 *   - it carries an `abandonReason` — an explicit error/abort the cycle filed
 *
 * A merged, regression-free dispatch is NOT flagged — the happy path needs no
 * transcript drill. Pending dispatches (`status === null`) are not flagged:
 * nothing went wrong *yet*. Returns the flagged subset in input order so the
 * selection is deterministic.
 */
export function flagDispatchesForDrill(dispatches: RetroDispatch[]): RetroDispatch[] {
  return dispatches.filter(
    (d) =>
      d.bucket === "failed" ||
      d.regressionIntroduced === true ||
      (typeof d.abandonReason === "string" && d.abandonReason.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toDetail(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/**
 * Run a sub-source reader under the never-throw contract. On rejection: log
 * with context, push a typed entry onto `errors`, and return `fallback`.
 */
async function safeSource<T>(
  source: string,
  errors: RetroBundleError[],
  fallback: T,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = toDetail(err);
    console.error(`[retro-bundle] sub-source failed (${source}): ${detail}`);
    errors.push({ source, detail });
    return fallback;
  }
}

function bucketOf(status: string | null): "merged" | "failed" | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (MERGED_STATUSES.has(s)) return "merged";
  if (FAILED_STATUSES.has(s)) return "failed";
  return null;
}

/**
 * Extract a bare PR number from an anchor string. The slot snapshot's `anchor`
 * carries the dispatched reference verbatim (e.g. a `qa_orch` slot reads
 * `PR#970`, a `dev_orch` slot reads `#961`); a PR-shaped anchor yields the
 * digits for `prNumber`, an issue-shaped one yields `null` (its number is the
 * issue ref, not a PR). Returns `null` when no PR-shaped token is present.
 * Used only as a slots_snapshot fallback — an action/outcome `prNumber`
 * always wins.
 */
function prNumberFromAnchor(anchor: string | null): string | null {
  if (!anchor) return null;
  // Only PR-shaped anchors carry a PR number: `PR#970` / `pr#970` / `PR970`.
  const m = /\bpr\s*#?\s*(\d+)\b/i.exec(anchor);
  return m ? m[1] : null;
}

/** Read the dispatched slot key off a dispatch action, when it carries one. */
function slotOfAction(a: any): string | null {
  return typeof a?.slot === "string" && a.slot.length > 0 ? a.slot : null;
}

/**
 * Read a string field off a slot-snapshot entry, tolerating non-object /
 * non-string members (a malformed slot map must never throw — it yields the
 * prior action-derived dispatch, per the never-throw / read-only invariant).
 */
function slotStr(slotObj: unknown, key: string): string | null {
  if (!slotObj || typeof slotObj !== "object") return null;
  const v = (slotObj as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Project the run's turn timeline into the flat per-dispatch list. Pulls the
 * dispatch identity (cycleId / skill / anchor) off each `type === "dispatch"`
 * action and the joined `outcome` (attached by `fetchTurnsWithJoins`), then
 * reconciles each turn's `slots_snapshot` (slot key → `{skill, anchor,
 * task_id, ...}`) as a FALLBACK that only fills fields the action left null.
 *
 * The real dispatch action carries the anchor nested under
 * `prompt_args.anchor` (not the top-level `anchorReference` the legacy join
 * read) and carries no `cycleId`, while the resolvable identity lives in
 * `slots_snapshot`; without this reconciliation `anchorReference` / `skill` /
 * `prNumber` came back null and `flagDispatchesForDrill` flagged nothing
 * (issue #975).
 *
 * Merge is keyed by `(turn, slot)`, NOT concatenated: a slot already
 * represented by an action enriches that RetroDispatch's null fields; a slot
 * present ONLY in `slots_snapshot` (the crashed-run case, where the dispatch
 * action was never recorded) becomes a NEW RetroDispatch. One real dispatch →
 * exactly one RetroDispatch, so a clean run with action-carried identity is
 * byte-identical (action values win, no double-count).
 *
 * Pure over the already-fetched turns — `slots_snapshot` is already on each
 * turn member, so there is no Redis round-trip here.
 */
export function projectDispatches(
  turns: Array<Record<string, unknown>>,
): RetroDispatch[] {
  const out: RetroDispatch[] = [];
  for (const turn of turns) {
    const turnN =
      typeof turn.turn_n === "number" && Number.isFinite(turn.turn_n)
        ? (turn.turn_n as number)
        : null;
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    const slotsSnapshot =
      turn.slots_snapshot && typeof turn.slots_snapshot === "object"
        ? (turn.slots_snapshot as Record<string, unknown>)
        : {};

    // Track which slot keys an action already projected, so the slots_snapshot
    // fold enriches those in place rather than emitting a duplicate.
    const bySlot = new Map<string, RetroDispatch>();

    for (const a of actions) {
      if (!a || a.type !== "dispatch") continue;
      const outcome = a.outcome && typeof a.outcome === "object" ? a.outcome : null;
      const cycleId =
        (outcome && typeof outcome.cycleId === "string" && outcome.cycleId) ||
        (typeof a.cycleId === "string" && a.cycleId) ||
        (typeof a.autopilotTurnId === "string" && a.autopilotTurnId) ||
        "";
      const status =
        outcome && typeof outcome.status === "string" ? (outcome.status as string) : null;
      const prNumber =
        outcome && outcome.prNumber != null ? String(outcome.prNumber) : null;
      // Anchor priority: top-level anchorReference/anchor/issueRef (legacy join
      // shape) then the real action's nested prompt_args.anchor.
      const anchorReference =
        (typeof a.anchorReference === "string" && a.anchorReference) ||
        (typeof a.anchor === "string" && a.anchor) ||
        (typeof a.issueRef === "string" && a.issueRef) ||
        (a.prompt_args &&
          typeof a.prompt_args === "object" &&
          typeof (a.prompt_args as any).anchor === "string" &&
          (a.prompt_args as any).anchor) ||
        null;
      const dispatch: RetroDispatch = {
        cycleId,
        turn_n: turnN,
        skill: typeof a.skill === "string" ? a.skill : null,
        anchorReference,
        prNumber,
        status,
        bucket: bucketOf(status),
        // abandonReason / regression are enriched from the metrics sidecar
        // join in the assemble loop; default to the no-signal values here.
        abandonReason: null,
        regressionIntroduced: false,
      };
      out.push(dispatch);
      const slot = slotOfAction(a);
      if (slot && !bySlot.has(slot)) bySlot.set(slot, dispatch);
    }

    // Fold the slots_snapshot in: enrich an action-derived dispatch's null
    // fields, or emit a new dispatch for a slot the actions never recorded
    // (the crashed-run case). Action-join wins when present, so this only fills
    // nulls — clean-run behaviour is byte-identical.
    for (const [slot, slotObj] of Object.entries(slotsSnapshot)) {
      if (slotObj == null) continue; // empty slot — nothing dispatched here.
      const slotSkill = slotStr(slotObj, "skill");
      const slotAnchor = slotStr(slotObj, "anchor");
      const existing = bySlot.get(slot);
      if (existing) {
        if (!existing.skill && slotSkill) existing.skill = slotSkill;
        if (!existing.anchorReference && slotAnchor) existing.anchorReference = slotAnchor;
        if (!existing.prNumber) {
          const pr = prNumberFromAnchor(slotAnchor);
          if (pr) existing.prNumber = pr;
        }
        continue;
      }
      // A slot member with no matching action that carries NO usable identity
      // (a malformed string/number/array, or an object with neither skill nor
      // anchor) is skipped rather than synthesised as an all-null phantom
      // dispatch (never-throw / read-only invariant: a garbage slot map yields
      // the prior action-derived dispatches, not a junk row).
      if (!slotSkill && !slotAnchor) continue;
      // Slot present only in the snapshot — the dispatch action was never
      // recorded (a crash truncated the turn). Synthesise a RetroDispatch so
      // the crashed-run dispatch is still attributable and flaggable.
      const dispatch: RetroDispatch = {
        cycleId: "",
        turn_n: turnN,
        skill: slotSkill,
        anchorReference: slotAnchor,
        prNumber: prNumberFromAnchor(slotAnchor),
        status: null,
        bucket: null,
        abandonReason: null,
        regressionIntroduced: false,
      };
      out.push(dispatch);
      bySlot.set(slot, dispatch);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Assemble the retro bundle for `runId`. Never throws — a missing or failing
 * sub-source yields a partial bundle plus a logged + recorded error. When the
 * run record itself is unreadable, `runFound` is `false` and the run-scoped
 * joins are skipped (but the run-agnostic sources — stuck-signals, friction —
 * are still attempted, since they remain useful context).
 */
export async function assembleRetroBundle(
  runId: string,
  deps: RetroBundleDeps = {},
): Promise<RetroBundle> {
  const readRun = deps.readRun ?? getRun;
  const readCycleHash = deps.readCycleHash ?? getCycleHash;
  const readCycleMetrics = deps.readCycleMetrics ?? getCycleMetrics;
  const readRecommendations = deps.readRecommendations ?? getAllRecommendations;
  const readAnchorReflections = deps.readAnchorReflections ?? loadAnchorReflections;
  const readFrictionPatterns = deps.readFrictionPatterns ?? listFrictionPatterns;
  const readStuckSignals = deps.readStuckSignals ?? getAutopilotHealth;
  const frictionSkills = deps.frictionSkills ?? DEFAULT_FRICTION_SKILLS;
  const generatedAt = (deps.now ?? new Date()).toISOString();

  const errors: RetroBundleError[] = [];

  // 1. Run record + turn timeline (the spine of the bundle).
  const runResult = await safeSource(
    "run-record",
    errors,
    null as Awaited<ReturnType<typeof getRun>> | null,
    () => readRun(runId),
  );

  let runView: Record<string, unknown> | null = null;
  let turns: Array<Record<string, unknown>> = [];
  let runFound = false;
  if (runResult && runResult.ok) {
    runFound = true;
    runView = runResult.run;
    turns = Array.isArray(runResult.turns) ? runResult.turns : [];
  } else if (runResult && !runResult.ok && runResult.code !== "not-found") {
    // A genuine read error (not a clean 404) — record it so the bundle's
    // partial-ness is legible. A `not-found` is a normal empty bundle.
    errors.push({ source: "run-record", detail: runResult.detail || runResult.code });
  }

  // 2. Per-dispatch projection from the turn timeline.
  const dispatches = projectDispatches(turns);

  // 3. Enrich each dispatch from its cycle metrics sidecar (abandonReason,
  //    regressionIntroduced) — getRun's join already attached status/PR, but
  //    the sidecar carries the failure-shape fields the drill selector needs.
  for (const d of dispatches) {
    if (!d.cycleId) continue;
    const metrics = await safeSource(
      "cycle-metrics",
      errors,
      {} as Record<string, string>,
      () => readCycleMetrics(d.cycleId),
    );
    if (metrics && typeof metrics === "object") {
      if (typeof metrics.abandonReason === "string" && metrics.abandonReason.length > 0) {
        d.abandonReason = metrics.abandonReason;
      }
      d.regressionIntroduced = metrics.regressionIntroduced === "true";
      // Backfill status/anchor from the metrics sidecar when the turn join
      // didn't carry them (e.g. a cycle recorded out-of-band of a turn).
      if (!d.status) {
        const hash = await safeSource(
          "cycle-record",
          errors,
          {} as Record<string, string>,
          () => readCycleHash(d.cycleId),
        );
        if (hash && typeof hash.status === "string" && hash.status.length > 0) {
          d.status = hash.status;
          d.bucket = bucketOf(d.status);
        }
      }
      if (!d.anchorReference && typeof metrics.anchorReference === "string") {
        d.anchorReference = metrics.anchorReference || null;
      }
      if (!d.prNumber && typeof metrics.prNumber === "string" && metrics.prNumber.length > 0) {
        d.prNumber = metrics.prNumber;
      }
    }
  }

  // 3b. Best-effort status derivation for a non-clean termination. When a run
  //     crashed (term_reason=crash) or was killed, its dispatches' terminal
  //     cycle status was never written, so they'd stay status=null and
  //     flagDispatchesForDrill would skip them — exactly the run #975 hit. For
  //     a still-occupied slot on a crashed run we derive a failure-leaning
  //     status from the run term_reason so the stalled dispatch becomes
  //     flaggable. We do NOT claim `merged` (that would be a false success on a
  //     run whose terminal status was never recorded); we tag the safe
  //     `errored` abandonReason instead, leaving the status itself null so we
  //     never misreport a positive outcome. Genuinely-idle slots are absent
  //     from slots_snapshot (null), so they were never projected and stay
  //     unflagged.
  const termReason =
    runView && typeof (runView as any).term_reason === "string"
      ? ((runView as any).term_reason as string)
      : "";
  if (CRASH_TERM_REASONS.has(termReason)) {
    for (const d of dispatches) {
      // Only fill dispatches whose terminal outcome was never resolved — an
      // action/cycle that DID record a status keeps it (action-join wins).
      if (d.status === null && d.bucket === null && !d.abandonReason) {
        d.abandonReason = `run-${termReason}`;
      }
    }
  }

  // 4. Reflections — only for the FLAGGED (drill-worthy) dispatches that carry
  //    an anchor. This is the "QA verdict / why it failed" narrative and the
  //    drill-on-flag bound keeps the read fan-out to the dispatches that went
  //    wrong.
  const flagged = flagDispatchesForDrill(dispatches);
  const reflections: RetroReflection[] = [];
  const seenAnchors = new Set<string>();
  for (const d of flagged) {
    const anchor = d.anchorReference;
    if (!anchor || seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    const block = await safeSource(
      "reflections",
      errors,
      { content: "", count: 0 },
      () => readAnchorReflections(anchor),
    );
    reflections.push({
      anchorReference: anchor,
      formatted: block.content,
      count: block.count,
    });
  }

  // 5. Stuck-signals (#890) — run-agnostic; always attempted.
  const stuckSignals = await safeSource<StuckSignal[]>(
    "stuck-signals",
    errors,
    [],
    () => readStuckSignals(),
  );

  // 6. Recommendation-engine recs emitted during the run.
  const recsHash = await safeSource(
    "recommendations",
    errors,
    {} as Record<string, string>,
    () => readRecommendations(runId),
  );
  const recommendations: unknown[] = [];
  for (const raw of Object.values(recsHash || {})) {
    try {
      recommendations.push(JSON.parse(raw));
    } catch {
      // A non-JSON rec value is a corrupt write; keep the raw string so the
      // bundle is still legible rather than silently dropping it.
      recommendations.push(raw);
    }
  }

  // 7. Friction-pattern store across the known dispatch skills.
  const frictionPatterns: MemoryPattern[] = [];
  for (const skill of frictionSkills) {
    const patterns = await safeSource<MemoryPattern[]>(
      "friction",
      errors,
      [],
      () => readFrictionPatterns(skill),
    );
    for (const p of patterns) frictionPatterns.push(p);
  }

  return {
    run_id: runId,
    generatedAt,
    runFound,
    run: runView,
    turns,
    dispatches,
    reflections,
    stuckSignals,
    recommendations,
    frictionPatterns,
    errors,
  };
}
