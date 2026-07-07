---
name: hydra-target-retro
disable_model_invocation: true
description: Per-run Target retrospective that deep-reads failed and reframed builds plus friction reports and routes recurring failure patterns into the planner/executor feedback surface and Target backlog.
when_to_use: "When the user says 'target retro', 'retro the target', 'analyze target builds', or hydra-autopilot wants to turn completed Target builds into conservative cross-build learning. Invoked as /hydra-target-retro [run_id] (default: latest completed run)."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
---

# Hydra Target Retro

Per-run (or daily) retrospective for the **Target** (hydra-betting) build loop —
the Target analogue of the Orchestrator's `/hydra-retro`. It deep-reads the
**failed and reframed** Target builds plus the Target executor's **subagent
friction reports**, synthesises recurring failure patterns, runs an
**adversarial self-check** to drop speculative/duplicate findings, then routes
what survives — **capped at ≤2 proposals/run, deduped** — into two lanes:

- **`feedback`** (prompt-shaped) → an instruction appended directly to the
  Target planner/executor feedback files the build loop already reads
  (`config/feedback/to-planner.md`, `config/feedback/to-executor.md`).
- **`backlog`** (code-needing) → a Redis Target-backlog item filed via the
  backlog module.

The pure caps/dedup/routing logic lives in `scripts/target/target-retro.ts`
(unit-tested in `test/target-retro.test.mts`) — this playbook orchestrates the
deep-read, the synthesis, and the feedback-file edit / backlog-item writes.

