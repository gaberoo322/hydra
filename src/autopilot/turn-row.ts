/**
 * Turn Row — the one module that knows the shape of a stored Autopilot Turn
 * record (the member `recordTurn` writes into the run's turns ZSET).
 *
 * Before this module each reader hand-parsed the member JSON with its own
 * defaults (`Number(parsed.turn_n || 0)`, a re-guard copy in `class-state.ts`,
 * a second class-of-action resolver in `run-reads.ts`). Now:
 *
 *   - WRITE: {@link serializeTurnMember} owns the stored key order and the
 *     omit-when-absent rule; `recordTurn` builds a {@link StoredTurn} and the
 *     compiler checks it. {@link sanitizeParentExceptions} and
 *     {@link sanitizeTurnObservabilityFields} are the per-field guards, called
 *     by `recordTurn` before storing and by {@link parseTurnRow} after reading
 *     (one guard per field, no copies).
 *   - READ: {@link parseTurnRow} is pure. TOLERANCE RULE — it returns null
 *     (the caller logs one warning and skips) only when the member is not a
 *     JSON object or has no integer `turn_n`. Any other field that is missing
 *     or malformed reads as ABSENT, never as a default such as 0, `{}` or
 *     `true`: absence means no information.
 *   - {@link readRunTurns} reaches Redis only through the
 *     `listAutopilotRunTurnsDesc` accessor (which still returns strings).
 *
 * Slice B (#5445): the run view, retro projection and stalled-dispatch signal
 * read {@link JoinedTurn}s — a Turn Row whose dispatch actions carry their
 * joined cycle outcome. {@link attachOutcomes} builds one from a row plus an
 * outcome resolver; {@link joinedTurnFromWire} rebuilds one from the wire form
 * the run view serves (outcomes already attached).
 */

import { listAutopilotRunTurnsDesc } from "../redis/autopilot-runs.ts";
import { logger } from "../logger.ts";

/** One class's folded verdict on a turn (heartbeat.py `plan.events` fold). */
export interface TurnDecision {
  outcome: string;
  reason: string;
}

/** One mirrored Run Ledger parent-exception row (issue #5324). */
export interface TurnParentException {
  cause: string;
  turn: number;
  source: string;
  detail: string;
  ts_epoch: number;
}

/** The sanitised #4635 observability fields; a key is present only when valid. */
export interface TurnObservabilityFields {
  decisions?: Record<string, TurnDecision>;
  burned_classes?: string[];
  usage_shed?: string[];
  usage_allow?: boolean;
}

/** Where a guard warning came from; absent on the read path (no run context). */
export interface TurnGuardContext {
  runId?: string;
  turnN?: number;
}

/** One dispatch action with its facets resolved once. */
export interface TurnDispatch {
  /** Position in the turn's `actions` array (the synthetic cycle-id index). */
  index: number;
  /** Dispatch class: `class` first (legacy rows), then `slot`; null when neither. */
  class: string | null;
  /** First present of cycleId, autopilotTurnId, worktreeBranch; null when none. */
  cycleIdCandidate: string | null;
  /** The action object itself. */
  action: Record<string, unknown>;
}

/**
 * The cycle outcome joined onto a dispatch action. Every field is optional on
 * the type because a wire-rebuilt outcome (see {@link joinedTurnFromWire}) is
 * whatever the producer attached; the live join always fills all six.
 */
