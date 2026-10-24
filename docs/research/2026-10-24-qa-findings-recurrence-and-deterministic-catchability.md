# Which QA findings recur across PRs, and which could a deterministic check have caught?

**Asset for wayfinder ticket [#5192](https://github.com/gaberoo322/hydra/issues/5192)** (map [#5182](https://github.com/gaberoo322/hydra/issues/5182), two-pass code factory). This is a **fact** document: it clusters recent QA blocking findings and maps each cluster to the cheapest deterministic check that could have caught it. It does not decide what to build. It complements [`2026-10-23-qa-fail-fixable-in-place.md`](./2026-10-23-qa-fail-fixable-in-place.md) (#5183), which classifies a larger 173-PR corpus by *who* could fix a finding; this one classifies by *what kind of defect* it is and *which check* fits.

## Headline

- **Only about a third of FAIL rounds are plausibly mechanizable, and the clearest wins are already built but not load-bearing.** Of 66 FAIL rounds with a parsable findings table, 22 (33%) had every blocking row in the mechanizable clusters (scope or baseline drift, missing or vacuous test, stale doc or orphan code, duplication, unguarded shell or `gh` failure). Only 3 rounds were scope or baseline drift alone, and 10 were drift plus missing test only. The rest (67%) contain at least one semantic design, logic or parser-hole blocker.
- **The single biggest recurrence cluster is one subsystem, not a convention.** Shell-command parser holes in `scripts/claude-hooks/git-remote-fence.sh` account for 41 of 192 distinct blocking rows (21%) and 8 of 66 FAIL rounds, from just two PRs (#4980 3 rounds, #5037 5 rounds, 13 `high`). Each round fixed the cited bypass and the next reviewer found a sibling. No lint rule catches that; a table-driven adversarial corpus test plus a "fail closed on any parse ambiguity" standard would.
- **"Missing or vacuous test" is the most widespread single cluster** (26 rows, 13 PRs, 21 FAIL rounds). A mutation gate (`mutation-test`) already exists in `ci.yml`, but these rows are the ones it did not stop: tests that assert source text, assert a substring's absence, or never execute the failure path.
- **Scope and baseline drift (18 rows, 11 PRs, 14 rounds) is the cleanest case of a duplicated check.** `scope-check` is a `ci.yml` job and `scripts/test/suite-count-check.mjs` already warns on baseline drift, yet QA still spends a blocking finding on it. I could not verify from comments whether `scope-check` was red at those heads (not recorded in the verdict), so treat "QA is duplicating CI" as likely, not proven.
- **Repeat blockers inflate the cost.** 56 of 66 FAIL rounds sit on PRs that took 2 or more FAIL rounds; #4976 took 7 and #5037 and #5069 took 5 each. 42 of 192 rows (22%) carry a "still / not fixed / unchanged / same class" marker, so many extra rounds are the same defect class reappearing at a sibling site (the dashboard double-fire defect in #4976 recurred in rounds 2, 3, 5, 6 and 7), not new findings.

## Method

**Corpus.** The 100 most recently merged PRs on `gaberoo322/hydra` at 2026-10-24 (`gh pr list --state merged --limit 100`), with `gh pr view --json comments,reviews`. 78 of the 100 carry at least one QA verdict comment; 22 carry none (mostly in-session fast-lane PRs; three, #5155 to #5157, carry a `QA-Override:` line). The window therefore spans roughly #5068 to #5217 plus a few older long-lived PRs that merged late (#4976 to #5037). It is **merged PRs only**: PRs closed unmerged are excluded, so the corpus under-represents the worst failures.

**Rounds.** A round is one `QA-Verdict: <PASS|FAIL|PASS-pending-CI> pr=<N> round=<k>` trailer: 149 trailers, 69 PASS, 12 PASS-pending-CI, 68 FAIL. 30 of 78 reviewed PRs (38%) got a FAIL as their first verdict. Blocking rows are the `medium`/`high` rows of the `### Findings` table (the non-blocking `### Follow-ups` table is excluded): 209 rows, 192 distinct after de-duplicating rows repeated verbatim in a round (the same row appears when two reviewers return it), across 66 FAIL rounds and 29 PRs. The other 2 FAIL rounds yielded no parsable `medium`/`high` row.

**Clustering.** Single rater. A first-match regex pass over finding text assigned each row one *primary* cluster in a fixed order (parser holes, reap probe, redaction, scope/baseline drift, test gap, stale doc, duplication, unguarded shell, else semantic). I read all 192 rows and hand-checked the assignments for the mechanizable clusters; the semantic bucket is the residual, so it absorbs any row my patterns missed. Cluster sizes are indicative to roughly plus or minus 3 rows. The "which check" column is my judgement of what could have fired, not a measured result.

## Clusters

| # | Cluster | Rows (of 192) | PRs | FAIL rounds (of 66) | Example PRs |
|---|---|---|---|---|---|
| 9 | Semantic design or logic defect (state machines, dedup, ladder semantics, double-fire, rotation, concurrency) | 62 (32%) | 19 | 33 | #4976, #5056, #5059, #5017, #5000 |
| 1 | Shell parser bypass in `git-remote-fence.sh` (fail-open, false-deny) | 41 (21%) | 2 | 8 | #4980, #5037 |
| 5 | Missing or vacuous test (source-text pin, absence pin, failure path never run) | 26 (13%) | 13 | 21 | #5067, #5069, #4981, #5145, #5213 |
| 4 | Scope, baseline or PR-body claim drift | 18 (9%) | 11 | 14 | #4980, #5017, #5067, #5069, #5205 |
| 6 | Stale doc, orphan code, unmet acceptance criterion | 13 (7%) | 6 | 7 | #5150, #5197, #5210, #5060, #5134 |
| 2 | Absence-inferred classification (reap `empty` probe treats a missing dir or ref as "no work") | 11 (6%) | 1 | 3 | #5002 |
| 3 | Credential or URL redaction gap | 7 (4%) | 3 | 5 | #4980, #5037, #5068 |
| 7 | Duplicated helper not consolidated | 7 (4%) | 4 | 5 | #5148, #5069, #5134, #4981 |
| 8 | Unguarded shell or `gh` failure in a playbook or script | 7 (4%) | 5 | 6 | #4983, #5169, #5003, #5067 |

Rounds can hold rows from several clusters, so the FAIL-rounds column does not sum to 66. Rows are counted once, so the first column sums to 192.

## Per-cluster catchability

For each cluster: what check could have caught it before review, and whether one already exists.

| Cluster | Deterministic check that fits | Exists today? | Status |
|---|---|---|---|
| 4 Scope / baseline / PR-body claim drift | `scope-check` (PR body `Files in scope` vs diff); `suite-count-check.mjs` drift WARN; `test-subject-baseline` and `docs-drift-baseline` ratchets | Yes: `scope-check` is a job in `ci.yml`; baseline drift is a WARN, not a failure | Partly advisory. A baseline-diff-vs-`Files in scope` check, and an INV-claim-vs-diff check (rows citing "PR body claims no `useApi.js` change" while the diff changes it), do not exist |
| 5 Missing or vacuous test | `mutation-test` (kill-rate) for "deleting X keeps suite green"; an `ast-grep` rule flagging tests that assert on `readFileSync` of a `src/` path with `includes` or regex only; an "absence-of-substring" pin rule | Mutation gate exists in `ci.yml`; no AST rule for source-text pins | Gap. Source-text pins are the dominant sub-pattern (#4976 r3, #5067 r1 and r2, #5069, #4982) |
| 6 Stale doc / orphan code / unmet AC | `knip` (orphan exports); `docs-prose-drift` identifier and retired-term baseline test; a grep for deleted-script names under `docs/` | `docs-prose-drift` is part of `npm test` (required). `knip` runs in `cleanup_orch`, not per PR. No "deleted file is still referenced" check | Gap for #5150 ("script deleted, docs still name it") and #5197 (orphaned `getDecisionQueue`). Candidate: per-PR `knip` diff plus deleted-path reference grep |
| 7 Duplication | A duplicate-code detector (jscpd or similar) | No | Gap. Low value: 7 rows, always `medium`, usually fixed in one round |
| 8 Unguarded shell / `gh` failure | `shellcheck`; an `ast-grep` or `comby` rule for `$(gh ...)` without a failure guard; `set -o pipefail` lint in playbook code blocks | `fail-loud-catch.yml` (`src/ast-grep-rules/`) covers TypeScript `catch` only and is advisory-only (Tier-3 sibling, not in `ci.yml`). No shell equivalent | Gap in the non-TS lane (`scripts/comby-rules/` has one unrelated rule) |
| 3 Redaction gap | A single shared `redactUrlUserinfo` helper used by the watchdog, the aggregator and the fence, plus a table-driven test on userinfo containing `/`, `@`, `:` | No shared helper: `[^/]*@` was re-implemented and re-broken in `hydra-watchdog.sh`, `recent-merges.ts` and the fetch-stderr path | Design fix, not a lint. `secret-scan.sh` looks for committed secrets, not runtime-log leakage |
| 1 Shell parser bypass | A committed adversarial corpus (allow and deny cases, including `$(...)` nesting, ANSI-C quoting, case-insensitive git keys, `find -exec`) run as a test, written before review | No corpus: each round added individual cases | Process gap. Reviewers found the same class five times in #5037 |
| 2 Absence-inferred probe | None mechanical. The invariant ("never infer no-work from absence alone") is a design rule | n/a | Standards line: classify on positive evidence only |
| 9 Semantic | None. A reviewer or a spec-vs-behaviour test | n/a | Remains the reviewer's job |

**Already built but advisory-only.** The fail-loud ast-grep rule was added after the 09-28 audit found "9 of 67 hydra-qa FAIL rounds" were silent catches (its own header says so). In this window I found no blocking row that is a plain silent TypeScript `catch`; the nearest are shell or `throw`-escape bugs (the since-marker and XADD rows in #4980 and #5067, #5000's unguarded `runTick`) that the rule does not see. That is consistent with the TypeScript silent-catch class having been largely absorbed, though I did not run the rule against the PR diffs to confirm.

## Cost: how many FAIL rounds each cluster drove

A FAIL round takes roughly one dev fix push and one re-review. Rounds containing at least one row of the cluster (a round with several clusters counts for each):

- Semantic (9): 33 rounds, 50% of FAIL rounds. Not reducible by checks.
- Missing or vacuous test (5): 21 rounds (32%). The largest *reducible* cluster.
- Scope, baseline, PR-body drift (4): 14 rounds (21%); only 3 rounds had nothing else wrong. Removing the check-able drift would save few whole rounds, because those PRs usually also had a code finding. The saving is mostly one finding per round, not one round.
- Parser bypass (1): 8 rounds (12%) from 2 PRs.
- Stale doc (6): 7 rounds; unguarded shell (8): 6; duplication (7) and redaction (3): 5 each; reap probe (2): 3.

Treat "eliminated if the check existed" as an upper bound: 22 of 66 rounds (33%) are the ceiling for clusters 4 to 8 together, consistent with #5183's 8% to 16% for strictly mechanical fixes and 36% for the optimistic reading.

## Data-quality caveats

- **Verdict-format drift is not a problem in this window.** All 149 verdict comments carry a canonical `QA-Verdict:` trailer and every `pr=` matches the PR it sits on. The legacy-header drift the ticket mentions (`## hydra-qa verdict: FAIL`, `## QA Verdict: FAIL`) is handled by `LEGACY_VERDICT_HEADER_RE` in `scripts/ci/qa-catch-rate.ts` and only concerns pre-#4729 history, which this window does not reach. The practical data-quality traps here are different:
  - **Prose that quotes a verdict.** About a dozen non-verdict comments (forward-fix notes, e.g. on #4976, #4983, #5037, #5056, #5059, #5134) contain `QA-Verdict FAIL sha=...` in prose. A substring match for `QA-Verdict` would double-count them; the parser must anchor to the trailer line (`^QA-Verdict: <v> pr=<N> round=<k>`), which `parseQaVerdictTrailers` does.
  - **Non-verdict QA-marked bodies.** `> *Automated QA — review deferred*` (#5002) matches the `Automated QA` marker but is not a verdict.
  - **A FAIL trailer with no parsable blocking row.** #5066 round 1 reports `blockers=1 max_severity=high` but its findings table has no `medium`/`high` row in the standard column layout, so a table scraper drops it. The trailer, not the table, is the reliable count; the table is the reliable *content*.
  - **No verdict at all** on 22 of 100 PRs: the catch-rate denominator (reviewed PRs) is 78, not 100.
- **Survivorship.** Merged-only. A PR that failed repeatedly and was closed is absent.
- **Linked-issue comments were not fetched.** The bounce comments on the linked issue (`Automated QA failed`) are a second ledger; they add no new findings here because the PR comment carries the full table.
- **Single rater, heuristic clustering,** no inter-rater check. The semantic cluster is a residual and probably contains a few mechanizable rows (for example some missing-test rows phrased as spec gaps).
- **Overlap with #5183.** Its corpus is larger (173 PRs, 369 rows) and independently measures Files-in-scope drift (31 rows), baseline regeneration (12) and missing-pin coverage (46). My 18 and 26 rows for the corresponding clusters are consistent in proportion on a 100-PR subset.

## Candidate follow-ups (for the map, not decisions)

1. **Make the scope and baseline drift check blocking-in-CI and drop it from QA's finding list.** The check exists; QA is spending findings on it. Needs confirmation that `scope-check` was red on the affected heads before relying on this.
2. **An AST rule for source-text test pins** (cluster 5's dominant sub-pattern), in the existing advisory `ast-grep` lane, as a sibling of `fail-loud-catch.yml`.
3. **A per-PR "deleted path still referenced" and orphan-export check** (`knip` diff plus a grep of deleted filenames under `docs/`), for cluster 6.
4. **A shell-lane analogue of the fail-loud rule** (comby or `shellcheck`) for `$(gh ...)` and process-substitution failures, for cluster 8.
5. **Standards lines rather than lint** for clusters 1, 2 and 3: "security-fence parsers ship with an adversarial corpus test and fail closed on any parse ambiguity"; "classify on positive evidence, never absence"; "one shared URL-userinfo redactor".
6. **Because 67% of FAIL rounds contain a semantic blocker, none of the above removes the need for the reviewer**; the realistic goal is to cut the per-round finding count and the sibling-site recurrence (cluster 1 and the #4976 double-fire), not the round count.

Reproduction: `gh pr list --repo gaberoo322/hydra --state merged --limit 100 --json number`, then `gh pr view <n> --json number,title,body,comments,reviews,mergedAt` per PR; trailers parsed with `^QA-Verdict: (\S+) pr=(\d+) round=(\d+) sha=(\S+) blockers=(\d+) max_severity=(\S+)`; blocking rows are `| medium |` / `| high |` lines before `### Follow-ups`.
