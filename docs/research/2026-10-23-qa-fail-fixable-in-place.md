# Which QA FAIL findings could the reviewer have fixed in place?

**Asset for wayfinder ticket [#5183](https://github.com/gaberoo322/hydra/issues/5183)** (map [#5182](https://github.com/gaberoo322/hydra/issues/5182), two-pass code factory). This is a **fact** document: it classifies recent QA FAIL findings and estimates the counterfactual. It does not decide the reviewer's authority (that is [#5184](https://github.com/gaberoo322/hydra/issues/5184)).

## Headline

- **A reviewer that fixes in place would have removed at most about 36% of FAIL rounds, and only about 8% to 16% on a conservative reading.** Of 86 FAIL rounds after the last QA-severity lever (#4917, 2026-10-06), 7 were pure doc / PR-body / baseline / comment fixes (class A), 14 were fixable by also adding a missing test (A+B), and 31 by also making a small prescribed code edit (A+B+C). The other 55 (64%) had at least one blocker that needed the implementer's design context.
- **Each eliminated FAIL round saves about one dev fix-push and one re-review round.** Of the 175 review rounds in the post-#4917 window, that is 4% / 8% / 18% of rounds across the three readings, and 7 / 14 / 31 of 79 post-FAIL fix pushes.
- **The cheapest and largest "low-severity churn" win is already banked.** All 26 FAIL rounds whose worst finding was `low` happened before #4917 (2026-10-01 to 2026-10-06); none occurred after. Do not count them again as a reviewer-authority saving.
- **FAIL findings are mostly real.** Post-#4917 FAIL rounds are 73 `medium` and 14 `high` by trailer severity, 0 `low` (86 rounds by a loose trailer match, 87 by the strict one). 126 of 243 blocking rows (52%) are behavioural or spec defects, and the `high` findings cluster in a handful of security-fence and dashboard PRs (#5037 alone has 13 `high` rows over 4 rounds). This is not mostly nit-picking.
- **Several "fixable" classes are really deterministic-check candidates, not reviewer-authority candidates**: PR-body Files-in-scope drift (31 rows), ratchet-baseline regeneration (12 rows), and missing-pin test coverage (46 rows). That belongs with [#5192](https://github.com/gaberoo322/hydra/issues/5192) and [#5187](https://github.com/gaberoo322/hydra/issues/5187).

## Method

**Corpus.** All 173 PRs merged to `gaberoo322/hydra` on or after 2026-09-30 (#4751 to #5178; the 09-29 QA levers #4729 to #4738 had landed). 132 of them carry at least one `hydra-qa` verdict comment with a `QA-Verdict:` trailer (256 of 263 QA comments have one; the rest are "review deferred / skipped" notices). 41 PRs have no QA verdict comment; from their titles they are mostly the in-session fast-lane epic PRs (Turn Snapshot, operator-channel, dashboard slices, ADR docs) plus two dependency bumps, which were reviewed in-session rather than through a `hydra-qa` PR comment, so this corpus under-represents that path.

**Round and verdict.** A round is one `QA-Verdict: PASS|FAIL` trailer. "Review rounds" per PR = FAIL rounds + 1 if the PR ever got a PASS (a `PASS-pending-CI` followed by a `PASS` counts once). The verdict, `round=`, `blockers=` and `max_severity=` come from the trailer, not from prose.

**Blocking findings.** For each FAIL round the blocking rows are the `### Findings` table rows with severity `medium`/`high` (or `low` when the round's `max_severity=low`, which only happened before #4917). The `### Follow-ups (non-blocking)` table is excluded. 369 blocking rows across 143 FAIL rounds (8 FAIL rounds have no parsable table; they are excluded from the class counts).

**Classification (single rater, heuristic-assisted, then hand-corrected).** Every blocking row got one class; a *round* takes the class of its hardest row, because a round is only avoidable if **every** blocker is reviewer-fixable.

| Class | Meaning | Examples |
|---|---|---|
| **A: strict in-place** | Local, mechanical, needs no implementer context | stale doc / glossary / comment, PR-body scope list or INV claim, ratchet-baseline regen or revert of unrelated churn, naming, formatting, demote one more export |
| **B: add a test** | Behaviour is already right; a guard / pin / branch has no test (or the pin is vacuous) | "reverting X keeps the suite green", negative pin reads the wrong file, untested branch |
| **C: small prescribed code edit** | One local code change whose fix the finding already spells out; no design choice | add a `[[ -n ]]` guard, `safeDecode`, annotate an intentional fail-open, pass `-L`, drop a literal path from output, remove duplicate helper |
| **D: needs the implementer** | Wrong design, spec / AC miss, cross-module effect, security parser hole, semantics decision, multi-site fix | stream-retention accounting, fence parser bypasses, dedup / ladder semantics, dismiss-contract mismatch across producer and consumer |

Class A is the "mechanical" reading, A+B the "plus tests" reading, A+B+C the "upper bound". **Caveat:** C rows still change behaviour, so a reviewer-authored C fix needs the same verification as any implementer change; treat C as an optimistic ceiling. Judgement calls are visible in the per-round table below so a second rater can re-score them; I did not blind-check inter-rater agreement.

## Re-measurement against the 09-28 baseline

| Metric | 09-28 audit (150 PRs, #4332 to #4727) | This window, all (132 reviewed PRs, merged >= 09-30) | Post-#4917 only (>= 2026-10-06) |
|---|---|---|---|
| Review rounds per reviewed PR | 1.55 | 1.90 (251 rounds) | 1.84 (175 rounds / 95 PRs touched) |
| First-round FAIL | 35% | 52% (68 / 132) | 43% (39 / 91 PRs first reviewed in window) |
| FAIL rounds | 67 | 141 | 86 |
| Low-severity FAIL share | 46 / 67 (69%) | 26 / 141 (18%) | 0 / 86 |
| Medium / high FAIL rounds | real-defect 21, process-gate 13, doc-accuracy 12, standards-nit 9, spec 5, test 5, false 2 (different taxonomy) | about 100 / 17 | 73 / 14 |
| FAIL rounds that repeat an earlier blocker | 17 / 67 (25%) | 38 / 135 (28%) | 31 / 82 (38%) |
| Merged with an unaddressed final FAIL | 7 | 22 | 6 |

Reading it: #4917 did remove the low-severity churn, but rounds per PR and first-FAIL rate **rose** against the 09-28 numbers, and goalpost-moving (the "still / not fixed / carried over" share) did not fall. The corpus is not the same mix: this window is heavy with autopilot/ledger/fence work (T3, behavioural) and light on the doc-only PRs that inflated the cheap PASS count earlier, so do not read the first-FAIL jump as a QA regression without controlling for PR type. The repeat-blocker figure is a text heuristic (regex over "not fixed / still / unchanged / carried over / round-N") and over- or under-counts by a few rounds.

Dev fix cycles: 118 of 141 FAIL rounds with a parsable successor were followed by at least one commit before the next review (79 of 86 post-#4917); 22 FAIL rounds were final (the PR merged anyway by operator override or race). A "dev-resume dispatch" is not recorded one-to-one per push in the PR timeline, so the push count is the proxy.

## Classified outcome

Post-#4917 FAIL rounds (86 by trailer; 82 with a parsable findings table):

| Reading | FAIL rounds removable | Share of 86 | Fix pushes saved (of 79) | Re-review rounds saved (of 175) |
|---|---|---|---|---|
| A strict in-place | 7 | 8% | 7 | 7 (4%) |
| A + B (add a test) | 14 | 16% | 14 | 14 (8%) |
| A + B + C (small prescribed code edit) | 31 | 36% | 31 | 31 (18%) |
| D: needs the implementer | 51 classified, plus 4 unparsable | 64% | n/a | n/a |

Whole window, same method: A 13, A+B 23, A+B+C 55 removable FAIL rounds of 141 (9% / 16% / 39%); the pre-#4917 part includes 26 low-only rounds that #4917 already removed.

Row mix, post-#4917 (243 blocking rows): D 126 (52%), C 46 (19%), B 39 (16%), A 32 (13%). By topic, 46 rows are about test coverage or a pin, 31 are PR-body / artifact-accuracy claims, 24 are docs / comments, 12 are ratchet baselines, and 130 are other (behaviour).

### What the "fixable" rows look like

- **PR-body and artifact accuracy (31 rows, mostly class A).** "Files in scope" omits files the diff touches (#4927, #4980, #5005; #4835 pre-#4917), INV claims in the PR body do not match the diff (#4818, #4844, #4976), the wrong `Closes #N` (#4969 r6, one `high`). These are text edits, but they are also exactly what `scope-check` and `design-concept-reconcile` already police; the cheaper fix is a deterministic Files-in-scope diff-versus-body check, not a reviewer commit. Note the CLAUDE.md trap: `design-concept-reconcile` reads the PR body from the webhook payload captured at push time, so a reviewer that edits a body must follow it with one more push.
- **Ratchet baselines (12 rows).** "Baseline regeneration carries unrelated churn" (#4980, #5017, #4818 r3/r4) and "baseline stale after a new `describe`" (#4844, #4797, both in pre-#4917 low-only rounds). These are `suite-count-check.mjs --update-baseline` runs; the file-set arm already forces some of them. Deterministic, not reviewer-judgement.
- **Missing pin / vacuous pin (39 post-#4917 rows are class B; 46 rows mention tests by keyword).** The most repeated instance is a negative pin that reads one file after the code moved to another (#4818 r2, r3, r4: three rounds on the same defect class, including a sweep). That one is only "fixable in place" if the reviewer is also told to sweep the class, which round 4 had to demand explicitly. Related: [#5036](https://github.com/gaberoo322/hydra/issues/5036) (forward-fix lands without a test for the new guard); a reviewer-authored test addition is the natural home for those.
- **Small prescribed code edits (46 rows, class C).** Missing `-n`/empty guards (#5068), `2>/dev/null |` swallowing a failure without an `intentional:` annotation (#4871, #4860, #4935, #4878; some in pre-#4917 rounds), `decodeURIComponent` without a guard (#4751), `execFileSync` default `maxBuffer` (#4970), secret-in-log redaction patterns (#4980, #5037, #5068), an `-uno` that hides untracked files (#4814). These are the cases where the 09-28 note "the fix is local, mechanical and needs no implementer context" is closest to true, but several (the redaction family, the `-uno` work-loss path) are on money- or safety-adjacent paths where a reviewer-authored fix without an independent second look would be the unreviewed-change pattern the gate exists to prevent.

### What clearly needs the implementer (class D)

- **Security-fence parser work.** #5037 (`git-remote-fence`): four rounds, 13 `high` rows (case-insensitive git section names, quoted-empty values, ANSI-C quoting, nested substitutions, wrapper allowlist). Each fix opened the next hole; this is design iteration, and #4980 (the original fence PR) needed three rounds for the same shape.
- **Accounting / ledger semantics.** #4964 (merge-count window), #5002 (empty-cycle classification), #4882 (supersede rules across ticks), #5017 (back-off ladder stamped at plan time). The finding and its fix are different decisions here (what should a failed launch count as?).
- **Producer / consumer contract changes.** #4973 (strict dismiss route while the only consumer still sends the old body, `high`), #4976 (five rounds of Undo / double-fire semantics), #4963.
- **Spec misses.** AC1/AC2 left unmet (#5134, #4777), spec-listed IDs not honoured (#4844).

### Concentration

Per-PR FAIL counts across the 132 reviewed PRs: 0 FAIL 63, 1 FAIL 28, 2 FAIL 20, 3 FAIL 13, 4 FAIL 5, 5 FAIL 2, 6 FAIL 1. The 8 PRs with 4+ FAILs (#4818, #4844, #4871, #4964, #4969, #4976, #5037, #5069) carry a disproportionate share of rounds, and almost all of their rounds are class D or mixed. Reviewer-fixes-in-place does little for the PRs that cost the most.

## Counterfactual savings

Unit of account: review rounds and fix cycles (what the data supports). Token figures are illustrative; the repo has no per-dispatch token ledger I could read for this window.

| Reading | Review rounds saved | Dev fix cycles saved | Review tokens at 185k each | Net after reviewer's own fix cost (assume 20k to 60k per fix) |
|---|---|---|---|---|
| A strict | 7 | 7 | 1.3M | about 0.9M to 1.2M |
| A + B | 14 | 14 | 2.6M | about 1.8M to 2.3M |
| A + B + C | 31 | 31 | 5.7M | about 3.9M to 5.1M |

- 185k tokens per review is the 09-28 digest-based figure. I did not re-derive it: the live `/api/metrics/cost-by-class` endpoint only exposes a 24h transcript meter in which `hydra-qa` read about 24.6M against 9 posted verdict comments (about 2.7M per comment), a different unit (it counts cache reads, and was recently re-based by #5141), so the two are not comparable. Re-measure the per-review baseline before quoting an absolute figure in an ADR.
- Dev fix-cycle tokens are **not measured**. If a resume dispatch costs 1x to 2x a review (an assumption, not a measurement), the A+B+C total rises to roughly 10M to 16M tokens over the 17-day window; A strict stays near 2M to 4M.
- Savings are upper bounds. They assume the reviewer's in-place commit passes CI first time and needs no re-review of its own, but the reviewer's commit changes the head, so CI reruns and any independent re-check of the reviewer's change is a new cost. They also assume the avoided FAIL would not have been followed by a *different* blocker in the next round; 38 of 135 FAIL rounds (28%) repeated an earlier blocker, which suggests round cascades are driven by unfixed class D problems that in-place fixing would not touch.

## Implications for the map (facts, not decisions)

1. In-place fixing alone, even at its optimistic ceiling, removes roughly one FAIL round in three and one conservative FAIL round in twelve; it will not by itself deliver the "fewer rounds and resumes" goal.
2. About half of the cheap rows (PR-body drift, baselines, pins) are better served by deterministic checks than by reviewer authority; ticket [#5192](https://github.com/gaberoo322/hydra/issues/5192) should price those separately.
3. The expensive PRs are the class D ones (security parser, ledger semantics, cross-module contracts); the lever for those is earlier (design concept, test-quality standard #5189), not a reviewer commit.
4. Any reviewer-commits design needs an answer to "who reviews the reviewer's fix" for class C rows before they are in scope ([#5184](https://github.com/gaberoo322/hydra/issues/5184)); class A and B are the defensible pilot scope.
5. Re-measure first-FAIL by PR type before comparing to the 09-28 baseline; the aggregate is confounded by mix.

## Per-round classification (post-#4917 FAIL rounds with a findings table)

Class is the round's hardest blocker (A strict, B +test, C +local code, D implementer). "Rows" counts blocking rows by row class (S=A, T=B, L=C, I=D). The text is the hardest row, truncated.

| PR / round | Max severity | Round class | Rows | Hardest blocker |
|---|---|---|---|---|
| #4775 r2 | high | C +local | 1L 1T | Step 9 still calls q.foldReviewFindings({ tier, findings, ...(spawned.length > 0 ? { spawnedRev |
| #4814 r1 | medium | D implementer | 1I | release_claim_fallback runs after ANY non-zero run_driver finish and does git worktree remove - |
| #4814 r2 | medium | C +local | 2L | release_claim_fallback's worktree gate uses git status --porcelain -uno, ignoring untracked fil |
| #4814 r3 | medium | C +local | 1T 1L | AC4's own verification grep -cE '...\ |
| #4818 r2 | medium | B +test | 1T | The negative pin "no first-attempt routing channel left to re-arm" (route_model, design_concept |
| #4818 r3 | medium | C +local | 2T 1L | The ADR-0013 ratchet is documented as shrink only, but the PR adds two baseline entries (decide |
| #4818 r4 | high | C +local | 2T 1L | Operator item 3 unmet. The shrink-only ADR-0013 ratchet GREW: master has 1 decide entry (decide |
| #4818 r5 | medium | A strict | 2S | Two moved comments were reworded (dev.py:270, cleanup.py:80) so the code is no longer byte-iden |
| #4871 r2 | medium | D implementer | 2I 1L | HEAD_SHA=$(gh api .../pulls/$PR_NUM ...) runs before PR_NUM is assigned (the assignment is in t |
| #4871 r3 | medium | D implementer | 1I | Issues with no closing PR in the fetched PR window are ignored when deciding allSkipped, so one |
| #4875 r1 | medium | B +test | 1T | The post-quota-cooldown arm is tested only in timer mode, but acceptance criterion 3 and INV-7  |
| #4890 r1 | medium | D implementer | 1I | containedPath uses posix.join(playbooksDir, rel), which concatenates an absolute rel onto the d |
| #4891 r1 | medium | D implementer | 3I | Row says the dispatch binding applies conflict-fix-attempted before the spawn (durable 1-attemp |
| #4927 r1 | medium | A strict | 1S | The diff touches src/autopilot/work-projections.ts, src/api/autopilot-board.ts and docs/generat |
| #4935 r1 | medium | D implementer | 2T 1I | AC3/INV-10 (wayfinder_orch skill resolves from skill_by_ticket_type) is met only in playbook pr |
| #4935 r2 | medium | D implementer | 1I | The hand-kept 22-row class-to-skill table still lives in the dispatch-reference fragment and th |
| #4958 r1 | medium | C +local | 1L | Fail-safe-all-open only covers a non-ok search read; an ok search with a non-array payload pars |
| #4960 r1 | medium | D implementer | 1I | RetroDispatch.bucket still comes from the turn-ledger action's outcome.status (completed at rea |
| #4961 r1 | medium | C +local | 1L 4S | Rendered body embeds absolute host appDir as the working directory for a picked-up agent (confl |
| #4961 r2 | medium | A strict | 1S | INV-8 reconciliation cites the banner test, which asserts only 'Target ($TARGET_APP_DIR)' and n |
| #4963 r1 | medium | D implementer | 2I 2L 2T | glossaryAnchors uses a line regex while the renderer slugs only paragraph tokens led by a stron |
| #4963 r2 | medium | B +test | 2T | The INV-11 renderer-parity tests dynamically import dashboard/node_modules/marked and skip when |
| #4964 r1 | medium | D implementer | 2I | Stamp is a one-shot snapshot at endRun; the bridge polls every 60s so merges landing in the las |
| #4964 r2 | medium | D implementer | 2I | The entries.length >= 2000 guard can never fire because the slot-events stream is MAXLEN ~1000  |
| #4964 r3 | medium | D implementer | 1I | hydra:autopilot:slot-events is shared with the per-tool-call hook (on-subagent-tool-call.sh, XA |
| #4964 r4 | medium | D implementer | 2T 2I | A failed durable XADD is only logged; the merge is lost and the run is later stamped source=win |
| #4969 r2 | medium | D implementer | 5I 1L | Verification code throws instead of returning result objects (missing counts.json row at 610; r |
| #4969 r3 | medium | D implementer | 1I | Verification code still throws on a missing or malformed inventory/baseline JSON (readJson) and |
| #4969 r4 | medium | D implementer | 2I | When the scan aborts, rows is the single sentinel row (inputs):unreadable-input:<message with a |
| #4969 r5 | medium | A strict | 1S | Baseline row format is file:kind:token with no line, but issue says (file:line:kind:token); PR  |
| #4969 r6 | high | B +test | 3S 1T | The --update-baseline refuse-to-grow branch and the successful baseline write have no test; CLI |
| #4970 r1 | medium | D implementer | 3L 1I | Enumerating every app-router page.tsx now crawls redirect-only and auth-gated pages; crawlRoute |
| #4970 r2 | medium | C +local | 3L | The round-1 dedup fix (labels=needs-triage) drops an open crawl issue from the dedup set once t |
| #4972 r2 | medium | C +local | 1L | The cap branch posts the cap comment (the count terminator in _count_prior_nopr_stall_comments) |
| #4973 r1 | high | D implementer | 3I | POST /attention/:id/dismiss is now strict {reason: enum, key}; the only consumer (Today Attenti |
| #4976 r1 | medium | D implementer | 2I 2L | useDelayedCommit.start() clears the pending timer without firing it, and the feed shares ONE wi |
| #4976 r2 | medium | D implementer | 4I | INV-7 ("Undo cancels before ANY request is sent; on expiry the request fires"): the immediate-u |
| #4976 r3 | medium | D implementer | 2I 2S | Dismiss has the same double-fire defect fixed for in-dashboard actions: buttons never disabled  |
| #4976 r4 | medium | D implementer | 1I | Each immediate-tier affordance and the feed's dismiss render their own DelayedCommitToast at th |
| #4976 r5 | medium | D implementer | 1I | The confirm-first tier still gates on the row-local disabled={busy} and never reads undoHost.in |
| #4980 r1 | medium | D implementer | 3L 4I 4S 3T | The fence keys only on the session cwd common-dir, not the effective target of the command: den |
| #4980 r2 | medium | D implementer | 1I | literal() rejects any value starting with ~ or containing $, so the os.path.expanduser call can |
| #4980 r3 | medium | D implementer | 5I 2S | GIT prefix regex accepts only --opt or --opt=value, so space-separated git --git-dir /home/gabe |
| #4981 r1 | medium | D implementer | 1I 2T | Artifact says the pending probe is 'a new AutopilotRunsDeps field' and that hand-built makeEndD |
| #4982 r1 | medium | B +test | 2T | The AC4 test pins a naming accident by asserting the substring open_pr is absent from the whole |
| #4983 r1 | high | C +local | 4L | Without pipefail, gh issue view ... \ |
| #4983 r2 | medium | C +local | 1L | Both Step 0.7 guards use gh pr edit (--body restore and --add-label "$L"), which this repo's ow |
| #5000 r1 | medium | D implementer | 2I | runTick guards only the author session; a throw from createWorktree, claimIssue, readIssueBody  |
| #5002 r1 | medium | D implementer | 3I 1T | All-absent arm still infers no-work from absence plus a 60k-token proxy. total_tokens is 0 when |
| #5002 r2 | medium | D implementer | 2I | if status == 'empty' and snap.anchor_ref: status = 'completed' keeps every anchored zero-commit |
| #5003 r1 | medium | C +local | 2L | Plan-apply and skips loops read from process substitutions whose exit status set -e never sees; |
| #5003 r2 | medium | B +test | 1T | The round-1 fixes (strict shape check, decode-failure exits, applied-vs-expected count guard) h |
| #5003 r3 | medium | C +local | 2L 1T | Shape check does not reject a NUL in .content; jq -j then emits a stray NUL delimiter, so the r |
| #5005 r1 | medium | B +test | 2T | Headline criterion (GET /api/dispatches/<hash>/transcript resolves the child JSONL) has no end- |
| #5005 r2 | medium | A strict | 1S | Files in scope omits test/dispatches-transcript.test.mts and test/fixtures/suite-count-baseline |
| #5006 r1 | medium | A strict | 1S | Checklist item collectClassStats from #4987 is neither demoted nor recorded as a knip false pos |
| #5017 r2 | medium | D implementer | 3I 1S 1L | Selector stamps streak/last_fired before later gates; a dropped dispatch still climbs the ladde |
| #5017 r3 | medium | D implementer | 3I | Streak stamped inside the selector at plan time, so a dropped or failed-launch dispatch still c |
| #5037 r1 | high | D implementer | 2I | New WORD/VAL pattern excludes parentheses, so git -C $(pwd) remote set-url ... no longer matche |
| #5037 r2 | high | D implementer | 2I | Round-2 deep-nesting blocker only partly fixed: DEEP_SUBST needs 4 open parens but WORD fails a |
| #5037 r3 | high | D implementer | 10I | echo "git remote set-url origin x" \ |
| #5037 r4 | high | D implementer | 16I | Quoted args scanned only when a SHELLS word is in the same simple command: echo "git remote set |
| #5056 r1 | medium | D implementer | 7I | Hard-coded fallback chat id removed; missing TELEGRAM_CHAT_ID now silently disables every Teleg |
| #5056 r2 | medium | D implementer | 1I 3S | Still not fixed: inventory drops TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID though scripts/hydra-w |
| #5059 r1 | medium | D implementer | 2I | Unbounded Promise.all spawns one bash qa-verdict-event.sh (several gh calls, 90s timeout each)  |
| #5059 r2 | medium | D implementer | 3I | Fixed lowest-PR-first slice(0,12) has no rotation: persistent non-mergeable candidates (green C |
| #5059 r3 | medium | D implementer | 1I | Rotation start (floor(now/60s)*12)%n does not advance when 12*turn-minutes is a multiple of n ( |
| #5060 r1 | medium | C +local | 1S 1L | The new section 0.9 recipe runs gh api -X DELETE ... --silent 2>/dev/null \ |
| #5067 r1 | medium | B +test | 2T | Not fixed from round 1: deploy.sh AC (non-zero installer exit gives ::error:: and deploy contin |
| #5067 r2 | medium | C +local | 2L 1S 2T | Symlinked ~/.claude/settings.json is replaced by a regular file via os.replace on every deploy  |
| #5068 r1 | medium | C +local | 1L | Guard with [[ -n "$canon_norm" ]] in both places (-z "$canon_norm" \ |
| #5068 r2 | medium | D implementer | 3L 4I 2T | Persistent failing repair re-runs a <=60s git fetch every tick; only the XADD is deduped (round |
| #5069 r1 | medium | D implementer | 1I | The new guard matches only argv "-n","<idx>" and HYDRA_REDIS_DB: "<idx>". The original #5062 de |
| #5069 r2 | medium | D implementer | 2I 2T | On HYDRA_FULL_SUITE=1 local run ownedDbSkip returns false and the test hard-fails instead of sk |
| #5069 r3 | medium | D implementer | 1I 1L | battery() silently drops the SELECT-path parity entries when no owned DB exists, even on a full |
| #5069 r4 | medium | C +local | 1L | Pool-literal guard still misses unquoted numeric -n, drcAt("9", ...) literals, typed *DB*: stri |
| #5134 r1 | medium | D implementer | 1L 4I | AC1 not met: DegradeReason unused; DegradedMarker.reason and Classified failure arm remain stri |
| #5145 r1 | medium | D implementer | 1I 2T | Token check over the entire prompt denies a correctly rendered prompt whenever embedded notes/i |
| #5148 r1 | medium | C +local | 2L | The same .[] walk is still hand-rolled as members; not consolidated into the new eachValue |
| #5150 r1 | medium | A strict | 3S | Still says term-check.py only reads the quota baseline and Phase 3 prints OK; script is deleted |
| #5150 r2 | medium | A strict | 1S | Still says the autopilot self-terminates on idle_drain_turns, but this PR deleted that arm from |
| #5170 r1 | medium | D implementer | 3I | Orch-scope instruction passes targetName "$TARGET_NAME" but the seam that resolves $TARGET_NAME |
