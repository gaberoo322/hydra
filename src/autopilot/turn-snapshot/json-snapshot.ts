/**
 * turn-snapshot/json-snapshot.ts — the JSON Turn Snapshot builder (ADR-0043
 * Decision 5, issue #4934).
 *
 * `turn-snapshot.ts --format json` runs every collector in one process and
 * hands their TYPED values here. {@link buildTurnSnapshot} projects them onto
 * the schema in src/schemas/turn-snapshot.ts and {@link serializeTurnSnapshot}
 * validates the document on emit — repairing it PER FIELD, never discarding
 * it whole unless it is structurally unusable — and prints it. Never throws.
 *
 * Signal derivations keep the semantics decide.py has always planned on
 * (Plan parity over test/fixtures/turn-snapshot-parity/ pins them), with one
 * deliberate #4949 change: the degraded (gh-derived) orch board counts now
 * feed the four orch board signals by field — the retired kv wire's
 * line-prefix rule never parsed the sorted-keys fallback line, so a degraded
 * data plane read as an empty board. One quirk inherited on purpose:
 * `scout_walk_due` parses the ISO-8601 subset `datetime.fromisoformat`
 * accepts, naive timestamps in local time.
 *
 * Blobs (`usage_eligibility`, `emergency_brake`, `class_stats`, `slot_events`,
 * `target_risk_surface`) are spliced in as the exact JSON text the service
 * returned, so Python sees the same int/float lexemes (`85.0` stays a float).
 */

import type { Classified, DegradedMarker } from "./collector.ts";
import {
  CLASS_STATS_FALLBACK,
  EMERGENCY_BRAKE_FALLBACK,
  SLOT_EVENTS_FALLBACK,
  stallBand,
  USAGE_ELIGIBILITY_FALLBACK,
  type CapacityValue,
  type HealthValue,
  type RecommendationsValue,
  type SchedulerValue,
  type ScoutAlertsValue,
} from "./passthrough.ts";
import { pyFormatFixed, pyStrValue } from "./py-format.ts";
import { pyJsonDumps, pyJsonLoads } from "./py-compat.ts";
import type { PrGateSnapshot, PrPick } from "./pr-gate.ts";
import type { PicksSnapshot } from "./picks.ts";
import type { OrchBoardSnapshot } from "./orch-board.ts";
import type { TargetBoardSnapshot } from "./target-board.ts";
import type { TargetScanSnapshot } from "./target-scan-boards.ts";
import type { TargetRiskSurfaceSnapshot } from "./target-risk-surface.ts";
import { BOARD_SIGNALS_SUPPRESSED, type ArchBoardsValue, type HitlGrillValue, type RedisQueuesValue, type ScoutValue } from "./board-saturation.ts";
import type { RetroValue, WayfinderValue } from "./afk-frontier.ts";
import {
  ALL_DEGRADED_SIGNALS,
  TURN_SNAPSHOT_SCHEMA_VERSION,
  TurnSnapshotSchema,
  type TurnSnapshotDoc,
  type TurnSnapshotPin,
  type TurnSnapshotSignals,
} from "../../schemas/turn-snapshot.ts";

/** Every collector's typed value for one turn — what the JSON is built from. */
export interface TurnSnapshotValues {
  readonly health: HealthValue;
  readonly directionDrift: boolean;
  readonly orchBoard: OrchBoardSnapshot;
  readonly targetBoard: TargetBoardSnapshot;
  readonly untriagedOrphans: Classified<number>;
  readonly needsQaNumbers: Classified<readonly number[]>;
  readonly prGate: PrGateSnapshot;
  readonly picks: PicksSnapshot;
  readonly redisQueues: RedisQueuesValue;
  readonly scout: ScoutValue;
  readonly archBoards: ArchBoardsValue;
  readonly hitlGrill: Classified<HitlGrillValue>;
  readonly targetScan: TargetScanSnapshot;
  readonly targetRiskSurface: TargetRiskSurfaceSnapshot;
  readonly retro: RetroValue;
  readonly wayfinder: WayfinderValue;
  readonly tickets: Classified<string | null>;
  readonly scoutAlerts: ScoutAlertsValue;
  readonly realmShare: Classified<number>;
  readonly usageEligibility: Classified<string>;
  readonly emergencyBrake: Classified<string>;
  readonly classStats: Classified<string>;
  readonly capacity: Classified<CapacityValue>;
  readonly scheduler: SchedulerValue;
  readonly recommendations: Classified<RecommendationsValue>;
  readonly slotEvents: Classified<string>;
}

