/**
 * Design Concept — the persistence + HTTP-surface module for the
 * design-concept domain.
 *
 * A design-concept artifact is a structured record produced by the (future)
 * `hydra-grill` skill before any code-writing dispatch (`dev_orch` /
 * `dev_target`). It captures:
 *
 *   - Which `CONTEXT.md` glossary terms the agent grounded in, and which
 *     gaps remain.
 *   - Which modules the agent intends to touch, with `interfaceImpact` and
 *     `depthClassification` annotations.
 *   - The invariants the agent intends to preserve.
 *   - The rejected alternatives, the Q&A trace that produced the design,
 *     and any prototype snippets that resolved hard logic/state questions.
 *
 * The artifact is the single source of truth consumed both by the gate
 * (`gateCheck()`, which lives in the pure `design-concept-gate.ts` leaf and is
 * re-exported here) and by PR-time review (the future two-axis `hydra-qa`
 * rewrite — sub-issue #440). See ADR-0008.
 *
 * ## Module organisation (after the #3039 gate-leaf extraction)
 *
 * The pure, zero-Redis half of the domain — the domain value types
 * (`DesignConcept`, `DesignConceptScope`), the artifact-identity hash
 * (`computeArtifactHash`), and the gate predicates (`isFresh`, `gateCheck`,
 * `DESIGN_CONCEPT_MAX_AGE_MS`) — was extracted to `src/design-concept-gate.ts`
 * (issue #3039). That leaf imports only the tier-classifier, so gate/identity
 * tests need zero Redis setup. This module imports the leaf and **re-exports**
 * its public symbols, so a caller can still `import { gateCheck,
 * getDesignConcept } from "./design-concept.ts"` on one line — preserving the
 * single-source import surface that motivated the #2316 consolidation.
 *
 * This module retains:
 *
 * 1. **Artifact identity (Redis-adjacent)** — `designConceptHandle` and the
 *    green-light criterion (`computeGreenLight` + `GREEN_LIGHT_WINDOW_DAYS` /
 *    `GREEN_LIGHT_REQUIRED_DAYS`). Pure — no Redis IO, but domain-local to
 *    persistence.
 *
 * 2. **Persistence** — `saveDesignConcept`, `getDesignConcept`,
 *    `listDesignConcepts`, `approveDesignConcept`, `resolveDesignConceptForQa`,
 *    and `DesignConceptResolution`. Redis-backed; owns the Redis seam calls
 *    and the QA-time retrieval path. Uses the gate leaf's
 *    `DESIGN_CONCEPT_MAX_AGE_MS` for index pruning and `computeArtifactHash`
 *    for the save path.
 *
 * Redis schema:
 *   hydra:design-concept:{anchorRef}  → Hash (full body, JSON-encoded fields)
 *   hydra:design-concept:index         → Sorted set (score = createdAt)
 *
 * TTL: 7 days from createdAt. The index is opportunistically pruned of
 * stale entries on every read.
 *
 * Phase A scope: persistence + HTTP surface + gate semantics only. No
 * autopilot wiring (Phase B), no CI hook (Phase C). The `dev_orch` gate
 * is NOT wired here — `src/gate.ts` and the autopilot decide.py are out
 * of scope for this sub-issue.
 */

import { InvalidArgumentError, NotFoundError } from "./errors.ts";
import {
  DESIGN_CONCEPT_MAX_AGE_MS,
  computeArtifactHash,
  type DesignConcept,
  type DesignConceptScope,
  type ModuleTouched,
  type Prototype,
  type QaTurn,
  type RejectedAlternative,
} from "./design-concept-gate.ts";
import {
  getDesignConceptHash,
  listAllDesignConceptRefs,
  listRecentDesignConceptRefs,
  removeExactDesignConceptFromIndex,
  saveDesignConceptHash,
  setDesignConceptField,
  normalizeAnchorRef,
  appendExemptLogEntry,
  readRecentExemptLogEntries,
  readDailySnapshots,
  getDesignConceptIndexSize,
} from "./redis/design-concept.ts";
import {
  type DesignConceptInput as DesignConceptInputType,
} from "./schemas/design-concept.ts";