export interface DispatchOutcome {
  cycleId?: string;
  status?: string;
  prNumber?: string | number | null;
  filesChanged?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

/** A dispatch with its joined outcome; `null` = no cycle record yet (pending). */
export interface JoinedDispatch extends TurnDispatch {
  outcome: DispatchOutcome | null;
}

/**
 * A Turn Row whose dispatch actions carry their joined outcome. `dispatches`
 * holds the typed {@link JoinedDispatch}es; `raw` is the WIRE object — the
 * stored object (every key, known or unknown) with `outcome` attached to each
 * dispatch action — which is exactly what the run view serves.
 */
export interface JoinedTurn extends Omit<TurnRow, "dispatches"> {
  dispatches: JoinedDispatch[];
}

/** The member `recordTurn` stores. Key order here is the stored key order. */
export interface StoredTurn {
  turn_n: number;
  epoch: number;
  actions: unknown[];
  reasons: unknown[];
  slots_snapshot: object;
  signals_snapshot: object;
  tokens_after: number;
  idle_turns: number;
  decisions?: Record<string, TurnDecision>;
  burned_classes?: string[];
  usage_shed?: string[];
  usage_allow?: boolean;
  parent_exceptions?: TurnParentException[];
}

/** A parsed Turn Row. Every field but `turn_n` is optional: absent = no information. */
export interface TurnRow {
  turn_n: number;
  epoch?: number;
  actions?: unknown[];
  slots_snapshot?: Record<string, unknown>;
  signals_snapshot?: Record<string, unknown>;
  idle_turns?: number;
  decisions?: Record<string, TurnDecision>;
  burned_classes?: string[];
  usage_shed?: string[];
  usage_allow?: boolean;
  parent_exceptions?: TurnParentException[];
  /** Dispatch actions, facets resolved. `[]` when there are none. */
  dispatches: TurnDispatch[];
  /** The raw parsed object, so a consumer that must pass unknown keys through still can. */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-field guards (shared by the write and read paths)
// ---------------------------------------------------------------------------

function ctxFields(ctx: TurnGuardContext): Record<string, unknown> {
  return { runId: ctx.runId, turnN: ctx.turnN };
}

/**
 * Keep only well-formed parent-exception rows (string cause/source, integer
 * turn and ts_epoch); drop the rest with a warn. `undefined` when the field
 * is absent or yields no valid row, so the member omits it. A genuinely empty
 * array is kept as `[]`: it marks a clean, mirror-era turn (#5324).
 */
export function sanitizeParentExceptions(
  raw: unknown,
  ctx: TurnGuardContext = {},
  opts: { lenientSource?: boolean } = {},
): TurnParentException[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    logger.warn(ctxFields(ctx), "[autopilot/turn-row] dropped non-array parent_exceptions field");
    return undefined;
  }
  const kept: TurnParentException[] = [];
  for (const row of raw) {
    const r = row as Partial<TurnParentException> | null;
    if (
      r &&
      typeof r === "object" &&
      typeof r.cause === "string" &&
      (opts.lenientSource === true || typeof r.source === "string") &&
      Number.isInteger(r.turn) &&
      Number.isInteger(r.ts_epoch)
    ) {
      kept.push({
        cause: r.cause,
        turn: r.turn as number,
        source: typeof r.source === "string" ? r.source : "",
        detail: typeof r.detail === "string" ? r.detail : "",
        ts_epoch: r.ts_epoch as number,
      });
    }
  }
  if (kept.length !== raw.length) {
    logger.warn(
      { ...ctxFields(ctx), dropped: raw.length - kept.length },
      "[autopilot/turn-row] dropped malformed parent_exceptions rows",
    );
  }
  return kept.length > 0 || raw.length === 0 ? kept : undefined;
}

/**
 * Sanitise the #4635 observability fields off a (loose-schema) turn body.
 *
 * The turn row is load-bearing for run tallies (dispatches, turns,
 * tokens), so the HTTP schema accepts the fields as `z.unknown()` and THIS
 * filter — not a 400 — is where shape is enforced: a malformed field is
 * dropped with a `logger.warn` (fail loud), and the row records everything
 * else. A key whose value was absent or entirely malformed comes back
 * `undefined`, so the persisted member simply omits it (absent = no
 * information).
 */
export function sanitizeTurnObservabilityFields(
  body: {
    decisions?: unknown;
    burned_classes?: unknown;
    usage_shed?: unknown;
    usage_allow?: unknown;
  },
  ctx: TurnGuardContext = {},
): TurnObservabilityFields {
  const out: TurnObservabilityFields = {};

  // decisions: keep only entries whose value is an object with string
  // outcome + string reason. Non-string keys cannot occur post-JSON-parse.
  if (body.decisions !== undefined) {
    if (body.decisions && typeof body.decisions === "object" && !Array.isArray(body.decisions)) {
      const kept: Record<string, TurnDecision> = {};
      const dropped: string[] = [];
      for (const [cls, val] of Object.entries(body.decisions as Record<string, unknown>)) {
        if (
          val &&
          typeof val === "object" &&
          typeof (val as { outcome?: unknown }).outcome === "string" &&
          typeof (val as { reason?: unknown }).reason === "string"
        ) {
          kept[cls] = {
            outcome: (val as { outcome: string }).outcome,
            reason: (val as { reason: string }).reason,
          };
        } else {
          dropped.push(cls);
        }
      }
      if (dropped.length > 0) {
        logger.warn(
          { ...ctxFields(ctx), dropped },
          "[autopilot/turn-row] dropped malformed decisions entries",
        );
      }
      out.decisions = kept;
    } else {
      logger.warn(
        { ...ctxFields(ctx), value: body.decisions },
        "[autopilot/turn-row] dropped non-object decisions field",
      );
    }
  }

  const stringList = (value: unknown, label: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      logger.warn(
        { ...ctxFields(ctx), value },
        `[autopilot/turn-row] dropped non-list ${label} field`,
      );
      return undefined;
    }
    const kept = value.filter((el): el is string => typeof el === "string");
    if (kept.length !== value.length) {
      logger.warn(
        { ...ctxFields(ctx), label, dropped: value.length - kept.length },
        `[autopilot/turn-row] dropped non-string ${label} elements`,
      );
    }
    return kept;
  };
  const burned = stringList(body.burned_classes, "burned_classes");
  if (burned !== undefined) out.burned_classes = burned;
  const shed = stringList(body.usage_shed, "usage_shed");
  if (shed !== undefined) out.usage_shed = shed;

