# ADR-0008: Design-Concept Gate

Status: Accepted
Date: 2026-05-15
Deciders: Operator + Hydra
Issue: [#437](https://github.com/gaberoo322/hydra/issues/437) (epic), [#438](https://github.com/gaberoo322/hydra/issues/438) (Phase A implementation)

## Context

The codex-removal cut-over (ADR-0006) consolidated all code-writing work
behind two Claude Code subagent skills: `hydra-dev` and
`hydra-target-build`. The merge gate (`src/gate.ts`) governs what enters
master via deterministic checks (typecheck, test, build, mutation
kill-rate, scope, tier classifier). What the gate *does not* check:
whether the agent and the rest of the system share an understanding of
what was being built.

Today the implicit chain is: an issue is filed → `hydra-research`
enriches it → `hydra-dev` picks it up and writes code → CI accepts or
rejects. There is no codified moment where the agent proves it
understands the problem in the system's own vocabulary before code is
written. When alignment fails, it surfaces as one of: scope creep caught
by `src/scope-enforcement.ts`, vocabulary drift in PR descriptions, or a
`ready-for-human` punt with freeform "this is stuck" prose.

The "Software Fundamentals Matter More Than Ever" talk (Matt Pocock) and
the associated `mattpocock/skills` repo articulate this gap cleanly:
specs-to-code without a *shared design concept* compounds entropy. The
proposed fix is a small, persisted artifact — produced by an automated
grilling pass — that records the agent's understanding before
implementation, and is then the ground truth for PR-time review.

## Decision

Introduce a **design-concept artifact** (Redis-backed, 7-day TTL, schema
below) that is:

1. **Required** before any `dev_orch` / `dev_target` dispatch (enforced
   in `scripts/autopilot/decide.py`, Phase B).
2. **Produced** by a new autopilot class
   `design_concept_orch` / `design_concept_target`, which dispatches the
   new `hydra-grill` skill (sub-issue #439). Grilling drives a Q&A loop
   against `CONTEXT.md`, ADRs, and the existing research report. Hard
   logic questions sub-dispatch the upstream `prototype` skill into a
   sandbox worktree.
3. **Consumed** at PR-merge time by `hydra-qa`, which is rewritten as a
   wrapper over the upstream `review` skill (sub-issue #440). The Spec
   axis reads the artifact; the Standards axis reads `CONTEXT.md` +
   ADRs + lint configs. The two axes run as parallel sub-agents.

The artifact's `glossaryGaps`, `modulesTouched`, and `invariants` are
first-class fields — not freeform prose. The autopilot's existing tier
classifier (`src/tier-classifier.ts`) cross-references
`interfaceImpact: 'breaking'` against tier ≥ 2.

Operator escalation (unresolvable glossary gaps, vision conflicts) emits
a `handoff` artifact (per upstream skill) into the
`Operator decision queue YYYY-MM-DD` issue, replacing freeform
`ready-for-human` prose.

### Artifact schema (TypeScript)

```ts
type DesignConcept = {
  anchorRef: string;
  scope: 'orch' | 'target';
  createdAt: number;
  artifactHash: string;            // sha256 over canonical-JSON of body
  glossaryTerms: string[];
  glossaryGaps: string[];
  modulesTouched: Array<{
    path: string;
    interfaceImpact: 'none' | 'extend' | 'breaking';
    depthClassification: 'deep' | 'shallow' | 'unknown';
  }>;
  invariants: string[];
  rejectedAlternatives: Array<{ alt: string; why: string }>;
  qaTrace: Array<{ q: string; a: string }>;
  prototypes: Array<{
    question: string;
    branch: 'logic' | 'ui';
    snippet: string;
    answer: string;
    workTreePath: string;
  }>;
  status: 'draft' | 'approved' | 'stale';
  approvedBy: 'auto-gate' | `operator:${string}`;
};
```

### Redis schema

- `hydra:design-concept:{anchorRef}` — Hash, JSON-encoded array/object
  fields. EXPIRE = 7 days.
- `hydra:design-concept:index` — Sorted set, score = `createdAt`.
  Opportunistically pruned of stale entries on every read.

### `artifactHash` semantics

`artifactHash` is sha256 over the canonical-JSON encoding (sorted keys,
no whitespace) of the body fields EXCLUDING `artifactHash`, `createdAt`,
`status`, and `approvedBy`. Two artifacts with identical content
therefore hash to the same value regardless of when they were saved or
who approved them. This lets PR descriptions reference an artifact by
hash for audit purposes without coupling the hash to lifecycle state.

### Gate check (`gateCheck(d, now)`)

Returns `{ ok: false, reasons: [...] }` when ANY of:

1. `glossaryGaps.length > 0` — Phase A fails closed (no whitelist
   escape hatch yet; lands later).
2. `invariants.length < 1`.
3. `modulesTouched.length < 1`.
4. Any `modulesTouched[i].interfaceImpact === 'breaking'` AND the
   corresponding module path does **not** classify to tier ≥ 2 via
   `src/tier-classifier.ts`. A "breaking" declaration is incompatible
   with a Tier-0 (untouchable) or Tier-1 (prompt-shaped, auto-merge)
   path — those are either operator-only or low-blast-radius by
   definition. Tier-2 (outcome-holdback) and Tier-3 (operator-review)
   paths both clear this check.
5. `qaTrace.length < 6`.
6. `now - createdAt > 7 days` (i.e. `isFresh()` returns false).
7. `status !== 'approved'`.

All checks are pure functions over the artifact + a `now` timestamp.
The autopilot consumes the boolean and the reason list verbatim.

### Rollout (4 phases, each independently revertible)

- **Phase A — Build & shadow** (THIS PHASE, issue #438): build
  `src/design-concept.ts`, API sub-router. Glossary scrub (#441),
  `hydra-grill` skill (#439), `hydra-qa` rewrite (#440) land as
  parallel sub-issues. Autopilot class wiring deferred.
- **Phase B — Warn-only** (later): gate fires events but `dev_orch`
  proceeds; PR receives artifact as a comment.
- **Phase C — Enforce** (later): gate blocks `dev_orch`; CI step
  required.
- **Phase D — Target side** (later): mirror on `design_concept_target`.

Each phase has a single-line revert (remove the slot from
`PIPELINE_SLOTS`, disable CI step). Tier-2 (Outcome Holdback) applies:
if Target Outcome metrics regress over 5 cycles after Phase C,
auto-revert to Phase B.

## Consequences

**Positive**:

- Every code-writing dispatch has an auditable alignment artifact.
- PR-time review is grounded in the same artifact that authorized
  dispatch — single source of truth front-to-back.
- `hydra-qa` shrinks dramatically by delegating to a maintained
  upstream skill (`review`).
- Operator decision queue input is structured (handoff format) rather
  than freeform.
- Prototype-driven decisions are captured as verbatim snippets in the
  artifact, not lost in conversation.

**Negative**:

- Adds latency per dev dispatch (one grilling pass). Mitigation: cap at
  30k tokens per session; cache artifacts for 7d.
- Adds a new class to `decide.py` and a new Redis namespace; surface
  area to maintain.
- Glossary-only rule forces churn on `CONTEXT.md` (some `(planned)`
  placeholders need cleanup) — handled by sub-issue #441.

**Neutral**:

- Does not change the merge gate (`src/gate.ts`) — gate stays the
  source of truth for deterministic verification. Design-concept gate
  is *additional* alignment, not a replacement.
- Does not change ADR-0005 (operator escalation is narrow);
  design-concept gate auto-resolves the majority of cases that would
  otherwise have been punted as freeform `ready-for-human`.

## Alternatives considered

1. **Continue with implicit alignment** — status quo. Rejected:
   codex-removal measurement (see `docs/codex-removal-measurement.md`)
   shows that scope-creep and vocabulary drift account for a
   non-trivial slice of QA rejections.
2. **Specs-to-code regeneration** — write a spec, regenerate code on
   each iteration. Rejected: the Pocock talk's central thesis is that
   this compounds entropy; we've also seen this in practice with the
   deprecated planner/executor loop (ADR-0006).
3. **Free-form planning documents** — let `hydra-dev` write a markdown
   plan inside the worktree before coding. Rejected: not auditable at
   PR time, not machine-checkable, and drifts from `CONTEXT.md`.

## References

- ADR-0001 (Untouchable Core), ADR-0004 (Self-modification tiers),
  ADR-0005 (Operator escalation is narrow), ADR-0006 (Codex CLI
  removed), ADR-0007 (Decision-brain orchestration).
- `~/.claude/skills/grill-with-docs/SKILL.md`,
  `~/.claude/skills/prototype/SKILL.md`,
  `~/.claude/skills/review/SKILL.md`,
  `~/.claude/skills/handoff/SKILL.md` (mattpocock/skills).
- "Software Fundamentals Matter More Than Ever" — Matt Pocock
  conference talk.