// ---------------------------------------------------------------------------
// Design-concept gate + identity leaf re-export (issue #3039)
// ---------------------------------------------------------------------------
//
// The pure gate/identity leaf lives in `design-concept-gate.ts`. Re-export its
// public surface here so existing callers keep their single-source import
// (`import { gateCheck, getDesignConcept } from "./design-concept.ts"`) — this
// is the back-compat relay that keeps the #3039 re-extraction from
// reintroducing the 3-way import fan-out that motivated the #2316 re-merge.
export {
  computeArtifactHash,
  isFresh,
  gateCheck,
  type DesignConcept,
} from "./design-concept-gate.ts";

// File-private status alias — used by `saveDesignConcept` / `hydrate`. Kept
// local to the persistence module because it is only meaningful when a record
// is written or hydrated (the gate leaf treats status as a plain field value).
type DesignConceptStatus = "draft" | "approved" | "stale";

// ---------------------------------------------------------------------------
// QA-time retrievability handle (issue #1450)
// ---------------------------------------------------------------------------

/**
 * The stable retrieval handle for a design-concept artifact.
 *
 * `redisKey` is the canonical Redis hash key the artifact lives under for the
 * lifetime of the anchor (7-day TTL); `apiPath` is the HTTP route QA fetches
 * it through. Both are derived from the SAME canonical `anchorRef`
 * (`normalizeAnchorRef`), so the handle a producer (grill) persists under and
 * the handle a consumer (QA) reads from can never disagree — the wedge that
 * orphaned artifacts in #736.
 *
 * The handle is meaningful even when the artifact is absent: it tells QA
 * (and the operator) EXACTLY where the artifact was looked for, so a miss is
 * loud and diagnosable rather than a silent "not reachable".
 */
export type DesignConceptHandle = {
  /** The canonical anchorRef the handle resolves to (e.g. `issue-1450`). */
  anchorRef: string;
  /** Canonical Redis hash key — `hydra:design-concept:<canonical-anchorRef>`. */
  redisKey: string;
  /** HTTP route QA reads the artifact through. */
  apiPath: string;
};

/**
 * Compute the stable retrieval handle for `anchorRef` without touching Redis.
 * Pure — used both by the resolver in the persistence section below and
 * exposed so callers can render the handle in logs/comments even before (or
 * after) the artifact exists.
 */
export function designConceptHandle(anchorRef: string): DesignConceptHandle {
  const canonical = normalizeAnchorRef(anchorRef);
  return {
    anchorRef: canonical,
    redisKey: `hydra:design-concept:${canonical}`,
    apiPath: `/api/design-concepts/${canonical}`,
  };
}

// ---------------------------------------------------------------------------
// Green-light criterion (issue #736)
// ---------------------------------------------------------------------------

/**
 * The promotion clock is idle-tolerant (issue #736): Phase C of #437 may
 * flip when at least `GREEN_LIGHT_REQUIRED_DAYS` of the most-recent
 * `GREEN_LIGHT_WINDOW_DAYS` snapshot days produced ≥1 design concept.
 *
 * Chosen form: "N of last M days" rather than a pure consecutive run.
 * Rationale (the open design choice the design-concept artifact deferred
 * to implementation): a strict `consecutiveGreenDays >= 7` punishes
 * legitimately-quiet orch days (no `ready-for-agent` issue lacking a fresh
 * artifact ⇒ nothing to grill), which is exactly the failure the issue
 * reports. "7 of last 10" tolerates up to 3 quiet days inside the window
 * while still demanding sustained production. Both the threshold and the
 * window stay well inside MAX_SNAPSHOT_DAYS (14) so the HASH always holds
 * enough history to evaluate.
 *
 * (Extracted from `src/api/design-concepts.ts` to its domain home so the
 * pure function is directly unit-testable and the policy constants are
 * importable without HTTP overhead — issue #1875.)
 */
export const GREEN_LIGHT_WINDOW_DAYS = 10;
export const GREEN_LIGHT_REQUIRED_DAYS = 7;

export type GreenLightMetrics = {
  /** Legacy field: green days counted consecutively from the newest. */
  consecutiveGreenDays: number;
  /** Green (production > 0) days within the trailing window. */
  greenDaysInWindow: number;
  windowDays: number;
  requiredGreenDays: number;
  greenLightReady: boolean;
};

