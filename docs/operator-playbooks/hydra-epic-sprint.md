---
name: hydra-epic-sprint
description: Operator-attended sprint that drives one designed epic on gaberoo322/hydra to done in-session. Parallel worktree build agents, an independent reviewer per PR, then QA-Override and an auto-merge arm. Skips autopilot pickup, the per-slice grill and formal hydra-qa; never skips CI or branch protection.
when_to_use: "When the operator says 'sprint this epic', 'work epic #N in this session', 'finish this epic faster than autopilot', or wants a filed, designed epic driven to merged in one attended session. Not for a foggy initiative (/hydra-wayfinder) or a single issue (/hydra-dev)."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*) SendMessage(*) AskUserQuestion(*) TaskStop(*)
arguments: [epic]
disable-model-invocation: true
---

# Hydra Epic Sprint — drive one epic to merged, in-session

The autopilot drains an epic one slice at a time. Each slice waits behind class cooldowns, the pace gate, label pickup, a grill and a separate QA dispatch. When the operator is present and the epic is already **designed** (an accepted ADR or design concept answers its design questions), that latency is all waste. This skill replaces the loop with the operator's own session as the orchestrator:

- **build agents** run in parallel, one fresh worktree each;
- an **independent read-only reviewer** checks every PR;
- the operator's standing authorisation stands in for formal hydra-qa, posted as a `QA-Override:` line;
- **CI stays the only merge gate.**

Policy and boundaries: [ADR-0044](../adr/0044-operator-attended-epic-sprint-lane.md). The reference run is epic #4928: 6 slices and 13 PRs merged in about 18h.

## Boundaries (non-negotiable)

