/**
 * src/glm/prompt.ts — the GLM dev-drainer's authoring-prompt composer
 * (issue #4688, ADR-0040 Decision 1; epic #4681).
 *
 * A pure port of `scripts/glm/drainer-loop.sh`'s `compose_prompt()`: no I/O,
 * never throws, and its output is byte-identical to the bash function for the
 * same inputs — including the awk scope extractor's quirk (below). Phase
 * slices move logic, they do not change behaviour (ADR-0040 Decision 6).
 *
 * The prompt is what the headless GLM `hydra-dev` session reads: the
 * permission-fence disclosure (it cannot `gh pr create`; the loop opens the PR
 * from `.glm-drainer-pr-body.md`), the scope contract, the issue's own scope
 * section(s), and — only on a resume dispatch (issue #4337 INV-5) — a RESUME
 * paragraph telling the fresh session to continue the prior session's pushed
 * commits instead of redoing them.
 */

const SCOPE_HEADING = /^##[\t\n\v\f\r ]*Files (in|out of) scope/;
const SCOPE_IN = /^##[\t\n\v\f\r ]*Files in scope/;
const SCOPE_OUT = /^##[\t\n\v\f\r ]*Files out of scope/;
const ANY_H2 = /^##[\t\n\v\f\r ]/;

/**
 * Extract the `## Files in scope` / `## Files out of scope` section(s) from an
 * issue body — a faithful port of the bash awk program:
 *
 *   on && /^##[[:space:]]/ && !/Files (in|out of) scope/ && ++seen>1 {on=0}
 *
 * QUIRK (pinned by test/glm-prompt.test.mts, deliberately preserved): `seen`
 * counts non-scope `##` headings met while a scope block is open, and the
 * block closes only on the SECOND one — so the first non-scope `##` section
 * that follows the scope block(s) is emitted too (e.g. `## Blocked by`). The
 * harmless extra section is the existing behaviour; fixing it is a separate
 * change.
 *
 * Trailing newlines are trimmed, as bash `$(...)` command substitution does.
 */
