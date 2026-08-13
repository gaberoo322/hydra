# What do leading orchestration dashboards put on screen?

**Wayfinder ticket:** [#3978](https://github.com/gaberoo322/hydra/issues/3978) ·
**Map:** [Dashboard v3 — the orchestrator cockpit #3977](https://github.com/gaberoo322/hydra/issues/3977) ·
**Date:** 2026-08-12

Survey of eleven products across three lanes, read for *what is on screen* and
*what is deliberately not*. The judgment section is graded against the five
operator journeys and the Ambient/Trust/Action differentiators decided in
[the journeys ticket #3980](https://github.com/gaberoo322/hydra/issues/3980).

**Sourcing caveat (read this before citing any row):** these findings come from
vendor documentation, not from hands-on use of each product's live UI. Doc pages
describe the intended UI and reliably enumerate *nav structure* and *available
actions*; they systematically under-describe density, defaults, and what an
operator actually looks at. Every claim below is doc-derived unless marked
otherwise. Nothing here was observed in a running instance. Claims about what a
tool **lacks** are the weakest class — absence of documentation is not proof of
absence — and are marked as such where they carry weight.

---

## 1. Per-product summary

### Workflow orchestrators

**Apache Airflow 3** ([UI Overview](https://airflow.apache.org/docs/apache-airflow/stable/ui.html))

- **Nav:** Home → Dags → Assets → Admin. Four items.
- **Home** is a system-health overview: DAG/task history, recent asset events.
- **Dag detail** carries two primary visualizations side by side — **Grid**
  (a matrix of runs × tasks, colour-coded by state) and **Graph** (dependency
  topology) — plus tabs: Runs, Tasks, Events, Code, Details, XCom.
- **Write actions, and there are many:** trigger DAG, pause/resume, clear task
  instances, mark success, mark failed, backfill, add a run note, reparse DAG,
  edit Variables/Connections, emit a manual asset event.
- **The docs describe no confirmation dialog for any of them** — including
  destructive ones. (Doc-derived absence; treat as "undocumented", not "proven
  absent".)

**Temporal** ([Web UI](https://docs.temporal.io/web-ui),
[Events](https://docs.temporal.io/workflow-execution/event),
[UI changelog](https://temporal.io/changelog/product-area/ui))

- **Nav:** Namespaces → Workflows (list, filterable, capped at 1,000 shown) →
  Workflow Execution detail.
- **Event History is the centrepiece** — ~40 event types, offered in four
  renderings: **All**, **Compact** (logical grouping of activities/signals/
  timers), **JSON** (raw), and **Timeline**. Input/Output values shown for
  debugging.
- **Principal Attribution:** every event records *who or what* triggered it —
  which user or service started the workflow, sent a signal, or requested
  cancellation.
- **Write actions:** cancel (graceful), terminate (forceful, with a custom note
  logged), **reset to a chosen point in event history**, signal, update.
- Docs explicitly counsel cancel over terminate, reserving terminate for stuck
  executions.

**Dagster** ([webserver/UI](https://docs.dagster.io/guides/operate/webserver),
[asset catalog](https://docs.dagster.io/guides/observe/asset-catalog))

- **Nav:** Overview · Catalog · (Deployment).
- **Overview — "the factory floor"** — one high-level page of activity across all
  code locations, tabbed into runs, jobs, schedules, sensors, resources,
  backfills.
- **Asset catalog** is an *object* index (filter by key, compute kind, group,
  code location, tags, owners) rather than an execution index — a second spine
  alongside runs.
- **Deployment overview** is a separate page for *system* health: code-location
  status, daemon/agent health, schedules, sensors, config.

**Prefect** ([docs](https://docs.prefect.io/v3/concepts/work-pools),
[flow runs](https://prefect-284-docs.netlify.app/ui/flow-runs/))

- **Nav:** Dashboard (default landing) · Flow Runs · Deployments · Work Pools.
- **Flow Runs** page is the workhorse: filter by state, tags, scheduled-vs-observed.
- **Work Pools** is a *control* surface — edit pools, set and modify concurrency.
  Concurrency-as-a-dial in the UI is notable; it is a throughput lever, not a view.

### CI/CD

**Argo CD** ([docs](https://argo-cd.readthedocs.io/en/stable/), plus third-party
UI walkthroughs)

- **Nav:** Applications list (tiles) → Application detail (resource tree).
- **The two-axis idea, and the single most transferable finding in this survey:**
  **Sync status** (does live state match Git?) and **Health status** (is it
  actually working?) are tracked as *orthogonal* axes. Synced/OutOfSync/Unknown
  on one; Healthy/Progressing/Degraded on the other.
- An app can be **Synced but Degraded** (deployed what you asked for; it's broken)
  or **OutOfSync but Healthy** (working fine; not what Git says). Collapsing these
  into one "status" destroys the distinction.

**GitHub Actions** ([run logs](https://docs.github.com/actions/managing-workflow-runs/using-workflow-run-logs),
[re-running](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs))

- **Spine:** Actions tab → workflow (sidebar) → run summary → job → step logs.
- **Failed steps are auto-expanded** on opening a job. The cheapest ambient
  affordance found anywhere in this survey: it removes the "hunt for the red
  thing" step entirely.
- Deep-linkable to a **specific log line** (click line number → copy URL).
- **Write actions:** re-run all, **re-run failed jobs only**, re-run a single job,
  each with an optional debug-logging toggle.

**Jenkins Blue Ocean** ([dashboard](https://www.jenkins.io/doc/book/blueocean/dashboard/),
[activity view](https://www.jenkins.io/doc/book/blueocean/activity/),
[deprecation](https://github.com/jenkins-infra/jenkins.io/issues/9038))

- **Nav:** Dashboard (Pipelines list, plus a Favorites list above it) → Activity
  view (tabs: Activity · Branches · Pull Requests).
- **Favorites auto-populate**: Blue Ocean adds branches/PRs you have modified.
- Shipped its own design system (Jenkins Design Language) and was explicitly a
  clarity-over-clutter visual redesign.
- **It lost.** Blue Ocean is in maintenance mode — no new features — and is
  **deprecated as of July 2026**; Jenkins docs now steer users to the plainer
  Pipeline Graph View. See §4.

**n8n** ([all executions](https://docs.n8n.io/workflows/executions/all-executions/),
[single-workflow executions](https://docs.n8n.io/workflows/executions/single-workflow-executions/))

- **Nav:** Overview → Executions tab (global) or per-project/per-workflow.
- Filter by status: Failed · Running · Success · Waiting.
- **Write action worth stealing:** *"Retry with currently saved workflow"* —
  re-run the old execution's data against the **fixed** workflow, not the version
  that failed. The distinction between "retry as it was" and "retry with my fix"
  is made explicit in the UI.

### Agent / LLM observability

**LangSmith** ([dashboards](https://docs.langchain.com/langsmith/dashboards))

- **Hierarchy:** Organization → Workspace → Project → Trace.
- **Nav includes a Monitoring tab** with prebuilt per-project dashboards plus a
  **user-built chart builder** ("+ New Chart").
- Tracked metrics: trace count, **token usage and cost**, latency percentiles,
  error rates, feedback scores.
- Trace rendered as a **tree of runs** with inputs/outputs visible at each step.

**Langfuse** ([observability overview](https://langfuse.com/docs/observability/overview),
[data model](https://langfuse.com/docs/observability/data-model),
[sessions](https://langfuse.com/docs/observability/features/sessions))

- **Data model is three-tier:** observations → traces → sessions. Sessions group
  traces belonging to one multi-step interaction or agentic workflow.
- Surfaces: Trace Details, Sessions, Timeline, Users, **Agent Graphs**, Dashboard.
- Dashboard axis is explicitly **quality, cost, and latency**; filterable by user,
  session, cost, latency, or custom metadata.

*(Braintrust was in the ticket's list and was not surveyed — two agent-observability
products proved sufficient to establish the lane's pattern, and the marginal
finding did not justify the search budget. Flagged as a known gap.)*

---

## 2. The invariant: every one of them is a drill-down spine

Eleven products, one shape:

| Product | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| Airflow | Dags | Dag run | Task instance → logs |
| Temporal | Workflows | Execution | Event history |
| Dagster | Runs | Run | Steps |
| Prefect | Flow runs | Flow run | Task runs |
| Argo CD | Applications | Application | Resource tree |
| GH Actions | Workflows | Run | Job → step logs |
| n8n | Executions | Execution | Node |
| LangSmith | Projects | Trace | Run tree |
| Langfuse | Sessions | Trace | Observation |

Three further recurrences:

- **Status is the primary visual carrier** — colour-coded state on every list row.
- **A separate system-health page**, distinct from the work list — Airflow Home,
  Dagster Deployment overview, Argo CD's health axis. Nobody merges "is the
  platform up" into "what ran".
- **Write actions live at the detail level**, reached by drilling in. Airflow's
  grid-cell actions and n8n's list-row retry are the two exceptions.

---

## 3. What transfers to Hydra

Graded against the five journeys from
[the journeys ticket](https://github.com/gaberoo322/hydra/issues/3980).

### Adopt

1. **The drill-down spine, for J4 ("why did that fail?") only.** Dispatch list →
   dispatch → turn timeline → transcript. Hydra already has the level-3 pieces
   (`/dispatch/:id/transcript`, `/autopilot/:runId`) — what it lacks is the
   list-level entry and the auto-expansion. This is J4's strongest template and
   the survey's clearest transfer.
2. **Auto-expand the failure (GitHub Actions).** Open a failed dispatch, land on
   the failing turn — not on a summary you must navigate out of. Cheapest ambient
   affordance found.
3. **Argo CD's two orthogonal axes, applied to deploy state.** Hydra has this
   exact problem and currently conflates it: `CLAUDE.md` documents that back-to-back
   master merges can cancel a `deploy` job, leaving master silently ahead of prod.
   That is precisely **OutOfSync** — and the service is simultaneously **Healthy**.
   One "status" light cannot express it. Two axes can.
   *Premise check:* `CLAUDE.md` claims this drift has "no alarm", but the operator
   memory `reference_watchdog_does_check_sha_drift` records that a detector **does**
   exist (log-only). The inventory ticket should verify which is true before
   designing around either.
4. **Temporal's Principal Attribution — who triggered this.** Directly addresses a
   known Hydra weakness: dispatch→issue attribution is recorded at ~4.97% in
   operator memory. Attribution as a *display* requirement forces the join to be
   fixed rather than quietly tolerated.
5. **n8n's "retry with currently saved workflow".** Maps exactly onto Hydra's
   re-dispatch-after-a-prompt-fix case, and onto the standing rule that a stalled
   dispatch should be *resumed*, not re-dispatched. Make the distinction explicit
   in the UI rather than leaving it to the operator's memory.
6. **Temporal's reset-to-a-point**, as the conceptual model for resuming a
   dispatch mid-run rather than restarting it.
7. **Airflow's Grid — the density idea, not the DAG.** A matrix of *time × unit*
   with colour-coded cells is the highest-information-density widget in the
   survey, and the journeys ticket established that Hydra's pages may be dense
   (speed was explicitly not a differentiator). The Hydra analogue is
   dispatch-class × cycle, or issue × lifecycle-stage.

### Reject

1. **Multi-tenancy hierarchy.** Temporal namespaces, LangSmith
   Organization→Workspace→Project, Dagster code locations. All solve a problem
   Hydra does not have — one operator, two repos. Any hierarchy is pure
   navigation cost, and "too many surfaces" is already a named v2 failure.
2. **User-configurable chart builders (LangSmith "+ New Chart").** A single
   operator building their own charts is work, not a feature. It also contradicts
   **Ambient**: a chart you had to configure can only show what you already knew
   to ask.
3. **Favorites / pinning (Blue Ocean).** Presupposes more objects than one
   operator has.
4. **Schedules / backfill UI.** Hydra has no schedules to backfill.
5. **DAG topology views — with one caveat.** Hydra's work is not a DAG of
   deterministic tasks, so Airflow/Argo-style graph rendering mostly fails the
   "easy to compute, not what I needed" test that sank v2. **The caveat:** issue
   `blocked-by` edges and wayfinder map frontiers *are* genuine dependency
   graphs, and an existing surface (the Orchestrator Map tab) already attempts
   this. Whether that specific case earns a graph is a real question — it belongs
   to the kill-list ticket, and this survey does not settle it.

### No precedent — Hydra is on its own

This is the survey's most important negative result. **Two of Hydra's five
journeys, plus two of its three page-differentiators, have no template in any
surveyed product.** Stated conservatively: none of the surveyed *documentation*
describes such a surface. Absence of docs is weaker than absence of feature, but
across eleven products the pattern is consistent enough to plan against.

| Hydra need | Precedent found |
|---|---|
| **J1 — "what needs me?"** (an operator-decision queue) | **None.** Every tool assumes the human comes looking; none maintains a queue of things blocked on a human. |
| **J5 — "what's in the backlog / what's next?"** | **None.** Orchestrators show what *is* running, never what *should* run next or why the scheduler chose it. The nearest analogue is an issue tracker, not an orchestrator. |
| **Cost / quota as a first-class axis** | **Only the LLM-observability lane.** Langfuse (quality/cost/latency) and LangSmith (token usage and cost) surface it; **no classic orchestrator does** — they show duration, never money. Hydra's hard quota constraint has no template outside that lane. |
| **Trust / provenance of a displayed number** | **None.** Every tool treats its own database as ground truth and shows bare values. Nothing timestamps a value or renders it as unknown-when-stale. This is exactly what [the trust-contract ticket #3985](https://github.com/gaberoo322/hydra/issues/3985) must invent. |
| **Ambient ranking** ("surface what I didn't know to ask") | **Essentially none.** Every tool *lists and filters*; none *ranks by attention-worthiness*. Argo CD's health rollup is the closest, and it is a status aggregate, not a ranking. |

The practical consequence for [the page inventory](https://github.com/gaberoo322/hydra/issues/3984):
**this survey can inform J3 and J4 strongly, informs J2 only on the health half,
and cannot help with J1, J5, cost, trust, or ambient ranking.** Those pages must
be designed from Hydra's own journeys. Borrowing a competitor's page shape for
them would reproduce v2's root cause — building what is easy to copy rather than
what answers a question.

---

## 4. The Blue Ocean warning

Blue Ocean was Jenkins's ground-up UX redesign: a bespoke design system, a
clarity-over-clutter mandate, sophisticated pipeline visualizations. It is now in
maintenance mode and **deprecated as of July 2026**, with Jenkins documentation
redirecting users to the plainer Pipeline Graph View
([jenkins-infra/jenkins.io#9038](https://github.com/jenkins-infra/jenkins.io/issues/9038)).

Meanwhile Airflow's Grid view — a colour-coded table — remains the most-used
surface in the most-deployed orchestrator in the survey.

The lesson for v3 is precise and uncomfortable: **the prettier, more coherent
redesign lost to the denser, plainer one.** Hydra dashboard v2 was itself a
redesign (PRD #615) and was abandoned. A v3 that competes on visual quality will
lose the same way. The journeys ticket already points elsewhere — Ambient, Trust,
Action, explicitly *not* speed and, by extension, not polish. This survey
independently corroborates that from the outside.

---

## Sources

- [Airflow UI Overview](https://airflow.apache.org/docs/apache-airflow/stable/ui.html)
- [Temporal Web UI](https://docs.temporal.io/web-ui) · [Events and Event History](https://docs.temporal.io/workflow-execution/event) · [UI changelog](https://temporal.io/changelog/product-area/ui) · [Workflow cancellation](https://docs.temporal.io/develop/python/workflows/cancellation)
- [Dagster webserver and UI](https://docs.dagster.io/guides/operate/webserver) · [Asset catalog](https://docs.dagster.io/guides/observe/asset-catalog)
- [Prefect work pools](https://docs.prefect.io/v3/concepts/work-pools) · [Prefect flow runs](https://prefect-284-docs.netlify.app/ui/flow-runs/)
- [Argo CD documentation](https://argo-cd.readthedocs.io/en/stable/) · [ArgoCD UI dashboard guide](https://oneuptime.com/blog/post/2026-02-26-argocd-ui-dashboard-guide/view) · [Health status icons](https://oneuptime.com/blog/post/2026-02-26-argocd-health-status-icons-ui/view)
- [GitHub Actions: using workflow run logs](https://docs.github.com/actions/managing-workflow-runs/using-workflow-run-logs) · [Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) · [Partial re-runs](https://github.blog/news-insights/product-news/save-time-partial-re-runs-github-actions/)
- [Blue Ocean dashboard](https://www.jenkins.io/doc/book/blueocean/dashboard/) · [Activity view](https://www.jenkins.io/doc/book/blueocean/activity/) · [Deprecation issue](https://github.com/jenkins-infra/jenkins.io/issues/9038)
- [n8n all executions](https://docs.n8n.io/workflows/executions/all-executions/) · [Single-workflow executions](https://docs.n8n.io/workflows/executions/single-workflow-executions/)
- [LangSmith dashboards](https://docs.langchain.com/langsmith/dashboards)
- [Langfuse observability overview](https://langfuse.com/docs/observability/overview) · [Data model](https://langfuse.com/docs/observability/data-model) · [Sessions](https://langfuse.com/docs/observability/features/sessions)
