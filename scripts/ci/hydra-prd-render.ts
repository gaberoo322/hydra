/**
 * scripts/ci/hydra-prd-render.ts — Pure helpers for the hydra-prd skill
 * (issue #514).
 *
 * Background: with the Specs subsystem retired (issue #513), multi-issue
 * research findings have nowhere durable to live. `hydra-prd` is the
 * non-interactive producer of a GitHub-native replacement: one parent epic
 * issue plus N tracer-bullet child issues on `gaberoo322/hydra`, structured
 * so that `hydra-epic-close` can later auto-close the parent once every
 * child closes.
 *
 * Unlike the generic upstream `/to-prd` skill — which interviews the operator
 * via `AskUserQuestion` — `hydra-prd` is fully parameterised: input is a
 * structured `PrdInput`, output is rendered markdown bodies for the parent
 * and each child. The shell skill (docs/operator-playbooks/hydra-prd.md)
 * calls these helpers, then shells out to `gh issue create` in dependency
 * order (parent first, then children referencing the real parent number).
 *
 * This module is pure — no fs / network / process — so it can be unit
 * tested directly. See test/hydra-prd-template.test.mts.
 *
 * ## Demoted to a called renderer library (ADR-0030 Decision 2, issue #3421)
 *
 * Under the one-lineage refit (ADR-0030), the Pocock `tickets` stage is owned
 * by the `tickets_orch` dispatch class (`scripts/autopilot/classes.json`),
 * which dispatches the vendored upstream `to-tickets` skill + the thin Hydra
 * AFK overlay (the Option C compose mechanism, issue #3420). This module is
 * that overlay's CALLEE: the `PrdInput`→issue-body renderer library. It is
 * NOT a standalone dispatch identity — `hydra-prd` has no class row in the
 * taxonomy and must not gain one (pinned by test/taxonomy-classes.test.mts).
 * Expand step: the existing hydra-prd playbook path stays alive beside the
 * new class until the delta #3423 / epsilon #3424 contract phases retire it.
 */

/**
 * A single tracer-bullet vertical slice in the PRD.
 *
 * `dependsOn` references sibling slices by their 1-based slice index
 * (so slice 2 referencing slice 1 → `dependsOn: [1]`). The rendered child
 * body translates these indices into the real GitHub issue numbers once
 * the caller has them; see `renderChildBody`.
 */
export interface PrdSlice {
  /** Short imperative title (used as the GitHub issue title). */
  title: string;
  /** What end-to-end behaviour this slice ships (prose). */
  whatToBuild: string;
  /** Acceptance criteria — rendered as a markdown checkbox list. */
  acceptanceCriteria: string[];
  /** Files in scope — REQUIRED by the issue-label-validation workflow (#396). */
  filesInScope: string[];
  /** Files explicitly out of scope — strongly recommended for scope-check CI. */
  filesOutOfScope?: string[];
  /**
   * 1-based indices of sibling slices this slice depends on. The renderer
   * resolves these to issue numbers via the caller-supplied `siblingIssueNumbers`
   * map.
   */
  dependsOn?: number[];
  /**
   * Label hint — `enhancement` (default) or `bug`. The skill always also
   * stamps `ready-for-agent`.
   */
  kind?: "enhancement" | "bug";
}

/**
 * Structured input to the hydra-prd skill. Callers (operator invocation or
 * future autopilot wiring) build this from a research finding / discover
 * anchor and pass it as JSON.
 */
export interface PrdInput {
  /** Parent epic title — single line, no leading "Epic:" prefix. */
  title: string;
  /** Problem statement using Hydra glossary terms (see CONTEXT.md). */
  problem: string;
  /** Rationale for shipping this now (links to Target Outcomes, Stuckness, etc.). */
  rationale: string;
  /**
   * The tracer-bullet slice list, in dependency order. Issue #514 requires
   * ≥3 slices; the validator enforces this.
   */
  slices: PrdSlice[];
  /**
   * Glossary terms expected to appear in the parent narrative. The vocabulary
   * check (see `vocabularyCheck`) flags any of these that are missing.
   */
  expectedGlossaryTerms?: string[];
  /**
   * Optional source pointer (e.g. `hydra:reports:research:2026-05-18T...`)
   * surfaced in the parent footer so future operators can trace the epic
   * back to the finding that produced it.
   */
  sourceRef?: string;
}

export interface PrdValidationError {
  field: string;
  reason: string;
}

/**
 * Validate a PrdInput. Returns the list of problems found — an empty array
 * means the input is ready to render. The skill prose treats a non-empty
 * return as a hard stop (no issues are created).
 */
