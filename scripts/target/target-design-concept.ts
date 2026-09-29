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
 * `src/target/risk-critical.ts` (`classifyRisk`, #3017) whose surface is
 * manifest-sourced (#3018):
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
 *
 * Issue #4693 (CSB #119 / PR #193 QA FAIL) added the operator-decision seam:
 * an operator decision posted as an ISSUE COMMENT overrides the issue body's
 * option list, but the capture step read the body only — so the build shipped
 * exactly the move the operator had excluded. This module gained the pure
 * halves of that fix: `selectOperatorDecision` (content-marker selection over
 * the raw REST comment array — marker, NEVER author, because every comment on
 * a Target thread shares the operator's login), an optional `operatorDecision`
 * field carrying the decision VERBATIM, and `isStaleAgainstDecision` (a retry
 * must not reuse an artifact captured before a newer decision). The I/O — the
 * `gh api …/issues/N/comments` read — lives in the playbook (Step 3.3), not
 * here.
 */

import { classifyRisk, type RiskSurface } from "../../src/target/risk-critical.ts";
import { loadRiskSurface } from "./target-risk-surface.ts";

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
 * One issue comment in the raw REST shape `gh api repos/…/issues/N/comments`
 * returns (issue #4693). The three fields the selector reads are typed loose
 * (`unknown`) so a malformed entry is SKIPPED at runtime rather than being
 * unrepresentable; extra API fields (`user`, `id`, …) are ignored, letting the
 * playbook pipe the API response straight in.
 */
export interface TargetIssueComment {
  /** Verbatim comment body. */
  body: unknown;
  /** ISO-8601 creation timestamp. */
  created_at: unknown;
  /** Comment permalink. */
  html_url: unknown;
}

/**
 * The selected binding operator decision (issue #4693): the most recent
 * comment whose body carries the "Operator decision" content marker. `body`
 * is the comment VERBATIM — the binding scope statement a build must not
 * paraphrase — and `url`/`createdAt` keep provenance for the QA Spec axis and
 * the staleness predicate.
 */
export interface OperatorDecision {
  /** Comment permalink — provenance. */
  url: string;
  /** ISO-8601 `created_at` of the decision comment. */
  createdAt: string;
  /** VERBATIM comment body — the binding scope statement, never a paraphrase. */
  body: string;
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
   * The binding operator-decision comment for this anchor (issue #4693),
   * carried VERBATIM. OPTIONAL and ABSENT when no decision comment exists —
   * deliberately absent-when-empty (never `undefined`-valued) so the
   * pre-#4693 lightweight shape is preserved and every artifact already
   * sitting in Redis under the 14-day TTL still parses.
   */
  operatorDecision?: OperatorDecision;
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
  /**
   * Optional (issue #4693): the operator decision selected at Step 3.3,
   * carried into the artifact verbatim. `null` means "no decision" (same as
   * omitting it); a mistyped value is dropped, never thrown on.
   */
  operatorDecision?: OperatorDecision | null;
}

/**
 * Should the Target planner capture a design-concept artifact for this build?
 *
 * Delegation to `classifyRisk` against the manifest-sourced risk surface (issue
 * #3018 — `surface`/`appSubdir` come from `.hydra/manifest.json` via
 * `loadRiskSurface`, no hardcoded betting const). Returns true iff ANY
 * changed/expected path touches the risk surface — provider integrations,
 * execution, staking, or bet-math. Safe-path builds (UI / docs / config) return
 * false and skip artifact creation entirely (acceptance criterion: "safe-path
 * anchors skip artifact creation entirely").
 *
 * Surface resolution: callers pass an explicit `surface`/`appSubdir` (the
 * hermetic path the tests use); when omitted, they are resolved from the target
 * manifest. Fail-closed-conservative: if the manifest cannot be resolved, the
 * risk surface is UNKNOWN, so we CAPTURE (a spurious artifact is cheaper than a
 * missed money-critical one — the design-concept artifact only ever *informs*,
 * it never blocks a merge).
 *
 * @param expectedPaths the paths the planner expects the build to touch
 *   (repo-relative, Target repo).
 * @param surface   the target risk surface (manifest `riskCritical.surface`);
 *   defaults to the manifest-sourced surface.
 * @param appSubdir the target app subdir (manifest `verify.appSubdir`);
 *   defaults to the manifest-sourced value.
 */
export function shouldCaptureDesignConcept(
  expectedPaths: readonly string[],
  surface?: RiskSurface,
  appSubdir?: string,
): boolean {
  const resolved = resolveSurface(surface, appSubdir);
  // Fail-closed-conservative: an unresolvable manifest means we cannot rule the
  // build safe, so capture rather than skip.
  if (!resolved) return true;
  return classifyRisk(expectedPaths, resolved.surface, resolved.appSubdir).riskCritical;
}

/**
 * Resolve the risk `surface`/`appSubdir` for the design-concept helpers.
 *
 * Returns the explicit values when the caller supplied them (the hermetic test
 * path). Otherwise reads them from the target manifest via `loadRiskSurface`;
 * returns `null` when the manifest cannot be resolved so the caller can apply
 * its own fail-closed policy. Never throws.
 */
function resolveSurface(
  surface: RiskSurface | undefined,
  appSubdir: string | undefined,
): { surface: RiskSurface; appSubdir: string } | null {
  if (surface !== undefined && appSubdir !== undefined) {
    return { surface, appSubdir };
  }
  const result = loadRiskSurface();
  if (!result.ok) return null;
  return { surface: result.surface, appSubdir: result.appSubdir };
}

/**
 * The content marker identifying an operator-decision comment (issue #4693):
 * the hydra-review convention `**Operator decision (YYYY-MM-DD): …**`. Matched
 * case-insensitively against the comment body. Deliberately a CONTENT marker,
 * never an author check — every comment on a Target thread (routing notes,
 * autopilot notes, QA verdicts) shares the operator's login, and the
 * `> *This was generated by AI during operator review.*` header alone also
 * appears on non-decision status reports; only this marker marks a decision.
 */
const OPERATOR_DECISION_MARKER = /^[*_\s]*operator decision\b/i;

/**
 * Does this body OPEN with the decision marker (issue #4693 QA finding)? The
 * marker must lead the comment — after any leading blank / blockquote
 * (`> ...`) lines, i.e. the AI-review header — not merely appear somewhere in
 * it. A QA verdict or agent note that QUOTES or mentions "operator decision"
 * mid-body (or quotes the decision as a `>` blockquote) must never supersede
 * the real decision.
 */
function hasLeadingDecisionMarker(body: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith(">")) continue;
    return OPERATOR_DECISION_MARKER.test(t);
  }
  return false;
}

/**
 * Select the binding operator decision from the anchor issue's comment thread
 * (issue #4693): the most recent comment, by `created_at`, whose body contains
 * the "Operator decision" content marker (case-insensitive) as the LEADING
 * text of its body (after an optional blockquote AI-review header) — a comment
 * that merely quotes or mentions the phrase does not qualify.
 *
 * Pure and total — the I/O (the `gh api …/issues/N/comments` read) is the
 * playbook's job (Step 3.3). Accepts the raw REST comment array (extra fields
 * ignored); malformed entries are skipped; empty / non-array input yields
 * `null`; never throws.
 *
 * @param comments the raw REST comment objects (any array order; the REST
 *   endpoint returns ascending, but latest-wins is computed from
 *   `created_at`, not position).
 */
export function selectOperatorDecision(
  comments: readonly TargetIssueComment[] | null | undefined,
): OperatorDecision | null {
  if (!Array.isArray(comments)) return null;
  let selected: OperatorDecision | null = null;
  for (const entry of comments) {
    const candidate = asDecisionEntry(entry);
    // Latest by created_at wins; `>=` breaks ties in array order (the REST
    // endpoint returns ascending, so the later entry is the newer one).
    if (candidate && (!selected || candidate.createdAt >= selected.createdAt)) {
      selected = candidate;
    }
  }
  return selected;
}

/** Validate one raw entry as a decision; `null` for anything malformed. */
function asDecisionEntry(entry: unknown): OperatorDecision | null {
  if (typeof entry !== "object" || entry === null) return null;
  const c = entry as Record<string, unknown>;
  if (typeof c.body !== "string") return null;
  if (!hasLeadingDecisionMarker(c.body)) return null;
  if (c.body.trim().length === 0) return null;
  if (typeof c.created_at !== "string" || c.created_at.length === 0) return null;
  if (typeof c.html_url !== "string" || c.html_url.length === 0) return null;
  return { url: c.html_url, createdAt: c.created_at, body: c.body };
}

/**
 * Retry-reuse staleness (issue #4693): a persisted artifact whose `capturedAt`
 * is EARLIER than the latest operator decision's `createdAt`, OR that
 * carries no `operatorDecision` field at all while a decision exists, must NOT
 * be reused — the operator's newer call supersedes it, so Step 4.5 discards it
 * and recaptures. A null/absent decision never makes an artifact stale, and an
 * unparseable timestamp fails SAFE to stale (recapture is the cheap direction;
 * reuse is what reproduced the CSB #119 QA FAIL).
 */
export function isStaleAgainstDecision(
  concept: TargetDesignConcept,
  decision: OperatorDecision | null | undefined,
): boolean {
  if (!decision) return false;
  // A decision exists but the artifact carries none (captured before the
  // decision, or pre-#4693): it cannot be proven to reflect the operator's
  // call, so it is stale regardless of timestamps (QA finding, #4693).
  if (!concept.operatorDecision) return true;
  const decisionAt = Date.parse(decision.createdAt);
  const capturedAt = Date.parse(concept.capturedAt);
  if (Number.isNaN(decisionAt) || Number.isNaN(capturedAt)) return true;
  return decisionAt > capturedAt;
}

/**
 * Build a lightweight Target design-concept artifact from the planner's input.
 *
 * Derives `matchedPaths` from `modulesTouched` via `classifyRisk` against the
 * manifest-sourced risk surface (issue #3018) and stamps `capturedAt`. Never
 * throws; never touches Redis / network. String inputs are trimmed;
 * empty/whitespace-only invariant and modulesTouched entries are dropped so a
 * sloppy planner submission doesn't persist noise.
 *
 * Surface resolution mirrors `shouldCaptureDesignConcept`: an explicit
 * `surface`/`appSubdir` is the hermetic test path; when omitted they are read
 * from the target manifest. An unresolvable manifest yields an empty
 * `matchedPaths` (the caller already gated on `shouldCaptureDesignConcept`, so a
 * built artifact means the surface was resolvable in practice).
 *
 * @param input the planner-supplied fields.
 * @param now injectable clock for deterministic tests (defaults to `new Date()`).
 * @param surface   the target risk surface; defaults to the manifest-sourced value.
 * @param appSubdir the target app subdir; defaults to the manifest-sourced value.
 */
export function buildDesignConcept(
  input: TargetDesignConceptInput,
  now: Date = new Date(),
  surface?: RiskSurface,
  appSubdir?: string,
): TargetDesignConcept {
  const modulesTouched = cleanStringList(input.modulesTouched);
  const invariants = cleanStringList(input.invariants);
  const rejectedAlternatives = cleanAlternatives(input.rejectedAlternatives);
  // Issue #4693: carried VERBATIM (no trim — a paraphrase is exactly the
  // failure this field exists to prevent) but only when well-formed; absent
  // from the object entirely otherwise, preserving the pre-#4693 shape.
  const operatorDecision = isOperatorDecision(input.operatorDecision)
    ? input.operatorDecision
    : undefined;
  const resolved = resolveSurface(surface, appSubdir);
  const { matchedPaths } = resolved
    ? classifyRisk(modulesTouched, resolved.surface, resolved.appSubdir)
    : { matchedPaths: [] as string[] };

  return {
    kind: "target-design-concept",
    anchorRef: typeof input.anchorRef === "string" ? input.anchorRef.trim() : "",
    scope: typeof input.scope === "string" ? input.scope.trim() : "",
    modulesTouched,
    invariants,
    rejectedAlternatives,
    ...(operatorDecision ? { operatorDecision } : {}),
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
    // Issue #4693 backward compatibility: ABSENT is fine (every pre-#4693
    // artifact in Redis), PRESENT-but-mistyped rejects — the whole artifact
    // degrades to "recapture" (parseDesignConcept → null), never a crash.
    (v.operatorDecision === undefined || isOperatorDecision(v.operatorDecision)) &&
    isStringArray(v.matchedPaths) &&
    typeof v.capturedAt === "string"
  );
}

/**
 * Structural guard for the optional `operatorDecision` field (issue #4693) —
 * three non-empty strings. Shared by the parse guard above and by
 * `buildDesignConcept` (which drops a mistyped input value instead of
 * persisting junk).
 */
function isOperatorDecision(value: unknown): value is OperatorDecision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.url === "string" &&
    v.url.length > 0 &&
    typeof v.createdAt === "string" &&
    v.createdAt.length > 0 &&
    typeof v.body === "string" &&
    v.body.trim().length > 0
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
