/**
 * scripts/target/target-design-concept.ts — Pure builder + serializer for the
 * **lightweight Target design-concept artifact** (issue #1056, parent epic
 * #1052 — "Selectively converge the Target SDLC with the Orchestrator's
 * build-quality machinery").
 *
 * Background: the Orchestrator captures a rich design-concept artifact via the
 * `hydra-grill` Q&A loop before any code-writing dispatch — modules-touched
 * with per-module interfaceImpact/depthClassification annotations, the full
 * Q&A trace, prototype snippets, and a draft/approved/stale gate
 * (`src/design-concept.ts`, ADR-0008). That apparatus exists to contain
 * self-modification blast radius. A Target (hydra-betting) PR structurally
 * cannot break the builder, so epic #1052 declines to mirror the heavy
 * machinery — the same "selectively converge, do not mirror the tier ladder"
 * decision that shaped `scripts/target/target-qa-verdict.ts` (#1055) and the
 * money-critical mutation gate (#1057).
 *
 * This module is the Target's *deliberately lighter* counterpart: a flat
 * 4-field record captured by the Target planner BEFORE execute, and ONLY for
 * money-critical work. The four fields are exactly the ones the issue names:
 *
 *   - `scope`              — one-line statement of what the build will change.
 *   - `modulesTouched`     — the money-critical paths the build expects to
 *                            edit (plain string paths — NO interfaceImpact /
 *                            depthClassification annotations; that depth
 *                            ordering is an Orchestrator tier-ladder concern
 *                            the Target does not have).
 *   - `invariants`         — the money-safety properties the build must
 *                            preserve (e.g. "never place a bet above the
 *                            staking cap", "settlement math stays exact").
 *   - `rejectedAlternatives` — alternatives the planner considered and why it
 *                            rejected them, so a retry does not re-litigate.
 *
 * Two organizing rules, both inherited from the keystone classifier in
 * `src/target/money-critical.ts` (`classifyTargetRisk`, #1053):
 *
 *   1. **Money-critical-only.** `shouldCaptureDesignConcept(changedPaths)`
 *      gates artifact creation on the money-critical flag. Safe-path builds
 *      (UI / docs / config — the ~90% case) skip the artifact entirely; there
 *      is no artifact to create, persist, or diff against.
 *   2. **NOT a Q&A loop, NOT a gate.** There is no draft/approved/stale
 *      lifecycle, no operator approval, no prototype branch. The artifact only
 *      ever *informs* — the Target QA Spec axis (#1055) diffs the merged change
 *      against it; it never blocks a merge by itself.
 *
 * Persistence is the playbook's job, NOT this module's. This module is pure —
 * no fs / network / Redis / spawn — so it unit-tests in milliseconds (see
 * test/target-design-concept.test.mts). `serializeDesignConcept` /
 * `parseDesignConcept` are the JSON round-trip the `hydra-target-build`
 * playbook uses to write/read the per-anchor Redis key; a retry on the same
 * anchor reads back the persisted artifact and reuses it instead of
 * rediscovering scope.
 */

import { classifyRisk } from "../../src/target/risk-critical.ts";
import {
  BETTING_RISK_SURFACE,
  BETTING_APP_SUBDIR,
} from "./betting-risk-surface.ts";

/**
 * One rejected alternative — what was considered and the one-line reason it
 * was rejected. Kept as paired free-text fields, mirroring the Orchestrator
 * artifact's `RejectedAlternative` shape so the Target QA Spec axis reads a
 * familiar structure.
 */
export interface TargetRejectedAlternative {
  /** The alternative approach that was considered. */
  alt: string;
  /** The one-line reason it was rejected. */
  why: string;
}

/**
 * The lightweight Target design-concept artifact. Four planner-supplied
 * fields plus the keystone-derived `matchedPaths` audit trail and a
 * `capturedAt` ISO timestamp so a retry can tell how stale the reuse is.
 *
 * Deliberately flat: no nested per-module annotations, no Q&A trace, no
 * prototype snippets, no lifecycle status. That is the whole point of #1056 —
 * the Target gets the minimum the Spec axis needs, not a mirror of the
 * Orchestrator's gate.
 */
export interface TargetDesignConcept {
  /** Schema discriminator — lets the playbook reject a malformed reuse. */
  readonly kind: "target-design-concept";
  /** The anchor this artifact was captured for (anchor.reference, e.g. "issue-1056"). */
  anchorRef: string;
  /** One-line statement of what the build will change. */
  scope: string;
  /**
   * The money-critical paths the build expects to touch (plain string paths).
   * NO interfaceImpact / depthClassification — that is an Orchestrator
   * tier-ladder concern the Target's two-level money-critical boolean does
   * not carry.
   */
  modulesTouched: string[];
  /** The money-safety properties the build must preserve. */
  invariants: string[];
  /** Alternatives the planner considered and rejected (so a retry doesn't re-litigate). */
  rejectedAlternatives: TargetRejectedAlternative[];
  /**
   * The subset of `modulesTouched` that `classifyTargetRisk` flagged as
   * money-critical (in input order, de-duplicated). The audit trail proving
   * the artifact was warranted; never empty for a persisted artifact.
   */
  matchedPaths: string[];
  /** ISO-8601 capture timestamp, so a retry can report how stale the reuse is. */
  capturedAt: string;
}

