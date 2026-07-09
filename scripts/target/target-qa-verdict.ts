/**
 * scripts/target/target-qa-verdict.ts — Pure verdict logic for the
 * independent Target QA reviewer (issue #1055, parent epic #1052 —
 * "Selectively converge the Target SDLC with the Orchestrator's
 * build-quality machinery").
 *
 * Background: today the Target (hydra-betting) executor grades its own work —
 * there is no independent reviewer. This module is the pure decision core for
 * the Target's first independent QA pass, dispatched by the
 * `hydra-target-qa` playbook. It deliberately mirrors the *shape* of the
 * Orchestrator's `scripts/ci/qa-verdict.ts` (one-pass classification, an
 * adversarial 2-reviewer fold) WITHOUT mirroring the Modification Tier ladder,
 * Verifier Core, deep-QA remediation loop, or operator-escalation machinery —
 * a Target PR structurally cannot break the builder, so the heavy
 * self-modification-containment apparatus does not apply (epic #1052
 * rationale).
 *
 * Depth is routed on the **risk-critical flag** from
 * `src/target/risk-critical.ts` (`classifyRisk`, #3017) whose surface is
 * sourced from `.hydra/manifest.json` (#3018) — the single organizing
 * primitive shared by every Target gate:
 *
 *   - **safe path** (the ~90% of Target changes — UI / docs / config) — a
 *     SINGLE independent Standards pass (conventions, tests-present, no silent
 *     catch, doesn't touch money-critical paths). One reviewer verdict.
 *   - **money-critical path** (providers / execution / staking / bet-math) —
 *     Standards PLUS a Spec pass (diff vs. the design-concept artifact) PLUS an
 *     adversarial 2-reviewer fold. ALL of Standards, Spec, and BOTH adversarial
 *     reviewers must pass; a single hard finding from any of them is a FAIL.
 *
 * A hard finding bounces the item to the existing **reframe queue**
 * (`hydra:anchors:reframe-queue`, surfaced by `hydra-target-review`). There is
 * NO deep-QA remediation loop and NO operator-escalation path — those are the
 * Verifier-Core teeth the epic explicitly declines to mirror for the Target.
 *
 * This module is pure — no fs / network / Redis / spawn — so it is unit-tested
 * directly (see test/target-qa-verdict.test.mts). The playbook is responsible
 * for collecting the reviewer verdicts (running the actual review sub-agents)
 * and for executing the routing this module decides.
 */

import { classifyRisk, type RiskSurface } from "../../src/target/risk-critical.ts";
import { loadRiskSurface } from "./target-risk-surface.ts";

/** A single reviewer's verdict — PASS unless it surfaced a real hard finding. */
export type ReviewVerdict = "PASS" | "FAIL";

/**
 * Which QA path a Target PR takes, derived from the money-critical flag.
 *
 * - `safe` — Standards-only single pass.
 * - `money-critical` — Standards + Spec + adversarial 2-reviewer fold.
 */
export type TargetQaPath = "safe" | "money-critical";

/**
 * The reviewer verdicts the playbook collected for a Target PR. The shape the
 * playbook must populate depends on the path (see `classifyTargetQaPath`):
 *
 * - **safe path** — only `standards` is consulted; the money-critical-only
 *   fields are ignored if present.
 * - **money-critical path** — `standards`, `spec`, `adversarialA`, and
 *   `adversarialB` are ALL required. A missing money-critical-only verdict is
 *   treated as a FAIL (defensive: an absent reviewer must never silently pass
 *   the heavier gate).
 */
export interface TargetReviewVerdicts {
  /** Standards axis — runs on every Target PR (safe AND money-critical). */
  standards: ReviewVerdict;
  /** Spec axis (diff vs. design-concept artifact) — money-critical only. */
  spec?: ReviewVerdict;
  /** First independent adversarial refutation reviewer — money-critical only. */
  adversarialA?: ReviewVerdict;
  /** Second independent adversarial refutation reviewer — money-critical only. */
  adversarialB?: ReviewVerdict;
}