  if (body.usage_allow !== undefined) {
    if (typeof body.usage_allow === "boolean") {
      out.usage_allow = body.usage_allow;
    } else {
      logger.warn(
        { ...ctxFields(ctx), value: body.usage_allow },
        "[autopilot/turn-row] dropped non-boolean usage_allow field",
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Dispatch-action facets
// ---------------------------------------------------------------------------

/**
 * Resolve a dispatch action's class: the legacy `class` field is honoured
 * first for older turn rows (#4634), then `slot` (what decide.py's
 * make_dispatch emits today). Null when neither is a non-empty string.
 */
export function resolveDispatchClass(action: Record<string, unknown>): string | null {
  if (typeof action.class === "string" && action.class) return action.class;
  if (typeof action.slot === "string" && action.slot) return action.slot;
  return null;
}

/**
 * Resolve a dispatch action's cycle-id candidate in the order reap.py /
 * dispatch.sh stamp them: `cycleId`, then `autopilotTurnId`, then
 * `worktreeBranch`. Null when the action carries none of them (the caller
 * synthesises `<run_id>:<turn_n>:<index>`).
 */
export function resolveCycleIdCandidate(action: Record<string, unknown>): string | null {
  for (const key of ["cycleId", "autopilotTurnId", "worktreeBranch"] as const) {
    const v = action[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * The one cycle-id rule: the dispatch's candidate, else the synthetic
 * `<run_id>:<turn_n>:<index>` id (mirrors reap.py / dispatch.sh allocation).
 */
export function resolveCycleId(
  runId: string,
  turnN: number,
  index: number,
  candidate: string | null,
): string {
  return candidate ?? `${runId}:${turnN}:${index}`;
}

function resolveDispatches(actions: unknown[] | undefined): TurnDispatch[] {
  const out: TurnDispatch[] = [];
  if (!actions) return out;
  actions.forEach((a, index) => {
    if (!a || typeof a !== "object" || (a as { type?: unknown }).type !== "dispatch") return;
    const action = a as Record<string, unknown>;
    out.push({
      index,
      class: resolveDispatchClass(action),
      cycleIdCandidate: resolveCycleIdCandidate(action),
      action,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

function plainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Parse one stored turns-ZSET member. Pure. Null (caller logs + skips) only
 * for non-JSON, non-object JSON, or a missing/non-integer `turn_n`; every
 * other field is guarded and reads as absent when missing or malformed.
 */
export function parseTurnRow(member: string): TurnRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(member);
  } catch {
    /* intentional: an unparseable member is the documented null result; readRunTurns logs the skip count */
    return null;
  }
  return parseTurnObject(parsed);
}

/** {@link parseTurnRow} for an already-parsed object (same tolerance rule). */
export function parseTurnObject(parsed: unknown): TurnRow | null {
  const raw = plainObject(parsed);
  if (!raw || !Number.isInteger(raw.turn_n)) return null;

  const row: TurnRow = { turn_n: raw.turn_n as number, dispatches: [], raw };
  if (typeof raw.epoch === "number" && Number.isFinite(raw.epoch)) row.epoch = raw.epoch;
  if (Array.isArray(raw.actions)) {
    row.actions = raw.actions;
    row.dispatches = resolveDispatches(raw.actions);
  }
  const slots = plainObject(raw.slots_snapshot);
  if (slots) row.slots_snapshot = slots;
  const signals = plainObject(raw.signals_snapshot);
  if (signals) row.signals_snapshot = signals;
  if (typeof raw.idle_turns === "number" && Number.isFinite(raw.idle_turns)) row.idle_turns = raw.idle_turns;

  const ctx: TurnGuardContext = { turnN: row.turn_n };
  Object.assign(row, sanitizeTurnObservabilityFields(raw, ctx));
  // Read side is lenient on `source` (INV-8: builder-health folds never read it) and
  // an all-malformed array still marks a mirror-era row, as before the module.
  const pe = sanitizeParentExceptions(raw.parent_exceptions, ctx, { lenientSource: true });
  if (pe !== undefined) row.parent_exceptions = pe;
  else if (Array.isArray(raw.parent_exceptions)) row.parent_exceptions = [];
  return row;
}

function outcomeFromWire(v: unknown): DispatchOutcome | null {
  return plainObject(v) ? (v as DispatchOutcome) : null;
}

/**
 * Join outcomes onto a Turn Row. `outcomeFor` is asked once per dispatch; the
 * result's `raw` is a copy of the stored object whose dispatch actions carry
 * `outcome` (appended after the stored keys, as the pre-module join did).
 * Non-dispatch actions and every other stored key pass through untouched.
 */
export function attachOutcomes(
  row: TurnRow,
  outcomeFor: (d: TurnDispatch) => DispatchOutcome | null,
): JoinedTurn {
  const dispatches: JoinedDispatch[] = row.dispatches.map((d) => {
    const outcome = outcomeFor(d);
    return { ...d, action: { ...d.action, outcome }, outcome };
  });
  const raw: Record<string, unknown> = { ...row.raw };
  if (row.actions) {
    const actions = row.actions.slice();
    for (const d of dispatches) actions[d.index] = d.action;
    raw.actions = actions;
  }
  return { ...row, dispatches, raw };
}

/**
 * Rebuild a {@link JoinedTurn} from the wire form the run view serves (outcomes
 * already attached to dispatch actions). Null under the Turn Row tolerance rule
 * (not an object, or no integer `turn_n`).
 */
export function joinedTurnFromWire(wire: unknown): JoinedTurn | null {
  const row = parseTurnObject(wire);
  return row ? attachOutcomes(row, (d) => outcomeFromWire(d.action.outcome)) : null;
}

/**
 * Serialise a {@link StoredTurn} to the stored member. Optional observability
 * keys are written only when present (absent = no information); existing keys
 * keep their order so the member is byte-identical to the pre-module writer.
 */
export function serializeTurnMember(turn: StoredTurn): string {
  return JSON.stringify({
    turn_n: turn.turn_n,
    epoch: turn.epoch,
    actions: turn.actions,
    reasons: turn.reasons,
    slots_snapshot: turn.slots_snapshot,
    signals_snapshot: turn.signals_snapshot,
    tokens_after: turn.tokens_after,
    idle_turns: turn.idle_turns,
    ...(turn.decisions !== undefined ? { decisions: turn.decisions } : {}),
    ...(turn.burned_classes !== undefined ? { burned_classes: turn.burned_classes } : {}),
    ...(turn.usage_shed !== undefined ? { usage_shed: turn.usage_shed } : {}),
    ...(turn.usage_allow !== undefined ? { usage_allow: turn.usage_allow } : {}),
    ...(turn.parent_exceptions !== undefined ? { parent_exceptions: turn.parent_exceptions } : {}),
  });
}

// ---------------------------------------------------------------------------
// Typed read
// ---------------------------------------------------------------------------

/**
 * Parse a batch of members (newest-first order preserved), logging ONE warning
 * when any were skipped. Pure apart from that log.
 */
export function parseTurnRows(members: readonly string[], runId?: string): TurnRow[] {
  const rows: TurnRow[] = [];
  let skipped = 0;
  for (const member of members) {
    const row = parseTurnRow(member);
    if (row === null) skipped += 1;
    else rows.push(row);
  }
  if (skipped > 0) {
    logger.warn({ runId, skipped }, "[autopilot/turn-row] skipped unparseable turn members");
  }
  return rows;
}

/**
 * Read a run's turns newest-first as typed Turn Rows. Reaches Redis only
 * through `listAutopilotRunTurnsDesc`; lets that accessor's errors propagate
 * (each caller already owns its degrade path).
 */
export async function readRunTurns(
  runId: string,
  limit: number,
  list: (runId: string, limit: number) => Promise<string[]> = listAutopilotRunTurnsDesc,
): Promise<TurnRow[]> {
  return parseTurnRows(await list(runId, limit), runId);
}