export function validatePrdInput(input: PrdInput): PrdValidationError[] {
  const errors: PrdValidationError[] = [];

  if (!input.title || !input.title.trim()) {
    errors.push({ field: "title", reason: "parent title is required" });
  }
  if (!input.problem || !input.problem.trim()) {
    errors.push({ field: "problem", reason: "problem statement is required" });
  }
  if (!input.rationale || !input.rationale.trim()) {
    errors.push({ field: "rationale", reason: "rationale is required" });
  }
  if (!Array.isArray(input.slices) || input.slices.length < 3) {
    errors.push({
      field: "slices",
      reason: `at least 3 tracer-bullet slices required (got ${
        Array.isArray(input.slices) ? input.slices.length : 0
      })`,
    });
  }

  if (Array.isArray(input.slices)) {
    input.slices.forEach((slice, i) => {
      const idx = i + 1;
      if (!slice.title || !slice.title.trim()) {
        errors.push({ field: `slices[${idx}].title`, reason: "title required" });
      }
      if (!slice.whatToBuild || !slice.whatToBuild.trim()) {
        errors.push({
          field: `slices[${idx}].whatToBuild`,
          reason: "whatToBuild required",
        });
      }
      if (!Array.isArray(slice.acceptanceCriteria) || slice.acceptanceCriteria.length === 0) {
        errors.push({
          field: `slices[${idx}].acceptanceCriteria`,
          reason: "at least one acceptance criterion required",
        });
      }
      if (!Array.isArray(slice.filesInScope) || slice.filesInScope.length === 0) {
        // The issue-label-validation workflow (#396) requires a ## Files in scope
        // section with at least one entry on every agent-ready child.
        errors.push({
          field: `slices[${idx}].filesInScope`,
          reason: "at least one file in scope required (issue-label-validation #396)",
        });
      }
      if (slice.dependsOn) {
        for (const dep of slice.dependsOn) {
          if (!Number.isInteger(dep) || dep < 1 || dep > input.slices.length) {
            errors.push({
              field: `slices[${idx}].dependsOn`,
              reason: `dependsOn entry ${dep} out of range (must be 1..${input.slices.length})`,
            });
          }
          if (dep >= idx) {
            errors.push({
              field: `slices[${idx}].dependsOn`,
              reason: `slice ${idx} depends on later/self slice ${dep} — slices must be listed in dependency order`,
            });
          }
        }
      }
    });
  }

  return errors;
}

/**
 * Issue #2175: a path that belongs to the **Target** repo (`hydra-betting`),
 * not this orchestrator repo (`gaberoo322/hydra`).
 *
 * When a research finding describes a seam with siblings in both repos, a
 * slice's `filesInScope` can list Target paths alongside orchestrator paths.
 * Rendering those Target paths under `## Files in scope` is the friction the
 * issue reports: `scripts/ci/scope-check.ts` unions every path in that section
 * as in-scope, and an orchestrator dev PR (which correctly only touches the
 * orchestrator file) then has to scope-justify files that cannot exist in this
 * repo — pure friction, no safety value.
 *
 * A path is Target-repo-shaped when it carries the `hydra-betting` marker in
 * any of its conventional forms: a `hydra-betting/…` relative path, the
 * `gaberoo322/hydra-betting` org-qualified form, or the absolute Target root
 * `/home/gabe/hydra-betting/…` (the canonical root, see
 * scripts/ci/hydra-target-wire-or-retire-emit.ts `TARGET_ROOT`). Matching the
 * marker as a path segment (boundary-anchored) avoids mis-flagging an
 * orchestrator file that merely mentions the Target in its name.
 */
export function isTargetRepoPath(path: string, targetName?: string): boolean {
  const p = (path || "").trim();
  if (!p) return false;
  // Boundary-anchored: the Target name must be a path segment, not a substring
  // of some other identifier (e.g. it must be `a/hydra-betting/b`, the start
  // `hydra-betting/…`, or the bare `hydra-betting`), so an orchestrator file
  // like `src/hydra-betting-adapter.ts` is NOT mis-classified as Target.
  // `hydra-betting` (the retired Target) always counts; issue #5168 adds the
  // configured Target's name when the caller passes it (the renderer is pure,
  // so the playbook resolves it through the target seam).
  const names = [LEGACY_TARGET_NAME, ...(targetName ? [targetName] : [])];
  return names.some((n) => new RegExp(`(^|/)(gaberoo322/)?${escapeRegExp(n)}(/|$)`).test(p));
}

