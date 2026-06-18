/**
 * Design Concept — Redis-backed alignment artifact (Phase A of #437).
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
 * Phase A scope: persistence + HTTP surface + gate semantics only. No
 * autopilot wiring (Phase B), no CI hook (Phase C). The `dev_orch` gate
 * is NOT wired here — `src/gate.ts` and the autopilot decide.py are out
 * of scope for this sub-issue.
 *
 * Redis schema:
 *   hydra:design-concept:{anchorRef}  → Hash (full body, JSON-encoded fields)
 *   hydra:design-concept:index         → Sorted set (score = createdAt)
 *
 * TTL: 7 days from createdAt. The index is opportunistically pruned of
 * stale entries on every read.
 */

import {
  getDesignConceptHash,
  listAllDesignConceptRefs,
  listRecentDesignConceptRefs,
  removeDesignConceptFromIndex,
  saveDesignConceptHash,
  setDesignConceptField,
} from "./redis/design-concept.ts";
// `normalizeAnchorRef` is a keying concern that now lives in the persistence
// seam (ADR-0018 / issue #797). Re-exported here for back-compat — callers
// and the existing #736 test import it as `dc.normalizeAnchorRef`. The seam
// normalizes every key-shaped `anchorRef` at function entry, so the domain
// layer no longer calls it to derive Redis keys.
import { normalizeAnchorRef } from "./redis/design-concept.ts";
export { normalizeAnchorRef } from "./redis/design-concept.ts";
// Pure artifact-identity + green-light policy logic now lives in its own
// Module (issue #2033) so it is unit-testable without dragging the full
// persistence layer. This persistence Module imports the types + pure
// functions it needs and re-exports them below for back-compat — existing
// callers (`src/api/design-concepts.ts`, `src/anchor-candidates.ts`, and the
// #1875/#736 tests) keep importing them from `./design-concept.ts` unchanged.
import {
  type DesignConcept,
  type DesignConceptScope,
  type DesignConceptHandle,
  type ModuleTouched,
  type RejectedAlternative,
  type QaTurn,
  type Prototype,
  type DesignConceptStatus,
  computeArtifactHash,
  designConceptHandle,
  computeGreenLight,
  GREEN_LIGHT_WINDOW_DAYS,
  GREEN_LIGHT_REQUIRED_DAYS,
} from "./design-concept-identity.ts";
import {
  type DesignConceptInput as DesignConceptInputType,
} from "./schemas/design-concept.ts";
// The gate predicate (`gateCheck`/`isFresh`) and its freshness window were
// extracted to `src/design-concept-gate.ts` (issue #1908) — the gate is the
// only concern that coupled this persistence module to the tier-classifier
// boundary. We import the freshness constant back for internal index pruning;
// the back-compat re-export of `gateCheck`/`isFresh`/`DESIGN_CONCEPT_MAX_AGE_MS`
// was dropped (issue #1977 — no caller imports them via this module; they all
// import directly from `./design-concept-gate.ts`).
import { DESIGN_CONCEPT_MAX_AGE_MS } from "./design-concept-gate.ts";

// `DesignConceptInput` is owned by `src/schemas/design-concept.ts` per
// ADR-0011 (single source of truth: the schema is also the type). The
// re-export below keeps the historical import path working.
export type { DesignConceptInput } from "./schemas/design-concept.ts";

// Back-compat re-exports for the identity Module (issue #2033). These symbols
// were defined inline here until the pure logic moved to
// `./design-concept-identity.ts`; existing callers import them from this
// module, so re-export the locally-imported bindings (above) so no import site
// changes. Re-exporting the local bindings (rather than a second
// `export ... from`) avoids a duplicate-identifier clash with the internal-use
// imports.
export type {
  DesignConcept,
  DesignConceptScope,
};
export {
  computeArtifactHash,
  designConceptHandle,
  computeGreenLight,
  GREEN_LIGHT_WINDOW_DAYS,
  GREEN_LIGHT_REQUIRED_DAYS,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7 days, in seconds — for Redis EXPIRE. */
const DESIGN_CONCEPT_TTL_SECONDS = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/* The domain value types (`DesignConcept`, `DesignConceptScope`,
 * `ModuleTouched`, etc.) and the pure artifact-identity functions
 * (`computeArtifactHash` + its `canonicalJson` helper) now live in
 * `./design-concept-identity.ts` (issue #2033) and are imported above +
 * re-exported for back-compat. `DesignConceptInput` is owned by
 * `src/schemas/design-concept.ts` — see ADR-0011. */

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Save (or overwrite) a design concept. Computes `createdAt` and
 * `artifactHash` server-side. Index is updated in lockstep with the
 * hash key; both share the same 7-day TTL via Redis EXPIRE.
 *
 * Idempotent on `anchorRef`: a second call replaces the prior artifact.
 */
export async function saveDesignConcept(
  input: DesignConceptInputType,
  now: number = Date.now(),
): Promise<DesignConcept> {
  if (!input.anchorRef || typeof input.anchorRef !== "string") {
    throw new Error("saveDesignConcept: anchorRef is required");
  }
  if (input.scope !== "orch" && input.scope !== "target") {
    throw new Error("saveDesignConcept: scope must be 'orch' or 'target'");
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

/* The `DesignConceptHandle` type and the pure `designConceptHandle` derivation
 * moved to `./design-concept-identity.ts` (issue #2033) — imported above +
 * re-exported for back-compat. The QA-time resolver below stays here because
 * it performs Redis IO (`getDesignConcept`). */

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
 * `"operator:<name>"`. Throws on unknown anchorRef so callers can return
 * 404 rather than silently no-op.
 */
export async function approveDesignConcept(
  anchorRef: string,
  by: string,
): Promise<DesignConcept> {
  const existing = await getDesignConcept(anchorRef);
  if (!existing) {
    throw new Error(`approveDesignConcept: no artifact for anchorRef "${anchorRef}"`);
  }
  if (!by || (by !== "auto-gate" && !by.startsWith("operator:"))) {
    throw new Error(
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

/* The green-light criterion (`computeGreenLight` +
 * `GREEN_LIGHT_WINDOW_DAYS`/`GREEN_LIGHT_REQUIRED_DAYS`) moved to
 * `./design-concept-identity.ts` (issue #2033) — it is pure (no Redis IO) and
 * is imported + re-exported above for back-compat. The `GreenLightMetrics`
 * type lives at its domain home and is imported directly from there by callers
 * that need it (issue #2052 dropped the unused barrel re-export). */
