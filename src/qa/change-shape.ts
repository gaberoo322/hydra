/**
 * src/qa/change-shape.ts — the change-shape leaf (prompt-only / tests-only / docs-only / code) shared by the admission and fan-out phases.
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

/**
 * Change-shape reviewer sizing (issue #4733). Pure, no fs/network.
 *
 * The tier classifier is Verifier Core (T4) and lands most PRs at T3, so a
 * doc-only PR paid the full T3 two-reviewer × two-axis (4 sub-agent) fan-out.
 * Rather than touch the classifier, hydra-qa sizes its fan-out from the SHAPE
 * of the changed-file list:
 *
 *   code        — anything under src/, scripts/, dashboard/src/, .github/, or
 *                 any other path that is not doc / test / prompt. A mixed diff
 *                 with even ONE code path is `code`.
 *   prompt-only — prompt/skill surfaces (playbook `.md` under
 *                 docs/operator-playbooks/, `.claude/skills/**.md`,
 *                 config/agents/, config/feedback/).
 *   tests-only  — paths under test/.
 *   docs-only   — documentation: docs/**, or a `.md` outside the code dirs.
 *
 * A non-code MIX reports its most behavioural component (prompt > tests >
 * docs) so the literal set stays four-valued. An empty list is `code`
 * (fail-closed: no evidence of a narrow change buys full review).
 */
export type ChangeShape = "docs-only" | "tests-only" | "prompt-only" | "code";

/** Path prefixes that always make a diff `code`, regardless of extension. */
const CODE_PATH_PREFIXES = ["src/", "scripts/", "dashboard/src/", ".github/"] as const;

type NonCodeKind = "docs" | "tests" | "prompt";

function normalizeChangedPath(rawPath: string): string {
  return rawPath.trim().replace(/^\.\//, "");
}

/**
 * The ONE prompt/skill path list (issue #4733): shared by the change-shape
 * classifier and the playbook's step-6 Tier-1 Spec auto-bypass, so the two
 * cannot disagree about what "prompt-only" means.
 */
export function isPromptPath(rawPath: string): boolean {
  const p = normalizeChangedPath(rawPath);
  const isMarkdown = p.endsWith(".md");
  return (
    (p.startsWith("docs/operator-playbooks/") && isMarkdown) ||
    (p.startsWith(".claude/skills/") && isMarkdown) ||
    p.startsWith("config/agents/") ||
    p.startsWith("config/feedback/")
  );
}

/** True iff the list is non-empty and EVERY path is a prompt path. */
export function isPromptOnlyChange(paths: readonly string[]): boolean {
  const real = paths.filter((p) => typeof p === "string" && p.trim() !== "");
  return real.length > 0 && real.every(isPromptPath);
}

function classifyChangedPath(rawPath: string): NonCodeKind | "code" {
  const p = normalizeChangedPath(rawPath);
  if (CODE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix))) return "code";
  if (isPromptPath(p)) return "prompt";
  const isMarkdown = p.endsWith(".md");
  if (p.startsWith("test/")) return "tests";
  // Non-.md playbook siblings (e.g. a hook `.settings.json`) register runtime
  // behaviour, so they stay `code` instead of falling into the docs arm.
  if (p.startsWith("docs/operator-playbooks/")) return "code";
  if (p.startsWith("docs/") || isMarkdown) return "docs";
  return "code";
}

/**
 * Classify a PR's changed-file list into its change shape. Any single `code`
 * path makes the whole diff `code` (a doc and a `src/` file together → code).
 * Callers pass `git diff --no-renames --name-only` so a rename contributes
 * BOTH its old and new path — a `src/` → `test/` move stays `code`.
 */
export function classifyChangeShape(paths: readonly string[]): ChangeShape {
  const kinds = new Set<NonCodeKind>();
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const kind = classifyChangedPath(raw);
    if (kind === "code") return "code";
    kinds.add(kind);
  }
  if (kinds.size === 0) return "code";
  if (kinds.has("prompt")) return "prompt-only";
  if (kinds.has("tests")) return "tests-only";
  return "docs-only";
}

// ---------------------------------------------------------------------------
// Declared shape — the `Merge danger:` PR-body field (issue #5258, S2 of #5255;
// ADR-0046 D5). Pure, no fs/network. The dev declares whether the PR is a
// one-way door; the S1 detector (src/qa/one-way-door.ts) observes it; the
// comparison is ESCALATE-ONLY: nothing here can lower depth below either call.
// ---------------------------------------------------------------------------

export interface MergeDangerField {
  status: "ok" | "missing" | "malformed";
  declared: "one-way" | "two-way" | null;
  /** The raw matched line (trimmed), or null when missing. */
  raw: string | null;
  /** Free-text reason after the value, capped at 200 chars; null when absent. */
  reason: string | null;
}

