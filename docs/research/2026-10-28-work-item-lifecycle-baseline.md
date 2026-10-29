# Work-item lifecycle baseline (wayfinder map #5283, ticket #5284)

Measured 2026-10-28 against `origin/master` @ `4f90596ed`, window 2026-09-28 .. 2026-10-28 (30d).
Method: GitHub REST `issues/N/events` (label `labeled`/`unlabeled` timeline) for all 375 issues
updated in the window, `gh pr list --state merged` (248 PRs), `/api/autopilot/runs`,
`/api/metrics/cost-by-class`, and `git grep` on `origin/master`. Nothing here is copied from the
2026-09-28 QA audit or 2026-10-01 throughput audit.

## Caveats that bound every number below

- **No actor attribution.** 4017 of 4027 label events in the window are by `gaberoo322` (shared
  identity: autopilot, GLM drainer, QA agents and the operator all write as one account); 10 by
  `github-actions[bot]`. "Who moved the label" is unrecoverable from GitHub alone — this is itself
  the case for a journal (#5289).
- Dwell is measured label-added to label-removed (or to now if still open). An issue closed with a
  label still on it is not counted (no `unlabeled` event).
- "Rounds" and "first-pass" are **label proxies** (count of `needs-qa` adds), not QA verdict
  comments. `needs-qa` can be re-asserted without a new QA round, so rounds are an upper bound and
  first-pass yield a lower bound.

## 1. Stranding / ping-pong incidents

Label dwell (issues entering the state in the window):

| Label | Entries | Median | p90 | Max | > 3h | > 24h |
|---|---|---|---|---|---|---|
| in-progress | 488 | 0.8h | 89.9h | 581h | 161 | 79 |
| needs-qa | 474 | 0.3h | 6.9h | 120h | 80 | 6 |
| needs-dev-resume | 247 | 1.9h | 50.5h | 571h | 96 | 38 |
| blocked | 58 | 113.7h | 186.9h | 552h | (40 > 24h) | 40 |

Stranding incidents per week = dwell above 3h (in-progress / needs-qa / needs-dev-resume) or above
24h (blocked), bucketed by week the state was entered:

| ISO week | in-progress | needs-qa | needs-dev-resume | blocked |
|---|---|---|---|---|
| 2026-W40 (from 09-28) | 31 | 38 | 36 | 17 |
| 2026-W41 | 37 | 19 | 26 | 1 |
| 2026-W42 | 41 | 4 | 6 | 2 |
| 2026-W43 | 45 | 10 | 17 | 20 |
| 2026-W44 (partial, to 10-28) | 7 | 9 | 11 | 0 |

Total about 55-125 over-threshold stalls per week; in-progress stalls are not trending down
(31 -> 45 across W40..W43). The 3h/24h thresholds are this baseline's choice; the production
backstops live in `scripts/autopilot/recover-stale.sh` and `scripts/autopilot/reap_stall.py`
(re-derive thresholds there before comparing a later re-measure).

Ping-pong (same issue gets the same lifecycle label >= 3 times among in-progress, needs-qa,
needs-dev-resume, ready-for-agent): **78 of 375 issues (21%)**. Extreme outliers: #4593
(76 in-progress / 76 ready-for-agent cycles), #4949 (18/17), #4279 (14 needs-qa / 14
needs-dev-resume). Excluding #4593 and #4949 it is still 76 issues, so this is a broad pattern, not
two bad tickets.

Snapshot of open lifecycle-labelled issues now: 3 in-progress, 1 needs-qa, 1 needs-dev-resume,
6 blocked (5 of them idle ~198h, all `glm-withhold`).

## 2. QA yield and rounds

- 195 closed issues reached `needs-qa`; 79 (**41%**) did so exactly once with no
  `needs-dev-resume` (proxy for first-pass PASS). By close week: W40 17/36, W41 11/44, W42 16/33,
  W43 32/65, W44 3/17 (no clear trend; W41 lowest at 25%).
- `needs-qa` adds per closed issue: mean 2.42, median 2, p90 5.
- Merged PRs: 248 in 30d (about 8.3/day, bursty: 1 to 26 per day). PR open-to-merge median 5.5h,
  p90 74.4h.
- For a true first-pass yield, ADR-0028 panel work needs a recorded QA verdict per head SHA; today
  it exists only as issue comments (not queried here).

## 3. Label-write site inventory (origin/master)

Deterministic code, TypeScript seams:
- `src/github/issue-actions.ts:111-165` `removeIssueLabel` / `editIssueLabels` (multi-flag
  `gh issue edit`, atomic remove+add).
- `src/github/issues.ts:484-518` `addIssueLabel` (the one add surface).
- `src/api/autopilot-board.ts:474-477` default add/remove deps; call sites `:605`
  (hitl-grill removal), `:643` (lane removal) — the re-read, gate, write, re-verify spine.
- `src/glm/finish.ts:465` (in-progress -> ready-for-agent), `:470` (glm-withhold), `:480`
  (-> needs-qa), `:581` (glm-authored); `src/glm/drainer-driver.ts:351`.
- `src/pattern-memory/escalation.ts:379` `restoreLifecycleLabel` (`addIssueLabel`).
- `src/operator-actions/registry.ts:1447, 1604, 1650, 1680, 1771, 1801` (operator-action command
  templates: blocked, ready-for-agent, wontfix, ready-for-human).
