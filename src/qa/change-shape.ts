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
