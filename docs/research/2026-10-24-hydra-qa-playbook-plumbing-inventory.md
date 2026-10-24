# Which parts of the hydra-qa playbook are deterministic plumbing?

**Asset for wayfinder ticket [#5187](https://github.com/gaberoo322/hydra/issues/5187)** (map [#5182](https://github.com/gaberoo322/hydra/issues/5182), two-pass code factory). A fact document: an inventory and an estimate, no design decision. All numbers are measured against `origin/master` at `676429150` (`docs/operator-playbooks/hydra-qa.md`, 1,675 lines, 16,724 words by `wc -w`).

## Headline

- **About 55% of the playbook (about 9.2k of 16.7k words) is deterministic plumbing; about 28% (about 4.7k) is judgement; about 17% (about 2.8k) is reference.** Fenced bash alone is 5,805 words (35%); the rest of the plumbing is the prose that annotates that bash (INV tags, label rationale, issue-number history).
- **Moving plumbing behind scripts with a JSON contract, and reference into sidecars, would cut the loaded playbook from 16.7k to roughly 6k to 7k words (about 60%).** Plumbing leaves, minus a stub of about 1.5k words that says "run X, read this JSON, branch on this field"; reference leaves for on-demand loading. Treat the figures as plus or minus 15%: the split is by section with a few sections divided by line range.
- **Most of the decision logic is already in TypeScript.** `scripts/ci/qa-verdict.ts` (2,123 lines) already holds `classifyVerdict`, `decideReviewAdmission`, `decideReviewerFanout`, `foldReviewFindings`, `buildQaVerdictTrailer`, `decideQaRoundAction`, `decideDeepQaAction`, `decideReReviewContext`. The playbook is mostly shell glue that feeds these functions through `node -e "import(...)"` one-liners and then performs the label and comment side effects. That is the same shape the autopilot had before `turn.sh` / `render-dispatch.py` (#4827 to #4834).
- **Who pays: the parent `qa_orch` session, not the reviewers.** The Standards and Spec sub-agents already receive a pre-built review packet and a prompt, and never load this playbook. The playbook's cost is the parent's context, carried through the whole fan-out.
- **Verifier Core exposure is small and specific** (section below): no playbook section is itself in Verifier Core, but `.github/workflows/deep-qa-gate.yml` (T4) imports `hasFreshDeepQaPass` from `scripts/ci/qa-verdict.ts`, so that file's gate exports are a frozen contract for any refactor.

## Method

Classified every `##` / `###` section of the file into one of three buckets, then counted words with `awk`, splitting fenced code from prose (`/^```/` toggle).

| Bucket | Test | Fate |
|---|---|---|
| **Judgement** | The QA session must read it to decide or to brief a reviewer: reviewer prompts, the refutation framing, the smell battery, the findings contract, the T4 checklist, "never end a turn" discipline, lesson-cause choice | stays in the playbook |
| **Plumbing** | A fixed input to fixed output transformation, or a side effect (label, comment, `gh` call) whose branch condition is already computed by a TS helper | becomes a script with a JSON contract; the playbook keeps a stub |
| **Reference** | True and sometimes needed, but not read on every run: tier tables, invariants, rationale, the holdback watch, the slot-lifecycle hook | sidecar, loaded on demand |

Section-level counts below sum to the file total. Where a section mixes buckets, the split uses fenced-vs-prose or a line range and is marked `~`.

## Section inventory

| Section (lines) | Words | Bucket | Note |
|---|---:|---|---|
| Preface, blocking-dispatch mandate, never-end notice (1-57) | 679 | Judgement | The `run_in_background: false` mandate and the no-waiting rule must be read top-down |
| Tier-aware verification depth (58-69) | 329 | Reference | Policy prose; the executable form is `decideReviewerFanout` / `classifyVerdict` |
| Severity-gated fold T1-T3 (70-81) | 245 | Reference | Describes `foldReviewFindings` (#4734) |
| Convergent review T1-T3 (82-89) | 249 | Reference | Describes `decideReReviewContext` / round cap (#4735) |
| T4 Verifier-Core checklist + remediation loop (90-107) | 531 | Judgement | The T4 reviewer brief; keep |
| `deep-qa-gate` StatusContext vs CheckRun (108-116) | 350 | Reference | Operator rationale (#868) |
| Phase A shadow mode (117-127) | 171 | Reference | |
| Verdict tiers (128-142) | 315 | Reference | Glossary of `PASS` / `FAIL` / `-pending-CI` |
| Never end a turn on a pending wait (143-192) | 422 | Judgement ~272, plumbing ~148 | The 148 fenced words are a bounded poll loop: `poll-pr.sh` |
| 1. Select issue; 2. Find linked PR (195-217) | 84 | Plumbing | |
| 3. Pin the fixed point (218-277) | 514 | Plumbing | 463 fenced: `gh pr view`, GLM provenance, `qa_bounce_label`, `git fetch` |
| 4. Resolve the spec source (278-399) | 865 | Plumbing | 691 fenced: `/api/design-concepts/resolve`, exemption-label fallbacks. Output is `$SPEC_INPUT_JSON` or `$SPEC_SKIPPED_REASON` |
| 5. Collect CI state (400-438) | 345 | Plumbing | Already half-scripted via `@include _fragments/checks-fetch.md` and `buildCheckStates` |
| 6. Tier-1 auto-bypass (439-457) | 163 | Plumbing | |
| 6.5 Resolve Modification Tier (458-481) | 158 | Plumbing | Calls `scripts/tier-classify.ts` |
| 6.6 Reviewer admission gate (482-701) | 1,837 | Plumbing ~1,547, reference ~290 | The gate is `decideReviewAdmission`; what remains is bash that calls it, fails closed, and posts the defer or skip bounce. The INV-A..INV-G definitions are reference |
| 6.7 Size the fan-out (702-733) | 253 | Plumbing | `decideReviewerFanout` already decides; this is the call |
| 7 intro + 7a/7b/7c + reviewer briefs (734-739, 893-968) | 1,775 | Judgement | Refutation framing, findings contract with severity rubric, Standards brief, twelve-smell battery, Spec brief. This is the review itself |
| 7.0 / 7.0a packet builder + re-review context (740-892) | 1,205 | Plumbing ~855, judgement ~350 | The packet loop and the `rereview-context` block are plumbing; the "packet discipline, no exploratory tool loop" wording is judgement |
| 7.5 Verify every reviewer returned (969-994) | 394 | Judgement | The incomplete-fan-out rule. The check itself is trivial and could be scripted later, but the decision to refuse a verdict stays with the session |
| 8. Aggregate (995-998) | 438 | Judgement | Transcribe reviewers' findings verbatim |
| 9. Classify the verdict (999-1073) | 745 | Plumbing | The `severity-fold` block is `foldReviewFindings` + `classifyVerdict` |
| 9.5 Render the `QA-Verdict:` trailer (1074-1134) | 627 | Plumbing | `buildQaVerdictTrailer` |
| 10. Verdict routing (1135-1466) | 2,517 | Plumbing | 2,009 fenced. PASS, T1-T3 FAIL, T4 1st/2nd FAIL, round cap, disarm auto-merge, the `qa-merge-guard.ts` call, label swaps, comments. Every branch condition is already a TS return value |
| 11. Lesson capture on FAIL (1467-1522) | 333 | Judgement ~226, plumbing ~107 | Choosing which criterion failed is judgement; the `curl` per criterion is plumbing |
| Post-merge regression check: intro, A (1523-1572) | 456 | Reference | A is explicitly "owned by the autopilot, NOT hydra-qa" (#2055) |
| Post-merge regression check: B, the watch (1573-1621) | 310 | Plumbing | 259 fenced |
| Invariants (1622-1654) | 281 | Reference | |
| Slot lifecycle PostToolUse hook (1655-1675) | 131 | Reference | |

Bucket totals (sum of the rows, with the split sections apportioned):

| Bucket | Words | Share |
|---|---:|---:|
| Judgement | about 4,665 | 28% |
| Deterministic plumbing | about 9,242 | 55% |
| Reference | about 2,817 | 17% |

## Candidate script boundaries

Five contracts cover essentially all of the plumbing. Names are illustrative; this ticket does not decide the design.

1. **`qa-preflight`** (steps 1-6.7: about 4.3k words). Input: issue or PR number. Output JSON: `fixed_sha`, `pr_tier`, `checks_json`, `merge_state`, `glm_authored`, `spec` (`found` / `skipped_reason` / artifact), `tier1_bypass`, `gate` (`admit` | `defer` | `skip-required-failed` plus reason), `fanout_mode`, `red_required`. The defer and skip-required-failed branches already end in a fixed bounce, so the script can perform it and exit with a code the playbook branches on, as `turn.sh` does.
2. **`qa-packet`** (7.0 / 7.0a: about 855 words). Output: the review packet file path, including the re-review context. Pure read.
3. **`qa-fold`** (steps 9 and 9.5: about 1.4k words). Input: the transcribed per-reviewer findings file. Output: `verdict`, `reason`, `max_severity`, `blockers`, `worst_finding`, `findings_table`, `trailer`.
4. **`qa-route`** (step 10 and the step-6.6 bounce: about 2.5k words). Input: the `qa-fold` JSON plus the report. Performs the label and comment effects, the T4 marker, the round cap and the merge-guard-gated merge. Output: the action taken. This is the largest single removal and the one that must keep "merge only on `qa-merge-guard` exit 0" visible.
5. **`poll-pr`** (the bounded foreground poll: about 150 words, plus the matching prose). Shared with other skills that carry the same loop.

The existing precedent for the whole pattern: `scripts/autopilot/turn.sh`, `render-dispatch.py`, `stamp-slot.py`, `qa-verdict-event.sh`, and the `@include _fragments/` mechanism that `sync-skills.sh` resolves (`_fragments/checks-fetch.md` is already one such plumbing fragment inside step 5). A sidecar for the reference bucket would follow the `_fragments/` / reference-sidecar convention used by `hydra-autopilot`.

## Estimated saving

| | Words |
|---|---:|
| Playbook today | 16,724 |
| Plumbing removed | about -9,240 |
| Stubs added ("run X, read field Y, branch") | about +1,500 |
| Reference moved to on-demand sidecar | about -2,820 |
| **Loaded on every run after** | **about 6,100** |
| Net reduction vs today | about 63% (about 7.7k from plumbing alone, 46%) |

Notes on the figure:

- The generated `~/.claude/skills/hydra-qa/SKILL.md` is 17,810 words, because it adds the vendored `_vendor/code-review.md` base (1,087 words) and expands the `@include` fragments. The saving applies to the overlay; the base is unchanged.
- Words are a proxy for tokens. The fenced bash is token-dense (variable names, flags, escaped quotes), so the token saving is likely larger than the word saving.
- The "judgement" bucket is not small. Step 7's reviewer briefs alone are 1.8k words, and the T4 checklist and findings contract are load-bearing. The floor for an unscripted playbook is about 4.7k words; the estimate above includes the stubs and the always-read preface on top of that.

## Where a move would touch Verifier Core

Verifier Core is the list in `src/untouchable.ts` (`VERIFIER_CORE_PATHS`): `ci.yml`, `deploy.yml`, `deep-qa-gate.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`. Measured with `scripts/tier-classify.ts`: `docs/operator-playbooks/hydra-qa.md` is **T3**, `scripts/ci/qa-verdict.ts` is **T3**, `scripts/ci/qa-merge-guard.ts` is **T3**. A new `scripts/qa/*` is T3 by default. Nothing in the proposed moves forces a T4 PR on its own. Flagged sections:

1. **Step 10, T4 PASS marker (the `renderDeepQaPassMarker` post) and the T4 FAIL marker.** The `deep-qa-gate` required check (`.github/workflows/deep-qa-gate.yml`, lines 170-200) runs `import('./scripts/ci/qa-verdict.ts')` and calls `hasFreshDeepQaPass(comments, HEAD_SHA)`. Its `pull_request` arm runs the PR-head copy of the workflow. So `DEEP_QA_PASS_MARKER`, `DEEP_QA_FAIL_MARKER`, `renderDeepQaPassMarker`, `hasFreshDeepQaPass` and `decideDeepQaAction` in `qa-verdict.ts` are a frozen contract: a script that wraps them is fine, but moving, renaming or re-exporting them changes what the gate imports. Leave them where they are and have `qa-route` import them rather than copy the literals. The playbook text that posts the marker is not itself gated, but changing *when* it posts changes the T4 depth guarantee, so that edit should be reviewed as if it were T4.
2. **Step 10, the merge call and `qa-merge-guard.ts`.** The playbook calls the guard and merges only on exit 0; `test/qa-merge-guard-callsites.test.mts` pins the call sites by `# >>>` / `# <<<` markers and by `@include _fragments/checks-fetch.md`. Hiding the merge behind `qa-route` removes the call site those tests search for, so the test has to move with it. This is a weakening risk if the test is simply deleted.
3. **Step 6.6, INV-B and INV-E (T3/T4 depth is never cut; unknowns fail closed to full review).** These properties live in `decideReviewAdmission` and in the bash `.catch()` / empty-action fallbacks. A script that swallows an error and returns `admit` preserves them; one that returns a bare exit code and lets the playbook default could invert them. The fail-closed branches must move with the gate, not be dropped as boilerplate.
4. **Step 6.5 tier resolution** calls `scripts/tier-classify.ts` (Verifier Core). Calling it from a script is fine; modifying it is T4.

Tests that read the playbook text and constrain a restructure (all in `test/`): `hydra-qa-prompt-verdict.test.mts`, `hydra-qa-needs-qa-clear.test.mts`, `qa-merge-guard-callsites.test.mts`, `verifier-core-docs-drift.test.mts`, `autopilot-qa-orch-forbidden-ending-preamble.test.mts`, `skill-size-ratchet.test.mts` (baseline must be re-ratcheted downward). Any move is also a `sync-skills.sh` regeneration, so the generated skill and the playbook change together.

## Open questions this inventory does not settle

- Whether the stub-plus-script form degrades the QA session's behaviour. The autopilot precedent suggests not, but no eval exists for `hydra-qa`; the `promptfoo` lane (`evals/`) is the place to A/B it.
- Whether `qa-route` should perform side effects itself or print a plan the session executes (the `decide.py` / plan split). The second keeps `gh` mutations visible in the transcript at the cost of the stub growing.
- The interaction with sibling ticket [#5183](https://github.com/gaberoo322/hydra/issues/5183): its finding that PR-body Files-in-scope drift and ratchet-baseline regeneration are deterministic-check candidates suggests a `qa-preflight` check could absorb them too.

## Sources

- `docs/operator-playbooks/hydra-qa.md` at `origin/master` `676429150` (section line ranges above).
- `scripts/ci/qa-verdict.ts`, `scripts/ci/qa-merge-guard.ts`, `.github/workflows/deep-qa-gate.yml` (lines 170-200), `src/untouchable.ts` (`VERIFIER_CORE_PATHS`), `scripts/tier-classify.ts` (run on the files named above).
- `docs/operator-playbooks/_fragments/README.md`, `scripts/autopilot/{turn.sh,render-dispatch.py}` as the precedent.
- Tests: `test/qa-merge-guard-callsites.test.mts`, `test/hydra-qa-prompt-verdict.test.mts`, `test/hydra-qa-needs-qa-clear.test.mts`.
