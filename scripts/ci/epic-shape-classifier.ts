/**
 * scripts/ci/epic-shape-classifier.ts — Pure decision helper for the
 * hydra-research / hydra-discover -> hydra-prd routing question (issue #515).
 *
 * Background: with the Specs subsystem retired (issue #513) and `hydra-prd`
 * landed (issue #514), `hydra-research` needs to decide — per finding —
 * whether to file a flat list of disconnected GitHub issues OR a single
 * parent epic + N tracer-bullet children via `hydra-prd`. Today the
 * decision is implicit in the prose; tomorrow it can be a one-line call
 * from the playbook (Bash: `node scripts/ci/epic-shape-classifier.ts <json>`)
 * or, more usefully, this same helper consumed from a future TS dispatcher.
 *
 * The rule (mirrored verbatim from issue #515 acceptance criteria):
 *
 *   A finding is **epic-shaped** iff ALL of:
 *     - The decomposition produces >= 3 vertical slices
 *     - The slices share a common rationale (one problem statement covers all)
 *     - The slices have inter-dependencies (>= 1 sibling-to-sibling dependsOn)
 *
 *   A finding is **flat-shaped** iff:
 *     - It has 1-2 slices total, OR
 *     - The slices are mutually independent (no dependsOn between siblings
 *       AND no shared rationale)
 *
 *   Escape hatches:
 *     - `epic: false` — operator forces flat
 *     - `epic: true`  — operator forces epic (still validates ≥3 slices below;
 *                       `hydra-prd` would reject a forced epic with <3 slices,
 *                       so we surface that here as `forcedEpicTooSmall`)
 *
 * The helper returns a structured verdict — never throws on a well-formed
 * Finding shape — so the calling playbook can log the reason verbatim. The
 * playbook prose treats:
 *
 *   shape === "epic" → render PrdInput + invoke `hydra-prd --apply`
 *   shape === "flat" → fall through to per-slice `gh issue create`
 *
 * This module is pure (no fs / network / process) — see
 * test/epic-shape-classifier.test.mts for the regression coverage.
 */

/**
 * The slice shape this classifier consumes. Deliberately a structural subset
 * of `PrdSlice` from `hydra-prd-render.ts` so a research finding can be
 * passed straight through to `hydra-prd` once the verdict is `epic`.
 *
 * `dependsOn` is 1-based sibling indices (per the `hydra-prd` contract).
 */
export interface EpicShapeSlice {
  /** Short imperative title — used for diagnostics only here. */
  title: string;
  /**
   * 1-based indices of sibling slices this slice depends on. The presence of
   * any entry is what tells the classifier "the slices have inter-dependencies."
   */
  dependsOn?: number[];
}

/**
 * The finding shape this classifier consumes. The fields that overlap with
 * `PrdInput` (title/problem/rationale/slices) are exactly the same so a
 * research finding can be forwarded straight to `hydra-prd` once we decide
 * to route it through the PRD producer.
 *
 * `epic` is the explicit operator override — `true` forces epic-shape, `false`
 * forces flat-shape. Absent (`undefined`) means "let the rule decide."
 */
export interface EpicShapeFinding {
  /** Parent epic title — required only because we surface it in diagnostics. */
  title?: string;
  /** Problem statement (prose). Optional; the rule doesn't read it directly. */
  problem?: string;
  /**
   * Rationale (prose). The presence/absence of this string is what we use to
   * decide whether the slices "share a common rationale." A finding without
   * a rationale is treated as having no shared narrative — slices stand
   * alone.
   */
  rationale?: string;
  /** Vertical slices that make up the decomposition. */
  slices: EpicShapeSlice[];
  /**
   * Explicit operator override. Absent → let the rule decide. `true` → force
   * epic-shape (still surfaces `forcedEpicTooSmall` if there are <3 slices).
   * `false` → force flat-shape regardless of slice count or dependencies.
   */
  epic?: boolean;
}

/**
 * The verdict returned by `classifyEpicShape`. Designed to be both
 * machine-actionable (read `shape`) and human-readable (log `reason` from
 * the calling playbook).
 *
 * `forcedEpicTooSmall` is the one edge case the classifier won't silently
 * fix: if the operator passes `epic: true` but supplies fewer than 3 slices,
 * `hydra-prd` would reject the input anyway (the validator enforces a
 * 3-slice minimum). We surface that mismatch here so the playbook can stop
 * BEFORE invoking `hydra-prd` and producing a noisy validation report.
 */
