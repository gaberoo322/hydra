/**
 * Design Concept — artifact-identity & production-metric logic (issue #2033).
 *
 * Extracted from `src/design-concept.ts` (the persistence Module) so the pure
 * identity logic lives apart from the Redis-backed, side-effectful persistence
 * operations. The two concerns have different rates of change and different
 * test surfaces:
 *
 *   - **Artifact identity** — `computeArtifactHash` (+ its `canonicalJson`
 *     helper) derive a stable SHA-256 content hash so two artifacts with the
 *     same body always produce the same hash. `designConceptHandle` derives the
 *     canonical Redis key + HTTP route a producer persists under and a consumer
 *     reads from.
 *   - **Green-light policy** — `computeGreenLight` is the pure "N of last M
 *     days" promotion-clock criterion (issue #736), with its threshold/window
 *     constants.
 *
 * Everything here is pure (no Redis IO) and therefore unit-testable without
 * async setup. `src/design-concept.ts` keeps the persistence operations,
 * imports the types it needs from here, and re-exports these symbols for
 * back-compat so existing callers (`src/api/design-concepts.ts`,
 * `src/anchor-candidates.ts`, the #1875/#736 tests) are unchanged.
 *
 * `normalizeAnchorRef` (the keying concern) stays in the persistence seam
 * (`src/redis/design-concept.ts`, ADR-0018 / issue #797) — it is the single
 * source of canonical key derivation. We import it here for
 * `designConceptHandle` rather than re-homing it (the seam owns keying; this
 * Module is a consumer). The seam's Redis connection is lazy-initialized, so
 * importing the function does NOT open a Redis connection at module load.
 *
 * See ADR-0008 (design-concept artifact) and ADR-0011 (schema is the type).
 */

import { createHash } from "node:crypto";

import { normalizeAnchorRef } from "./redis/design-concept.ts";

// ---------------------------------------------------------------------------
// Domain value types (no Redis dependency)
// ---------------------------------------------------------------------------

export type DesignConceptScope = "orch" | "target";

export type DesignConceptStatus = "draft" | "approved" | "stale";

export type InterfaceImpact = "none" | "extend" | "breaking";

export type DepthClassification = "deep" | "shallow" | "unknown";

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
// Canonical JSON + artifact hash
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
 * Pure — used both by the resolver in the persistence Module and exposed so
 * callers can render the handle in logs/comments even before (or after) the
 * artifact exists.
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