/** A degraded field, attributed to the collector that reported it. */
export interface SnapshotDegraded extends DegradedMarker {
  readonly collector: string;
}

/** The document plus the raw JSON text of each spliced blob. */
export interface BuiltTurnSnapshot {
  /** The document with each spliced blob's PARSED value (what the schema validates). */
  readonly doc: TurnSnapshotDoc;
  /** Blob name → the exact JSON text spliced into the printed document. */
  readonly rawBlobs: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Python-compatible scalar reads (the derivations decide.py has planned on)
// ---------------------------------------------------------------------------

/** `int(str(raw).strip())`, else `0`. */
export function pyIntOr0(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const m = /^\s*([+-]?\d+(?:_\d+)*)\s*$/.exec(raw);
  return m ? Number((m[1] as string).replace(/_/g, "")) : 0;
}

const FROMISO =
  /^(\d{4})-?(\d{2})-?(\d{2})(?:.(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)?)?$/su;

/**
 * `datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()` for the
 * extended/basic calendar forms (naive = local time), or `null` when Python
 * would raise. Week dates and other exotic forms read as unparseable.
 */
export function pyFromIsoformatEpoch(raw: string): number | null {
  const m = FROMISO.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const ms = m[7] === undefined ? 0 : Number(`0.${m[7]}`) * 1000;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || y < 1) return null;
  const tz = m[8];
  let epochMs: number;
  if (tz === undefined) {
    const local = new Date(y, mo - 1, d, h, mi, s, ms);
    if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) return null;
    epochMs = local.getTime();
  } else {
    const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
    if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
    let offsetSec = 0;
    if (tz !== "Z") {
      const t = /^([+-])(\d{2}):?(\d{2})?:?(\d{2}(?:\.\d+)?)?$/.exec(tz);
      if (!t) return null;
      const sign = t[1] === "-" ? -1 : 1;
      const oh = Number(t[2]);
      const om = Number(t[3] ?? 0);
      const os = Number(t[4] ?? 0);
      if (oh > 23 || om > 59 || os >= 60) return null;
      offsetSec = sign * (oh * 3600 + om * 60 + os);
    }
    epochMs = utc.getTime() - offsetSec * 1000;
  }
  return epochMs / 1000;
}

/** `stale_days`: empty or unparseable → stale. */
export function staleDays(raw: string, days: number, nowMs: number): boolean {
  const s = raw.trim();
  if (s === "") return true;
  const then = pyFromIsoformatEpoch(s.replaceAll("Z", "+00:00"));
  if (then === null) return true;
  return nowMs / 1000 - then > days * 86400;
}

