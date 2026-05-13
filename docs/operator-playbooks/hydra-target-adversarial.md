# hydra-target-adversarial (stub)

> **Status:** Stub — not implemented yet. Tracking ticket TBD (follow-up to issue #344).

## Purpose

Replace the in-cycle adversarial validation agent (removed in Phase A, issue
#344) with a **nightly** `/schedule`d run that examines recently merged commits
for edge cases, missed error paths, and integration issues, then opens GitHub
issues (or work-queue items) for surviving findings.

The in-cycle agent was removed because:

- It ran on every merged cycle, adding ~30s of latency and an extra mini-model
  call regardless of risk.
- Findings were dropped straight into the work queue, where they competed with
  operator priorities without explicit review.
- The same value can be delivered out-of-band, nightly, without blocking the
  build cadence.

## Expected behavior (when implemented)

1. **Trigger:** Nightly via `/schedule` (e.g., 02:00 local), or on operator
   request.
2. **Input:** The last 24h of merged commits to `master` on the target repo
   (`~/hydra-betting`) — pulled from `hydra:reports:reality:*` reality reports
   and/or `git log --since=24.hours.ago`.
3. **Method:** For each merged commit, sample up to N changed source files
   (`.ts`/`.tsx`, excluding tests/configs/migrations/`.d.ts`), feed them to a
   mini-model adversary prompt (see `prompts/adversarial.md` — to be authored),
   and parse the JSON findings.
4. **Output:** For each medium+/high severity finding:
   - Open a GitHub issue with `needs-triage` label on the target repo, OR
   - Push to `hydra:queue:work` with `source: "adversarial-validation-nightly"`.
   - Deduplicate against the existing queue and recently-merged task titles
     (the dedup helper `isAdversarialFindingAlreadyMerged` lived in the old
     `src/post-merge.ts` dispatch — port it into this skill).
5. **Tracking:** Continue writing the rolling window of tracked merges to
   `hydra:adversarial:tracking` and precision stats to `hydra:adversarial:stats`
   so the digest + dashboard can keep reporting precision-of-findings without
   schema churn.

## Redis schema (preserved from Phase A)

- `hydra:adversarial:tracking` — rolling window of up to 50 tracked merges
  (`pushTrackedMerge`, `getTrackedMerges` in `src/redis/adversarial.ts`).
- `hydra:adversarial:stats` — precision stats (`setAdversarialStats`).

These remain accessible via `src/redis-adapter.ts` re-exports. Digest and
dashboard read them directly; the nightly skill will be the only writer.

## Skill outline (TODO)

- Location: `.claude/skills/hydra-target-adversarial/SKILL.md` (TBD).
- Frequency: nightly (operator-configurable via `/schedule`).
- Cost cap: < $0.50/night (mini-model, ~5 commits × ~3 files × ~2k tokens).
- Output: GitHub issues + Redis writes; never opens PRs directly.

## Open questions

- Should the skill auto-open PRs that add regression tests for high-confidence
  findings, or only file issues? (Default: file issues, let the next dev cycle
  pick them up.)
- How aggressively should precision tracking suppress the skill if precision
  falls below some threshold? (e.g., < 10% true positives over 14 days →
  pause + alert operator.)
- Should the prompt see the diff alongside the file content, or only the
  diff? (Old in-cycle version sent both, capped at ~5kb each.)

## References

- Issue #344 — Phase A removal of the in-cycle agent.
- Old implementation (deleted in #344): `src/adversarial.ts`,
  `src/post-merge.ts` step 8.7 block.
- Redis schema owner: `src/redis/adversarial.ts`.