/** The planner-supplied fields — everything `buildDesignConcept` derives is omitted. */
export interface TargetDesignConceptInput {
  anchorRef: string;
  scope: string;
  modulesTouched: string[];
  invariants: string[];
  rejectedAlternatives: TargetRejectedAlternative[];
}

/**
 * Should the Target planner capture a design-concept artifact for this build?
 *
 * Pure delegation to `classifyTargetRisk` (the single source of truth for the
 * money-critical surface, #1053). Returns true iff ANY changed/expected path
 * touches money-critical surface — provider integrations, execution, staking,
 * or bet-math. Safe-path builds (UI / docs / config) return false and skip
 * artifact creation entirely (acceptance criterion: "safe-path anchors skip
 * artifact creation entirely").
 *
 * @param expectedPaths the money-critical paths the planner expects the build
 *   to touch (repo-relative, Target repo).
 */
export function shouldCaptureDesignConcept(expectedPaths: readonly string[]): boolean {
  return classifyRisk(expectedPaths, BETTING_RISK_SURFACE, BETTING_APP_SUBDIR)
    .riskCritical;
}

/**
 * Build a lightweight Target design-concept artifact from the planner's input.
 *
 * Derives `matchedPaths` from `modulesTouched` via `classifyTargetRisk` and
 * stamps `capturedAt`. Pure and total: never throws, never touches Redis /
 * network / fs. String inputs are trimmed; empty/whitespace-only invariant and
 * modulesTouched entries are dropped so a sloppy planner submission doesn't
 * persist noise.
 *
 * @param input the planner-supplied fields.
 * @param now injectable clock for deterministic tests (defaults to `new Date()`).
 */
export function buildDesignConcept(
  input: TargetDesignConceptInput,
  now: Date = new Date(),
): TargetDesignConcept {
  const modulesTouched = cleanStringList(input.modulesTouched);
  const invariants = cleanStringList(input.invariants);
  const rejectedAlternatives = cleanAlternatives(input.rejectedAlternatives);
  const { matchedPaths } = classifyRisk(
    modulesTouched,
    BETTING_RISK_SURFACE,
    BETTING_APP_SUBDIR,
  );

  return {
    kind: "target-design-concept",
    anchorRef: typeof input.anchorRef === "string" ? input.anchorRef.trim() : "",
    scope: typeof input.scope === "string" ? input.scope.trim() : "",
    modulesTouched,
    invariants,
    rejectedAlternatives,
    matchedPaths,
    capturedAt: now.toISOString(),
  };
}

/**
 * Serialize an artifact to the JSON string the playbook persists at the
 * per-anchor Redis key. Pure; the inverse of `parseDesignConcept`.
 */
export function serializeDesignConcept(concept: TargetDesignConcept): string {
  return JSON.stringify(concept);
}

/**
 * Parse a persisted artifact back from its JSON string, for a retry that
 * reuses it instead of rediscovering scope (acceptance criterion: "a retry on
 * the same anchor reuses the persisted artifact").
 *
 * Pure and total: returns `null` for any malformed, mistyped, or
 * wrong-discriminator input rather than throwing — a corrupt persisted value
 * must degrade to "no artifact found, recapture" (the planner re-runs
 * `buildDesignConcept`), never crash the build. Mirrors the
 * never-throw-from-verification discipline.
 *
 * @param raw the JSON string read from the per-anchor Redis key (or null/empty
 *   when no artifact was persisted — both yield `null`).
 */
export function parseDesignConcept(raw: string | null | undefined): TargetDesignConcept | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // intentional: a corrupt persisted artifact degrades to "recapture", not a crash.
    return null;
  }
  if (!isTargetDesignConcept(parsed)) return null;
  return parsed;
}

/** Structural type guard — every field present and correctly typed. */
function isTargetDesignConcept(value: unknown): value is TargetDesignConcept {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "target-design-concept" &&
    typeof v.anchorRef === "string" &&
    typeof v.scope === "string" &&
    isStringArray(v.modulesTouched) &&
    isStringArray(v.invariants) &&
    isAlternativeArray(v.rejectedAlternatives) &&
    isStringArray(v.matchedPaths) &&
    typeof v.capturedAt === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((e) => typeof e === "string");
}

function isAlternativeArray(value: unknown): value is TargetRejectedAlternative[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as Record<string, unknown>).alt === "string" &&
        typeof (e as Record<string, unknown>).why === "string",
    )
  );
}

/** Trim entries and drop empty/whitespace-only and non-string ones. */
function cleanStringList(list: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Trim both fields of each alternative; drop entries where both end up empty. */
function cleanAlternatives(
  list: readonly TargetRejectedAlternative[] | undefined,
): TargetRejectedAlternative[] {
  if (!Array.isArray(list)) return [];
  const out: TargetRejectedAlternative[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const alt = typeof entry.alt === "string" ? entry.alt.trim() : "";
    const why = typeof entry.why === "string" ? entry.why.trim() : "";
    if (alt.length === 0 && why.length === 0) continue;
    out.push({ alt, why });
  }
  return out;
}