/** The retired Target the #2175 partition was written against; still a Target path. */
const LEGACY_TARGET_NAME = "hydra-betting";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Issue #2175: partition a slice's declared in-scope files by repo. Returns
 * `{ thisRepo, targetRepo }` so renderers can keep ONLY this-repo paths under
 * `## Files in scope` and surface Target-repo siblings under a clearly-labelled
 * related-but-not-in-scope note. Order within each bucket is preserved.
 */
export function partitionScopeByRepo(files: string[], targetName?: string): {
  thisRepo: string[];
  targetRepo: string[];
} {
  const thisRepo: string[] = [];
  const targetRepo: string[] = [];
  for (const f of files ?? []) {
    if (isTargetRepoPath(f, targetName)) targetRepo.push(f);
    else thisRepo.push(f);
  }
  return { thisRepo, targetRepo };
}

/**
 * Issue #5168: which board the rendered issues are filed on.
 *
 * - `orch` (the default) renders exactly as before; `targetName` (the seam's
 *   `$TARGET_NAME`) also partitions that Target's paths out of scope.
 * - `target` renders for the Target board itself: every declared path is in
 *   scope (they all live in the Target repo), and the Orchestrator-only
 *   `Expected tier` stamp gives way to a `Money-critical` line derived from
 *   the Target Manifest's `riskCritical.surface` (`$TARGET_RISK_SURFACE_JSON`).
 */
export type RenderScope =
  | { readonly kind: "orch"; readonly targetName?: string }
  | { readonly kind: "target"; readonly riskSurface: readonly string[] };

/**
 * Issue #5168: the slice paths on the Target risk surface, in input order,
 * deduped. Same rule as the Target's own classifier (`risk-core.ts`
 * `matchRiskSurface`): an entry ending in `/` is a directory prefix, any other
 * entry matches one file exactly. A leading `./` is ignored.
 */
export function riskSurfaceMatches(files: readonly string[], riskSurface: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of files ?? []) {
    const p = (raw || "").trim().replace(/^\.\//, "");
    if (!p || out.includes(p)) continue;
    if (riskSurface.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e))) out.push(p);
  }
  return out;
}

/**
 * Run a glossary vocabulary check against the parent's combined narrative
 * (problem + rationale). Returns the subset of `expectedGlossaryTerms` that
 * are missing — case-insensitive, whole-word match. Missing terms are a
 * soft warning, not a hard error: research findings on rare topics may
 * legitimately not need every glossary term.
 */
export function vocabularyCheck(
  parentNarrative: string,
  expectedGlossaryTerms: string[] | undefined,
): string[] {
  if (!expectedGlossaryTerms || expectedGlossaryTerms.length === 0) return [];
  const haystack = parentNarrative.toLowerCase();
  const missing: string[] = [];
  for (const term of expectedGlossaryTerms) {
    const needle = term.toLowerCase().trim();
    if (!needle) continue;
    // Whole-word, case-insensitive. Escape regex meta.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (!re.test(haystack)) {
      missing.push(term);
    }
  }
  return missing;
}

/**
 * Render the parent epic body. Children are rendered as a markdown checklist
 * in a `## Sub-issues` section so `hydra-epic-close` can parse them.
 *
 * `childIssueNumbers` should be the GitHub issue numbers for each slice in
 * order. If the parent is being rendered *before* the children exist (the
 * skill renders the parent first to get its number, then creates children
 * with `## Parent` pointing back), pass an empty array — the function
 * renders `- [ ] (slice 1: title)` placeholders instead.
 */
export function renderParentBody(
  input: PrdInput,
  childIssueNumbers: number[] = [],
): string {
  const lines: string[] = [];
  lines.push("> *Generated by `/hydra-prd`*");
  lines.push("");
  lines.push("## Problem");
  lines.push("");
  lines.push(input.problem.trim());
  lines.push("");
  lines.push("## Rationale");
  lines.push("");
  lines.push(input.rationale.trim());
  lines.push("");
  lines.push("## Sub-issues");
  lines.push("");
  input.slices.forEach((slice, i) => {
    const num = childIssueNumbers[i];
    if (typeof num === "number" && Number.isFinite(num) && num > 0) {
      lines.push(`- [ ] #${num} — ${slice.title}`);
    } else {
      lines.push(`- [ ] (slice ${i + 1}: ${slice.title})`);
    }
  });
  lines.push("");
  if (input.sourceRef) {
    lines.push(`<sub>Source: \`${input.sourceRef}\`</sub>`);
  }
  return lines.join("\n").trim() + "\n";
}

