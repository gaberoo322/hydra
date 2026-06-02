---
status: accepted (extends ADR-0015; amends ADR-0005's closed list)
---

# Deep-QA PASS marker gates T4 auto-merge

ADR-0015 declared that **T4 (Verifier Core) auto-merges once it clears T3 + the deep-QA remediation loop + the Live-Gate Invariant** — but it never specified *how a passed deep-QA review becomes legible to the merge gate*. The half-built state this left (issue #743) made the gap concrete:

- `decide.py`'s `should_auto_merge()` returns `hold` for T4, with the docstring *"Once #740/#743 land, the T4 arm flips to auto-merge on a proven deep-QA pass."*
- The CI `tier-gate` still hard-blocks any Verifier-Core PR lacking the `operator-approved` label.
- `should_auto_merge` only ever sees `qa_verdict="PASS"` — it **cannot distinguish a deep-QA T4 PASS from a shallow PASS.** #740 deliberately added *"no new verdict literal, no new label — the PR is the ledger"* (the negative `Verifier-Core deep-QA: FAIL` marker), so there is no positive signal that the T4 deep branch ran.

Naively flipping the T4 arm to `auto-merge` on a bare PASS would let a T4 PR merge on a *shallow* review — defeating the entire deep-QA gate and violating INV-001. The missing piece is a **proof that the deep-QA branch ran against this code**, and a gate that enforces it.

## Decision

1. **A positive `Deep-QA PASS marker` is the proof.** On a T4 PASS, `hydra-qa` posts a PR comment of the exact form `Verifier-Core deep-QA: PASS @ <head-sha>`. It is the PASS counterpart to the existing `Verifier-Core deep-QA: FAIL` marker — the **same PR-as-ledger surface** #740 already blessed (no new verdict literal, no new Redis key, no new label). It enters the glossary via the **Glossary delta** below, landed in `CONTEXT.md` by this `ubiquitous-language`-labelled ADR PR (#852) per the `docs/agents/domain.md` WRITE contract — a separate PR from the code, never inline on `master`; the Slice 1 (#847) code PR declares `Glossary impact` rather than editing the glossary.

2. **The marker is SHA-bound; this is bug-defense, not adversary-defense.** The gate requires a marker matching the PR's *current* head SHA, so pushing new commits after a pass invalidates the marker and forces re-QA — the proof attests deep-QA passed against *exactly the merged code*. Because all agents share one GitHub identity (`gaberoo322`), the marker cannot be author-verified and is forgeable by a same-identity agent; it defends against the realistic threat (a bug/hallucination merging T4 without deep review), not an adversarial PR. A separate QA bot identity is the future hardening, filed as a non-blocking follow-up.

3. **The plane split: `decide.py` trusts, CI enforces.** `should_auto_merge` is a pure function over the `qa-verdict` event — it has no access to PR comments and must stay pure. So its T4 arm flips to `auto-merge` on `qa_verdict==PASS`, identical in shape to T3, *trusting* that the skill ran the deep branch. The independent enforcement lives entirely in CI: a required `deep-qa-gate` check verifies the SHA-bound marker. If the marker is absent — skill bug, forged PASS event, a `ci.yml` that tried to drop the check — the required check fails and branch protection blocks the merge. The merge **fails closed** even when `decide.py` emitted `auto-merge`.

4. **The gate is a separate `issue_comment`-triggered workflow (`deep-qa-gate.yml`).** A `pull_request`-triggered job cannot work: `tier-gate` runs at PR-open time, *before* QA posts the marker, so it would be permanently red. Triggering on `issue_comment` (filtered to `github.event.issue.pull_request`) re-evaluates when QA posts the marker comment, flipping the check green. GitHub runs `issue_comment`-triggered workflows from the **default branch's** copy of the file, never the PR head — so the gate logic is **base-ref-protected for free**, with zero base-ref-extraction code (the Live-Gate Invariant, handed to us by the platform). `deep-qa-gate.yml` is added to `VERIFIER_CORE_PATHS` so its `pull_request`-triggered arm is also tier-protected.

5. **INV-001 is retired; the T4 backstop relocates from brain to gate.** `INV-001` (*"never auto-merge a T4 Verifier-Core PR"*) is a plan-level guard in `assert_invariants.py`. Once T4 *may* auto-merge and `decide.py` cannot see the marker, INV-001 can no longer do its job — a defense that cannot see the thing it defends is theater, and the only sound version of it (assert `qa_verdict==PASS`) is already `INV-007`. The T4 depth guarantee moves to the base-ref `deep-qa-gate` check + retained `INV-007`. This is consistent with CLAUDE.md's *"CI is the merge gate, never an in-cycle check"* and ADR-0015's *"tier names depth, not merge authority."*

6. **`operator-approved` is retired as the routine T4 gate.** The label survives only as the operator-only emergency brake (#744), not as a per-PR merge requirement — a correction to ADR-0005's closed list, which named "T4 / Verifier-Core changes" as an operator-escalation destination. Routine T4 merges are now fully autonomous; the only surviving operator route is an exhausted deep-QA remediation loop (#740).

7. **Two ordered slices, with one ordering invariant.** The change lands additive-first:
   - **Slice 1 (additive):** **(A1)** marker emission (`hydra-qa`) + **(A2)** `deep-qa-gate.yml` + add to `VERIFIER_CORE_PATHS` + operator adds `deep-qa-gate` to branch-protection required checks. Result: T4 is *tighter* (label **and** marker). No unlock.
   - **Slice 2 (atomic flip, = re-scoped #743):** **(F1)** drop the `operator-approved` block (`live-gate.sh`/`tier-gate`) + **(F2)** flip `should_auto_merge` T4 arm + **(F3)** retire INV-001 — all in one PR.
   - **Ordering invariant: the `deep-qa-gate` required check must be live before the `operator-approved` block is dropped**, else a window opens where a T4 PR merges with *neither* gate. **F2 (decide.py flip) and F3 (INV-001 retirement) are mandatorily atomic** — an un-retired INV-001 rejects the autopilot plan the instant decide.py emits a T4 auto-merge.

## Considered options

- **Trust-by-construction, no marker (Option A).** Flip the T4 arm on a bare PASS, trusting the skill ran the deep branch for `tier==4`. Rejected: gives no independent check; a buggy skill or forged event merges T4 shallow with nothing to catch it.
- **`deep_qa: true` field on the `qa-verdict` event (Option C).** Rejected: `decide.py` trusts the emitter regardless, so it is Option A with extra plumbing — and it is a new event surface, unlike a PR-comment marker.
- **Marker as a commit status / check-run, not a comment.** Rejected: a tier-conditional *required* status can't be expressed in branch-protection config alone (it would block all non-T4 PRs waiting on a check that never reports), so a reporting job is needed anyway — and the comment + `issue_comment` trigger is the cleaner shape that also gives base-ref-for-free.
- **Keep a weakened INV-001.** Rejected: the only sound assertion left (`qa_verdict==PASS`) is exactly INV-007 — redundant.
- **One coordinated PR doing all five edits.** Rejected: a single T4 mega-diff is harder to QA deeply, and it cannot establish the A2-before-F1 ordering within itself (the required-check config is an out-of-repo operator step between the slices).
- **Block on a separate QA bot identity first.** Rejected: solves a threat this single-operator system does not have, and would gate the unlock on unrelated infra.

## Consequences

- T4 (Verifier Core) gains a fully autonomous merge path: a proven deep-QA pass + the deterministic CI depth (mutation floor #778, base-ref Live-Gate #738) auto-merges with no human label.
- The T4 safety backstop is now a base-ref-protected CI check, not a brain-side invariant — harder to misconfigure-away (you cannot ship a head-ref `ci.yml`/`deep-qa-gate.yml` that neuters it) but no longer independent of CI.
- New surfaces: the `Verifier-Core deep-QA: PASS @ <sha>` marker contract (a greppable string — changing it is a breaking change to both `hydra-qa` and the gate), and `.github/workflows/deep-qa-gate.yml` (a required check + a Verifier-Core path).
- `INV-001` is removed from `assert_invariants.py`; `INV-007` is retained and becomes the sole brain-side merge guard.
- Forgeability is an accepted, documented limitation (Decision 2); the QA-identity hardening is a tracked follow-up.
- Implementation tracked across Slice 1 (#847) and Slice 2 (#743).

## Glossary delta

Landed in the root `CONTEXT.md` by this `ubiquitous-language`-labelled PR (#852), per the `docs/agents/domain.md` WRITE contract (the glossary/ADR delta ships in a separate PR from the code; the Slice 1 code PR #847 declares `Glossary impact` instead of editing the glossary).

**Deep-QA PASS marker**:
The positive, SHA-bound proof that a **T4** PR cleared the deep-QA branch: a PR comment of the exact form `Verifier-Core deep-QA: PASS @ <head-sha>`, posted by `hydra-qa`'s T4 PASS path. It is the PASS counterpart to the `Verifier-Core deep-QA: FAIL` ledger marker — same PR-as-ledger surface (no new verdict literal, Redis key, or label). The `deep-qa-gate` required check verifies a marker matching the PR's *current* head SHA before a T4 PR may merge; pushing new commits invalidates a stale marker and forces re-QA. It is **bug-defense, not adversary-defense** — all agents share one GitHub identity, so the marker proves the deep branch ran in the normal flow but is forgeable by a same-identity agent (a separate QA identity is the future hardening, #848). Replaces the operator-approved-label block as the T4 merge gate.
_Avoid_: operator-approved (retired as the T4 gate), deep-QA verdict (it is a ledger marker, not a `FinalVerdict` literal)

## Related

- ADR-0015 — the tier model this extends; defined "T4 = T3 + deep-QA remediation loop + Live-Gate Invariant" without the proof mechanism.
- ADR-0005 — operator-escalation closed list; this amends it (operator-approved retired as the routine T4 gate).
- ADR-0001 — the gate is its own module verified by the live gate; the `issue_comment` base-ref-for-free property is the same principle.
- Issues #738 (Live-Gate Invariant), #740 (deep-QA remediation loop + FAIL marker), #742/#825 (policy collapse), #744 (emergency brake), #778 (T3 mutation floor), #743 (Slice 2).