**Skipped:**
- autopilot dispatch and label pickup;
- the per-slice `hydra-grill` / design-concept step (the epic's ADR is the design);
- the separate `hydra-qa` dispatch.

**Never skipped:**
- every required CI check and branch protection;
- worktree isolation, feature branches, normal pushes (no force-push, no rewritten history, no direct master push, no admin merge);
- the QA merge guard inside the override recipe;
- the tier ladder. A **T4 / Verifier Core** PR leaves this lane for Deep-QA.

If a required gate is red for a reason the PR can't fix, restructure the PR (see the >300-file split below) or stop and ask. Never bypass the gate.

## When NOT to run this

- **The design is still open.** If the epic has no accepted ADR or design concept, slices make design calls nobody reviewed. Send the operator to `/hydra-wayfinder` or `/hydra-grill` first.
- **The operator isn't staying.** This lane runs on standing in-session authorisation; unattended work belongs to `hydra-autopilot`.
- **The weekly quota is nearly spent.** Each build round costs roughly 200–460k sub-agent tokens and each review 150–200k (#4928 figures). Show the estimate in Step 1.

## Step 0 — Preflight

```bash
EPIC=<N>                                      # the epic issue number
cd ~/hydra && git remote get-url origin      # must print https://github.com/gaberoo322/hydra.git
gh issue view "$EPIC" --repo gaberoo322/hydra --json title,body,state
gh api "repos/gaberoo322/hydra/issues/$EPIC/sub_issues" --jq '.[] | "\(.number) \(.state) \(.title)"'
curl -s localhost:4000/api/autopilot/paused
```

- If the origin URL is wrong, **stop**. An unknown process has rewritten it before (#4939). Push and fetch by **explicit URL** for the whole session:
  - `git push https://github.com/gaberoo322/hydra.git HEAD:<branch>`
  - `git fetch https://github.com/gaberoo322/hydra.git +refs/heads/master:refs/remotes/origin/master`
- Read the epic's ADR and every sub-issue (`## Files in scope`, `Blocked by`, acceptance criteria).
- **Pause the autopilot for the sprint** (`curl -s -X POST localhost:4000/api/autopilot/paused -H 'content-type: application/json' -d '{"paused":true}'`), unless the operator chooses to keep it live. Claiming a slice with `in-progress` doesn't keep the autopilot off it. `board-state` treats an `in-progress` issue with no open PR as stale after 90 minutes, and `recover-stale.sh` puts it back to `ready-for-agent`, so `dev_orch` would double-dispatch a slice that is waiting its turn. If the autopilot stays live, claim a slice only when its build agent is dispatched, leave `blocked` labels alone, and accept that 90-minute window.
- `~/hydra` must be on `master` (`git -C ~/hydra rev-parse --abbrev-ref HEAD`), because the QA-Override recipe loads the merge guard and line renderer from that checkout. If it isn't, run the recipe from a fresh `origin/master` worktree.

## Step 1 — Map the epic, then confirm once

Build the plan and present it in ONE `AskUserQuestion`: approve, edit, or abort.

1. **Merge order** from `Blocked by` plus the slice numbering.
2. **Shared seams.** List every file or new module that two or more slices will touch: ports, registries, a shared client, ratchet constants, baselines.
   - #4928 lost most of its time when four parallel slices each wrote their own copy of one new module (`hydra-http.ts`), forcing a reconcile round on every merge.
   - Rule: land a new shared module **first** (its own PR, or the first slice), or name **one owner slice** that every other slice adopts.
   - Slices may run in parallel only where their seams are already on master.
3. **Stacking.** A slice that needs an unmerged sibling builds on that sibling's branch and merges master in after the sibling lands. Always merge, never rebase, so normal pushes keep working.
4. **Risky surfaces.** A slice that changes what `decide.py` reads or decides is split into **expand / contract** PRs:
   - expand: new path plus the old path as fallback;
   - contract: delete the old path once expand is proven.
   Both gate on a **plan-parity corpus**: every distinct `decide()` input captured from the decide test files must give an identical Plan on both paths. Add a mutation check: point one read back at the old path and confirm divergence.
5. **Cost estimate:** slices × (build + review), using the token figures above.

## Step 2 — Write the shared slice contract

Write one rules file to the scratchpad. Every build agent reads it first, which keeps prompts short and identical. It covers:

- **Read-first list:** `CLAUDE.md` Pitfalls, the ADR, the slice issue, and the template slice once one has merged.
- **Git safety:** the explicit-URL push and fetch above; check the origin URL before every fetch.
- **Worktree recipe:** `git worktree add -b <branch> .claude/worktrees/<dir> <base>`. ABORT rather than fall back to `~/hydra`. Commit early, because the hourly prune reaps uncommitted hand-made worktrees.
- **The slice's design rules,** distilled from the ADR.
- **Shared-file etiquette:** additive, localized edits only. Append, don't reorder.
- **Repo chores:**
  - changelog fragment `.changelog/<N>-<slug>.md`;
  - regenerate the suite-count baseline when the test-file set changes, the test-subject baseline when the sprawl guard asks, and `npm run docs:inventories`;
  - ratchet constants set to the real count;
  - pins written as ceilings (`<=`), never exact equality, so sibling slices don't conflict.
- **PR body:**
  - `Tier:` from `GET /api/tier?files=…`;
  - `Closes #N` (or `Part of #N` for a multi-PR slice);
  - `## Files in scope` as plain paths with no code spans;
  - `scope-justification:` lines and a `Decisions taken` section;
  - ends with the Claude Code footer.
- **Verification, all in the foreground:** touched tests, full `npm test`, `typecheck`, `typecheck:test`, and the fail-loud lint.
- **Rules for the agent:** no merging, no CI polling, no relabelling, no nested sub-agents. Report the PR URL, head SHA, verification results and decisions.

## Step 3 — Dispatch build agents

Launch one `Agent` (general-purpose, background) per ready slice, in a single message so they run concurrently. The prompt is: the rules file path, the slice issue number, the base branch, and anything slice-specific (stacking, seam owner). Keep each agent's ID: fixes and reconciles go back to the **same** agent via `SendMessage`, so its context is reused.

## Step 4 — Independent review per PR

When a build agent reports, launch a separate read-only reviewer agent. Its prompt template:

> Independent READ-ONLY reviewer for PR #N (<title>, implements #I under ADR-X). No `gh pr checkout`, no pushes, edits, comments or sub-agents. Inspect with `gh pr view/diff` and the slice's worktree; run tests and scripts only into scratch, and never dispatch, un-pause or POST to the live service.
>
> SPEC: re-verify the evidence yourself rather than trusting the PR body: replay goldens or parity against the OLD code, run mutation checks, and walk 2–3 nontrivial pieces line by line against what they replace. Judge each `Decisions taken` item.
>
> STANDARDS: `CLAUDE.md` conventions, test quality (interface, not source text), shell correctness, and stale references to anything deleted.
>
> Report a findings table (severity, file:line, finding + failure scenario, fix) and a verdict: PASS if there is no blocker or medium, otherwise FAIL. Keep it under 900 words.

- **FAIL**, or lows worth fixing: send the findings to the build agent with explicit numbered fixes, then re-check the delta. Re-review in full only if the fix changed behaviour.
- After a **reconcile** (master merged into the slice), review the reconcile delta. A full re-review is needed when shared code changed meaning.

## Step 5 — Override and arm

**Read the guard first.** Run `node --experimental-strip-types scripts/ci/qa-merge-guard.ts --pr <N> --repo gaberoo322/hydra` and check its `reason`:
- **`not-reviewed`, `stale-verdict`, `verdict-at-head` or `exempt`:** proceed.
- **`verdict-fail`:** **stop and ask the operator.** Overriding a recorded QA FAIL is always a per-PR choice, and the sprint's blanket authorisation never covers it.
- **`fetch-failed`:** retry; never override blind.

The operator's sprint authorisation is the override choice for the cases above. Run `/hydra-review`'s **QA-Override recipe** (the `# >>> qa-override` block in `docs/operator-playbooks/hydra-review.md`) from `~/hydra`, using its `--auto` arm variant, which is head-pinned. That recipe re-runs the QA merge guard and posts the `QA-Override:` line that `npm run qa:catch-rate` counts.

The reason should be self-contained, for example:

> In-session fast lane (operator-authorised, epic #E). Independent reviewer PASS at <sha>: <evidence>. Lows: <fixed / deferred to #F>.

**Enrol the Outcome Holdback** exactly as the autopilot's `auto-merge` handler does: `curl -s -X POST localhost:4000/api/holdback/pending -H 'content-type: application/json' -d '{"prNumber":<N>,"tier":<T>,"cycleId":"epic-sprint-<EPIC>"}'`. The merge watcher enrols it when the PR lands. Without this call, sprint merges skip the regression watch that ADR-0015 requires.

Then start a background watcher. It checks every 90s and exits on `MERGED`, `DIRTY`, any `gh pr checks --required` line marked `fail`, or `autoMergeRequest` becoming null (a head-pinned arm drops when the head moves). `advisory-checks` is ambient red on master; read only the required checks.

## Step 6 — After each merge

1. Confirm the issue closed. A `Closes #N` that didn't fire gets a manual `gh issue close` with the PR reference.
2. Message every agent stacked on or touching the merged slice:
   - merge master in (explicit-URL fetch, `git merge`, no rebase);
   - adopt the landed shared seam, re-delete anything the squash re-added;
   - set the ratchets to their real counts;
   - re-run tests;
   - **re-arm:** the new head drops the head-pinned arm, so re-check the delta (Step 4) and re-run Step 5 at the new head;
   - update the PR body with `gh api -X PATCH repos/gaberoo322/hydra/pulls/<N> -F body=@file` **before** the final push. `design-concept-reconcile` reads the body as it was at push time, and `gh pr edit` is unreliable here.
3. Send the next slice in the merge order through Steps 4–5.

## Gate hazards seen live

- **More than 300 changed files:** the required `deep-qa-gate` gets HTTP 406 from the diff API and can never pass. Check `git diff --name-only origin/master...HEAD | wc -l` before opening a PR. If it's too big, keep the PR's logic changes, revert bulk generated or fixture rewrites to master (have the tests tolerate the old content for now), and land the bulk rewrite as stacked follow-up PRs of ≤250 files each.
- **Transient `ERR_MODULE_NOT_FOUND`** (for example `zod`) mid-run: the deploy's `npm ci` rewrote `~/hydra/node_modules` under the worktree. Re-run; it's not a regression.

## Step 7 — Close out

1. After the last merge settles, check `curl -s localhost:4000/api/health` for `deployedSha` vs `originMasterSha`. If they still differ once CI is idle, run `bash scripts/deploy.sh` once.
2. Live-check the shipped behaviour on the deployed code, read-only or plan-only.
3. File follow-ups for every deferred low or newly found bug (`needs-triage`, with a `## Files in scope` section).
4. Close the epic with a comment mapping each slice to its PR, the outcome and the follow-ups.
5. Remove the merged sprint worktrees (only clean ones), stop the watchers, and resume the autopilot if Step 0 paused it (`-d '{"paused":false}'`).
6. Report to the operator: merged PRs, what changed, what cost time, the follow-ups, and anything that needs them.

## Rules

- One `AskUserQuestion`, at Step 1. After that, ask again only for a genuine blocker: a T4 slice, a gate that can't be fixed in-PR, a design question the ADR doesn't answer, a scope conflict, or quota exhaustion.
- Never claim a review, CI result or merge that a tool result didn't show. Report failures with their output.
- A reviewer never edits, and a build agent never merges.
