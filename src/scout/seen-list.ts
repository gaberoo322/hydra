/**
 * Tool-scout seen-list (issue #484).
 *
 * Append-only Redis-backed ledger of every tool the `/hydra-tool-scout`
 * skill has ever considered. Lets re-runs skip duplicates without
 * re-filing issues. Schema documented inline below.
 *
 * Storage: one Redis hash per canonical slug at
 *   `hydra:scout:tools-considered:<slug>`  (see src/redis/keys.ts)
 *
 * The keys are NOT TTLed — we want a permanent record of every
 * consideration. "Re-eval eligibility" is computed from the hash
 * fields below, not from key expiry. This is by design — a tool we
 * rejected three years ago should still be one Redis lookup away.
 *
 * Access goes through `src/redis/*` per the codebase convention; this
 * module re-exports a small typed surface so callers don't have to
 * stringify themselves.
 */

import {
  getScoutToolsConsidered,
  scoutToolsConsideredExists,
  setScoutToolsConsidered,
} from "../redis/scout.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome the scout reached for this candidate. */
export type ScoutDecision = "filed" | "rejected" | "skipped-cooldown";

/** Trigger source for the scout invocation that recorded this entry. */
export type ScoutTrigger = "manual" | "calendar" | "alert" | "gap";

/**
 * Strongly-typed shape of a seen-list entry. Redis stores everything as
 * strings; `getSeen` parses back to this shape.
 */
export interface ScoutSeenEntry {
  tool: string;
  slug: string;
  category: string;
  decision: ScoutDecision;
  reason: string;
  /** ISO-8601 UTC timestamp of the most recent decision write. */
  filedAt: string;
  /** GitHub issue number when `decision === "filed"`; null otherwise. */
  issueNum: number | null;
  /**
   * Optional override timestamp (ISO-8601) — when set, `eligibleForReEval`
   * returns true once `now >= reEvalAt`. Operators set this to force an
   * earlier re-scout (e.g. when a major version ships).
   */
  reEvalAt: string | null;
  /** Trigger source that produced this entry. */
  trigger: ScoutTrigger;
  /**
   * ISO-8601 UTC — heartbeat updated on every scout walk that sees the
   * tool, even when the cooldown causes us to skip. Lets us answer "when
   * did we last evaluate this?".
   */
  lastChecked: string;
  /** Rubric version (see docs/ai-leverage-rubric.md frontmatter). */
  rubricVersion: string | null;
  /**
   * Median AI-leverage score (1–5) at scoring time, if computed. Null when
   * the tool was rejected by maintenance/dedup gates before scoring.
   */
  leverageScore: number | null;
}