/**
 * Render a single child issue body.
 *
 * - `parentNumber` is the parent epic's real GitHub issue number (the parent
 *   must be created first).
 * - `sliceIndex` is the 1-based index of this slice in `input.slices`.
 * - `siblingIssueNumbers` maps 1-based sibling indices to their issue numbers
 *   (so a child whose `dependsOn: [1]` renders `## Blocked by` → `- Blocked by #42`,
 *   the parser-clean form `extractStrictBlockerRefs` recovers — see issue #3425).
 *   Entries for not-yet-created siblings are omitted from the Blocked by list
 *   — the skill creates children in dependency order so earlier siblings
 *   always have numbers by the time later siblings render.
 * - `expectedTier` is the integer tier returned by `GET /api/tier` for the
 *   slice's `filesInScope`. Stamped into the body as `Expected tier: N` so
 *   CI's tier-gate has a heads-up. Orchestrator scope only.
 * - `scope` (issue #5168, default `{ kind: "orch" }`) — see {@link RenderScope}.
 */
export function renderChildBody(
  input: PrdInput,
  sliceIndex: number,
  parentNumber: number,
  siblingIssueNumbers: Map<number, number> = new Map(),
  expectedTier?: number,
  scope: RenderScope = { kind: "orch" },
): string {
  const slice = input.slices[sliceIndex - 1];
  if (!slice) {
    throw new Error(`renderChildBody: sliceIndex ${sliceIndex} out of range`);
  }

  const lines: string[] = [];
  lines.push("> *Generated by `/hydra-prd`*");
  lines.push("");
  lines.push("## Parent");
  lines.push("");
  lines.push(`#${parentNumber}`);
  lines.push("");
  lines.push("## What to build");
  lines.push("");
  lines.push(slice.whatToBuild.trim());
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  for (const ac of slice.acceptanceCriteria) {
    lines.push(`- [ ] ${ac.trim()}`);
  }
  lines.push("");
  // Issue #2175: partition by repo so Target-repo (hydra-betting) siblings
  // never land under `## Files in scope`, where scope-check would union them
  // as in-scope and force the orchestrator dev PR to scope-justify files that
  // cannot exist in this repo. This-repo paths stay in `## Files in scope`;
  // Target-repo paths move to a clearly-labelled `## Related (Target repo)`
  // note below, which scope-check never reads.
  // A Target-scope issue IS on the Target repo, so nothing is partitioned out.
  const { thisRepo: inScopeThisRepo, targetRepo: relatedTargetRepo } =
    scope.kind === "target"
      ? { thisRepo: [...slice.filesInScope], targetRepo: [] }
      : partitionScopeByRepo(slice.filesInScope, scope.targetName);
  lines.push("## Files in scope");
  lines.push("");
  if (inScopeThisRepo.length > 0) {
    for (const f of inScopeThisRepo) {
      lines.push(`- \`${f}\``);
    }
  } else {
    // Every Target-repo path was partitioned out and the slice declared no
    // orchestrator-repo file. Surface this loudly rather than emit an empty
    // section the issue-label-validation workflow (#396) would reject — a
    // cross-repo slice with NO orchestrator file probably belongs in the
    // Target backlog, not on gaberoo322/hydra.
    lines.push("- _(none in this repo — see Related (Target repo) below)_");
  }
  lines.push("");
  if (relatedTargetRepo.length > 0) {
    // NOT `## Files in scope` / `## Files out of scope` — scope-check
    // (scripts/ci/scope-check.ts) parses only those two headings, so a
    // distinct heading keeps these Target paths out of the scope set entirely.
    lines.push("## Related (Target repo)");
    lines.push("");
    const targetLabel = scope.kind === "orch" && scope.targetName ? scope.targetName : LEGACY_TARGET_NAME;
    lines.push(
      `These sibling paths live in the Target repo (\`${targetLabel}\`), not this repo. ` +
        "They are listed for context only and are intentionally outside this issue's scope — " +
        "do not touch them in an orchestrator PR.",
    );
    lines.push("");
    for (const f of relatedTargetRepo) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }
  lines.push("## Files out of scope");
  lines.push("");
  if (slice.filesOutOfScope && slice.filesOutOfScope.length > 0) {
    for (const f of slice.filesOutOfScope) {
      lines.push(`- \`${f}\``);
    }
  } else {
    lines.push("- _(none declared — scope-check CI will treat any file outside the in-scope list as a violation)_");
  }
  lines.push("");
  lines.push("## Blocked by");
  lines.push("");
  const deps = slice.dependsOn ?? [];
  const resolvedDeps: string[] = [];
  for (const dep of deps) {
    const num = siblingIssueNumbers.get(dep);
    if (typeof num === "number" && Number.isFinite(num) && num > 0) {
      resolvedDeps.push(`#${num}`);
    }
  }
  if (resolvedDeps.length > 0) {
    // Issue #3425: each bullet self-anchors the `Blocked by #N` phrase so
    // `extractStrictBlockerRefs` (src/github/blockers.ts, STRICT_BLOCKER_PATTERNS)
    // recovers the number. The `## Blocked by` heading alone does NOT prime the
    // contiguous `blocked by … #N` pattern across the blank line, so the old
    // bare `- #N` bullet parsed to [] — silently no-opping #3059's dep-aware
    // dispatch gate (ADR-0029 Decision 5). The heading + one-bullet-per-blocker
    // structure is preserved; only the bullet text changes.
    for (const ref of resolvedDeps) {
      lines.push(`- Blocked by ${ref}`);
    }
  } else {
    lines.push("- _(none)_");
  }
  lines.push("");
  if (scope.kind === "target") {
    // The tier ladder is Orchestrator-only (ADR-0004); a Target slice's depth
    // is set by the risk surface instead, which the Target's own CI re-derives
    // on the PR and its automerge fence enforces.
    const touched = riskSurfaceMatches(slice.filesInScope, scope.riskSurface);
    if (touched.length > 0) {
      lines.push(`Money-critical: yes — touches the Target risk surface (${touched.join(", ")})`);
      lines.push("");
    }
  } else if (typeof expectedTier === "number" && Number.isFinite(expectedTier)) {
    lines.push(`Expected tier: ${expectedTier}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Render the labels the skill should apply to a child slice. Always includes
 * `ready-for-agent` plus the slice's kind (`enhancement` by default). In
 * Target scope (issue #5168) a slice on the risk surface also carries
 * `money-critical`, the label the Target's automerge fence reads.
 */
export function childLabels(slice: PrdSlice, scope: RenderScope = { kind: "orch" }): string[] {
  const kind = slice.kind ?? "enhancement";
  const labels = ["ready-for-agent", kind];
  if (scope.kind === "target" && riskSurfaceMatches(slice.filesInScope, scope.riskSurface).length > 0) {
    labels.push("money-critical");
  }
  return labels;
}

/**
 * Render the labels the skill should apply to the parent epic. Always includes
 * `enhancement` (the existing epic label vocabulary — `epic` is intentionally
 * not introduced here per issue #514's "reuse `enhancement` if introducing a
 * new label is out of scope" guidance) plus `needs-triage` so the epic is born
 * with a stable lifecycle label (issue #3788 Cause 2). Before this, a freshly
 * created parent carried only a category label — no `ready-for-agent` (epics
 * are correctly excluded, #777/#794) and nothing else — so once a later sweep
 * cleared a stale `blocked`, the epic reverted to fully label-less and stayed
 * an `untriaged_orphans` false-positive for its entire lifetime. `hydra-sweep`
 * already special-cases tracking parents at the `needs-triage` lane (skip
 * auto-triage, run the stuck-ness gate instead), so stamping `needs-triage`
 * here is safe: a PROGRESSING epic is left alone with the label intact, and a
 * STUCK one still routes to `ready-for-human` as before.
 */
export function parentLabels(): string[] {
  return ["enhancement", "needs-triage"];
}

/**
 * Parse the CLI-style args the skill receives (via Skill `args` or operator
 * invocation) into a normalised options object.
 *
 * Recognised forms:
 *   --input=<path>     → read PrdInput JSON from this file (otherwise stdin)
 *   --dry-run          → render bodies and print them; do NOT call `gh issue create`
 *   --apply            → opposite of dry-run; the skill prose treats this as the
 *                        only path that actually creates GitHub issues
 *
 * Dry-run is the default for safety — `parseArgs("")` returns `{ apply: false }`.
 */
export function parseArgs(args: string | null | undefined): {
  apply: boolean;
  inputPath?: string;
} {
  if (!args) return { apply: false };
  const tokens = args
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  let apply = false;
  let inputPath: string | undefined;
  for (const t of tokens) {
    if (t === "--apply") {
      apply = true;
      continue;
    }
    if (t === "--dry-run") {
      apply = false;
      continue;
    }
    const [k, v] = t.split("=", 2);
    if (k === "apply") {
      apply = v === "true" || v === "1" || v === "yes";
      continue;
    }
    if (k === "--input" || k === "input") {
      inputPath = v;
      continue;
    }
  }
  return { apply, inputPath };
}
