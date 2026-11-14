/**
 * src/qa/pr-head.ts — make a PR's head commit resolvable in the local object
 * store WITHOUT moving the worktree (issue #5520).
 *
 * The hydra-qa plumbing scripts (`scripts/qa/preflight.ts`, `packet.ts`) used to
 * diff against the literal `HEAD`, i.e. whatever the QA worktree happened to
 * have checked out (master) — an empty diff for the PR under review. They now
 * build everything from `pr.headSha`; this helper guarantees that sha exists
 * locally. It only fetches objects (`git fetch origin refs/pull/<N>/head`) and
 * proves the sha resolves (`git cat-file -e`); it never checks out, switches,
 * resets or touches a worktree (the dispatch forbids `gh pr checkout`).
 *
 * Returns a result object, never throws (STD-VERIFY-NEVER-THROW); callers
 * translate the failure arm into their existing pre-verdict exit-1 path.
 */

/** The one outward call this helper needs: `git <argv>` in the process cwd. */
export type PrHeadGit = (
  argv: string[],
) => Promise<{ ok: true; stdout: string; stderr?: string } | { ok: false; stderr: string; stdout?: string }>;

/** Flat, not a discriminated union: the repo tsconfig is non-strict so `ok` would not narrow. */
export interface EnsurePrHeadResult {
  ok: boolean;
  headSha: string;
  /** Why the head is unusable; "" when ok. */
  reason: string;
}

export async function ensurePrHead(
  git: PrHeadGit,
  prNumber: number,
  headSha: string,
): Promise<EnsurePrHeadResult> {
  if (headSha.trim() === "") {
    return { ok: false, headSha, reason: `PR #${prNumber} has no head sha (gh pr view returned an empty headRefOid)` };
  }
  const fetched = await git(["fetch", "origin", `refs/pull/${prNumber}/head`]);
  if (!fetched.ok) {
    console.error(`[qa-pr-head] fetch of refs/pull/${prNumber}/head failed:`, String(fetched.stderr).slice(0, 300));
    // Fall through: the object may already be present locally; cat-file is the proof.
  }
  const proof = await git(["cat-file", "-e", `${headSha}^{commit}`]);
  if (!proof.ok) {
    return {
      ok: false,
      headSha,
      reason: `PR #${prNumber} head ${headSha.slice(0, 12)} is not resolvable locally (force-pushed or closed since preflight, or the fetch failed): ${String(proof.stderr).slice(0, 200)}`,
    };
  }
  return { ok: true, headSha, reason: "" };
}
