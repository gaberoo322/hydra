---
name: thermo-nuclear-code-quality-review
description: Operator-invoked, full-repo architectural review for infrastructure-scale ideation. Walks the entire codebase plus its operational surface (devops, CI, services, hosting, hardware), produces a free-form system map with ranked pressure points, then fires parallel deep-dives that propose code-judo restructurings — restructurings that delete whole subsystems, not polish them. Use when the operator wants a thermo-nuclear review, deep architectural audit, infrastructure ideation, or harsh full-repo quality sweep. Sibling to `improve-codebase-architecture` (module-scoped, opportunity-framed) — this skill is repo-scoped and blocker-framed.
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Write(*) Agent(*)
disable-model-invocation: true
reference_files: [_fragments/thermo-nuclear-proposal-format.md]
---

# Thermo-Nuclear Code Quality Review

A harsh, full-repo, **infrastructure-scale** architectural review. Looks for **code-judo moves** — restructurings that delete whole subsystems, services, conditionals, layers, or operational concepts rather than rearranging them. Anchored against the repo's documented architecture (CONTEXT.md, ADRs) and live source via the repo's two search lanes — probe-search for fuzzy recall and ast-search for exact syntax (see [Search usage](#search-usage)). The former semantic-retrieval backend is retired (ADR-0033); a question that used to route there now routes to probe-search.

## Identity

This skill exists to find **dramatic structural simplifications** at the scale of the whole system, including its operational surface. Examples of in-scope moves:

- Collapse two subsystems into one
- Retire a service or a tier entirely
- Replace a polling loop with an event stream
- Consolidate operational primitives (watchdog + heartbeat, two cost-accounting planes)
- Move state across the Redis/Postgres/disk boundary when one side has overgrown its role
- Delete an abstraction whose two-callers-promised never materialised

Not in scope:

- Module-level deepening — that's `/improve-codebase-architecture`
- Diff-scoped review — that's `/review` and the source `thermo-nuclear-code-quality-review` it descends from
- Discovering single bugs — that's `/diagnose`

**Frequency:** monthly, or on-demand before a major planning meeting. Not daily — the system map doesn't change fast enough to justify the token cost.

## When to use vs. neighbours

| Skill | Scope | Frame | Output |
|---|---|---|---|
| `thermo-nuclear-code-quality-review` (this) | whole repo + infra | blocker / dramatic-simplification | free-form proposal docs |
| `improve-codebase-architecture` | one module at a time | deepening opportunities | grilled deepening proposal |
| `review` | a diff | standards + spec conformance | two-axis report |
| `diagnose` | one bug | reproduction → root cause | minimal fix + regression test |
| `grill-with-docs` | one plan | resolve open questions | sharpened plan + CONTEXT/ADR updates |

If the operator says "review this branch" → `/review`. "Improve this module" → `/improve-codebase-architecture`. "Find the biggest reshapes this whole system needs" → this skill.

## Process

The skill runs in two phases. Phase 1 → Phase 2 is automatic; the operator's contact surface is the **post-deep-dive triage** and **grilling-on-survivors**.

### Phase 1 — System Map

Build a free-form map of the repo's current shape, the operational surface around it, and a ranked pool of pressure points. The map is the load-bearing artifact: it feeds Phase 2 routing, ADR-drift status, and re-run diffing.

#### Phase 1a — Generation (uncapped)

Enumerate **every** pressure point you can identify. Don't cap, don't rank yet — maximize recall here, precision comes in 1b.

For each candidate pressure point, capture: a one-liner, an evidence pointer (file:path:line or systemd unit / CI workflow path), and a rough deletion-yield estimate.

Cover, at minimum:
- The full source tree (subsystem boundaries, dependencies, file sizes, dead-code candidates)
- The operational surface (systemd services + timers, `.github/workflows/`, deploy scripts, self-hosted runners, container topology)
- External services the repo depends on (databases, search indices, LLM endpoints, Tailnet routing, etc.)
- ADR drift (see [`#adr-drift-detection`](#adr-drift-detection) below)
- Cross-cutting patterns (polling loops scattered across services, state duplicated across stores, abstractions that exist in one place but were meant to be reused, etc.)

Do not over-shape the map. Let the repo's actual shape determine how you describe it — directory tree, execution flow, data flow, service topology, or some combination. Different repos demand different shapes.

#### Phase 1b — Ranking + selection

Rank the full pool. Top `N` (default 5, knob: `--pressure-points=N`) go to Phase 2 deep-dive. The rest stay in the map under `## Below the Deep-Dive Line` with their one-liners — visible to the operator, who can mentally promote any of them.

**Ranking weights (in order):**

1. **Deletion yield** — how much complexity disappears if this lands? *Highest weight.* A pressure point that retires a whole service outranks one that polishes a module even if the second is more obviously broken.
2. **Operational blast radius** — how many systems / services / CI minutes / on-call surfaces are affected right now? Bigger = higher leverage to fix.
3. **Active ADR drift** — is the system *currently* decaying away from a documented decision in this area? Drifted ADRs lift the pressure points that touch them, because the rot is ongoing, not theoretical.
4. **Evidence strength** — can the operator verify the finding in seconds via grep? Higher = ranks higher (lower trust overhead).
5. **Reversibility** — easier-to-reverse moves win the tiebreaker. Lower regret cost.

**Do NOT weight on:**

- Implementation difficulty (the operator decides what they can afford)
- Novelty (old-but-real findings still rank)
- Aesthetic preference (this isn't a style skill)

**Ranking transparency is mandatory.** The map must state the ranking criteria you used and a one-line rationale per top-N pick. Without this, ranking is opaque and the operator can't sanity-check.

#### Phase 1 output shape

Free-form markdown, written to `.thermonuclear/map-YYYY-MM-DD.md` (local-only, gitignored). Two anchor headings are required so Phase 2 and drift-diffing can locate sections reliably:

- `## Pressure Points` — top-N ranked, with rationales. Free-form inside (numbered list, prose, whatever fits).
- `## ADR Drift` — list of `(ADR, status, violating file:lines)`. Free-form inside.

Optional but encouraged:
- `## Below the Deep-Dive Line` — pressure points not in the top N, with one-liners so the operator can see what was deprioritised.

Everything else (subsystem inventory, operational surface, code-shape metrics, meta-findings, diagrams) — agent-driven. Write what *this* repo on *this* run needs.

**Content rule (applies throughout the map):** every concrete claim cites `file:path:line` or the equivalent operational identifier (systemd unit name, CI workflow path, external-service URL). No vibes. The skill's whole credibility is that findings can be defended in seconds.

#### Re-run diffing

On day 2+, before generating Phase 1a, read the most recent `.thermonuclear/map-*.md`. Find what has changed since that map's date with `git log --since=<map-date> --name-only` (or `git diff <map-commit>..HEAD --name-only`); use probe-search to re-derive context for any changed subsystem. Subsystems unchanged → carry their entries forward. Subsystems changed → re-map. Pressure points carry forward with status: open / resolved (no longer detectable) / superseded (replaced by a different pressure point). Surface a `## Diff vs. previous map` section showing newly drifted ADRs and resolved/superseded pressure points.

### Phase 2 — Parallel deep-dives, then triage, then grill survivors

Auto-proceed from Phase 1. No operator confirmation between phases.

#### Phase 2a — Parallel deep-dives

Fire `N` parallel sub-agents (one per top-N pressure point) via the Agent tool with `subagent_type=general-purpose`. Each sub-agent:

- Receives its pressure point + the relevant ADR fragments (read directly from `docs/adr/`) + source snippets pulled via probe-search or ast-search, scoped to the subsystem
- Produces a structured-but-free-form proposal following [`thermo-nuclear-proposal-format.md`](./thermo-nuclear-proposal-format.md)
- Writes to `.thermonuclear/proposals/<slug>.md`

Sub-agents may produce **conflicting proposals** (e.g., two pressure points proposing opposite directions). That conflict is itself a finding — surface it explicitly in the triage view.

#### Phase 2b — Operator triage

When all sub-agents return, present a compact ranked list:

```
1. <slug>  — <code-judo move in one line>  — deletes: <count> files / <subsystem>
2. <slug>  — <code-judo move in one line>  — deletes: ...
...

Conflicts detected:
- #2 and #4 propose opposite directions on <subsystem>. See conflict note.
```

For each, the operator picks one of: `accept` (proposal stands as-is → flows to the Phase 2d handoff), `reject` (drop), `grill-me` (drop into a grilling loop to sharpen, then flows to 2d).

#### Phase 2c — Grill survivors

For each `grill-me` proposal, drop into a sequential grilling loop one at a time. The grilling sharpens the proposal: resolves open assumptions, kills weak alternatives, picks the right scope. Use the `/grill-with-docs` pattern — one question at a time, lead with a recommendation per question.

**Fold-in, not transcript-append:** as the grilling resolves tensions, update the proposal document inline. The final proposal speaks in conclusions, not deliberation. Do not paste the literal grill transcript at the bottom.

After grilling, the sharpened proposal stays at `.thermonuclear/proposals/<slug>.md` and flows into the Phase 2d handoff below.

#### Phase 2d — Operator-gated handoff into tracked work

Every proposal the operator marked `accept` (or `grill-me` and kept) reaches this step. Its job is to close the gap that otherwise leaves accepted proposals stranded on disk: turn the proposal into **queued work the autopilot can pick up**, without weakening the never-*auto*-file guardrail. The distinction is deliberate — the skill still never files behind the operator's back; filing is an explicit, operator-confirmed action *after* an `accept`.

This mirrors `hydra-architecture-scan` §4's routing exactly. For each accepted proposal, count the tracer-bullet slices it decomposes into (a slice = one independently-mergeable PR with concrete `filesInScope` paths), then route:

| Proposal shape | Route | How |
|---|---|---|
| **≥3 slices** in dependency order | `hydra-prd` epic | Render the proposal into a `PrdInput` JSON (title/problem/rationale/expectedGlossaryTerms/slices[] — map the code-judo move → `problem`, cited ADRs + deletion yield → `rationale`, the "What gets deleted" file:line list → each slice's `filesInScope`). |
| **1–2 slices** | `/to-tickets` | Fewer than 3 slices means the work isn't epic-shaped; render a to-tickets input instead. |
| **Still foggy + big** after grilling (rare — grilling de-fogs) | `hydra-wayfinder` | Chart a destination-pending map; the proposal is an initiative, not yet a decomposition. |

**Operator gate (this is the load-bearing safety property).** Never `--apply` unprompted. For each proposal:
1. Render the `PrdInput` / to-tickets JSON and run the target skill in **dry-run** (`hydra-prd` is dry-run by default; pass `--apply` only on confirm). Show the rendered parent epic + child bodies.
2. **Stop and get explicit operator confirmation before filing.** thermo-nuclear operates at infrastructure scale — a proposal may retire a tier, a service, or a Verifier-Core path (ADR-0005 escalation territory: T4 / Verifier-Core / vision conflict). Those must never be auto-queued. If the proposal's tier (from `GET /api/tier` on its `filesInScope`) is **T4 or touches a Verifier-Core path**, say so loudly and route to the operator as an escalation, *not* into `hydra-prd`.
3. On confirm, `--apply`, then report the created epic/issue numbers. Leave the proposal doc in place (it's the design-of-record the issues link back to).

The operator may also still decline the handoff entirely and take the proposal manually — copy into `gh issue create`, drop into `docs/adr/`, or just start coding. **The skill never auto-files; it renders-then-confirms.**

## Search usage

This skill anchors every claim against the repo's documented architecture (CONTEXT.md, the ADRs) and live source via the repo's **two** search lanes. **The former semantic-retrieval backend is retired (ADR-0033)** — there is no semantic-search backend behind this skill, and a question that used to route there now routes to one of the two lanes below. Do not invent a replacement backend.

### When you don't yet know the exact name — probe-search (fuzzy relevance)

For relevance-ranked recall across the whole tree — "where is the watchdog wired", "find the retry logic", "what touches the Redis/Postgres/disk boundary" — use probe-search. It combines ripgrep speed with tree-sitter parsing and BM25 ranking, returns whole code *blocks* (not lines), and needs no index. This is the direct replacement for the retired semantic backend's "find by meaning" recall (ADR-0033):

```
npm run probe-search -- --query 'watchdog health check wiring'
```

### When you know the exact syntax — ast-search (exact)

For call-site / AST questions — "every caller of `moveItemToLane`", "every `new Redis(...)` outside `src/redis/`", "every `catch` that swallows" — use ast-search. It matches *syntax*, so it never false-matches a comment or string literal:

```
npm run ast-search -- --pattern 'new Redis(:[args])'
```

### Retrieval routing

- **ADR fragments** (Phase 2 deep-dive context): read `docs/adr/` directly — `ls docs/adr/` for the roster (or open `docs/adr/README.md`), then read the ADRs whose decisions the pressure point touches. There is no index to query and no cross-corpus contamination to filter out (the retired semantic backend's URI-prefix filtering step is moot — ADR-0033).
- **Source context** (subsystem snippets for a deep-dive): probe-search scoped toward the subsystem's directory, or ast-search when you can name the symbol precisely.
- **Config / CONTEXT.md**: read the file directly, or probe-search when you don't know which section.

### No health check, no degraded mode

These are local CLI invocations with no standing service behind them, so there is nothing to ping and nothing to degrade. probe-search and ast-search either return results or fail loud on a missing invocation — treat a zero-result query as "narrow the wording or read the files directly", not as a service outage. The honest-recall discipline (cite `file:path:line` for every claim) is unchanged.

## ADR drift detection

Phase 1 includes a drift-detection pass against the repo's ADRs. Each ADR gets classified:

- **Mechanically checkable** — the decision can be verified via grep / file scan / CI check pattern. Example: ADR-0009 "no `new Redis()` outside `src/redis/`" → grep with a path filter.
- **Manual-only** — the decision is philosophical or cross-cutting and can't be mechanically verified. Example: ADR-0003 "terminal goal hierarchy."

For mechanically-checkable ADRs, codify the check (grep pattern, file scan, etc.) in the map under `## ADR Drift`, run it, and report `clean` / `drift detected — <count> violations at <file:lines>`.

For manual-only ADRs, note them in the same section as `manual-only — verify during deep-dive if relevant`.

**False-positive guard.** When codifying a check, include the documented exceptions. A grep for `new Redis()` outside `src/redis/` excludes the seam files themselves. Read the ADR before writing the check, not just its title.

**Honest coverage.** Report the ratio: `drift checked: X/Y ADRs; remaining Z require manual review.` Don't pretend full coverage when it isn't there.

## Tone

Direct, demanding, harsh-but-fair. The skill exists to take stands. Soft-pedalled findings are useless at infrastructure scale.

**Confidence markers are required.** Separate grep-defensible facts from judgement calls in every proposal and every pressure point one-liner:

- `Confident:` — verifiable by anyone in seconds. ADR drift, file-size limits crossed, dead code, duplicated state.
- `Judgement:` — depends on a model of how the system should behave. "Should the watchdog be part of the autopilot heartbeat" is judgement.

The operator dismisses overconfident-but-wrong proposals less, and sharpens uncertain ones faster, when the line is explicit.

## What to flag aggressively (at this scale)

- Whole services / subsystems / tiers whose purpose has decayed
- Operational primitives duplicated across systems (two cost planes, two heartbeat mechanisms, two scheduling layers)
- State duplicated across stores (the same fact in Redis and Postgres, or Redis and disk)
- Polling loops where an event stream would collapse the orchestration
- Abstractions promised at one caller and never reused
- ADR contradictions — code that violates a documented decision
- Subsystems with no ADR + multiple large files (likely under-documented load-bearing pieces)
- Cross-cutting patterns: "you have this same problem in 3 places"
- Hosting/runtime coupling that's invisible from the code (the self-hosted runner, Tailnet endpoints, hardware-specific paths)

## What NOT to do

- **Do not auto-file** issues, PRs, or ADRs. Filing happens only in the Phase 2d handoff, and only after an explicit `accept` + operator confirmation on a dry-run render — never behind the operator's back, and never for a T4 / Verifier-Core proposal (those escalate to the operator instead).
- **Do not propose changes you can't defend with file:line citations.** Every claim needs evidence.
- **Do not skip the empty-deleted-set check.** If a proposal's "What gets deleted" comes up empty after grilling, surface it at the top of the proposal: *"This proposal is rearrangement, not deletion. The operator may still want to action it, but it doesn't meet the thermo-nuclear bar."* Don't reject the proposal — let the operator decide.
- **Do not classify findings by tier.** The operator already knows everything from this skill needs their personal attention.
- **Do not narrow scope.** Full sweep always. Cross-cutting findings are the highest-leverage ones.

## Persistence layout

```
.thermonuclear/                  (gitignored)
├── map-2026-05-28.md            (this run)
├── map-2026-04-30.md            (previous run, used for diffing)
└── proposals/
    ├── retire-watchdog-fold-into-autopilot.md
    ├── collapse-cost-planes.md
    └── ...
```

Add `.thermonuclear/` to `.gitignore` on first run if not already present.