/**
 * Compute the green-light metrics from a newest-first snapshot list. Pure
 * — no Redis IO — so it is unit-testable. A "green" day is one whose
 * production count is > 0.
 */
export function computeGreenLight(
  snapshots: Array<{ date: string; count: number }>,
  windowDays: number = GREEN_LIGHT_WINDOW_DAYS,
  requiredGreenDays: number = GREEN_LIGHT_REQUIRED_DAYS,
): GreenLightMetrics {
  // `consecutiveGreenDays`: walk from newest until the first zero day.
  let consecutiveGreenDays = 0;
  for (const s of snapshots) {
    if (s.count > 0) consecutiveGreenDays += 1;
    else break;
  }
  // `greenDaysInWindow`: count green days among the newest `windowDays`.
  const window = snapshots.slice(0, windowDays);
  const greenDaysInWindow = window.reduce(
    (n, s) => (s.count > 0 ? n + 1 : n),
    0,
  );
  return {
    consecutiveGreenDays,
    greenDaysInWindow,
    windowDays,
    requiredGreenDays,
    greenLightReady: greenDaysInWindow >= requiredGreenDays,
  };
}

// ---------------------------------------------------------------------------
// Exempt-log audit record (issue #464)
// ---------------------------------------------------------------------------
//
// The Redis-stored wire shape for the design-concept exemption-log audit
// record. `appendExemptLogEntry` persists this shape (JSON-encoded) and
// `readRecentExemptLogEntries` retrieves it; the `GET/POST
// /api/design-concepts/exempt-log` handlers in `src/api/design-concepts.ts`
// are the HTTP surface. The type + its parse guard live here — in the
// persistence domain — rather than inline in the route layer, so a reader can
// understand the audit-log wire format from the domain module without opening
// an Express route file (issue #3226).

/**
 * One design-concept gate-exemption audit entry, as stored in Redis by
 * `appendExemptLogEntry`. `gate_fail_reasons` is the (truncated) list of gate
 * verdict reasons that were exempted for the PR.
 */
export type ExemptLogEntry = {
  pr: number;
  applier: string;
  ts: number;
  anchorRef: string;
  gate_fail_reasons: string[];
};

/**
 * Runtime type guard for `ExemptLogEntry` — the parse predicate for a JSON
 * blob read back out of Redis. Used by the exempt-log read handler to reject
 * schema-drifted entries without dropping the rest of the log.
 */
export function isExemptLogEntry(value: unknown): value is ExemptLogEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pr === "number" &&
    typeof v.applier === "string" &&
    typeof v.ts === "number" &&
    typeof v.anchorRef === "string" &&
    Array.isArray(v.gate_fail_reasons) &&
    (v.gate_fail_reasons as unknown[]).every((r) => typeof r === "string")
  );
}

// ---------------------------------------------------------------------------
// Adapter re-exports — exempt-log + daily-snapshot + index-size (issue #3280)
// ---------------------------------------------------------------------------
//
// These four operations own no policy of their own — they are already fully-
// formed domain persistence operations that happened to live one layer too low,
// directly in the `redis/design-concept.ts` adapter. Re-exporting them here
// makes THIS module the single import surface for the ENTIRE design-concept
// domain, so a caller (the `src/api/design-concepts.ts` sub-router) no longer
// has to import from BOTH `design-concept.ts` and `redis/design-concept.ts` to
// get the full domain surface — the split the module header claimed did not
// exist. `redis/design-concept.ts` remains the sole backing adapter (it still
// owns the `getRedisConnection()` boundary, key shapes, and TTLs); these are
// thin pass-throughs, NOT wrappers with added behavior — signatures and runtime
// semantics are unchanged (LPUSH newest-first exempt log, ZCARD index size,
// HASH read newest-first snapshots). Out of scope for #3280: the two other
// direct adapter importers (`src/aggregators/builder-health.ts`,
// `src/scheduler/chores/design-concept-snapshot.ts`), which use DI / dynamic-
// import seams and are a distinct consolidation.
export {
  appendExemptLogEntry,
  readRecentExemptLogEntries,
  readDailySnapshots,
  getDesignConceptIndexSize,
};

