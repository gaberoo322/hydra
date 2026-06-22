/**
 * Design Concept — the single deep module that owns the design-concept domain
 * (closes #2316, consolidating three shallow modules into one).
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
 * (`gateCheck()` here) and by PR-time review (the future two-axis
 * `hydra-qa` rewrite — sub-issue #440). See ADR-0008.
 *
 * ## Module organisation (four concern sections)
 *
 * 1. **Domain value types** — the TypeScript types that describe the artifact
 *    shape (`DesignConcept`, `DesignConceptScope`, etc.). Pure — no imports
 *    from Redis or the tier-classifier.
 *
 * 2. **Artifact identity** — `computeArtifactHash` (+ `canonicalJson`),
 *    `designConceptHandle`, and the green-light criterion (`computeGreenLight`
 *    + `GREEN_LIGHT_WINDOW_DAYS` / `GREEN_LIGHT_REQUIRED_DAYS`). Pure — no
 *    Redis IO.
 *
 * 3. **Gate predicates** — `isFresh`, `gateCheck`, and
 *    `DESIGN_CONCEPT_MAX_AGE_MS`. Pure — no Redis IO, but imports the
 *    tier-classifier (`classifyChange`, `permitsBreakingChange`) for the
 *    breaking-impact rule.
 *
 * 4. **Persistence** — `saveDesignConcept`, `getDesignConcept`,
 *    `listDesignConcepts`, `approveDesignConcept`, `resolveDesignConceptForQa`,
 *    and `DesignConceptResolution`. Redis-backed; owns the Redis seam calls
 *    and the QA-time retrieval path.
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

import { createHash } from "node:crypto";

import { InvalidArgumentError, NotFoundError } from "./errors.ts";
import {
  getDesignConceptHash,
  listAllDesignConceptRefs,
  listRecentDesignConceptRefs,
  removeDesignConceptFromIndex,
  saveDesignConceptHash,
  setDesignConceptField,
  normalizeAnchorRef,
} from "./redis/design-concept.ts";
import {
  type DesignConceptInput as DesignConceptInputType,
} from "./schemas/design-concept.ts";
import { classifyChange } from "./tier-classifier.ts";
import { permitsBreakingChange } from "./tier-policy.ts";

// ---------------------------------------------------------------------------
// 1. Domain value types (no Redis dependency, no tier-classifier dependency)
// ---------------------------------------------------------------------------

export type DesignConceptScope = "orch" | "target";

// File-private — used only within this module (DesignConcept, saveDesignConcept,
// hydrate). Not exported (no external consumer; knip flagged the prior `export`
// as dead surface, issue #2320).
type DesignConceptStatus = "draft" | "approved" | "stale";

// File-private — used only by `ModuleTouched` below. Not exported (no external
// consumer; knip flagged the prior `export` as dead surface, issue #2051).
type InterfaceImpact = "none" | "extend" | "breaking";

type DepthClassification = "deep" | "shallow" | "unknown";

// File-private — used only within this module (the `DesignConcept` shape and
// `hydrate`). Not exported (no external consumer; knip flagged the prior
// `export` as dead surface, issue #2320).
type ModuleTouched = {
  path: string;
  interfaceImpact: InterfaceImpact;
  depthClassification: DepthClassification;
};

type RejectedAlternative = { alt: string; why: string };

type QaTurn = { q: string; a: string };

type Prototype = {
  question: string;
  branch: "logic" | "ui";
  snippet: string;
  answer: string;
  workTreePath: string;
};

export type DesignConcept = {
  anchorRef: string;
  scope: DesignConceptScope;
  createdAt: number;
  artifactHash: string;
  glossaryTerms: string[];
  glossaryGaps: string[];
  modulesTouched: ModuleTouched[];
  invariants: string[];
  rejectedAlternatives: RejectedAlternative[];
  qaTrace: QaTurn[];
  prototypes: Prototype[];
  status: DesignConceptStatus;
  approvedBy: "auto-gate" | `operator:${string}` | "";
};

// ---------------------------------------------------------------------------
// 2. Artifact identity (pure — no Redis IO)
// ---------------------------------------------------------------------------

/**
 * Canonical-JSON encode an arbitrary value: object keys are emitted in
 * sorted order, no whitespace, primitives encoded as `JSON.stringify`
 * does. Used as the input to `sha256` for `artifactHash`, so two
 * artifacts with the same body always produce the same hash.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalJson(v));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Compute the `artifactHash` for a design concept. Hashes all body fields
 * EXCLUDING `artifactHash`, `createdAt`, `status`, and `approvedBy` — so
 * approving an artifact (or persisting it at a different timestamp) does
 * not change its content identity.
 */
