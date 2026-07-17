/**
 * Design Concept — pure gate + identity leaf (issue #3039).
 *
 * This module is the **zero-Redis leaf** of the design-concept domain: the
 * domain value types, the artifact-identity hash, and the dispatch-gate
 * predicates. It imports ONLY the tier-classifier (`classifyChange`,
 * `permitsBreakingChange`) — both pure classification functions — and NOTHING
 * from `src/redis/`. A test of the gate logic against synthetic `DesignConcept`
 * objects therefore requires zero Redis setup.
 *
 * ## Why a separate leaf (and the #2316 caveat)
 *
 * The gate/identity logic previously lived here (#1908), was re-consolidated
 * into the single deep module `design-concept.ts` (#2316) because callers had
 * to fan their imports across THREE modules for one conceptual operation, and
 * is now re-extracted (#3039) as a single leaf that `design-concept.ts`
 * **re-exports** for back-compat. That re-export is load-bearing: it keeps the
 * caller import surface single-source (a caller can still `import { gateCheck,
 * getDesignConcept } from "./design-concept.ts"`), so this re-extraction does
 * NOT reintroduce the 3-way fan-out that motivated #2316's re-merge.
 *
 * ## Module organisation (two concern sections)
 *
 * 1. **Domain value types** — the TypeScript types that describe the artifact
 *    shape (`DesignConcept`, `DesignConceptScope`, etc.). Pure — no imports
 *    from Redis or the tier-classifier.
 *
 * 2. **Artifact identity + gate predicates** — `computeArtifactHash`
 *    (+ `canonicalJson`), `isFresh`, `gateCheck`, and
 *    `DESIGN_CONCEPT_MAX_AGE_MS`. Pure — no Redis IO. `gateCheck` imports the
 *    tier-classifier (`classifyChange`, `permitsBreakingChange`) for the
 *    breaking-impact rule.
 *
 * 3. **Green-light criterion** — `computeGreenLight`
 *    (+ `GREEN_LIGHT_WINDOW_DAYS` / `GREEN_LIGHT_REQUIRED_DAYS` /
 *    `GreenLightMetrics`). Pure — no Redis IO. Relocated here from
 *    `design-concept.ts` (issue #3414) because it satisfies this leaf's stated
 *    "zero-Redis, pure predicate" invariant; it sat in the persistence module
 *    only for historical reasons. `design-concept.ts` re-exports it so its
 *    callers keep their single-source import surface.
 *
 * Persistence (`saveDesignConcept`, `getDesignConcept`, …) lives in
 * `design-concept.ts`, which imports this leaf (a correct downward dependency:
 * persistence is the implementation, the gate is the domain rule that guards
 * it). See ADR-0008.
 */

import { createHash } from "node:crypto";

import { classifyChange } from "./tier-classifier.ts";
import { permitsBreakingChange } from "./tier-policy.ts";

// ---------------------------------------------------------------------------
// 1. Domain value types (no Redis dependency, no tier-classifier dependency)
// ---------------------------------------------------------------------------

export type DesignConceptScope = "orch" | "target";

// File-private — used only within the design-concept domain (DesignConcept,
// saveDesignConcept, hydrate). Not exported (no external consumer; knip flagged
// the prior `export` as dead surface, issue #2320).
type DesignConceptStatus = "draft" | "approved" | "stale";

// File-private — used only by `ModuleTouched` below. Not exported (no external
// consumer; knip flagged the prior `export` as dead surface, issue #2051).
type InterfaceImpact = "none" | "extend" | "breaking";

type DepthClassification = "deep" | "shallow" | "unknown";

// Exported so the persistence module (`design-concept.ts`) can type its
// `hydrate` JSON-field parses against the same shape after the #3039 gate-leaf
// extraction. These are the field element types of `DesignConcept` and have no
// consumer outside the design-concept domain.
export type ModuleTouched = {
  path: string;
  interfaceImpact: InterfaceImpact;
  depthClassification: DepthClassification;
};

export type RejectedAlternative = { alt: string; why: string };

export type QaTurn = { q: string; a: string };

export type Prototype = {
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
// 3. Gate predicates (pure — no Redis IO; imports tier-classifier)
// ---------------------------------------------------------------------------

/** 7 days, in milliseconds. */
export const DESIGN_CONCEPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum Q&A trace depth for the gate. From the ADR-0008 schema. */
const MIN_QA_TRACE_LENGTH = 6;

/** The gate-check verdict: `ok` when every ADR-0008 rule passed. */
export type GateResult = { ok: boolean; reasons: string[] };

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
): GateResult {
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
// 4. Green-light criterion (pure — no Redis IO)
// ---------------------------------------------------------------------------
//
// Relocated from `design-concept.ts` (the persistence module) into this pure
// gate leaf (issue #3414): `computeGreenLight` reads a plain snapshot list and
// returns a struct with zero Redis IO, satisfying this leaf's "zero-Redis, pure
// predicate" invariant. It previously lived in the persistence module only for
// historical reasons (extracted there from the route layer in #1875).
// `design-concept.ts` re-exports these symbols so its callers
// (`src/api/design-concepts.ts`) keep their single-source import surface.

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