/**
 * What the playbook should do with the PR after folding the reviewer verdicts.
 *
 * - `merge` — the folded verdict is PASS; the Target's merge-on-green path
 *   proceeds (this module does not itself merge; CI / the playbook does).
 * - `bounce-to-reframe` — a hard finding was surfaced; push the item to the
 *   reframe queue (`hydra:anchors:reframe-queue`). NO operator escalation, NO
 *   deep-QA remediation loop (epic #1052: those Verifier-Core teeth are not
 *   mirrored for the Target).
 */
export type TargetQaAction = "merge" | "bounce-to-reframe";

/** The folded outcome of a Target QA pass. */
export interface TargetQaVerdict {
  /** The single folded review verdict over every consulted axis. */
  verdict: ReviewVerdict;
  /** Which path was taken — derived from the money-critical flag. */
  path: TargetQaPath;
  /** True iff the PR touched money-critical surface (provider/exec/stake/math). */
  moneyCritical: boolean;
  /** The routing decision: merge on PASS, bounce-to-reframe on FAIL. */
  action: TargetQaAction;
  /** Human-readable reason, naming the failing axis/reviewer(s) on FAIL. */
  reason: string;
  /**
   * The money-critical paths that drove the path choice (in input order,
   * de-duplicated). Empty on the safe path.
   */
  matchedPaths: string[];
}

/**
 * Decide which QA path a Target PR takes from its changed file paths.
 *
 * Delegation to `classifyRisk` against the manifest-sourced risk surface (issue
 * #3018 — `surface`/`appSubdir` come from `.hydra/manifest.json` via
 * `loadRiskSurface`, no hardcoded betting const). A risk-critical hit routes to
 * the heavier Standards + Spec + adversarial path; everything else takes the
 * safe Standards-only path.
 *
 * Surface resolution: callers pass an explicit `surface`/`appSubdir` (the
 * hermetic test path); when omitted they are read from the target manifest.
 * Fail-closed: if the manifest cannot be resolved the risk surface is UNKNOWN,
 * so we route to the HEAVIER `money-critical` path — a QA gate must never
 * DOWNGRADE its depth on a config error (an unresolvable surface must not
 * silently skip the Spec + adversarial fold).
 *
 * @param changedPaths the PR's changed file paths (repo-relative, Target repo).
 * @param surface   the target risk surface; defaults to the manifest-sourced value.
 * @param appSubdir the target app subdir; defaults to the manifest-sourced value.
 */
export function classifyTargetQaPath(
  changedPaths: readonly string[],
  surface?: RiskSurface,
  appSubdir?: string,
): {
  path: TargetQaPath;
  moneyCritical: boolean;
  matchedPaths: string[];
} {
  const resolved = resolveQaSurface(surface, appSubdir);
  if (!resolved) {
    // Fail-closed: an unresolvable manifest routes to the heavier path so QA
    // depth is never silently downgraded by a config error.
    return { path: "money-critical", moneyCritical: true, matchedPaths: [] };
  }
  // The public `moneyCritical` field / `"money-critical"` path label is the
  // Target-QA depth-routing name (consumed by target-qa-verdict.test.mts). The
  // underlying classifier now sources its surface from `.hydra/manifest.json`.
  const { riskCritical, matchedPaths } = classifyRisk(
    changedPaths,
    resolved.surface,
    resolved.appSubdir,
  );
  return {
    path: riskCritical ? "money-critical" : "safe",
    moneyCritical: riskCritical,
    matchedPaths,
  };
}

/**
 * Resolve the risk `surface`/`appSubdir` for the QA-verdict helpers.
 *
 * Returns the explicit values when the caller supplied them (the hermetic test
 * path). Otherwise reads them from the target manifest via `loadRiskSurface`;
 * returns `null` when the manifest cannot be resolved so the caller can apply
 * its own fail-closed policy (route to the heavier path). Never throws.
 */
