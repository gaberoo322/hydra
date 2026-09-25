# GLM drainer function triage

Resolves the wayfinder ticket "GLM drainer function triage" (#4647) on the map "Move the GLM dev-drainer decision logic from bash to typed, tested TS" (#4517). Facts only. The seam recommendation belongs to the next ticket, "GLM drainer seam shape" (#4648).

Snapshot: `origin/master` at `a2c99b503`, 2026-09-23. Subjects: `scripts/glm/drainer-loop.sh` (1,423 lines), `test/glm-drainer-loop.test.mts` (1,747 lines), `src/glm/drainer-driver.ts` + `drainer-runner.ts`, and every other copy of the GLM eligibility rules.

## Headline facts

- **39 functions, not 38.** The map's count missed `record_quota_block_if_429` (530–541).
- **Layering.** 8 functions are pure decisions, 12 are mixed (a pure core wrapped around an effect), 14 are single effects, 3 are mechanics, and 2 are glue (`attempt_one_issue`, `main`).
- **Tests.** The suite has 54 `test(` calls, which run as 65 tests because one golden table loops over 12 cases. Every whole-script test idles at the picker's dry-run branch, so **no whole-script test ever reaches `attempt_one_issue`**. `attempt_one_issue` is covered only through sourced snippets with real git and fake `gh`/`node`.
- **Hotspots.** Of 18 drainer and lane bugs since 2026-08-05, **8 were eligibility/routing parity drift**. `pick_eligible_issue` was changed by 4 separate fixes, more than any other function.
- **Eligibility is implemented in 8 places.** They disagree in 13 identified ways. Code comments show one is deliberate; 8 contradict their own comments or have none, and read as drift. One disagreement strands issues from both lanes and is filed as bug #4649.

## 1. Function table

Layer: **D** decision (pure given inputs), **M** mixed (pure core + effect; the extractable part is named), **E** effect, **Mech** mechanics, **G** glue. Coverage groups D1–D17 are the `describe` blocks listed in §2.

| # | Function | Lines | Layer | Reads / output | Coverage | Fixed by |
|---|---|---|---|---|---|---|
| 1 | `log` | 233–243 | Mech | stderr line | all | |
| 2 | `run_driver` | 259–263 | E | `node … drainer-driver.ts <mode>`; one JSON line; non-zero = driver fault | D12; via D13/D15 | #4372 |
| 3 | `write_heartbeat` | 269–283 | Mech | driver `heartbeat` → Redis `hydra:glm:drainer:active` | DRY branch only | |
| 4 | `acquire_lock_or_heartbeat_and_exit` | 289–296 | Mech | flock fd 9; heartbeat + exit 0 when held | D4 | |
| 5 | `is_operator_paused` | 302–329 | M: JSON → paused, fail-closed | `curl` pause endpoint + `jq` | D1 (missing-tool arm untested) | |
| 6 | `cap_file_path` | 335–337 | D (clock) | `$CAP_DIR/…daily-cap-YYYY-MM-DD` | D2 | |
| 7 | `cap_count` | 339–347 | E (read) | cap file or `0` | D2 | |
| 8 | `is_cap_exhausted` | 349–357 | M: `count >= DAILY_CAP` | cap_count | D2 | |
| 9 | `cap_increment` | 359–369 | E | read-modify-write | D13 (DRY untested) | |
| 10 | `timeout_counter_path` | 379–381 | D | `$CAP_DIR/…timeouts-<issue>` | via D13/D15 | #4442 |
| 11 | `timeout_counter_value` | 383–391 | E (read) | file or `0` | D13, D15 | #4442 |
| 12 | `timeout_counter_increment` | 393–403 | E | +1 | D13, D15 | #4442 |
| 13 | `timeout_counter_remove` | 405–411 | E | `rm -f` | D13 | #4442 |
| 14 | `release_after_authoring` | 419–432 | M: withhold = timed out ∧ count ≥ cap | counter → `release_issue` | D13, D15 (open_pr-failure site untested) | #4442 |
| 15 | `quota_block_file_path` | 455–457 | D | path | D3, D17 | #4450 |
| 16 | `quota_blocked_until_epoch` | 463–478 | M: numeric ∧ future; deletes stale file | block file, clock | D3 (non-numeric arm untested) | #4450 |
| 17 | `epoch_to_iso` | 482–484 | D | `date -d` | D3, D17 | #4450 |
| 18 | `parse_quota_block_stdout` | 497–524 | D (clock) | z.ai 429 text → epoch, clamped [now+900, now+3024000], fallback now+3600 | D16 (7) | #4450 |
| 19 | `record_quota_block_if_429` | 530–541 | M: parse + file write | author stdout | D17; the real attempt → 429 path is checked only as source text | #4450 |
| 20 | `recover_stale_glm_claims` | 547–569 | M: jq staleness filter (> 5400 s) | `gh issue list` → `recover-stale.sh` | DRY branch only | |
| 21 | `has_approved_design_concept` | 575–588 | M: `.status == "approved"` | `curl` design-concept API | D9 (curl-failure arm untested) | |
| 22 | `is_grill_clear` | 628–656 | M: pure jq classifier, then HTTP fall-through | rows → `cleanup-scan-label` / `expected-tier-t1` / `approved-artifact` / `none` | D9 golden table (12) | #4438 |
| 23 | `issue_has_open_pr` | 658–668 | D | closing-verb regex over open-PR bodies | D6, D9 | #3902 |
| 24 | `issue_has_merged_pr` | 689–698 | D | closing verb or `(#N)` title anchor | D7, D9 | #4246 |
| 25 | `pick_eligible_issue` | 700–788 | M/G: (rows, open PRs, merged PRs, approval) → first pick | 3 `gh` list calls; prints an issue number or nothing | D6–D9 snippets (open-PR-list failure untested) | #3902, #4246, #4252, #4438 |
| 26 | `claim_issue` | 794–802 | E | `gh issue edit` → `in-progress` | runs in D13/D15, never asserted | |
| 27 | `release_issue` | 810–823 | E | → `ready-for-agent` (+ `glm-withhold`) | D13, D15 (preflight-blocked site untested) | |
| 28 | `advance_to_needs_qa` | 825–834 | E | → `needs-qa` | D13 | |
| 29 | `compose_prompt` | 845–959 | D (pure text) | body scope sections, resume branch → prompt | D15 (RESUME paragraph); scope-section extraction never asserted | #4442 |
| 30 | `run_author_session` | 961–971 | E | driver `author` | D13/D15 via fake node; the clean-success outcome is never used | |
| 31 | `run_preflight_check` | 977–985 | E | driver `preflight` | D13 (a blocked verdict is untested) | |
| 32 | `open_pr` | 991–1053 | M: title fallback, adopt-vs-fail | `gh pr create`, else `gh pr list --head` | D5, D13 | #3902 |
| 33 | `find_resumable_branch` | 1070–1095 | M: newest ahead-of-master branch | `git ls-remote` + `rev-list` | D14, D15 | #4442 |
| 34 | `create_worktree` | 1105–1143 | M: branch/path naming | three `git worktree add` arms + node_modules symlink | fresh and local-ref arms only (`--track` and failure untested) | #3864, #4442 |
| 35 | `cleanup_worktree` | 1145–1153 | E | `git worktree remove` | D13 | |
| 36 | `delete_remote_branch_if_pushed` | 1155–1162 | E | `git push --delete` | D13 | |
| 37 | `append_timeout_note` | 1173–1195 | E | appends to PR body | D13 | #4442 |
| 38 | `attempt_one_issue` | 1201–1365 | G, with two pure decisions inside: the post-author arm and the salvage ladder | issue body, author JSON, commit count, preflight verdict | D13 (5), D15. **Untested:** clean success, preflight-blocked, genuine open_pr failure, create_worktree failure | #4442, #4450 |
| 39 | `main` | 1371–1418 | G | lock → paused → cap → quota → heartbeat → recover → pick → attempt | D1–D4; the `attempt_one_issue` call is never reached by a test | #4372, #4438, #4450 |

**Pure decision cores that already exist, or could be lifted out unchanged:** the paused parse (5), the cap check (8), the withhold rule (14), the quota parse and validity checks (16, 18), the stale-claim filter (20), grill-clear classification (21, 22), the PR dedup regexes (23, 24), the pick (25), prompt composition (29), the open_pr adopt decision (32), resume selection (33), worktree naming (34), and the two decisions inside `attempt_one_issue` (38).

## 2. Test groups (`test/glm-drainer-loop.test.mts`)

| ID | Subject | How it runs | Tests |
|---|---|---|---|
| D1 | kill switch honours only operator pause | whole script, DRY_RUN, fixture pause server | 6 |
| D2 | daily PR cap | whole script | 2 |
| D3 | z.ai quota block | whole script | 3 |
| D4 | flock concurrency | whole script | 2 |
| D5 | `open_pr` adopts an already-exists collision | sourced snippet, fake gh | 2 |
| D6–D8 | picker skips open PR / merged PR / ab-control | sourced snippet | 2 / 4 / 2 |
| D9 | `is_grill_clear` golden table (12 cases) + picker cases | sourced snippet | 7 |
| D10–D11 | systemd unit shape; no cost-join record | static reads | 2 / 1 |
| D12 | `run_driver` invokes the committed driver | snippet, fake node | 3 |
| D13 | `attempt_one_issue` post-author arms and salvage | snippet, real git + bare origin, fake node/gh | 5 |
| D14 | `find_resumable_branch` | snippet, real git | 1 |
| D15 | bounded timeout retries → glm-withhold | snippet, two attempts | 1 |
| D16 | `parse_quota_block_stdout` | snippet | 7 |
| D17 | `record_quota_block_if_429` wiring | source text + snippets | 4 |

## 3. File-backed and external state

| State | Location (default) | Format | Writer | Readers outside the script |
|---|---|---|---|---|
| Lock | `/tmp/hydra-glm-drainer.lock` | flock fd 9 | #4 | none |
| Daily cap | `$CAP_DIR/hydra-glm-drainer-daily-cap-YYYY-MM-DD` (`/tmp`) | integer, one file per UTC day, never deleted | #9 | none |
| Per-issue timeouts | `$CAP_DIR/hydra-glm-drainer-timeouts-<issue>` | integer; removed only when a PR opens | #12 / #13 | none |
| Quota block | `$CAP_DIR/hydra-glm-drainer-quota-blocked-until` | epoch seconds | #19 | none |
| Heartbeat | Redis `hydra:glm:drainer:active` | epoch ms, TTL 5400 s | driver via #3 | `src/redis/autopilot.ts` liveness (45 min) → `src/api/autopilot-board.ts`; `hydra-watchdog.sh` sterile check |
| Prompt / changed-files | `$TMPDIR/hydra-glm-drainer-{prompt,changed}-<issue>.txt` | text | #38 | TS driver `author` / `preflight`; never cleaned up |
| PR body | `$wt/.glm-drainer-pr-body.md` | markdown | author session, #37 | — |
| Resume record | origin branches `worktree-agent-glm-<issue>-<ts>` | git refs | author session, #38 | prefix parsed in collect-state.sh, glm-beachhead-report.sh, hydra-watchdog.sh |
| Labels | issue `in-progress` / `ready-for-agent` / `needs-qa` / `glm-withhold`; PR `glm-authored` | GitHub | #26–#28, #32 | board-state, sweep, collect-state, watchdog, beachhead report |

Config is read from 12 `HYDRA_GLM_DRAINER_*` / `HYDRA_AUTOPILOT_REPO` env overrides plus fixed constants (header 201–231). `HYDRA_GLM_DRAINER_WORKTREE_ROOT` is honoured but not listed in the header's hooks block.

## 4. Logic duplicated between bash and elsewhere

1. **Grill-clear arms** are mirrored in collect-state.sh's MECHANICAL/TRIVIAL blocks (~1837–1918). They are kept in step only by reciprocal "LOCKSTEP" comments. The golden table runs only the drainer's jq.
2. **The closing-keyword regex** appears in four slightly different forms: the drainer, `pr-refs.py`, `scripts/ci/epic-close.ts:96`, and `scripts/ci/design-concept-reconcile-check.ts:195`.
3. **The 5400 s stale threshold** is a bash literal, repeats as literals in collect-state.sh, and exists as a TS constant in board-labels.ts.
4. **Label names** are repeated as bash literals instead of `ORCH_BOARD_LABELS`.
5. **The `worktree-agent-glm-` prefix** is built and parsed in bash and repeated in three other scripts.
6. **The TS driver's JSON output contract** (`.ok/.code/.message/.stdout/.timedOut`, preflight `.ok`) is restated by hand in bash, including in the DRY stubs. There is no shared schema.
7. **The 50-minute timeout** appears as prose in `compose_prompt` and `append_timeout_note`. Its source of truth is `GLM_API_TIMEOUT_MS` in drainer-runner.ts.
8. **Exists only in bash:** 429 parsing and the quota block. **Exists only in TS:** heartbeat, preflight, env fencing.

## 5. GLM eligibility: rules and copies

**The drainer's rules.**

- **Tick gates:** G1 lock, G2 operator pause (fail-closed), G3 daily cap of 5, G4 quota block, G5 heartbeat (written after G2–G4 whether or not work exists), G6 stale-claim recovery.
- **Pick:** open issues carrying `glm-eligible` + `ready-for-agent`, fetched with `--limit 30`. It then:
  - excludes `glm-withhold` and `glm-ab-control`;
  - sorts by `updatedAt` ascending;
  - applies the open-PR skip, then the merged-PR skip, then grill-clear (cleanup-scan, then a T1 stamp without `needs-design-concept`, then an approved artifact of any age);
  - takes the first survivor.
- **Not checked by the drainer:** `target-backlog`, body dependency blockers, `in-progress` alongside `ready-for-agent`, `track:` titles, tier above T1.

**The copies.**

| Copy | Role |
|---|---|
| `src/scheduler/chores/glm-eligibility-sweep.ts` | Producer; applies `glm-eligible` / `glm-ab-control` |
| `src/autopilot/board-state.ts` (+ `src/api/autopilot-board.ts`) | Removes GLM work from the Claude lane; publishes `glm_withheld` |
| `scripts/autopilot/collect-state.sh` | Claude-lane anchor and grill selection; consumes `glm_withheld` |
| `scripts/autopilot/decide.py` | Routes on signals; no label literals |
| `docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md` | hydra-dev self-selection `GLM_FILTER_JQ` |
| `scripts/hydra-watchdog.sh` | `GLM_DRAINER_STERILE` alarm queue |
| `scripts/glm-beachhead-report.sh` | A/B cohort report |
| `src/autopilot/work-projections.ts` | Dashboard badge (raw `"glm-eligible"` literal) |

### Rule-by-copy matrix

| Rule | Drainer | Sweep | board-state | collect-state | hydra-dev | watchdog | beachhead | badge |
|---|---|---|---|---|---|---|---|---|
| Needs `ready-for-agent` | yes | yes | yes | yes | yes | yes | — | — |
| Excludes `glm-withhold` | yes | yes | **no** | **no** | **no** | yes | no | no |
| Excludes `glm-ab-control` | yes | yes | yes | via list | yes | **no** | yes | no |
| Excludes `target-backlog` | **no** | yes | yes | yes | no | no | — | — |
| Excludes `in-progress` | via query only | yes | — | yes | no | no | — | — |
| Grill arms | cleanup-scan, T1, approved (any age) | — | — | cleanup-scan, T1, fresh ≤ 7 d (any status), `track:` excluded | — | — | — | — |
| Dependency blocker | **no** | no | yes | yes | no | no | — | — |
| Open-PR dedup | closing verbs in body | — | — | `pr-refs.py` (+ branch, `Refs`) | `pr-refs.py` | — | — | — |
| Merged-PR dedup | yes | — | — | **no** | **no** | — | — | — |
| Order / cap | `updatedAt` asc, within 30 | board, 100 | — | issue number asc, cap 10 | `.[0]` | count, 100 | 300 | — |

### Disagreements

1. **`glm-eligible` + `glm-withhold` is stranded from both lanes while the drainer is live, and no alarm fires.** The drainer itself creates this state on a preflight failure or at the timeout cap. **Drift; filed as #4649.** No issue is stranded today.
2. **A fresh draft artifact on a `glm-eligible` issue.** collect-state counts it as grill-clear and so won't grill it, but refuses to pin it. The drainer requires `approved`. Nobody builds it.
3. **An approved artifact older than 7 days.** The drainer authors it while collect-state re-grills it as stale.
4. **A `track:` title with a T1 stamp.** The drainer admits it, although its own comments say parity means refusing it.
5. **"Blocked by #X" with X open.** The drainer admits it; board-state and collect-state exclude it.
6. **An open PR that only says `Refs #N`, or only uses branch `issue-N-…`.** `pr-refs.py` counts it as claimed; the drainer re-authors it. The two regexes also differ at the edges.
7. **A merged PR anchored only by `(#N)` in the title.** The drainer skips it; the Claude lane has no merged-PR check.
8. **`ready-for-agent` and `in-progress` both present.** The drainer admits it; the sweep and collect-state skip it.
9. **`target-backlog` added after `glm-eligible`.** The drainer admits it; the sweep and board-state exclude it.
10. **Watchdog false alarm.** Its queue counts rows the drainer will never pick (not grill-clear, `glm-ab-control`, or already has a PR), so `GLM_DRAINER_STERILE` can fire while the drainer is correctly idle.
11. **Degraded collect-state fallback** counts `glm-eligible` as Claude work. Deliberate (fail-open, #3754).
12. **Ordering and visibility.** The drainer sees only the first 30 rows gh returns. With more than 30 eligible issues, some are never seen.
13. **Badge and beachhead report** ignore `glm-withhold` / `glm-ab-control`; the report counts withheld issues in the treatment arm.

### How the copies stay in sync today

- `ORCH_BOARD_LABELS` is shared only by the sweep and board-state.
- board-state produces `glm_withheld` and collect-state consumes it; a test forbids label literals in that collect-state guard.
- Byte-parity tests cover the hydra-dev `GLM_FILTER_JQ` (`test/board-state.test.mts`) and the watchdog/beachhead PR-match jq (`test/launch-flow-delivery.test.mts`).
- **No cross-check** exists between the drainer and the sweep, the drainer and `pr-refs.py`, the drainer's stale literal and the TS constant, or the watchdog queue and the drainer's picker.
- Both grill-arm "LOCKSTEP" comments say consolidation was "deliberately left to operator grilling".

## 6. Incident history

Drainer and lane bugs 2026-08-05 → 09-15, by class:

| Class | Count | Issues |
|---|---|---|
| Eligibility/routing parity drift | 8 | #3870, #4124, #4153, #4253, #4254, #4271, #4286, #4460 |
| Process/mechanics | 4 | #3863, #4071, #4363, #4371 |
| PR dedup | 2 | #3900, #4130 (fixed by PR #4246) |
| Timeout/salvage | 2 | #4337, #4379 |
| Quota handling | 1 | #4273 |
| Heartbeat/liveness | 1 | #3868 |

Functions changed by fix PRs: `pick_eligible_issue` 4 (#3902, #4246, #4252, #4438); `main` 3; `attempt_one_issue` 2; `create_worktree` 2; `open_pr`, `run_driver` and `compose_prompt` 1 each. #4442 and #4450 introduced 12 new functions between them.

## Method

Three read-only passes over the snapshot, each checked against the source:

1. A function-by-function read of the script and test file, with coverage traced from each `describe`/`test` name.
2. A rule-by-rule comparison of every eligibility copy found by grepping `src/`, `scripts/`, `docs/operator-playbooks/` and `test/`.
3. An incident history built from closed issues and each fix PR's diff hunks against `drainer-loop.sh`.

The #4649 finding was re-verified by reading `isGlmWithheldFromClaude`, the `board-labels.ts` comment, and `release_after_authoring` directly.