// ---------------------------------------------------------------------------
// Persistence (Redis-backed)
// ---------------------------------------------------------------------------
//
// The pure gate predicates (`isFresh`, `gateCheck`, `DESIGN_CONCEPT_MAX_AGE_MS`)
// now live in `design-concept-gate.ts` and are re-exported at the top of this
// module. The persistence path below consumes `DESIGN_CONCEPT_MAX_AGE_MS` (for
// index pruning) and `computeArtifactHash` (for the save path) as imported
// values from the leaf.

/** 7 days, in seconds — for Redis EXPIRE. */
const DESIGN_CONCEPT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Save (or overwrite) a design concept. Computes `createdAt` and
 * `artifactHash` server-side. Index is updated in lockstep with the
 * hash key; both share the same 7-day TTL via Redis EXPIRE.
 *
 * Idempotent on `anchorRef`: a second call replaces the prior artifact.
 *
 * Throws `InvalidArgumentError` (`code: "invalid-argument"`, from
 * `src/errors.ts`) when `anchorRef` is missing/non-string or `scope` is
 * neither `"orch"` nor `"target"`, so callers discriminate on `err.code`
 * rather than `err.message` (CLAUDE.md typed-error convention, #756).
 */
export async function saveDesignConcept(
  input: DesignConceptInputType,
  now: number = Date.now(),
): Promise<DesignConcept> {
  if (!input.anchorRef || typeof input.anchorRef !== "string") {
    throw new InvalidArgumentError("saveDesignConcept: anchorRef is required");
  }
  if (input.scope !== "orch" && input.scope !== "target") {
    throw new InvalidArgumentError(
      "saveDesignConcept: scope must be 'orch' or 'target'",
    );
  }

  const status: DesignConceptStatus = input.status ?? "draft";
  const approvedBy: DesignConcept["approvedBy"] = input.approvedBy ?? "";

  // The persistence seam keys every artifact canonically at write time
  // (ADR-0018 / issue #736), so the Redis key is correct regardless of which
  // form the caller supplied. We canonicalize the *artifact identity* here
  // too so the stored body field and the returned object match the key — this
  // is not a keying call (the seam owns keying), it just keeps the record's
  // own `anchorRef` consistent with where it lives.
  const anchorRef = normalizeAnchorRef(input.anchorRef);

  const draft: Omit<DesignConcept, "artifactHash"> = {
    anchorRef,
    scope: input.scope,
    createdAt: now,
    glossaryTerms: input.glossaryTerms ?? [],
    glossaryGaps: input.glossaryGaps ?? [],
    modulesTouched: input.modulesTouched ?? [],
    invariants: input.invariants ?? [],
    rejectedAlternatives: input.rejectedAlternatives ?? [],
    qaTrace: input.qaTrace ?? [],
    prototypes: input.prototypes ?? [],
    status,
    approvedBy,
  };

  const artifactHash = computeArtifactHash(draft);
  const concept: DesignConcept = { ...draft, artifactHash };

  await saveDesignConceptHash(
    concept.anchorRef,
    concept.createdAt,
    [
      "anchorRef", concept.anchorRef,
      "scope", concept.scope,
      "createdAt", String(concept.createdAt),
      "artifactHash", concept.artifactHash,
      "glossaryTerms", JSON.stringify(concept.glossaryTerms),
      "glossaryGaps", JSON.stringify(concept.glossaryGaps),
      "modulesTouched", JSON.stringify(concept.modulesTouched),
      "invariants", JSON.stringify(concept.invariants),
      "rejectedAlternatives", JSON.stringify(concept.rejectedAlternatives),
      "qaTrace", JSON.stringify(concept.qaTrace),
      "prototypes", JSON.stringify(concept.prototypes),
      "status", concept.status,
      "approvedBy", concept.approvedBy,
    ],
    DESIGN_CONCEPT_TTL_SECONDS,
  );

  return concept;
}

function parseJsonField<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error("[DesignConcept] Failed to parse JSON field", { raw, err });
    return fallback;
  }
}