function resolveQaSurface(
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
 * Fold the collected reviewer verdicts into a single Target QA verdict and
 * routing decision.
 *
 * Routing on the money-critical flag (from `changedPaths`):
 *
 *   - **safe** — PASS iff `standards === "PASS"`. The Spec / adversarial fields
 *     are not consulted on the safe path.
 *   - **money-critical** — PASS iff Standards AND Spec AND BOTH adversarial
 *     reviewers all returned PASS. A single FAIL from ANY of them — or a
 *     MISSING money-critical-only verdict (`spec` / `adversarialA` /
 *     `adversarialB` undefined) — is a FAIL. The missing-as-FAIL rule is the
 *     same defensive asymmetry the Orchestrator's adversarial fold uses: an
 *     absent refuter must never let the heavier gate pass by omission.
 *
 * A PASS routes to `merge`; a FAIL routes to `bounce-to-reframe` (no
 * escalation, no remediation loop). Pure — no fs / network / Redis.
 *
 * @param changedPaths the PR's changed file paths (repo-relative, Target repo).
 * @param verdicts the reviewer verdicts the playbook collected.
 * @param surface   the target risk surface; defaults to the manifest-sourced value.
 * @param appSubdir the target app subdir; defaults to the manifest-sourced value.
 */
export function classifyTargetQaVerdict(
  changedPaths: readonly string[],
  verdicts: TargetReviewVerdicts,
  surface?: RiskSurface,
  appSubdir?: string,
): TargetQaVerdict {
  const { path, moneyCritical, matchedPaths } = classifyTargetQaPath(
    changedPaths,
    surface,
    appSubdir,
  );

  // Standards runs on every path.
  if (verdicts.standards === "FAIL") {
    return fail(path, moneyCritical, matchedPaths, "Standards review surfaced a hard finding.");
  }

  if (path === "safe") {
    // Safe path: Standards-only. A PASS here is the whole gate.
    return pass(
      path,
      moneyCritical,
      matchedPaths,
      "Standards review PASS (safe path — UI / docs / config; no money-critical surface).",
    );
  }

  // Money-critical path: Standards + Spec + adversarial 2-reviewer fold.
  // Every money-critical-only verdict is required; a missing one is a FAIL.
  const failures: string[] = [];
  if (verdicts.spec === undefined) {
    failures.push("Spec verdict missing (required on money-critical path)");
  } else if (verdicts.spec === "FAIL") {
    failures.push("Spec review surfaced a hard finding (diff diverges from design-concept)");
  }

  if (verdicts.adversarialA === undefined) {
    failures.push("adversarial reviewer A verdict missing (required on money-critical path)");
  } else if (verdicts.adversarialA === "FAIL") {
    failures.push("adversarial reviewer A surfaced a real blocker");
  }

  if (verdicts.adversarialB === undefined) {
    failures.push("adversarial reviewer B verdict missing (required on money-critical path)");
  } else if (verdicts.adversarialB === "FAIL") {
    failures.push("adversarial reviewer B surfaced a real blocker");
  }

  if (failures.length > 0) {
    return fail(
      path,
      moneyCritical,
      matchedPaths,
      `Money-critical QA FAIL: ${failures.join("; ")}.`,
    );
  }

  return pass(
    path,
    moneyCritical,
    matchedPaths,
    "Money-critical QA PASS: Standards + Spec + both adversarial reviewers found no hard finding.",
  );
}

function pass(
  path: TargetQaPath,
  moneyCritical: boolean,
  matchedPaths: string[],
  reason: string,
): TargetQaVerdict {
  return { verdict: "PASS", path, moneyCritical, action: "merge", reason, matchedPaths };
}

function fail(
  path: TargetQaPath,
  moneyCritical: boolean,
  matchedPaths: string[],
  reason: string,
): TargetQaVerdict {
  return {
    verdict: "FAIL",
    path,
    moneyCritical,
    action: "bounce-to-reframe",
    reason,
    matchedPaths,
  };
}
