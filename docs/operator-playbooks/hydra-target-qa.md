---
name: hydra-target-qa
description: Independent QA for Target PRs — Standards on every PR, a Spec plus 2-reviewer adversarial fold on risk-critical changes, and a before/after visual QA pass on UI PRs; verdicts post as issue comments and hard findings bounce via the reframe label + ready-for-human.
when_to_use: "When a Target build opens a PR and needs an independent reviewer (today the executor grades its own work), the operator says 'QA the target PR', or hydra-autopilot dispatches Target QA."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Agent(*)
arguments: [pr_ref]
claude_only: true
---

# Hydra Target QA

The Target's first **independent reviewer**. Today the `hydra-target-build`
executor grades its own work — there is no second set of eyes, so
risk-critical betting-math and execution paths merge through the same shallow
gate (typecheck + test + emulated merge-on-green) as a copy tweak. This skill
closes that gap with a proportionate, depth-routed QA pass (issue #1055, parent
epic #1052).

It deliberately **does NOT** mirror the Orchestrator's heaviest machinery — the
T1–T4 Modification Tier ladder, Verifier Core, the live-gate invariant, the
deep-QA remediation loop, or per-merge Outcome Holdback. Those exist to stop the
Orchestrator from neutering its own verifier; a Target PR structurally cannot
break the builder, so that apparatus does not apply. What the Target gets here
is an independent reviewer plus an adversarial fold on the dangerous ~10% of
changes — and nothing more.

## Depth routing — the risk-critical flag

Verification depth is routed on the **risk-critical flag**
(`classifyRisk` in `src/target/risk-critical.ts`) — the single
organizing primitive shared by every Target gate. A path is risk-critical iff
it touches the Target's own declared risk surface: the classifier reads
`riskCritical.surface` from the Target's `.hydra/manifest.json` (epic #3014,
ADR-0026), so the specific betting paths (`src/lib/providers/`,
`src/lib/execution/`, `src/lib/staking/`, `src/lib/bet-math/`) are declared in
the **Target** repo, not hardcoded here.