/** Fields callers supply when recording a decision. */
export interface RecordDecisionInput {
  tool: string;
  category: string;
  /** Required for `decision === "filed"`; ignored otherwise. */
  issueNum?: number | null;
  /** Optional override of the default re-eval timestamp. */
  reEvalAt?: string | null;
  trigger?: ScoutTrigger;
  rubricVersion?: string | null;
  leverageScore?: number | null;
  /** Optional override of `new Date()` for deterministic tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Cooldown policy
// ---------------------------------------------------------------------------

/** Default cooldown for rejected tools — 90 days. */
export const REJECT_COOLDOWN_DAYS = 90;

/** Default cooldown for filed-then-wontfix tools — 90 days. */
export const WONTFIX_COOLDOWN_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetch a seen-list entry by canonical slug. Returns null if no record
 * exists. Caller is expected to have already canonicalized the slug via
 * `aliases.canonicalizeSlug` — this function trusts its input.
 */
export async function getSeen(slug: string): Promise<ScoutSeenEntry | null> {
  if (!slug || typeof slug !== "string") {
    throw new TypeError(`getSeen: expected non-empty slug, got ${typeof slug}`);
  }
  const exists = await scoutToolsConsideredExists(slug);
  if (!exists) return null;

  const raw = await getScoutToolsConsidered(slug);
  // empty hash → treat the same as missing.
  if (!raw || Object.keys(raw).length === 0) return null;

  return parseEntry(slug, raw);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Record a scout decision for a tool. Idempotent w.r.t. the slug — repeated
 * calls overwrite the prior entry (we keep one row per tool; the *history*
 * of decisions is the responsibility of the issue tracker, not this ledger).
 *
 * On every write we refresh `lastChecked`. On a `filed`/`rejected` we also
 * refresh `filedAt`. `skipped-cooldown` ONLY refreshes `lastChecked` — it's
 * a heartbeat, not a new decision.
 *
 * Throws if `decision === "filed"` and `issueNum` is not supplied.
 */
export async function recordDecision(
  slug: string,
  decision: ScoutDecision,
  reason: string,
  input: RecordDecisionInput,
): Promise<void> {
  if (!slug) throw new TypeError("recordDecision: slug required");
  if (!decision) throw new TypeError("recordDecision: decision required");
  if (typeof reason !== "string") {
    throw new TypeError("recordDecision: reason must be a string");
  }
  if (decision === "filed" && (input.issueNum == null || input.issueNum <= 0)) {
    throw new RangeError(
      `recordDecision: decision="filed" requires positive issueNum (got ${input.issueNum})`,
    );
  }

  const now = (input.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  // Load prior entry (if any) so heartbeat writes don't blow away decision history.
  const prior = await getSeen(slug);

  // Resolve effective fields for this write.
  const tool = input.tool ?? prior?.tool ?? slug;
  const category = input.category ?? prior?.category ?? "";
  const trigger: ScoutTrigger = input.trigger ?? prior?.trigger ?? "manual";

  // For skipped-cooldown writes we keep the prior decision/reason/filedAt
  // intact — they describe the *prior* terminal outcome. Only `lastChecked`
  // (and optionally `reEvalAt`) move.
  let effectiveDecision: ScoutDecision = decision;
  let effectiveReason = reason;
  let effectiveFiledAt = nowIso;
  let effectiveIssueNum: number | null = input.issueNum ?? null;
  let effectiveRubricVersion: string | null =
    input.rubricVersion ?? prior?.rubricVersion ?? null;
  let effectiveLeverageScore: number | null =
    input.leverageScore ?? prior?.leverageScore ?? null;

  if (decision === "skipped-cooldown" && prior) {
    effectiveDecision = prior.decision;
    effectiveReason = prior.reason;
    effectiveFiledAt = prior.filedAt;
    effectiveIssueNum = prior.issueNum;
    effectiveRubricVersion = prior.rubricVersion;
    effectiveLeverageScore = prior.leverageScore;
  }

  const reEvalAt =
    input.reEvalAt !== undefined ? input.reEvalAt : (prior?.reEvalAt ?? null);

  const fields: Record<string, string> = {
    tool,
    slug,
    category,
    decision: effectiveDecision,
    reason: effectiveReason,
    filedAt: effectiveFiledAt,
    issueNum: effectiveIssueNum == null ? "" : String(effectiveIssueNum),
    reEvalAt: reEvalAt == null ? "" : reEvalAt,
    trigger,
    lastChecked: nowIso,
    rubricVersion: effectiveRubricVersion ?? "",
    leverageScore:
      effectiveLeverageScore == null ? "" : String(effectiveLeverageScore),
  };

  // Flatten {field: value} to ["field", value, "field", value, ...] for hashSet.
  const flat: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    flat.push(k, v);
  }
  await setScoutToolsConsidered(slug, ...flat);
}

// ---------------------------------------------------------------------------
// Re-eval eligibility
// ---------------------------------------------------------------------------

/**
 * Returns true if the tool is eligible to be re-considered by a new scout
 * walk. Pure function over a fetched entry — the network call is the
 * caller's responsibility (see `eligibleForReEval` below for the
 * convenience wrapper).
 *
 * Eligible when ANY of:
 *  - No prior entry exists.
 *  - `reEvalAt` is set AND `now >= reEvalAt` (operator-forced re-eval).
 *  - `decision === "rejected"` AND `filedAt` is older than REJECT_COOLDOWN_DAYS.
 *  - `decision === "filed"` AND the cooldown has elapsed (caller decides
 *    whether the issue is closed/wontfix — this module doesn't read GH).
 *
 * The fourth path is the conservative one: we let the caller decide whether
 * a still-open filed issue should trigger a re-scout (usually no — refresh
 * heartbeat instead). This module returns `true` once the calendar cooldown
 * has elapsed and trusts the caller to apply the GH-state filter.
 */
export function isEligibleForReEval(
  entry: ScoutSeenEntry | null,
  now: Date = new Date(),
): boolean {
  if (!entry) return true;

  // Operator override: reEvalAt timestamp passed.
  if (entry.reEvalAt) {
    const reAt = Date.parse(entry.reEvalAt);
    if (Number.isFinite(reAt) && now.getTime() >= reAt) {
      return true;
    }
  }

  const filedAtMs = Date.parse(entry.filedAt);
  if (!Number.isFinite(filedAtMs)) {
    // Corrupt timestamp — treat as eligible so the next walk overwrites it.
    return true;
  }

  const ageDays = (now.getTime() - filedAtMs) / MS_PER_DAY;

  switch (entry.decision) {
    case "rejected":
      return ageDays >= REJECT_COOLDOWN_DAYS;
    case "filed":
      // Cooldown elapsed → caller may re-evaluate (after checking GH state).
      return ageDays >= WONTFIX_COOLDOWN_DAYS;
    case "skipped-cooldown":
      // Heartbeat-only entries shouldn't exist as the *terminal* decision,
      // but if they do (e.g. partial write), default to eligible.
      return true;
    default:
      return true;
  }
}

/**
 * Convenience wrapper: look up the slug and apply the eligibility test in
 * one call.
 */
export async function eligibleForReEval(
  slug: string,
  now: Date = new Date(),
): Promise<boolean> {
  const entry = await getSeen(slug);
  return isEligibleForReEval(entry, now);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseEntry(slug: string, raw: Record<string, string>): ScoutSeenEntry {
  const issueNumRaw = raw.issueNum ?? "";
  const issueNum = issueNumRaw === "" ? null : Number.parseInt(issueNumRaw, 10);

  const leverageScoreRaw = raw.leverageScore ?? "";
  const leverageScore =
    leverageScoreRaw === "" ? null : Number.parseFloat(leverageScoreRaw);

  const decision = (raw.decision ?? "rejected") as ScoutDecision;
  const trigger = (raw.trigger ?? "manual") as ScoutTrigger;

  return {
    tool: raw.tool ?? slug,
    slug,
    category: raw.category ?? "",
    decision,
    reason: raw.reason ?? "",
    filedAt: raw.filedAt ?? "",
    issueNum: Number.isFinite(issueNum as number) ? (issueNum as number) : null,
    reEvalAt: raw.reEvalAt === "" || raw.reEvalAt == null ? null : raw.reEvalAt,
    trigger,
    lastChecked: raw.lastChecked ?? "",
    rubricVersion:
      raw.rubricVersion === "" || raw.rubricVersion == null
        ? null
        : raw.rubricVersion,
    leverageScore: Number.isFinite(leverageScore as number)
      ? (leverageScore as number)
      : null,
  };
}