> **What this deliberately does NOT mirror from `/hydra-retro`:** there is **NO
> gated PR lane** and **NO Modification-Tier / Verifier-Core / deep-QA
> remediation / operator-escalation** machinery. The Orchestrator retro's single
> prompt-fix PR rides the tier ladder; the Target does not mirror that ladder
> (epic #1052), so a Target retro writes prompt-shaped findings DIRECTLY into the
> feedback files and never opens a PR. A Target retro only ever PROPOSES — it
> never gates a merge.

> **Safety:** `--audit` (dry-run) is the DEFAULT. Without `--apply` the skill
> prints the emit plan and stops — no feedback-file edits, no backlog items.

## 1. Resolve the run id

`/hydra-target-retro [run_id]` — argument is optional. Parse via the pure helper
so `--audit` / `--apply` are honoured and dry-run is the default:

```bash
# parseArgs(args) → { apply, runId? }  (apply defaults to false)
```

If no `run_id` was given, default to the latest **completed** run:

```bash
RUN_ID=$(curl -sf http://localhost:4000/api/autopilot/runs/current | jq -r '.run_id // empty')
# If `current` is still in-flight, walk the index for the most recent
# status=ended run instead — never retro an in-flight run.
```

## 2. Gather the Target signals (signals-first)

Unlike the Orchestrator retro, the Target has no Modification-Tier retro bundle.
Gather the Target's own lifecycle signals directly:

- **Failed / reframed builds** — the reframe queue is the Target's failure
  ledger (where `hydra-target-qa` bounces hard findings, and where the build
  loop parks reframes):

  ```bash
  docker exec hydra-redis-1 redis-cli LRANGE hydra:anchors:reframe-queue 0 -1
  ```

- **Subagent friction reports** — a FIRST-CLASS input, not a parallel
  mechanism. The Target executor's soft-friction patterns live under the
  friction store key `hydra:friction:<skill>:patterns` (the same store
  `hydra-target-build` emits its `## Friction Report` items into). Read them via
  the typed agent-memory seam — never raw Redis from `src/`:

  ```bash
  # The friction namespace shares schema with agent-memory; read it through
  # src/redis/agent-memory.ts (namespace="friction"), not redis/keys directly.
  npx tsx -e '
    import { loadPatternsRaw } from "./src/redis/agent-memory.ts";
    const raw = await loadPatternsRaw("hydra-target-build", "friction");
    process.stdout.write(raw ?? "[]");
    process.exit(0);
  '
  ```

Fold BOTH sources into a single observation list for synthesis — a recurring
friction cue and a transcript-derived gotcha compete on the same cue key.

## 3. Deep-read ONLY the failed / reframed transcripts

For each failed or reframed build (and ONLY those), read the full transcript so
synthesis is grounded in real lines, not speculation:

```bash
curl -sf "http://localhost:4000/api/dispatches/<id>/transcript"
```

This is the cost bound: a clean Target run (no reframes, no recurring friction)
reads no transcripts and emits nothing. A merged, regression-free build is never
drilled.

## 4. Synthesise observations

From the failed/reframed transcripts + the friction patterns, synthesise
candidate observations. Each is one of two lanes (see
`scripts/target/target-retro.ts` for the exact `RetroObservation` shape):

- **`feedback`** — a recurring prompt-shaped gotcha the planner/executor keep
  tripping on (e.g. "executor keeps skipping the staking-bounds check"). Written
  as an instruction into a feedback file.
- **`backlog`** — a code-needing finding (a real bug or brittle seam). Filed as
  a Redis Target-backlog item.

Every observation MUST carry a stable, kebab-case **`cue`** matching the
friction-store grammar (so a friction-pattern twin and a transcript gotcha line
up on the same dedup key), a one-line `title`, and a `source` of `transcript`
or `friction` (recorded for the artifact; routing does NOT depend on it).

## 5. Adversarial self-check (drop before emit)

Before ANY emit, adversarially challenge each observation and DROP it if:

- **Speculative** — not grounded in a transcript line or a friction-pattern
  count. "Might be flaky" is not a finding.
- **Duplicate** — already covered by another surviving observation, OR already
  an open Target-backlog issue / an existing feedback-file instruction, OR
  already in the persisted seen-list (snapshotted in step 6).

Live duplicate scan for the backlog lane:

```bash
gh issue list --repo gaberoo322/hydra --label target-backlog --state open \
  --json number,title --jq '.[] | "\(.number): \(.title)"'
```

Word-overlap > 50% with an existing item/instruction → drop.

## 6. Snapshot the seen-list

Snapshot the cross-run dedup ledger (the cues a prior Target retro already
emitted) so the pure planner can hard-skip re-proposals. Reuse the retro seen
seam:

```bash
SEEN=$(npx tsx -e '
  import { getRetroSeen } from "./src/redis/retro-seen.ts";
  const seen = await getRetroSeen();
  process.stdout.write(JSON.stringify(Object.keys(seen)));
  process.exit(0);
')
```

## 7. Plan the emit (pure, capped)

Hand the surviving observations + the seen-list snapshot to the pure planner. It
caps proposals at **≤2 total across BOTH lanes** (a single shared budget, not
≤2-per-lane), dedups against the seen-list, and routes each survivor to its
declared lane:

```bash
# validateObservations(observations) → []  (hard-stop on any error)
# planTargetRetro(observations, { seenCues: new Set(seenCues) })
#   → { feedback[], backlog[], artifactOnly[], skipped[] }
```

`plan.feedback` are the feedback-file instructions; `plan.backlog` are the
Redis Target-backlog items; `plan.artifactOnly` (over the shared cap) +
`plan.skipped` (deduped) are recorded in the artifact, never emitted.

## 8. Emit (ONLY under --apply)

If `apply === false` (the default), PRINT the plan and STOP — no edits, no items.

Under `--apply`:

- For each `plan.feedback[]`: append a one-line dated instruction to the
  appropriate Target feedback file (`config/feedback/to-planner.md` or
  `config/feedback/to-executor.md`). Keep it terse and actionable — this is the
  surface the build loop reads next run. Then record the cue in the shared
  seen-list. The seam's `decision` field is the Orchestrator-retro
  `RetroEmitKind` (`"issue" | "pr" | "artifact"`) — a prompt-shaped feedback
  edit maps onto `"artifact"` (the Target has no PR lane), so the existing
  `src/redis/retro-seen.ts` seam is reused unchanged (out of this issue's scope):

      npx tsx -e 'import {recordRetroSeen} from "./src/redis/retro-seen.ts"; await recordRetroSeen({cue: process.env.CUE, decision: "artifact", runId: process.env.RUN_ID, ref: null, at: new Date().toISOString()}); process.exit(0);'

- For each `plan.backlog[]`: file a Redis Target-backlog item through the backlog
  module (it dedups by title automatically):

      npx tsx -e '
        import { addToBacklog } from "./src/backlog/items.ts";
        const r = await addToBacklog({
          title: process.env.TITLE,
          description: process.env.DESC,
          category: "target-retro",
          source: "target-retro",
          lane: "triage",
        });
        process.stdout.write(JSON.stringify(r));
        process.exit(0);
      '

  Then record the cue in the shared seen-list with `decision: "issue"` (a
  code-needing backlog item is the Target's issue-shaped lane), `ref` set to the
  returned backlog item id:

      npx tsx -e 'import {recordRetroSeen} from "./src/redis/retro-seen.ts"; await recordRetroSeen({cue: process.env.CUE, decision: "issue", runId: process.env.RUN_ID, ref: process.env.REF, at: new Date().toISOString()}); process.exit(0);'

The shared cap means at most 2 proposals (in any feedback/backlog mix) ever
leave a single Target retro run.

## 9. Artifact (always)

Write the persisted retro artifact (feedback instructions appended, backlog
items filed, artifact-only notes, dropped findings + reasons). Under `--audit`
this is the sole output.

## Summary output

```
[hydra-target-retro] run <RUN_ID> (apply=<bool>). Reframed/failed <N> builds, drilled <N> transcripts, folded <F> friction patterns.
  Observations: <C> feedback, <B> backlog (after adversarial drop of <D>).
  Emitted: <FE> feedback instructions + <BE> backlog items (shared cap 2).
  Artifact-only (over cap): <A>. Deduped (seen-list/live): <S>.
```

## Domain context
- `~/hydra/CONTEXT.md` — canonical vocabulary
- `~/hydra/docs/adr/` — don't contradict existing ADRs
- `scripts/target/target-retro.ts` — the pure caps/dedup/routing core this skill consumes
- `scripts/ci/hydra-retro-emit.ts` — the Orchestrator retro this one is the Target analogue of
- `src/redis/retro-seen.ts` — the seen-list seam (shared with the Orchestrator retro)
- `src/redis/agent-memory.ts` — the friction-store read seam (`namespace="friction"`)
- `src/backlog/items.ts` — the Target-backlog item writer (`addToBacklog`)
- `docs/operator-playbooks/hydra-target-build.md` — the build loop whose failures this retro learns from

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