| Path | Verification depth |
|------|--------------------|
| **safe** (UI / docs / config — ~90% of changes) | a SINGLE independent **Standards** pass |
| **risk-critical** (the Target manifest's declared risk surface) | **Standards + Spec + a 2-reviewer adversarial fold** — all must pass |

- **Standards** (every PR) — conventions, tests-present-and-non-empty, no
  silent catch, no unjustified touch of risk-critical paths, and — on any
  UI-touching PR — **render-robustness** (see below).
  - **Refactoring-smell battery (Martin Fowler, via upstream `code-review` v1.1).**
    Beyond the documented conventions, scan the diff for these twelve smells and
    **name each one you find** so the finding is actionable, applying them
    universally **unless a Target-documented standard overrides**: Mysterious
    Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession,
    Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality,
    Message Chains, Middle Man, Refused Bequest. Report a smell only where you can
    point at the specific hunk; do not invent speculative concerns.
- **Spec** (risk-critical only) — diff vs. the design-concept artifact for the
  work item (the lightweight Target artifact from #1056; absent → treat the
  Spec axis as a hard finding so the heavier gate never passes by omission).
- **Adversarial fold** (risk-critical only) — TWO independent reviewers, each
  prompted in **refutation framing** (actively find a reason this change is
  wrong / regresses something), neither told the other exists. The change
  passes only if **both** find no real blocker; a single real blocker from
  either is a FAIL.

The pure folding rule is `classifyTargetQaVerdict()` in
`scripts/target/target-qa-verdict.ts` — never re-derive the routing by hand.

## Render-robustness — pages degrade on data gaps, never throw

Every **UI-touching** PR (page/route components, server components, and their
data loaders) must clear the Target's **degrade-never-throw** convention on the
**Standards** axis: a route must **never `500` because of a data state**. When
data is missing, stale, or carries an **unknown enum value**, the page must
render a degraded state — a callout, an empty-state row, or a "data unavailable"
panel — instead of throwing. This is the Target sibling of the Orchestrator's
"never throw from merge/grounding/verification" convention.

- **Recurrence class this catches** — new venues, sports, providers, and other
  enum values **WILL** appear in production data before the UI knows them. A
  loader that trusts the data shape (unchecked enum switch, `.find(...)!`,
  non-null assertion on an optional row) is a latent `500` the first time an
  unexpected value lands. Treat any un-guarded assumption about data
  presence/shape on a render path as a **hard finding**.
- **Exemplar fixes** — Target backlog **item-737** (a missing reconciliation
  checkpoint that `500`ed the route) and **item-738** (an unknown sport key that
  `500`ed the route). Four live production routes `500`ed this way (epic #2732);
  the fixes render a degraded panel instead of throwing.
- **What Standards checks on a UI PR** — for each touched render path, confirm
  the loader/component tolerates: a missing row, an empty result set, a `null`
  or stale value, and an **unrecognized enum/discriminant** — each producing a
  visible degraded state, not an exception. A UI PR that adds or edits a render
  path without this tolerance is a hard finding (FAIL → bounce-to-reframe).

The authoritative statement of this rule lives in the Target repo's
`CLAUDE.md` / `web/AGENTS.md`; this checklist is how QA enforces it on every
UI-touching PR.

## Per-PR visual QA — screenshot the affected routes on UI-touching PRs

A UI-touching PR gets a **visual QA pass** on the **Standards** axis, over and
above the render-robustness check above: QA renders the affected routes in the
PR's own worktree, captures **before/after** screenshots, and reviews the
after-state against the Target design ADR
(`hydra-betting/docs/adr/0005-design-language.md`, epic #2732) — the ADR's
**[mechanical]** rules hard-verified, its **[judgment]** rules flagged in the
verdict comment for the operator's design read. **Non-UI PRs skip this step
entirely** — zero added cost on the common ~90% path (issue #2740).

### The UI-touching trigger

Run the visual pass **iff** the PR's changed paths (Target-repo-relative)
include a rendered surface — a page/route, a component, or a global style:

- `web/src/app/**` (App-Router pages, layouts, and their server components /
  loaders), OR
- `web/src/components/**` (shared render components, including
  `nav-registry.ts`), OR
- `web/src/app/globals.css` / the design tokens the ADR pins.

Any other PR (API routes under `web/src/app/api/**` that render nothing,
`web/src/lib/**`, tests, config, docs) is **not** UI-touching — skip the visual
pass and note `visual-qa: skipped (non-UI)` in the verdict so the skip is
auditable. Decide the trigger from the changed-path set only; never infer it
from PR size or description.

**Deriving the affected routes.** Map the touched files to the nav-registry
routes they render:

- a `web/src/app/<route>/**` change → that `<route>` (and any route whose layout
  it is);
- a `web/src/components/**` or `globals.css` change is **cross-cutting** — it can
  affect every page, so screenshot the **full** nav-registry route set (same set
  the slice-1 route-smoke suite renders), not a guessed subset.

### The screenshot procedure

Reuse the **slice-1 route-smoke Playwright helper** (issue #2733:
`web/e2e/route-smoke.spec.ts`'s per-route PNG capture, driven by
`npm run e2e:smoke` against a **seeded-empty** DB) — do NOT hand-roll a second
screenshot path. Capture **before** (base = `origin/main`) and **after**
(PR `HEAD`) for each affected route:

```bash
# In the PR's Target worktree. Non-UI PRs never reach this block.
AFFECTED=$(...)   # routes from the mapping above (or the full nav set for a cross-cutting change)

# BEFORE — base state
git stash --include-untracked >/dev/null 2>&1 || true   # or check out origin/main in a scratch worktree
ROUTES="$AFFECTED" SHOT_DIR=.qa-shots/before npm run e2e:smoke

# AFTER — PR HEAD state
git stash pop >/dev/null 2>&1 || true
ROUTES="$AFFECTED" SHOT_DIR=.qa-shots/after  npm run e2e:smoke
```

If the smoke helper is unavailable in the worktree (missing Playwright browser,
`e2e:smoke` script absent), record `visual-qa: unavailable (<reason>)` in the
verdict and fall back to the render-robustness static review — **never** silently
skip and report a clean visual pass. A UI PR whose affected route **`500`s or
logs a console error** in the after-capture is a hard finding (that is exactly
the four-live-`500` failure mode from epic #2732) → FAIL → bounce-to-reframe.

### Reviewing against the design ADR

Grade each after-screenshot against ADR-0005's decisions, respecting the ADR's
own **[mechanical]** vs **[judgment]** tags:

- **[mechanical] rules — hard-verify (a violation is a FAIL, bounce-to-reframe):**
  - a rendered nav source other than the four-tab `PortfolioShellNav` +
    `/system` index, or a nav-registry `href` containing a `#fragment`
    (decision 1);
  - a nav label that does not match its destination page's `h1` and is not in
    the ADR alias table (decision 4);
  - more than **4 top-level sections** on a page, or a rendered-HTML weight over
    the **100KB/route** ceiling (decision 3);
  - a section that renders **blank** instead of the shared `EmptyState` /
    degraded idiom in the seeded-empty capture (decision 5).

  These are the same rules the `nav-completeness` suite (#2737), the color-literal
  lint ratchet (#2738), and the route-smoke ceilings enforce in Target CI — QA
  re-checks them on the screenshot so a visual regression can't ride in on a
  green mechanical gate.

- **[judgment] rules — FLAG in the verdict comment, do NOT FAIL:** whether the
  page *looks* consistent with the hand-rolled idiom (spacing, hierarchy, pill
  usage — decision 2), whether each section actually serves the page's declared
  question (decision 3), and whether empty-state wording is honest (decision 5).
  These are the `design_qa_target` dispatch's remit (#2739) and the operator's
  design read — QA surfaces them with the screenshot but never blocks the merge
  on a judgment call. (Confidence-routing discipline: mechanical → block;
  judgment → surface.)

### The verdict on a UI PR

The Standards reviewer's verdict comment on a UI-touching PR **embeds the
before/after screenshots** (attach the PNGs or link the CI artifacts) and lists
**per-rule findings** — each mechanical rule marked PASS/FAIL, each judgment rule
flagged for the operator. A mechanical violation folds into the Standards axis as
a hard finding (FAIL → bounce-to-reframe, per the routing below); judgment flags
travel with the PASS/FAIL but never change it.

## Routing the outcome — bounce, never escalate

A hard finding from **any** consulted axis folds to a `FAIL` verdict whose
action is `bounce-to-reframe`: under ADR-0031 the reframe queue is now the
**`reframe` label** on the anchor issue (`gaberoo322/hydra-betting`), stamped
alongside `ready-for-human` so `hydra-target-review` surfaces it to the operator
on the next review (the label pair replaces the retired
`hydra:anchors:reframe-queue`). The QA **verdict itself is posted as a
`gh issue comment`** on the anchor issue and the `needs-qa` label is stripped —
mirroring the Orchestrator `hydra-qa` verdict-as-comment + relabel discipline.
There is **NO** deep-QA remediation loop and **NO** Verifier-Core teeth — those
are the containment gates epic #1052 explicitly declines to mirror for the
Target; the `reframe` + `ready-for-human` label pair is the *only* operator
surface, not a new escalation channel. A `PASS` verdict's action is `merge`: the
Target's normal merge-on-green path proceeds (this skill never merges directly).

## Process

### 1. Resolve the PR + changed paths

If `$pr_ref` is provided use it; otherwise resolve the PR the current Target
build opened. Collect the changed paths (repo-relative, Target repo):

```bash
# In the Target worktree, or via the PR API.
CHANGED=$(git diff --name-only origin/main...HEAD)
```

### 2. Classify the path

Feed the changed paths to `classifyTargetQaPath()` (or call
`classifyRisk` directly) to decide `safe` vs. risk-critical. Do NOT
infer the path from a hand-maintained pattern list — the classifier in
`src/target/risk-critical.ts` (which reads the Target manifest's
`riskCritical.surface`, ADR-0026) is the single source of truth. Note: the QA
verdict layer (`scripts/target/target-qa-verdict.ts`) still exposes its result
under the legacy `moneyCritical` field / `"money-critical"` path label — that
public shape is unchanged; only the underlying classifier is now the
manifest-sourced `classifyRisk`.

### 3. Run the reviewer sub-agents for the chosen path

- **safe** — one **Standards** reviewer sub-agent. Collect its `PASS` / `FAIL`.
- **risk-critical** — run, in parallel independent sub-agents:
  1. **Standards**,
  2. **Spec** (against the design-concept artifact),
  3. **adversarial reviewer A** (refutation framing),
  4. **adversarial reviewer B** (refutation framing, no shared context with A).

  Each returns `PASS` / `FAIL`. A reviewer surfaces a `FAIL` only on a **real
  hard blocker**, not a nit.

### 4. Fold the verdict

Pass the changed paths and the collected reviewer verdicts to
`classifyTargetQaVerdict()`. It returns `{ verdict, path, moneyCritical,
action, reason, matchedPaths }` (the `moneyCritical` field name is the layer's
unchanged legacy label for the risk-critical result; ADR-0026). The fold is
pure and total — a missing risk-critical-only verdict is treated as a FAIL
(defensive: an absent reviewer must never let the heavier gate pass by
omission).

### 5. Execute the routing

All routing is `gh` on the anchor issue (`gaberoo322/hydra-betting`) — REST-first
(`gh issue comment` / `gh issue edit`), never the retired Redis `hydra backlog` /
`/backlog` API. `$ANCHOR_NUM` is the anchor issue number the build claimed.

- `action: "merge"` — post the PASS verdict as an issue comment, strip `needs-qa`,
  and let the Target merge-on-green path proceed:
  ```bash
  REPO=gaberoo322/hydra-betting
  gh issue comment "$ANCHOR_NUM" --repo "$REPO" \
    --body "QA verdict: **PASS** ($PATH_TAKEN). $VERDICT_REASON"
  gh issue edit "$ANCHOR_NUM" --repo "$REPO" --remove-label needs-qa
  ```
- `action: "bounce-to-reframe"` — post the FAIL verdict as an issue comment, then
  stamp the reframe label pair so `hydra-target-review` picks it up. Do NOT escalate
  through any other channel and do NOT open a remediation loop.
  ```bash
  REPO=gaberoo322/hydra-betting
  gh issue comment "$ANCHOR_NUM" --repo "$REPO" \
    --body "QA verdict: **FAIL** ($PATH_TAKEN). Bounce-to-reframe: $VERDICT_REASON"
  gh issue edit "$ANCHOR_NUM" --repo "$REPO" \
    --remove-label needs-qa --add-label reframe --add-label ready-for-human
  ```

### 6. Report

Emit the folded `verdict`, the `path` taken, the `reason`, and (on
risk-critical) the per-axis reviewer verdicts. The verdict literal is
`PASS` / `FAIL` — there is no tier-pending machinery here (the Target's CI is a
single self-hosted runner with emulated merge-on-green, not the Orchestrator's
multi-check rollup).

## Invariants

- **Depth is routed only by the risk-critical flag** — never by PR size, file
  count, or a self-asserted level.
- **The fold lives in one pure function** — `classifyTargetQaVerdict()`,
  unit-tested in `test/target-qa-verdict.test.mts`. The playbook collects
  reviewer verdicts; it does not re-implement the AND/short-circuit logic.
- **FAIL bounces via the `reframe` + `ready-for-human` label pair. Never
  escalates.** The verdict posts as a `gh issue comment` and `needs-qa` is
  stripped; the only operator surface is the existing `hydra-target-review` drain
  of `reframe`-labelled issues (ADR-0031 — the label replaces the retired Redis
  reframe-queue).
- **Render-robustness is a Standards-axis requirement on every UI-touching PR**
  — a render path that can `500` on a missing/stale/unknown-enum data state is a
  hard finding. New venues/sports/enum values arrive in production before the UI
  knows them; the page must degrade, never throw.
- **Per-PR visual QA runs only on UI-touching PRs, and only its [mechanical]
  ADR rules block.** A UI PR is screenshotted (before/after, via the slice-1
  route-smoke helper) and graded against ADR-0005; a **[mechanical]** violation
  (nav spine, label↔h1, section/weight ceilings, blank-instead-of-empty-state) is
  a hard finding, while **[judgment]** findings are flagged for the operator and
  never change the verdict. Non-UI PRs skip the pass entirely (auditable
  `visual-qa: skipped`), so the common path pays zero added cost.
- **No deep-QA remediation loop, no Verifier-Core checklist, no Outcome
  Holdback** — those are Orchestrator self-modification-containment gates the
  Target structurally does not need (epic #1052 rationale).

## References

- Issue #1055 — this skill (independent Target QA).
- Parent epic #1052 — selectively converge the Target SDLC with the
  Orchestrator's build-quality machinery.
- `src/target/risk-critical.ts` (issue #1053, renamed in #3017) — the
  risk-critical classifier (`classifyRisk`, reads the Target manifest's
  `riskCritical.surface` per ADR-0026) this skill routes on.
- ADR-0026 / epic #3014 — the Target Manifest that declares each target's own
  `riskCritical.surface` and `verify` commands.
- `scripts/target/target-qa-verdict.ts` — the pure verdict fold.
- `scripts/ci/qa-verdict.ts` — the Orchestrator's analogous one-pass verdict
  classifier (the shape this skill mirrors, minus the tier ladder).
- `docs/operator-playbooks/hydra-target-review.md` — drains the `reframe`-labelled issues.
- Issue #2734 / epic #2732 — the render-robustness (degrade-never-throw)
  convention and the four live-`500` routes that motivated it; exemplar fixes
  item-737 (missing reconciliation checkpoint) and item-738 (unknown sport key).
- Issue #2740 / epic #2732 — the per-PR visual QA pass this section defines.
- `hydra-betting/docs/adr/0005-design-language.md` — the Target design-language
  rubric (operator-grilled, #2736) whose **[mechanical]** rules this pass
  hard-verifies and whose **[judgment]** rules it flags.
- Issue #2733 — the slice-1 route-smoke Playwright suite + per-route screenshot
  helper (`npm run e2e:smoke`) this pass reuses; #2737 (nav + label checks) and
  #2738 (color-literal lint ratchet) are the CI arms of the same rubric.
- Issue #2739 — the low-cadence `design_qa_target` dispatch that owns the
  **[judgment]** ADR review across all routes (the periodic sibling of this
  per-PR pass).
