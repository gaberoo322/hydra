---
name: hydra-tool-scout
description: Scout for new tools/libraries/skills that would amplify Hydra's autonomous coding leverage. Discovers candidates in a named category, filters them through a three-gate rubric (AI-leverage score, maintenance gate, dedup seen-list), and files GitHub issues for the survivors.
when_to_use: "When the operator says 'scout tools' or wants to discover new tooling that would make the AI agents faster, safer, or more capable in a specific category."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) WebFetch(*) WebSearch(*)
arguments: [category]
claude_only: true
---

# Hydra Tool Scout (Phase A — manual)

Hydra is an AI-built system. Its long-term throughput is bounded by how legible the world is to its agents: typed schemas beat docstrings, deterministic builds beat heisenbugs, machine-readable spans beat raw stdout. **`hydra-tool-scout` is the skill that goes looking for tools that make Hydra's agents more leveraged**, files structured proposal issues, and remembers what it has already considered so it doesn't re-propose the same tool twice.

Phase A (issue #484) ships the scaffolding only:

1. This playbook (taxonomy of where to look, rubric for what's worth filing, output schema).
2. The taxonomy doc (`docs/ai-leverage-categories.md`) — the closed list of categories the scout walks.
3. The rubric doc (`docs/ai-leverage-rubric.md`) — the 1–5 AI-leverage scale, with worked examples.
4. The Redis seen-list (`src/scout/seen-list.ts`) — so re-runs don't re-propose `react-query` every time.
5. Manual invocation only — `/hydra-tool-scout <category>`. **No autopilot wiring, no cron.** Phase B adds those, after the operator has confirmed the issue quality on at least one category.

Phases B/C/D (alert subscriptions, calendar walk, gap-driven triggers) are deferred — see the parent epic #483 and the "Out of scope" section below.

## When NOT to run this

- Without a category argument. The scout is a depth-first walker, not a breadth-first one — it expects to be pointed at one taxonomy entry per invocation.
- When the orchestrator board is already saturated with proposal-grade issues (>20 open `enhancement` issues). The operator should drain the queue before adding more.
- (Phase A only — see Phase B below.) ~~From an autopilot loop.~~ Phase B (issue #485) wires this into the autopilot as the `scout_orch` signal class. The autopilot dispatch passes `trigger: "calendar"` in `prompt_args`; manual invocations still use `trigger: "manual"`.

## Inputs

| Input | Source | Notes |
|---|---|---|
| `category` (positional arg) | Operator | Must be one of the slugs in `docs/ai-leverage-categories.md`. Reject anything else — the rubric is calibrated per category and freeform input would dilute it. |
| Trigger source | Implicit | Phase A: `"manual"`. Phase B adds `"calendar"`. Phase C (issue #486) adds `"alert"`. Phase D will add `"gap"`. Recorded on every seen-list entry. |
| Seen-list | `hydra:scout:tools-considered:*` | Read before discovery to skip anything in cooldown. |

## Process

### 0. Resolve category from trigger (Phase B/C)

The skill is invoked in three modes:

1. **Manual** (operator typed `/hydra-tool-scout typed-schemas`) — `category` arg is required.
2. **Calendar** (`prompt_args: {"trigger": "calendar"}`) — no category arg; read `/api/scout/alert-plan` first (to honor failure pain before calendar cadence), and if empty, fall back to `planWalk()` from `src/scout/calendar-walk.ts` and iterate the eligible list.
3. **Alert** (`prompt_args: {"trigger": "alert"}`) — no category arg; read `/api/scout/alert-plan`, iterate `eligible[]` and dispatch one scout per `(pattern, category)` pair. After each dispatch, POST the outcome to the audit trail via `recordDispatch()` (in `src/scout/alert-listener.ts`) so the per-pattern/per-category cooldown stamps land and `hydra:scout:dispatches` gets the audit XADD.

When invoked in alert mode, the skill MUST record every dispatched target's outcome (filed/dropped/error). Skipping the bookkeeping leaves the dedup keys stale and the audit trail will undercount.

### 1. Validate category

Read `docs/ai-leverage-categories.md`. The H2 headings (with stable slugs in their anchor) are the closed list. If `$category` is not one of them, exit with a clear error: `unknown category: <category>. Valid slugs: ...`. **Do not invent categories.** Adding a new category is an operator action — propose it as a PR to `docs/ai-leverage-categories.md`, don't auto-extend.

### 2. Discover candidates

For the given category, sweep these sources (cheapest first, stop once you have ≥5 candidates):

1. **Curated lists** the category doc points at (awesome-* repos, vendor matrices). Cheapest signal — these are pre-filtered by humans who care about the same problem.
2. **GitHub topic search** (`https://github.com/topics/<tag>`) for the topic tags the category doc declares as canonical.
3. **npm registry search** (`npm search <keyword>`) — orchestrator and dashboard are Node/TS, so npm is the primary distribution channel. Skip for non-Node categories (e.g. LSP tooling, language-level work).
4. **Web search** (broad terms, last 12 months) — last resort. Spends tokens; cheaper sources first.

Each candidate is a `{ name, slug, homepage, repo, npmName?, oneLineDescription }` record. Canonicalize the slug via `src/scout/aliases.ts:canonicalizeSlug()` BEFORE adding to the working set — `@tanstack/query` and `tanstack-query` must collapse to one entry.

> **Discovery quota:** 5 candidates per category is enough. If the source pool is genuinely sparse, file what you have and note the gap in the issue body — don't pad with bad candidates.

### 3. Filter pipeline (AND-gated criteria)

Each surviving candidate is the *intersection* of the gates below. Fail any → drop from the working set AND record the rejection in the seen-list with `decision: "rejected"` and the failing-gate reason. Gates 1–3 are the original leverage/maintenance/dedup screen; Gate 4 is the **lane-reconciliation screen** added after the 2026-06-13 scout wave filed issues that the implementer had to re-architect or decline downstream (see #1882). The leverage/maintenance/dedup screen is still strictly AND — Gate 4 does not relax it; it shapes HOW a surviving candidate is filed so the implementer doesn't burn a research+correction cycle.

#### Gate 1: AI-leverage score ≥ 4

Apply the rubric in `docs/ai-leverage-rubric.md`. Score the tool 1–5 against the criteria for **its category** (the rubric is category-aware). Tools scoring 1–3 are rejected. A 4 means "this would noticeably improve agent throughput or safety in a measurable way." A 5 means "agents are currently working around the absence of this tool."

Capture the score, the per-criterion reasoning, and the rubric version (the rubric doc has a `version:` line in its frontmatter — record it so we can re-score historical entries when the rubric changes).

#### Gate 2: Maintenance gate

The tool must clear ALL of:

- ≥ 500 GitHub stars OR ≥ 50k weekly npm downloads OR endorsed in ≥ 2 awesome-lists in the category.
- A commit to the default branch within the last 90 days.
- No unaddressed CVE in the last release.
- License compatible with our stack (MIT, Apache-2.0, BSD, MPL, ISC — reject GPL/AGPL/SSPL/BSL).

**Verify the license from the registry, not the README/landing page.** For an npm-distributed tool run `npm view <npmName> license` and stamp the *verified* SPDX value into the issue; for a non-npm tool read the `LICENSE` file in the repo's default branch. The README or marketing site is not authoritative — a 2026-06-13 scout filed Apache-2.0 for `@probelabs/probe` when `npm view` reported ISC, and the implementing dev burned a cycle reconciling it. Record HOW you checked (e.g. `npm view @probelabs/probe license` → `ISC`) in the Maintenance signals block so the dev can trust it without re-checking.

The thresholds are tuned for Phase A — we expect the operator to revise them after the first smoke test in research question #2 (issue body).

#### Gate 3: Dedup seen-list

Check `hydra:scout:tools-considered:<canonical-slug>` via `seenList.getSeen()`. If a record exists and `seenList.eligibleForReEval()` returns `false`, drop the candidate **without** filing an issue but DO update `lastChecked` so we have a heartbeat for the cooldown.

Re-eval is eligible when ANY of:
- `decision: "rejected"` AND `filedAt` is more than 90 days old.
- `decision: "filed"` AND the linked GitHub issue is `closed` AND was closed with `wontfix` more than 90 days ago.
- `reEvalAt` is set and the timestamp has passed (the operator can force an earlier re-eval — e.g. when a major version ships).
- `decision: "filed"` AND the linked GitHub issue is still open (this is a stale heartbeat refresh — skip filing, refresh `lastChecked`).

#### Gate 4: Lane reconciliation (file-shaping, not a leverage screen)

A candidate that clears Gates 1–3 is worth filing, but the issue MUST land already reconciled against this repo's constraints so the implementing `hydra-dev` doesn't have to detect and fix the same three defect classes downstream. Before filing, reconcile each of:

1. **No-dependency lane (ADR-0005 / allow-scripts).** Runtime deps are a closed operator-approved allowlist (`express`, `ioredis`, `ws`, `@sentry/node`, `zod`); dev deps that run install scripts trip the lavamoat allow-scripts gate. If the tool would require adding a runtime or dev dependency, **do not file an issue that proposes `npm install`** — instead propose the pinned-`npx` (or pinned pre-built binary) wrapper path up front, exactly as `ast-grep` / `comby` / `probe` / `promptfoo` are integrated (see CLAUDE.md "Structural code search"). If the tool *cannot* run via `npx`/standalone binary and *must* be a dependency, either (a) the issue is for the operator to approve the dep — say so explicitly and label accordingly — or (b) reject the candidate with reason `no-dep-lane-incompatible`. A 2026-06-13 scout proposed a plain dependency against this lane and the dev had to re-architect it as a pinned-`npx` wrapper; another (`evalite`) was rejected outright because it hard-requires a vitest devDep that trips allow-scripts. Never leave this to the implementer.

2. **Superseded-premise check.** Reconcile the candidate against recently-merged tooling, not just the seen-list cooldown. Skim the last ~30 days of merged tool-scout PRs and the seen-list `decision: "filed"` entries: if a recently-merged tool already delivers this candidate's niche, the candidate is **superseded** — reject it with reason `premise-superseded-by-<slug>` (cite the merged PR/issue) rather than filing a duplicate the dev will decline. (`evalite` was superseded by `promptfoo` #1806, merged one day prior; the dev declined it and delivered the niche on the existing lane — a cycle the scout could have saved.) The seen-list dedup (Gate 3) only catches the *same* tool; this gate catches a *different* tool covering an *already-covered* niche.

3. **Real CLI / API contract.** Run the tool once (or read its `--help` / API reference) and record the actual invocation contract — the real `--format`/`--json` flags, the scorer/callback signature, the output schema — in the issue's "Proposed integration" block. Do NOT leave the dev to reverse-engineer it empirically (the 2026-06-13 wave shipped issues that omitted probe's JSON schema and promptfoo's two-arg file-scorer signature, so the dev discovered them by trial). One verified command line in the issue saves a discovery loop.

### 4. File an issue per survivor

For each candidate that clears all three gates, file a GitHub issue with the schema below and record `decision: "filed"`, `issueNum`, `filedAt` to the seen-list.

```markdown
# tool-scout: <Tool Name> — <category>

> Filed by `/hydra-tool-scout` on <ISO date>. AI-leverage score: <N>/5 against rubric <version>.

## What it is

<one paragraph — what the tool does, who built it, what its actual primitive is>

## Why this would help Hydra

<3–5 bullet points, each tying back to a real agent pain we've observed.
e.g.: "hydra-dev agents currently have to chase down type errors by reading
runtime stack traces in journalctl — a typed schema gateway would surface
contract violations at PR time.">

## AI-leverage rubric

| Criterion | Score | Reasoning |
|---|---|---|
| Surfaces structured signal | 5 | <why> |
| Reduces blast radius of agent edits | 4 | <why> |
| Determinism / reproducibility | 4 | <why> |
| Discoverability for agents | 3 | <why> |
| (others per the rubric) | | |
| **Total / 5 (gated)** | **N** | |

## Maintenance signals

- Stars: <N>
- Weekly downloads: <N>
- Last commit: <ISO date>
- License: <SPDX> (verified via `npm view <npmName> license` → <value>, NOT the README claim)
- CVE check: <link or "none in last release">

## No-dependency-lane stance (ADR-0005)

<REQUIRED. State exactly how this integrates without adding a runtime/dev dependency that trips the allow-scripts gate. One of:
- "Runs via pinned-`npx <pkg>@<version>` — no package.json entry (same lane as ast-grep/comby/probe/promptfoo)."
- "Pinned pre-built binary downloaded in CI — no npm distribution (same lane as comby)."
- "Requires operator approval to add as a runtime dep — out of the autonomous lane; this issue is an operator decision."
Do not leave this to the implementer — if you can't state a lane-compatible path, the candidate should have been rejected at Gate 4.>

## Premise check (not superseded)

<REQUIRED. Confirm no recently-merged tool already covers this niche. e.g. "Checked merged tool-scout PRs in the last 30 days + seen-list filed entries; nearest is <slug> (#NNNN) which covers <X> but not <this candidate's niche Y>.">

## Proposed integration

<concrete, scoped, and including the REAL CLI/API contract — the verified invocation, e.g. `npx <pkg> --format json <args>`, the actual scorer/callback signature, the output schema. Run it once; don't make the dev reverse-engineer it. "wrap as a new sub-router under `src/api/`" or "add a `scripts/<name>.ts` npx wrapper + an `npm run <name>` script". Not a design document; a starting point for the operator + a dev_orch follow-up.>

## Risks / unknowns

<any operator-relevant friction: vendor lock-in, runtime cost, deps it pulls in>

## Files in scope (proposed)

<list of files the dev_orch follow-up would touch — gives the tier classifier something to chew on>

## Out of scope

<everything the dev_orch follow-up should not touch>

---
*Generated by hydra-tool-scout (Phase A). Slug: `<canonical-slug>`. Seen-list key: `hydra:scout:tools-considered:<canonical-slug>`.*
```

Labels: `enhancement`, `needs-triage`, `tool-scout`. The triage label is intentional — the operator should review and decide before this gets picked up.

### 5. Update the seen-list

After every candidate (filed, rejected, or skipped-due-to-cooldown):

```ts
await seenList.recordDecision(slug, decision, reason, {
  tool: "react-query",
  category: "typed-schemas",
  issueNum: 567,            // present if decision === "filed"
  reEvalAt: null,           // optional override
  trigger: "manual",        // Phase A; "calendar"/"alert"/"gap" later
});
```

The seen-list does NOT TTL Redis keys — we want a permanent ledger of every consideration. Re-eval eligibility is computed from the fields, not from key expiry.

### 6. Print a deterministic summary

```
hydra-tool-scout — category: typed-schemas — 2026-05-18T19:32:00Z

Discovered: 7 candidates
After dedup:  5
After maintenance gate: 4
After AI-leverage gate: 2
Filed: 2 issues (#567, #568)
Rejected: 3 (logged to seen-list)
Skipped (cooldown): 2 (logged heartbeat)
```

This is the operator's accept/reject point. If the issue bodies look wrong, the seen-list lets us roll back without re-filing on the next invocation — just close the issue with `wontfix` and the dedup cooldown handles the rest.

## Rules

- **No autopilot dispatch in Phase A.** Manual invocation only.
- **No category invention.** The taxonomy is closed; new categories require a PR to `docs/ai-leverage-categories.md`.
- **Slug canonicalization happens in `src/scout/aliases.ts`** — never use the raw npm name or repo path as the seen-list key.
- **Three-gate AND** — a tool must clear all three (leverage, maintenance, dedup). No 2-of-3 fallbacks. Gate 4 (lane reconciliation) is additive — it never relaxes the AND.
- **Verify the license from the registry, never the README.** Stamp the `npm view <pkg> license` (or repo `LICENSE` file) value into the issue and record how you checked. A README/landing-page license claim is not authoritative (#1882: Apache-2.0 claim vs ISC reality).
- **Screen against the no-dependency lane (ADR-0005) before filing.** A surviving candidate's issue must propose the pinned-`npx`/standalone-binary path, OR be explicitly flagged as an operator dep-approval decision, OR be rejected `no-dep-lane-incompatible`. Never file an issue that silently assumes `npm install`.
- **Reconcile the premise against recent merges.** If a tool merged in the last ~30 days already covers the candidate's niche, reject `premise-superseded-by-<slug>` — don't file a duplicate the dev will decline. Gate 3 dedups the same tool; this guards against a different tool covering an already-covered niche.
- **Record the real CLI/API contract.** Run the tool once and stamp the verified invocation (flags, scorer signature, output schema) into "Proposed integration" — never leave the dev to reverse-engineer it.
- **Issues land in `needs-triage`** — never auto-route to `ready-for-agent`. The operator is the accept point in Phase A.
- **Seen-list is append-only conceptually.** Every consideration leaves a fingerprint, even cooldown-skipped ones (via `lastChecked` heartbeat).

## Manual smoke test

This is the Phase A acceptance flow — the operator runs this before we wire Phase B autopilot dispatch.

```bash
/hydra-tool-scout typed-schemas
```

Expected:

- Discovery surfaces 3–5 candidates from the sources in §2.
- The filter pipeline rejects ≥ 2 of them with a reason logged to the seen-list.
- ≤ 2 issues filed, each matching the schema in §4 — including a registry-verified License line, a No-dependency-lane stance block, a Premise check block, and a real CLI/API contract in Proposed integration.
- Re-running `/hydra-tool-scout typed-schemas` immediately produces zero new issues — the dedup cooldown holds.
- The operator either moves a filed issue to `ready-for-agent` (acceptance) or closes it with `wontfix` (which re-feeds the seen-list).

## Out of scope (Phase A/B)

| Item | Lands in |
|---|---|
| Autopilot `scout_orch` class + `decide.py` wiring | **Phase B (issue #485) — shipped** |
| Calendar walk (one walk/week over categories + deps) | **Phase B (issue #485) — shipped** |
| Alert-driven trigger (`hydra:alerts` subscription) | **Phase C (issue #486) — shipped** |
| Gap-driven triggers (e.g. "the same lesson fired 3x → scout the related category") | Phase D |
| Vibe-driven triggers (operator hunches surfaced via Redis hint) | Phase D |
| Auto-PRs that actually integrate a tool | Never — that is dev_orch's job; the scout files an issue and stops. |

### Phase B wiring summary (issue #485)

- `scout_orch` signal class (7d per-class cooldown in `decide.py:SIGNAL_COOLDOWNS`).
- Walk planner: `src/scout/calendar-walk.ts:planWalk()` — builds the (category, dep) target list with per-category cooldown (30d default).
- Per-tool cooldown (90d) is honored inside the scout via the Phase A seen-list.
- Stats: `/api/scout/stats?window=7` returns last-week activity per category.
- Cost slice: `SCOUT_DAILY_COST_SHARE = 0.04` (~\$2/day on a \$50 cap); operators override via `state.limits.scout_cost_share`.

### Phase C wiring summary (issue #486)

Failure-driven trigger — when a recurring-pattern alert maps to a researchable category, dispatch the scout within hours instead of days.

- **Alert listener:** `src/scout/alert-listener.ts:planAlertDispatches()`
  - Polls the `hydra:alerts` Redis list (newest 100 entries by default).
  - Filters via `PATTERN_CATEGORY_MAP` — the closed pattern→category map.
  - Applies a 24h per-pattern dedup (`hydra:scout:pattern-last-fired:<pattern>`) AND a 24h per-category cooldown (same `hydra:scout:category-last-walked:<cat>` key the calendar walk uses, so the two triggers honor each other).
  - Coalesces multiple patterns into one dispatch per category.
- **Pattern → category starter map** (see `PATTERN_CATEGORY_MAP` in `alert-listener.ts`):
  - `consecutive_failures` → `verification-tooling`
  - `test_decline` → `testing-tooling`
  - `recurring_regressions` → `testing-tooling`
  - `anchor_stuck` → `refactoring-tooling`
  - `low_merge_rate` → `verification-tooling`
  - `high_abandonment` → `agent-tooling`
  - `file_rework` → `refactoring-tooling` (forward-compat; pattern not yet in `ALERT_TYPES`)
  - `rollback_cluster` → `verification-tooling` (forward-compat)
- **Autopilot dispatch:** `decide.py` extends `scout_orch` to prefer alert-driven dispatches over calendar (`trigger: "alert"`). The 7d class cooldown remains the back-stop — even under sustained alert pressure, `scout_orch` fires at most once per 7 days.
- **Audit trail:** `hydra:scout:dispatches` (Redis stream, MAXLEN ~ 1000). Read via `GET /api/scout/dispatches?limit=N`. Each entry: `triggeredBy: calendar | alert:<pattern>`, `category`, `dispatchedAt`, `cost`, `outcome`, `detail`.
- **Diagnostic preview:** `GET /api/scout/alert-plan` returns the eligible/skipped list the listener would emit RIGHT NOW. Read-only — doesn't stamp anything.
- **Cursor:** `hydra:scout:alert-cursor` — high-water-mark ISO timestamp over the alerts list. The skill advances it after a successful dispatch; a crash mid-tick re-processes the same alerts on the next tick.

**Reflex-loop risk (research question #4):** none. The scout files GH issues, not pattern alerts; the map is the chokepoint — only the eight pattern names listed above can drive a dispatch. `cost-cap`, `consumer:dead`, `dlq:alert` are deliberately absent from the map so a runaway scout can't re-trigger itself.

See parent epic #483 for the full roadmap.

## Files

- `docs/operator-playbooks/hydra-tool-scout.md` — this playbook (source of truth for the skill body).
- `docs/ai-leverage-categories.md` — closed-list taxonomy of where to scout.
- `docs/ai-leverage-rubric.md` — 1–5 AI-leverage scale with worked examples.
- `src/scout/seen-list.ts` — Redis-backed seen-list (`getSeen`, `recordDecision`, `eligibleForReEval`).
- `src/scout/aliases.ts` — `canonicalizeSlug` + alias map for npm/repo-name collisions.
- `src/scout/calendar-walk.ts` — Phase B weekly walk planner (categories + deps + per-category cooldown).
- `src/scout/alert-listener.ts` — Phase C alert-driven planner (`PATTERN_CATEGORY_MAP`, `planAlertDispatches`, `recordDispatch`, audit trail).
- `src/redis-keys.ts` — adds `scoutToolsConsidered(slug)` + Phase B/C keys (`scoutLastCalendarWalk`, `scoutCategoryLastWalked`, `scoutStatsDaily`, `scoutDispatches`, `scoutAlertCursor`, `scoutPatternLastFired`).
- `src/api/scout.ts` — `/api/scout/stats`, `/api/scout/dispatches`, `/api/scout/alert-plan`.
- `test/scout-seen-list.test.mts` — regression tests for record + re-eval eligibility.
- `test/scout-alert-listener.test.mts` — regression tests for Phase C pattern map, dedup, coalescing, audit trail.

## Tier

Tier 2 (new module + new tests; no Untouchable Core touched). The PR body carries the live tier classifier's verdict; this footer is informational.