const MERGE_DANGER_LINE = /^Merge danger:[ \t]+(one-way|two-way)\b[ \t]*(?:[—-]\s*)?(.*)$/im;
const MERGE_DANGER_ANY = /^Merge danger:/im;
const MERGE_DANGER_REASON_CAP = 200;

/** Parse the `Merge danger:` line. Total over any input; first well-formed line wins. */
export function parseMergeDangerField(body: string | null | undefined): MergeDangerField {
  if (typeof body !== "string" || body === "") {
    return { status: "missing", declared: null, raw: null, reason: null };
  }
  const m = MERGE_DANGER_LINE.exec(body);
  if (m) {
    const reason = m[2].trim().slice(0, MERGE_DANGER_REASON_CAP);
    return {
      status: "ok",
      declared: m[1].toLowerCase() as "one-way" | "two-way",
      raw: m[0].trim(),
      reason: reason === "" ? null : reason,
    };
  }
  const any = MERGE_DANGER_ANY.exec(body);
  if (any) {
    const line = body.slice(any.index).split(/\r?\n/, 1)[0].trim();
    return { status: "malformed", declared: null, raw: line, reason: null };
  }
  return { status: "missing", declared: null, raw: null, reason: null };
}

export type MergeDangerOutcome =
  | "match"
  | "under-declared"
  | "over-declared"
  | "missing"
  | "malformed"
  | "detector-unknown";

/** Structurally identical to fold.ts `ReviewFinding` (leaf stays free of a fold import). */
export interface MergeDangerFinding {
  severity: "medium" | "low";
  axis: "standards";
  reviewer: "merge-danger-check";
  location: "PR body";
  finding: string;
  fix: string;
}

export interface MergeDangerCheck {
  outcome: MergeDangerOutcome;
  effectiveDoor: "one-way" | "two-way";
  finding: MergeDangerFinding | null;
  gapLine: string | null;
}

export interface MergeDangerDetector {
  door: "one-way" | "two-way" | "unknown";
  classes?: readonly string[];
  signals?: readonly { ruleId: string; class: string | null; path: string; line?: number }[];
}

export interface MergeDangerContext {
  pr?: number | string;
  sha?: string;
}

/** Compare the declared field with the detector's call. Pure, escalate-only. */
export function compareMergeDanger(
  field: MergeDangerField,
  detector: MergeDangerDetector,
  ctx: MergeDangerContext = {},
): MergeDangerCheck {
  if (field.status !== "ok") {
    const what =
      field.status === "missing" ? "no `Merge danger:` line" : `a malformed line \`${field.raw ?? ""}\``;
    return {
      outcome: field.status,
      effectiveDoor: "one-way",
      finding: {
        severity: "low",
        axis: "standards",
        reviewer: "merge-danger-check",
        location: "PR body",
        finding: `PR body has ${what}; depth treated as one-way (fail-closed).`,
        fix: "Add `Merge danger: <one-way|two-way> — <reason>` as its own line near `Tier:`.",
      },
      gapLine: null,
    };
  }
  const declared = field.declared as "one-way" | "two-way";
  if (declared === "two-way" && detector.door === "one-way") {
    const sigs = (detector.signals ?? [])
      .map((s) => `${s.ruleId}/${s.class ?? "-"} ${s.path}${s.line !== undefined ? `:${s.line}` : ""}`)
      .join("; ");
    return {
      outcome: "under-declared",
      effectiveDoor: "one-way",
      finding: {
        severity: "medium",
        axis: "standards",
        reviewer: "merge-danger-check",
        location: "PR body",
        finding: `PR declares \`${field.raw}\` but the one-way-door detector fired: ${sigs || (detector.classes ?? []).join(", ")}.`,
        fix: "Change the line to `Merge danger: one-way (<classes>)` or state in the reason why each signal is a false positive.",
      },
      gapLine: null,
    };
  }
  if (declared === "one-way" && detector.door === "two-way") {
    return {
      outcome: "over-declared",
      effectiveDoor: "one-way",
      finding: null,
      gapLine: `Merge-danger-gap: pr=${ctx.pr ?? "-"} sha=${(ctx.sha ?? "-").slice(0, 12)} declared=one-way detector=two-way reason=${field.reason ?? "-"}`,
    };
  }
  if (declared === "two-way" && detector.door === "unknown") {
    return { outcome: "detector-unknown", effectiveDoor: "one-way", finding: null, gapLine: null };
  }
  return { outcome: "match", effectiveDoor: declared, finding: null, gapLine: null };
}