export function extractScopeSections(issueBody: string): string {
  const out: string[] = [];
  let on = false;
  let seen = 0;
  for (const line of String(issueBody ?? "").split("\n")) {
    if (SCOPE_IN.test(line)) on = true;
    if (SCOPE_OUT.test(line)) on = true;
    if (on && ANY_H2.test(line) && !SCOPE_HEADING.test(line) && ++seen > 1) {
      on = false;
    }
    if (on) out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

/**
 * The RESUME paragraph — present iff a resumable branch was handed in.
 * `resumeCommits` of `null`/`""`/`undefined` renders as "at least one".
 */
function resumeParagraph(resumeBranch: string, resumeCommits: string): string {
  if (resumeBranch === "") return "";
  const commits = resumeCommits === "" ? "at least one" : resumeCommits;
  return `
## RESUME — a prior drainer session on this issue was cut off by the timeout

A prior GLM drainer session was cut off by the drainer's 50-minute timeout
after committing and pushing ${commits} commit(s) on this
very branch (${resumeBranch}), and no PR was opened for it. You are resuming
that work. Before writing any code:

1. Run git log origin/master..HEAD and git diff origin/master...HEAD FIRST to
   see exactly what the prior session already did on this branch.
2. Do NOT redo committed work — verify it, then continue from where it
   stopped.
3. Write the .glm-drainer-pr-body.md file FIRST, before touching code: the
   previous copy was lost when the prior worktree was removed, and it is the
   ONLY way your PR description reaches the opened PR.
4. Commit and push to THIS branch (the same one) when done.`;
}

/**
 * Compose the authoring prompt. `resumeBranch` is non-empty only on a RESUME
 * dispatch; `resumeCommits` is that branch's commit count (empty/null renders
 * "at least one"). Pure; never throws.
 */
export function composePrompt(
  issue: number | string,
  issueBody: string,
  resumeBranch?: string | null,
  resumeCommits?: number | string | null,
): string {
  const scopeSection = extractScopeSections(issueBody);
  const resume = resumeParagraph(
    resumeBranch ?? "",
    resumeCommits === null || resumeCommits === undefined ? "" : String(resumeCommits),
  );
  return `/hydra-dev ${issue}

---

${resume}

GLM dev-drainer session (issue #3689, ADR-0032). Read this before doing
anything else — it changes two things about how this dispatch normally ends.

1. You are the CHILD in hydra-dev's parent/child split
   (docs/operator-playbooks/hydra-dev.md): you were placed directly into this
   worktree, you have NO Agent/Task spawn tool, and the issue's
   ready-for-agent -> in-progress label swap has ALREADY been done for you.
   Do NOT re-select or re-label the issue.

2. This session runs under a permission-fenced --settings file
   (config/glm/drainer-settings.json) that deliberately does NOT grant
   \`gh pr create\` — a supervising loop opens the PR for you, AFTER an
   additional secret-scan + Verifier-Core/tier preflight on your diff. If a
   \`gh pr create\` call is denied, that is EXPECTED, not a bug: do not treat
   it as a failure and do not abandon the work because of it.

3. Because the loop (not you) opens the PR, you MUST write your complete
   intended PR body to the file \`.glm-drainer-pr-body.md\` at the root of
   this worktree (via the Write tool) BEFORE attempting \`gh pr create\`, and
   again if you revise it. This is the ONLY way your PR description reaches
   the opened PR — nothing you pass as an argument to a denied
   \`gh pr create\` call is recoverable. Write it as soon as you reasonably
   can, not only at the very end, in case the session is cut short.

   \`.glm-drainer-pr-body.md\` MUST include, in this order:
     a. A short summary of what you built and why.
     b. A \`## Design-concept reconciliation\` section (top-level \`##\`
        heading, never nested under \`## Files in scope\`) if a
        design-concept artifact was fetched for this anchor — one
        \`INV-<n>\` bullet per invariant with a verifiable \`verified by:\`
        assertion, per the child-flow contract's reconciliation gate. Omit
        this section entirely if no artifact was fetched (404).
     c. A \`## Files in scope\` section that mirrors the issue's own section
        below, byte-for-byte.
     d. A \`## Friction Report\` section (always, even on clean success).

4. Commit AND PUSH your branch yourself (\`git push\` IS granted in this
   session's settings) — the loop reads your pushed commits to build the
   diff it preflights. Do not skip the push just because \`gh pr create\` is
   denied.

## SCOPE CONTRACT — issue body is authoritative

The linked issue contains a \`## Files in scope\` section (mandatory) and may
contain a \`## Files out of scope\` section. Before writing any code:

1. Extract both lists from the issue body.
2. Treat \`Files in scope\` as the SOFT boundary — every file you change
   should match one of these entries (substring/prefix match, so \`src/foo/\`
   covers everything beneath).
3. Treat \`Files out of scope\` as the HARD boundary — touching anything
   matching these entries will fail CI's scope-check gate. Do not touch them
   unless absolutely required.
4. If you DO have to touch an out-of-scope file, include a
   \`scope-justification:\` block in \`.glm-drainer-pr-body.md\` listing each
   affected file with a one-line rationale.
5. Mirror the issue's \`## Files in scope\` section into
   \`.glm-drainer-pr-body.md\` so the gate can match against either source
   (also required by point 3c above).
6. CODE-SPAN TRAP: the scope-check parser treats EVERY backticked code-span
   inside the \`Files in scope\` / \`Files out of scope\` sections as a scope
   entry, not just the bullet paths. Keep non-path filenames in prose
   PLAIN-TEXT.

The CI \`scope-check\` job at \`.github/workflows/ci.yml\` enforces this
contract.

For reference, the issue's own scope section(s):

${scopeSection}
`;
}
