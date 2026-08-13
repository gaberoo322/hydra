# ADR-0034: The Orchestrator dashboard is a five-page cockpit organised by operator journey

Status: Accepted
Date: 2026-08-12
Deciders: Operator + Hydra (wayfinder map #3977 — eight decision tickets resolved 2026-08-12, transcribed here)
Related: #3977 (the map), #3980 (journeys), #3978 (competitor survey, PR #3986), #3979 (coverage audit, PR #3996), #3981 (work ranking, PR #3998), #3982 (kill list), #3983 (write-actions + auth), #3985 (trust contract), #3987 (attention-ranking), #3984 (this inventory), #4000 (the auth exposure this design depends on), #3997 (`/cycle/history` — the worked trust example), PRD #615 (dashboard v2, superseded), ADR-0004 (tiers — `dashboard/` is T2)

## Context

The Orchestrator dashboard reached 11 nav-reachable surfaces plus 2 deep-link pages, built from PRD #615 ("dashboard v2"). It was then **abandoned**: the operator reports opening it "basically never", operating Hydra entirely from inside Claude Code.

That reframes the design problem. **v3's competition is not v2 — it is the operator typing a question to an agent.** Every page must justify beating a conversational turn.

Asked directly what would make a page win, the operator selected **Ambient**, **Trust**, and **Action** — and pointedly **not speed**. Latency is not the pain, so pages may be dense and server-computed; they do not need to be sub-second glance tiles.

v2 failed on **all four** offered failure modes simultaneously — built around available endpoints rather than around a question, numbers that could not be trusted, too many surfaces to navigate, and read-only dead ends that terminated in "now go type something". The structural cause: **v2 is organised by data domain** (Today / Now / Outcomes / Explore), and the operator's journeys are not data domains.

Two independent audits sharpened this:

- **The competitor survey** (#3978) found eleven products share one shape — a list→detail→trace drill-down spine — and that **two of Hydra's five journeys ("what needs me", "what's next"), plus cost-as-an-axis, trust/provenance, and ambient ranking, have no precedent in any surveyed tool.** It also found Jenkins Blue Ocean — the ground-up UX redesign — deprecated as of July 2026 while Airflow's plain colour-coded Grid endures. A v3 competing on polish loses the same way v2 did.
- **The coverage audit** (#3979) found **138 routes** (94 GET / 44 write), of which 53 GETs are dark and **41 of 44 write routes have no UI at all**. The cockpit's backend largely exists and was never wired to a control.

## Decision

### 1. Organise by journey, not by data domain

Five pages, each answering exactly one question, plus two detail views. Thirteen surfaces become seven.

| Route | The one question | Journey | Viewport |
|---|---|---|---|
| `/` **Today** | What needs me, and what happened overnight? | attention + activity | desktop |
| `/health` | Is it on fire, or burning money? | is-it-healthy | **phone-grade** |
| `/work` | What is queued, what is next — and why that? | backlog | desktop |
| `/runs` | Why did that fail? | forensics | desktop |
| `/builder` | Is the system actually getting better? | weekly | desktop |
| `/runs/:runId` | What happened in this run? | forensics detail | desktop |
| `/dispatch/:id/transcript` | What did this agent actually do? | forensics detail | desktop |

**`/health` is the only phone-grade surface.** The operator's sole away-from-desk journey is a mid-day "is it on fire" check with the ability to hit pause. Every other page may assume a desktop.

### 2. Each page's contract

**`/` — Today.** *What needs me, and what happened overnight?*
Carries the **attention feed** (§4) plus the overnight summary: merges, runs, what the autopilot did.
**Must not show:** trends, cost breakdowns, or anything requiring interpretation. Today is for acting, not assessing.
**Data:** `/today/decision-queue`, `/today/stuck`, `/today/merges`, `/today/summary`, `/today/lessons-overnight`, plus the attention feed's threshold sources.
**Actions:** dismiss (feed items), promote to `ready-for-agent`, approve a wayfinder handoff.

**`/health` — is it on fire, or burning money?**
Service liveness, quota burn, spend, autopilot run state, and **deploy state on two orthogonal axes** — *drift* (does the deployed SHA match `origin/master`?) and *health* (is the service actually working?), the Argo CD pattern the survey identified. One status light cannot express "deployed the wrong thing but running fine".
**Must not show:** anything that needs reading. This page is scanned, often on a phone.
**Data:** `/health/deep` (dark today — four subsystems, richest health payload in the system), `/now/service-strip`, `/outcomes/quota`, `/now/cost-burn`, `/metrics/cost-by-class`, `/metrics/cost-per-merged-pr`, `/autopilot/paused`, `/capacity`.
**Actions:** pause/resume (the one action that already works), emergency brake.

**`/work` — what is queued, what is next, and why that?**
Board state, the ready-for-agent queue, and **why the autopilot chose what it chose** — `/metrics/anchor-distribution`, live, dark today, and something the survey found **no orchestrator anywhere ships**.
**Must not show:** run history or failure detail — that is `/runs`.
**Data:** `/autopilot/board-state`, `/metrics/anchor-distribution`, `/goals`, GitHub issue state.
**Actions:** promote, relabel, close/reopen, re-prioritise.

**`/runs` — why did that fail?**
The drill-down spine the survey found in all eleven products: runs list → run → dispatch → transcript. Absorbs the **Friction** and **Behavior** content folded from Explore. **Failed steps auto-expand** (the GitHub Actions affordance — the cheapest ambient trick in the survey). Every event shows **who or what triggered it** (Temporal's principal attribution), which forces Hydra's ~4.97% dispatch→issue join to be fixed rather than tolerated.
**Must not show:** aggregate trends.
**Data:** `/autopilot/runs`, `/autopilot/runs/:id`, `/dispatches/:id/transcript`, `/explore/friction`, `/explore/behavior`, `/attribution`, `/learning/friction-patterns`.
**Actions:** resume or reap a stuck dispatch, re-run failed CI, update branch. Resume and re-dispatch are **distinct, labelled** operations (n8n's "retry with the currently saved workflow").

**`/builder` — is the system actually getting better?**
The weekly journey. Builder health, quality-gate trends, lesson throughput, and the **ranked maintainability view**: architecture rendered as **most-tangled modules** (fan-in + fan-out, largest dependency cycles), not as a 363-node/1004-edge graph. The question — what should I refactor next — is rung 1 of the work ranking (#3981); the node-soup rendering was the wrong form for it.
**Must not show:** anything actionable today. This page changes decisions weekly, not hourly.
**Data:** `/builder-health`, `/metrics/quality-gates`, `/outcomes/trends`, `/outcomes/lessons`, `/architecture` (re-rendered), `/explore/lessons`.
**Actions:** none.

### 3. What dies

Six surfaces are removed outright: **Orchestrator Map** (rendered from a checked-in `data/control-plane.json` — no API call, structurally incapable of reflecting current state), **Anomalies** (single endpoint, empty), **Now › Habitat** (its two write actions operated on an empty endpoint), **Outcomes** (content re-homed by question: cost → `/health`, quality → `/builder`), and **the Explore container itself** with its tab bar — the deepest burial on the dashboard.

The `/now` Console/Habitat mode toggle collapses with the Habitat, taking its `?view=` deep-link and localStorage machinery.

**Explore's four live tabs are folded, not deleted:** Friction and Behavior → `/runs`, Flow → `/` , Lessons → `/builder`.

### 4. Ambient means threshold-crossing, not scoring

The dashboard **ranks and surfaces**; it does not list. But it ranks by **threshold-crossing**, extending an idiom Hydra already uses in three independent subsystems (`/today/stuck` ships `blockedDays: 2` / `needsInfoDays: 1`; `pattern-memory` fires at `PROMOTION_THRESHOLD: 3`; `builder-health` measures against floors).

The decisive argument is §5: derived values must explain themselves, and **a threshold is its own explanation** ("blocked 4 days > 2-day line") where a weighted score is not. Two properties follow free: the **quiet state is structural** — nothing crossed means a genuine all-clear, not an empty list — and each line is tunable without touching a weight vector.

**One heterogeneous "needs attention" feed** on `/`, mixing issues, PRs, dispatches and health breaches under a common shape, each item deep-linking to the page that owns its detail.

**Signals: blocked-on-human, breakage, repetition.** **Deviation (spend / quota / duration outside a normal band) is deliberately excluded** — money is something the operator goes and looks at, not something that interrupts them. Cost keeps its place on `/health`; it earns no threshold.

**Calibration is falsifiable.** Every surfaced item can be dismissed with a reason, and dismissals are counted per threshold. A line whose items are always dismissed unread is miscalibrated and says so in the data. Without this, ranking quality degrades unobserved — which is how the Anomalies tab died.

### 5. The trust contract

A page's whole advantage over a conversational answer is that it reads ground truth. A page that lies once forfeits that advantage permanently, for every other page too.

1. **Unverifiable → `UNKNOWN`, never a confident-looking number.** Failed fetch, missing timestamp, or a timestamp past its budget renders an explicit unknown state. The last known value may appear as context, never in the position a current value would occupy.
2. **Zero must be asserted, not inferred.** A list response must carry evidence the lookup ran (a `scanned`/`count`, or explicit `empty: true`). The UI renders "nothing to show" only on an asserted zero; an unasserted `[]` renders `UNKNOWN`. **This is an API contract change across every list endpoint** — the largest implementation consequence of this ADR. It is the rule that catches #3997, where `/cycle/history` returned `200 []` while 118 cycle hashes existed.
3. **Derived values look distinct from observed ones and explain themselves**, decomposed into their inputs. This discharges the no-editorialising requirement: the UI never asserts a judgement it cannot take apart. Hydra's derived values have a poor record — reconciler ~92% false positives, `costByClass` partial denominator, a green CI check that is not a green suite.
4. **Age always visible; full source on demand.** Every panel shows "as of HH:MM"; the endpoint, key, and poll cadence sit behind hover/click.

**Freshness budgets:** minutes for is-it-on-fire, ~1 hour for activity, ~1 day for weekly trends. Exceeding the budget demotes to `UNKNOWN`.

19 of 28 live endpoints already emit `generatedAt`; the nine that do not must gain it. Only ~4 components render it today, **all on the killed Outcomes page** — the provenance display is rebuilt, not extended.

### 6. Auth is a precondition, not a feature

The API is **already internet-reachable and unauthenticated** — verified 2026-08-12 (#4000): `https://admin.clawstreetbets.xyz/api/autopilot/paused` returns 200 from the public internet, the only guard anywhere is a Bearer on the `config` routes, and CORS echoes any origin with all methods. All 44 write routes are exposed, including the emergency brake.

**Gate at the edge with Cloudflare Access, covering reads and writes** — not per-route guards, because a per-route guard is opt-in and is exactly how the current state arose. The `/api/health` probe in `scripts/hydra-watchdog.sh:215` needs a bypass policy or a service token.

**No cockpit action ships before the gate exists.** The dashboard does not create this exposure, but it must not widen it.

### 7. Action confirmation is tiered by blast radius

- **Immediate, with undo:** pause/resume, relabel, close/reopen, dismiss.
- **Confirm first:** anything that starts an agent or spends quota — promote to `ready-for-agent`, re-run CI, reap a dispatch.
- **Always:** show the actual result. Nothing may fail silently and **no action may render success it has not verified** — the trust contract applied to writes.

Constraints any implementation must encode: `ready-for-agent` is a dispatch trigger in disguise; `issue-label-validation` reverts it on an issue lacking a `## Files in scope` section; a blocked issue must never be promoted; `gh pr edit` is broken for labels here (use `gh api …/labels`); PR actions need GitHub credentials — a different trust boundary from every other action.

## Consequences

- **Thirteen surfaces become seven.** The competitor norm is one work-list spine plus one health page; five is more, justified by two journeys nobody else ships.
- **Asserted-emptiness is an API contract change** touching every list endpoint. `usePageItems` — which already centralises `loading | error | empty | ready` — is the single seam through which most of the client half lands, and gains `stale` and `unknown`.
- **`dashboard/` is a `TIER_2_PREFIX`**, so every page merge enrols in Outcome Holdback, and **no auto-caller exists** for `POST /api/holdback/enroll`. A busier UI lane raises that manual burden; the epic should address it.
- **Deep links break**: `/explore` and all `:tab` routes, `/outcomes`, and `/now?view=habitat`. Redirects map to the pages that absorbed their content.
- **The dashboard has exactly one working action today** (pause). Every other action here is net-new wiring against the 41 of 44 unwired write routes.
- **`/cycle/history` (#3997) is the worked example** for the trust contract: a fixed one must render real records; a broken one must render `UNKNOWN`, never "no cycles".

## Alternatives considered

- **Extend v2 rather than replace it.** Rejected: v2's failure is structural — organised by data domain against journeys that are not data domains. Extending it reproduces the cause.
- **Weighted scoring for the attention feed.** Rejected: weights are arbitrary, drift silently, and cannot decompose into a reason without extra machinery the trust contract would demand anyway.
- **Per-route Bearer auth.** Rejected: opt-in guards get forgotten on the next route added — demonstrably, since that is how 44 write routes ended up ungated.
- **Merge Today and Outcomes into one windowed "how is it going" page.** Rejected: it puts a weekly trend in a daily surface and makes one page answer two questions.
- **Keep the Architecture graph.** Rejected as form, kept as data: a 1004-edge graph is the "easy to compute, not what I needed" artifact that sank v2. The ranked most-tangled list answers the actual question.
- **A user-configurable chart builder** (the LangSmith pattern). Rejected: it contradicts Ambient outright — a chart you had to configure can only show what you already knew to ask.