- `src/scheduler/chores/glm-eligibility-sweep.ts` (glm-eligible/glm-ab-control adds through
  `addIssueLabel`).

Deterministic code, scripts:
- `scripts/autopilot/reap_stall.py:187-190` (-> ready-for-human), `:238-240` (-> needs-dev-resume),
  `:395-398` (-> needs-qa), `:515-516` (-> ready-for-agent).
- `scripts/autopilot/recover-stale.sh:164` (-> needs-qa), `:171` (-> ready-for-agent), `:227`
  (blocked -> needs-qa), `:233` (blocked -> ready-for-agent).
- `scripts/autopilot/reap.py:1562` (creates `needs-triage` issues); `scripts/ci/hydra-cleanup-emit.ts:547-556`,
  `scripts/ci/hydra-target-cleanup-emit.ts:473,503`, `scripts/ci/hydra-prd-render.ts` (issue
  creation with labels).
- `scripts/autopilot/render-dispatch.py:111-113` tells dispatched workers to mutate labels via
  `gh api .../labels` (contract text, a writer by delegation); `scripts/claude-hooks/gh-label-delete-guard.sh`
  exists only to stop the collection-DELETE that wipes all labels.

Workflows:
- `.github/workflows/issue-label-validation.yml:104-107` and `:211-214` (revert ready-for-agent ->
  needs-info), `:174` (label on create).
- `.github/workflows/audit-nightly.yml:110-113` (creates issues with `ready-for-agent`).
- `.github/workflows/design-concept-comment.yml:196` (PR label removal, not an issue lifecycle
  label).

LLM playbooks: 54 `gh issue edit` mentions across `docs/operator-playbooks/**` (37 explicitly
`--add-label`/`--remove-label` or `gh api .../labels`). Heaviest: `hydra-qa.md` 14,
`hydra-wire-or-retire.md` 10, `_fragments/hydra-target-build-anchor-preflight.md` 9,
`_fragments/hydra-dev-parent-flow.md` 8, `hydra-target-sweep.md` 6, `hydra-target-build.md` 5,
`hydra-target-qa.md` 4. Full per-file counts: `git grep -c "gh issue edit" origin/master -- docs/operator-playbooks`.

Total: about 10 deterministic writer files + 2 workflows + 22 playbooks files (54 sites). Label
adds by volume in window (all actors): in-progress 488, needs-qa 474, ready-for-agent 336,
needs-dev-resume 247, hitl-grill 78, ready-for-human 72, blocked 58.

## 4. Cost per merged PR

Not cleanly measurable today; the data is partial and the windows disagree:
- `/api/metrics/cost-by-class` is a 24h transcript window: 82.4M tokens total, only 1 PR merged in
  the same 24h (a low-merge day), so tokens per merged PR from that window is meaningless (82M).
- `/api/autopilot/runs` (hard cap 50 runs, about 3.5d: 2026-10-25..): 16.0M `total_tokens`,
  20 merges (`merged_count`), about 0.8M tokens per merge, but several runs report
  `total_tokens: 0`, so this is a floor, and `merged_count_source` mixes `actions`/`window`.
- Dev share of the 24h window: dev-orch 19.4M (23%), qa 4.3M (5%), retro 3.9M (5%).
- Need: a persistent per-merged-PR join (PR -> dispatch -> tokens); the run ledger (#5071) is the
  natural source. USD is structurally $0 (cost gates inert), so token is the only unit.

## 5. Parent-loop glue share

- 24h tokens: `hydra-autopilot` parent 12.6M (15.3%), `hydra-sweep`+`hydra-target-sweep` 5.6M (6.8%),
  `clear` 6.9M (8.4%, unattributed), interactive operator session 24.0M (29%). Parent plus sweeps
  = about 22% of tokens spent on non-code-writing orchestration; with the unattributed `clear`
  bucket up to about 30%.
- Last 50 runs: 240 turns for 222 dispatches (1.08 turns per dispatch); terminations: 31 handoff,
  17 context_compaction, 1 quota. 34% of runs end on context_compaction, i.e. the parent loop
  exhausts its context rather than finishing.
- Run-journal sample (run 3df8bc22): two slots flagged "silent-wedged" past the 3600s cap
  (`dev_orch` ~3706s, `dev_target` ~61359s) and reaped with 0 tokens; sweeps spent a turn
  finding nothing. These are the state-stitching cases the writer seam should absorb.
- Not measured: per-action glue calls (recover-stale / manual reap / re-routing) — the run ledger
  does not tag calls by purpose. Gap for the epic's instrumentation.

## Implications for sibling tickets

- #5286/#5287: 10 deterministic writers plus 54 LLM-playbook sites; the spine to generalise is
  `src/api/autopilot-board.ts`. Python (`reap_stall.py`, `recover-stale.sh`) and shell writers
  bypass the TS seam entirely.
- #5289: shared `gaberoo322` actor makes the event log unattributable; the journal must carry its
  own actor/reason field.
- #5290: 21% of issues cycle a lifecycle label >= 3 times; #4593 reached 76 cycles — evidence that
  caps are not durable today.
- Re-measurement recipe: this document's method is reproducible with the commands in the Method
  line; permanent panel fields (first-pass QA yield, cost per merged PR) require the data gaps in
  sections 2, 4 and 5 to be closed first.
