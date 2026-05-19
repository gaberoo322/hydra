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
 *   (so a child whose `dependsOn: [1]` can render `## Blocked by` → `#42`).
 *   Entries for not-yet-created siblings are omitted from the Blocked by list
 *   — the skill creates children in dependency order so earlier siblings
 *   always have numbers by the time later siblings render.
 * - `expectedTier` is the integer tier returned by `GET /api/tier` for the
 *   slice's `filesInScope`. Stamped into the body as `Expected tier: N` so
 *   CI's tier-gate has a heads-up.
 */
export function renderChildBody(
  input: PrdInput,
  sliceIndex: number,
  parentNumber: number,
  siblingIssueNumbers: Map<number, number> = new Map(),
  expectedTier?: number,
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
  lines.push("## Files in scope");
  lines.push("");
  for (const f of slice.filesInScope) {
    lines.push(`- \`${f}\``);
  }
  lines.push("");
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
    for (const ref of resolvedDeps) {
      lines.push(`- ${ref}`);
    }
  } else {
    lines.push("- _(none)_");
  }
  lines.push("");
  if (typeof expectedTier === "number" && Number.isFinite(expectedTier)) {
    lines.push(`Expected tier: ${expectedTier}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Render the labels the skill should apply to a child slice. Always includes
 * `ready-for-agent` plus the slice's kind (`enhancement` by default).
 */
export function childLabels(slice: PrdSlice): string[] {
  const kind = slice.kind ?? "enhancement";
  return ["ready-for-agent", kind];
}

/**
 * Render the labels the skill should apply to the parent epic. Always includes
 * `enhancement` (the existing epic label vocabulary — `epic` is intentionally
 * not introduced here per issue #514's "reuse `enhancement` if introducing a
 * new label is out of scope" guidance).
 */
export function parentLabels(): string[] {
  return ["enhancement"];
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
