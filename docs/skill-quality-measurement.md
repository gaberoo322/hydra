# Skill-quality epic #2944 — measurement (before / after)

> One-shot verification slice (issue #3008) for epic **#2944**. Read-only measurement over
> existing git history + live metrics endpoints — no `src/`, `scripts/sync-skills.sh`, CI, or
> `SKILL.md`/playbook file is modified by this slice. The recurring shrink-only enforcement is
> the #2946 size ratchet (`scripts/ci/skill-size-ratchet.ts`); this doc closes the epic on
> **evidence** rather than the original **assertion** that trigger hygiene + structure split +
> pruning are "direct, recurring cost reductions on the Orchestrator's largest token surface."

## What was measured, and how

- **Unit:** word count of the **generated** `~/.claude/skills/<name>/SKILL.md` — the artifact
  actually loaded into each dispatch's context window — using the #2946 ratchet's
  `countWords()` definition (`text.split(/\s+/).filter(w => w.length > 0).length`).
  Scope = the **34** playbook-generated `hydra-*` skills; upstream mattpocock skills excluded.
- **NOT** the `#2946` `scripts/ci/skill-size-baseline.json`, which counts the **source**
  playbooks + `_fragments/`, not the generated surface — that file is a cross-check only, not
  the before-numbers for this deliverable.
- **Before/after git points:**
  - **Before = `b3fa7a1`** — the parent of the first epic PR (`7ecfb65`, PR #2968, closes
    #2945). This is the true pre-epic tree.
    **Correction to the issue body:** the issue cited `ac03176` ("before PR #2983"), but
    `ac03176` **is** the #2983 merge (closes #2947) — itself *inside* epic #2944. Using it
    would under-count the delta by excluding the #2945/#2946/#2947 shrinks.
  - **After = current `master` `HEAD`.**
- **Method:** regenerated both skill sets from a clean worktree via `scripts/sync-skills.sh`
  (`CLAUDE_SKILLS_DIR=<tmp>`) at each ref, then counted `SKILL.md` per skill. The live
  `~/.claude/skills` (current master) was used to spot-verify the after-numbers.
- **Reconciliation:** the operator-seeded numbers land exactly — `hydra-target-build`
  12,212 → 4,696, `hydra-autopilot` 9,795 → 4,905, `hydra-dev` 8,328 → split,
  `hydra-cleanup` 8,220 (largest remaining).

## 1. Word-count delta (`SKILL.md`, per-dispatch context surface)

| skill | before (`b3fa7a1`) | after (`master`) | Δ words | Δ % |
|-------|-------:|------:|--------:|-----:|
| `hydra-dev` | 8,328 | 799 | **−7,529** | −90.4% |
| `hydra-target-build` | 12,212 | 4,696 | **−7,516** | −61.5% |
| `hydra-autopilot` | 9,795 | 4,905 | **−4,890** | −49.9% |
| `hydra-architect` | 1,074 | 936 | −138 | −12.8% |
| `hydra-wire-or-retire` | 2,619 | 2,552 | −67 | −2.6% |
| `hydra-design-qa` | 1,136 | 1,074 | −62 | −5.5% |
| `hydra-auto-merge-window` | 2,045 | 1,990 | −55 | −2.7% |
| `hydra-target-cleanup` | 1,943 | 1,895 | −48 | −2.5% |
| `hydra-architecture-scan` | 3,888 | 3,858 | −30 | −0.8% |
| `hydra-prd` | 1,942 | 1,913 | −29 | −1.5% |
| `hydra-grill` | 2,801 | 2,779 | −22 | −0.8% |
| `hydra-target-qa` | 2,379 | 2,362 | −17 | −0.7% |
| `hydra-tool-scout` | 3,435 | 3,418 | −17 | −0.5% |
| `hydra-branch-prune` | 5,967 | 5,954 | −13 | −0.2% |
| `hydra-pr-rebase` | 1,279 | 1,266 | −13 | −1.0% |
| `hydra-epic-close` | 1,100 | 1,089 | −11 | −1.0% |
| `hydra-cleanup` | 8,229 | 8,220 | −9 | −0.1% |
| `hydra-skill-prune` | — | 1,299 | new (#2949) | — |
| _16 other `hydra-*` skills_ | _unchanged_ | | 0 | 0% |
| **TOTAL (34 skills)** | **98,087** | **78,920** | **−19,167** | **−19.5%** |

**The epic's value is concentrated in three skills** — `hydra-dev`, `hydra-target-build`,
`hydra-autopilot` — which account for **−19,935 words**, i.e. essentially the *entire* net
reduction. The other 30 skills are near flat (the +1,299 `hydra-skill-prune` addition and
~19 trivial trims roughly cancel to a small net).

### Nuance — the `hydra-dev` "−90.4%" is a structure split, not a deletion

`hydra-dev` was split into a small `SKILL.md` (799 words, always loaded) plus two on-demand
reference files loaded via progressive disclosure:

| file | words | load |
|------|------:|------|
| `hydra-dev/SKILL.md` | 799 | every dispatch |
| `hydra-dev-parent-flow.md` | 2,393 | on demand |
| `hydra-dev-child-flow.md` | 1,704 | on demand |
| on-disk total | 4,896 | — |

So `hydra-dev` went 8,328 → 4,896 words **on disk** (−41%), but only **799 words load
up-front** per dispatch (−90.4% of the always-on context surface). This is the real
mechanism of the epic's saving: the always-loaded surface shrank far more than the total
prose, because the bulk moved behind progressive disclosure. The −19,167 total above counts
the **always-loaded `SKILL.md`** surface, which is the correct unit for the "per-dispatch
context cost" claim.

## 2. Recurring token-cost estimate

**Data source correction:** `GET /api/cost/by-class` returns **HTTP 404** (the dedicated
endpoint does not exist). The equivalent data lives inside **`GET /api/metrics`** as the
`costByClass` block, plus `GET /api/scheduler/status` for cadence. This slice uses those.

**Stated assumptions** (order-of-magnitude, per acceptance criteria):
- **~1.3 tokens per whitespace word** (typical English-prose tokenizer ratio).
- The `SKILL.md` body is loaded **once per dispatch** of the class that owns it.
- Dispatch cadence: `/api/scheduler/status` → autopilot ticks every **15m**; `cyclesRun`
  7,886 lifetime. Per-class dispatch/day is derived below from the live 24h `costByClass`
  totals (`/api/metrics`, window `2026-07-07 + 2026-07-08`, `totalTokens` = 181.85M) divided
  by `tokensPerMergedPR` = **1,552,301** as a per-full-dispatch proxy.

### Per-dispatch context saving (the three material skills)

| skill (class) | Δ words | ~tokens saved / dispatch |
|---------------|--------:|--------:|
| `hydra-autopilot` (autopilot loop) | −4,890 | ~6,360 |
| `hydra-dev` (dev-orch) | −7,529 | ~9,790 |
| `hydra-target-build` (dev-target) | −7,516 | ~9,770 |

### Per-day rough saving

Using the live 24h `costByClass` totals to estimate dispatch frequency per class:

| class | 24h tokens (live) | ~full-dispatch-equiv / day | Δ tokens / dispatch | ~tokens saved / day |
|-------|------------------:|---------------------------:|--------------------:|--------------------:|
| dev-orch (`hydra-dev`) | 14,395,369 | ~9 | ~9,790 | **~88,000** |
| dev-target (`hydra-target-build`) | 19,960,000 | ~13 | ~9,770 | **~127,000** |
| autopilot loop (`hydra-autopilot`) | — (single long-running session) | ≥1 reload/tick, 96 ticks/day @15m | ~6,360 | **~6,400 – 610,000**¹ |

¹ The autopilot session's SKILL.md is loaded at least once at launch; whether it re-loads per
15m tick or per pace-gate relaunch is model/harness-dependent. Lower bound = one load/day
(~6,400 tok); if reloaded each of the ~96 ticks/day the ceiling is ~610,000 tok/day. The
honest figure is "**~6k – ~600k tok/day for autopilot, and ~215k tok/day combined for the two
code-writing classes**."

**Bottom line (order-of-magnitude):** the epic removes on the order of **~0.2 – 0.8 million
input tokens per day** of always-on context across the three high-frequency skills — a real,
recurring reduction, though small relative to the ~182M **total** daily token spend (i.e.
**well under 1%** of total). The saving is a **context-hygiene / signal-density** win (less
prose to distract the model, faster load, lower always-on floor), **not** a headline cost
lever. The dominant token spend is generation (qa 44%, research 36%), which this epic does not
touch.

## 3. Quality-regression check

**No holdback signal is available.** The T2 Outcome-Holdback path requires an autopilot-owned
`POST /api/holdback/enroll` per T2 merge, but:
- The epic edits are skill-source prose changes (T1 prompt-shaped → T2 skill-shaped); **no
  holdback enrollment was recorded** for the epic PRs. `GET /api/holdback` / `.../status`
  both return 404 — there is no queryable holdback state for these edits.

**Fallback — retro / merged-rate trend since the epic merged** (epic PRs merged
2026-07-05 → 2026-07-07):
- `GET /api/scheduler/status` (2026-07-08): **`mergeRate` = 94%** over the last-50-cycle
  window; `emptyRate` = 6%; `consecutiveErrors` = 0; `lastError` = null.
- `GET /api/metrics`: `mergedRate` **95%**, `regressionRate` **0%**, `falseCompletionRate`
  **0%**, `verifiedCompletionRate` **100%** over the recent cycle window.

No dispatch-quality degradation is attributable to the skill edits: merge/verified-completion
rates are healthy and regression rate is zero across the cycles since the epic merged. This is
**best-available** evidence (rate trend), **not** a controlled holdback A/B — the skill edits
were never holdback-enrolled, so a causal "no-harm" claim cannot be made; the observational
signal is simply that nothing regressed.

## 4. Residual finding — largest un-split skills remaining

Top generated `SKILL.md` on current master:

| skill | words | touched by epic? |
|-------|------:|:----------------:|
| `hydra-cleanup` | **8,220** | no |
| `hydra-qa` | 7,039 | no |
| `hydra-branch-prune` | 5,954 | trivially (−13) |
| `hydra-autopilot` | 4,905 | yes (−49.9%) |
| `hydra-target-build` | 4,696 | yes (−61.5%) |
| `hydra-architecture-scan` | 3,858 | trivially |
| `hydra-tool-scout` | 3,418 | trivially |
| `hydra-doctor` | 3,187 | no |

**`hydra-cleanup` (8,220 words) is the single largest remaining surface** and was untouched by
the epic — it is now the largest always-on skill, ahead of the two the epic deliberately
shrank. **`hydra-qa` (7,039)** is the second, and it is also the **highest-token class**
(qa ≈ 44% of daily spend per `costByClass`), so trimming its always-on prose has the best
frequency-weighted payoff of any remaining skill.

**Recommendation:** do **not** file bespoke split issues. Feed `hydra-cleanup` and
`hydra-qa` to the recurring **`skill_prune`** class (shipped #2949 / PR #2984,
`hydra-skill-prune`), which is the eval-gated recurring pruner and the correct home for this
follow-up. Actually splitting any skill is **out of scope** of this measurement slice.

## Conclusion — does the epic close on evidence?

**Yes.** The epic delivered a **−19,167-word (−19.5%)** reduction in the always-loaded
generated-skill surface, concentrated in the three highest-frequency skills (dev-orch,
dev-target, autopilot), via structure-split + trigger-hygiene + pruning. The recurring saving
is real but modest (**~0.2–0.8M input tok/day, <1% of total spend**) — its value is
**context-density / signal hygiene**, not a top-line cost lever. No quality regression is
observed in the post-merge rate trend (holdback A/B was not available). The follow-up lever is
`skill_prune` on `hydra-cleanup` (8,220) and `hydra-qa` (7,039, highest-token class).

---
*Generated by issue #3008 (dev_orch), 2026-07-08. Read-only measurement; regenerated skill
sets from `b3fa7a1` vs `master` via `sync-skills.sh`, counted with the #2946 `countWords`
definition. Token figures are order-of-magnitude with assumptions stated inline.*