/** `float(raw)` for a finite decimal, else `null` (absent: the previous value is kept). */
function pyFiniteFloat(raw: string): number | null {
  const s = raw.trim();
  if (!/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/.test(s)) return null;
  const n = Number(s.replace(/_/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const issueRef = /^[1-9]\d*$/;

/** A pin as decide.py's legacy parser would accept it, else `null`. */
function pin(p: PrPick | null): TurnSnapshotPin | null {
  if (p === null) return null;
  const branch = p.headRefName.trim();
  if (!Number.isInteger(p.issue) || p.issue <= 0 || !Number.isInteger(p.pr) || p.pr <= 0) return null;
  if (branch === "" || p.headRefName.includes(":")) return null;
  return { issue: p.issue, pr: p.pr, branch };
}

/** The health rule: the first token of `<status> redis=<redis>` != `ok`, or a failed hydra unit. */
function healthFail(h: HealthValue): boolean {
  if (h.failedServices > 0) return true;
  if (!h.service.ok) return true;
  // The first LINE of `<status> redis=<redis>` (Python `str()` of each); an empty value reads as `ok`.
  const line = `${pyStrValue(h.service.value.status)} redis=${pyStrValue(h.service.value.redis)}`.split("\n")[0] as string;
  const first = line.trim().split(/\s+/)[0] || "ok";
  return first !== "ok";
}

/**
 * An orch board count, read BY FIELD from whichever branch produced the
 * counts — the board-state service body or the degraded path's
 * `deriveBoardState` values (#4949). The retired kv wire keyed on the
 * counts line's `{"needs_qa"` prefix, so the sorted-keys fallback line was
 * never parsed and the four orch board signals read false exactly when the
 * data plane was degraded. Both `BoardCounts` value variants carry the same
 * keys, so one field read serves both; only a withheld counts read
 * (`source: "none"`) reads as 0 (#4130).
 */
/** The four count keys the orch board signals read — never the array-valued stale lists (#4949). */
type OrchBoardCountKey = "needs_qa" | "ready_for_agent" | "needs_triage" | "needs_research";

function orchBoardCount(s: OrchBoardSnapshot, key: OrchBoardCountKey): number {
  if (s.counts.source === "none") return 0;
  const v = (s.counts.values as Readonly<Record<string, unknown>>)[key];
  return pyIntOr0(v === undefined ? undefined : pyJsonDumps(v));
}

/** A Target count line's value (`<key>=<value>`, the last one wins), or `0` when not printed. */
function targetCount(s: TargetBoardSnapshot, key: string): number {
  if (!s.counts.ok) return 0;
  if (s.counts.value === null) return 0;
  let raw: string | undefined;
  for (const [k, v] of s.counts.value) if (k === key) raw = v;
  return pyIntOr0(raw);
}

/**
 * The `target_risk_surface` blob: the resolved Target Manifest facts, or the
 * fail-closed `{ok: false, errors}` object naming why they could not be read
 * (decide.py's wire_or_retire_target dispatch then carries no carve-out, #4411).
 */
export function targetRiskSurfaceBlob(s: TargetRiskSurfaceSnapshot): unknown {
  const m = s.manifest;
  return "reason" in m ? { ok: false, errors: [`target_risk_surface_json: ${m.reason}`] } : m.value;
}

/** The text of one Classified body, or the fail-open fallback literal. */
function blobText(b: Classified<string>, fallback: string): string {
  return b.ok ? b.value : fallback;
}

export function buildTurnSnapshot(v: TurnSnapshotValues, opts: { nowMs: number; degraded?: readonly SnapshotDegraded[] }): BuiltTurnSnapshot {
  const degraded: SnapshotDegraded[] = [...(opts.degraded ?? [])];
  const anchor = (collector: string, field: string, raw: string | number | null): number | null => {
    if (raw === null) return null;
    const s = String(raw).trim();
    if (issueRef.test(s)) return Number(s);
    degraded.push({ collector, field, reason: "not-an-issue-number" });
    return null;
  };

  const glm = v.prGate.glmRed.ok ? v.prGate.glmRed.value : { bucket: [], pick: null };
  const dirtyFix = v.prGate.dirtyFix.ok ? v.prGate.dirtyFix.value : { pick: null, surface: [] };
  const wip = v.targetBoard.wip.ok ? v.targetBoard.wip.value : null;
  const scan = v.targetScan.signals.ok ? v.targetScan.signals.value : null;
  const board = v.archBoards.board.ok ? v.archBoards.board.value : BOARD_SIGNALS_SUPPRESSED;
  const hitl = v.hitlGrill.ok ? v.hitlGrill.value : { open: 0, saturated: true };
  const ticketsPick = v.tickets.ok ? v.tickets.value : null;
  const share = v.realmShare.ok ? Number(pyFormatFixed(v.realmShare.value, 4)) : null;
  const lastWalk = v.scout.lastWalkIso.ok ? (v.scout.lastWalkIso.value ?? "").replaceAll('"', "") : "";

  const signals: TurnSnapshotSignals = {
    orch_work_available: orchBoardCount(v.orchBoard, "ready_for_agent") > 0,
    needs_qa_orch: orchBoardCount(v.orchBoard, "needs_qa") > 0,
    needs_research: orchBoardCount(v.orchBoard, "needs_research") > 0,
    needs_triage_orch: orchBoardCount(v.orchBoard, "needs_triage") > 0,
    needs_qa_numbers: v.needsQaNumbers.ok ? [...v.needsQaNumbers.value] : [],
    orch_needs_triage_items: v.orchBoard.needsTriageItems.ok ? [...v.orchBoard.needsTriageItems.value] : [],
    untriaged_orphans_orch: (v.untriagedOrphans.ok ? v.untriagedOrphans.value : 0) > 0,

    target_work_available: (v.redisQueues["work-queue"].ok ? v.redisQueues["work-queue"].value : 0) > 0,
    target_board_work_available: targetCount(v.targetBoard, "target_ready_for_agent") > 0,
    target_board_research_due: targetCount(v.targetBoard, "target_ready_for_agent") === 0,
    target_wip_saturated: wip?.saturated ?? false,
    needs_qa_target: targetCount(v.targetBoard, "target_needs_qa") > 0,
    target_needs_qa_pr_ref: v.targetBoard.needsQaPr.ref,
    target_needs_qa_pr_head: v.targetBoard.needsQaPr.head,
    target_dev_resume_pick: pin(v.targetBoard.devResumePick.ok ? v.targetBoard.devResumePick.value : null),
    needs_triage_target: targetCount(v.targetBoard, "target_needs_triage") > 0,
    target_needs_triage_items: scan ? [...scan.needsTriageItems] : [],

    health_fail: healthFail(v.health),
    scout_walk_due: staleDays(lastWalk, 7, opts.nowMs),
    scout_board_saturated: pyIntOr0(v.scout.openEnhancements.ok ? v.scout.openEnhancements.value : "0") > 20,
    scout_alert_eligible_count: v.scoutAlerts.eligible.ok ? v.scoutAlerts.eligible.value : 0,

    orch_backfill_idle: board.backfillIdle,
    arch_board_saturated: board.archSaturated,
    hitl_grill_open: hitl.open,
    hitl_grill_saturated: hitl.saturated,
    orch_board_signals_degraded: v.archBoards.orchBoardDegraded === "1",
    cleanup_board_saturated: board.cleanupSaturated,
    skill_prune_board_saturated: board.skillPruneSaturated,
    target_backfill_idle: scan?.backfillIdle ?? false,
    target_cleanup_board_saturated: scan?.cleanupSaturated ?? true,
    wire_or_retire_target_available: (scan?.wireOrRetireTriage ?? 0) > 0,
    design_qa_target_due: scan ? !scan.designQaSaturated && v.targetScan.adrPresent : false,
    design_qa_target_saturated: scan?.designQaSaturated ?? true,
    retro_run_available: v.retro.runs.ok && v.retro.runs.value.available,
    retro_run_drillable: v.retro.drillable === true,

    orch_prs_dirty: [...v.prGate.dirty],
    orch_prs_unchecked: [...v.prGate.unchecked],
    orch_prs_behind: [...v.prGate.behind],
    orch_ci_trigger_stale: v.prGate.ciTriggerStale.ok && v.prGate.ciTriggerStale.value,
    orch_prs_glm_red: [...glm.bucket],
    orch_glm_red_forward_fix: pin(glm.pick),
    orch_dev_resume_pick: pin(v.prGate.devResumePick.ok ? v.prGate.devResumePick.value : null),
    orch_dirty_forward_fix: pin(dirtyFix.pick),
    orch_prs_dirty_surface: dirtyFix.surface.map((e) => ({ pr: e.pr, closing_issue: e.closingIssue })),

    orch_pending_grill_anchor: anchor("picks", "orch_pending_grill_anchor", v.picks.grillPick),
    orch_dev_ready_anchor: anchor("picks", "orch_dev_ready_anchor", v.picks.devReadyPick),

    wayfinder_orch_frontier: anchor("wayfinder-frontier", "wayfinder_orch_frontier", v.wayfinder.frontier),
    wayfinder_orch_ticket_type: v.wayfinder.ticketType,
    wayfinder_orch_inflight_global: v.wayfinder.inflightGlobal,
    tickets_available: ticketsPick !== null,
    tickets_orch_pending_spec: anchor("tickets", "tickets_orch_pending_spec", ticketsPick),

    orch_realm_weekly_share: share,
  };

  // Blobs: the exact JSON text the service returned; absent when it does not parse.
  const rawBlobs: Record<string, string> = {};
  const blobs: TurnSnapshotDoc["blobs"] = {};
  const addBlob = (name: "usage_eligibility" | "emergency_brake" | "class_stats" | "slot_events" | "target_risk_surface", collector: string, text: string) => {
    const parsed = pyJsonLoads(text);
    if (!parsed.ok) {
      degraded.push({ collector, field: name, reason: "unparseable-body" });
      return;
    }
    rawBlobs[name] = text;
    (blobs as Record<string, unknown>)[name] = parsed.value; // shape-checked by the per-field repair on emit
  };
  addBlob("usage_eligibility", "usage-eligibility", blobText(v.usageEligibility, USAGE_ELIGIBILITY_FALLBACK));
  addBlob("emergency_brake", "emergency-brake", blobText(v.emergencyBrake, EMERGENCY_BRAKE_FALLBACK));
  addBlob("class_stats", "class-stats", blobText(v.classStats, CLASS_STATS_FALLBACK));
  addBlob("slot_events", "slot-events", blobText(v.slotEvents, SLOT_EVENTS_FALLBACK));
  addBlob("target_risk_surface", "target-risk-surface", pyJsonDumps(targetRiskSurfaceBlob(v.targetRiskSurface)));
  blobs.candidate_exclusions = v.picks.candidateExclusions.map((r) => ({ ...r }));

  const spend = pyFiniteFloat(v.scout.spendUsd);
  if (spend === null) degraded.push({ collector: "scout", field: "scout_spend_usd_today", reason: "not-numeric" });

  const doc: TurnSnapshotDoc = {
    schema_version: TURN_SNAPSHOT_SCHEMA_VERSION,
    generated_at: new Date(opts.nowMs).toISOString(),
    signals,
    blobs,
    ...(spend === null ? {} : { scout_spend_usd_today: spend }),
    degraded,
    validation: { ok: true },
    observability: observability(v),
  };
  return { doc, rawBlobs };
}

/** The collector values no decide.py rule reads — the operator's per-turn record. */
function observability(v: TurnSnapshotValues): Record<string, unknown> {
  const sched = v.scheduler.scheduler;
  return {
    health: v.health,
    direction_drift: v.directionDrift,
    capacity: v.capacity,
    scheduler: {
      codex_running: v.scheduler.codexRunning,
      scheduler: sched,
      stall: sched.ok ? stallBand(sched.value.nonMerges) : null,
    },
    recommendations: v.recommendations,
    redis_queues: v.redisQueues,
    // #412's live-PR count — the kv wire printed it for the session to read;
    // no decide.py rule gates on it (dev_orch gates on its slot + pick).
    active_dev_orch: v.picks.activeDevOrch,
  };
}

// ---------------------------------------------------------------------------
// Validate on emit (per-field repair) + serialise
// ---------------------------------------------------------------------------

const RAW_TOKEN = (name: string) => `@@turn-snapshot-raw-blob:${name}@@`;
type Issue = { path: string; message: string };

const cloneSignals = (): TurnSnapshotSignals => structuredClone({ ...ALL_DEGRADED_SIGNALS }) as TurnSnapshotSignals;

/**
 * The all-degraded document (ADR-0043 Decision 5): every signal at its
 * {@link ALL_DEGRADED_SIGNALS} value, no blobs (decide.py keeps the previous
 * blob values on state), one marker naming why.
 */
export function allDegradedTurnSnapshot(generatedAt: string, reason: string): TurnSnapshotDoc {
  return {
    schema_version: TURN_SNAPSHOT_SCHEMA_VERSION,
    generated_at: generatedAt,
    signals: cloneSignals(),
    blobs: {},
    degraded: [{ collector: "turn-snapshot", field: "*", reason }],
    validation: { ok: true },
  };
}

/**
 * Repair `doc` from zod issues, field by field: an invalid or unknown signal
 * takes its all-degraded value (unknown keys are dropped); an invalid blob,
 * `scout_spend_usd_today`, `observability` or `degraded` entry is dropped.
 * Returns null when an issue sits outside those fields (structural).
 */
function repairFields(doc: TurnSnapshotDoc, issues: readonly { path: readonly PropertyKey[]; code: string; message: string; keys?: readonly string[] }[]): {
  doc: TurnSnapshotDoc;
  rawDropped: Set<string>;
} | null {
  const signals = { ...(doc.signals as Record<string, unknown>) };
  const blobs = { ...(doc.blobs as Record<string, unknown>) };
  const dropDegraded = new Set<number>();
  const markers: SnapshotDegraded[] = [];
  const rawDropped = new Set<string>();
  let spend = doc.scout_spend_usd_today;
  let obs = doc.observability;
  const mark = (field: string, message: string) => markers.push({ collector: "turn-snapshot", field, reason: `schema-invalid: ${message}` });
  for (const issue of issues) {
    const [head, key] = issue.path;
    if (head === "signals" && typeof signals === "object") {
      if (key === undefined && issue.code === "unrecognized_keys") {
        for (const k of issue.keys ?? []) {
          delete signals[k];
          mark(`signals.${k}`, issue.message);
        }
        continue;
      }
      if (typeof key === "string" && key in ALL_DEGRADED_SIGNALS) {
        signals[key] = structuredClone((ALL_DEGRADED_SIGNALS as Record<string, unknown>)[key]);
        mark(`signals.${key}`, issue.message);
        continue;
      }
      return null;
    }
    if (head === "blobs") {
      const names = key === undefined && issue.code === "unrecognized_keys" ? [...(issue.keys ?? [])] : typeof key === "string" ? [key] : null;
      if (names === null) return null;
      for (const name of names) {
        delete blobs[name];
        rawDropped.add(name);
        mark(`blobs.${name}`, issue.message);
      }
      continue;
    }
    if (head === "degraded" && typeof key === "number") {
      dropDegraded.add(key);
      continue;
    }
    if (head === "scout_spend_usd_today") {
      spend = undefined;
      mark("scout_spend_usd_today", issue.message);
      continue;
    }
    if (head === "observability") {
      obs = undefined;
      mark("observability", issue.message);
      continue;
    }
    return null;
  }
  if (dropDegraded.size > 0) markers.push({ collector: "turn-snapshot", field: "degraded", reason: "malformed-entry-dropped" });
  const { scout_spend_usd_today: _s, observability: _o, ...rest } = doc;
  return {
    doc: {
      ...rest,
      signals: signals as TurnSnapshotSignals,
      blobs: blobs as TurnSnapshotDoc["blobs"],
      ...(spend === undefined ? {} : { scout_spend_usd_today: spend }),
      degraded: [...doc.degraded.filter((_, i) => !dropDegraded.has(i)), ...markers],
      validation: { ok: true },
      ...(obs === undefined ? {} : { observability: obs }),
    },
    rawDropped,
  };
}

const describeIssues = (issues: readonly Issue[]) => issues.map((i) => `${i.path}: ${i.message}`).join("; ");

/**
 * Validate the document against the schema and print it. An invalid field is
 * repaired in place (see {@link repairFields}) with a `degraded` marker and a
 * stderr note; a document still invalid after that is replaced by the
 * {@link allDegradedTurnSnapshot} — never a throw (ADR-0043 Decision 5).
 */
export function serializeTurnSnapshot(built: BuiltTurnSnapshot): { text: string; valid: boolean; repaired: boolean; note: string | null } {
  let doc: TurnSnapshotDoc = built.doc;
  let raw: Record<string, string> = { ...built.rawBlobs };
  let note: string | null = null;
  let valid = true;
  let repaired = false;
  const first = TurnSnapshotSchema.safeParse(doc);
  if (!first.success) {
    const issues: Issue[] = first.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
    const fixed = repairFields(doc, first.error.issues as never);
    const second = fixed === null ? null : TurnSnapshotSchema.safeParse(fixed.doc);
    if (fixed !== null && second?.success) {
      doc = fixed.doc;
      for (const name of fixed.rawDropped) delete raw[name];
      repaired = true;
      note = `turn-snapshot: ${issues.length} field(s) failed schema validation (${describeIssues(issues)}) — each repaired to its degraded value with a marker; the rest of the snapshot stands (issue #4934)`;
    } else {
      valid = false;
      doc = allDegradedTurnSnapshot(built.doc.generated_at, `schema-invalid: ${describeIssues(issues)}`.slice(0, 500));
      raw = {};
      note = `turn-snapshot: the JSON snapshot is structurally invalid (${describeIssues(issues)}) — emitted the all-degraded snapshot instead (issue #4934)`;
    }
  }
  const blobs: Record<string, unknown> = { ...doc.blobs };
  for (const name of Object.keys(raw)) blobs[name] = RAW_TOKEN(name);
  let text = JSON.stringify({ ...doc, blobs });
  for (const [name, rawText] of Object.entries(raw)) text = text.replace(JSON.stringify(RAW_TOKEN(name)), () => rawText);
  return { text: `${text}\n`, valid, repaired, note };
}
