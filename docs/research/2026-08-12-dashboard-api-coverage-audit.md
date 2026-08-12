# Which orchestrator signals have no page? — endpoint↔surface coverage audit

**Wayfinder ticket:** [#3979](https://github.com/gaberoo322/hydra/issues/3979) ·
**Map:** [Dashboard v3 — the orchestrator cockpit #3977](https://github.com/gaberoo322/hydra/issues/3977) ·
**Date:** 2026-08-12 · **Probed against:** live production service on `:4000`

---

## Method, and what it can and cannot tell you

**Route extraction.** All `router.<method>(...)` declarations across `src/api/*.ts`,
extracted with a multi-line regex tolerant of all three quote styles. **Verified
complete** by comparing per-file extracted counts against per-file declared counts
— zero mismatches across 48 files.

**Consumer extraction — this is where the first two attempts were wrong, and the
correction matters more than the result.** Three successive methods disagreed:

| Method | Consumed | Dark | Why it was wrong |
|---|---|---|---|
| Call-site regex on `useApi`/`fetch` | 35 | 59 | Missed the `usePageItems` hook entirely, and any path built inside a ternary. |
| Substring test (route literal appears anywhere in `dashboard/src`) | 49 | 45 | False positives: `/alerts` matches inside `/now/alerts`; `/agents/stream` appears only in a **comment**; `/outcomes` matches a React nav link. |
| **Exact call-site + delimited-literal scan, hand-verified** | **41** | **53** | Final. Five candidates recovered from DARK, then **three of those five re-rejected** by reading the actual line: a `<Link to=>`, a sidebar nav entry, and a prefix collision. |

**Residual risk in the final number:** a path assembled from fragments
(`base + "/" + name`) would still read as dark. The 53 should be treated as a
close upper bound on truly-unsurfaced routes, not a certainty.

**Liveness probing.** Every parameterless dark route was requested against the
**live production service**, and the response body classified structurally. Three
caveats that bound every liveness claim below:

1. **One probe, one moment.** An endpoint returning `[]` may be *idle*, not dead.
   Distinguishing those requires a producer trace, which was done only where noted.
2. **A `400` is not death.** The first classifier pass misread zod
   `{code:"schema-validation-failed", issues:[...]}` bodies as *data* — `issues`
   is a non-empty array. Five routes were reclassified as **param-required and
   live**, not dark-and-broken.
3. **`redis-cli` is not installed on this host.** An early liveness pass used it
   with `2>/dev/null` and returned "0 keys" for everything — **silent false
   zeros**. Those results were discarded and re-derived through `ioredis`. Any
   Redis figure below comes from the `ioredis` pass.

---

## Headline numbers

| Measure | Verified value |
|---|---|
| Router files in `src/api/` | 48 (**47 mounted**; `route-helpers.ts` and `config-io.ts` declare no routes) |
| **Total routes** | **138** — 94 GET, 42 POST, 1 PUT, 1 PATCH |
| GET routes **surfaced** by the dashboard | **41** |
| GET routes **dark** | **53 (56%)** |
| **Orphan UI** (dashboard calls with no server route) | **0** |
| Write routes wired to the UI | **3 of 44 (7%)** |

> **Premise correction for the map.** The map records "48 API routers / ~160
> endpoints". The router count is right; **the endpoint count is 138, not ~160**,
> and only 94 of those are readable GETs. The map has been corrected.

---

## The write surface — the sharpest single finding

**44 write routes exist. The dashboard calls exactly three:**

| Call site | Endpoint |
|---|---|
| `now-console/NowConsole.jsx:120` | `POST /autopilot/paused` — the pause kill-switch |
| `now-pixel/RecommendationsTab.jsx:72` | recommendation dismiss |
| `now-pixel/RecommendationsTab.jsx:86` | mute-class |

**41 of 44 write endpoints (93%) have no UI.** This is the quantified form of the
operator's "read-only — it always ended in 'now go type something'" verdict: the
backend for a cockpit largely exists and was never wired to a control.

Two consequences worth carrying to [the write-actions ticket](https://github.com/gaberoo322/hydra/issues/3983):

- **The pause kill-switch is already built and shipped** in the `/now` Console.
  The most important phone-grade action on the map is not new work — it is work to
  *find*, and possibly to relocate.
- The other two live writes sit in **`now-pixel`** — the Habitat view, the
  alternate mode behind a toggle. Two of the dashboard's three total actions are
  in its least-reachable surface.

---

## Dark but live — ranked by operator value

31 dark routes returned real populated data. Ranked against the five journeys
from [the journeys ticket](https://github.com/gaberoo322/hydra/issues/3980).

| # | Route | Payload observed | Journey | Why it ranks |
|---|---|---|---|---|
| 1 | `/health/deep` | `services, pipeline, infrastructure, intelligence` | **J2** | Richest health payload in the system, four subsystems, entirely unsurfaced. J2 is the phone journey. |
| 2 | `/metrics/cost-efficiency` | `byClass, qa` | **J2** | Cost per unit of outcome. |
| 3 | `/metrics/cost` | `bySkill` | **J2** | Per-skill spend. Note operator memory: `costByClass` has a partial denominator and must not be used to rank classes — **this** is the sound one. |
| 4 | `/metrics/cost-by-outcome` | `byOutcome` | **J2** | Spend split by what it bought. |
| 5 | `/attribution` + `/attribution/impact` | `metrics`, `rows` | **J4** | Aims at the known-weak dispatch→issue join (~4.97%). The competitor survey flagged Temporal's principal-attribution as directly transferable. |
| 6 | `/capacity` | `orchestrator, target, idle, last20` | **J2/J3** | Headroom and idle state across both projects. |
| 7 | `/learning/friction-patterns` | `hydra-dev, hydra-target-build` (18.9 KB) | **J4** | Largest live learning payload; recurring-failure signal. |
| 8 | `/metrics/quality-gates` | `trend, summary` (10.3 KB) | **weekly** | "Is the system actually improving" — the weekly journey has no page at all today. |
| 9 | `/scheduler/status` | `reconciler, autopilotPause` | **J2** | Scheduler liveness. |
| 10 | `/metrics/anchor-distribution` | `distribution, servedByAnchorType` | **J5** | *Why the autopilot picked what it picked* — the survey found **no orchestrator anywhere** surfaces this. |
| 11 | `/goals` | `metrics, weights, constraints, customSections` (11 KB) | **J5** | The priority model itself. Relevant to [the UI-priority ticket](https://github.com/gaberoo322/hydra/issues/3981). |
| 12 | `/design-concepts` | `items` — **465 KB** | J5 | Largest payload in the API by two orders of magnitude, fully dark. Would need pagination before any page could use it. |

Also dark and live, lower-ranked: `/health`, `/learning/ineffective-rules`,
`/learning/rule-action-log`, `/learning/reflection-health`, `/metrics`,
`/metrics/grounding-duration`, `/metrics/unclassified`, `/outcomes`,
`/scout/stats`, `/design-concepts/exempt-log`, `/design-concepts/snapshots`.

---

## Dead or broken — verified, not inferred

| Finding | Evidence |
|---|---|
| **`/cycle/history` always returns `[]` — confirmed bug** | The route reads `listCycleIds()`, which scans `MATCH hydra:cycle:cycle-*` (`src/redis/cycle-tracking.ts:40`). Live keys are `hydra:cycle:<hex>` — e.g. `hydra:cycle:aeef970d909cccd8a`. **The pattern cannot match.** Meanwhile Redis holds **118 cycle hashes** with valid `status` fields and a **1,824-entry** `hydra:cycle:index` zset; newest sampled cycle **2026-08-10**. A page built on this endpoint would report "no cycles" while 118 exist — precisely the trust failure the operator named. |
| **`/grounding/latest` hangs** | No response in 15 s; `curl` exit code `000`. Not slow — non-responding. |
| **`/calibration/outcomes` returns 502** | Upstream dependency unavailable. |
| **`/summary` returns plain text, not JSON** | Body: `Hydra V2 — 20 cycles completed / Merged: 95% …`. A legacy text-report format from the retired era; unusable by any modern surface. |
| **Dead UI link** | `HistoryTable.jsx:90` renders `<Link to={\`/metrics?run=…\`}>`. **There is no `/metrics` React route** in `App.jsx` — the link is a dead end. |
| **Orchestrator Map renders from a static file** | `components/OrchestratorMap.jsx:2` imports `../data/control-plane.json`. It touches no API and **cannot** reflect current state. A hard kill-list input. |

### Not dead — param-required (reclassified)

`/tier`, `/reflections`, `/metrics/session-tokens`, `/learning/context-trace`,
`/observability/trace-url`, `/agents/stream` all return `400` with an explicit
"missing parameter" or zod-validation body. **Live, correctly refusing a bad
request.** Recorded here because the first classifier pass misread them.

### Undetermined — do not assert either way

`/alerts` and `/recommendations` both return `[]`, and the `ioredis` pass found
**zero** `hydra:alert*` and zero `hydra:recommendation*` keys. Producer code
exists for both (`src/scout/alert-listener.ts`; `src/autopilot/recommendation-materiality.ts`).
Genuinely-idle and genuinely-dead are indistinguishable from a single probe.
**Flagged for the kill-list ticket, not decided here.**

---

## What this means for the map

1. **The supply/demand gap is real but smaller than assumed** — 53 dark GETs, not
   ~125. The problem is less "vast unsurfaced data" and more **misallocation**:
   the richest live payloads (deep health, cost splits, attribution, quality-gate
   trends, anchor distribution) are dark, while 11 surfaces render thinner data.
2. **The cockpit's backend already exists.** 44 write routes, 3 wired. The
   action gap is wiring, not construction.
3. **Cost has endpoints and no page.** The competitor survey found cost-as-an-axis
   has no precedent outside LLM-observability tooling; Hydra has four live cost
   endpoints and surfaces two of them narrowly. This is a page with data waiting.
4. **Two trust failures are already latent in production** — an endpoint that
   silently reports zero while 118 records exist, and a tab rendering a checked-in
   JSON file. Direct input to [the trust contract](https://github.com/gaberoo322/hydra/issues/3985).
5. **`/metrics/anchor-distribution` is the J5 seed.** "Why did the autopilot pick
   that" is live, dark, and — per the survey — something no competitor ships.