function hydrate(raw: Record<string, string>): DesignConcept | null {
  if (!raw || !raw.anchorRef) return null;
  const status = (raw.status || "draft") as DesignConceptStatus;
  const approvedBy = (raw.approvedBy || "") as DesignConcept["approvedBy"];
  return {
    anchorRef: raw.anchorRef,
    scope: (raw.scope === "target" ? "target" : "orch") as DesignConceptScope,
    createdAt: Number(raw.createdAt) || 0,
    artifactHash: raw.artifactHash || "",
    glossaryTerms: parseJsonField<string[]>(raw.glossaryTerms, []),
    glossaryGaps: parseJsonField<string[]>(raw.glossaryGaps, []),
    modulesTouched: parseJsonField<ModuleTouched[]>(raw.modulesTouched, []),
    invariants: parseJsonField<string[]>(raw.invariants, []),
    rejectedAlternatives: parseJsonField<RejectedAlternative[]>(
      raw.rejectedAlternatives,
      [],
    ),
    qaTrace: parseJsonField<QaTurn[]>(raw.qaTrace, []),
    prototypes: parseJsonField<Prototype[]>(raw.prototypes, []),
    status,
    approvedBy,
  };
}

/** Fetch one design concept by `anchorRef`. Returns null if missing. */
export async function getDesignConcept(
  anchorRef: string,
): Promise<DesignConcept | null> {
  if (!anchorRef) return null;
  // The seam canonicalizes the lookup key, so either form (`"736"` or
  // `"issue-736"`) resolves to the same persisted artifact (ADR-0018 / #736).
  const raw = await getDesignConceptHash(anchorRef);
  return hydrate(raw);
}

// ---------------------------------------------------------------------------
// QA-time retrievability (issue #1450)
// ---------------------------------------------------------------------------

/**
 * Result of resolving an artifact at QA time.
 *
 * `found` is the explicit signal: `true` carries the hydrated `concept`;
 * `false` carries a loud, structured `reason` string. `handle` is ALWAYS
 * present (even on a miss it names exactly where the artifact was probed). The
 * resolver NEVER returns a bare null, so a missing artifact can be logged loud
 * (the #1450 acceptance criterion) instead of silently worked around via
 * `recordAnchorReflection` side-effects.
 *
 * Modelled as a single shape with optional `concept`/`reason` rather than a
 * discriminated union on purpose: the repo type-checks with `strict:false`
 * (so `strictNullChecks` is off), under which a `boolean`-discriminant union
 * does NOT narrow on `if (r.found)`. A flat shape with `found` + optionals is
 * the contract that stays sound for every caller regardless of strictness.
 */
export type DesignConceptResolution = {
  /** True iff a persisted artifact was retrieved. */
  found: boolean;
  /** Stable handle the artifact lives under — present on hit AND miss. */
  handle: DesignConceptHandle;
  /** The hydrated artifact — present iff `found`. */
  concept?: DesignConcept;
  /** Loud, structured miss reason — present iff NOT `found`. */
  reason?: string;
};

/**
 * Resolve the design-concept artifact a QA verdict must be checked against
 * (issue #1450).
 *
 * This is the single retrieval path QA's verdict flow consumes: it reads the
 * PERSISTED artifact via the canonical handle (the durable Redis hash, NOT an
 * ephemeral in-memory grill artifact), and on a miss returns a structured,
 * loud reason naming the exact handle that was probed. The premise of the
 * design-concept gate (ADR-0008) is that the artifact is the durable spec a PR
 * is QA'd against; this resolver makes "durable + retrievable at QA time"
 * mechanically checkable.
 *
 * Contract:
 *   - blank `anchorRef`            → found:false, reason names the bad input.
 *   - hash present + hydrates      → found:true, concept + handle.
 *   - hash absent / TTL'd / unhydratable → found:false, reason names the
 *     canonical handle so the caller logs WHERE it looked, not just THAT it
 *     missed.
 */
export async function resolveDesignConceptForQa(
  anchorRef: string,
): Promise<DesignConceptResolution> {
  const handle = designConceptHandle(anchorRef ?? "");
  if (!anchorRef || typeof anchorRef !== "string" || anchorRef.trim() === "") {
    return {
      found: false,
      handle,
      reason:
        "design-concept artifact unreachable: blank/invalid anchorRef supplied to QA resolver",
    };
  }
  const concept = await getDesignConcept(anchorRef);
  if (!concept) {
    return {
      found: false,
      handle,
      reason:
        `design-concept artifact NOT persisted/retrievable at handle ${handle.redisKey} ` +
        `(GET ${handle.apiPath}) — produce it with hydra-grill or apply 'design-concept-exempt'; ` +
        "do NOT silently fall back to recordAnchorReflection (issue #1450)",
    };
  }
  return { found: true, handle, concept };
}