export function computeArtifactHash(d: Omit<DesignConcept, "artifactHash">): string {
  const body = {
    anchorRef: d.anchorRef,
    scope: d.scope,
    glossaryTerms: d.glossaryTerms,
    glossaryGaps: d.glossaryGaps,
    modulesTouched: d.modulesTouched,
    invariants: d.invariants,
    rejectedAlternatives: d.rejectedAlternatives,
    qaTrace: d.qaTrace,
    prototypes: d.prototypes,
  };
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

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
// 3. Gate predicates (pure — no Redis IO; imports tier-classifier)
// ---------------------------------------------------------------------------

/** 7 days, in milliseconds. */
export const DESIGN_CONCEPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum Q&A trace depth for the gate. From the ADR-0008 schema. */
const MIN_QA_TRACE_LENGTH = 6;

/**
 * Return true iff the artifact was created within the freshness window
 * (7 days by default). Pure function — no Redis IO.
 */
export function isFresh(
  d: DesignConcept,
  now: number,
  maxAgeMs: number = DESIGN_CONCEPT_MAX_AGE_MS,
): boolean {
  if (!d || typeof d.createdAt !== "number" || d.createdAt <= 0) return false;
  return now - d.createdAt <= maxAgeMs;
}

/**
 * Gate check — the 7 deterministic failure modes from ADR-0008 §"Gate
 * check". Returns `{ ok: true, reasons: [] }` only when EVERY rule
 * passes. Pure function — no Redis IO. The autopilot consumes this
 * verbatim in Phase B.
 *
 * For Phase A: `glossaryGaps` fails closed (any non-empty list is a
 * reject). The whitelist-via-Redis escape hatch lands later.
 *
 * For Phase A: `interfaceImpact: 'breaking'` cross-checks against the
 * existing tier classifier in `src/tier-classifier.ts` — every breaking
 * module path must classify to tier >= 2. Under the monotonic T1–T4
 * ladder (ADR-0015) a "breaking" declaration on a T1 (prompt-shaped,
 * auto-merge-trivial) path is the only gate failure here: T1 is the
 * shallowest, lowest-blast-radius tier and a breaking change there is a
 * contradiction. T2 (outcome-holdback), T3 (operator-review), and T4
 * (Verifier Core — the deepest tier, carrying the most verification) all
 * clear this check. NOTE (issue #737): under the old non-monotonic
 * numbering a breaking change on a Tier-0 path FAILED this rule
 * (0 < 2); under the monotonic ladder Verifier Core is T4 (deepest) and
 * now PASSES — this corrects a latent inversion (the deepest tier should
 * carry the most verification, not be rejected). Intended behavior delta,
 * not a regression.
 */
export function gateCheck(
  d: DesignConcept,
  now: number,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1. No glossary gaps allowed in Phase A.
  if (Array.isArray(d.glossaryGaps) && d.glossaryGaps.length > 0) {
    reasons.push(
      `glossaryGaps non-empty (${d.glossaryGaps.length}): ${d.glossaryGaps.join(", ")}`,
    );
  }

  // 2. At least one invariant.
  if (!Array.isArray(d.invariants) || d.invariants.length < 1) {
    reasons.push("invariants must list at least 1 entry");
  }

  // 3. At least one modulesTouched.
  if (!Array.isArray(d.modulesTouched) || d.modulesTouched.length < 1) {
    reasons.push("modulesTouched must list at least 1 entry");
  }

  // 4. Breaking impact → tier ≥ 2.
  const breakingPaths = (d.modulesTouched ?? [])
    .filter((m) => m && m.interfaceImpact === "breaking")
    .map((m) => m.path);
  if (breakingPaths.length > 0) {
    const cls = classifyChange(breakingPaths);
    if (!permitsBreakingChange(cls.tier)) {
      reasons.push(
        `interfaceImpact: 'breaking' on tier-${cls.tier} path(s) — breaking change must classify to tier >= 2 ` +
          `(got: ${cls.reason})`,
      );
    }
  }

  // 5. Q&A trace depth.
  if (!Array.isArray(d.qaTrace) || d.qaTrace.length < MIN_QA_TRACE_LENGTH) {
    reasons.push(
      `qaTrace must have at least ${MIN_QA_TRACE_LENGTH} turns (got ${d.qaTrace?.length ?? 0})`,
    );
  }

  // 6. Freshness.
  if (!isFresh(d, now)) {
    reasons.push("artifact is stale (older than 7 days)");
  }

  // 7. Status must be approved.
  if (d.status !== "approved") {
    reasons.push(`status must be 'approved' (got '${d.status}')`);
  }

  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// 4. Persistence (Redis-backed)
// ---------------------------------------------------------------------------

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
      await removeDesignConceptFromIndex(ref);
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