export interface EpicShapeVerdict {
  /**
   * The routing decision. `epic` → invoke `hydra-prd`. `flat` → fall through
   * to per-slice `gh issue create`.
   */
  shape: "epic" | "flat";
  /**
   * Short human-readable explanation. Stable enough to assert on in tests;
   * meant to be logged verbatim by the calling playbook.
   */
  reason: string;
  /**
   * True when the operator forced epic-shape (`epic: true`) but supplied
   * fewer than 3 slices. The shape is still `flat` in that case (we can't
   * route a 2-slice finding through `hydra-prd`); this flag exists so the
   * playbook can surface a clear "your `epic: true` override was ignored
   * because there aren't enough slices" warning instead of silently filing
   * flat issues.
   */
  forcedEpicTooSmall?: boolean;
}

const MIN_SLICES_FOR_EPIC = 3;

/**
 * Classify a research finding's shape. Returns the verdict — never throws
 * on a well-formed `EpicShapeFinding`.
 *
 * The decision tree (in order, first match wins):
 *
 *   1. Operator override `epic: false` → flat (reason: "operator override").
 *   2. Operator override `epic: true`:
 *        - <3 slices → flat + forcedEpicTooSmall=true
 *        - >=3 slices → epic (reason: "operator override")
 *   3. <3 slices → flat (reason: "fewer than 3 slices").
 *   4. No sibling dependencies AND no shared rationale → flat
 *      (reason: "mutually independent slices").
 *   5. Otherwise → epic.
 *
 * The order matters: explicit operator overrides win over the rule, and the
 * "too few slices" check runs before the dependency check so the verdict
 * reason is the most-specific reason that fired.
 */
export function classifyEpicShape(
  finding: EpicShapeFinding,
): EpicShapeVerdict {
  const slices = Array.isArray(finding.slices) ? finding.slices : [];
  const sliceCount = slices.length;

  // 1. Operator override: forced flat. The operator may decide they want
  // multiple loose issues even when the rule would have produced an epic
  // (parallel small wins, e.g.).
  if (finding.epic === false) {
    return {
      shape: "flat",
      reason: "operator override (epic: false)",
    };
  }

  // 2. Operator override: forced epic. We still have to honour the
  // 3-slice minimum that `hydra-prd` enforces — surface the mismatch so the
  // playbook can warn instead of producing a malformed PRD.
  if (finding.epic === true) {
    if (sliceCount < MIN_SLICES_FOR_EPIC) {
      return {
        shape: "flat",
        reason: `operator forced epic: true but only ${sliceCount} slices — hydra-prd requires >=${MIN_SLICES_FOR_EPIC}`,
        forcedEpicTooSmall: true,
      };
    }
    return {
      shape: "epic",
      reason: "operator override (epic: true)",
    };
  }

  // 3. Rule branch — too few slices to be epic-shaped.
  if (sliceCount < MIN_SLICES_FOR_EPIC) {
    return {
      shape: "flat",
      reason: `fewer than ${MIN_SLICES_FOR_EPIC} slices (${sliceCount}) — file flat`,
    };
  }

  // 4. Rule branch — slices may be epic-sized but if they're mutually
  // independent (no sibling deps) AND there's no shared rationale, they're
  // parallel small wins, not an epic. Either ingredient alone is enough to
  // keep them in epic territory: a shared rationale without deps still
  // wants a parent narrative; deps without rationale still need
  // sequencing.
  const hasSiblingDependency = slices.some(
    (s) => Array.isArray(s.dependsOn) && s.dependsOn.length > 0,
  );
  const hasSharedRationale =
    typeof finding.rationale === "string" && finding.rationale.trim().length > 0;

  if (!hasSiblingDependency && !hasSharedRationale) {
    return {
      shape: "flat",
      reason:
        "mutually independent slices (no sibling dependsOn, no shared rationale) — file flat",
    };
  }

  // 5. Default: epic. Cite the strongest signal in the reason.
  const parts: string[] = [];
  if (hasSiblingDependency) parts.push("inter-slice dependsOn present");
  if (hasSharedRationale) parts.push("shared rationale present");
  return {
    shape: "epic",
    reason: `${sliceCount} slices; ${parts.join(", ")} — route through hydra-prd`,
  };
}

/**
 * Convenience: returns true iff the verdict says route through `hydra-prd`.
 * Lets the calling playbook write `if (shouldRouteToPrd(verdict)) ...`
 * without poking at the `shape` field directly.
 */
export function shouldRouteToPrd(verdict: EpicShapeVerdict): boolean {
  return verdict.shape === "epic";
}