/**
 * Opportunistic prune of stale (>7d) entries from the index. Reads the
 * whole index, drops members whose score is older than `cutoff`. Cheap
 * for the expected index size (≤ a few hundred entries; 7-day TTL caps
 * growth). Returns the number of entries pruned.
 *
 * The hash keys themselves are reaped by Redis via EXPIRE, so this only
 * keeps the index consistent.
 */
async function pruneStaleIndex(now: number): Promise<number> {
  const cutoff = now - DESIGN_CONCEPT_MAX_AGE_MS;
  const allRefs = await listAllDesignConceptRefs();
  let pruned = 0;
  for (const ref of allRefs) {
    const raw = await getDesignConceptHash(ref);
    const createdAt = Number(raw?.createdAt) || 0;
    // Either the hash is gone (TTL'd out) or it's older than the cutoff.
    if (!raw?.anchorRef || createdAt < cutoff) {
      // Remove the member VERBATIM (issue #3236). `ref` came straight out of
      // the ZSET via `listAllDesignConceptRefs`, so a legacy non-canonical
      // member (bare `"705"` from before the #736 normalization) must be
      // evicted by its stored string — the canonicalizing
      // `removeDesignConceptFromIndex` would normalize `705`→`issue-705`,
      // `zrem` a member that isn't there, and leave the orphan un-prunable
      // (the index bloated to 168 members against 86 live hashes).
      await removeExactDesignConceptFromIndex(ref);
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * List design concepts in reverse-chronological order. The index is
 * pruned of stale entries on every call (see `pruneStaleIndex`).
 *
 * Filters:
 *   - `scope`: only return artifacts for this scope.
 *   - `limit`: cap the returned count (default 50; max 200).
 */
export async function listDesignConcepts(opts: {
  scope?: DesignConceptScope;
  limit?: number;
  now?: number;
} = {}): Promise<DesignConcept[]> {
  const now = opts.now ?? Date.now();
  await pruneStaleIndex(now);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const refs = await listRecentDesignConceptRefs(limit);
  const out: DesignConcept[] = [];
  for (const ref of refs) {
    const dc = await getDesignConcept(ref);
    if (!dc) continue;
    if (opts.scope && dc.scope !== opts.scope) continue;
    out.push(dc);
  }
  return out;
}

/**
 * Mark a design concept as `approved` and record the approver. The
 * approver must be either the literal string `"auto-gate"` or
 * `"operator:<name>"`.
 *
 * Throws typed errors from `src/errors.ts` so callers discriminate on
 * `err.code`, not `err.message` (CLAUDE.md typed-error convention, #756):
 *   - `NotFoundError` (`code: "not-found"`) — no artifact for `anchorRef`,
 *     so the API caller can return 404 rather than silently no-op.
 *   - `InvalidArgumentError` (`code: "invalid-argument"`) — malformed `by`.
 */
export async function approveDesignConcept(
  anchorRef: string,
  by: string,
): Promise<DesignConcept> {
  const existing = await getDesignConcept(anchorRef);
  if (!existing) {
    throw new NotFoundError(
      `approveDesignConcept: no artifact for anchorRef "${anchorRef}"`,
    );
  }
  if (!by || (by !== "auto-gate" && !by.startsWith("operator:"))) {
    throw new InvalidArgumentError(
      `approveDesignConcept: 'by' must be "auto-gate" or "operator:<name>", got "${by}"`,
    );
  }
  const approvedBy = by as DesignConcept["approvedBy"];
  // Field updates target `existing.anchorRef` — already canonical (the body
  // field is canonicalized at save). The seam re-normalizes idempotently, so
  // this hits the same key the artifact was persisted under without the old
  // double-normalize (ADR-0018 / issue #736).
  await setDesignConceptField(existing.anchorRef, "status", "approved");
  await setDesignConceptField(existing.anchorRef, "approvedBy", approvedBy);
  return { ...existing, status: "approved", approvedBy };
}
